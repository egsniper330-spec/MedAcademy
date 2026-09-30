<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Database\Database;
use MedAcademy\Utils\Uuid;

/**
 * audit_logs writer. Mirrors the PG audit_action enum values used by the
 * RPCs (see schema enums — 100+ actions). The MySQL schema enforces the
 * same values via a CHECK constraint.
 *
 * Every event denormalizes the ACTOR identity (actor_id, actor_name,
 * actor_email, actor_role) into the row itself, so the Super Admin Audit
 * Trail shows who did what even if the profile is later renamed, trashed,
 * or hard-deleted (actor_id is ON DELETE SET NULL). The target user is
 * still stored in user_id / target_name. Details pass through a sanitizer
 * that drops credential-shaped keys and never stores full request bodies.
 */
final class AuditService
{
    /** Keys stripped from audit details (case-insensitive) — secrets must
     *  never reach the audit store, not even in nested payloads. */
    private const SENSITIVE_KEY_PATTERN = '/(password|passwd|secret|token|api_key|apikey|private_key|otp|authorization|cookie|credential)/i';

    /**
     * @param string $action one of the audit_action values
     * @param array<string,mixed> $details jsonb payload
     * @param string|null $actorIdOverride explicit ACTOR identity. When null
     *   the actor is resolved from $userId (internal writers pass the acting
     *   user first). Client-facing writers pass the authenticated identity
     *   here so the stored actor can never be forged by request payloads.
     */
    public static function write(
        ?string $userId,
        string $action,
        array $details = [],
        ?string $ipAddress = null,
        ?string $actorIdOverride = null
    ): void {
        $actor = self::resolveActor($actorIdOverride ?? $userId);

        Database::instance()->insert(
            'INSERT INTO audit_logs
                (id, user_id, actor_id, action, details, ip_address, created_at,
                 target_name, description, log_status, actor_name, actor_email, actor_role)
             VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), ?, ?, ?, ?, ?, ?)',
            [
                Uuid::v4(),
                $userId,
                $actor['id'],
                $action,
                json_encode(self::sanitizeDetails($details), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
                $ipAddress,
                self::stringOrNull($details['target_name'] ?? null, 512),
                self::stringOrNull($details['description'] ?? null, 2048),
                self::stringOrNull($details['log_status'] ?? null, 191) ?? 'success',
                $actor['name'],
                $actor['email'],
                $actor['role'],
            ]
        );
    }

    /**
     * Resolve the acting user's denormalized identity. Returns the
     * placeholder-free structure for system events (actor columns NULL).
     *
     * @return array{id:?string,name:?string,email:?string,role:?string}
     */
    private static function resolveActor(?string $userId): array
    {
        if ($userId === null || trim($userId) === '') {
            return ['id' => null, 'name' => null, 'email' => null, 'role' => null];
        }

        $row = null;
        try {
            $row = Database::instance()->select(
                'SELECT id, full_name, email, role FROM profiles WHERE id = ? LIMIT 1',
                [$userId]
            )[0] ?? null;
        } catch (\Throwable) {
            // Identity lookup must never block the audit write itself; the
            // row still records the raw actor id below.
        }

        return [
            'id'    => is_array($row) ? (string) $row['id'] : $userId,
            'name'  => is_array($row) && isset($row['full_name']) ? self::stringOrNull($row['full_name'], 512) : null,
            'email' => is_array($row) && isset($row['email']) ? self::stringOrNull($row['email'], 512) : null,
            'role'  => is_array($row) && isset($row['role']) ? self::stringOrNull($row['role'], 191) : null,
        ];
    }

    /**
     * Metadata sanitizer: drops credential-shaped keys (recursively), caps
     * string sizes, and enforces a bounded payload so a caller cannot blind-
     * store an entire request body. Non-scalar junk becomes null.
     *
     * @param array<string,mixed> $details
     * @return array<string,mixed>
     */
    public static function sanitizeDetails(array $details, int $depth = 0): array
    {
        if ($depth > 3) {
            return [];
        }

        $clean = [];
        foreach ($details as $key => $value) {
            if (!is_string($key) || $key === '') {
                continue;
            }
            if (preg_match(self::SENSITIVE_KEY_PATTERN, $key) === 1) {
                continue;
            }
            if ($value === null || is_scalar($value)) {
                $clean[$key] = is_string($value) ? self::stringOrNull($value, 2048) : $value;
                continue;
            }
            if (is_array($value)) {
                if (count($value) > 50) {
                    $clean[$key] = ['_truncated' => count($value) . ' entries omitted'];
                    continue;
                }
                $clean[$key] = self::sanitizeDetails($value, $depth + 1);
                continue;
            }
            // objects / closures / resources never belong in an audit row
            $clean[$key] = null;
        }

        return $clean;
    }

    private static function stringOrNull(mixed $value, int $maxLen): ?string
    {
        if ($value === null || !is_scalar($value)) {
            return null;
        }
        $s = trim((string) $value);
        if ($s === '') {
            return null;
        }
        return mb_substr($s, 0, $maxLen);
    }
}
