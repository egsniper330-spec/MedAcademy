<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Utils\Uuid;

/**
 * VIDEO PROVIDER POLICY — the authoritative availability decision for the
 * platform's two real video providers:
 *
 *   plyr       — YouTube/Plyr playback path (lessons.video_type = 'youtube')
 *   vdocipher  — secure VdoCipher DRM playback path (lessons.video_type = 'vdocipher')
 *
 * ─── Model ───────────────────────────────────────────────────────────────────
 *   video_providers               — one row per provider, is_globally_enabled
 *   teacher_provider_permissions  — per-doctor override rows (is_enabled)
 *
 * ─── Three-state override semantics ─────────────────────────────────────────
 *   An override ROW for (doctor, provider) is an explicit decision:
 *       is_enabled = 1 → ENABLED  (allowed even when globally OFF)
 *       is_enabled = 0 → DISABLED (blocked even when globally ON)
 *   The ABSENCE of a row means INHERIT → the global setting decides.
 *
 * ─── Fail-open rule ──────────────────────────────────────────────────────────
 *   A MISSING global row (or a missing override row) can never disable a
 *   provider: unknown/misconfigured keys resolve to ENABLED, mirroring
 *   FeatureFlagService. A policy outage must not take video capability away
 *   from the whole platform; disabling is always an explicit admin decision.
 *
 * ─── Ordering contract ───────────────────────────────────────────────────────
 *   This is an AVAILABILITY layer only. It never replaces or reorders the
 *   authentication, account-state, maintenance, forced-update, integrity,
 *   device-evidence or client-risk gates; call sites must invoke it AFTER the
 *   existing security gates so security continues to win.
 */
final class VideoProviderPolicyService
{
    /** Stable machine keys — the only registry entries the client knows. */
    public const PROVIDERS = ['plyr', 'vdocipher'];

    /** Lesson-level video_type values that map to each provider. */
    public const VIDEO_TYPE_MAP = [
        'vdocipher' => 'vdocipher',
        'youtube'   => 'plyr',
    ];

    public static function isValidProvider(string $key): bool
    {
        return in_array($key, self::PROVIDERS, true);
    }

    /** Map a lessons.video_type value to its provider key (null = not video). */
    public static function providerForVideoType(?string $videoType): ?string
    {
        if ($videoType === null) {
            return null;
        }
        return self::VIDEO_TYPE_MAP[strtolower(trim($videoType))] ?? null;
    }

    /**
     * Effective availability for one (doctor, provider) pair:
     * explicit override → global default; missing data fails open.
     */
    public static function isEnabled(string $doctorId, string $providerKey): bool
    {
        $db = Database::instance();

        $override = $db->value(
            'SELECT is_enabled FROM `teacher_provider_permissions` WHERE `teacher_id` = ? AND `provider_key` = ? LIMIT 1',
            [$doctorId, $providerKey],
            null
        );
        if ($override !== null) {
            return (int) $override === 1;
        }

        $global = $db->value(
            'SELECT is_globally_enabled FROM `video_providers` WHERE `provider_key` = ? LIMIT 1',
            [$providerKey],
            null
        );
        // Fail open: no global row (or a NULL flag) means the provider stays
        // available — a missing configuration can never disable capability.
        return $global === null ? true : (int) $global === 1;
    }

    /**
     * Enforce availability for the CALLING user; throws a structured,
     * machine-readable refusal the client maps to a friendly message.
     *
     * @throws ApiException 403 code=video_provider_disabled (never leaks policy internals)
     */
    public static function assertProviderAllowed(?string $userId, string $providerKey): void
    {
        if (!self::isValidProvider($providerKey)) {
            return; // unknown keys are not this policy's business (fail open)
        }
        if ($userId === null || $userId === '') {
            return; // unauthenticated requests are handled by the auth layer
        }
        if (!self::isEnabled($userId, $providerKey)) {
            throw new ApiException(
                403,
                'This video player is currently unavailable. Please choose another available player.',
                'video_provider_disabled'
            );
        }
    }

