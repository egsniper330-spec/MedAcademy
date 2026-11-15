<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Utils\Config;

/**
 * Progressive login cooldown keyed to (source IP, normalized identifier).
 *
 * WHAT IT IS — and IS NOT
 * ───────────────────────
 * An additional defence against guessing one account from one source. It is
 * NOT an account lockout: the key contains the source, so failures from one
 * source never block a legitimate user on another source, and an attacker
 * cannot lock an account out globally with unauthenticated requests.
 * It is also NOT a complete defence against distributed credential stuffing
 * (many sources, one account). The per-IP limiter and the per-account
 * monitoring remain the throughput caps.
 *
 * POLICY (defaults; each is overridable by env)
 *   failures 1–4 : no pair cooldown
 *   failure 5    : 30 s
 *   failure 6    : 60 s
 *   failure 7    : 120 s
 *   further      : exponential, capped at 300 s
 *   no failure for 24 h resets the history to zero.
 *
 * KEYS
 * ────
 * pair_key = HMAC-SHA256(LOGIN_THROTTLE_HMAC_KEY, "<ip>|<normalized identifier>").
 * No raw identifier or IP is stored. The key is a required secret: without it
 * the pair throttle is disabled (logged) and the per-IP limiter still applies.
 *
 * CONCURRENCY
 * ───────────
 * Failures use one atomic upsert whose arithmetic runs inside the database, so
 * concurrent failures cannot lose increments. A check during an active cooldown
 * only READS state and never writes, so it cannot extend the cooldown.
 */
final class LoginPairThrottleService
{
    /** Failures tolerated before any pair cooldown applies. */
    public const FREE_FAILURES = 4;

    /** Failure history older than this is treated as fresh. */
    public const DECAY_SECONDS = 86400;

    /** Ceiling on any single cooldown. */
    public const MAX_COOLDOWN_SECONDS = 300;

    /**
     * Cooldown seconds for the failure that brings the count to $failCount.
     * Pure function — the policy under test.
     */
    public static function cooldownForFailCount(int $failCount): int
    {
        if ($failCount <= self::FREE_FAILURES) {
            return 0;
        }
        $base = max(1, Config::int('LOGIN_PAIR_BASE_COOLDOWN_SECONDS', 30));
        $cap  = max($base, min(self::MAX_COOLDOWN_SECONDS, Config::int('LOGIN_PAIR_MAX_COOLDOWN_SECONDS', self::MAX_COOLDOWN_SECONDS)));
        // failure 5 → base, 6 → 2×base, 7 → 4×base, … capped.
        $exp = $failCount - (self::FREE_FAILURES + 1);
        if ($exp >= 16) {
            return $cap; // avoid overflow; far beyond any cap
        }
        return (int) min($cap, $base * (2 ** $exp));
    }

    /**
     * Stable pair key. Identifier must already be normalized by the caller
     * (see self::normalizeIdentifier()).
     */
    public static function pairKey(string $ip, string $normalizedIdentifier): ?string
    {
        $key = Config::string('LOGIN_THROTTLE_HMAC_KEY', '');
        if ($key === '') {
            return null;
        }
        return hash_hmac('sha256', $ip . '|' . $normalizedIdentifier, $key);
    }

    /**
     * Normalize an identifier the way the login resolver effectively matches it:
     * Public User ID canonicalised; e-mail lower-cased; otherwise the trimmed
     * value with phone separators removed. Two spellings that resolve to the
     * same account therefore share one pair key.
     */
    public static function normalizeIdentifier(string $identifier): string
    {
        $identifier = trim($identifier);
        $canonicalId = AuthService::normalizePublicUserId($identifier);
        if ($canonicalId !== null) {
            return 'id:' . $canonicalId;
        }
        if (str_contains($identifier, '@')) {
            return 'email:' . strtolower($identifier);
        }
        $digits = preg_replace('/[\s\-().]/', '', $identifier) ?? $identifier;
        return 'other:' . strtolower($digits);
    }

