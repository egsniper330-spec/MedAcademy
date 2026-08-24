<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuditService;
use MedAcademy\Utils\Uuid;

/**
 * CreditController — PHP equivalent of the credits Edge Function.
 *
 * Actions:
 *   allocate         → admin adds credits to a doctor
 *   refund           → admin refunds unused or consumed credits
 *   revoke           → admin reverses a credit transaction
 *   bulk_allocate    → admin adds credits to multiple doctors
 *   me               → current user's credit balance
 *   transactions     → current user's credit transaction history
 *   redeem           → student redeems activation code
 *   createCodes      → admin creates activation codes
 */
final class CreditController
{
    public function me(Request $request): array
    {
        return [
            'credits' => Database::instance()->row(
                'SELECT doctor_id, allocated, consumed, remaining, updated_at FROM credits WHERE doctor_id = ?',
                [$request->user['id']]
            ) ?? ['allocated' => 0, 'consumed' => 0, 'remaining' => 0],
        ];
    }

    public function transactions(Request $request): array
    {
        return [
            'transactions' => Database::instance()->select(
                'SELECT id, transaction_type, amount, course_id, student_id, notes, created_at
                   FROM credit_transactions
                  WHERE doctor_id = ?
                  ORDER BY created_at DESC LIMIT 200',
                [$request->user['id']]
            ),
        ];
    }

