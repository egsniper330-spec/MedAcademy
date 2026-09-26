<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;

/**
 * AppReleaseService — Super Admin production version management.
 *
 * TWO CONCEPTS, NEVER CONFLATED:
 *   1. CURRENT PRODUCTION — the release currently deployed for a platform
 *      (app_releases.status = 'published', at most ONE per platform).
 *   2. PENDING RELEASE — a draft/ready release being prepared. Editing it
 *      NEVER changes production; only publish() does.
 *
 * Auto-increment is a bug class this service makes impossible: versions move
 * ONLY through explicit create/edit/publish calls — nothing else writes here.
 *
 * Semantic versions are COMPARED NUMERICALLY (see compareVersions) — the
 * centralized rule shared with the client helper src/lib/semver.ts.
 *
 * Enforcement layer: ForceUpdate/AppUpdateService keeps versionCode as the
 * authoritative gate input; the published release record is the SOURCE of
 * that gate configuration once releases are used (UpdateConfigController
 * exposes publishedPromotion()).
 */
final class AppReleaseService
{
    public const PLATFORMS = ['android', 'ios'];
    public const STATUSES = ['draft', 'ready', 'published', 'archived'];

    /**
     * Numeric per-part semver comparison (never string comparison —
     * "1.10.0" must be GREATER than "1.9.0").
     */
    public static function compareVersions(string $a, string $b): int
    {
        $pa = explode('.', ltrim($a, 'vV'));
        $pb = explode('.', ltrim($b, 'vV'));
        $len = max(count($pa), count($pb));
        for ($i = 0; $i < $len; $i++) {
            $x = isset($pa[$i]) && $pa[$i] !== '' ? (int) $pa[$i] : 0;
            $y = isset($pb[$i]) && $pb[$i] !== '' ? (int) $pb[$i] : 0;
            if ($x !== $y) {
                return $x <=> $y;
            }
        }
        return 0;
    }

    /** Canonical storage form: trim + strip one leading v/V + validate. */
    public static function normalizeVersion(mixed $raw): ?string
    {
        if (!is_string($raw)) {
            return null;
        }
        $v = ltrim(trim($raw), 'vV');
        // 1–3 component groups, numeric, 1–3 digits each (X.Y.Z[.W]).
        if (!preg_match('/^\d{1,3}(\.\d{1,3}){2,3}$/', $v)) {
            return null;
        }
        $parts = explode('.', $v);
        foreach ($parts as $p) {
            if (strlen($p) > 1 && $p[0] === '0') {
                return null; // "01.2.3" style noise rejected
            }
        }
        return $v;
    }

    /** Full release row list (SA view). */
    public function listReleases(): array
    {
        return Database::instance()->select(
            'SELECT id, platform, version, android_version_code, ios_build_number,
                    download_url, release_notes, status, published_at, published_by,
                    created_by, created_at, updated_at
               FROM app_releases
           ORDER BY created_at DESC, id DESC'
        );
    }

    /** The current production release for a platform (or null). */
    public function currentFor(string $platform): ?array
    {
        return Database::instance()->row(
            "SELECT * FROM app_releases WHERE platform = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1",
            [$platform]
        );
    }

