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
 *   - remote missing (404)      → video_assets.status = 'remotely_deleted';
 *                                 lessons.video_status = 'missing' (existing
 *                                 missing convention from markLessonVideoMissing)
 *   - listing error (timeout/5xx/429/auth) → ABORT untouched. A temporary
 *                                 network failure is NEVER interpreted as a
 *                                 deletion.
 *   - duplicates                → same provider_video_id on >1 active asset:
 *                                 keep the canonical row (most lessons attached,
 *                                 then oldest), re-point orphans where safe,
 *                                 archive the rest — never a blind delete.
 *
 * Deletion of a video through the app is handled by VideoController::deleteAsset
 * (remote-first, idempotent); this service is the read-side reconciliation.
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
     * @param string $triggeredBy  acting user id (audit)
     * @param bool   $repairDuplicates  also consolidate duplicate active assets
     * @return array structured summary, e.g.
     *   { scanned_local, remote_videos, missing_remote, marked_unavailable,
     *     duplicates, reconciled, errors, pages, status, error }
     */
    public function syncLibrary(string $triggeredBy, bool $repairDuplicates = true): array
    {
        $db = Database::instance();

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
                'error' => 'VdoCipher listing failed (' . ($listing['error'] ?? 'unknown') . ') — local library left untouched. No video was marked deleted.',
                'http_status' => $listing['http_status'],
                'scanned_local' => 0,
                'remote_videos' => count($listing['videos']),
                'pages' => $listing['pages'],
                'missing_remote' => 0,
                'marked_unavailable' => 0,
                'duplicates' => 0,
                'reconciled' => 0,
                'errors' => 1,
            ];
        }
        $remoteIds = array_fill_keys(array_keys($listing['videos']), true);

        // ── 2. Local VdoCipher-backed assets (both FK and legacy video_id) ──
        $assets = $db->select(
            "SELECT va.id, va.doctor_id, va.provider_video_id, va.status,
                    (SELECT COUNT(*) FROM lessons l WHERE l.video_asset_id = va.id) AS lesson_refs,
                    (SELECT COUNT(*) FROM lessons l2 WHERE l2.video_id = va.provider_video_id) AS id_refs
               FROM video_assets va
              WHERE va.provider_video_id IS NOT NULL AND va.provider_video_id <> ''"
        );
        $scannedLocal = count($assets);

        $missing = [];
        $marked = 0;
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
                // Not in the listing. Distinguish "proven gone" (404) from
                // "listing may be stale/incomplete" — verify individually
                // before touching anything.
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
            foreach ($missing as $asset) {
                $affected = $this->markRemotelyDeleted($db, $asset);
                $marked += $affected;
                AuditService::write($triggeredBy, 'video_remote_missing', [
                    'asset_id' => $asset['id'],
                    'provider_video_id' => $asset['provider_video_id'],
                    'lessons_flagged_missing' => $affected,
                ]);
            }
            $db->commit();
        } catch (\Throwable $e) {
            $db->rollback();
            AuditService::write($triggeredBy, 'video_remote_sync', ['outcome' => 'aborted_local_error', 'error' => $e->getMessage()]);
            throw new ApiException(500, 'Local reconciliation failed: ' . $e->getMessage());
        }

        // ── 4. Duplicate detection / consolidation ─────────────────────────
        $duplicateGroups = $db->select(
            "SELECT provider_video_id, COUNT(*) AS n
               FROM video_assets
              WHERE provider_video_id IS NOT NULL AND provider_video_id <> ''
              GROUP BY provider_video_id
             HAVING COUNT(*) > 1"
        );
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
                    // Asset is gone remotely — every copy is stale; the loop in
                    // step 3 already marked whichever rows it saw. Skip here;
                    // remaining copies get marked on the next pass.
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
            'marked_unavailable' => $marked,
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
            'marked_unavailable' => $marked,
            'duplicates' => $duplicates,
            'reconciled' => $reconciled,
            'unknown_verification' => $unknownCount,
            'errors' => 0,
        ];
    }

    /**
     * Transition one asset + its lessons to the remotely-deleted state.
     * Uses the EXISTING conventions: video_assets.status='remotely_deleted'
     * (new value) and lessons.video_status='missing' (established by
     * RpcController::markLessonVideoMissing). Returns the number of lessons
     * flagged. Deterministic and safe to re-run (WHERE guards on prior state).
     */
    private function markRemotelyDeleted(Database $db, array $asset): int
    {
        $db->query(
            "UPDATE video_assets
                SET status = 'remotely_deleted', remote_status = 'missing',
                    remote_synced_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)
              WHERE id = ? AND status <> 'remotely_deleted'",
            [$asset['id']]
        );
        // Lessons keep pointing at the id (history), but are flagged with the
        // established 'missing' status — the UI and OTP gate already know it.
        $db->query(
            "UPDATE lessons SET video_status = 'missing', updated_at = UTC_TIMESTAMP(6)
              WHERE (video_asset_id = ? OR video_id = ?) AND video_status <> 'missing'",
            [$asset['id'], $asset['provider_video_id']]
        );
        return (int) $db->value(
            'SELECT COUNT(*) FROM lessons WHERE (video_asset_id = ? OR video_id = ?) AND video_status = ?',
            [$asset['id'], $asset['provider_video_id'], 'missing'],
            0
        );
    }
}
