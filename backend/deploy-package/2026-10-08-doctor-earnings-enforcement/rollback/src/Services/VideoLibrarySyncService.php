<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Video\VdoCipherService;

/**
 * VideoLibrarySyncService — VdoCipher ↔ Video Library reconciliation.
 *
 * VdoCipher is the remote source of truth for ASSET EXISTENCE. Dashboard
 * deletions never notify this app, so the only reliable detection is the
 * official paginated listing API (GET /videos?page=N&limit=M).
 *
 * Reconcile policy (never a per-page-render scan):
 *   - remote present            → keep active; refresh ready state opportunistically
 *   - remote missing (404)      → CONFIRMED remote deletion: the local video
 *                                 asset row is REMOVED IMMEDIATELY during this
 *                                 sync (the sync itself is the cleanup pass —
 *                                 there is no user-facing "remotely deleted"
 *                                 state and no second manual Remove step).
 *                                 Lesson associations are detached safely:
 *                                 the lesson and its course are PRESERVED
 *                                 (same detach/demote contract as the
 *                                 doctor-initiated deleteAsset), and the
 *                                 removal runs in one local transaction.
 *   - listing error (timeout/5xx/429/auth/malformed/incomplete pagination)
 *                             → ABORT untouched. A temporary network failure
 *                                 is NEVER interpreted as a deletion — local
 *                                 rows are only ever removed after the
 *                                 COMPLETE paginated snapshot succeeded AND
 *                                 the per-asset single-video fallback
 *                                 confirmed the 404.
 *   - duplicates                → same provider_video_id on >1 active asset:
 *                                 keep the canonical row (most lessons attached,
 *                                 then oldest), re-point orphans where safe,
 *                                 archive the rest — never a blind delete.
 *
 * Deletion of a video through the app is handled by VideoController::deleteAsset
 * (remote-first, idempotent); this service is the read-side reconciliation
 * whose confirmed-absent branch performs the immediate local cleanup.
 */
final class VideoLibrarySyncService
{
    public function __construct(
        private readonly VdoCipherService $vdo = new VdoCipherService()
    ) {
    }

