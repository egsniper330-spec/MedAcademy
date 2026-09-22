<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Auth\Password;
use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuthService;
use MedAcademy\Services\AuditService;
use MedAcademy\Utils\Uuid;

/**
 * StudentController — PHP equivalent of the student-operations Edge Function.
 *
 * Modes:
 *   create_only               → create user + profile + audit
 *   create_and_enroll_credits → A + lock credits + enroll + deduct
 *   enroll_existing_credits   → existing student + credits
 */
final class StudentController
{
    public function __construct(
        private readonly AuthService $authService = new AuthService()
    ) {
    }

    /**
     * POST /student-operations — unified action dispatcher.
     */
    public function handle(Request $request): array
    {
        $body = $request->json();
        $mode = (string) ($body['mode'] ?? '');
        $actorId = $request->user['id'];
        $actorRole = $request->user['role'];

        if (!in_array($actorRole, ['doctor', 'admin', 'super_admin'], true)) {
            throw new ApiException(403, 'Requires doctor, admin, or super_admin role');
        }

        if ($mode === '') {
            throw new ApiException(422, 'mode is required');
        }

        $needsNewStudent = in_array($mode, ['create_only', 'create_and_enroll_credits'], true);
        $needsActivation = $mode !== 'create_only';

        // Validation
        if ($needsNewStudent) {
            $fullName = trim((string) ($body['full_name'] ?? ''));
            if ($fullName === '') {
                throw new ApiException(422, 'full_name is required');
            }
            $password = (string) ($body['password'] ?? '');
            if (strlen($password) < 6) {
                throw new ApiException(422, 'Password must be at least 6 characters');
            }
            $email = trim((string) ($body['email'] ?? ''));
            $phone = trim((string) ($body['phone'] ?? ''));
            if ($email === '' && $phone === '') {
                throw new ApiException(422, 'At least one of email or phone is required');
            }
        }

        if (!$needsNewStudent) {
            if (empty($body['student_id'])) {
                throw new ApiException(422, 'student_id is required');
            }
            // Validate BEFORE any FK insert: a garbage identifier would otherwise
            // reach the enrollments FK and surface as a raw SQL 500 instead of a
            // clear 422. Frontend always passes profiles.id (internal UUID).
            Uuid::normalize((string) $body['student_id']);
        }
        if ($needsActivation && empty($body['course_id'])) {
            throw new ApiException(422, 'course_id is required');
        }

        $newUserId = null;

        try {
            $studentId = (string) ($body['student_id'] ?? '');

            // Step 1: Create auth user (modes A/B/C)
            if ($needsNewStudent) {
                $email = strtolower(trim((string) ($body['email'] ?? '')));
                $phone = trim((string) ($body['phone'] ?? ''));
                $phoneE164 = $phone !== '' ? $this->normalizePhoneE164($phone) : null;
                $fullName = trim((string) ($body['full_name'] ?? ''));

                $authEmail = $email !== '' ? $email : 'phone_' . preg_replace('/\D/', '', $phone) . '@medacademy.internal';

                $newUserId = Uuid::v4();
                $db = Database::instance();

                // Create auth user. NOTE: `phone` is intentionally NOT part of
                // this INSERT (same MySQL trigger-cascade restriction as
                // AuthService::register — inserting users.phone fires
                // trg_sync_auth_phone_on_new_user → UPDATE profiles → fires
                // trg_sync_auth_phone_on_profile_update → UPDATE users → Error
                // 1442 → 500). The UPDATE profiles below performs the sync
                // legally and writes users.phone back via the trigger.
                $db->insert(
                    'INSERT INTO users (id, email, encrypted_password, raw_user_meta_data, email_confirmed_at, phone_confirmed_at, created_at, updated_at)
                     VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))',
                    [
                        $newUserId,
                        $authEmail,
                        Password::hash($body['password']),
                        json_encode(['full_name' => $fullName, 'phone' => $phone], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
                    ]
                );

                // Trigger creates profiles row; update it
                $db->query(
                    'UPDATE profiles SET
                        email = ?, full_name = ?, phone = ?, phone_e164 = ?,
                        role = ?, status = ?, watermark_id = ?,
                        force_password_change = 1, created_by_doctor_id = ?,
                        created_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)
                      WHERE id = ?',
                    [
                        $authEmail,
                        $fullName,
                        $phone !== '' ? $phone : null,
                        $phoneE164,
                        'student',
                        'active',
                        $this->nextWatermarkId(),
                        $actorRole === 'doctor' ? $actorId : null,
                        $newUserId,
                    ]
                );

                // Create credits row
                $db->insert(
                    'INSERT IGNORE INTO credits (id, doctor_id, allocated, consumed, remaining) VALUES (?, ?, 0, 0, 0)',
                    [Uuid::v4(), $newUserId]
                );

                $studentId = $newUserId;
            }

