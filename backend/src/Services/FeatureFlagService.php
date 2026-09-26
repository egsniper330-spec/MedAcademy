<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Database\Database;
use MedAcademy\Http\FeatureDisabledException;
use MedAcademy\Http\Request;

/**
 * Server-authoritative FEATURE FLAGS.
 *
 * ─── Contract ────────────────────────────────────────────────────────────────
 * Every flag this service knows about is declared in REGISTRY — the SINGLE
 * source of truth for the key space, its human label, its risk posture and its
 * default. That gives three guarantees the Super Admin UI depends on:
 *
 *   1. No arbitrary keys. `setEnabled()` rejects any key that is not in the
 *      registry (HTTP 422), so the table can never become an untrusted
 *      key/value store and no flag can be invented at runtime.
 *   2. No UI-only flags. Enforcement lives on the SERVER: protected endpoints
 *      call `assertEnabled()` and receive a structured 403
 *      { error: { code: 'feature_disabled', feature: '<key>' } }.
 *   3. Availability beats configuration. A missing row, a missing table or any
 *      read failure resolves to the registry DEFAULT (all current flags default
 *      to `true`) — configuration can never accidentally disable a capability.
 *
 * ─── Priority ────────────────────────────────────────────────────────────────
 * Feature flags are an AVAILABILITY policy, exactly like Maintenance Mode, and
 * are evaluated strictly AFTER the stronger policies: authentication,
 * account-suspended/revoked checks, forced update and maintenance remain
 * authoritative. A flag can never re-enable something those policies denied.
 *
 * ─── Super Admin ─────────────────────────────────────────────────────────────
 * Flags marked `superadmin_exempt` are bypassed for an authenticated Super Admin
 * so an administrator can never be locked out of the control that re-enables the
 * capability (the `user_login` flag is the critical case: sign-in is refused for
 * everyone else but a Super Admin can always get in and turn it back on).
 */
final class FeatureFlagService
{
    /** How long (seconds) a worker may serve a cached flag state. */
    public const CACHE_TTL = 15;

