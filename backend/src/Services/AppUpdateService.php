<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;

/**
 * App Update Enforcement — remote version-gate configuration and evaluation.
 *
 * Data model: app_update_config (one row per platform; see migration 021).
 *
 * Comparison contract:
 *   versionCode (integer) is the AUTHORITATIVE comparison value. Version
 *   names are informational only and are never compared.
 *
 * Enforcement contract (see AuthMiddleware):
 *   an authenticated request whose X-App-Platform/X-App-Version-Code identify
 *   an installed version BELOW minimum_version_code is rejected with
 *   HTTP 426 { error: { code: UPDATE_REQUIRED, ... } } — the client cannot
 *   bypass the forced-update screen by patching the UI, because every
 *   protected API route independently refuses service.
 */
final class AppUpdateService
{
    public const PLATFORMS = ['android', 'ios'];
    public const MODES = ['FORCED', 'OPTIONAL'];

    /** Runtime cache (per-request process) of the platform → row map. */
    private ?array $cache = null;

    /**
     * All rows keyed by platform. Null when the table does not exist yet
     * (migration 021 not applied) — callers treat that as "enforcement
     * unavailable", never as a block, so deploying the code before running
     * the migration cannot lock anyone out.
     */
    public function allConfigs(): ?array
    {
        if ($this->cache !== null) {
            return $this->cache;
        }
        try {
            $rows = Database::instance()->select(
                'SELECT platform, latest_version_name, latest_version_code, minimum_version_code,
                        update_mode, update_url, release_notes, is_enabled
                   FROM app_update_config'
            );
        } catch (\Throwable) {
            $this->cache = null;
            return null;
        }
        $map = [];
        foreach ($rows ?? [] as $r) {
            $map[(string) $r['platform']] = $r;
        }
        $this->cache = $map;
        return $this->cache;
    }

    /** Active config for one platform, or null when absent/disabled/table missing. */
    public function activeFor(string $platform): ?array
    {
        $all = $this->allConfigs();
        if ($all === null) {
            return null;
        }
        $row = $all[$platform] ?? null;
        if ($row === null || !(int) $row['is_enabled']) {
            return null;
        }
        return $row;
    }

    /**
     * Public payload for GET /app/version. Shaped exactly as the mobile client
     * contract (platform-specific; enabled:false when the feature is off or
     * the platform row is missing).
     */
    public function publicPayload(string $platform): array
    {
        $row = $this->activeFor($platform);
        if ($row === null) {
            return [
                'platform'            => $platform,
                'enabled'             => false,
            ];
        }
        return [
            'platform'            => $platform,
            'enabled'             => true,
            'latestVersion'       => (string) $row['latest_version_name'],
            'latestVersionCode'   => (int) $row['latest_version_code'],
            'minimumVersionCode'  => (int) $row['minimum_version_code'],
            'updateMode'          => (string) $row['update_mode'],
            'updateUrl'           => (string) $row['update_url'],
            'releaseNotes'        => $row['release_notes'] !== null ? (string) $row['release_notes'] : null,
        ];
    }