    /**
     * Effective-state rows for one doctor (used by the SA console + the
     * doctor's own provider gating). Missing override rows are reported as
     * inherit:true so the UI can distinguish the three states exactly.
     *
     * @return array<int, array{provider_key:string, display_name:string,
     *   global_enabled:bool, override:'inherit'|'enabled'|'disabled',
     *   teacher_enabled:bool, effective:bool}>
     */
    public static function effectiveForTeacher(string $teacherId): array
    {
        $db = Database::instance();

        $globals = $db->select(
            'SELECT provider_key, display_name, is_globally_enabled FROM `video_providers` ORDER BY provider_key ASC'
        ) ?? [];
        if ($globals === []) {
            // Registry absent/empty → derive from the code-level registry so
            // the console and the doctor gate both render the two real
            // providers (fail open) instead of an empty screen.
            $globals = array_map(
                static fn(string $k): array => [
                    'provider_key'        => $k,
                    'display_name'        => $k === 'plyr' ? 'Plyr' : 'VdoCipher',
                    'is_globally_enabled' => 1,
                ],
                self::PROVIDERS
            );
        }

        $overrides = [];
        foreach (
            $db->select(
                'SELECT provider_key, is_enabled FROM `teacher_provider_permissions` WHERE `teacher_id` = ?',
                [$teacherId]
            ) ?? [] as $row
        ) {
            $overrides[(string) $row['provider_key']] = (int) $row['is_enabled'] === 1;
        }

        $out = [];
        foreach ($globals as $g) {
            $key = (string) $g['provider_key'];
            if (!self::isValidProvider($key)) {
                continue; // only the two real providers are controllable
            }
            $globalOn = (int) ($g['is_globally_enabled'] ?? 1) === 1;
            if (array_key_exists($key, $overrides)) {
                $override    = $overrides[$key] ? 'enabled' : 'disabled';
                $teacherOn   = $overrides[$key];
            } else {
                $override    = 'inherit';
                $teacherOn   = $globalOn;
            }
            $out[] = [
                'provider_key'   => $key,
                'display_name'   => (string) ($g['display_name'] ?? $key),
                'global_enabled' => $globalOn,
                'override'       => $override,
                'teacher_enabled' => $teacherOn,
                'effective'      => $teacherOn, // override decides; else global
            ];
        }
        return $out;
    }

    /**
     * Write ONE override row with three-state semantics. $mode:
     *   'inherit'  → delete the override row (global decides again)
     *   'enabled'  → upsert is_enabled = 1
     *   'disabled' → upsert is_enabled = 0
     */
    public static function setOverride(string $teacherId, string $providerKey, string $mode): void
    {
        if (!self::isValidProvider($providerKey)) {
            throw new ApiException(422, 'Unknown video provider', ['unknown_provider']);
        }
        if (!in_array($mode, ['inherit', 'enabled', 'disabled'], true)) {
            throw new ApiException(422, 'Override mode must be inherit, enabled or disabled');
        }
        if (!preg_match('/^[0-9a-fA-F-]{36}$/', $teacherId)) {
            throw new ApiException(422, 'teacher_id must be a UUID');
        }

        $db = Database::instance();
        if ($mode === 'inherit') {
            $db->query(
                'DELETE FROM `teacher_provider_permissions` WHERE `teacher_id` = ? AND `provider_key` = ?',
                [$teacherId, $providerKey]
            );
            return;
        }

        $db->query(
            'INSERT INTO `teacher_provider_permissions` (`id`, `teacher_id`, `provider_key`, `is_enabled`, `created_at`, `updated_at`)
             VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
             ON DUPLICATE KEY UPDATE `is_enabled` = VALUES(`is_enabled`), `updated_at` = UTC_TIMESTAMP(6)',
            [Uuid::v4(), $teacherId, $providerKey, $mode === 'enabled' ? 1 : 0]
        );
    }

    /**
     * Set the global availability flag; creates the registry row on first use
     * so the page self-initializes instead of operating on an empty table.
     */
    public static function setGlobal(string $providerKey, bool $enabled): void
    {
        if (!self::isValidProvider($providerKey)) {
            throw new ApiException(422, 'Unknown video provider', ['unknown_provider']);
        }
        $db = Database::instance();
        $display = $providerKey === 'plyr' ? 'Plyr' : 'VdoCipher';
        $db->query(
            'INSERT INTO `video_providers` (`id`, `provider_key`, `display_name`, `is_globally_enabled`, `created_at`, `updated_at`)
             VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
             ON DUPLICATE KEY UPDATE `is_globally_enabled` = VALUES(`is_globally_enabled`), `updated_at` = UTC_TIMESTAMP(6)',
            [Uuid::v4(), $providerKey, $display, $enabled ? 1 : 0]
        );
    }
}