    /**
     * THE REGISTRY — key => metadata.
     *
     * `default` is what applies when the row is missing or unreadable. All
     * current capabilities default to ENABLED: turning something off must be a
     * deliberate Super Admin action, never the result of a config failure.
     *
     * `superadmin_exempt` = a Super Admin is not blocked by this flag (their
     * request is still subject to auth/role/security policies as usual).
     */
    public const REGISTRY = [
        'user_registration' => [
            'label'       => 'New User Registration',
            'description' => 'Allow new accounts. Enforced on POST /auth/register.',
            'category'    => 'access',
            'default'     => true,
            'superadmin_exempt' => false,
        ],
        'user_login' => [
            'label'       => 'User Login',
            'description' => 'Allow new sign-ins. Super Admin sign-in is always allowed so this flag can be re-enabled.',
            'category'    => 'access',
            'default'     => true,
            'superadmin_exempt' => true,
        ],
        'course_creation' => [
            'label'       => 'Course Creation',
            'description' => 'Allow creating new courses. Enforced on POST /courses.',
            'category'    => 'courses',
            'default'     => true,
            'superadmin_exempt' => true,
        ],
        'doctor_course_publishing' => [
            'label'       => 'Doctor Course Publishing',
            'description' => 'Allow publishing a course. Enforced on POST /courses/{id}/publish. Existing published courses and drafts are never modified.',
            'category'    => 'courses',
            'default'     => true,
            'superadmin_exempt' => true,
        ],
        'course_enrollment' => [
            'label'       => 'Course Enrollment',
            'description' => 'Allow enrolling students into a course. Enforced on POST /courses/{id}/enroll.',
            'category'    => 'courses',
            'default'     => true,
            'superadmin_exempt' => true,
        ],
        'doctor_earnings' => [
            'label'       => 'Doctor Earnings',
            'description' => 'Expose doctor earnings to doctors. Enforced on the revenue read path. Balances and history are never modified.',
            'category'    => 'finance',
            'default'     => true,
            'superadmin_exempt' => true,
        ],

        // ── Expanded registry (capability inventory, second pass) ────────────
        // Each key below was audited for: (1) a real user-facing capability,
        // (2) a reliable server-side enforcement point, (3) no data loss or
        // lockout risk when disabled, (4) safe re-enable. Flags were NOT added
        // for capabilities without a safe enforcement point (reviews, ratings,
        // comments, favorites, messaging, certificates, withdrawals, payouts,
        // email/phone verification — see the platform audit report).
        'password_reset' => [
            'label'       => 'Password Reset',
            'description' => 'Allow the forgot/reset password flow. Enforced on POST /auth/forgot-password and POST /auth/reset-password. Authenticated password changes are never affected.',
            'category'    => 'access',
            'default'     => true,
            'superadmin_exempt' => true,
        ],
        'redeem_codes' => [
            'label'       => 'Redeem Codes',
            'description' => 'Allow doctors to redeem credit codes. Enforced on POST /redeem-codes/redeem. Codes, balances and history are never modified; re-enabling restores redemption.',
            'category'    => 'finance',
            'default'     => true,
            'superadmin_exempt' => true,
        ],
        'doctor_credit_refunds' => [
            'label'       => 'Doctor Credit Refunds',
            'description' => 'Allow admins to refund credits to a doctor. Enforced on POST /credits/refund. Ledgers and balances are never touched by the flag itself.',
            'category'    => 'finance',
            'default'     => true,
            'superadmin_exempt' => true,
        ],
        'user_management' => [
            'label'       => 'User Creation (Admin)',
            'description' => 'Allow admins to create managed users. Enforced on POST /admin/user-management and POST /student-operations. Existing accounts are unaffected.',
            'category'    => 'admin',
            'default'     => true,
            'superadmin_exempt' => true,
        ],
        'student_enrollment_credits' => [
            'label'       => 'Student Enrollment via Credits',
            'description' => 'Allow enrolling a student into a course using the doctor\'s credits. Enforced on POST /student-operations (credit modes) and POST /courses/{id}/enroll. Existing enrollments are unaffected.',
            'category'    => 'courses',
            'default'     => true,
            'superadmin_exempt' => true,
        ],
        'course_editing' => [
            'label'       => 'Course Editing',
            'description' => 'Allow editing an existing course. Enforced on PATCH /courses/{id}. Course content, lessons and enrollments are never modified by the flag itself.',
            'category'    => 'courses',
            'default'     => true,
            'superadmin_exempt' => true,
        ],

        // ── Video kill switches ──────────────────────────────────────────────
        // Separate from the per-provider policy (Video Providers console): these
        // stop the AUTHORIZATION step itself, which is the only reliable
        // server-side lever for a playback incident. Existing offline downloads
        // and DRM licences are never revoked or deleted by either flag.
        'video_playback' => [
            'label'       => 'Video Playback',
            'description' => 'Master switch for obtaining video authorization. Enforced on POST /video/otp and POST /video/offline-authorize. Already-downloaded offline videos keep working; re-enabling restores playback immediately.',
            'category'    => 'video',
            'default'     => true,
            'superadmin_exempt' => true,
        ],
        'video_offline_downloads' => [
            'label'       => 'Offline Video Downloads',
            'description' => 'Allow NEW offline downloads. Enforced on POST /video/offline-authorize only — online playback is unaffected and existing downloads are never deleted or corrupted.',
            'category'    => 'video',
            'default'     => true,
            'superadmin_exempt' => true,
        ],
        'video_library_sync' => [
            'label'       => 'Video Library Sync',
            'description' => 'Super Admin reconciliation of the Video Library with VdoCipher (remotely deleted / duplicate repair). Enforced on POST /video/sync-library. A disabled flag blocks new syncs only — it never marks anything deleted.',
            'category'    => 'video',
            'default'     => true,
            'superadmin_exempt' => true,
        ],

        // ── Administration surfaces ──────────────────────────────────────────
        'impersonation' => [
            'label'       => 'Impersonation',
            'description' => 'Allow Super Admin to sign in as another user. Enforced on POST /auth/impersonate. Sessions are unaffected; re-enabling restores the capability.',
            'category'    => 'admin',
            'default'     => true,
            // Deliberately NOT exempt: the flag would do nothing for its only
            // possible caller, and it cannot lock anyone out of the console
            // (this page and account recovery never depend on it).
            'superadmin_exempt' => false,
        ],
        'device_management' => [
            'label'       => 'Device Management',
            'description' => 'Allow admins to block or reset a user\' device. Enforced on POST /security/devices/{id}/block and POST /admin/users/{id}/devices/reset. No device rows or sessions are deleted, so re-enabling restores prior state.',
            'category'    => 'admin',
            'default'     => true,
            'superadmin_exempt' => true,
        ],
        'db_audit' => [
            'label'       => 'Database Audit',
            'description' => 'Allow running the low-level database audit. Enforced on POST /analytics/db-audit. Read-only diagnostics — no data is written, changed or removed.',
            'category'    => 'admin',
            'default'     => true,
            'superadmin_exempt' => true,
        ],
        'trash_cleanup' => [
            'label'       => 'Trash Cleanup',
            'description' => 'Allow permanently purging expired trash. Enforced on POST /admin/trash-cleanup. This is the ONLY irreversibly destructive admin operation, so it has its own kill switch; restore and inspection keep working when it is off.',
            'category'    => 'admin',
            'default'     => true,
            'superadmin_exempt' => true,
        ],
        'violation_management' => [
            'label'       => 'Violation Management',
            'description' => 'Allow resetting a user\'s content-protection violation count. Enforced on POST /rpc/admin-reset-violations. Recording violations is never blocked — only the clearing of strikes is gated.',
            'category'    => 'admin',
            'default'     => true,
            'superadmin_exempt' => true,
        ],
        'video_monitoring' => [
            'label'       => 'Video Health Scans',
            'description' => 'Allow running video health scans. Enforced on POST /video/health-scan. Refusal-only: playback, uploads and stored scan history are untouched.',
            'category'    => 'video',
            'default'     => true,
            'superadmin_exempt' => true,
        ],
    ];

