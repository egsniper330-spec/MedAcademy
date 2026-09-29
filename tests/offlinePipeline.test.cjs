/**
 * VdoCipher OFFLINE pipeline guards — root-cause-fix regression pins.
 *
 * Run: node tests/offlinePipeline.test.cjs
 *
 * Pins the source-level contracts established during the renderer-error /
 * "Tracks Not Found" root-cause investigation, per the OFFICIAL docs:
 *   https://www.vdocipher.com/docs/mobile/react-native/offline/
 *   https://www.vdocipher.com/docs/mobile/android/error-codes/
 *   https://www.vdocipher.com/docs/server/playbackauth/offline/
 *
 * Sections:
 *  1. selectDownloadTracks edge cases (video-only Android response, iOS audio-less)
 *  2. classifyOfflineLoadError (6187 / 6102-class / 6120-class / CDM-class)
 *  3. Diagnostics: sanitized logging only (no otp/playbackInfo/token leakage)
 *  4. Offline OTP backend contract (licenseRules serialized string, canPersist,
 *     rental default 90 days, optional customPlayerId passthrough)
 *  5. Native-state reconciliation wiring (player refuses non-completed loads)
 *  6. Single-player-instance rules (no Modal twin in the offline player)
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

function extractPureSection(source, startMark, endMark) {
  const a = source.indexOf(startMark);
  const b = source.indexOf(endMark, a);
  if (a < 0 || b < 0) throw new Error('section markers not found: ' + startMark);
  return source.slice(a, b);
}

function compileModule(name, code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdotest-'));
  const out = path.join(dir, name + '.js');
  const src = path.join(dir, name + '.ts');
  fs.writeFileSync(src, code, 'utf8');
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    src, '--outDir', dir, '--module', 'commonjs', '--target', 'es2020',
    '--skipLibCheck', '--noEmitOnError', 'false',
  ], { stdio: 'pipe' });
  return require(out);
}

const svcSrc = fs.readFileSync(path.join(ROOT, 'src/lib/offlineVideoService.ts'), 'utf8').replace(/\r/g, '');

// ── 1. Track-selection edge cases ─────────────────────────────────────────────
console.log('── Track-selection edge cases (official enqueue contract) ──');
{
  const selSection = extractPureSection(svcSrc, 'export function selectDownloadTracks', '// ─── Pure helpers');
  const selectFor = (platform) => {
    const m = compileModule('sel-' + platform, `
      type Track = { id: number; type: string; language: string; bitrate: number; width: number; height: number; label: string };
      const Platform = { OS: ${JSON.stringify(platform)} };
      ${selSection}
    `);
    return m.selectDownloadTracks;
  };
  const selectAndroid = selectFor('android');
  const selectIos = selectFor('ios');

  // 1. valid video+audio (Android baseline — covered in offlineState too, re-pinned)
  const va = selectAndroid([
    { id: 1, type: 'video', bitrate: 1200 },
    { id: 2, type: 'audio', language: 'en' },
  ]);
  assert(va.selections.length === 2 && va.selections.includes(0) && va.selections.includes(1),
    'Android video+audio → exactly [video, audio]');

  // 2. no tracks → refuse enqueue (never invent)
  assert(selectAndroid([]).selections.length === 0, 'Android: zero tracks → zero selections');
  assert(selectIos([]).selections.length === 0, 'iOS: zero tracks → zero selections');

  // 3. video-only response on Android → NO audio selection invented
  const videoOnly = selectAndroid([{ id: 1, type: 'video', bitrate: 900 }]);
  assert(videoOnly.selections.length === 1 && videoOnly.selections[0] === 0,
    'Android video-only response → video selected, NO audio invented');

  // 3b. iOS audio-less response → video only (the official iOS rule)
  const iosAudioless = selectIos([
    { id: 1, type: 'video', bitrate: 3000 },
    { id: 2, type: 'audio', language: 'en' }, // iOS must ignore audio tracks entirely
  ]);
  assert(iosAudioless.selections.length === 1 && iosAudioless.selections[0] === 0,
    'iOS audio-less/video+audio response → video track ONLY (audio never selected on iOS)');

  // 3c. captions/unknown/combined tracks never selected
  const mixed = selectAndroid([
    { id: 1, type: 'captions' },
    { id: 2, type: 'unknown' },
    { id: 3, type: 'combined' },
    { id: 4, type: 'video', bitrate: 1500 },
    { id: 5, type: 'audio' },
  ]);
  assert(mixed.selections.length === 2 && mixed.selections.includes(3) && mixed.selections.includes(4),
    'captions/unknown/combined never selected; video+audio indices correct');
}

// ── 2. Error classification ───────────────────────────────────────────────────
console.log('── classifyOfflineLoadError (VdoCipher error-code table) ──');
{
  const clsSection = extractPureSection(svcSrc, 'export type OfflineLoadErrorKind', '// ─── Download orchestration');
  const m = compileModule('cls', clsSection);
  const cls = m.classifyOfflineLoadError;

  assert(cls(6187) === 'expired', '6187 → expired (DRM keys finished rental duration)');
  assert(cls(6102) === 'incomplete_media', '6102 → incomplete_media (play on non-completed download)');
  assert(cls(5160) === 'incomplete_media' && cls(5161) === 'incomplete_media', '5160/5161 → incomplete_media (offline source deleted)');
  assert(cls(6120) === 'renderer', '6120 → renderer (documented renderer error)');
  assert(cls(6122) === 'renderer' && cls(6101) === 'renderer', '6122/6101 → renderer (secure-decoder failures)');
  assert(cls(6157) === 'drm_state' && cls(6166) === 'drm_state' && cls(6196) === 'drm_state',
    '6157/6166/6196 → drm_state (Widevine CDM state errors)');
  assert(cls('6187') === 'expired', 'string code accepted ("6187")');
  assert(cls(null) === 'other' && cls(undefined) === 'other' && cls('abc') === 'other', 'null/undefined/non-numeric → other');
}

// ── 3. Diagnostics hygiene ────────────────────────────────────────────────────
console.log('── Sanitized diagnostics (no credential leakage) ──');
{
  const svcLogs = svcSrc.match(/console\.(info|log|warn)[^;]*/g) || [];
  const forbidden = /\b(otp|playbackInfo|apiSecret|api_secret|token)\b/i;
  // template placeholders like ${token.otp} must never appear in log lines
  const leaks = svcLogs.filter((l) => forbidden.test(l) && !/offline-?token/i.test(l));
  assert(leaks.length === 0, 'offlineVideoService logs never contain otp/playbackInfo/secret/token: ' + JSON.stringify(leaks).slice(0, 200));

  // The enqueue/options diagnostics exist and carry only safe fields
  assert(/\[offline-dl\] STAGE=native-getDownloadOptions OK mediaId=/.test(svcSrc), 'options-success diagnostic logs mediaId + track inventory (safe fields)');
  assert(/\[offline-dl\] enqueue mediaId=.*selections=/.test(svcSrc), 'enqueue diagnostic logs mediaId + selected indices');
  assert(/\[offline-dl\] STAGE=native-getDownloadOptions FAILED code=/.test(svcSrc), 'options-failure diagnostic logs sanitized code/msg (stage-tagged: iOS "Tracks Not Found" originates in the bridge, before JS)');

  const playerSrc = fs.readFileSync(path.join(ROOT, 'src/components/OfflineVideoPlayer.native.tsx'), 'utf8').replace(/\r/g, '');
  const playerLogs = playerSrc.match(/console\.(info|log|warn)[^;]*/g) || [];
  const pleaks = playerLogs.filter((l) => forbidden.test(l));
  assert(pleaks.length === 0, 'OfflineVideoPlayer logs never contain credentials');
  assert(/\[offline-play\] load error code=/.test(playerSrc), 'player diagnostic logs the exact native error code');
}