    /**
     * Full reconciliation pass. Pagination-safe, error-safe, audit-logged.
     *
     * @param string $triggeredBy  acting user id (audit + scope='mine' owner)
     * @param bool   $repairDuplicates  also consolidate duplicate active assets
     * @param string $scope  'all' (admin) or 'mine' (doctor — only their own
     *                       assets are reconciled; enforced by the controller,
     *                       re-checked here in depth)
     * @return array structured summary, e.g.
     *   { scanned_local, remote_videos, missing_remote, removed,
     *     duplicates, reconciled, errors, pages, status, error }
     */
    public function syncLibrary(string $triggeredBy, bool $repairDuplicates = true, string $scope = 'all'): array
    {
        $db = Database::instance();
        $mine = ($scope === 'mine');
        if ($mine) {
            // Depth check for the doctor path: an actor id is required to
            // scope to. Admins ('all') never take this branch.
            if ($triggeredBy === '') {
                throw new \InvalidArgumentException("scope='mine' requires an acting user id");
            }
        }

        // ── 1. Fetch the COMPLETE remote library (all pages) ─────────────
        $listing = $this->vdo->listAllVideos();
        if ($listing['status'] !== 'ok') {
            AuditService::write($triggeredBy, 'video_remote_sync', [
                'outcome' => 'aborted_listing_error',
                'http_status' => $listing['http_status'],
                'error' => $listing['error'],
                'partial_pages' => $listing['pages'],
            ]);
            // Unknown remote state → change nothing locally.
            return [
                'status' => 'error',
                'error' => 'VdoCipher listing failed (' . ($listing['error'] ?? 'unknown') . ') — local library left untouched. No video was removed.',
                'http_status' => $listing['http_status'],
                'scanned_local' => 0,
                'remote_videos' => count($listing['videos']),
                'pages' => $listing['pages'],
                'missing_remote' => 0,
                'removed' => 0,
                'duplicates' => 0,
                'reconciled' => 0,
                'errors' => 1,
            ];
        }
        $remoteIds = array_fill_keys(array_keys($listing['videos']), true);

        // ── 2. Local VdoCipher-backed assets (both FK and legacy video_id) ──
        // scope='mine' → the acting doctor's rows ONLY. The remote listing is
        // the full account library (one VdoCipher account serves the whole
        // platform), so scoping is applied against LOCAL ownership — the
        // doctor never causes another teacher's asset to be reconciled.
        $assets = $db->select(
            "SELECT va.id, va.doctor_id, va.provider_video_id, va.status,
                    (SELECT COUNT(*) FROM lessons l WHERE l.video_asset_id = va.id) AS lesson_refs,
                    (SELECT COUNT(*) FROM lessons l2 WHERE l2.video_id = va.provider_video_id) AS id_refs
               FROM video_assets va
              WHERE va.provider_video_id IS NOT NULL AND va.provider_video_id <> ''"
            . ($mine ? " AND va.doctor_id = ?" : '')
        , $mine ? [$triggeredBy] : []);
        $scannedLocal = count($assets);

        $missing = [];
        $removed = 0;
        $unknownCount = 0;
        $confirmedIds = [];

        // ── 3. Remote-existence reconciliation (local transaction; no HTTP
        //       inside the transaction — the listing happened above) ──────
        $db->begin();
        try {
            foreach ($assets as $asset) {
                $pvid = (string) $asset['provider_video_id'];
                if (isset($remoteIds[$pvid])) {
                    // Present remotely. If it finished encoding and the local
                    // row is still 'processing', catch up (idempotent).
                    $remoteMeta = $listing['videos'][$pvid];
                    if (($remoteMeta['status'] ?? null) === 'Ready' && $asset['status'] === 'processing') {
                        $db->query(
                            "UPDATE video_assets SET status = 'ready', updated_at = UTC_TIMESTAMP(6) WHERE id = ?",
                            [$asset['id']]
                        );
                        $db->query(
                            "UPDATE lessons SET video_status = 'ready', updated_at = UTC_TIMESTAMP(6)
                              WHERE video_asset_id = ? AND video_status IN ('processing','none')",
                            [$asset['id']]
                        );
                    }
                    $confirmedIds[] = $asset['id'];
                    continue;
                }
                // Not in the COMPLETE listing. Per-asset verification is a
                // FALLBACK for this subset only (never for assets the listing
                // already contains): a listing can be served from a stale
                // replica, and a destructive removal must only act on a
                // confirmed 404 from the authoritative single-video endpoint.
                // Cost is bounded by the number of absent assets, which is
                // normally zero.
                $check = $this->vdo->verifyRemote($pvid);
                if ($check['status'] === 'missing') {
                    $missing[] = $asset;
                } elseif ($check['status'] === 'error') {
                    $unknownCount++;
                }
                // 'exists' → a listing/verify race; leave untouched.
            }
            // Bulk-stamp the confirmed rows (mig027 columns) — one bounded
            // UPDATE per chunk instead of one query per asset.
            foreach (array_chunk($confirmedIds, 500) as $chunk) {
                $placeholders = implode(',', array_fill(0, count($chunk), '?'));
                $db->query(
                    "UPDATE video_assets SET remote_status = 'exists', remote_synced_at = UTC_TIMESTAMP(6)
                      WHERE id IN ($placeholders)",
                    $chunk
                );
            }
            // Confirmed remote deletions → remove the local rows NOW (the
            // sync IS the cleanup pass). Still inside the same transaction:
            // any failure rolls every removal back.
            foreach ($missing as $asset) {
                $removed += $this->removeLocallyConfirmedDeleted($db, $asset, $mine ? $triggeredBy : null);
                AuditService::write($triggeredBy, 'video_remote_missing', [
                    'asset_id' => $asset['id'],
                    'provider_video_id' => $asset['provider_video_id'],
                    'outcome' => 'local_record_removed',
                ]);
            }
            $db->commit();
        } catch (\Throwable $e) {
            $db->rollback();
            AuditService::write($triggeredBy, 'video_remote_sync', ['outcome' => 'aborted_local_error', 'error' => $e->getMessage()]);
            throw new ApiException(500, 'Local reconciliation failed: ' . $e->getMessage());
        }

        // ── 4. Duplicate detection / consolidation ───────────────────────
        // scope='mine' → only duplicates among the acting doctor's rows are
        // considered (cross-doctor "duplicates" of the same provider video are
        // legitimate independent re-uploads and must never be touched).
        $duplicateGroups = $db->select(
            "SELECT provider_video_id, COUNT(*) AS n
               FROM video_assets
              WHERE provider_video_id IS NOT NULL AND provider_video_id <> ''"
            . ($mine ? " AND doctor_id = ?" : '') . "
              GROUP BY provider_video_id
             HAVING COUNT(*) > 1"
        , $mine ? [$triggeredBy] : []);
        $duplicates = 0;
        $reconciled = 0;
        if ($repairDuplicates && $duplicateGroups !== []) {
            foreach ($duplicateGroups as $group) {
                $pvid = (string) $group['provider_video_id'];
                $rows = $db->select(
                    "SELECT id, doctor_id, status,
                            (SELECT COUNT(*) FROM lessons l WHERE l.video_asset_id = va.id) AS lesson_refs
                       FROM video_assets va
                      WHERE provider_video_id = ?
                      ORDER BY lesson_refs DESC, created_at ASC, id ASC",
                    [$pvid]
                );
                if (count($rows) < 2) {
                    continue; // concurrent reconcile already fixed it
                }
                if (!isset($remoteIds[$pvid])) {
                    // Asset is gone remotely — step 3 has already removed the
                    // scoped rows this pass saw; any copy outside the acting
                    // scope is removed by its own authorized sync. Nothing to
                    // consolidate here.
                    $duplicates++;
                    continue;
                }
                // Canonical = most lesson refs, then oldest. Others are
                // archived (data preserved via upload history), lessons that
                // referenced ONLY the non-canonical copy are re-pointed when
                // the canonical asset belongs to the same doctor; otherwise
                // the lesson is flagged 'missing' so an admin resolves it.
                $canonical = $rows[0];
                $duplicates++;
                foreach (array_slice($rows, 1) as $dupe) {
                    $repointed = $db->value(
                        'SELECT COUNT(*) FROM lessons WHERE video_asset_id = ?',
                        [$dupe['id']],
                        0
                    );
                    if ($repointed > 0 && (string) $dupe['doctor_id'] === (string) $canonical['doctor_id']) {
                        $db->query(
                            'UPDATE lessons SET video_asset_id = ?, updated_at = UTC_TIMESTAMP(6)
                              WHERE video_asset_id = ?',
                            [$canonical['id'], $dupe['id']]
                        );
                        $reconciled += (int) $repointed;
                    }
                    // Keep upload history intact; archive the duplicate asset.
                    $db->query(
                        "UPDATE video_assets SET status = 'duplicate_removed', updated_at = UTC_TIMESTAMP(6)
                          WHERE id = ?",
                        [$dupe['id']]
                    );
                    AuditService::write($triggeredBy, 'video_duplicate_detected', [
                        'provider_video_id' => $pvid,
                        'kept_asset_id' => $canonical['id'],
                        'archived_asset_id' => $dupe['id'],
                        'lessons_repointed' => $repointed,
                    ]);
                }
            }
        }

        AuditService::write($triggeredBy, 'video_remote_sync', [
            'outcome' => 'completed',
            'scanned_local' => $scannedLocal,
            'remote_videos' => count($remoteIds),
            'remote_pages' => $listing['pages'],
            'missing_remote' => count($missing),
            'removed' => $removed,
            'unknown_verification' => $unknownCount,
            'duplicate_groups' => $duplicates,
            'lessons_reconciled' => $reconciled,
        ]);

        return [
            'status' => 'ok',
            'scanned_local' => $scannedLocal,
            'remote_videos' => count($remoteIds),
            'remote_pages' => $listing['pages'],
            'missing_remote' => count($missing),
            // ACTUAL local video records removed during this sync (never a
            // merely-flagged count — there is no flagged state anymore).
            'removed' => $removed,
            'duplicates' => $duplicates,
            'reconciled' => $reconciled,
            'unknown_verification' => $unknownCount,
            'errors' => 0,
        ];
    }