    /** Per-process cache of the resolved state (shared by all instances). */
    private static ?array $cache = null;
    private static int $cacheAt = 0;

    /**
     * Resolve one flag. Unknown keys (a code path referencing a key that is not
     * in the registry) FAIL OPEN — an unrecognised key must never silently
     * disable a capability.
     */
    public function isEnabled(string $key): bool
    {
        $meta = self::REGISTRY[$key] ?? null;
        if ($meta === null) {
            return true;
        }
        $state = $this->state();
        return $state[$key] ?? (bool) $meta['default'];
    }

    /**
     * Enforcement entry point for protected endpoints.
     *
     * @throws FeatureDisabledException 403 feature_disabled (unless the caller
     *         is a Super Admin and the flag is superadmin_exempt).
     */
    public function assertEnabled(string $key, Request $request): void
    {
        $meta = self::REGISTRY[$key] ?? null;
        if ($meta === null) {
            return; // unknown key → fail open (see isEnabled)
        }
        if (!empty($meta['superadmin_exempt']) && $this->isSuperAdmin($request)) {
            return;
        }
        if ($this->isEnabled($key)) {
            return;
        }
        throw new FeatureDisabledException(
            $key,
            (string) ($meta['label'] ?? $key) . ' is temporarily unavailable.'
        );
    }

    /**
     * Admin view: registry metadata + live state. Rows are created on demand so
     * a fresh deployment shows the real flag list instead of an empty screen.
     */
    public function snapshot(): array
    {
        $state = $this->state();
        $counts = self::overrideCounts();
        $out = [];
        foreach (self::REGISTRY as $key => $meta) {
            $out[] = [
                'key'         => $key,
                'label'       => $meta['label'],
                'description' => $meta['description'],
                'category'    => $meta['category'],
                'enabled'     => $state[$key] ?? (bool) $meta['default'],
                'is_default'  => (bool) $meta['default'],
                'overrides'   => $counts[$key] ?? 0,
            ];
        }
        return $out;
    }

