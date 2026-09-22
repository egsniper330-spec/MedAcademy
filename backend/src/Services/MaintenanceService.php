<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Database\Database;

/**
 * Server-authoritative Maintenance Mode.
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * Maintenance Mode previously existed ONLY as two rows in `system_config`
 * (maintenance_enabled / maintenance_message) that the Super Admin app wrote.
 * NOTHING on the server ever read them — toggling the switch changed a flag
 * in the database and nothing else. Normal users kept using the API normally.
 *
 * ─── Contract ────────────────────────────────────────────────────────────────
 * `enabled()` is the single source of truth, consulted by Middleware\Maintenance
 * on EVERY request (see index.php bootstrapping). When enabled, non-exempt
 * callers receive HTTP 503 with:
 *   { "error": { "message": ..., "code": "maintenance_mode",
 *                "maintenance": { "enabled": true, "message": ..., "retryAfter": 300 } } }
 *
 * Exempt (server-authorized, never client-declared):
 *   - Super Admin role (from the AUTHENTICATED profile — a client cannot
 *     grant itself this; unauthenticated requests are non-exempt)
 *   - rows in `maintenance_whitelist` (per-user bypass, SA-managed)
 *
 * The config is read from `system_config` with a short per-process cache so
 * enabling/disabling propagates to every worker within TTL seconds without
 * hammering the database on each request.
 */
final class MaintenanceService
{
    /** How long (seconds) a worker may serve a cached enabled/disabled verdict. */
    public const CACHE_TTL = 15;

    /** Default Retry-After advertised to clients when maintenance is active. */
    public const DEFAULT_RETRY_AFTER = 300;

    private ?array $cache = null;
    private int $cacheReadAt = 0;

    public function __construct(private readonly string $actorRole = '', private readonly string $actorId = '')
    {
    }

    /**
     * The two config keys this service owns in `system_config`.
     * (The Super Admin app writes them through its maintenance controller.)
     */
    public const KEY_ENABLED = 'maintenance_enabled';
    public const KEY_MESSAGE = 'maintenance_message';

    /**
     * Raw config: ['enabled' => bool, 'message' => string]. Never throws —
     * a missing table/config FAILS OPEN (maintenance off): availability of the
     * platform must not depend on a config-read failure.
     */
    public function config(): array
    {
        $now = time();
        if ($this->cache !== null && ($now - $this->cacheReadAt) < self::CACHE_TTL) {
            return $this->cache;
        }

        $enabled = false;
        $message = 'MedAcademy is temporarily unavailable while we perform maintenance.';

        try {
            $rows = Database::instance()->select(
                'SELECT `key`, `value` FROM `system_config` WHERE `key` IN (?, ?)',
                [self::KEY_ENABLED, self::KEY_MESSAGE]
            );
            foreach ($rows ?? [] as $row) {
                if (($row['key'] ?? '') === self::KEY_ENABLED) {
                    $raw = $row['value'] ?? null;
                    // system_config.value is JSON — decode scalars written by the app.
                    if (is_string($raw)) {
                        $decoded = json_decode($raw, true);
                        $raw = $decoded === null && $raw !== 'null' ? $raw : $decoded;
                    }
                    $enabled = $raw === true || $raw === 1 || $raw === 'true' || $raw === '1';
                } elseif (($row['key'] ?? '') === self::KEY_MESSAGE) {
                    $raw = $row['value'] ?? null;
                    if (is_string($raw)) {
                        $decoded = json_decode($raw, true);
                        if (is_string($decoded) && $decoded !== '') {
                            $message = $decoded;
                        } elseif ($raw !== '') {
                            $message = $raw;
                        }
                    }
                }
            }
        } catch (\Throwable) {
            // Fail OPEN: config read problems must never take the platform down.
            $enabled = false;
        }

        $this->cache = ['enabled' => $enabled, 'message' => $message];
        $this->cacheReadAt = $now;
        return $this->cache;
    }

    /**
     * True only when maintenance is enabled AND the caller is not exempt.
     * Exemption is computed from the authenticated profile (role) and the
     * maintenance_whitelist table — never from client-declared headers.
     */
    public function blocks(): bool
    {
        $cfg = $this->config();
        if (!$cfg['enabled']) {
            return false;
        }
        return !$this->isExempt();
    }

    /**
     * Super Admin (server-verified role) and explicitly whitelisted users may
     * pass. Unknown role / anonymous → never exempt.
     */
    public function isExempt(): bool
    {
        if ($this->actorRole === 'super_admin') {
            return true;
        }
        if ($this->actorId === '') {
            return false;
        }
        try {
            $row = Database::instance()->value(
                'SELECT COUNT(*) FROM `maintenance_whitelist` WHERE `user_id` = ?',
                [$this->actorId],
                0
            );
            return (int) $row > 0;
        } catch (\Throwable) {
            return false;
        }
    }

    /**
     * Called by the SA maintenance controller after a successful toggle so the
     * change is visible to this worker immediately (not after CACHE_TTL).
     */
    public static function flushCache(): void
    {
        // Instance caches are per-request; the static registry lets long-lived
        // workers (e.g. RoadRunner/Swoole style) clear all live instances.
        foreach (self::$liveInstances as $svc) {
            $svc->cache = null;
            $svc->cacheReadAt = 0;
        }
    }

    /** @var array<int, MaintenanceService> */
    private static array $liveInstances = [];

    public function __destruct()
    {
        // Keep the live-instance registry bounded (FPM: per-request lifecycle).
        if (($key = array_search($this, self::$liveInstances, true)) !== false) {
            unset(self::$liveInstances[$key]);
        }
    }

    /**
     * Construct a tracked instance (used by Middleware\Maintenance + the SA
     * controller) so flushCache() reaches every live copy.
     */
    public static function tracked(string $actorRole = '', string $actorId = ''): self
    {
        $svc = new self($actorRole, $actorId);
        self::$liveInstances[] = $svc;
        return $svc;
    }
}
