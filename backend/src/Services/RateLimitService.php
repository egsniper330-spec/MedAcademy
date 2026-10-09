<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Utils\Config;
use MedAcademy\Utils\Uuid;

/**
 * RateLimitService — the shared fixed-window counter behind every
 * abuse-prone endpoint (login, registration, password reset, token refresh,
 * challenge issuance, evidence verification).
 *
 * WHY IT EXISTS
 * ─────────────
 * AuthService used to own a private rateLimit() helper that only login and
 * registration could call. Password reset, refresh-token rotation and the
 * security-challenge endpoints had no throttle at all, so each was a cheap
 * unauthenticated/authenticated amplification primitive. The logic now lives
 * here so every call site shares ONE implementation, ONE storage table
 * (`rate_limits`, already in the schema — no migration required) and ONE
 * error contract.
 *
 * WINDOW SEMANTICS
 * ────────────────
 * Fixed windows aligned to `time() % window`. The counter resets by design at
 * the window boundary, so a legitimate user can never be locked out
 * PERMANENTLY — the worst case is one window.
 *
 * IDENTITY SEMANTICS (shared carrier NAT)
 * ───────────────────────────────────────
 * Per-IP limits MUST be generous: mobile carrier NAT puts hundreds of
 * unrelated subscribers behind one address, so a tight per-IP ceiling would
 * let one abuser starve a whole carrier block. Where the abuse is
 * account-scoped (reset-token guessing, challenge flooding, evidence spam),
 * the identifier is the ACCOUNT, which is unaffected by shared IPs.
 *
 * TRUST MODEL
 * ───────────
 * The identifier is derived from Request::clientIp(), which reads
 * REMOTE_ADDR only — `X-Forwarded-For` is never consulted unless an operator
 * explicitly configures a trusted proxy, so a client cannot spoof its way out
 * of (or into) a bucket by sending forged forwarding headers.
 *
 * FAILURE CONTRACT
 * ────────────────
 * HTTP 429 { error: { message, code: 'rate_limited' } } — identical to the
 * historical AuthService behaviour, so existing clients keep working.
 */
final class RateLimitService
{
    /**
     * Count one request against $identifier for $operation and refuse it when
     * the window's total exceeds $max.
     *
     * @param string $operation    Bucket namespace (keeps e.g. login and
     *                             forgot-password counters independent even
     *                             when they share an identifier).
     * @param string $identifier   Who is being limited (e.g. 'ip:1.2.3.4',
     *                             'user:<uuid>', 'account:<normalized id>').
     * @param int    $max          Requests permitted per window.
     * @param int    $windowSeconds Window length in seconds.
     */
    public static function hit(string $operation, string $identifier, int $max, int $windowSeconds): void
    {
        if ($max <= 0 || $windowSeconds <= 0) {
            return; // operator disabled this limiter via config
        }

        $windowStart = gmdate('Y-m-d H:i:s', intdiv(time(), $windowSeconds) * $windowSeconds);

        $db = Database::instance();
        $db->query(
            'INSERT INTO rate_limits (id, identifier, operation, window_start, request_count)
             VALUES (?, ?, ?, ?, 1)
             ON DUPLICATE KEY UPDATE request_count = request_count + 1',
            [Uuid::v4(), $identifier, $operation, $windowStart]
        );
        $count = (int) $db->value(
            'SELECT request_count FROM rate_limits WHERE identifier = ? AND operation = ? AND window_start = ?',
            [$identifier, $operation, $windowStart],
            0
        );

        if ($count > $max) {
            // Identical envelope to the historical AuthService helper:
            // 429 { error: { message, code: 'api_error', errors: ['rate_limited'] } }
            throw new ApiException(429, 'Too many attempts. Please try again later.', 'rate_limited');
        }
    }