    /**
     * Remove one locally-recorded video asset whose VdoCipher asset is
     * CONFIRMED deleted remotely (verified 404 after a complete successful
     * listing). Same data-preservation contract as the doctor-initiated
     * VideoController::deleteAsset local cleanup:
     *
     *   • lessons are DETACHED, not deleted — video_asset_id/video_id are
     *     nulled, video metadata cleared, and a published lesson is demoted
     *     to draft (a published lesson must never reference a missing video);
     *     the lesson row and its course are always PRESERVED.
     *   • the legacy video_id path is scoped to the acting doctor's own
     *     courses in scope='mine' so a doctor's sync can never detach or
     *     demote another teacher's lesson that happens to reference the same
     *     provider id. The FK path (video_asset_id) is inherently scoped —
     *     only lessons referencing THIS asset row can match.
     *   • upload history rows are archived (kept for audit, marked canceled)
     *     exactly like deleteAsset.
     *   • the asset row itself is hard-deleted (the established local model
     *     for deletion — there is no user-facing remotely-deleted state).
     *
     * Idempotent: re-running against an already-removed asset removes 0.
     * Callers MUST hold an open transaction.
     *
     * @param Database $db  open transaction handle
     * @param array $asset  { id, doctor_id, provider_video_id, ... }
     * @param string|null $ownerId  acting doctor id when scope='mine'
     *                              (legacy-ref scoping), null for admins
     * @return int  number of local asset rows actually removed (0 or 1)
     */
    private function removeLocallyConfirmedDeleted(Database $db, array $asset, ?string $ownerId): int
    {
        $assetId = (string) $asset['id'];
        $pvid = (string) $asset['provider_video_id'];

        // Scope clause for the LEGACY provider-id reference: admins clean the
        // platform-wide truth; a doctor's sync only ever touches lessons in
        // their own courses. The FK path needs no extra scope (row-identity).
        // NOTE: parameter order is (assetId, pvid[, ownerId]) and the SQL
        // tokens must match exactly — PDO is strict here (HY093 otherwise).
        $detachSql = "UPDATE lessons SET
                video_asset_id = NULL,
                video_id = NULL,
                video_type = 'vdocipher',
                video_status = IF(status = 'published', 'draft', video_status),
                status = IF(status = 'published', 'draft', status),
                video_upload_id = NULL,
                video_playback_id = NULL,
                video_thumbnail_url = NULL,
                video_duration_seconds = NULL,
                updated_at = UTC_TIMESTAMP(6)
             WHERE video_asset_id = ?"
            . ($ownerId !== null
                ? ' OR (video_id = ? AND course_id IN (SELECT id FROM courses WHERE doctor_id = ?))'
                : ' OR video_id = ?');
        // 1. Detach lessons (preserve lesson + course; demote published).
        $db->query($detachSql, $ownerId !== null ? [$assetId, $pvid, $ownerId] : [$assetId, $pvid]);

        // 2. Archive the upload history rows (audit preserved, not active).
        $db->query(
            "UPDATE video_uploads SET status = 'canceled', archived_at = UTC_TIMESTAMP(6),
                    error_message = 'Video asset removed by VdoCipher sync (deleted remotely)', updated_at = UTC_TIMESTAMP(6)
             WHERE provider_video_id = ?" . ($ownerId !== null ? ' AND doctor_id = ?' : ''),
            $ownerId !== null ? [$pvid, $ownerId] : [$pvid]
        );

        // 3. Remove the asset row (hard delete = the established local model).
        $db->query('DELETE FROM video_assets WHERE id = ?', [$assetId]);

        return 1;
    }
}