            // Step 2: Activation (modes B/C/D/E)
            if ($needsActivation) {
                $courseId = Uuid::normalize((string) $body['course_id']);

                if (in_array($mode, ['create_and_enroll_credits', 'enroll_existing_credits'], true)) {
                    // Credits path: deduct from doctor, enroll student
                    $db = Database::instance();
                    $db->transaction(function (Database $db) use ($actorId, $studentId, $courseId) {
                        // Check doctor has enough credits — FOR UPDATE locks the row
                        // until COMMIT so two concurrent enrollments can never both
                        // pass this check and drive the balance negative (the
                        // chk_credits_c0 CHECK would abort the second transaction).
                        $credits = $db->row('SELECT remaining FROM credits WHERE doctor_id = ? FOR UPDATE', [$actorId]);
                        if ($credits === null || (int) $credits['remaining'] <= 0) {
                            throw new ApiException(422, 'Insufficient credits');
                        }

                        // Deduct from doctor
                        $db->query(
                            'UPDATE credits SET remaining = remaining - 1, consumed = consumed + 1, updated_at = UTC_TIMESTAMP(6) WHERE doctor_id = ?',
                            [$actorId]
                        );

                        // Record transaction (course_id feeds trg_earnings_on_consumption
                        // so the doctor's earnings snapshot resolves course-level pricing)
                        $db->insert(
                            'INSERT INTO credit_transactions (id, doctor_id, transaction_type, amount, course_id, student_id, performed_by, created_at)
                             VALUES (?, ?, ?, 1, ?, ?, ?, UTC_TIMESTAMP(6))',
                            [Uuid::v4(), $actorId, 'consumption', $courseId, $studentId, $actorId]
                        );

                        // Enroll — explicit duplicate check FIRST: INSERT IGNORE would
                        // swallow the enrollments unique-key violation AFTER the credit
                        // was already deducted (silently consuming a credit with no
                        // enrollment). The schema column is `enrolled_at` — enrollments
                        // has NO `created_at`; using it failed every credits-path
                        // enrollment with SQLSTATE 42S22 even with sufficient balance
                        // (the reported Add-Student / enrollment bug).
                        $already = (int) $db->value(
                            'SELECT COUNT(*) FROM enrollments WHERE student_id = ? AND course_id = ?',
                            [$studentId, $courseId], 0
                        );
                        if ($already > 0) {
                            throw new ApiException(409, 'This student is already enrolled in this course');
                        }
                        $db->insert(
                            'INSERT INTO enrollments (id, student_id, course_id, enrolled_by, enrollment_method, status, enrolled_at)
                             VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
                            [Uuid::v4(), $studentId, $courseId, $actorId, 'doctor_created', 'active']
                        );
                    });
                }
            }

            AuditService::write($actorId, 'student_created_by_doctor', [
                'mode' => $mode,
                'student_id' => $studentId,
                'course_id' => $body['course_id'] ?? null,
            ]);

            return [
                'success' => true,
                'mode' => $mode,
                'student_id' => $studentId,
            ];
        } catch (\PDOException $e) {
            // Raw SQL failures must reach the client as precise business errors —
            // never as SQLSTATE internals. The compensating delete still runs so
            // a half-created student account never survives a failed operation.
            $this->rollbackNewUser($newUserId);
            throw self::mapPdoError($e);
        } catch (\Throwable $e) {
            $this->rollbackNewUser($newUserId);
            throw $e;
        }
    }

    /** Compensating delete of a partially created student account. */
    private function rollbackNewUser(?string $newUserId): void
    {
        if ($newUserId === null) {
            return;
        }
        try {
            Database::instance()->query('DELETE FROM users WHERE id = ?', [$newUserId]);
        } catch (\Throwable) {
            // The profiles row cascades from users; nothing else to unwind.
        }
    }

    /** Translate enrollment-path PDO failures into precise, user-safe ApiExceptions. */
    private static function mapPdoError(\PDOException $e): ApiException
    {
        $msg = $e->getMessage();
        if (str_contains($msg, '1062') && str_contains($msg, 'enrollments')) {
            // Concurrent duplicate request that slipped past the pre-check —
            // the enrollments UNIQUE(student_id, course_id) constraint caught it.
            return new ApiException(409, 'This student is already enrolled in this course', 'already_enrolled', $e);
        }
        if (str_contains($msg, 'fk_enrollments_course_id')) {
            return new ApiException(422, 'The selected course could not be found. Please pick the course again.', 'course_not_found', $e);
        }
        if (str_contains($msg, 'fk_enrollments_student_id') || str_contains($msg, 'fk_credit_transactions_student_id')) {
            return new ApiException(422, 'The selected student account could not be found. Please search for the student again.', 'student_not_found', $e);
        }
        if (str_contains($msg, 'chk_credits_c0')) {
            return new ApiException(422, 'Insufficient credits', 'insufficient_credits', $e);
        }
        return new ApiException(500, 'The operation could not be completed. Please try again.', 'operation_failed', $e);
    }

    private function normalizePhoneE164(string $phone): ?string
    {
        $raw = preg_replace('/[\s\-]/', '', $phone);
        if ($raw === '') {
            return null;
        }
        if (preg_match('/^\+[1-9]\d{6,14}$/', $raw)) {
            return $raw;
        }
        if (preg_match('/^00[1-9]\d{6,14}$/', $raw)) {
            return '+' . substr($raw, 2);
        }
        if (preg_match('/^0[1-9]\d{9}$/', $raw)) {
            return '+20' . substr($raw, 1);
        }
        if (preg_match('/^20[1-9]\d{9}$/', $raw)) {
            return '+' . $raw;
        }
        if (preg_match('/^[1-9]\d{8,9}$/', $raw)) {
            return '+20' . $raw;
        }
        return null;
    }

    private function nextWatermarkId(): string
    {
        $db = Database::instance();
        $db->query('UPDATE watermark_seq SET next_val = next_val + 1 WHERE id = 1');
        $n = (int) $db->value('SELECT next_val - 1 FROM watermark_seq WHERE id = 1', [], 0);
        return strtoupper(dechex($n));
    }
}
