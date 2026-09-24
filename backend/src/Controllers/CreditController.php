<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuditService;
use MedAcademy\Services\FeatureFlagService;
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
 */
final class CreditController
{
    public function __construct(
        private readonly FeatureFlagService $flags = new FeatureFlagService()
    ) {
    }

    public function me(Request $request): array
    {
        $row = Database::instance()->row(
            'SELECT doctor_id, allocated, consumed, remaining, updated_at FROM credits WHERE doctor_id = ?',
            [$request->user['id']]
        ) ?? ['allocated' => 0, 'consumed' => 0, 'remaining' => 0];
        // Flatten so the client receives { allocated, consumed, remaining, ... }
        // directly — the legacy Supabase RPC get_my_credits_balance returned the
        // bare row and every consumer (creditService) expects that shape.
        return $row;
    }

    public function transactions(Request $request): array
    {
        return [
            'transactions' => Database::instance()->select(
                'SELECT ct.id, ct.transaction_type, ct.amount, ct.notes,
                        ct.balance_before, ct.balance_after, ct.created_at,
                        c.title AS course_title, p.full_name AS student_name
                   FROM credit_transactions ct
                   LEFT JOIN courses c  ON c.id = ct.course_id
                   LEFT JOIN profiles p ON p.id = ct.student_id
                  WHERE ct.doctor_id = ?
                  ORDER BY ct.created_at DESC LIMIT 200',
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
        // Feature flag: doctor_credit_refunds — availability gate BEFORE any
        // ledger mutation. Balances/history are never touched by the flag.
        $this->flags->assertEnabledFor('doctor_credit_refunds', $request);

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
        // Feature flag: doctor_earnings — hides the earnings view while the
        // capability is switched off. READ-ONLY gate: no balance, transaction or
        // historical record is ever modified by disabling this flag.
        $this->flags->assertEnabled('doctor_earnings', $request);

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

}
