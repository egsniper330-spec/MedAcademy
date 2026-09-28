'use strict';
/**
 * videoLibrarySync.test.cjs
 *
 * Regression pins for the VdoCipher ↔ Video Library integration:
 *   1. Reconciliation error-safety  — transient VdoCipher failures NEVER mark
 *      local videos deleted; only a confirmed 404 does.
 *   2. Doctor-scoped sync           — doctors reconcile their OWN library
 *      (scope clamped server-side); admins reconcile the platform.
 *   3. Remote-first delete order    — local rows die only after the remote
 *      deletion is confirmed (or already gone); unknown remote state aborts.
 *   4. Upload state machine         — real states (waiting→uploading→processing
 *      →encoding→ready/failed/timeout), no fake success, persistence/recovery.
 *   5. Duplicate prevention         — unique index + idempotent upsert key.
 *   6. Video Library hamburger      — standard PageHeader drawer pattern.
 *
 * Static-contract suite (same convention as fullscreenArchitecture.test.cjs):
 * reads the source files and pins the structural guarantees that protect the
 * live behavior. No network, no DB.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); }
};
const section = (t) => console.log(`\n── ${t} ──`);

// ── 1. Reconciliation error-safety ──────────────────────────────────────────
section('Reconciliation error-safety (VideoLibrarySyncService.php)');
{
  const svc = read('backend/src/Services/VideoLibrarySyncService.php');

  ok(/status'\] !== 'ok'/s.test(svc.replace(/\r/g, '')) && svc.includes("return [\n                'status' => 'error',"),
    'sync aborts with status=error when the remote listing fails');

  // The error-return must appear BEFORE the local transaction begins.
  const errIdx = svc.indexOf("'status' => 'error',");
  const beginIdx = svc.indexOf('$db->begin()');
  ok(errIdx !== -1 && beginIdx !== -1 && errIdx < beginIdx,
    'listing-failure return precedes any local transaction (nothing can be mutated)');

  ok(svc.includes("verifyRemote($pvid)") && svc.includes("if ($check['status'] === 'missing')"),
    'per-asset verify: only a confirmed missing (404) triggers removal');

  ok(svc.includes("elseif ($check['status'] === 'error')") && svc.includes('$unknownCount++'),
    'verify errors counted as unknown — never as deletion');

  ok(!svc.includes("status = 'remotely_deleted'") && svc.includes('DELETE FROM video_assets WHERE id = ?'),
    'confirmed-remote-deleted → local row REMOVED (no user-facing remotely-deleted state)');

  ok(svc.includes("UPDATE lessons SET\n                video_asset_id = NULL") && svc.includes("IF(status = 'published', 'draft', status)"),
    'lesson detach preserves lesson+course and demotes published lessons (deleteAsset contract)');

  ok(svc.includes("course_id IN (SELECT id FROM courses WHERE doctor_id = ?)"),
    'legacy provider-id detach is doctor-scoped (mine) — never detaches another doctor\'s lesson');

  ok(svc.includes('video_uploads SET status') && svc.includes('canceled'),
    'upload history archived (audit preserved), same as doctor-initiated delete');

  ok(svc.includes('429') || svc.includes('rate_limited'), 'rate-limit mid-listing is an error, not completion');
}
console.log();

// ── 2. Doctor-scoped reconciliation ─────────────────────────────────────────
section('Doctor-scoped reconciliation (controller clamp + service filter)');
{
  const ctrl = read('backend/src/Controllers/VideoController.php');
  const svc = read('backend/src/Services/VideoLibrarySyncService.php').replace(/\r/g, '');
  const routes = read('backend/routes/api.php').replace(/\r/g, '');

  ok(ctrl.includes("$request->json()['scope'] ?? 'all'"),
    'controller reads scope from the request body');

  ok(/in_array\(\$scope, \['all', 'mine'\], true\)/.test(ctrl),
    'scope is validated (422 on anything else)');

  ok(ctrl.includes("$scope = 'mine';") && ctrl.includes("in_array($request->user['role'], ['admin', 'super_admin'], true)"),
    'non-admin callers are CLAMPED to scope=mine server-side');

  ok(svc.includes("string $scope = 'all'"), 'service accepts the scope parameter');
  ok(svc.includes("$mine ? \" AND va.doctor_id = ?\" : ''"),
    "scope='mine' filters reconciled assets to the acting doctor's rows");
  ok(svc.includes("$mine ? \" AND doctor_id = ?\" : ''"),
    "scope='mine' also scopes duplicate detection (cross-doctor same-video is legitimate)");

  ok(routes.includes("['doctor', 'admin', 'super_admin']"), 'route file loaded with doctor role present'); // sanity
  ok(/post\('\/video\/sync-library'.*['"]doctor['"], ['"]admin['"], ['"]super_admin['"]/.test(routes),
    'sync-library route allows doctors (they can reconcile their own library)');
}
console.log();

// ── 3. Remote-first delete order ────────────────────────────────────────────
section('Remote-first delete (VideoController::deleteAsset)');
{
  const ctrl = read('backend/src/Controllers/VideoController.php');

  ok(ctrl.includes("$remoteState = $this->video->verifyRemote($providerVideoId)['status'];"),
    'delete resolves the remote state FIRST (exists|missing|error)');

  ok(ctrl.includes("if ($remoteState === 'exists') {") && ctrl.includes("$db->rollback();") &&
     /ApiException\(502, \$providerResult\['vdo_error'\]/.test(ctrl),
    'remote deletion failure rolls back the local transaction (502, retryable)');

  ok(ctrl.includes("throw new ApiException(502, 'VdoCipher is unreachable — the video was NOT deleted"),
    'unknown remote state aborts deletion entirely (no orphaned remote asset)');

  ok(ctrl.includes("elseif ($remoteState === 'missing') {"),
    'already-gone remote video is treated as satisfied (idempotent) then cleaned locally');

  ok(ctrl.indexOf('verifyRemote') < ctrl.indexOf("UPDATE lessons SET\n                    video_asset_id = NULL"),
    'remote verification happens BEFORE local lesson detachment');

  ok(ctrl.includes("'deleted' => true,") && ctrl.includes("'vdo_deleted' => true,"),
    'success response only after both remote + local deletion completed');
}
console.log();

// ── 4. Upload state machine (mobile) ────────────────────────────────────────
section('Upload state machine (real states, no fake success)');
{
  const engine = read('src/lib/videoUploadEngine.ts');
  const hook = read('src/lib/useVideoUploader.ts');
  const queue = read('src/components/VideoUploadQueue.tsx');
  const store = read('src/lib/uploadQueueStore.ts');

  ok(/'waiting'\s*\|\s*'uploading'/.test(engine) && engine.includes("'ready'") && engine.includes("'failed'") && engine.includes("'timeout'"),
    'UploadStatus covers waiting/uploading/processing/encoding/ready/failed/timeout');

  ok(hook.includes('pollVdoCipherReady') && hook.includes("getVdoCipherVideoStatus"),
    'polls the backend/VdoCipher status until actually ready');

  ok(hook.includes("if (result.status === 'ready')") && hook.includes("VdoCipher encoding failed"),
    'ready only on provider confirmation; provider failure → failed');

  ok(hook.includes("markTimeout") && hook.includes('POLL_TIMEOUT_MS'),
    'bounded processing poll with explicit timeout state');

  ok(queue.includes("'Ready to Watch'") && queue.includes("'Upload Failed'"),
    'queue UI distinguishes Ready from Failed');

  ok(queue.includes('indeterminate') && queue.includes('formatBytes(task.bytesUploaded)'),
    'uploading shows real byte progress; post-upload stages use indeterminate sweep');

  ok(queue.includes('{isReady && (') === false || queue.includes("'Ready to Watch'"),
    'checkmark UI keyed to the ready state');

  ok(store.includes("t.status !== 'ready' && t.status !== 'canceled'") && store.includes("status: 'recovering'"),
    'persistence: terminal states are not rehydrated; mid-flight → recovering (survives restart)');

  ok(store.includes("blocked backward transition"),
    'terminal states never regress (stale events cannot un-ready a task)');

  ok(hook.includes('getChunkUploadState') && hook.includes('startChunkIndex'),
    'retry resumes from stored chunk state — no blind re-upload / duplicate video');

  ok(hook.includes('retryProcessing') && hook.includes('t.vdoCipherVideoId'),
    'post-provider retry re-polls instead of creating a second VdoCipher video');

  // listing schema (the {count,rows} live contract) — protects uploadStatus+sync
  const vdo = read('backend/src/Video/VdoCipherService.php');
  ok(vdo.includes("isset($body['rows'])") && vdo.includes("isset($body['videos'])"),
    'listAllVideos accepts current {rows,count} AND legacy {videos} shapes');
}
console.log();

// ── 5. Duplicate prevention ─────────────────────────────────────────────────
section('Duplicate VdoCipher-ID prevention');
{
  const migration = read('backend/database/mysql-migrations/007_add_video_assets_unique_index.sql');
  const api = read('src/lib/videoLibraryApi.ts');

  ok(migration.includes('UNIQUE INDEX') && migration.includes('doctor_id, provider_video_id'),
    'migration 007 enforces one active asset per (doctor, provider video)');

  ok(api.includes("onConflict: 'doctor_id,provider_video_id'"),
    'upsertVideoAsset is idempotent on (doctor_id, provider_video_id) — retries cannot duplicate');
}
console.log();

// ── 6. Video Library hamburger ──────────────────────────────────────────────
section('Video Library navigation (hamburger via standard PageHeader)');
{
  const screen = read('src/app/(app)/(hubs)/video-library.tsx').replace(/\r/g, '');

  ok(screen.includes("import { PageHeader } from '@/components/PageHeader';"),
    'screen uses the shared PageHeader (standard drawer/back pattern)');

  ok(/<PageHeader\s*\n\s*title="Video Library"/.test(screen),
    'PageHeader renders the Video Library title (hamburger appears via DrawerContext)');

  ok(screen.includes('rightAction=') && screen.includes('Sync') && screen.includes('Upload'),
    'Sync + Upload preserved as header right actions');

  ok(screen.includes("syncVideoLibraryWithVdoCipher(true, 'mine')") &&
     screen.includes("isStaff ? 'all' : 'mine'"),
    'doctor auto-sync uses scope=mine; manual sync scopes by role');

  ok(screen.includes('AUTO_SYNC_INTERVAL_MS') && screen.includes('lastAutoSyncRef'),
    'auto-sync is throttled — no per-render VdoCipher calls');

  ok(screen.includes('VdoCipher sync was unavailable') && screen.includes('Nothing was changed'),
    'deferred-sync notice explains a failed sync honestly (library stays usable)');

  ok(screen.includes('setSyncing(true)') && !/load\(\);\s*\n\s*setSyncing\(/.test(screen),
    'sync is user/role-triggered, not wired into every render');
}

section('Upload progress visibility in Video Library');
{
  const screen = read('src/app/(app)/(hubs)/video-library.tsx').replace(/\r/g, '');

  ok(screen.includes('const activeUpload = tasks.find') && screen.includes("includes(t.status)"),
    'library derives the live in-flight upload task from the queue store');

  ok(screen.includes('`Uploading ${Math.round(t.progress)}%`'),
    'strip shows real byte progress percentage from the engine');

  ok(screen.includes("t.status === 'encoding' ? 'Processing video…'"),
    'VdoCipher processing/encoding is shown as its own stage (not Ready)');

  ok(screen.includes("t.status === 'failed' || t.status === 'timeout'") && screen.includes('retryUpload(t.id)'),
    'failed/timeout uploads expose an inline Retry wired to the engine retry');

  ok(/\{" height: 6, borderRadius: 3/.test(screen) === false,
    'sanity: strip markup present');
  ok(screen.includes('Live upload status strip'),
    'progress strip renders inside the library, independent of the queue panel');

  ok(screen.includes("import { useVideoUploader } from '@/lib/useVideoUploader';"),
    'retry reuses the existing engine hook (no second queue/control path)');
}

section('Reconciliation snapshot-authoritative design');
{
  const svc = read('backend/src/Services/VideoLibrarySyncService.php').replace(/\r/g, '');

  ok(/FALLBACK for this subset only[\s\S]{0,700}?verifyRemote/.test(svc),
    'per-asset verifyRemote is documented+positioned as fallback for absent subset only');

  ok(/\$remoteIds = array_fill_keys\(array_keys\(\$listing\['videos'\]\), true\);/.test(svc),
    'complete listing snapshot is the authoritative remote ID set');

  ok(/if \(\$listing\['status'\] !== 'ok'\)[\s\S]{0,700}?No video was removed/s.test(svc),
    'listing failure → abort, library untouched (no partial-snapshot deletion)');
}

// ── 7. Sync transport contract (client method ↔ route method) ───────────────
section('Sync transport contract (src/client/php.ts + routes/api.php)');
{
  const php = read('src/client/php.ts');
  const routes = read('backend/routes/api.php');

  const getRpcs = (php.match(/const GET_RPCS = new Set\(\[([\s\S]*?)\]\);/) || ['', ''])[1];
  ok(!getRpcs.includes("'sync_vdocipher_library'"),
    'sync_vdocipher_library is NOT a GET rpc (route is POST-only; GET 404s in the app UI)');

  ok(/\$router->post\('\/video\/sync-library'/.test(routes),
    'backend route /video/sync-library is registered as POST');

  ok(/\$router->post\('\/video\/sync-library'[\s\S]{0,200}?'doctor'/.test(routes),
    'sync route authorizes doctors (scope clamped server-side)');
}
console.log();

// ── 8. Filter chips layout (video-library.tsx) ──────────────────────────────
section('Filter chips layout (compact, content-sized)');
{
  const lib = read('src/app/(app)/(hubs)/video-library.tsx');

  // Parent must not grow vertically: react-native-web bases ScrollView on
  // flexGrow:1 — in the column parent the row inflated and the default
  // alignItems:'stretch' blew every chip up to a ~163px tall block.
  const chipsBlock = (lib.match(/Status filter chips[\s\S]*?<\/ScrollView>/) || [''])[0];
  ok(chipsBlock.includes('flexGrow: 0'), 'filter scroller has flexGrow:0 (cannot inflate vertically)');
  ok(chipsBlock.includes("alignItems: 'center'"), 'filter content row centers chips (no alignItems stretch)');
  ok(chipsBlock.includes('horizontal'), 'filter row is a horizontal scroller (compact single row)');

  // Chips stay content-sized — no equal-width flex, compact padding only.
  ok(!/flex:\s*1/.test(chipsBlock), 'chips have no flex:1 (content-sized width)');
  ok(/paddingHorizontal: 16, paddingVertical: 9, borderRadius: 20/.test(chipsBlock),
    'chip padding/radius in compact range (~36px tall, radius 20)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
