<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuditService;
use MedAcademy\Services\IntegrityService;
use MedAcademy\Services\SecurityEvidenceService;
use MedAcademy\Utils\Uuid;
use PDOException;

/**
 * RedeemCodeController — Credit Redeem Code system.
 *
 * A Credit Redeem Code is a CREDIT TOP-UP system ONLY:
 * super admin mints a code carrying a credit amount, an eligible doctor
 * redeems it, and the amount is added to the doctor's EXISTING credits
 * balance through the standard credit architecture. It never activates a
 * course, never enrolls a student and is never associated with a course
 * or a student.
 *
 * Endpoints (see routes/api.php):
 *   POST /redeem-codes              → create  (super_admin; quantity ≥ 1 = atomic bulk)
 *   GET  /redeem-codes              → list    (super_admin)
 *   POST /redeem-codes/{id}/revoke  → revoke  (super_admin)
 *   POST /redeem-codes/redeem       → redeem  (doctor)
 */
final class RedeemCodeController
{
    /** Code alphabet — no 0/O/1/I/L so hand-typed codes are unambiguous. */
    private const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

    // ─────────────────────────────────────────────────────────────────────
    // Super Admin — create
    // ─────────────────────────────────────────────────────────────────────
    public function create(Request $request): array
    {
        $body = $request->json();

        $amount = (int) ($body['credit_amount'] ?? 0);
        if ($amount <= 0) {
            throw new ApiException(422, 'credit_amount must be a positive integer.');
        }
        if ($amount > 1_000_000) {
            throw new ApiException(422, 'credit_amount is too large.');
        }

        // Bulk mode: quantity = number of SEPARATE codes to mint, each worth
        // `credit_amount` credits (10 × 50 → ten independent 50-credit codes,
        // 500 total potential — NOT one 500-credit code). Default 1 keeps the
        // legacy single-code behavior. Server-side cap prevents abuse;
        // validation is never trusted from the client.
        $quantity = (int) ($body['quantity'] ?? 1);
        if ($quantity < 1) {
            throw new ApiException(422, 'quantity must be a positive integer.');
        }
        if ($quantity > 200) {
            throw new ApiException(422, 'quantity exceeds the maximum of 200 codes per batch.');
        }

        $assigned = isset($body['assigned_doctor_id']) && $body['assigned_doctor_id'] !== null && $body['assigned_doctor_id'] !== ''
            ? Uuid::normalize((string) $body['assigned_doctor_id'])
            : null;
        if ($assigned !== null) {
            $doc = Database::instance()->row(
                "SELECT id FROM profiles WHERE id = ? AND role = 'doctor'",
                [$assigned]
            );
            if ($doc === null) {
                throw new ApiException(422, 'Assigned doctor not found.');
            }
        }

        $expiresAt = null;
        if (isset($body['expires_at']) && $body['expires_at'] !== null && $body['expires_at'] !== '') {
            $ts = strtotime((string) $body['expires_at']);
            if ($ts === false) {
                throw new ApiException(422, 'expires_at is not a valid date.');
            }
            if ($ts <= time()) {
                throw new ApiException(422, 'expires_at must be in the future.');
            }
            $expiresAt = gmdate('Y-m-d H:i:s', $ts);
        }

        $actor = $request->user['id'];

        // Server-side generation, ATOMIC across the whole batch: every code
        // is inserted inside ONE transaction, so the operation either creates
        // all $quantity codes or rolls back leaving no partial batch. The
        // unique index on `code` is the authoritative guard — a duplicate-key
        // insert fails only its own statement, so the colliding code is
        // regenerated (CSPRNG, never derived from the loop index) and retried
        // inside the still-open transaction. Any other error propagates and
        // rolls back the entire batch.
        $created = [];
        Database::instance()->transaction(function (Database $db) use ($amount, $quantity, $assigned, $expiresAt, $actor, &$created) {
            for ($i = 0; $i < $quantity; $i++) {
                $id = Uuid::v4();
                $code = null;
                for ($attempt = 0; $attempt < 5; $attempt++) {
                    $candidate = self::generateCode();
                    try {
                        $db->insert(
                            'INSERT INTO credit_redeem_codes
                                (id, code, credit_amount, assigned_doctor_id, status, created_by, created_at, expires_at)
                             VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), ?)',
                            [$id, $candidate, $amount, $assigned, 'unused', $actor, $expiresAt]
                        );
                        $code = $candidate;
                        break;
                    } catch (\Throwable $e) {
                        if (!self::isDuplicateKey($e)) {
                            throw $e; // non-collision → whole batch rolls back
                        }
                        // code collision → regenerate this row's code
                    }
                }
                if ($code === null) {
                    throw new ApiException(500, 'Could not generate unique redeem codes. Please try again.');
                }
                // Audit without the plaintext code — only the record id.
                AuditService::write($actor, 'redeem_code_created', [
                    'code_id'            => $id,
                    'credit_amount'      => $amount,
                    'assigned_doctor_id' => $assigned,
                    'expires_at'         => $expiresAt,
                    'batch_size'         => $quantity,
                ]);
                $created[] = [
                    'id'                 => $id,
                    'code'               => $code,
                    'credit_amount'      => $amount,
                    'assigned_doctor_id' => $assigned,
                    'status'             => 'unused',
                    'expires_at'         => $expiresAt,
                ];
            }
        });

        return [
            'success'            => true,
            'count'              => count($created),
            'total_credit_value' => count($created) * $amount,
            'redeem_codes'       => $created,
            // Backward-compatible single-code shape (first of the batch).
            'redeem_code'        => $created[0],
        ];
    }

    // ─────────────────────────────────────────────────────────────────────
    // Super Admin — list (search + status filter)
    // ─────────────────────────────────────────────────────────────────────
    public function list(Request $request): array
    {
        $status = (string) $request->query('status', 'all');
        $search = trim((string) $request->query('search', ''));
        $limit  = min(500, max(1, (int) $request->query('limit', 200)));

        $where = [];
        $params = [];

        if (in_array($status, ['unused', 'redeemed', 'expired', 'revoked'], true)) {
            if ($status === 'expired') {
                // Effective expiry: marked expired, or unused but past expires_at.
                $where[] = "(crc.status = 'expired' OR (crc.status = 'unused' AND crc.expires_at IS NOT NULL AND crc.expires_at <= UTC_TIMESTAMP(6)))";
            } else {
                $where[] = 'crc.status = ?';
                $params[] = $status;
            }
        }

        // Archived redeemed codes are hidden from every default view — the
        // product treats "Remove" on a redeemed code as permanent removal
        // from the active list. (Financial history stays in the DB row.)
        $where[] = 'crc.archived_at IS NULL';

        if ($search !== '') {
            $where[] = '(crc.code LIKE ? OR ap.full_name LIKE ? OR ap.public_user_id LIKE ? OR rp.full_name LIKE ? OR rp.public_user_id LIKE ?)';
            $like = '%' . $search . '%';
            array_push($params, $like, $like, $like, $like, $like);
        }

        $sql =
            "SELECT crc.id, crc.code, crc.credit_amount, crc.assigned_doctor_id, crc.status,
                    crc.redeemed_by, crc.redeemed_at, crc.created_at, crc.expires_at,
                    crc.revoked_at, crc.revoked_by, crc.archived_at,
                    ap.full_name      AS assigned_doctor_name,
                    ap.public_user_id AS assigned_doctor_public_id,
                    rp.full_name      AS redeemed_by_name,
                    rp.public_user_id AS redeemed_by_public_id,
                    CASE
                        WHEN crc.status = 'unused' AND crc.expires_at IS NOT NULL AND crc.expires_at <= UTC_TIMESTAMP(6)
                            THEN 'expired'
                        ELSE crc.status
                    END AS effective_status
               FROM credit_redeem_codes crc
               LEFT JOIN profiles ap ON ap.id = crc.assigned_doctor_id
               LEFT JOIN profiles rp ON rp.id = crc.redeemed_by"
            . (count($where) ? ' WHERE ' . implode(' AND ', $where) : '')
            . ' ORDER BY crc.created_at DESC LIMIT ' . $limit;

        $rows = Database::instance()->select($sql, $params);

        // Expose the effective status as `status` so the UI reflects backend
        // authority (an unused-but-past-expiry code shows as expired).
        foreach ($rows as &$r) {
            $r['status'] = $r['effective_status'];
            unset($r['effective_status']);
        }
        unset($r);

        return ['redeem_codes' => $rows];
    }

    // ─────────────────────────────────────────────────────────────────────
    // Super Admin — revoke = PERMANENT DELETE of an UNUSED code.
    //
    // Product rule: "Revoke" removes the redeemable code from the active
    // table entirely. The code can never be redeemed afterward (the row no
    // longer exists; redemption looks up by code and finds nothing →
    // 'Invalid redeem code'). Evidence is preserved as an audit-log entry
    // recording the code string, amount and reason WITHOUT keeping the code
    // redeemable. Credits/credit_transactions are never touched (an unused
    // code has no transactions).
    //
    // Redeemed codes are REFUSED (409): deleting them would destroy the
    // redeemed_by/redeemed_at accounting record. The UI offers a separate
    // ARCHIVE action for redeemed codes that only HIDES them from the active
    // list (archived_at flag), never destroying financial history.
    //
    // Identifier contract: route /redeem-codes/{id}/revoke → internal UUID
    // route param (body accepted for legacy callers; param wins).
    // ─────────────────────────────────────────────────────────────────────
    public function revoke(Request $request): array
    {
        $bodyId = (string) ($request->json()['id'] ?? $request->json()['code_id'] ?? '');
        $rawId  = (string) ($request->params['id'] ?? '') ?: $bodyId;
        $codeId = Uuid::normalize($rawId);
        $reason = trim((string) ($request->json()['reason'] ?? ''));
        $actor = $request->user['id'];

        Database::instance()->transaction(function (Database $db) use ($codeId, $actor, $reason) {
            $row = $db->row(
                'SELECT id, code, credit_amount, status FROM credit_redeem_codes WHERE id = ? FOR UPDATE',
                [$codeId]
            );
            if ($row === null) {
                throw new ApiException(404, 'Redeem code not found.');
            }
            if ($row['status'] !== 'unused') {
                throw new ApiException(409, 'Only unused redeem codes can be revoked. Redeemed codes are kept for accounting history.');
            }

            // Race-safe: if a concurrent redemption flips the status between
            // our SELECT and this DELETE, the guard matches 0 rows, rowCount
            // is 0, and the exception aborts the transaction before any
            // history-bearing row is lost.
            $deleted = $db->query(
                "DELETE FROM credit_redeem_codes WHERE id = ? AND status = 'unused'",
                [$codeId]
            );
            if ($deleted->rowCount() < 1) {
                throw new ApiException(409, 'Redeem code state changed — refresh and try again.');
            }

            // Audit evidence: code string + amount live in the audit log, NOT
            // in a redeemable row. The code can never be redeemed again.
            AuditService::write($actor, 'redeem_code_deleted', [
                'code_id'       => $codeId,
                'code'          => $row['code'],
                'credit_amount' => (int) $row['credit_amount'],
                'reason'        => $reason !== '' ? $reason : 'revoked_by_super_admin',
            ]);
        });

        return ['success' => true, 'deleted' => true];
    }

    // ─────────────────────────────────────────────────────────────────────
    // Super Admin — archive a REDEEMED code (hide from the active list).
    //
    // The row is KEPT (redeemed_by / redeemed_at and the linked
    // credit_transaction stay intact for accounting) but flagged with
    // archived_at so list()/search exclude it. It is already status=
    // 'redeemed', so it can never be redeemed again regardless.
    // ─────────────────────────────────────────────────────────────────────
    public function archive(Request $request): array
    {
        $bodyId = (string) ($request->json()['id'] ?? $request->json()['code_id'] ?? '');
        $rawId  = (string) ($request->params['id'] ?? '') ?: $bodyId;
        $codeId = Uuid::normalize($rawId);
        $actor = $request->user['id'];

        Database::instance()->transaction(function (Database $db) use ($codeId, $actor) {
            $row = $db->row(
                'SELECT id, code, status, archived_at FROM credit_redeem_codes WHERE id = ? FOR UPDATE',
                [$codeId]
            );
            if ($row === null) {
                throw new ApiException(404, 'Redeem code not found.');
            }
            if ($row['status'] !== 'redeemed') {
                throw new ApiException(409, 'Only redeemed codes can be archived. Unused codes are revoked (deleted) instead.');
            }
            if (!empty($row['archived_at'])) {
                return; // idempotent
            }

            $db->query(
                'UPDATE credit_redeem_codes SET archived_at = UTC_TIMESTAMP(6) WHERE id = ?',
                [$codeId]
            );

            AuditService::write($actor, 'redeem_code_archived', [
                'code_id' => $codeId,
                'code'    => $row['code'],
            ]);
        });

        return ['success' => true];
    }

    // ─────────────────────────────────────────────────────────────────────
    // Doctor — redeem (ATOMIC)
    //
    // One transaction, one row lock:
    //   lock code row (FOR UPDATE) → validate status/expiry/assignment →
    //   lock doctor's credits row (FOR UPDATE) → add amount → ledger row
    //   (balance_before/after) → mark code redeemed (guarded) → audit →
    //   COMMIT.
    //
    // A second concurrent redeem of the same code blocks on the FOR UPDATE
    // lock, then sees status='redeemed' and fails — exactly one grant.
    // Any failure rolls back EVERYTHING (no credits without redemption,
    // no redemption without credits).
    // ─────────────────────────────────────────────────────────────────────
    public function redeem(Request $request): array
    {
        // ── SERVER-SIDE APP-INTEGRITY POLICY (protected financial action) ──
        // A tampered APK must not be able to redeem codes; enforcement tier
        // is operator-controlled (security_config.extras.play_integrity).
        IntegrityService::assertActionAllowed(
            (string) $request->user['id'],
            'redeem',
            $request->header(IntegrityService::HEADER),
            $request->clientIp()
        );

        // ── SERVER-SIDE DEVICE-EVIDENCE POLICY (independent second gate) ──
 // Keystore-signed, challenge-bound evidence (SecurityEvidenceService).
 SecurityEvidenceService::assertEvidenceAllowed(
     (string) $request->user['id'],
     'redeem',
     $request->header(SecurityEvidenceService::EVIDENCE_HEADER),
     $request->clientIp()
 );

        $code = self::normalizeCode((string) ($request->json()['code'] ?? ''));
        if ($code === '') {
            throw new ApiException(422, 'Invalid redeem code.');
        }
        $doctorId = $request->user['id'];

        $result = Database::instance()->transaction(function (Database $db) use ($code, $doctorId) {
            // 1–3. Find + lock the code row.
            $row = $db->row(
                'SELECT id, code, credit_amount, assigned_doctor_id, status, expires_at,
                        (expires_at IS NOT NULL AND expires_at <= UTC_TIMESTAMP(6)) AS is_expired
                   FROM credit_redeem_codes
                  WHERE code = ?
                  FOR UPDATE',
                [$code]
            );
            if ($row === null) {
                throw new ApiException(404, 'Invalid redeem code.');
            }

            // 4–7. Status / expiry / assignment rules.
            switch ($row['status']) {
                case 'redeemed':
                    throw new ApiException(409, 'This redeem code has already been redeemed.');
                case 'revoked':
                    throw new ApiException(410, 'This redeem code is no longer valid.');
                case 'expired':
                    throw new ApiException(410, 'This redeem code has expired.');
            }
            if (!empty($row['is_expired'])) {
                throw new ApiException(410, 'This redeem code has expired.');
            }
            if ($row['assigned_doctor_id'] !== null && $row['assigned_doctor_id'] !== $doctorId) {
                throw new ApiException(403, 'This redeem code cannot be redeemed by this account.');
            }

            // 8–9. Authoritative amount comes from the database row only.
            $amount = (int) $row['credit_amount'];

            // 10. Add credits using the EXISTING credit architecture
            //     (same credits upsert used by admin allocation), row-locked.
            $credits = $db->row(
                'SELECT remaining FROM credits WHERE doctor_id = ? FOR UPDATE',
                [$doctorId]
            );
            $balanceBefore = (int) ($credits['remaining'] ?? 0);
            $balanceAfter = $balanceBefore + $amount;

            if ($credits !== null) {
                $db->query(
                    'UPDATE credits
                        SET allocated = allocated + ?, remaining = ?, updated_at = UTC_TIMESTAMP(6)
                      WHERE doctor_id = ?',
                    [$amount, $balanceAfter, $doctorId]
                );
            } else {
                $db->query(
                    'INSERT INTO credits (id, doctor_id, allocated, remaining, updated_at)
                     VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6))',
                    [Uuid::v4(), $doctorId, $amount, $balanceAfter]
                );
            }

            // 11. Ledger transaction in the EXISTING credit_transactions table.
            // transaction_type must satisfy chk_credit_transactions_transaction_type
            // ('allocation'|'consumption'|'deduction'|'restoration') — a redeem
            // code top-up is an allocation (same class as admin bulk-allocate).
            // The redeem-code context is preserved in `notes` + the audit log,
            // NOT by inventing a new enum value (that would violate the DB
            // CHECK constraint and roll back the entire redemption).
            $transactionId = Uuid::v4();
            $db->insert(
                'INSERT INTO credit_transactions
                    (id, doctor_id, transaction_type, amount, performed_by, notes, balance_before, balance_after, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
                [$transactionId, $doctorId, 'allocation', $amount, $doctorId,
                 'Credit Redeem Code: ' . $row['code'], $balanceBefore, $balanceAfter]
            );

            // 12–14. Mark redeemed — guarded so only an unused row transitions.
            $db->query(
                "UPDATE credit_redeem_codes
                    SET status = 'redeemed', redeemed_by = ?, redeemed_at = UTC_TIMESTAMP(6)
                  WHERE id = ? AND status = 'unused'",
                [$doctorId, $row['id']]
            );

            // 15. Audit record (inside the transaction — all-or-nothing).
            // The credit_transactions row id is captured first so the audit
            // entry links the ledger record to this redemption.
            AuditService::write($doctorId, 'redeem_code_redeemed', [
                'code_id'        => $row['id'],
                'credit_amount'  => $amount,
                'doctor_id'      => $doctorId,
                'transaction_id' => $transactionId,
            ]);

            // 16. COMMIT happens in Database::transaction().
            return [
                'code'           => $row['code'],
                'amount'         => $amount,
                'balance_before' => $balanceBefore,
                'balance_after'  => $balanceAfter,
                'transaction_id' => $transactionId,
            ];
        });

        return ['success' => true] + $result;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Server-side, CSPRNG code generation: MED-XXXX-XXXX-XXXX
     * 12 random chars from a 31-symbol alphabet ≈ 59 bits of entropy.
     * The credit amount is NEVER encoded in the code.
     */
    private static function generateCode(): string
    {
        $groups = [];
        for ($g = 0; $g < 3; $g++) {
            $s = '';
            for ($i = 0; $i < 4; $i++) {
                $s .= self::CODE_ALPHABET[random_int(0, strlen(self::CODE_ALPHABET) - 1)];
            }
            $groups[] = $s;
        }
        return 'MED-' . implode('-', $groups);
    }

    /**
     * Normalize a submitted code: uppercase, strip separators/spaces, and
     * rebuild the canonical MED-XXXX-XXXX-XXXX form. Returns '' for anything
     * that cannot be canonical (which then fails lookup as invalid).
     */
    private static function normalizeCode(string $raw): string
    {
        $clean = strtoupper((string) preg_replace('/[^A-Za-z0-9]/', '', $raw));
        if (strlen($clean) !== 15 || !str_starts_with($clean, 'MED')) {
            return '';
        }
        return 'MED-' . substr($clean, 3, 4) . '-' . substr($clean, 7, 4) . '-' . substr($clean, 11, 4);
    }

    /** True when a failed insert is a duplicate-key collision (SQLSTATE 23000 / err 1062). */
    private static function isDuplicateKey(\Throwable $e): bool
    {
        if (!$e instanceof PDOException) {
            return false;
        }
        $driverCode = (int) ($e->errorInfo[1] ?? 0);
        return $driverCode === 1062
            || str_contains($e->getMessage(), '1062')
            || str_contains($e->getMessage(), 'Duplicate entry');
    }
}
