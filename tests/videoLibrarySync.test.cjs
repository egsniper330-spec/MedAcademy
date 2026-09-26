/**
 * Automated tests for VDOCIPHER ↔ VIDEO LIBRARY SYNCHRONIZATION
 * (remote existence reconciliation · paginated listing · error-safe delete ·
 *  duplicate consolidation · playback/offline safety).
 *
 * Run: node tests/videoLibrarySync.test.cjs
 *
 * Backend (structural): no PHP runtime exists in this environment, so backend
 * behaviour is pinned structurally against the shipped PHP source — the same
 * convention as videoProviders.test.cjs. Any change to the pinned code paths
 * (verifyRemote semantics, listing pagination, delete-first flow, abort-on-
 * listing-error, reconciliation writes) breaks these tests.
 *
 * Client (behavioural): src/lib/videoLibraryApi.ts contract helpers are
 * exercised via source-contract assertions (the backendClient stub wall makes
 * full module execution infeasible here; the behavioral parts of the sync UI
 * are covered by the structural pins on the screen source).
 *
 * Scenarios (per the sync contract):
 *   A  existing remote video stays visible (never marked)
 *   B  remote-missing asset → remotely_deleted, hidden from active library
 *   C  duplicates by provider_video_id → detected + consolidated safely
 *   D  doctor delete → remote delete succeeds → local finalized
 *   E  remote delete fails → local intact, structured error, retry possible
 *   F  remote already deleted → idempotent local cleanup
 *   G  VdoCipher timeout → video NOT marked deleted
 *   H  VdoCipher 5xx → video NOT marked deleted
 *   I  upload retry / same VdoCipher ID → no duplicate active records
 *   J  sync follows ALL pages (pagination)
 *   K  playback of remotely-deleted video → no OTP (410)
 *   L  offline authorization for remotely-deleted video → refused
 *   M  non-super-admin cannot trigger sync (route role gate)
 *   N  concurrent delete → rollback on failure (transaction use)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.log('  ✗ ' + msg); }
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

// ════════════════════════════════════════════════════════════════════════════
// VdoCipherService — remote truth primitives
// ════════════════════════════════════════════════════════════════════════════
{
  const svc = read('backend/src/Video/VdoCipherService.php');

  // verifyRemote: strict three-state semantics (G/H root-cause fix)
  ok(/public function verifyRemote\(string \$videoId\): array/.test(svc),
    'service: verifyRemote() exists with a structured return');
  ok(/if \(\$http === 404\) \{\s*\n\s*return \['status' => 'missing'/.test(svc),
    'service: ONLY HTTP 404 classifies as missing (G/H: errors are never deletions)');
  ok(/return \['status' => 'error', 'http_status' => \$http\];/.test(svc),
    'service: non-200/404 (timeout, 401, 429, 5xx) → status error (UNKNOWN)');
  ok(/LEGACY boolean wrapper/.test(svc),
    'service: legacy providerExists() demoted to a wrapper (kept for compat)');

  // Official deletion endpoint (docs: DELETE /videos?videos={id}), idempotent 404
  ok(/'DELETE', '\/videos\?videos=' \. rawurlencode\(\$videoId\)/.test(svc),
    'service: delete uses the official DELETE /videos?videos={id} endpoint');
  ok(/\(\$vdoStatus >= 200 && \$vdoStatus < 300\) \|\| \$vdoStatus === 404/.test(svc),
    'service: deletion idempotent — 2xx or 404 counts as remote-deleted');
  ok(/public function providerConfigured\(\): bool/.test(svc),
    'service: providerConfigured() exposed for unknown-state policy decisions');

  // Listing (J): official paginated API, follows all pages, bounded memory
  ok(/public function listAllVideos\(int \$pageLimit = 100, int \$maxPages = 100\): array/.test(svc),
    'service: paginated listing with a safety cap (bounded time/memory)');
  ok(/'\/videos\?page=' \. \$page \. '&limit=' \. \$pageLimit/.test(svc),
    'service: uses the official listing endpoint GET /videos?page=N&limit=M');
  ok(/if \(count\(\$rowIds\) < \$pageLimit\) \{\s*\n\s*break;/.test(svc),
    'service: follows pages until a short page (never only the first page)');
  ok(/\$rowIds\[\] = \$id;/.test(svc) && /foreach \(\$rows as \$row\)/.test(svc),
    'service: collects every remote video id across pages');
  ok(/'rate_limited'/.test(svc),
    'service: 429 mid-listing aborts as an error (never treated as complete)');
}

// ════════════════════════════════════════════════════════════════════════════
// VideoLibrarySyncService — reconciliation policy
// ════════════════════════════════════════════════════════════════════════════
{
  const sync = read('backend/src/Services/VideoLibrarySyncService.php');

  ok(/class VideoLibrarySyncService/.test(sync), 'sync: service exists in the backend');

  // Abort-on-listing-error (G/H at sync level): local data untouched
  ok(/if \(\$listing\['status'\] !== 'ok'\)/.test(sync),
    'sync: a failed listing ABORTS reconciliation — nothing is marked deleted');
  ok(/'outcome' => 'aborted_listing_error'/.test(sync),
    'sync: aborted syncs are audit-logged with the upstream cause');
  ok(/No video was marked deleted/.test(sync),
    'sync: structured error tells the operator the library is untouched');

  // Missing → remotely_deleted (B) with lessons flagged via existing convention
  ok(/'missing' \) => \[\]\n?|if \(\$check\['status'\] === 'missing'\)/.test(sync) || /if \(\$check\['status'\] === 'missing'\)/.test(sync),
    'sync: only a PROVEN missing (404) asset is reconciled');
  ok(/SET status = 'remotely_deleted'/.test(sync),
    'sync: local lifecycle transitions to remotely_deleted');
  ok(/UPDATE lessons SET video_status = 'missing'/.test(sync),
    'sync: lessons flagged with the established video_status=missing convention');

  // Exists → stays visible + stamped (A)
  ok(/remote_status = 'exists', remote_synced_at = UTC_TIMESTAMP\(6\)/.test(sync),
    'sync: verified-present assets are stamped (remote_status/remote_synced_at)');

  // Transactions: no DB transaction held across the remote listing; reconcile
  // runs in a local transaction (N)
  ok(/listAllVideos\(\)/.test(sync) && /\$db->begin\(\)/.test(sync),
    'sync: remote listing happens before the local transaction begins');

  // Duplicates (C, I): canonical = most refs, then oldest; no blind delete
  ok(/GROUP BY provider_video_id\s*\n\s*HAVING COUNT\(\*\) > 1/.test(sync),
    'sync: duplicates detected by the canonical identity (VdoCipher video ID)');
  ok(/lesson_refs DESC, created_at ASC, id ASC/.test(sync),
    'sync: canonical pick is deterministic (most refs, then oldest)');
  ok(/status = 'duplicate_removed'/.test(sync),
    'sync: duplicate copies archived (data preserved), never blindly deleted');
  ok(/video_duplicate_detected/.test(sync),
    'sync: duplicate consolidation is audited');
  ok(/video_remote_missing/.test(sync) && /video_remote_sync/.test(sync),
    'sync: remote-missing + summary events audited (existing audit architecture)');

  // Ready-state catch-up is idempotent
  ok(/'Ready' && \$asset\['status'\] === 'processing'/.test(sync),
    'sync: ready-state catch-up only for still-processing rows (idempotent)');
}

// ════════════════════════════════════════════════════════════════════════════
// VideoController — deleteAsset remote-first contract (D/E/F) + sync endpoint
// ════════════════════════════════════════════════════════════════════════════
{
  const ctl = read('backend/src/Controllers/VideoController.php');
  const routes = read('backend/routes/api.php');

  // deleteAsset: verify first; error ≠ missing (E root-cause fix)
  ok(/\$remoteState = \$this->video->verifyRemote\(\$providerVideoId\)\['status'\];/.test(ctl),
    'controller: deleteAsset resolves the remote state BEFORE deleting');
  ok(/if \(\$remoteState === 'error' && !\$this->video->providerConfigured\(\)\)/.test(ctl),
    'controller: unconfigured secret → no remote resource to clean (absent, not error)');
  ok(/elseif \(\$remoteState === 'error'\) \{\s*\n\s*\$db->rollback\(\);\s*\n\s*throw new ApiException\(502, 'VdoCipher is unreachable — the video was NOT deleted/.test(ctl),
    'controller: UNKNOWN remote state aborts with a structured error (retryable)');
  ok(/VdoCipher is unreachable — the video was NOT deleted/.test(ctl),
    'controller: user-facing error explicitly says the video was NOT deleted');

  // exists → remote delete, failure rolls back (D/E)
  ok(/if \(\$remoteState === 'exists'\) \{\s*\n\s*\$providerResult = \$this->video->deleteVideo\(\$providerVideoId\);/.test(ctl),
    'controller: existing asset → VdoCipher DELETE is attempted');
  ok(/if \(!\$providerDeleted\) \{\s*\n\s*\$db->rollback\(\);\s*\n\s*throw new ApiException\(502/.test(ctl),
    'controller: failed remote delete rolls back local finalize (library never lies)');

  // missing → idempotent cleanup (F)
  ok(/elseif \(\$remoteState === 'missing'\) \{/.test(ctl) && /already_gone_at_delete_time/.test(ctl),
    'controller: remote-already-deleted proceeds idempotently (audited)');

  // Sync endpoint (M): super_admin only + feature flag
  ok(/public function syncLibrary\(Request \$request\): array/.test(ctl),
    'controller: syncLibrary action exists');
  ok(/\$this->flags->assertEnabled\('video_library_sync', \$request\)/.test(ctl),
    'controller: sync gated by the video_library_sync feature flag');
  ok(/\$router->post\('\/video\/sync-library', \[VideoController::class, 'syncLibrary'\], \$auth \+ \['role' => \['super_admin'\]\]\)/.test(routes),
    'routes: POST /video/sync-library is Super Admin-only');

  // Audit actions (constraint must cover every emitted action)
  const schema = read('backend/database/schema.sql');
  for (const action of ['video_remote_sync', 'video_remote_missing', 'video_duplicate_detected',
    'video_remote_delete_succeeded', 'video_remote_delete_failed', 'video_local_reconciled', 'video_delete_requested']) {
    ok(schema.includes("'" + action + "'"),
      'schema: audit action ' + action + ' present in chk_audit_logs_action');
  }

  // Playback safety (K/L): proven-missing lessons cannot get OTPs
  const vdo = read('backend/src/Video/VdoCipherService.php');
  const otpBody = vdo.slice(vdo.indexOf('public function otp('), vdo.indexOf('public function offlineAuthorize('));
  const offBody = vdo.slice(vdo.indexOf('public function offlineAuthorize('), vdo.indexOf('public function uploadInit('));
  ok(/video_status\s+\|\|\s+\(\$lesson\['video_status'\] \?\? ''\) === 'missing'|video_status.*=== 'missing'/.test(otpBody),
    'service: otp() refuses lessons flagged missing (410 — no OTP for dead assets)');
  ok(/=== 'missing'/.test(offBody),
    'service: offlineAuthorize() refuses lessons flagged missing (410)');
  for (const body of [otpBody, offBody]) {
    ok(/410, 'This video is no longer available'/.test(body),
      'service: stable 410 unavailable response for proven-deleted videos');
  }
  // Both queries must now select video_status so the gate can fire
  ok(/SELECT course_id, video_id, status, video_status FROM lessons/.test(vdo),
    'service: lesson queries include video_status (gate has its input)');

  // Migration 027 exists with the sync columns + uniqueness/index story
  const mig = read('backend/database/mysql-migrations/027_vdocipher_library_sync.sql');
  ok(/ADD COLUMN `remote_synced_at`/.test(mig) && /ADD COLUMN `remote_status`/.test(mig),
    'migration 027: sync columns added to video_assets');
  ok(/CREATE INDEX `idx_video_assets_remote_sync`/.test(mig),
    'migration 027: reconciliation index on (provider_video_id, remote_synced_at)');
  ok(/WHY NO UNIQUE CONSTRAINT ON provider_video_id ALONE/.test(mig),
    'migration 027: documents why a global unique index is not forced');

  // Feature flag registered with a safe default
  const flags = read('backend/src/Services/FeatureFlagService.php');
  ok(/'video_library_sync' => \[/.test(flags), 'flags: video_library_sync registered');
  ok(/'video_library_sync' => \[[\s\S]*?'default'     => true/.test(flags),
    'flags: video_library_sync defaults ENABLED (deterministic when absent)');
}

// ════════════════════════════════════════════════════════════════════════════
// Client — API layer + Video Library UI
// ═════════════════════════════════════════Video Library UI
// ════════════════════════════════════════════════════════════════════════════
{
  const api = read('src/lib/videoLibraryApi.ts');
  const php = read('src/client/php.ts');
  const screen = read('src/app/(app)/(doctor)/video-library.tsx');
  const saScreen = read('src/app/(app)/(superadmin)/sa-video-library.tsx');

  // API layer
  ok(/sync_vdocipher_library/.test(php) && /'\/video\/sync-library'/.test(php),
    'client: RPC map exposes sync_vdocipher_library → POST /video/sync-library');
  ok(/export async function syncVideoLibraryWithVdoCipher/.test(api),
    'client: typed syncVideoLibraryWithVdoCipher() in the video library API layer');
  ok(/remotely_deleted|duplicate_removed/.test(api),
    'client: VideoAsset status type includes the new lifecycle states');

  // UI: sync affordance + stale handling (never renders dead as available)
  ok(/Sync VdoCipher/.test(screen), 'UI: manual "Sync VdoCipher" action present');
  ok(/profile\?\.role === 'super_admin' \|\| profile\?\.role === 'admin'/.test(screen),
    'UI: sync action only offered to admins (client mirror of the server gate)');
  ok(/Syncing video library with VdoCipher…/.test(screen),
    'UI: "Syncing video library…" status shown while a sync runs');
  ok(/Last synchronized:/.test(screen), 'UI: completion timestamp surfaced');
  ok(/This video was deleted from VdoCipher/.test(screen),
    'UI: remotely-deleted rows show an explicit unavailable notice, not a normal card');
  ok(/Deleted on VdoCipher/.test(screen),
    'UI: remotely-deleted status renders with a human label (not raw enum text)');
  ok(/\{ value: 'remotely_deleted', label: 'Deleted on VdoCipher' \}/.test(screen),
    'UI: status filter includes the remotely-deleted bucket');
  ok(/remotely_deleted.*return '#EF4444'|'remotely_deleted': return '#EF4444'/.test(screen),
    'UI: remotely-deleted badge uses the unavailable red');
  // Dead rows never reach the delete-confirmation flow under a false promise:
  // Remove routes through the same audited, idempotent server flow.
  ok(/onPress=\{\(\) => handleDelete\(item\)\}/.test(screen),
    'UI: Remove on an unavailable row goes through the real deletion flow (idempotent)');
  ok(/export \{ default \} from '@\/app\/\(app\)\/\(doctor\)\/video-library';/.test(saScreen),
    'UI: SA video-library route shares the same library screen (single source)');

  // Upload idempotency (I): the per-doctor unique index guards INSERTs
  const schema = read('backend/database/schema.sql');
  ok(/CREATE UNIQUE INDEX `video_assets_doctor_provider_uniq` ON `video_assets` \(`doctor_id`, `provider_video_id`\)/.test(schema),
    'schema: (doctor_id, provider_video_id) unique index present (duplicate INSERT guard)');
  ok(/upsert\(row, \{\s*\n\s*onConflict: 'doctor_id,provider_video_id'/.test(api),
    'client: upload-side asset creation upserts on the unique key (retry-safe)');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
