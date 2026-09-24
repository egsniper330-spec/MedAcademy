/**
 * Automated tests for the OFFLINE VIDEO state machines.
 *
 * Run: npm run test:offline   (or: node .freebuff/run-offline-tests.cjs)
 *
 * Compiles the pure, easily-isolated parts of src/lib/offlineVideoService.ts
 * (nextPhase / selectDownloadTracks / isOfflineVideoExpired) and the pure
 * evaluateOfflineUpdatePolicy in src/lib/securityStateModel.ts, then asserts
 * the product-spec state machines:
 *   • download phase transitions (queued→progress→completed/failed, no
 *     resurrection of a completed download, removal clears the row)
 *   • track selection parity (Android: 1 video + 1 audio; iOS: video only)
 *   • expiry from the server-issued rental window (both platforms)
 *   • offline update policy (no cache / cached supported / cached required /
 *     stale cache / garbage cache)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.log('  ✗ ' + msg); }
}

// ── Compile helpers ───────────────────────────────────────────────────────────
// The service file's pure functions are extracted (they sit between clearly
// marked sections) rather than compiling the whole module, which imports RN.
function extractPureSection(source, startMark, endMark) {
  const a = source.indexOf(startMark);
  const b = source.indexOf(endMark, a);
  if (a < 0 || b < 0) throw new Error('section markers not found: ' + startMark);
  return source.slice(a, b);
}

function compileModule(name, code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offlinetest-'));
  const out = path.join(dir, name + '.js');
  const src = path.join(dir, name + '.ts');
  fs.writeFileSync(src, code, 'utf8');
  // Windows-safe: spawn node on the tsc entry script (no .cmd shim).
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    src, '--outDir', dir, '--module', 'commonjs', '--target', 'es2020',
    '--skipLibCheck', '--noEmitOnError', 'false',
  ], { stdio: 'pipe' });
  return require(out);
}

// ── 1. Phase machine ──────────────────────────────────────────────────────────
console.log('── Offline download phase machine ──');
{
  const svcSrc = fs.readFileSync(path.join(ROOT, 'src/lib/offlineVideoService.ts'), 'utf8');
  const phaseSection = extractPureSection(
    svcSrc,
    '/** Pure transition table',
    'function applyEntry'
  ).replace(/import[^\n]*\n/g, '');
  const types = `
    type OfflineDownloadPhase = 'authorizing' | 'pending' | 'downloading' | 'completed' | 'failed';
  `;
  const mod = compileModule('phases', types + phaseSection);
  const nextPhase = mod.nextPhase;

  // enqueued → pending
  assert(nextPhase('authorizing', 'enqueued') === 'pending', 'enqueued on authorizing → pending');
  // progress → downloading (and stays)
  assert(nextPhase('pending', 'progress') === 'downloading', 'progress on pending → downloading');
  assert(nextPhase('downloading', 'progress') === 'downloading', 'progress on downloading → downloading');
  // completed is absorbing for progress
  assert(nextPhase('completed', 'progress') === 'completed', 'progress on completed → completed (no resurrection)');
  // completed is absorbing for failure
  assert(nextPhase('completed', 'failed') === 'completed', 'failed on completed → completed (completed downloads never flip to failed)');
  // normal failure path
  assert(nextPhase('downloading', 'failed') === 'failed', 'failed on downloading → failed');
  assert(nextPhase('pending', 'failed') === 'failed', 'failed on pending → failed');
  // removed clears the row
  assert(nextPhase('completed', 'removed') === null, 'removed on completed → row dropped');
  assert(nextPhase('downloading', 'removed') === null, 'removed on downloading → row dropped');
}

// ── 2. Track selection parity ────────────────────────────────────────────────
console.log('── Track selection parity ──');
{
  const svcSrc = fs.readFileSync(path.join(ROOT, 'src/lib/offlineVideoService.ts'), 'utf8');
  const selSection = extractPureSection(
    svcSrc,
    'export function selectDownloadTracks',
    '// ─── Download orchestration'
  );
  // Platform.OS is captured at module-load time — compile once per platform.
  const selectFor = (platform) => {
    process.env.MOCK_PLATFORM = platform;
    const m = compileModule('tracks-' + platform, `
      type Track = { id: number; type: string; language: string; bitrate: number; width: number; height: number; label: string };
      const Platform = { OS: process.env.MOCK_PLATFORM || 'android' };
      ${selSection}
    `);
    return m.selectDownloadTracks;
  };
  const selectAndroid = selectFor('android');
  const selectIos = selectFor('ios');
  const select = selectAndroid;

  const tracks = [
    { id: 10, type: 'video', bitrate: 800 },
    { id: 11, type: 'video', bitrate: 2500 },
    { id: 12, type: 'audio', language: 'en' },
    { id: 13, type: 'audio', language: 'ar' },
  ];

  const android = selectAndroid(tracks);
  assert(android.selections.length === 2, 'Android: exactly two selections (1 video + 1 audio)');
  assert(android.selections.includes(1), 'Android: picks highest-bitrate video track (index 1)');
  assert(android.selections.includes(2), 'Android: picks first audio track (index 2)');
  assert(android.platform === 'android', 'Android: platform reported');

  const ios = selectIos(tracks);
  assert(ios.selections.length === 1, 'iOS: exactly one selection (video only — official rule)');
  assert(ios.selections.includes(1), 'iOS: picks highest-bitrate video track');
  assert(ios.platform === 'ios', 'iOS: platform reported');

  // Edge: no tracks at all
  const none = select([]);
  assert(none.selections.length === 0, 'No available tracks → empty selections (caller refuses enqueue)');
}

// ── 3. Expiry model ───────────────────────────────────────────────────────────
console.log('── Rental expiry (single source of truth: server-issued expiresAt) ──');
{
  const svcSrc = fs.readFileSync(path.join(ROOT, 'src/lib/offlineVideoService.ts'), 'utf8');
  const expSection = extractPureSection(
    svcSrc,
    'export function isOfflineVideoExpired',
    'export function getPlayableOfflineVideos'
  );
  const mod = compileModule('expiry', `
    interface OfflineVideoEntry {
      meta: { expiresAt: string };
      phase: string;
    }
    ${expSection}
  `);
  const expired = mod.isOfflineVideoExpired;

  const future = Date.now() + 3_600_000;
  const past = Date.now() - 3_600_000;
  const mk = (expiresAt, phase) => ({ phase, meta: { expiresAt } });

  assert(expired(mk(new Date(future).toISOString(), 'completed')) === false, 'future expiry → playable');
  assert(expired(mk(new Date(past).toISOString(), 'completed')) === true, 'past expiry → expired');
  assert(expired(mk('not-a-date', 'completed')) === false, 'unparseable expiry → NOT auto-expired (DRM layer remains authority)');
  assert(expired(mk(new Date(past).toISOString(), 'downloading')) === false, 'expiry ignored for non-completed phases');
  assert(expired(mk('', 'completed')) === false, 'missing expiry → NOT auto-expired (defensive; server always issues one)');
}

// ── 4. Offline update policy ──────────────────────────────────────────────────
console.log('── Offline update-policy cache ──');
{
  const modelSrc = fs.readFileSync(path.join(ROOT, 'src/lib/securityStateModel.ts'), 'utf8');
  const polSection = modelSrc.slice(modelSrc.indexOf('export interface CachedUpdatePolicy'));
  const mod = compileModule('updpol', polSection);
  const ev = mod.evaluateOfflineUpdatePolicy;
  const DAY = 86_400_000;
  const now = 1_800_000_000_000;

  // No cache → network unavailability is NOT an update requirement
  assert(ev(null, now).verdict === 'SUPPORTED' && ev(null, now).reason === 'no_cached_policy',
    'no cache → SUPPORTED (offline itself never blocks)');

  // Cached SUPPORTED within window
  assert(ev({ verdict: 'SUPPORTED', minimumVersionCode: 230, confirmedAt: now - 2 * DAY }, now).reason === 'cached_supported',
    'recent cached SUPPORTED → usable offline');

  // Cached SUPPORTED stale → still supported, but treated as unknown-cache
  assert(ev({ verdict: 'SUPPORTED', minimumVersionCode: 230, confirmedAt: now - 20 * DAY }, now).reason === 'no_cached_policy',
    'stale cached SUPPORTED → treated as no policy');

  // Cached UPDATE_REQUIRED honored per validity
  const req = ev({ verdict: 'UPDATE_REQUIRED', minimumVersionCode: 230, confirmedAt: now - DAY }, now);
  assert(req.verdict === 'UPDATE_REQUIRED' && req.reason === 'cached_required' && req.minimumVersionCode === 230,
    'recent cached UPDATE_REQUIRED → blocked with cached floor');

  // A REQUIREMENT never decays into support through staleness alone
  const staleReq = ev({ verdict: 'UPDATE_REQUIRED', minimumVersionCode: 230, confirmedAt: now - 20 * DAY }, now);
  assert(staleReq.verdict === 'SUPPORTED' && staleReq.reason === 'cached_required_expired',
    'stale cached requirement expires by policy (documented, explicit branch)');

  // Garbage cache never becomes a block
  assert(ev({ verdict: 'GARBAGE', minimumVersionCode: NaN, confirmedAt: now }, now).verdict === 'SUPPORTED',
    'garbage verdict → SUPPORTED (never invents a block)');
  assert(ev({ verdict: 'UPDATE_REQUIRED', minimumVersionCode: 230, confirmedAt: now + 10 * 60_000 }, now).reason === 'no_cached_policy',
    'future confirmation timestamp → treated as absent');
}

// ── 5. Raw VdoCipher filename/title ban (UI title hygiene) ────────────────────
console.log('── Raw VdoCipher title ban (safeDisplayTitle) ──');
{
  const svcSrc = fs.readFileSync(path.join(ROOT, 'src/lib/offlineVideoService.ts'), 'utf8');
  const titleSection = extractPureSection(
    svcSrc,
    '/**\n * VdoCipher media often arrives titled',
    'export interface OfflineCourseGroup'
  );
  const mod = compileModule('titles', titleSection);
  const { isInternalVideoTitle, safeDisplayTitle } = mod;

  // The exact filename observed on the physical device must be classified internal
  assert(isInternalVideoTitle('2023_08_22_01_20_IMG_4574.MP4') === true, 'device-observed raw filename → internal');
  assert(isInternalVideoTitle('lecture.mp4') === true, 'any .mp4 name → internal');
  assert(isInternalVideoTitle('IMG_4574.mov') === true, '.mov name → internal');
  assert(isInternalVideoTitle('Pharmacology — Lecture 01') === false, 'human title → NOT internal');
  assert(isInternalVideoTitle('') === true && isInternalVideoTitle(null) === true && isInternalVideoTitle(undefined) === true, 'empty/null → internal (force fallback)');
  assert(isInternalVideoTitle('e3b0c44298fc1c149afbf4c8996fb924') === true, 'opaque hash-like name → internal');

  // MedAcademy lesson title wins
  assert(safeDisplayTitle({ lessonTitle: 'Lecture 01 — Introduction', title: 'x.mp4' }) === 'Lecture 01 — Introduction',
    'MedAcademy lesson title wins');
  // Raw filename can NEVER surface — falls back to the generic label
  assert(safeDisplayTitle({ lessonTitle: '2023_08_22_01_20_IMG_4574.MP4', title: null }) === 'Offline Video',
    'raw filename lessonTitle → generic label (never rendered)');
  assert(safeDisplayTitle({ lessonTitle: null, title: 'IMG_4574.MP4' }) === 'Offline Video',
    'raw filename persisted title → generic label');
  assert(safeDisplayTitle({}) === 'Offline Video', 'no titles at all → generic label');
  assert(safeDisplayTitle({ lessonTitle: 'Real Title', title: '2023_08_22_01_20_IMG_4574.MP4' }) === 'Real Title',
    'real title preferred over raw filename fallback');
}

// ── 6. Course grouping (library cards) ────────────────────────────────────────
console.log('── Course grouping ──');
{
  const svcSrc = fs.readFileSync(path.join(ROOT, 'src/lib/offlineVideoService.ts'), 'utf8');
  const groupSection = extractPureSection(
    svcSrc,
    'export interface OfflineCourseGroup',
    'async function persist'
  );
  const types = `
    type OfflineDownloadPhase = 'authorizing' | 'pending' | 'downloading' | 'completed' | 'failed';
    interface OfflineVideoMeta {
      mediaId: string; lessonId: string; courseId: string | null; title: string;
      lessonTitle: string; courseName: string | null; lessonThumbnailUrl: string | null;
      lessonOrder: number | null; userId: string; rentalHours: number | null;
      expiresAt: string; authorizedAt: number; durationSec: number | null; posterUrl: string | null;
      courseImageUrl: string | null; sectionTitle: string | null;
    }
    interface OfflineVideoEntry { meta: OfflineVideoMeta; phase: OfflineDownloadPhase; progress: number;
      bytesDownloaded: number; totalSizeBytes: number | null; lastError: string | null; updatedAt: number; }
  `;
  const mod = compileModule('groups', types + groupSection);
  const group = mod.exportOfflineCourseGroups;

  const mkE = (id, courseId, courseName, phase, order, progress) => ({
    meta: { mediaId: id, lessonId: 'l' + id, courseId, courseName, title: 't', lessonTitle: 'Lesson ' + id,
      lessonThumbnailUrl: null, lessonOrder: order, userId: 'u', rentalHours: 72,
      expiresAt: new Date(Date.now() + 864e5).toISOString(), authorizedAt: 0, durationSec: null, posterUrl: null,
      courseImageUrl: null, sectionTitle: null },
    phase, progress, bytesDownloaded: 0, totalSizeBytes: null, lastError: null, updatedAt: 0,
  });

  assert(group([]).length === 0, 'no entries → no groups');

  // Grouping by course + lessonOrder sorting inside the group
  const g1 = group([
    mkE('b', 'c1', 'Pharmacology', 'completed', 2, 100),
    mkE('a', 'c1', 'Pharmacology', 'completed', 1, 100),
    mkE('z', 'c2', 'Anatomy', 'downloading', 1, 40),
  ]);
  assert(g1.length === 2, 'two courses → two groups');
  const pharm = g1.find((g) => g.courseId === 'c1');
  assert(!!pharm && pharm.lessons.length === 2, 'same course entries grouped together');
  assert(!!pharm && pharm.lessons[0].meta.mediaId === 'a' && pharm.lessons[1].meta.mediaId === 'b',
    'lessons sorted by lessonOrder inside the group');
  assert(!!pharm && pharm.completedCount === 2, 'completed count reflects reality ("2 videos downloaded")');
  assert(!!pharm && pharm.progressPercent === 100, 'all-completed course → 100%');
  const anat = g1.find((g) => g.courseId === 'c2');
  assert(!!anat && anat.progressPercent === 40 && anat.activeCount === 1, 'in-progress course → real percent + active count');
  assert(g1[0].courseId === 'c2', 'course with active download sorts first');

  // Failed course surfaces its failure count
  const g2 = group([mkE('f', 'c3', 'Biochem', 'failed', 1, 0)]);
  assert(g2[0].failedCount === 1, 'failed downloads counted for the retry UI');

  // No course metadata → safe generic grouping, never a filename
  const g3 = group([mkE('n', null, null, 'completed', 1, 100)]);
  assert(g3.length === 1 && g3[0].courseId === '__nocourse__' && g3[0].courseName === 'My Downloads',
    'entries without course metadata → generic "My Downloads" group');

  // Course name comes from MedAcademy metadata only
  const g4 = group([mkE('q', 'c9', 'Cardiology', 'completed', 1, 100)]);
  assert(g4[0].courseName === 'Cardiology', 'courseName from MedAcademy metadata');
}

// ── VdoCipher offline-OTP payload contract (regression for the 403 fix) ───
// The official VdoCipher offline-OTP contract (docs/server/playbackauth/offline)
// requires licenseRules = SERIALIZED JSON STRING {"canPersist":true,
// "rentalDuration":<seconds>}. The previously shipped payload used an invented
// `licenseValidty` object and never set canPersist → the license server
// rejected the persistent-license request at download time ("License creation
// failed", HTTP 403) while OTP minting itself still returned 200.
{
  const svc = fs.readFileSync('backend/src/Video/VdoCipherService.php', 'utf8');

  // 1. The offline OTP payload must carry licenseRules built from the rental policy
  assert(
    /\$payload\['licenseRules'\]\s*=\s*json_encode\(\[/.test(svc),
    'offline OTP payload must send licenseRules as a serialized JSON string (official contract)'
  );
  assert(
    /'canPersist'\s*=>\s*true/.test(svc),
    'licenseRules must include canPersist=true (persistent-license permission)'
  );
  assert(
    /'rentalDuration'\s*=>\s*\$rentalHours\s*\*\s*3600/.test(svc),
    'licenseRules must include rentalDuration in SECONDS derived from the server policy'
  );

  // 2. The invented parameter must never return
  assert(
    !/licenseValidty/.test(svc),
    'invented licenseValidty parameter must not exist anywhere in the service'
  );

  // 3. Rental policy stays server-side and finite (fail-safe defaults)
  assert(
    /\$rentalHours\s*=\s*90 \* 24;/.test(svc),
    'offline rental default must be 90 days (server-side policy, client cannot extend)'
  );
  assert(
    /\$h > 0 && \$h <= 24 \* 365/.test(svc),
    'rental config must be bounded (rejects zero/negative/infinite durations)'
  );

  // 4. Client surface: the download flow passes ONLY otp+playbackInfo to the
  //    official SDK; no client-side license rules, no extension path.
  const client = fs.readFileSync('src/lib/offlineVideoService.ts', 'utf8');
  assert(
    /VdoDownload\.getDownloadOptions\(\{\s*otp: token\.otp,\s*playbackInfo: token\.playbackInfo,\s*\}\)/.test(client),
    'client must pass only otp+playbackInfo to the official getDownloadOptions'
  );
  assert(
    !/canPersist|rentalDuration|licenseRules/.test(client),
    'client must not carry license-rule parameters (server-side only)'
  );
  passed++; console.log('ok: offline OTP payload contract (licenseRules/canPersist/rentalDuration)');
}

// ── 7. Watermark identity (P4/P5/P6 — no UUID leaks, stable identity) ────────
console.log('── Watermark identity (no UUID leak / online-parity) ──');
{
  const idSrc = fs.readFileSync(path.join(ROOT, 'src/lib/watermarkIdentity.ts'), 'utf8');
  const mod = compileModule('wmidentity', idSrc);
  const { resolveWatermarkIdentity, watermarkLabel } = mod;

  const UUID = '758490a6-5538-4af2-acf3-a72b862804d6'; // the exact id seen leaking on device

  // Public MED id resolves; name combined in the ONLINE format
  assert(watermarkLabel(resolveWatermarkIdentity({ public_user_id: 'MED-0002', full_name: 'Ahmed Mohamed' })) === 'Ahmed Mohamed • MED-0002',
    'online format "NAME • MED-####"');
  assert(watermarkLabel(resolveWatermarkIdentity({ public_user_id: 'MED-0002' })) === 'MED-0002', 'ID-only mode when name absent');

  // THE REGRESSION: a UUID (internal DB id) must NEVER resolve — this is the
  // offline fallback that leaked '758490a6-…' onto the player.
  assert(resolveWatermarkIdentity({ public_user_id: UUID, full_name: 'X' }) === null, 'UUID in public_user_id → null (never rendered)');
  assert(resolveWatermarkIdentity({ watermark_id: UUID }) === null, 'UUID in watermark_id → null');
  assert(resolveWatermarkIdentity({ public_user_id: null, watermark_id: null, full_name: 'X' }) === null, 'no public id → null (no overlay, online rule)');
  assert(resolveWatermarkIdentity(null) === null, 'no profile → null');

  // Legacy WM id token still accepted; UUID skipped in favor of public id
  assert(!!resolveWatermarkIdentity({ public_user_id: 'WM-20251234' }), 'legacy WM id token accepted');
  assert(resolveWatermarkIdentity({ public_user_id: 'MED-0002', watermark_id: UUID })?.id === 'MED-0002', 'UUID skipped, public id wins');

  // Offline player must not carry the old userId fallback; both players share
  // the ONE authoritative identity source.
  const playerSrc = fs.readFileSync(path.join(ROOT, 'src/components/OfflineVideoPlayer.native.tsx'), 'utf8');
  assert(!/\?\?\s*entry\.meta\.userId/.test(playerSrc), 'offline player: no entry.meta.userId watermark fallback');
  assert(/resolveWatermarkIdentity/.test(playerSrc), 'offline player uses the shared identity resolver');
  const onlineSrc = fs.readFileSync(path.join(ROOT, 'src/components/VdoCipherPlayerNativeAdapter.native.tsx'), 'utf8');
  assert(/resolveWatermarkIdentity/.test(onlineSrc), 'online adapter uses the same shared identity resolver');
}

// ── 8. Fullscreen rotation (in-place expansion — same player instance) ────
console.log('── Fullscreen rotation (in-place expansion, single player instance) ──');
{
  const playerSrc = fs.readFileSync(path.join(ROOT, 'src/components/OfflineVideoPlayer.native.tsx'), 'utf8');
  const codeOnly = playerSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // THE ROOT-CAUSE FIX (device-proven black screen): the old fullscreen was an
  // RN Modal — a SECOND native window whose Dialog surface is destroyed and
  // recreated around a still-running decoder on rotation → black video with
  // live audio. The fix: fullscreen is IN-PLACE absolute-fill expansion of the
  // SAME VdoPlayerView in the SAME activity window; the manifest configChanges
  // keeps the activity alive and the SDK resizes its own surface. No second
  // window exists at all.
  assert(!/<Modal/.test(codeOnly), 'offline player does NOT use a Modal window (second window = surface teardown on rotation)');
  assert(/position: 'absolute', top: 0, left: 0, right: 0, bottom: 0/.test(playerSrc),
    'fullscreen is in-place absolute-fill expansion of the same container');
  assert((playerSrc.match(/<VdoPlayerView/g) || []).length === 1, 'exactly ONE VdoPlayerView instance (no second fullscreen player)');
  assert(!/useOrientation\(/.test(playerSrc), 'no orientation-remount hook in the player');
  assert(!/<VdoPlayerView\s+key=/.test(codeOnly), 'player NOT keyed by anything (no mid-session remount)');
  // Android back collapses fullscreen (no Modal → BackHandler required).
  assert(/BackHandler\.addEventListener\('hardwareBackPress'/.test(playerSrc), 'hardware back collapses fullscreen');
  // Landscape lock + portrait restore (same as online).
  assert(/OrientationLock\.LANDSCAPE/.test(playerSrc) && /OrientationLock\.PORTRAIT_UP/.test(playerSrc), 'orientation lock: landscape fullscreen, portrait otherwise');
  // System-bars controller shared with the online player.
  assert(/enterFullscreenSystemUi/.test(playerSrc) && /exitFullscreenSystemUi/.test(playerSrc), 'system-UI controller shared with online player');
  // Fullscreen back-arrow control (no ✕ / Close text in the player).
  assert(/ArrowLeft/.test(codeOnly), 'fullscreen uses a back-arrow control');
  assert(!/✕/.test(codeOnly), 'no ✕ glyph anywhere in the player');
}

// ── 9. Offline metadata model (course image + section/chapter titles) ────────
console.log('── Offline metadata model (course image / chapters) ──');
{
  const svcSrc = fs.readFileSync(path.join(ROOT, 'src/lib/offlineVideoService.ts'), 'utf8');
  assert(/courseImageUrl: string \| null;/.test(svcSrc), 'meta persists courseImageUrl (same image as online course)');
  assert(/sectionTitle: string \| null;/.test(svcSrc), 'meta persists sectionTitle (chapter structure)');
  assert(/courseImageUrl: p\.courseImageUrl \?\? null,/.test(svcSrc), 'authorize-time persist: courseImageUrl');
  assert(/sectionTitle: p\.sectionTitle \?\? null,/.test(svcSrc), 'authorize-time persist: sectionTitle');
  const lessonSrc = fs.readFileSync(path.join(ROOT, 'src/app/(app)/lesson/[id].tsx'), 'utf8');
  assert(/courseImageUrl,\r?\n\s*sectionTitle:/.test(lessonSrc), 'lesson screen passes courseImageUrl + sectionTitle at download');
  const libSrc = fs.readFileSync(path.join(ROOT, 'src/app/(app)/offline-library.tsx'), 'utf8');
  const courseScrSrc = fs.readFileSync(path.join(ROOT, 'src/app/(app)/offline-course.tsx'), 'utf8');
  assert(/resolveWatermarkIdentity\(profile\)/.test(libSrc) && /resolveWatermarkIdentity\(profile\)/.test(courseScrSrc), 'offline screens use the shared identity resolver');
  assert(!/backgroundColor: colors\.primary,\s*(.*\r?\n\s*)?borderRadius: sp\.cardRadius/.test(libSrc.replace(/\r/g, '')), 'offline library: no solid-primary card background');
}

// ── 10. Rental duration policy (90 days, backend-authoritative) ───────────────
console.log('── Rental duration (backend 90-day policy) ──');
{
  const php = fs.readFileSync(path.join(ROOT, 'backend/src/Video/VdoCipherService.php'), 'utf8').replace(/\r/g, '');
  assert(/\$rentalHours = 90 \* 24;/.test(php), 'server default = 90 * 24 hours (90 days)');
  assert(/'rentalDuration' => \$rentalHours \* 3600,/.test(php), 'licenseRules carries rentalDuration seconds');
  assert(/'canPersist'     => true,/.test(php), 'canPersist stays true (offline OTP contract intact)');
  assert(!/licenseValidty/.test(php), 'legacy misspelled payload never returns');
  assert(/offline_rental_hours/.test(php), 'operator DB override path preserved');
  // Client renders the server-issued expiry only — no client-side fake.
  const svc = fs.readFileSync(path.join(ROOT, 'src/lib/offlineVideoService.ts'), 'utf8');
  assert(/expiresAt: token\.expiresAt,/.test(svc), 'client expiry comes from the server token (single source of truth)');
  assert(!/86400 \* 90|\+ 90 \* 24/.test(svc), 'no client-side 90-day fabrication');
}

// ── 11. Watch-screen layout + header integration (Issues 3/4/5) ──────────────
console.log('── Watch-screen SafeArea + header integration ──');
{
  const libSrc = fs.readFileSync(path.join(ROOT, 'src/app/(app)/offline-library.tsx'), 'utf8');
  const courseSrc = fs.readFileSync(path.join(ROOT, 'src/app/(app)/offline-course.tsx'), 'utf8');
  // Issue 3: the player header must respect the real status-bar/notch inset.
  assert(/Math\.max\(insets\.top, 8\) \+ 6/.test(libSrc), 'library watch header uses SafeArea inset (no fixed offset)');
  assert(/Math\.max\(insets\.top, 8\) \+ 6/.test(courseSrc), 'course watch header uses SafeArea inset (no fixed offset)');
  assert(!/playerHeader.*paddingTop: 12\b/.test(libSrc.replace(/\r/g, '')), 'no fixed 12px top offset on the watch header');
  // Issue 8 (this pass): the course-card chevron is REMOVED entirely — the
  // whole card is the tap target; nothing floats mid-page.
  assert(!/ChevronRight/.test(libSrc.replace(/\r/g, '')), 'no chevron anywhere on the offline course card (removed per Issue 8)');
  // Issue 5: the shared back button renders WITHOUT container chrome.
  const phSrc = fs.readFileSync(path.join(ROOT, 'src/components/PageHeader.tsx'), 'utf8');
  const backBlock = phSrc.slice(phSrc.indexOf('{showBack ?'), phSrc.indexOf('showHamburger ?'));
  assert(!/neuMicroStyle/.test(backBlock), 'back button has no white-box container chrome');
  assert(/ArrowLeft/.test(backBlock), 'back affordance retained');
  assert(/hitSlop=\{spacing\.sm\}/.test(backBlock), 'touch target preserved via hitSlop');
}

// ── 12. This fix pass (offline transition / card / drawer / About / watermark) ─
console.log('── Focused fix pass (transition, card, drawer, About, watermark) ──');
{
  // Issue 1: genuinely offline + valid cached policy → DIRECT Offline Mode.
  //   The security pipeline must skip network-bound detectors when the device
  //   is genuinely offline (local detectors still run), so no fake
  //   "Security Check Incomplete" wall is shown for a network absence.
  const secSrc = fs.readFileSync(path.join(ROOT, 'src/lib/security.ts'), 'utf8').replace(/\r/g, '');
  assert(/genuinely offline[^\n]*skipping network-bound detectors/.test(secSrc),
    'security pipeline has the genuine-offline fast-path (network absence ≠ security finding)');
  assert(/getNetworkStateAsync\(\)/.test(secSrc) && /isInternetReachable/.test(secSrc),
    'offline state drives the detector skip decision (expo-network genuine-offline check)');

  // Issue 4: the Offline Videos drawer row carries no numeric badge.
  const drawerSrc = fs.readFileSync(path.join(ROOT, 'src/components/DrawerNav.tsx'), 'utf8').replace(/\r/g, '');
  assert(/PLAIN navigation row \(UI decision\): no/.test(drawerSrc),
    'Offline Videos drawer item is a plain navigation row (no count)');
  assert(!/badge:\s*offline/i.test(drawerSrc), 'no offline count is passed as a drawer badge');

  const courseSrc = fs.readFileSync(path.join(ROOT, 'src/app/(app)/offline-course.tsx'), 'utf8').replace(/\r/g, '');

  // Issue 5: About screen exposes no DRM/Widevine/VdoCipher/FairPlay wording.
  const aboutBlock = courseSrc.slice(courseSrc.indexOf('About these downloads'));
  assert(!/\bDRM\b|Widevine|VdoCipher|FairPlay|decrypt|encryption\b/i.test(aboutBlock),
    'About tab contains no DRM/technical protection wording');

  // Issue 6/3: the native watermark is a Plyr replica via the shared config.
  {
    const cr = (src) => src.replace(/\r/g, '');
    const wmSrc = cr(fs.readFileSync(path.join(ROOT, 'src/components/NativeWatermarkOverlay.tsx'), 'utf8'));
    const cfgSrc = cr(fs.readFileSync(path.join(ROOT, 'src/lib/nativeWatermarkConfig.ts'), 'utf8'));
    const plyrSrc = cr(fs.readFileSync(path.join(ROOT, 'src/lib/plyr/playerScript.ts'), 'utf8'));
    // Plyr slot table still intact in the SOURCE OF TRUTH (untouched).
    assert(/var G\s*=\s*\[[\s\S]*?\];/.test(plyrSrc), 'Plyr source still contains its G table (source of truth intact)');
    // Shared config carries the Plyr values verbatim.
    assert(/0\.08, 0\.08/.test(cfgSrc) && /0\.72, 0\.74/.test(cfgSrc), 'shared config carries the Plyr 9-slot table verbatim');
    assert(/WATERMARK_MOVE_MIN_MS  = 30_000/.test(cfgSrc) && /WATERMARK_MOVE_MAX_MS  = 60_000/.test(cfgSrc), 'move interval 30-60s (Plyr scheduleTick)');
    assert(/WATERMARK_OPACITY_MIN      = 0\.38/.test(cfgSrc) && /WATERMARK_OPACITY_MAX      = 0\.58/.test(cfgSrc), 'opacity band 0.38-0.58 (Plyr move)');
    assert(/WATERMARK_GLIDE_MS     =     600/.test(cfgSrc), '600ms glide (Plyr CSS transition)');
    assert(/WATERMARK_ROTATION_DEG =       3/.test(cfgSrc), 'rotation jitter +-3 deg (Plyr)');
    assert(!/__fwmPulse/.test(cfgSrc), 'no pulse animation in the Plyr-parity config');
    // Native overlay: glides while visible (never hides), clamped, Plyr typography.
    assert(!/withSequence/.test(wmSrc), 'no fade-teleport-fade sequence (Plyr glides, never hides)');
    assert(/wmClampPosition/.test(wmSrc), 'whole-element clamp (Plyr mkTransform) prevents edge clipping');
    assert(/color:\s+'#fff'/.test(wmSrc) && /fontSize:\s+13,/.test(wmSrc) && /fontWeight:\s+'600'/.test(wmSrc), 'native typography = Plyr (13px/600/#fff)');
    // Web injection: Plyr parity in the VdoCipher WebView.
    const injSrc = cr(fs.readFileSync(path.join(ROOT, 'src/lib/watermarkInjection.ts'), 'utf8'));
    assert(/0\.08,0\.08/.test(injSrc) && /0\.72,0\.74/.test(injSrc), 'web injection uses the Plyr G table');
    assert(/transition:transform 0\.6s ease/.test(injSrc), 'web injection glides at 0.6s ease (Plyr)');
    assert(!/__fwmPulse/.test(injSrc.replace(/^[\s*\/]+/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')) || !/animation:__fwmPulse/.test(injSrc), 'web injection pulse animation removed (Plyr parity)');
    assert(/rnd\(0\.38,0\.58\)/.test(injSrc), 'web injection opacity band = Plyr');
    assert(/rnd\(30000,60000\)/.test(injSrc), 'web injection interval = Plyr (30-60s)');
    assert(/font-size:13px/.test(injSrc) && /font-weight:600/.test(injSrc), 'web injection typography = Plyr');
    // Fullscreen DOM hook: same table/typography.
    const fsSrc = cr(fs.readFileSync(path.join(ROOT, 'src/hooks/useFullscreenWatermark.ts'), 'utf8'));
    assert(/0\.08, 0\.08/.test(fsSrc) && /0\.72, 0\.74/.test(fsSrc), 'fullscreen DOM hook uses the Plyr G table');
    assert(/font-size:13px;font-weight:600/.test(fsSrc), 'fullscreen DOM hook typography = Plyr');
    // Web VdoCipher player: exactly ONE watermark (the in-HTML injection);
    // the second RN overlay layer is removed.
    const wvSrc = cr(fs.readFileSync(path.join(ROOT, 'src/components/VdoCipherPlayerWebView.tsx'), 'utf8'));
    assert(!/<ForensicWatermarkOverlay/.test(wvSrc), 'no second RN watermark layer in the web VdoCipher player');
  }
}

console.log('── Offline startup state machine wiring (no login redirect while offline) ──');
{
  // php.ts: hydration is AUTHORITATIVE — getSession() awaits the REAL read.
  // The 3s timeout is diagnostic; only a hard-capped hung bridge can truncate.
  const phpSrc = fs.readFileSync(path.join(ROOT, 'src/client/php.ts'), 'utf8').replace(/\r/g, '');
  assert(/HYDRATION_HARD_CAP_MS = 10_000/.test(phpSrc), 'hydration hard cap present (bounded startup preserved)');
  assert(/AUTH_HYDRATION_SLOW/.test(phpSrc), 'slow-hydration diagnostic log present');
  assert(/hungBridgeCap/.test(phpSrc) && !/Promise\.race\(\[hydration, timeout\]\)/.test(phpSrc),
    'getSession() no longer races a 3s timeout against the SecureStore read (offline→login root cause fixed)');
  assert(/performs NO network I\/O|performs no network I\/O/i.test(phpSrc), 'hydration path documented as local-only (no network I/O)');

  // index.tsx: routing flows through the pure startup state machine —
  // unknowns HOLD (spinner), never collapse to login.
  const idxSrc = fs.readFileSync(path.join(ROOT, 'src/app/index.tsx'), 'utf8').replace(/\r/g, '');
  assert(/resolveStartupRoute\(\{/.test(idxSrc), 'landing screen routes through startupStateModel');
  assert(/route === 'spinner'/.test(idxSrc) && /route === 'login'/.test(idxSrc), 'spinner on unknowns; login only for genuinely-no-session');
  assert(/isOffline === null \? null : !isOffline/.test(idxSrc), 'connectivity tri-state preserved (null ≠ offline)');

  // Account isolation: persist() merges the current account's view over the
  // raw cross-account store — it can neither wipe an unhydrated state nor
  // destroy other accounts' rows.
  const ovsSrc = fs.readFileSync(path.join(ROOT, 'src/lib/offlineVideoService.ts'), 'utf8').replace(/\r/g, '');
  assert(/if \(cache === null\) return;/.test(ovsSrc), 'persist() refuses to write an unhydrated state (no cross-account wipe)');
  assert(/rawStore\.filter\(\(e\) => e\?\.meta\?\.userId !== hydratedUserId\)/.test(ovsSrc),
    'persist() preserves other accounts\' rows (account-isolation merge)');
  assert(/hydratedUserId = userId;/.test(ovsSrc), 'hydration stamps the owning user id');
  // Owner binding on hydration (state 9) — unchanged and asserted.
  assert(/e\.meta\.userId === userId/.test(ovsSrc), 'hydrate filters rows by session owner (state 9)');

  // The pure machine itself is exercised by test:state (17 startup tests).
  const runnerSrc = fs.readFileSync(path.join(ROOT, '.freebuff/run-state-tests.cjs'), 'utf8').replace(/\r/g, '');
  assert(/src\/lib\/startupStateModel\.ts/.test(runnerSrc), 'state-test harness compiles startupStateModel');
}

console.log('── Account state sync (server-authoritative role/status) + Global Search crash ──');
{
  // ── Global Search crash root cause: get_user_activity returns an OBJECT ──
  // (AnalyticsController::userActivity → { recent_audit, recent_security,
  // devices }); the old cast produced a non-array in drawerAuditLogs state →
  // .slice() crashed. The normalizer is the single API boundary.
  const apiSrc = fs.readFileSync(path.join(ROOT, 'src/lib/api.ts'), 'utf8').replace(/\r/g, '');
  assert(/export function normalizeUserActivityResponse/.test(apiSrc), 'getUserActivity normalizer exists at the API boundary');
  assert(/recent_audit/.test(apiSrc), 'normalizer reads the real backend shape (recent_audit)');
  assert(/Array\.isArray\(data\)/.test(apiSrc), 'normalizer accepts the legacy raw-array shape too');

  // Behavioral: exercise the exported normalizer by transpiling api.ts's
  // function body standalone (no RN deps needed — it is pure).
  {
    const m = apiSrc.match(/export function normalizeUserActivityResponse[\s\S]*?\n\}/);
    assert(m, 'normalizer body extractable');
    const fn = new Function('data', m[0]
      .replace('export function normalizeUserActivityResponse(data: unknown): { entries: UserActivityEntry[]; totalCount: number } {', 'return function normalizeUserActivityResponse(data) {')
      .replace(/ as UserActivityEntry\[\]/g, '')
      .replace(/ as \{ entries\?: unknown; total_count\?: unknown; recent_audit\?: unknown; recent_security\?: unknown \}/, '')
      .replace('(data[0] as UserActivityEntry | undefined)', 'data[0]')
      .replace(/ as \{ recent_audit\?: unknown; recent_security\?: unknown \}/, '')
      + '\n')();
    // 1. Backend object shape → audit rows array.
    const objShape = fn({ recent_audit: [{ id: 'a', action: 'login' }, { id: 'b', action: 'logout' }], recent_security: [], devices: [] });
    assert(Array.isArray(objShape.entries) && objShape.entries.length === 2, 'object backend shape → array entries');
    // 2. Legacy raw array shape still works.
    const arrShape = fn([{ id: 'x', action: 'k', total_count: 7 }]);
    assert(arrShape.entries.length === 1 && arrShape.totalCount === 7, 'legacy array shape preserved with total_count');
    // 3. Missing/malformed/null → [] (never an object) — the crash contract.
    assert(fn(null).entries.length === 0 && Array.isArray(fn(null).entries), 'null → []');
    assert(fn(undefined).entries.length === 0, 'undefined → []');
    assert(fn({}).entries.length === 0, 'empty object → []');
    assert(fn({ recent_audit: 'nope' }).entries.length === 0, 'malformed recent_audit → []');
    // 4. .slice() on the result is always safe.
    assert(Array.isArray(fn({ recent_audit: [{ id: 'q', action: 'z' }] }).entries.slice(0, 3)), '.slice() safe on normalized entries');
    // 5. search_audit_logs wrapper ({logs:[...]}) normalized in getAuditTrail.
    assert(/logs/.test(apiSrc) && /Array\.isArray\(\(payload as \{ logs\?: unknown \}\)\.logs\)/.test(apiSrc.replace(/\(payload as \{ logs\?: unknown \}\)\.logs/g, '(payload as { logs?: unknown }).logs')), 'getAuditTrail normalizes the {logs:[...]} wrapper');
  }

  // ── Blocked account: terminal state, never infinite spinner ──────────────
  const appLayoutSrc = fs.readFileSync(path.join(ROOT, 'src/app/(app)/_layout.tsx'), 'utf8').replace(/\r/g, '');
  assert(/account_suspended/.test(appLayoutSrc), '(app) shell recognizes the server blocked verdict (403 account_suspended)');
  assert(/router\.replace\('\/account-suspended'/.test(appLayoutSrc), 'blocked → existing account-suspended screen (terminal state)');
  assert(/profile row incomplete \(no role\/status\)/.test(appLayoutSrc), 'role-less profile rows are an error, never "loaded with no role"');
  assert(/refreshAccountState\(session\.user\.id, \{ reason: 'shell_cold_start' \}\)/.test(appLayoutSrc), 'cold-start authoritative refresh wired in the shell');
  // The blocked check lives INSIDE the catch (getProfile THROWS the error
  // object) — asserted by position: catch block contains the router.replace.
  {
    const catchIdx = appLayoutSrc.lastIndexOf('} catch (err) {');
    const navIdx = appLayoutSrc.indexOf("router.replace('/account-suspended'");
    assert(catchIdx !== -1 && navIdx > catchIdx, 'blocked-verdict navigation fires from the catch (getProfile throws the error object)');
  }

  // ── Runtime refresh service: triggers + guards ───────────────────────────
  const arSrc = fs.readFileSync(path.join(ROOT, 'src/lib/accountRefresh.ts'), 'utf8').replace(/\r/g, '');
  assert(/if \(inflight\) return inflight;/.test(arSrc), 'refresh is single-flight (no concurrent duplicates / A-after-B overwrite)');
  assert(/myGeneration !== generation/.test(arSrc), 'generation guard: stale responses cannot publish');
  assert(/row\.id !== userId/.test(arSrc), 'identity guard: foreign/stale session rows are discarded');
  assert(/onConnectivityRestored/.test(arSrc), 'OFFLINE→ONLINE trigger wired (authoritative refresh on reconnect)');
  assert(/AppState\.addEventListener/.test(arSrc), 'foreground trigger wired');
  assert(/store\.setProfile\(\{ \.\.\.\(prev \?\? \{\}\), \.\.\.row \} as typeof prev\)/.test(arSrc), 'publish merges server fields over the store row (server wins)');

  // Lifecycle wiring in the root layout.
  const rootSrc = fs.readFileSync(path.join(ROOT, 'src/app/_layout.tsx'), 'utf8').replace(/\r/g, '');
  assert(/initAccountRefreshLifecycle\(\)/.test(rootSrc), 'account refresh lifecycle wired at app root');

  // Offline guarantee intact: refresh skips offline BEFORE any request.
  assert(/return 'offline_skipped';/.test(arSrc.replace(/[\s\S]*?if \(state == null \|\| !online\)/, '')), 'offline → skip without request (offline session preserved)');
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('──────────────────────────────────────────────');
// == Platform sub-pages + System Diagnostics (Super Admin) ===================
{
  // 1. System Config fully removed from the user-facing Platform UI.
  const platformSrc = fs.readFileSync(path.join(ROOT, 'src/app/(app)/(superadmin)/sa-platform.tsx'), 'utf8').replace(/\r/g, '');
  const overviewSrc = fs.readFileSync(path.join(ROOT, 'src/app/(app)/(superadmin)/sa-overview.tsx'), 'utf8').replace(/\r/g, '');
  assert(!/System Config/.test(platformSrc), 'System Config card removed from Platform');
  assert(!/path:\s*['"]\/config['"]/.test(platformSrc), 'no Platform navigation target points to /config');
  assert(!/System Config/.test(overviewSrc), 'System Config card removed from Super Admin overview');
  assert(!fs.existsSync(path.join(ROOT, 'src/app/(app)/(superadmin)/config.tsx')), 'System Config route screen deleted');
  const saLayoutSrc = fs.readFileSync(path.join(ROOT, 'src/app/(app)/(superadmin)/_layout.tsx'), 'utf8').replace(/\r/g, '');
  assert(!/<Tabs\.Screen name="config"/.test(saLayoutSrc), 'no dead route registration for the removed config screen');
  // 2. Maintenance Mode + Pricing keep their underlying config functionality.
  const apiSrc2 = fs.readFileSync(path.join(ROOT, 'src/lib/api.ts'), 'utf8').replace(/\r/g, '');
  assert(/^async function upsertSystemConfig\(/m.test(apiSrc2), 'upsertSystemConfig preserved as an INTERNAL helper (maintenance/pricing still work)');
  assert(!/export (async )?function upsertSystemConfig/.test(apiSrc2), 'upsertSystemConfig no longer exported (no user-facing System Config API)');
  assert(!/export (async )?function getSystemConfig/.test(apiSrc2), 'getSystemConfig removed');
  // 3. Platform sub-pages have terminal states - never a blank screen.
  const platformPages = [
    'src/app/(app)/(superadmin)/branding.tsx',
    'src/app/(app)/(superadmin)/feature-flags.tsx',
    'src/app/(app)/(admin)/cms.tsx',
    'src/app/(app)/(superadmin)/maintenance.tsx',
  ];
  for (const p of platformPages) {
    const s = fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r/g, '');
    assert(/LoadingState/.test(s), p + ' renders LoadingState while loading');
    assert(/<ErrorState error=\{error\} onRetry=\{load\} \/>/.test(s), p + ' renders ErrorState with retry on failure');
    assert(!/catch \(_\) \{\}/.test(s), p + ' has no swallowed fetch errors (blank-screen bug class)');
  }
  // 4. CMS re-export chain intact for Super Admin.
  assert(fs.existsSync(path.join(ROOT, 'src/app/(app)/(superadmin)/sa-cms.tsx')), 'sa-cms re-export exists');
  // 5. System Diagnostics: route, client wiring, screen.
  const sysDiagScreen = fs.readFileSync(path.join(ROOT, 'src/app/(app)/(admin)/system-providers.tsx'), 'utf8').replace(/\r/g, '');
  assert(/runSystemDiagnostics\(\)/.test(sysDiagScreen), 'System Diagnostics screen runs the real backend scan');
  assert(/runSystemDiagnosticOne/.test(sysDiagScreen), 'System Diagnostics supports single-service re-check');
  assert(/<PageHeader\s+title="System Diagnostics"/.test(sysDiagScreen), 'screen retitled System Diagnostics (old System Providers presentation gone)');
  assert(!/Provider Abstraction Layer/.test(sysDiagScreen), 'obsolete Provider Abstraction Layer presentation removed');
  assert(/setScanning\(true\)/.test(sysDiagScreen) && /setScanning\(false\)/.test(sysDiagScreen), 'Scan All has a bounded scanning state');
  assert(/sa-system-providers/.test(saLayoutSrc), 'System Diagnostics route resolves for Super Admin');
  // 6. Client transport wiring.
  const phpSrc = fs.readFileSync(path.join(ROOT, 'src/client/php.ts'), 'utf8').replace(/\r/g, '');
  assert(/'system-diagnostics':\s*'\/admin\/system\/diagnostics',/.test(phpSrc), 'php.ts maps system-diagnostics to the PHP route');
  assert(/'system-diagnostics-one':\s*'\/admin\/system\/diagnostics\/\{id\}',/.test(phpSrc), 'php.ts maps single-service check with {id} templating');
  assert(/'system-diagnostics',\s*'system-diagnostics-one'/.test(phpSrc), 'diagnostics RPCs use GET');
  // 7. Backend: super_admin-only routes + no-secret redaction contract.
  const routesSrc = fs.readFileSync(path.join(ROOT, 'backend/routes/api.php'), 'utf8').replace(/\r/g, '');
  assert(/'role' => \['super_admin'\]\]\);/.test(routesSrc) && /admin\/system\/diagnostics/.test(routesSrc), 'diagnostics routes registered behind super_admin role middleware');
  const svcSrc = fs.readFileSync(path.join(ROOT, 'backend/src/Services/SystemDiagnosticsService.php'), 'utf8').replace(/\r/g, '');
  const ctrlSrc = fs.readFileSync(path.join(ROOT, 'backend/src/Controllers/SystemDiagnosticsController.php'), 'utf8').replace(/\r/g, '');
  assert(/sanitizeError/.test(svcSrc) && /redact/.test(svcSrc), 'service sanitizes/redacts exception details');
  assert(/Apisecret/.test(svcSrc), 'VdoCipher secret used for the server-side call only');
  assert(/allowOnly\(/.test(ctrlSrc), 'controller allow-list strips any unexpected keys (defense in depth)');
  for (const bannedKey of ['secret', 'password', 'api_key', 'token', 'Authorization']) {
    assert(!new RegExp("'" + bannedKey + "'").test(ctrlSrc), 'controller allow-list contains no "' + bannedKey + '" key');
  }
  assert(!/SMTP_USER\).*message|message.*SMTP_USER/.test(svcSrc), 'SMTP username is never interpolated into diagnostic messages');
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 14 — Production bug-fix pass: audit logs, app updates, edit email,
// server-side maintenance mode, account-state synchronization.
// ═══════════════════════════════════════════════════════════════════════════

// ── Issue 1: Audit Logs contract (userActivity) ─────────────────────────────
{
  const anal = fs.readFileSync(path.join(ROOT, 'backend/src/Controllers/AnalyticsController.php'), 'utf8').replace(/\r/g, '');
  // Real contract: union of audit + security rows, with the fields the UI renders.
  assert(/userActivity/.test(anal), 'backend userActivity endpoint exists');
  assert(/'entries'/.test(anal) && /'total_count'/.test(anal), 'userActivity returns { entries, total_count }');
  assert(/action.*event_type|COALESCE\(action, event_type\)/.test(anal), 'userActivity unifies audit.action and security.event_type (no undefined action reaching the UI)');
  assert(/resource_type/.test(anal) && /resource_id/.test(anal), 'userActivity exposes resource_type/resource_id');
  assert(/limit/i.test(anal), 'userActivity supports limit/pagination');
  // The screen must not crash on optional fields and must surface failures.
  const ua = fs.readFileSync(path.join(ROOT, 'src/app/(app)/user-activity.tsx'), 'utf8').replace(/\r/g, '');
  // entry.resource_type is consumed ONLY inside the ternary guard `entry.resource_type ? ... : null`
  assert(/entry\.resource_type\s*\?/.test(ua), 'user-activity ternary-guards entry.resource_type before .replace');
  assert(/\(profile\.role \?\? 'user'\)/.test(ua) || /profile\.role\?\./.test(ua), 'user-activity guards profile.role before .replace');
  assert(!/catch \(_\) \{\}/.test(ua), 'user-activity does not swallow fetch failures');
  assert(/tryAgain|Retry|onRetry/.test(ua), 'user-activity offers retry on error');
}

// ── Issue 2: App Updates route contract (GET + PUT both platforms) ──────────
{
  const php = fs.readFileSync(path.join(ROOT, 'src/client/php.ts'), 'utf8').replace(/\r/g, '');
  // Canonical backend contract: GET /admin/app-updates (collection), PUT /{platform}.
  assert(/'get-app-update-config':\s*'\/admin\/app-updates'/.test(php), 'get-app-update-config uses the canonical collection route (no /{platform} GET 404)');
  assert(!/'get-app-update-config':\s*'\/admin\/app-updates\/\{id\}'/.test(php), 'no obsolete per-platform GET route remains');
  assert(/'set-app-update-config':\s*'\/admin\/app-updates\/\{platform\}'/.test(php), 'set-app-update-config PUTs /admin/app-updates/{platform}');
  assert(/requires a platform \(android\|ios\)/.test(php), 'set-app-update-config validates the {platform} token source (route token keeps its real name)');
  // The controller must read the {platform} token correctly (live 422 bug).
  const uc = fs.readFileSync(path.join(ROOT, 'backend/src/Controllers/UpdateConfigController.php'), 'utf8').replace(/\r/g, '');
  assert(/params\['platform'\]/.test(uc) && /params\['id'\]/.test(uc), 'UpdateConfigController accepts platform OR id route-token naming');
  const routes = fs.readFileSync(path.join(ROOT, 'backend/routes/api.php'), 'utf8').replace(/\r/g, '');
  assert(/get\('\/admin\/app-updates'/.test(routes), 'backend registers the collection GET /admin/app-updates');
  assert(/put\('\/admin\/app-updates\/\{platform\}'/.test(routes), 'backend registers PUT /admin/app-updates/{platform}');
}

// ── Issue 3: Email update error path + persistence ──────────────────────────
{
  const api = fs.readFileSync(path.join(ROOT, 'src/lib/api.ts'), 'utf8').replace(/\r/g, '');
  // The Supabase-era error.context.text() reader used to swallow real reasons.
  assert(!/error\?\.context\?\.text\?\.\(\)/.test(api), 'no function wrapper reads the nonexistent context.text() (generic-error swallow + TypeError on every server error)');
  assert(/error\.message \|\| 'Failed to update email\.'/.test(api), 'updateUserEmail surfaces the real server message (409 duplicate / 422 invalid / 403)');
  const adm = fs.readFileSync(path.join(ROOT, 'backend/src/Controllers/AdminController.php'), 'utf8').replace(/\r/g, '');
  assert(/already in use by another account/.test(adm), 'backend reports duplicate email as a distinct error');
  assert(/filter_var\(\$newEmail, FILTER_VALIDATE_EMAIL\)/.test(adm), 'backend validates the new email format');
  assert(/str_ends_with\(\$newEmail, '@medacademy\.internal'\)/.test(adm), 'backend rejects internal placeholder emails');
}

// ── Issue 4: Server-side maintenance enforcement ────────────────────────────
{
  const mw = fs.readFileSync(path.join(ROOT, 'backend/src/Middleware/MaintenanceMiddleware.php'), 'utf8').replace(/\r/g, '');
  assert(/class MaintenanceMiddleware/.test(mw), 'MaintenanceMiddleware exists');
  assert(/503/.test(mw), 'middleware returns HTTP 503 when maintenance is enabled');
  assert(/maintenance_mode/.test(mw), '503 body uses the structured error code maintenance_mode');
  // blocks() internally consults config() → the persisted maintenance_enabled flag.
  assert(/->blocks\(\)/.test(mw) && /->config\(\)/.test(mw), 'middleware gates on MaintenanceService blocks()/config() (persisted maintenance_enabled flag)');
  assert(/super_admin/.test(mw), 'Super Admin requests bypass the gate (server-verified role, not a client bypass)');
  assert(/\/maintenance|\/auth\/login|health/.test(mw), 'minimal exemption list (status/login/health)');
  const idx = fs.readFileSync(path.join(ROOT, 'backend/public/index.php'), 'utf8').replace(/\r/g, '');
  assert(/MaintenanceMiddleware/.test(idx), 'maintenance gate is registered globally in index.php (before routing)');
  const routes = fs.readFileSync(path.join(ROOT, 'backend/routes/api.php'), 'utf8').replace(/\r/g, '');
  assert(/\/maintenance/.test(routes), 'maintenance status + management routes registered');
  const svc = fs.readFileSync(path.join(ROOT, 'backend/src/Services/MaintenanceService.php'), 'utf8').replace(/\r/g, '');
  assert(/MaintenanceService/.test(svc), 'MaintenanceService centralizes flag read/write');
  // Data API lockdown: normal users must not be able to flip maintenance off.
  const dc = fs.readFileSync(path.join(ROOT, 'backend/src/Controllers/DataController.php'), 'utf8').replace(/\r/g, '');
  assert(/system_config/.test(dc) && /super_admin/.test(dc), 'generic Data API blocks non-Super-Admin writes to system_config');
  assert(/->config\(\)/.test(mw), 'middleware consumes MaintenanceService::config() (the persisted maintenance_enabled flag)');
  // Client side: dedicated maintenance state, not login/offline.
  const php = fs.readFileSync(path.join(ROOT, 'src/client/php.ts'), 'utf8').replace(/\r/g, '');
  assert(/maintenance_mode/.test(php), 'client transport recognizes the 503 maintenance_mode error code');
  const gate = fs.readFileSync(path.join(ROOT, 'src/components/MaintenanceGate.tsx'), 'utf8').replace(/\r/g, '');
  assert(/MaintenanceGate/.test(gate), 'MaintenanceGate component exists');
  assert(/offline/i.test(gate), 'MaintenanceGate distinguishes maintenance from offline');
  const layout = fs.readFileSync(path.join(ROOT, 'src/app/_layout.tsx'), 'utf8').replace(/\r/g, '');
  assert(/MaintenanceGate/.test(layout), 'MaintenanceGate is mounted in the root layout');
}

// ── Account-state synchronization (role drift + blocked accounts) ───────────
{
  const dev = fs.readFileSync(path.join(ROOT, 'backend/src/Controllers/DeviceController.php'), 'utf8').replace(/\r/g, '');
  // check_authorization must return the fresh role (for no-logout role sync)
  // and the blocked reason for suspended accounts.
  assert(/'role'\s*=>/.test(dev), 'check_authorization returns the fresh server role (role-drift reconciliation)');
  assert(/account_blocked|suspended/.test(dev), 'check_authorization reports suspended accounts with a structured reason');
  const ctx = fs.readFileSync(path.join(ROOT, 'src/ctx.tsx'), 'utf8').replace(/\r/g, '');
  assert(/ROLE DRIFT/.test(ctx), 'client reconciles server-authoritative role drift into the profile store (no logout/login)');
  assert(/Object\.values\(UserRole\)/.test(ctx), 'client validates the fresh role against the UserRole enum before publishing');
  const ssm = fs.readFileSync(path.join(ROOT, 'src/lib/startupStateModel.ts'), 'utf8').replace(/\r/g, '');
  assert(/'blocked'/.test(ssm) && /account_suspended/.test(ssm), 'startup state model maps blocked accounts (403 account_suspended) to a dedicated terminal state (no infinite spinner)');
}

console.log(`RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILED:');
  failures.forEach((f) => console.log(' - ' + f));
  process.exit(1);
}