    /** Create a draft/ready release. NEVER touches the published record. */
    public function createRelease(array $input, string $actorId): array
    {
        $platform = strtolower(trim((string) ($input['platform'] ?? '')));
        if (!in_array($platform, self::PLATFORMS, true)) {
            throw new ApiException(422, 'platform must be android or ios');
        }
        $version = self::normalizeVersion($input['version'] ?? null);
        if ($version === null) {
            throw new ApiException(422, 'version must be semantic (e.g. 1.1.0) — invalid versions are rejected');
        }
        $status = strtolower(trim((string) ($input['status'] ?? 'draft')));
        if (!in_array($status, ['draft', 'ready'], true)) {
            throw new ApiException(422, 'A new release must start as draft or ready');
        }
        $downloadUrl = trim((string) ($input['download_url'] ?? ''));
        if ($downloadUrl !== '') {
            $this->assertHttpUrl($downloadUrl);
        }

        // Version uniqueness per platform across live (non-archived) releases.
        $dupe = Database::instance()->value(
            "SELECT COUNT(*) FROM app_releases WHERE platform = ? AND version = ? AND status <> 'archived'",
            [$platform, $version],
            0
        );
        if ((int) $dupe > 0) {
            throw new ApiException(422, "A {$platform} release for version {$version} already exists");
        }

        $id = \MedAcademy\Utils\Uuid::v4();
        Database::instance()->query(
            'INSERT INTO app_releases
                (id, platform, version, android_version_code, ios_build_number,
                 download_url, release_notes, status, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                $id,
                $platform,
                $version,
                $this->positiveIntOrNull($input['android_version_code'] ?? null),
                $this->positiveIntOrNull($input['ios_build_number'] ?? null),
                $downloadUrl !== '' ? $downloadUrl : null,
                array_key_exists('release_notes', $input) && (string) ($input['release_notes'] ?? '') !== ''
                    ? (string) $input['release_notes']
                    : null,
                $status,
                $actorId,
            ]
        );

        AuditService::write($actorId, 'release_created', [
            'release_id' => $id, 'platform' => $platform, 'version' => $version, 'status' => $status,
        ]);
        return $this->getRelease($id);
    }

    /** Edit a draft/ready release. NEVER touches the published record. */
    public function updateRelease(string $releaseId, array $input, string $actorId): array
    {
        $release = $this->getRelease($releaseId);
        if ($release['status'] === 'published') {
            throw new ApiException(409, 'Published releases are immutable — create a new version or roll back instead');
        }
        if ($release['status'] === 'archived') {
            throw new ApiException(409, 'Archived releases cannot be edited');
        }

        $version = array_key_exists('version', $input)
            ? self::normalizeVersion($input['version'])
            : (string) $release['version'];
        if ($version === null) {
            throw new ApiException(422, 'version must be semantic (e.g. 1.1.0) — invalid versions are rejected');
        }

        $dupe = Database::instance()->value(
            "SELECT COUNT(*) FROM app_releases WHERE platform = ? AND version = ? AND status <> 'archived' AND id <> ?",
            [$release['platform'], $version, $releaseId],
            0
        );
        if ((int) $dupe > 0) {
            throw new ApiException(422, "A {$release['platform']} release for version {$version} already exists");
        }

        $url = array_key_exists('download_url', $input)
            ? trim((string) ($input['download_url'] ?? ''))
            : (string) ($release['download_url'] ?? '');
        if ($url !== '') {
            $this->assertHttpUrl($url);
        }

        Database::instance()->query(
            'UPDATE app_releases SET
                version = ?, android_version_code = ?, ios_build_number = ?,
                download_url = ?, release_notes = ?, status = ?, updated_at = UTC_TIMESTAMP(6)
              WHERE id = ?',
            [
                $version,
                array_key_exists('android_version_code', $input)
                    ? $this->positiveIntOrNull($input['android_version_code'])
                    : ($release['android_version_code'] !== null ? (int) $release['android_version_code'] : null),
                array_key_exists('ios_build_number', $input)
                    ? $this->positiveIntOrNull($input['ios_build_number'])
                    : ($release['ios_build_number'] !== null ? (int) $release['ios_build_number'] : null),
                $url !== '' ? $url : null,
                array_key_exists('release_notes', $input)
                    ? (string) ($input['release_notes'] !== '' ? $input['release_notes'] : $release['release_notes'] ?? '')
                    : (string) ($release['release_notes'] ?? ''),
                in_array(strtolower(trim((string) ($input['status'] ?? $release['status']))), ['draft', 'ready'], true)
                    ? strtolower(trim((string) $input['status']))
                    : $release['status'],
                $releaseId,
            ]
        );

        AuditService::write($actorId, 'release_updated', [
            'release_id' => $releaseId, 'platform' => $release['platform'], 'version' => $version,
        ]);
        return $this->getRelease($releaseId);
    }

