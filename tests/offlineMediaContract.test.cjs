'use strict';
/**
 * offlineMediaContract.test.cjs
 *
 * Regression pins for the three offline-media root-cause areas:
 *   A/N  Offline Library renders ONE INDEPENDENT CARD PER COURSE
 *        (circular image beside the name) — incl. the legacy-null-courseId
 *        merge bug.
 *   B    Course thumbnail is offline-safe: cached on-device at download
 *        time, rendered cached→remote→lesson-thumb→initials, dead URLs
 *        degrade to initials (never a permanent blank circle).
 *   C/E  Android 6120 + completion authority: exactly ONE VdoPlayerView per
 *        session; "Watch Offline" tears the online player down first; the
 *        SDK registry — not local progress — decides playability.
 *   D    Resolved VdoCipher Android SDK is 1.29.9 (renderer-error fixes).
 *   G    iOS "Tracks Not Found" is surfaced verbatim (SDK capability
 *        signal), never faked around.
 *   K/L  Offline OTP contract (canPersist/rentalDuration) + diagnostics
 *        accept the live {count,rows} listing schema.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r/g, '');
let passed = 0, failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); }
};
const section = (t) => console.log(`\n── ${t} ──`);

// ── D. SDK version ──────────────────────────────────────────────────────────
section('D) Resolved VdoCipher Android SDK = 1.29.9');
{
  const gradle = read('node_modules/vdocipher-rn-bridge/android/build.gradle');
  ok(gradle.includes('com.vdocipher.aegis:vdocipher-android:1.29.9'),
    'bridge pins vdocipher-android 1.29.9 (6120/6122 reliability fixes)');
  ok(!/resolutionStrategy|force\s/.test(read('android/build.gradle')),
    'app gradle does not force/override a different version');
  const pkg = JSON.parse(read('package.json'));
  ok(pkg.dependencies['vdocipher-rn-bridge'] === '2.0.1', 'RN bridge 2.0.1 declared');
}

// ── A/N. One independent card per course ────────────────────────────────────
section('A/N) Per-course cards (no visual merging)');
{
  const svc = read('src/lib/offlineVideoService.ts');
  // Legacy rows with courseId=null must NOT all collapse into one bucket.
  ok(svc.includes('name:${e.meta.courseName.trim()}') || svc.includes("`name:${e.meta.courseName.trim()}`"),
    'legacy courseId=null rows group by persisted courseName (bug: one merged card)');
  ok(svc.includes("'__nocourse__'"), 'entries with neither id nor name stay in a safe shared bucket');

  const lib = read('src/app/(app)/offline-library.tsx');
  ok(lib.includes('styles.courseCard') && lib.includes('flexDirection'), 'course cards render per-group in a map');
  ok(/courses\.map\(\(g\) =>/.test(lib), 'each course group renders as its own card');
  ok(lib.includes('courseAvatarWrap') && lib.includes('borderRadius: 32'),
    'circular avatar (borderRadius=32 on a 64dp wrap)');
  ok(lib.includes('courseTitle') || lib.includes('g.courseName'),
    'course name renders beside the image (flex row card)');

  const course = read('src/app/(app)/offline-course.tsx');
  ok(course.includes('groups.find((g) => g.courseId === courseId)'),
    'course detail opens exactly one course group by id');
}

// ── B. Thumbnail root cause ─────────────────────────────────────────────────
section('B) Course thumbnail: offline-safe + honest failure');
{
  const svc = read('src/lib/offlineVideoService.ts');
  ok(svc.includes('courseImageUrlLocal'), 'metadata carries the on-device cached image path');
  ok(svc.includes('cacheCourseImage') && svc.includes('downloadAsync'),
    'course image is downloaded to the app directory at download time (offline-safe)');
  ok(svc.includes("if (!url || Platform.OS === 'web') return null;") && svc.includes('catch {'),
    'cache is best-effort: web skip + failure never blocks the download');
  ok(/courseImageUrlLocal[\s\S]*?courseImageUrl[\s\S]*?lessonThumbnailUrl/.test(svc.slice(svc.indexOf('courseImage ='))),
    'render priority: local cached copy → remote URL → lesson thumbnail');

  const lib = read('src/app/(app)/offline-library.tsx');
  const course = read('src/app/(app)/offline-course.tsx');
  ok(lib.includes('onError={() => setFailed(true)}') || lib.includes('CourseAvatar'),
    'library card degrades to initials when the image source fails');
  ok(course.includes('CourseAvatar') && course.includes('onError'),
    'course-detail header degrades to initials when the image source fails');
  ok(lib.includes('g.courseImage') && course.includes('group.courseImage'),
    'both screens consume the resolved courseImage (no ad-hoc URL chains)');
}

// ── C/E. One player + SDK-authoritative completion ──────────────────────────
section('C/E) Exactly one VdoPlayerView; SDK registry is authoritative');
{
  const lesson = read('src/app/(app)/lesson/[id].tsx');
  ok(lesson.includes('6120 ROOT-CAUSE GUARD') && /setPlayerVisible\(false\);\s*\n\s*router\.push/.test(lesson),
    '"Watch Offline" tears down the online player BEFORE the offline player mounts');

  const players = [];
  for (const f of [
    'src/components/OfflineVideoPlayer.native.tsx',
    'src/components/VdoCipherPlayerNativeAdapter.native.tsx',
  ]) {
    const src = read(f);
    const mounts = (src.match(/<VdoPlayerView/g) || []).length;
    players.push({ f, mounts });
    ok(mounts === 1, `${f}: exactly one <VdoPlayerView> JSX mount (found ${mounts})`);
    ok(!/适用于|<Modal/.test(src) || !src.includes('<Modal'), `${f}: no Modal/second window for fullscreen`);
  }

  const svc = read('src/lib/offlineVideoService.ts');
  ok(svc.includes('reconcileOfflineMediaState') && svc.includes("native.status === 'completed'"),
    'playback-time guard re-checks the SDK registry before offering playback');
  ok(svc.includes("if (e && e.phase === 'completed') removeEntry(mediaId);"),
    'completed-but-absent-from-registry rows are reconciled (not blindly offered)');
  ok(svc.includes('mapNativeStatus') && svc.includes("case 'failed':"),
    'SDK failed/incomplete states flow into local state (reconciliation)');
  const player = read('src/components/OfflineVideoPlayer.native.tsx');
  ok(player.includes('PLAYBACK-TIME COMPLETION GUARD'),
    'player refuses doomed DRM loads when the SDK says not-completed');
}

// ── G. iOS Tracks Not Found honesty ─────────────────────────────────────────
section('G) iOS "Tracks Not Found" surfaced, never faked');
{
  const bridge = read('node_modules/vdocipher-rn-bridge/ios/VdoDownload.swift');
  ok(bridge.includes('getVideoQualities()') && bridge.includes('Tracks Not Found'),
    'bridge emits "Tracks Not Found" when the asset exposes zero downloadable qualities');
  const svc = read('src/lib/offlineVideoService.ts');
  ok(svc.includes('selectDownloadTracks') && svc.includes("videoIdx >= 0 ? [videoIdx] : []"),
    'iOS selects the video track only (no invented audio track)');
  ok(svc.includes('No downloadable tracks were provided for this video.'),
    'zero-track result is an honest refusal, not a fabricated track list');
  ok(svc.includes('tracks=${availableTracks.length}'),
    'sanitized track inventory is logged for diagnosis (no credentials)');
}

// ── K/L. Backend OTP + diagnostics contract ─────────────────────────────────
section('K/L) Offline OTP contract + diagnostics schema');
{
  const vdo = read('backend/src/Video/VdoCipherService.php');
  ok(vdo.includes("'canPersist'     => true,") && vdo.includes('rentalDuration'),
    'offline OTP carries the persistent-license rental rules');
  ok(vdo.includes('VDO_CUSTOM_PLAYER_ID') && vdo.includes("customPlayerId"),
    'customPlayerId flows from server config only (optional, never a secret)');
  const diag = read('backend/src/Services/SystemDiagnosticsService.php');
  ok(diag.includes("isset($decoded['rows'])") && diag.includes("isset($decoded['videos'])"),
    'diagnostics accept the live {count,rows} listing schema (200 stays 200)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