    /**
     * Convenience: limit by client IP. $scope keeps per-IP buckets for
     * different operations from colliding.
     */
    public static function perIp(Request $request, string $scope, int $max, int $windowSeconds): void
    {
        self::hit($scope, 'ip:' . $request->clientIp(), $max, $windowSeconds);
    }

    /**
     * Convenience: limit by the authenticated account. Immune to shared-IP
     * NAT collisions; falls back to the IP when the caller is anonymous.
     */
    public static function perAccount(Request $request, string $scope, int $max, int $windowSeconds): void
    {
        $userId = (string) ($request->user['id'] ?? '');
        if ($userId !== '') {
            self::hit($scope, 'user:' . $userId, $max, $windowSeconds);
            return;
        }
        self::perIp($request, $scope, $max, $windowSeconds);
    }

    /** Optional limiter: identifier + an arbitrary extra dimension. */
    public static function forKey(string $scope, string $identity, int $max, int $windowSeconds): void
    {
        self::hit($scope, $identity, $max, $windowSeconds);
    }

    /**
     * Backwards-compatible shim for AuthService's original helper.
     * Historical callers pass a pre-composed identifier ('login:1.2.3.4') and
     * operation 'auth'. Both the identifier and the operation columns are
     * written exactly as before, so a deploy does not reset live counters.
     */
    public static function legacy(string $identifier, int $max, int $windowSeconds): void
    {
        self::hit('auth', $identifier, $max, $windowSeconds);
    }

    // ── Tunables (all operator-overridable; defaults are lockout-safe) ──────

    public static function forgotPasswordPerIpPerHour(): int
    {
        return Config::int('RATE_LIMIT_FORGOT_PASSWORD_PER_HOUR', 20);
    }

    public static function forgotPasswordPerAccountPerHour(): int
    {
        return Config::int('RATE_LIMIT_FORGOT_PASSWORD_PER_ACCOUNT_PER_HOUR', 5);
    }

    public static function resetPasswordPerIpPerHour(): int
    {
        return Config::int('RATE_LIMIT_RESET_PASSWORD_PER_HOUR', 40);
    }

    public static function refreshPerIpPerMinute(): int
    {
        return Config::int('RATE_LIMIT_REFRESH_PER_MINUTE', 120);
    }

    public static function changePasswordPerAccountPerHour(): int
    {
        return Config::int('RATE_LIMIT_CHANGE_PASSWORD_PER_HOUR', 20);
    }

    public static function challengePerAccountPerMinute(): int
    {
        return Config::int('RATE_LIMIT_SECURITY_CHALLENGE_PER_MINUTE', 60);
    }

    public static function evidencePerAccountPerMinute(): int
    {
        return Config::int('RATE_LIMIT_SECURITY_EVIDENCE_PER_MINUTE', 60);
    }

    public static function deviceKeyPerAccountPerMinute(): int
    {
        return Config::int('RATE_LIMIT_DEVICE_KEY_PER_MINUTE', 20);
    }

    public static function integrityPerAccountPerMinute(): int
    {
        return Config::int('RATE_LIMIT_INTEGRITY_PER_MINUTE', 60);
    }

    public static function securityEventsPerAccountPerMinute(): int
    {
        return Config::int('RATE_LIMIT_SECURITY_EVENTS_PER_MINUTE', 300);
    }

    /**
     * Unauthenticated identifier lookups (phone→e-mail sign-in helper,
     * /auth/lookup, pre-login device check, registration conflict check).
     *
     * These MUST stay public — sign-in and sign-up cannot authenticate before
     * they run — but each one answers "does this identifier exist?", so an
     * unthrottled version is a bulk enumeration oracle. Sized well above any
     * real sign-in attempt (a user triggers 1–3 calls) while capping how fast
     * a script can walk a phone-number space.
     */
    public static function identifierLookupPerIpPerMinute(): int
    {
        return Config::int('RATE_LIMIT_IDENTIFIER_LOOKUP_PER_MINUTE', 60);
    }
}