    /**
     * THE ONLY OPERATION that changes Current Production.
     * Publish = archive any existing published row + publish this one, in ONE
     * transaction (the one-active-per-platform invariant is enforced here AND
     * by the partial unique index idx_app_releases_one_active). Rollback is
     * publish() over a previously published release — history is preserved.
     */
    public function publish(string $releaseId, string $actorId): array
    {
        $release = $this->getRelease($releaseId);
        if ($release['status'] === 'published') {
            throw new ApiException(409, 'Release is already the current production version');
        }
        if ($release['status'] === 'archived') {
            throw new ApiException(409, 'Archived releases cannot be re-published directly');
        }
        if (trim((string) ($release['download_url'] ?? '')) === '') {
            throw new ApiException(422, 'A download URL is required before this release can be published');
        }

        $db = Database::instance();
        $db->begin();
        try {
            $previous = $db->row(
                "SELECT id, version, published_at FROM app_releases
                  WHERE platform = ? AND status = 'published'
                  FOR UPDATE",
                [$release['platform']]
            );
            if ($previous !== null) {
                $cmp = self::compareVersions((string) $release['version'], (string) $previous['version']);
                if ($cmp < 0) {
                    throw new ApiException(409, "Cannot publish {$release['version']} — it is older than the current production {$previous['version']}. Use rollback to re-activate a previous release.");
                }
                $db->query(
                    "UPDATE app_releases SET status = 'archived', updated_at = UTC_TIMESTAMP(6) WHERE id = ?",
                    [$previous['id']]
                );
            }
            $db->query(
                "UPDATE app_releases SET status = 'published', published_at = UTC_TIMESTAMP(6),
                        published_by = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?",
                [$actorId, $releaseId]
            );
            $db->commit();
        } catch (\Throwable $e) {
            $db->rollback();
            if ($e instanceof ApiException) {
                throw $e;
            }
            throw new ApiException(500, 'Publish failed: ' . $e->getMessage());
        }

        AuditService::write($actorId, 'release_published', [
            'release_id' => $releaseId,
            'platform' => $release['platform'],
            'version' => $release['version'],
            'previous_version' => $previous['version'] ?? null,
        ]);

        // Promotion: the published release FEEDS the existing update gate so
        // ForceUpdateGate sees exactly what production runs.
        $this->promoteToUpdateConfig($release['platform'], $this->getRelease($releaseId), $actorId);

        return $this->getRelease($releaseId);
    }

    /**
     * Rollback: re-activate a previously published release as current
     * production. Represented as a NEW activation event — history is never
     * destroyed (rows are archived, never deleted).
     */
    public function rollback(string $releaseId, string $actorId): array
    {
        $release = $this->getRelease($releaseId);
        if ($release['status'] !== 'published' && $release['status'] !== 'archived') {
            throw new ApiException(409, 'Only previously published releases can be restored');
        }
        if (trim((string) ($release['download_url'] ?? '')) === '') {
            throw new ApiException(422, 'A download URL is required to re-activate this release');
        }

        $db = Database::instance();
        $db->begin();
        try {
            $current = $db->row(
                "SELECT id, version FROM app_releases WHERE platform = ? AND status = 'published' FOR UPDATE",
                [$release['platform']]
            );
            if ($current !== null && (string) $current['id'] !== (string) $releaseId) {
                $db->query(
                    "UPDATE app_releases SET status = 'archived', updated_at = UTC_TIMESTAMP(6) WHERE id = ?",
                    [$current['id']]
                );
            }
            $db->query(
                "UPDATE app_releases SET status = 'published', published_at = UTC_TIMESTAMP(6),
                        published_by = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?",
                [$actorId, $releaseId]
            );
            $db->commit();
        } catch (\Throwable $e) {
            $db->rollback();
            throw new ApiException(500, 'Rollback failed: ' . $e->getMessage());
        }

        AuditService::write($actorId, 'release_rollback', [
            'release_id' => $releaseId,
            'platform' => $release['platform'],
            'version' => $release['version'],
            'superseded_version' => $current['version'] ?? null,
        ]);
        $this->promoteToUpdateConfig($release['platform'], $this->getRelease($releaseId), $actorId);
        return $this->getRelease($releaseId);
    }