    /**
     * Validate + persist a Super Admin configuration change.
     * Throws ApiException(422) with a human-readable message on any invalid
     * input (minimum > latest, non-numeric codes, bad URL, bad enum values).
     */
    public function upsert(string $platform, array $input, string $actorId): array
    {
        $platform = strtolower(trim($platform));
        if (!in_array($platform, self::PLATFORMS, true)) {
            throw new ApiException(422, 'Unsupported platform (use android or ios)');
        }

        // ---- version codes: positive integers, text allowed then validated ----
        $latestCode = $this->codeOrNull($input['latestVersionCode'] ?? null, 'latestVersionCode');
        $minCode    = $this->codeOrNull($input['minimumVersionCode'] ?? null, 'minimumVersionCode');
        if ($latestCode === null || $minCode === null) {
            throw new ApiException(422, 'Version codes must be positive integers');
        }
        if ($minCode > $latestCode) {
            throw new ApiException(422, 'minimumVersionCode cannot be greater than latestVersionCode');
        }

        // ---- version name: required non-empty string, sanity-checked ----
        $name = trim((string) ($input['latestVersion'] ?? ''));
        if ($name === '' || mb_strlen($name) > 64) {
            throw new ApiException(422, 'latestVersion is required (max 64 chars)');
        }

        // ---- mode ----
        $mode = strtoupper(trim((string) ($input['updateMode'] ?? 'FORCED')));
        if ($mode === '') {
            $mode = 'FORCED'; // default policy
        }
        if (!in_array($mode, self::MODES, true)) {
            throw new ApiException(422, 'updateMode must be FORCED or OPTIONAL');
        }

        // ---- URL: required https:// or http:// (custom scheme-less URLs are rejected) ----
        $url = trim((string) ($input['updateUrl'] ?? ''));
        if ($url === '' || mb_strlen($url) > 2048) {
            throw new ApiException(422, 'updateUrl is required (max 2048 chars)');
        }
        if (!preg_match('#^https?://#i', $url)) {
            throw new ApiException(422, 'updateUrl must be an absolute http(s) URL');
        }
        if (filter_var($url, FILTER_VALIDATE_URL) === false) {
            throw new ApiException(422, 'updateUrl is not a valid URL');
        }

        // ---- release notes / enabled ----
        $notes = array_key_exists('releaseNotes', $input) ? (string) ($input['releaseNotes'] ?? '') : null;
        $enabled = array_key_exists('enabled', $input)
            ? (bool) $input['enabled']
            : false; // new rows start disabled; the SA explicitly enables

        Database::instance()->query(
            'INSERT INTO app_update_config
                (platform, latest_version_name, latest_version_code, minimum_version_code,
                 update_mode, update_url, release_notes, is_enabled, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                latest_version_name  = VALUES(latest_version_name),
                latest_version_code  = VALUES(latest_version_code),
                minimum_version_code = VALUES(minimum_version_code),
                update_mode          = VALUES(update_mode),
                update_url           = VALUES(update_url),
                release_notes        = VALUES(release_notes),
                is_enabled           = VALUES(is_enabled),
                updated_by           = VALUES(updated_by)',
            [
                $platform,
                $name,
                $latestCode,
                $minCode,
                $mode,
                $url,
                $notes,
                $enabled ? 1 : 0,
                $actorId,
            ]
        );

        // Audit trail (action added by migration 021).
        \MedAcademy\Services\AuditService::write($actorId, 'app_update_config_changed', [
            'platform'            => $platform,
            'latest_version'      => $name,
            'latest_version_code' => $latestCode,
            'minimum_version_code'=> $minCode,
            'update_mode'         => $mode,
            'enabled'             => $enabled,
        ]);

        $this->cache = null; // bust per-process cache
        return $this->publicPayload($platform);
    }

    /**
     * HTTP 426 payload pieces for the middleware, or null when this request
     * should pass (feature off, table missing, version supported, version
     * header absent → treated as unknown client, not blocked).
     */
    public function evaluate(?string $platform, ?int $versionCode): ?array
    {
        if ($platform === null || $versionCode === null) {
            return null;
        }
        $platform = strtolower(trim($platform));
        if (!in_array($platform, self::PLATFORMS, true)) {
            return null;
        }
        $row = $this->activeFor($platform);
        if ($row === null) {
            return null; // feature disabled or table missing → do not block
        }
        $min = (int) $row['minimum_version_code'];
        if ($min <= 0 || $versionCode >= $min) {
            return null; // supported (or floor not configured yet)
        }
        return [
            'code'              => 'UPDATE_REQUIRED',
            'message'           => 'This app version is no longer supported. Please update to continue.',
            'latestVersion'     => (string) $row['latest_version_name'],
            'latestVersionCode' => (int) $row['latest_version_code'],
            'minimumVersionCode'=> $min,
            'updateUrl'         => (string) $row['update_url'],
            'updateMode'        => (string) $row['update_mode'],
        ];
    }

    /** Positive-int parse or null. Accepts numeric strings from JSON. */
    private function codeOrNull(mixed $v, string $field): ?int
    {
        if (is_int($v)) {
            return $v > 0 ? $v : null;
        }
        if (is_string($v) && preg_match('/^\d{1,9}$/', trim($v))) {
            $n = (int) trim($v);
            return $n > 0 ? $n : null;
        }
        return null;
    }
}