    /**
     * Super-Admin write. The key MUST be in the registry; the row is upserted,
     * the change is audited and the cache is flushed so the new state applies
     * to the very next request (no redeploy, no restart).
     */
    public function setEnabled(string $key, bool $enabled, ?string $actorId): array
    {
        if (!isset(self::REGISTRY[$key])) {
            throw new \MedAcademy\Http\ApiException(
                422,
                "Unknown feature flag '{$key}'",
                'unknown_feature_flag'
            );
        }

        $old = $this->isEnabled($key);

        $db = Database::instance();
        $db->query(
            'INSERT INTO `feature_flags` (`id`, `key`, `label`, `description`, `enabled`, `updated_by`, `updated_at`)
             VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))
             ON DUPLICATE KEY UPDATE
               `enabled`    = VALUES(`enabled`),
               `label`      = VALUES(`label`),
               `description` = VALUES(`description`),
               `updated_by` = VALUES(`updated_by`),
               `updated_at` = UTC_TIMESTAMP(6)',
            [
                \MedAcademy\Utils\Uuid::v4(),
                $key,
                (string) self::REGISTRY[$key]['label'],
                (string) self::REGISTRY[$key]['description'],
                $enabled ? 1 : 0,
                $actorId,
            ]
        );

        self::flushCache();

        AuditService::write($actorId, 'platform_settings_changed', [
            'setting'     => 'feature_flag',
            'key'         => $key,
            'enabled'     => $enabled,
            'old_enabled' => $old,
        ]);

        return [
            'key'         => $key,
            'label'       => self::REGISTRY[$key]['label'],
            'description' => self::REGISTRY[$key]['description'],
            'category'    => self::REGISTRY[$key]['category'],
            'enabled'     => $enabled,
            'is_default'  => (bool) self::REGISTRY[$key]['default'],
        ];
    }

    /** Drop the process cache (called after every write). */
    public static function flushCache(): void
    {
        self::$cache = null;
        self::$cacheAt = 0;
    }

    /**
     * Resolved state for every registry key.
     *
     * NEVER throws: any failure (missing table, DB error) resolves to the
     * registry defaults. Missing rows are inserted so the admin screen and the
     * enforcement path agree on the same values.
     */
    private function state(): array
    {
        $now = time();
        if (self::$cache !== null && ($now - self::$cacheAt) < self::CACHE_TTL) {
            return self::$cache;
        }

        $defaults = [];
        foreach (self::REGISTRY as $key => $meta) {
            $defaults[$key] = (bool) $meta['default'];
        }

        try {
            $rows = Database::instance()->select('SELECT `key`, `enabled` FROM `feature_flags`');
            $stored = [];
            foreach ($rows as $row) {
                $key = (string) ($row['key'] ?? '');
                if ($key === '' || !isset(self::REGISTRY[$key])) {
                    continue; // registry is the key space — unknown rows are ignored
                }
                $stored[$key] = self::coerceBool($row['enabled'] ?? null, $defaults[$key]);
            }

            $missing = array_diff(array_keys(self::REGISTRY), array_keys($stored));
            if ($missing !== []) {
                $this->ensureDefaults($missing);
                // The rows were just written with the registry defaults, so the
                // in-memory merge below is already the authoritative answer.
            }

            $state = array_merge($defaults, $stored);
        } catch (\Throwable) {
            // FAIL OPEN — availability must not depend on a config read.
            $state = $defaults;
        }

        self::$cache = $state;
        self::$cacheAt = $now;
        return $state;
    }

    /**
     * Create any registry rows that do not exist yet, with their defaults.
     * INSERT IGNORE keeps this safe against concurrent workers.
     *
     * @param array<int, string> $keys
     */
    private function ensureDefaults(array $keys): void
    {
        $db = Database::instance();
        foreach ($keys as $key) {
            $meta = self::REGISTRY[$key] ?? null;
            if ($meta === null) {
                continue;
            }
            $db->query(
                'INSERT IGNORE INTO `feature_flags`
                   (`id`, `key`, `label`, `description`, `enabled`, `updated_at`)
                 VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
                [
                    \MedAcademy\Utils\Uuid::v4(),
                    $key,
                    (string) $meta['label'],
                    (string) $meta['description'],
                    !empty($meta['default']) ? 1 : 0,
                ]
            );
        }
    }

    /** Strict, total boolean coercion — a malformed value falls back to $fallback. */
    private static function coerceBool(mixed $value, bool $fallback): bool
    {
        if (is_bool($value)) {
            return $value;
        }
        if (is_int($value)) {
            return $value !== 0;
        }
        if (is_string($value)) {
            $v = strtolower(trim($value));
            if ($v === '1' || $v === 'true') {
                return true;
            }
            if ($v === '0' || $v === 'false') {
                return false;
            }
        }
        if (is_float($value)) {
            return $value !== 0.0;
        }
        return $fallback;
    }

    /** Role comes from the AUTHENTICATED identity — never a client header. */
    private function isSuperAdmin(Request $request): bool
    {
        return ($request->user['role'] ?? '') === 'super_admin';
    }

    // ── Per-user overrides (three states, same model as video providers) ─────
    // feature_flag_overrides (user_id, flag_key, is_enabled) — an explicit row
    // is ENABLED/DISABLED for that user; the ABSENCE of a row is INHERIT (the
    // global default decides). Used for controlled rollout of a capability to
    // specific accounts (e.g. a new course builder pilot). Never a lockout
    // risk: superadmin_exempt flags bypass overrides for Super Admin too, and
    // any read failure fails open to the global state.

    /**
     * Effective state for ONE user: explicit override → global state.
     * Unknown keys fail open (true), read failures fail open (global).
     */
    public function isEnabledForUser(string $key, string $userId): bool
    {
        $meta = self::REGISTRY[$key] ?? null;
        if ($meta === null) {
            return true;
        }
        $global = $this->isEnabled($key);
        if ($userId === '') {
            return $global;
        }
        try {
            $row = Database::instance()->value(
                'SELECT is_enabled FROM `feature_flag_overrides` WHERE `user_id` = ? AND `flag_key` = ? LIMIT 1',
                [$userId, $key],
                null
            );
            return $row === null ? $global : (int) $row === 1;
        } catch (\Throwable) {
            return $global; // table missing / transient error → global state
        }
    }

    /**
     * Enforcement with per-user resolution. Same structured refusal contract
     * as assertEnabled(); the Super Admin exemption wins over any override.
     */
    public function assertEnabledFor(string $key, Request $request): void
    {
        $meta = self::REGISTRY[$key] ?? null;
        if ($meta === null) {
            return;
        }
        if (!empty($meta['superadmin_exempt']) && $this->isSuperAdmin($request)) {
            return;
        }
        if ($this->isEnabledForUser($key, (string) ($request->user['id'] ?? ''))) {
            return;
        }
        throw new FeatureDisabledException(
            $key,
            (string) ($meta['label'] ?? $key) . ' is temporarily unavailable.'
        );
    }

    /**
     * Effective rows for the Super Admin console: registry metadata + global
     * state + per-user override map for one target user.
     *
     * @return array<int, array{key:string,label:string,description:string,
     *   category:string,enabled:bool,is_default:bool,
     *   override:'inherit'|'enabled'|'disabled',user_effective:bool}>
     */
    public function snapshotForUser(string $userId): array
    {
        $state = $this->state();
        $overrides = [];
        if ($userId !== '') {
            try {
                foreach (
                    Database::instance()->select(
                        'SELECT flag_key, is_enabled FROM `feature_flag_overrides` WHERE `user_id` = ?',
                        [$userId]
                    ) ?? [] as $row
                ) {
                    $overrides[(string) $row['flag_key']] = (int) $row['is_enabled'] === 1;
                }
            } catch (\Throwable) {
                $overrides = []; // fail open — console shows pure global state
            }
        }

        $out = [];
        foreach (self::REGISTRY as $key => $meta) {
            $global = $state[$key] ?? (bool) $meta['default'];
            if (array_key_exists($key, $overrides)) {
                $override = $overrides[$key] ? 'enabled' : 'disabled';
                $effective = $overrides[$key];
            } else {
                $override = 'inherit';
                $effective = $global;
            }
            $out[] = [
                'key'         => $key,
                'label'       => $meta['label'],
                'description' => $meta['description'],
                'category'    => $meta['category'],
                'enabled'     => $global,
                'is_default'  => (bool) $meta['default'],
                'override'    => $override,
                'user_effective' => $effective,
            ];
        }
        return $out;
    }

    /**
     * Write one per-user override. mode: 'inherit' deletes the row; otherwise
     * upserts. Registry-validated; audited by the controller caller.
     */
    public function setOverride(string $key, string $userId, string $mode): void
    {
        if (!isset(self::REGISTRY[$key])) {
            throw new \MedAcademy\Http\ApiException(422, "Unknown feature flag '{$key}'", 'unknown_feature_flag');
        }
        if (!in_array($mode, ['inherit', 'enabled', 'disabled'], true)) {
            throw new \MedAcademy\Http\ApiException(422, 'mode must be inherit, enabled or disabled');
        }
        $db = Database::instance();
        if ($mode === 'inherit') {
            $db->query(
                'DELETE FROM `feature_flag_overrides` WHERE `flag_key` = ? AND `user_id` = ?',
                [$key, $userId]
            );
            return;
        }
        $db->query(
            'INSERT INTO `feature_flag_overrides` (`id`, `flag_key`, `user_id`, `is_enabled`, `created_at`, `updated_at`)
             VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
             ON DUPLICATE KEY UPDATE `is_enabled` = VALUES(`is_enabled`), `updated_at` = UTC_TIMESTAMP(6)',
            [\MedAcademy\Utils\Uuid::v4(), $key, $userId, $mode === 'enabled' ? 1 : 0]
        );
    }

    /** Number of explicit per-user overrides per flag (console detail line). */
    public static function overrideCounts(): array
    {
        try {
            $rows = Database::instance()->select(
                'SELECT flag_key, COUNT(*) AS n FROM `feature_flag_overrides` GROUP BY flag_key'
            ) ?? [];
            $out = [];
            foreach ($rows as $row) {
                $out[(string) $row['flag_key']] = (int) $row['n'];
            }
            return $out;
        } catch (\Throwable) {
            return [];
        }
    }
}