    /**
     * Refuse the attempt if the pair is inside an active cooldown. READ-ONLY:
     * a refused attempt never changes state, so it cannot extend the cooldown.
     *
     * @throws ApiException 429 with the same envelope as the per-IP limiter
     */
    public function assertAllowed(string $ip, string $identifier): void
    {
        $key = self::pairKey($ip, self::normalizeIdentifier($identifier));
        if ($key === null) {
            return;
        }
        $row = Database::instance()->row(
            'SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(6), next_allowed_at) AS remaining
               FROM login_pair_state WHERE pair_key = ? AND next_allowed_at > UTC_TIMESTAMP(6)',
            [$key]
        );
        if ($row === null) {
            return;
        }
        $remaining = max(1, (int) ($row['remaining'] ?? 1));
        throw new LoginCooldownException($remaining);
    }

    /**
     * Record one failed attempt for the pair. Atomic: the reset-on-decay,
     * increment and cooldown assignment all happen in one statement, and the
     * cooldown is set only when the pair is not already cooling down, so a
     * failure during a cooldown cannot extend it.
     */
    public function recordFailure(string $ip, string $identifier): void
    {
        $key = self::pairKey($ip, self::normalizeIdentifier($identifier));
        if ($key === null) {
            return;
        }
        $db = Database::instance();
        $decay = self::DECAY_SECONDS;
        $base = max(1, Config::int('LOGIN_PAIR_BASE_COOLDOWN_SECONDS', 30));
        $cap  = max($base, min(self::MAX_COOLDOWN_SECONDS, Config::int('LOGIN_PAIR_MAX_COOLDOWN_SECONDS', self::MAX_COOLDOWN_SECONDS)));
        $free = self::FREE_FAILURES;

        // One atomic upsert. MySQL evaluates ON DUPLICATE KEY UPDATE assignments
        // left to right, so the order matters: the cooldown is computed from the
        // OLD state first, then fail_count, then last_failure_at.
        //  • stale history (last failure > 24 h ago) restarts the count at 1;
        //  • a cooldown already in force is kept as-is (failures never extend it);
        //  • otherwise the new count (old + 1) sets the cooldown once past the
        //    free-failure threshold.
        $stale = "(last_failure_at IS NULL OR last_failure_at < DATE_SUB(UTC_TIMESTAMP(6), INTERVAL {$decay} SECOND))";
        $newCount = "IF({$stale}, 1, fail_count + 1)";
        $db->query(
            "INSERT INTO login_pair_state (pair_key, fail_count, last_failure_at, next_allowed_at)
             VALUES (?, 1, UTC_TIMESTAMP(6), NULL)
             ON DUPLICATE KEY UPDATE
               next_allowed_at = IF(
                 next_allowed_at IS NOT NULL AND next_allowed_at > UTC_TIMESTAMP(6),
                 next_allowed_at,
                 IF({$newCount} > {$free},
                    DATE_ADD(UTC_TIMESTAMP(6), INTERVAL LEAST({$cap}, {$base} * POW(2, LEAST({$newCount} - {$free} - 1, 16))) SECOND),
                    NULL)),
               fail_count = {$newCount},
               last_failure_at = UTC_TIMESTAMP(6)",
            [$key]
        );
    }

    /** Success clears this pair's state. Other sources and identifiers are untouched. */
    public function clear(string $ip, string $identifier): void
    {
        $key = self::pairKey($ip, self::normalizeIdentifier($identifier));
        if ($key === null) {
            return;
        }
        Database::instance()->query('DELETE FROM login_pair_state WHERE pair_key = ?', [$key]);
    }

    /**
     * Bounded retention. Removes rows whose last failure is older than the
     * decay window (they would be reset on next use anyway) and returns the
     * number deleted. Safe to run repeatedly; see backend/scripts/login-pair-cleanup.php.
     */
    public function purgeExpired(int $batchSize = 5000): int
    {
        $batchSize = max(1, min(50000, $batchSize));
        return Database::instance()->query(
            'DELETE FROM login_pair_state
              WHERE last_failure_at < DATE_SUB(UTC_TIMESTAMP(6), INTERVAL ' . self::DECAY_SECONDS . ' SECOND)
              LIMIT ' . $batchSize
        )->rowCount();
    }
}
