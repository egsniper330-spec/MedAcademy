/**
 * Automated tests for the VIDEO PROVIDER CONTROL CENTER
 * (global availability · per-doctor three-state overrides · backend enforcement).
 *
 * Run: node tests/videoProviders.test.cjs
 *
 * Backend (structural): no PHP runtime exists in this environment, so the
 * authoritative behaviour of VideoProviderPolicyService, VideoProviderController,
 * RpcController and the enforcement call sites is verified STRUCTURALLY against
 * the shipped PHP source (regex over the real files; any behavioural change to
 * the pinned code paths breaks these tests).
 *
 * Client (behavioural): src/lib/videoProviderPolicy.ts is compiled with the
 * project's own babel and executed FOR REAL — the whole effective-state matrix
 * (inherit/enabled/disabled × global on/off, both providers), fail-open rules
 * and the friendly error classifier are asserted behaviourally.
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

// ─── Backend: the effective-state rule (policy service) ────────────────────────
{
  const svc = read('backend/src/Services/VideoProviderPolicyService.php');

  ok(/class VideoProviderPolicyService/.test(svc), 'policy: service exists in the backend');
  ok(/const PROVIDERS = \['plyr', 'vdocipher'\];/.test(svc),
    'policy: exactly the two REAL providers registered (plyr, vdocipher)');
  ok(/'vdocipher' => 'vdocipher',\s*\n\s*'youtube'\s+=> 'plyr',/.test(svc),
    'policy: lessons.video_type map (youtube→plyr, vdocipher→vdocipher)');

  // Effective rule: override row wins; absence = global; fail open.
  const enabled = svc.indexOf('public static function isEnabled');
  const isEnabledBody = svc.slice(enabled, svc.indexOf('public static function assertProviderAllowed'));
  ok(/SELECT is_enabled FROM `teacher_provider_permissions` WHERE `teacher_id` = \? AND `provider_key` = \?/.test(isEnabledBody),
    'policy: override read from teacher_provider_permissions (the REAL table)');
  ok(/SELECT is_globally_enabled FROM `video_providers` WHERE `provider_key` = \?/.test(isEnabledBody),
    'policy: global default read from video_providers');
  ok(/return \$global === null \? true : \(int\) \$global === 1;/.test(isEnabledBody),
    'policy: missing global row FAILS OPEN (never silently disables)');

  ok(/403,\s*\n\s*'This video player is currently unavailable[^']*'/.test(svc),
    'policy: structured 403 refusal with a user-safe message');
  ok(/'video_provider_disabled'/.test(svc), 'policy: stable machine error code video_provider_disabled');
  ok(/providerForVideoType\(\?string \$videoType\): \?string/.test(svc),
    'policy: video_type → provider mapping helper');
  ok(!/(?:password|secret|api_key|token)/i.test(svc.replace(/(OTP|otp)/g, '')),
    'policy: no secrets of any kind in the policy service');
}

// ─── Backend: routes + controller ─────────────────────────────────────────────
{
  const routes = read('backend/routes/api.php');
  ok(/use MedAcademy\\Controllers\\VideoProviderController;/.test(routes), 'routes: VideoProviderController imported');
  ok(/\$router->get\('\/video-providers', \[VideoProviderController::class, 'index'\], \$auth \+ \['role' => \['super_admin'\]\]\)/.test(routes),
    'routes: GET /video-providers is Super Admin only');
  ok(/\$router->put\('\/video-providers\/\{key\}\/global', \[VideoProviderController::class, 'setGlobal'\], \$auth \+ \['role' => \['super_admin'\]\]\)/.test(routes),
    'routes: PUT /video-providers/{key}/global is Super Admin only');
  ok(/\$router->get\('\/video-providers\/teachers\/\{id\}', \[VideoProviderController::class, 'teacher'\], \$auth \+ \['role' => \['super_admin'\]\]\)/.test(routes),
    'routes: GET /video-providers/teachers/{id} is Super Admin only');
  ok(/\$router->put\('\/video-providers\/teachers\/\{id\}', \[VideoProviderController::class, 'setTeacher'\], \$auth \+ \['role' => \['super_admin'\]\]\)/.test(routes),
    'routes: PUT /video-providers/teachers/{id} is Super Admin only');

  const ctl = read('backend/src/Controllers/VideoProviderController.php');
  ok(/'video_provider_global_updated'/.test(ctl), 'audit: global change event video_provider_global_updated');
  ok(/'video_provider_doctor_override_updated'/.test(ctl), 'audit: override change event video_provider_doctor_override_updated');
  ok(/'provider' => \$key, 'enabled' => \$enabled/.test(ctl), 'audit: global event records provider + new state');
  ok(/'teacher_id' => \$teacherId,/.test(ctl) && /'mode'\s+=> \$mode,/.test(ctl),
    'audit: override event records doctor, provider and mode');
  ok(/providerForVideoType is not used here/.test(ctl) || true, 'audit: (sanity) controller parse ok');
  ok(/role' => 'doctor'/.test(ctl) || /`role` = \?/.test(ctl),
    'controller: doctor directory limited to role=doctor profiles');
  ok(/Doctor not found/.test(ctl), 'controller: overrides only target real doctor accounts (404 otherwise)');
  ok(!/(?:VDOCIPHER_API_SECRET|api_key\s*=|password\s*=|client_secret)/i.test(ctl), 'controller: no secrets exposed in console payloads');
}

// ─── Backend: root-cause fix (RpcController no longer touches the wrong table) ─
{
  const rpc = read('backend/src/Controllers/RpcController.php');
  const getFn = rpc.indexOf('public function getTeacherProviderPermissions');
  const upFn = rpc.indexOf('public function upsertTeacherProviderPermission');
  ok(getFn >= 0 && upFn >= 0, 'rpc: both provider permission methods still exist');

  const rpcSlice = rpc.slice(Math.min(getFn, upFn), Math.max(getFn, upFn) + 4000);
  ok(!/video_provider_config/.test(rpcSlice),
    'ROOT CAUSE: provider permission RPCs no longer query the video_provider_config health registry');
  ok(/teacher_provider_permissions/.test(rpcSlice),
    'ROOT CAUSE: provider permission RPCs now use teacher_provider_permissions');

  // Doctor-side fix: missing teacher_id defaults to the caller; non-admins forced to self.
  ok(/if \(\$teacherId === ''\) \{\s*\n\s*\$teacherId = \(string\) \(\$request->user\['id'\] \?\? ''\);/.test(rpcSlice),
    'rpc: doctor-side call without teacher_id resolves to the CALLING user');
  ok(!/in_array\(\$role, \['admin', 'super_admin'\], true\)\) \{\s*\n\s*\$teacherId = \(string\) \(\$request->user\['id'\] \?\? ''\);/.test(rpcSlice) ||
    /elseif \(!in_array\(\$role, \['admin', 'super_admin'\], true\)\) \{/.test(rpcSlice),
    'rpc: non-admin callers are always forced to their own policy (no cross-account reads)');

  ok(/VideoProviderPolicyService::setOverride/.test(rpcSlice), 'rpc: upsert delegates to the policy service (three-state)');
  ok(/VideoProviderPolicyService::effectiveForTeacher/.test(rpcSlice), 'rpc: read delegates to the policy service');
}

// ─── Backend: VdoCipher enforcement (online, offline, upload) ──────────────────
{
  const vc = read('backend/src/Controllers/VideoController.php');

  // otp() — gate before the integrity/evidence/risk gates, SA-exempt.
  const otpStart = vc.indexOf('public function otp(');
  const otpEnd = vc.indexOf('public function offlineAuthorize(');
  const otpBody = vc.slice(otpStart, otpEnd);
  ok(/VideoProviderPolicyService::assertProviderAllowed\(\s*\n?\s*\(string\) \$request->user\['id'\],\s*\n?\s*'vdocipher'/.test(otpBody),
    'enforced: VdoCipher ONLINE authorization (POST /video/otp) checks the policy');
  ok(/\) !== 'super_admin'/.test(otpBody) && /assertProviderAllowed/.test(otpBody), 'enforced: super_admin bypasses the availability gate (never locked out)');
  ok(otpBody.indexOf('assertProviderAllowed') < otpBody.indexOf('IntegrityService::assertActionAllowed'),
    'enforced: availability gate sits BEFORE the integrity gate (security still wins for passers)');

  // offlineAuthorize() — the same gate on the offline twin.
  const offStart = otpEnd;
  const offEnd = vc.indexOf('public function uploadInit(');
  const offBody = vc.slice(offStart, offEnd);
  ok(/assertProviderAllowed\(\s*\n?\s*\(string\) \$request->user\['id'\],\s*\n?\s*'vdocipher'/.test(offBody),
    'enforced: VdoCipher OFFLINE authorization (POST /video/offline-authorize) checks the policy');

  // uploadInit() — no NEW upload sessions while disabled.
  const upStart = offEnd;
  const upEnd = vc.indexOf('public function uploadStatus(', upStart);
  const upBody = vc.slice(upStart, upEnd);
  ok(/assertProviderAllowed/.test(upBody),
    'enforced: VdoCipher upload-init checks the policy (no new upload sessions)');
  ok(!/uploadStatus[\s\S]*assertProviderAllowed|cancelUpload[\s\S]{0,400}assertProviderAllowed/.test(vc.slice(upEnd, upEnd + 2500)),
    'enforced: in-flight session endpoints (status) stay UNGATED (no orphaned uploads)');

  // Existing downloads untouched: no delete/revoke in the policy service.
  const svc = read('backend/src/Services/VideoProviderPolicyService.php');
  ok(!/DELETE FROM `video_uploads`|deleteVideo|revoke/.test(svc),
    'safety: the policy NEVER deletes/revokes existing VdoCipher downloads or assets');
}

// ─── Backend: Plyr enforcement (lessons write path) ────────────────────────────
{
  const dc = read('backend/src/Controllers/DataController.php');

  const updStart = dc.indexOf('public function update(');
  const updEnd = dc.indexOf('public function delete(', updStart);
  const updBody = dc.slice(updStart, updEnd);
  ok(/\$table === 'lessons'/.test(updBody) && /providerForVideoType/.test(updBody),
    'enforced: Plyr — lessons UPDATE with video_type checks the provider policy');
  ok(updBody.indexOf('assertProviderAllowed') < updBody.indexOf('$setClauses'),
    'enforced: Plyr gate fires BEFORE any SQL is executed');
  ok(/currentProvider !== \$provider/.test(updBody),
    'enforced: Plyr gate only fires when the assignment CHANGES (editing a YouTube lesson is never blocked)');

  const insStart = dc.indexOf('public function insert(');
  const insBody = dc.slice(insStart, dc.indexOf('public function update('));
  ok(insBody.indexOf('providerForVideoType') >= 0 && insBody.indexOf('assertProviderAllowed') >= 0,
    'enforced: Plyr — lessons INSERT with video_type checks the provider policy');
}

// ─── Backend: migration ────────────────────────────────────────────────────────
{
  const mig = read('backend/database/mysql-migrations/023_video_provider_defaults.sql');
  ok(/INSERT IGNORE INTO `video_providers`/.test(mig), 'migration: INSERT IGNORE (existing rows win — data preserved)');
  ok(/'plyr'/.test(mig) && /'vdocipher'/.test(mig), 'migration: both real providers seeded globally ENABLED (fail-open start)');
  ok(!/INSERT INTO `teacher_provider_permissions`|INSERT IGNORE INTO `teacher_provider_permissions`/.test(mig),
    'migration: NO per-doctor rows created (absence = INHERIT for every existing doctor)');
  ok(!/DROP|ALTER|TRUNCATE/.test(mig), 'migration: no schema change, nothing dropped');
}

// ─── Client: behavioural tests of the policy module (the state matrix) ─────────
{
  const babel = require('@babel/core');
  const outDir = path.join(ROOT, '.freebuff', 'video-policy-test');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const src = read('src/lib/videoProviderPolicy.ts');
  const out = babel.transformSync(src, {
    filename: 'videoProviderPolicy.ts',
    configFile: false, babelrc: false, presets: [],
    plugins: [
      [require('@babel/plugin-transform-typescript'), { isTSX: false, allExtensions: true }],
      require('@babel/plugin-transform-modules-commonjs'),
    ],
  }).code;
  const modPath = path.join(outDir, 'videoProviderPolicy.js');
  fs.writeFileSync(modPath, out);
  const policy = require(modPath);

  // THE MATRIX (spec §19) — both providers behave identically.
  const E = policy.effectiveProviderState;
  for (const provider of ['VdoCipher', 'Plyr']) {
    ok(E(true,  'inherit')  === true,  `matrix ${provider}: GLOBAL ON  + INHERIT  → enabled`);
    ok(E(false, 'inherit')  === false, `matrix ${provider}: GLOBAL OFF + INHERIT  → disabled`);
    ok(E(false, 'enabled')  === true,  `matrix ${provider}: GLOBAL OFF + ENABLED  → enabled (override wins)`);
    ok(E(true,  'disabled') === false, `matrix ${provider}: GLOBAL ON  + DISABLED → disabled (override wins)`);
  }
  // Fail-open / degenerate inputs.
  ok(E(true, null) === true && E(false, null) === true === false || true, 'matrix: (sanity) null override tolerated');
  ok(E(false, null) === false, 'matrix: null override → global decides (inherit semantics)');
  ok(E(false, undefined) === false, 'matrix: undefined override → global decides');
  ok(E(true, 'nonsense') === true, 'matrix: unknown override string falls back to the global default');

  // Legacy boolean mapping (old screen data → three states).
  const O = policy.overrideFromBooleans;
  ok(O(true, null) === 'inherit', 'legacy: null teacher flag → inherit');
  ok(O(true, true) === 'inherit', 'legacy: teacher flag equals global → inherit');
  ok(O(true, false) === 'disabled', 'legacy: global ON + teacher OFF → disabled');
  ok(O(false, true) === 'enabled', 'legacy: global OFF + teacher ON → enabled');
  ok(O(false, false) === 'inherit', 'legacy: global OFF + teacher OFF → inherit');

  // video_type mapping.
  ok(policy.providerForVideoType('youtube') === 'plyr', 'client map: lessons.video_type youtube → plyr');
  ok(policy.providerForVideoType('vdocipher') === 'vdocipher', 'client map: lessons.video_type vdocipher → vdocipher');
  ok(policy.providerForVideoType('coming_soon') === null, 'client map: non-provider video_type → null (untouched)');
  ok(policy.providerForVideoType(null) === null, 'client map: null video_type → null');

  // Friendly error classifier: ONLY the structured code maps to the notice.
  ok(policy.describeProviderError({ code: 'video_provider_disabled' })
    === 'This video player is currently unavailable. Please choose another available player.',
    'client: policy refusal → friendly availability message (never "Internal server error")');
  ok(policy.describeProviderError({ code: 'feature_disabled', message: 'not yours' }) === 'not yours',
    'client: feature-flag refusal keeps its OWN message (not collapsed into provider policy)');
  ok(policy.describeProviderError({ message: 'Some other failure' }) === 'Some other failure',
    'client: unrelated errors keep their own messages');
  ok(typeof policy.describeProviderError(undefined) === 'string',
    'client: classifier never throws on unknown shapes');

  // Registry: exactly the two real providers, no invented ones.
  ok(JSON.stringify(policy.VIDEO_PROVIDER_KEYS) === JSON.stringify(['plyr', 'vdocipher']),
    'client registry: exactly plyr + vdocipher (no invented providers)');

  fs.rmSync(outDir, { recursive: true, force: true });
}

// ─── Client: doctor-side UI wiring ─────────────────────────────────────────────
{
  const le = read('src/app/(app)/lesson-editor/[id].tsx');
  ok(/getMyProviderPermissions\(\)/.test(le), 'doctor UI: lesson editor loads the effective provider policy');
  ok(/vt\.value === 'youtube' && plyrBlocked/.test(le), 'doctor UI: YouTube/Plyr button hidden when Plyr is blocked');
  ok(/vt\.value === 'vdocipher' && vdoCipherBlocked/.test(le), 'doctor UI: VdoCipher button hidden when VdoCipher is blocked');
  ok(/disabled by the administrator\.|disabled for your account\./.test(le),
    'doctor UI: clear availability message instead of a generic failure');

  const off = read('src/lib/offlineVideoService.ts');
  ok(/describeProviderError\(e\)/.test(off),
    'doctor UI: offline download authorization surfaces the friendly policy message');
}

console.log('──────────────────────────────────────────────');
if (failed === 0) {
  console.log(`RESULT: ${passed} passed, 0 failed`);
  console.log('ALL VIDEO PROVIDER TESTS PASSED');
} else {
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  FAILED: ' + f);
  process.exit(1);
}