// ── 4. Offline OTP backend contract ───────────────────────────────────────────
console.log('── Offline OTP backend contract (official playbackauth/offline) ──');
{
  const php = fs.readFileSync(path.join(ROOT, 'backend/src/Video/VdoCipherService.php'), 'utf8').replace(/\r/g, '');
  const fn = php.slice(php.indexOf('public function offlineAuthorize'), php.indexOf('public function uploadInit'));

  // licenseRules must be a SERIALIZED JSON STRING (docs note: "the value of
  // licenseRules is a string with serialized JSON and not a JSON object")
  assert(/json_encode\(\s*\[\s*'canPersist'\s*=>\s*true/.test(fn), 'licenseRules = json_encode([canPersist => true, ...]) — serialized STRING per official docs');
  assert(/'rentalDuration'\s*=>\s*\$rentalHours\s*\*\s*3600/.test(fn), 'rentalDuration travels inside licenseRules (DRM-enforced, device-clock-proof)');
  assert(/\$rentalHours\s*=\s*90\s*\*\s*24/.test(fn), 'default rental = 90 days (policy intact)');
  assert(/offline_rental_hours/.test(fn), 'operator-configurable rental override preserved');
  assert(/'customPlayerId'\s*=>\s*Config::string\('VDO_CUSTOM_PLAYER_ID'\)/.test(fn), 'optional customPlayerId passthrough (VDO_CUSTOM_PLAYER_ID)');
  assert(!/Apisecret|api_secret/.test(fn), 'API secret never appears in the offline authorize flow output');

  // Route still wired
  const routes = fs.readFileSync(path.join(ROOT, 'backend/routes/api.php'), 'utf8');
  assert(/post\('\/video\/offline-authorize'/.test(routes), 'POST /video/offline-authorize route registered');

  // Client types the new optional field
  const api = fs.readFileSync(path.join(ROOT, 'src/lib/api.ts'), 'utf8');
  assert(/customPlayerId\?\:\s*string\s*\|\s*null/.test(api), 'getOfflineDownloadToken response types optional customPlayerId');
}

// ── 5. Native-state reconciliation ────────────────────────────────────────────
console.log('── Native-state reconciliation (authoritative completion) ──');
{
  assert(/export async function reconcileOfflineMediaState/.test(svcSrc), 'reconcileOfflineMediaState exported');
  const rec = svcSrc.slice(svcSrc.indexOf('export async function reconcileOfflineMediaState'), svcSrc.indexOf('export function mapNativeStatus'));
  assert(/VdoDownload\.query\(\{\s*mediaId:\s*\[mediaId\]/.test(rec), 'reconciliation queries the SDK registry for the exact mediaId (SDK is authority)');
  assert(/removeEntry\(mediaId\)/.test(rec), 'completed-locally but absent natively → row removed (media deleted outside the app)');
  assert(/mapNativeStatus\(native\.status/.test(rec), 'native non-completed status → local row reconciled (no false playable)');

  const playerSrc = fs.readFileSync(path.join(ROOT, 'src/components/OfflineVideoPlayer.native.tsx'), 'utf8');
  assert(/reconcileOfflineMediaState\(mediaId\)/.test(playerSrc), 'player runs the completion guard before mounting the DRM surface');
  assert(/verdict === 'not_completed'/.test(playerSrc), 'non-completed verdict → honest retry message, no doomed DRM load');
}

// ── 6. Single-player-instance rules ───────────────────────────────────────────
console.log('── Single VdoPlayerView instance (6120 prevention) ──');
{
  const playerSrc = fs.readFileSync(path.join(ROOT, 'src/components/OfflineVideoPlayer.native.tsx'), 'utf8');
  const count = (playerSrc.match(/<VdoPlayerView/g) || []).length;
  assert(count === 1, `OfflineVideoPlayer mounts exactly ONE VdoPlayerView (found ${count})`);
  assert(!/<Modal/.test(playerSrc), 'offline player has NO Modal twin player (in-place fullscreen only)');

  // No Media3 pin conflicts: expo-video and vdocipher-android must agree (1.8.0)
  const expoVideo = fs.readFileSync(path.join(ROOT, 'node_modules/expo-video/android/build.gradle'), 'utf8');
  const mv = expoVideo.match(/androidxMedia3Version\s*=\s*"([\d.]+)"/);
  assert(mv && mv[1] === '1.8.0', `expo-video pins Media3 ${mv ? mv[1] : '?'} (VdoCipher 1.29.9 POM requires 1.8.0)`);
}

console.log(`RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILED:');
  failures.forEach((f) => console.log(' - ' + f));
  process.exit(1);
}