    /** Archive a non-published release (housekeeping). */
    public function archive(string $releaseId, string $actorId): array
    {
        $release = $this->getRelease($releaseId);
        if ($release['status'] === 'published') {
            throw new ApiException(409, 'The current production release cannot be archived — publish or roll back to another version first');
        }
        Database::instance()->query(
            "UPDATE app_releases SET status = 'archived', updated_at = UTC_TIMESTAMP(6) WHERE id = ?",
            [$releaseId]
        );
        AuditService::write($actorId, 'release_archived', [
            'release_id' => $releaseId, 'platform' => $release['platform'], 'version' => $release['version'],
        ]);
        return $this->getRelease($releaseId);
    }

    /** Admin overview: production + history for both platforms. */
    public function overview(): array
    {
        $out = [];
        foreach (self::PLATFORMS as $p) {
            $current = $this->currentFor($p);
            $history = Database::instance()->select(
                "SELECT id, platform, version, android_version_code, ios_build_number,
                        download_url, release_notes, status, published_at, published_by, created_at
                   FROM app_releases WHERE platform = ?
               ORDER BY published_at DESC, created_at DESC",
                [$p]
            );
            $out[$p] = [
                'current' => $current,
                'history' => $history,
            ];
        }
        return $out;
    }

    /**
     * Feed the published release into the EXISTING update-gate config so the
     * ForceUpdate system's authoritative record matches production. The
     * update mode is preserved from the previous config (policy is separate
     * from releases). Prerequisite: migration 021 applied.
     */
    private function promoteToUpdateConfig(string $platform, array $release, string $actorId): void
    {
        try {
            $row = Database::instance()->row(
                'SELECT update_mode, is_enabled FROM app_update_config WHERE platform = ?',
                [$platform]
            );
            $mode = $row !== null ? (string) $row['update_mode'] : 'FORCED';
            $enabled = $row !== null ? (int) $row['is_enabled'] : 1;
            $code = (int) ($platform === 'android'
                ? ($release['android_version_code'] ?? 0)
                : ($release['ios_build_number'] ?? 0));

            Database::instance()->query(
                'INSERT INTO app_update_config
                    (platform, latest_version_name, latest_version_code, minimum_version_code,
                     update_mode, update_url, release_notes, is_enabled, updated_by)
                 VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    latest_version_name  = VALUES(latest_version_name),
                    latest_version_code  = VALUES(latest_version_code),
                    update_url           = VALUES(update_url),
                    release_notes        = VALUES(release_notes),
                    updated_by           = VALUES(updated_by)',
                [
                    $platform,
                    (string) $release['version'],
                    $code > 0 ? $code : 0,
                    $mode,
                    (string) $release['download_url'],
                    (string) ($release['release_notes'] ?? ''),
                    $enabled ? 1 : 0,
                    $actorId,
                ]
            );
        } catch (\Throwable) {
            // Migration 021 not applied yet → gate config not present. The
            // release record remains authoritative for production state.
        }
    }

    private function assertHttpUrl(string $url): void
    {
        if (mb_strlen($url) > 2048) {
            throw new ApiException(422, 'download_url exceeds 2048 characters');
        }
        if (!preg_match('#^https?://#i', $url) || filter_var($url, FILTER_VALIDATE_URL) === false) {
            throw new ApiException(422, 'download_url must be an absolute http(s) URL');
        }
    }

    private function positiveIntOrNull(mixed $v): ?int
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

    private function getRelease(string $id): array
    {
        $row = Database::instance()->row('SELECT * FROM app_releases WHERE id = ?', [$id]);
        if ($row === null) {
            throw new ApiException(404, 'Release not found');
        }
        return $row;
    }
}