    /**
     * POST /credits/allocate — admin adds credits to a doctor.
     */
    public function allocate(Request $request): array
    {
        $doctorId = Uuid::normalize((string) ($request->json()['doctor_id'] ?? ''));
        $amount = (int) ($request->json()['amount'] ?? 0);
        $notes = (string) ($request->json()['notes'] ?? '');
        if ($amount <= 0) {
            throw new ApiException(422, 'amount must be positive');
        }
        $actor = $request->user['id'];

        Database::instance()->transaction(function (Database $db) use ($doctorId, $amount, $notes, $actor) {
            $db->query(
                'INSERT INTO credits (id, doctor_id, allocated, remaining, updated_at)
                 VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6))
                 ON DUPLICATE KEY UPDATE
                    allocated = allocated + ?, remaining = remaining + ?, updated_at = UTC_TIMESTAMP(6)',
                [Uuid::v4(), $doctorId, $amount, $amount, $amount, $amount]
            );
            $db->insert(
                'INSERT INTO credit_transactions (id, doctor_id, transaction_type, amount, performed_by, notes, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
                [Uuid::v4(), $doctorId, 'allocation', $amount, $actor, $notes]
            );
        });
        AuditService::write($actor, 'credit_allocated', ['doctor_id' => $doctorId, 'amount' => $amount]);
        return ['success' => true];
    }

    /**
     * POST /credits/refund — admin refunds unused or consumed credits.
     */
    public function refund(Request $request): array
    {
        $body = $request->json();
        $doctorId = Uuid::normalize((string) ($body['doctor_id'] ?? ''));
        $amount = (int) ($body['amount'] ?? 0);
        $notes = (string) ($body['notes'] ?? '');
        $refundType = (string) ($body['refund_type'] ?? 'unused');
        $actor = $request->user['id'];

        if ($amount <= 0) {
            throw new ApiException(422, 'amount must be positive');
        }

        $db = Database::instance();
        $credits = $db->row('SELECT allocated, consumed, remaining FROM credits WHERE doctor_id = ?', [$doctorId]);
        if ($credits === null) {
            throw new ApiException(404, 'Doctor credits not found');
        }

        $db->transaction(function (Database $db) use ($doctorId, $amount, $notes, $refundType, $actor, $credits) {
            $balBefore = (int) $credits['remaining'];

            if ($refundType === 'unused') {
                if ((int) $credits['remaining'] < $amount) {
                    throw new ApiException(422, 'Cannot remove unused credits — insufficient remaining balance');
                }
                $balAfter = $balBefore - $amount;
                $db->query(
                    'UPDATE credits SET remaining = ?, allocated = allocated - ?, updated_at = UTC_TIMESTAMP(6) WHERE doctor_id = ?',
                    [$balAfter, $amount, $doctorId]
                );
                $db->insert(
                    'INSERT INTO credit_transactions (id, doctor_id, transaction_type, amount, performed_by, notes, balance_before, balance_after, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
                    [Uuid::v4(), $doctorId, 'deduction', $amount, $actor, $notes ?: 'Admin removed unused credits', $balBefore, $balAfter]
                );
            } else {
                // Consumed refund
                if ((int) $credits['consumed'] < $amount) {
                    throw new ApiException(422, 'Refund amount exceeds consumed credits');
                }
                $balAfter = $balBefore + $amount;
                $db->query(
                    'UPDATE credits SET consumed = consumed - ?, remaining = ?, updated_at = UTC_TIMESTAMP(6) WHERE doctor_id = ?',
                    [$amount, $balAfter, $doctorId]
                );
                $db->insert(
                    'INSERT INTO credit_transactions (id, doctor_id, transaction_type, amount, performed_by, notes, balance_before, balance_after, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
                    [Uuid::v4(), $doctorId, 'restoration', $amount, $actor, $notes ?: 'Admin refund', $balBefore, $balAfter]
                );
            }
        });

        AuditService::write($actor, 'credit_refunded', ['doctor_id' => $doctorId, 'amount' => $amount, 'type' => $refundType]);
        return ['success' => true, 'doctor_id' => $doctorId, 'refunded' => $amount];
    }

    /**
     * POST /credits/revoke — admin reverses a credit transaction.
     */
    public function revoke(Request $request): array
    {
        $body = $request->json();
        $doctorId = Uuid::normalize((string) ($body['doctor_id'] ?? ''));
        $amount = (int) ($body['amount'] ?? 0);
        $reason = (string) ($body['reason'] ?? '');
        $actor = $request->user['id'];

        if ($amount <= 0) {
            throw new ApiException(422, 'amount must be positive');
        }
        if ($reason === '') {
            throw new ApiException(422, 'reason is required for revocation');
        }

        $db = Database::instance();
        $db->transaction(function (Database $db) use ($doctorId, $amount, $reason, $actor) {
            $credits = $db->row('SELECT remaining FROM credits WHERE doctor_id = ?', [$doctorId]);
            if ($credits === null) {
                throw new ApiException(404, 'Doctor credits not found');
            }

            $balBefore = (int) $credits['remaining'];
            $balAfter = max(0, $balBefore - $amount);

            $db->query(
                'UPDATE credits SET remaining = ?, consumed = consumed + ?, updated_at = UTC_TIMESTAMP(6) WHERE doctor_id = ?',
                [$balAfter, $amount, $doctorId]
            );

            $db->insert(
                'INSERT INTO credit_transactions (id, doctor_id, transaction_type, amount, performed_by, notes, balance_before, balance_after, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
                [Uuid::v4(), $doctorId, 'consumption', $amount, $actor, $reason, $balBefore, $balAfter]
            );
        });

        AuditService::write($actor, 'credit_deducted', ['doctor_id' => $doctorId, 'amount' => $amount, 'reason' => $reason]);
        return ['success' => true, 'doctor_id' => $doctorId, 'revoked' => $amount];
    }

    /**
     * POST /credits/bulk-allocate — admin adds credits to multiple doctors.
     */
    public function bulkAllocate(Request $request): array
    {
        $body = $request->json();
        $doctorIds = $body['doctor_ids'] ?? [];
        $amounts = $body['amounts'] ?? [];
        $amount = (int) ($body['amount'] ?? 0);
        $notes = (string) ($body['notes'] ?? '');
        $actor = $request->user['id'];

        if (!is_array($doctorIds) || count($doctorIds) === 0) {
            throw new ApiException(422, 'doctor_ids array is required');
        }

        $results = [];
        foreach ($doctorIds as $i => $doctorId) {
            $amt = is_array($amounts) && isset($amounts[$i]) ? (int) $amounts[$i] : $amount;
            if ($amt <= 0) {
                continue;
            }

            try {
                Database::instance()->transaction(function (Database $db) use ($doctorId, $amt, $actor) {
                    $db->query(
                        'INSERT INTO credits (id, doctor_id, allocated, remaining, updated_at)
                         VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6))
                         ON DUPLICATE KEY UPDATE allocated = allocated + ?, remaining = remaining + ?, updated_at = UTC_TIMESTAMP(6)',
                        [Uuid::v4(), $doctorId, $amt, $amt, $amt, $amt]
                    );
                    $db->insert(
                        'INSERT INTO credit_transactions (id, doctor_id, transaction_type, amount, performed_by, created_at)
                         VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
                        [Uuid::v4(), $doctorId, 'allocation', $amt, $actor]
                    );
                });
                $results[] = ['doctor_id' => $doctorId, 'success' => true];
            } catch (\Throwable $e) {
                $results[] = ['doctor_id' => $doctorId, 'error' => $e->getMessage()];
            }
        }

        AuditService::write($actor, 'credit_allocated', ['bulk' => true, 'count' => count($results)]);
        return ['success' => true, 'results' => $results];
    }

    /**
     * GET /credits/doctor/{id} — doctor earnings dashboard.
     */
    public function doctorEarnings(Request $request): array
    {
        $doctorId = Uuid::normalize((string) $request->params['id']);
        $db = Database::instance();

        $credits = $db->row('SELECT * FROM credits WHERE doctor_id = ?', [$doctorId]);
        $transactions = $db->select(
            'SELECT * FROM credit_transactions WHERE doctor_id = ? ORDER BY created_at DESC LIMIT 50',
            [$doctorId]
        );
        $enrollmentCount = (int) $db->value(
            'SELECT COUNT(*) FROM enrollments e
              JOIN courses c ON c.id = e.course_id
             WHERE c.doctor_id = ?',
            [$doctorId], 0
        );
        $courseCount = (int) $db->value(
            'SELECT COUNT(*) FROM courses WHERE doctor_id = ?',
            [$doctorId], 0
        );

        return [
            'credits' => $credits ?? ['allocated' => 0, 'consumed' => 0, 'remaining' => 0],
            'transactions' => $transactions ?? [],
            'total_enrollments' => $enrollmentCount,
            'total_courses' => $courseCount,
        ];
    }

    /**
     * POST /activation-codes/redeem — student redeems a code to enroll.
     */
    public function redeem(Request $request): array
    {
        $code = strtoupper(trim((string) ($request->json()['code'] ?? '')));
        if ($code === '') {
            throw new ApiException(422, 'code is required');
        }
        $studentId = $request->user['id'];
        $db = Database::instance();

        return $db->transaction(function (Database $db) use ($code, $studentId) {
            $v = $db->row('SELECT * FROM activation_codes WHERE code = ?', [$code]);
            if ($v === null) {
                return ['success' => false, 'error' => 'Code not found'];
            }
            if ($v['status'] !== 'active') {
                return ['success' => false, 'error' => 'Code is not active'];
            }
            if ($v['expires_at'] !== null && strtotime((string) $v['expires_at']) < time()) {
                $db->query("UPDATE activation_codes SET status = 'expired' WHERE id = ?", [$v['id']]);
                return ['success' => false, 'error' => 'Code has expired'];
            }
            $already = (bool) $db->value(
                'SELECT COUNT(*) FROM enrollments WHERE student_id = ? AND course_id = ?',
                [$studentId, $v['course_id']], 0
            );
            if ($already) {
                return ['success' => false, 'error' => 'Already enrolled in this course'];
            }
            $db->insert(
                'INSERT INTO enrollments (id, student_id, course_id, status, enrolled_at)
                 VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6))',
                [Uuid::v4(), $studentId, $v['course_id'], 'active']
            );
            $db->query(
                "UPDATE activation_codes SET status = 'used', used_by = ?, used_at = UTC_TIMESTAMP(6) WHERE id = ?",
                [$studentId, $v['id']]
            );
            return ['success' => true, 'course_id' => $v['course_id']];
        });
    }

    /**
     * POST /activation-codes — admin bulk code creation.
     */
    public function createCodes(Request $request): array
    {
        $courseId = Uuid::normalize((string) ($request->json()['course_id'] ?? ''));
        $count = min((int) ($request->json()['count'] ?? 1), 500);
        $expiresAt = isset($request->json()['expires_at']) ? (string) $request->json()['expires_at'] : null;
        $prefix = strtoupper(substr((string) ($request->json()['prefix'] ?? ''), 0, 4));
        $actor = $request->user['id'];

        $codes = [];
        for ($i = 0; $i < $count; $i++) {
            $code = ($prefix !== '' ? $prefix . '-' : '') . strtoupper(bin2hex(random_bytes(5)));
            Database::instance()->insert(
                'INSERT INTO activation_codes (id, code, course_id, status, expires_at, created_by, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
                [Uuid::v4(), $code, $courseId, 'active', $expiresAt, $actor]
            );
            $codes[] = $code;
        }
        AuditService::write($actor, 'code_created', ['course_id' => $courseId, 'count' => $count]);
        return ['success' => true, 'codes' => $codes];
    }

    /**
     * POST /activation-codes/assign — create code + enroll in one step.
     */
    public function assignCode(Request $request): array
    {
        $body = $request->json();
        $courseId = Uuid::normalize((string) ($body['course_id'] ?? ''));
        $targetUserId = (string) ($body['target_user_id'] ?? '');
        if ($courseId === '' || $targetUserId === '') {
            throw new ApiException(422, 'course_id and target_user_id are required');
        }

        $code = strtoupper(bin2hex(random_bytes(5)));
        $actor = $request->user['id'];
        $db = Database::instance();

        $db->transaction(function (Database $db) use ($code, $courseId, $targetUserId, $actor) {
            // Create used code
            $db->insert(
                'INSERT INTO activation_codes (id, code, course_id, status, used_by, used_at, created_by, created_at)
                 VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(6), ?, UTC_TIMESTAMP(6))',
                [Uuid::v4(), $code, $courseId, 'used', $targetUserId, $actor]
            );

            // Enroll
            $db->insert(
                'INSERT IGNORE INTO enrollments (id, student_id, course_id, enrolled_by, enrollment_method, status, enrolled_at, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))',
                [Uuid::v4(), $targetUserId, $courseId, $actor, 'admin_assigned', 'active']
            );
        });

        AuditService::write($actor, 'code_redeemed', ['course_id' => $courseId, 'target_user_id' => $targetUserId]);
        return ['success' => true, 'code' => $code, 'target_user_id' => $targetUserId];
    }

    // ================================================================
    // ACTIVATION CODES BATCH OPERATIONS
    // Mirrors supabase/functions/activation-codes/index.ts
    // ================================================================

    /**
     * POST /activation-codes/batch-create — create a batch of activation codes.
     */
    public function batchCreateCodes(Request $request): array
    {
        $body = $request->json();
        $courseId = Uuid::normalize((string) ($body['course_id'] ?? ''));
        $count = min(max((int) ($body['count'] ?? 10), 1), 500);
        $prefix = (string) ($body['prefix'] ?? '');
        $label = (string) ($body['label'] ?? $body['batch_label'] ?? ($prefix !== '' ? $prefix : ''));
        $expiresAt = $body['expires_at'] ?? null;
        $notes = $body['notes'] ?? null;
        $creditAmount = max((int) ($body['credit_amount'] ?? 1), 0);
        $maxUses = $body['max_uses'] ?? null;
        if ($maxUses !== null) {
            $maxUses = (int) $maxUses > 0 ? (int) $maxUses : null;
        }

        if ($courseId === '') {
            throw new ApiException(422, 'course_id is required');
        }

        $actor = $request->user['id'];
        $db = Database::instance();

        // Create batch record (label + max_uses are sent by the frontend batch generator)
        $batchId = Uuid::v4();
        $db->insert(
            'INSERT INTO code_batches (id, label, course_id, created_by, total_count, expires_at, notes, prefix, max_uses, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
            [$batchId, $label !== '' ? $label : ($prefix !== '' ? $prefix : 'Batch ' . date('Y-m-d')), $courseId, $actor, $count, $expiresAt, $notes, $prefix !== '' ? $prefix : null, $maxUses]
        );

        // Generate codes
        $codes = [];
        $db->transaction(function (Database $db) use ($batchId, $courseId, $count, $prefix, $actor, &$codes, $creditAmount, $maxUses) {
            for ($i = 0; $i < $count; $i++) {
                $code = $prefix . strtoupper(bin2hex(random_bytes(5)));
                $db->insert(
                    'INSERT INTO activation_codes (id, code, course_id, status, credit_amount, max_uses, created_by, batch_id, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
                    [Uuid::v4(), $code, $courseId, 'active', $creditAmount, $maxUses, $actor, $batchId]
                );
                $codes[] = $code;
            }
        });

        AuditService::write($actor, 'codes_batch_created', ['batch_id' => $batchId, 'count' => $count]);
        return ['batch_id' => $batchId, 'codes' => $codes, 'count' => count($codes)];
    }

    /**
     * POST /activation-codes/clone-batch — duplicate a batch with fresh codes.
     * Mirrors the clone_batch action of the activation-codes Edge Function.
     */
    public function cloneBatch(Request $request): array
    {
        $body = $request->json();
        $batchId = (string) ($body['batch_id'] ?? '');
        if ($batchId === '') {
            throw new ApiException(422, 'batch_id is required');
        }

        $actor = $request->user['id'];
        $db = Database::instance();
        $src = $db->row(
            'SELECT label, course_id, total_count, expires_at, notes, prefix, max_uses, credit_amount
               FROM code_batches WHERE id = ?',
            [$batchId]
        );
        if ($src === null) {
            throw new ApiException(404, 'Batch not found');
        }

        $count = min(max((int) $src['total_count'], 1), 500);
        $newBatchId = Uuid::v4();
        $db->insert(
            'INSERT INTO code_batches (id, label, course_id, created_by, total_count, expires_at, notes, prefix, max_uses, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
            [$newBatchId, $src['label'], $src['course_id'], $actor, $count, $src['expires_at'], $src['notes'], $src['prefix'], $src['max_uses']]
        );

        $codes = [];
        $db->transaction(function (Database $db) use ($newBatchId, $src, $count, $actor, &$codes) {
            for ($i = 0; $i < $count; $i++) {
                $code = ($src['prefix'] !== null && $src['prefix'] !== '' ? $src['prefix'] : '') . strtoupper(bin2hex(random_bytes(5)));
                $db->insert(
                    'INSERT INTO activation_codes (id, code, course_id, status, credit_amount, max_uses, created_by, batch_id, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
                    [Uuid::v4(), $code, $src['course_id'], 'active', (int) ($src['credit_amount'] ?? 0), $src['max_uses'], $actor, $newBatchId]
                );
                $codes[] = $code;
            }
        });

        AuditService::write($actor, 'codes_batch_cloned', ['source_batch_id' => $batchId, 'new_batch_id' => $newBatchId, 'count' => $count]);
        return ['batch_id' => $newBatchId, 'codes' => $codes, 'count' => count($codes)];
    }

    /**
     * POST /activation-codes/deactivate — deactivate a code or batch.
     */
    public function deactivateCode(Request $request): array
    {
        $body = $request->json();
        $codeId = $body['code_id'] ?? null;
        $batchId = $body['batch_id'] ?? null;
        $codeIds = $body['code_ids'] ?? null;

        $db = Database::instance();
        if ($batchId) {
            $db->query(
                "UPDATE activation_codes SET status = 'disabled', disabled_at = UTC_TIMESTAMP(6), disabled_by = ?
                  WHERE batch_id = ? AND status = 'active'",
                [$request->user['id'], $batchId]
            );
            $db->query('UPDATE code_batches SET disabled_count = total_count - used_count - expired_count WHERE id = ?', [$batchId]);
        } elseif (is_array($codeIds) && count($codeIds) > 0) {
            // Bulk disable (frontend sends code_ids array — matches the EF)
            $placeholders = implode(',', array_fill(0, count($codeIds), '?'));
            $db->query(
                "UPDATE activation_codes SET status = 'disabled', disabled_at = UTC_TIMESTAMP(6), disabled_by = ?
                  WHERE id IN ($placeholders) AND status = 'active'",
                array_merge([$request->user['id']], array_values($codeIds))
            );
        } elseif ($codeId) {
            $db->query(
                "UPDATE activation_codes SET status = 'disabled', disabled_at = UTC_TIMESTAMP(6), disabled_by = ?
                  WHERE id = ? AND status = 'active'",
                [$request->user['id'], $codeId]
            );
        } else {
            throw new ApiException(422, 'code_id, code_ids or batch_id is required');
        }

        AuditService::write($request->user['id'], 'codes_deactivated', ['code_id' => $codeId, 'code_ids' => $codeIds, 'batch_id' => $batchId]);
        return ['success' => true];
    }

    /**
     * POST /activation-codes/reactivate — re-enable disabled codes.
     */
    public function reactivateCode(Request $request): array
    {
        $body = $request->json();
        $codeId = $body['code_id'] ?? null;
        $batchId = $body['batch_id'] ?? null;
        $codeIds = $body['code_ids'] ?? null;

        $db = Database::instance();
        if ($batchId) {
            $db->query(
                "UPDATE activation_codes SET status = 'active', disabled_at = NULL, disabled_by = NULL
                  WHERE batch_id = ? AND status = 'disabled'",
                [$batchId]
            );
        } elseif (is_array($codeIds) && count($codeIds) > 0) {
            // Bulk re-enable (frontend sends code_ids array — matches the EF)
            $placeholders = implode(',', array_fill(0, count($codeIds), '?'));
            $db->query(
                "UPDATE activation_codes SET status = 'active', disabled_at = NULL, disabled_by = NULL
                  WHERE id IN ($placeholders) AND status = 'disabled'",
                array_values($codeIds)
            );
        } elseif ($codeId) {
            $db->query(
                "UPDATE activation_codes SET status = 'active', disabled_at = NULL, disabled_by = NULL
                  WHERE id = ? AND status = 'disabled'",
                [$codeId]
            );
        } else {
            throw new ApiException(422, 'code_id, code_ids or batch_id is required');
        }

        AuditService::write($request->user['id'], 'codes_reactivated', ['code_id' => $codeId, 'code_ids' => $codeIds, 'batch_id' => $batchId]);
        return ['success' => true];
    }

    /**
     * POST /activation-codes/bulk-delete — permanently delete unused codes.
     */
    public function bulkDeleteCodes(Request $request): array
    {
        $body = $request->json();
        $batchId = $body['batch_id'] ?? null;
        $codeIds = $body['code_ids'] ?? [];

        $db = Database::instance();
        $deleted = 0;

        if ($batchId) {
            $result = $db->query(
                "DELETE FROM activation_codes WHERE batch_id = ? AND status IN ('active', 'disabled')",
                [$batchId]
            );
            $deleted = $result->rowCount();
        } elseif (!empty($codeIds)) {
            $placeholders = implode(',', array_fill(0, count($codeIds), '?'));
            $params = array_merge($codeIds);
            $result = $db->query(
                "DELETE FROM activation_codes WHERE id IN ($placeholders) AND status IN ('active', 'disabled')",
                $params
            );
            $deleted = $result->rowCount();
        } else {
            throw new ApiException(422, 'batch_id or code_ids is required');
        }

        AuditService::write($request->user['id'], 'codes_bulk_deleted', ['deleted' => $deleted]);
        return ['deleted' => $deleted];
    }
}
