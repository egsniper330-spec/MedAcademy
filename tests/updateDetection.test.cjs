/**
 * App-Update detection & full-screen enforcement tests.
 *
 * Run: node tests/updateDetection.test.cjs
 *
 * Covers the root causes of "published update not detected":
 *   A. iOS build-number identity (the client MUST read the native build via
 *      expo-application — Application.nativeBuildVersion — not hardcode 0).
 *   B. Server-side 426 identity header sent for iOS too (AuthMiddleware's
 *      floor evaluated every native client, not only Android).
 *   C. Publish must ARM the gate: minimum_version_code raised, is_enabled=1.
 *   D. Cache v2 is bound to the installed build (no stale suppression after
 *      the user updates).
 *   E. Full-screen gate requirements: root-level mounting, FORCED = whole
 *      screen, no Alert/Modal, gate stays above drawer/back navigation.
 *   F. Verdict semantics preserved (fail-closed startup, no false UPDATE_REQUIRED
 *      from network loss, draft never enforces).
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  pass++;
  console.log(`  ✔ ${msg}`);
}
function fnSrc(file, name) {
  const src = read(file);
  const idx = src.indexOf(name);
  ok(idx !== -1, `${file} contains ${name}`);
  return idx === -1 ? '' : src.slice(idx, idx + 2600);
}

// ── A. Native identity source ─────────────────────────────────────────────────
console.log('\nA. Native app identity (expo-application)');
const identity = read('src/lib/appIdentity.ts');
ok(identity.includes("from 'expo-application'"), 'appIdentity imports expo-application');
ok(
  identity.includes('nativeBuildVersion') && identity.includes('nativeApplicationVersion'),
  'reads Application.nativeBuildVersion + nativeApplicationVersion (both platforms)'
);
ok(
  !/iOS[\s\S]{0,80}:\s*0/.test(identity),
  'no hardcoded 0 build for iOS'
);
const pkg = JSON.parse(read('package.json'));
ok(
  pkg.dependencies['expo-application'] !== undefined,
  'expo-application is a direct dependency'
);
const ucSvc = read('src/lib/updateConfigService.ts');
ok(
  ucSvc.includes("from './appIdentity'"),
  'updateConfigService consumes the native identity module'
);
ok(
  /INSTALLED_CODE\s*=\s*getNativeBuildNumber\(\)/.test(ucSvc),
  'INSTALLED_CODE comes from the native build number (android AND ios)'
);
ok(!ucSvc.includes('?? 0)\n    : 0;'), 'the old hardcoded-iOS-0 ternary is gone');

// ── B. Server-side 426 identity headers for BOTH platforms ────────────────────
console.log('\nB. Identity headers (server-side enforcement)');
const phpClient = read('src/client/php.ts');
ok(
  phpClient.includes('getInstalledBuildNumber'),
  'php.ts identity header uses the native build number'
);
ok(
  /if \(RNPlatform\.OS !== 'web'\) \{[\s\S]{0,500}?X-App-Platform[\s\S]{0,500}?X-App-Version-Code/.test(phpClient),
  'X-App-Platform + X-App-Version-Code sent for every native platform (iOS included)'
);
ok(
  !phpClient.includes("Constants.expoConfig?.android?.versionCode ?? 0;\n    if (appVersionCode > 0)"),
  'the android-only header ternary is gone'
);

// ── C. Publish arms the gate (backend) ────────────────────────────────────────
console.log('\nC. Publish arms enforcement');
const promote = fnSrc('backend/src/Services/AppReleaseService.php', 'private function promoteToUpdateConfig');
ok(promote.includes('GREATEST(app_update_config.minimum_version_code, VALUES(minimum_version_code))'),
  'publish raises minimum_version_code monotonically (never lowers)');
ok(/is_enabled\s*=\s*1/.test(promote), 'publish enables the platform gate');
ok(!/VALUES\(is_enabled\)/.test(promote), 'publish no longer preserves a stale disabled flag');

const evaluate = fnSrc('backend/src/Services/AppUpdateService.php', 'public function evaluate');
ok(evaluate.includes("'releaseNotes'"), '426 payload carries releaseNotes');

const version = fnSrc('backend/src/Controllers/UpdateConfigController.php', 'public function version');
ok(version.includes("'web'"), 'header-less /app/version resolves platform web (not android)');

// ── D. Cache bound to the installed build ─────────────────────────────────────
console.log('\nD. Offline policy cache v2');
ok(ucSvc.includes('update_policy_cache_v2'), 'cache bumped to v2 (v1 entries never trusted)');
ok(
  ucSvc.includes('cachedPolicyInstalledCode === INSTALLED_CODE') ||
    ucSvc.includes('cached.installedVersionCode === INSTALLED_CODE'),
  'cached verdicts are bound to the installed build that confirmed them'
);
ok(
  ucSvc.includes('installedVersionCode: INSTALLED_CODE'),
  'persisted cache entries record the installed build'
);

// ── E. Full-screen gate ───────────────────────────────────────────────────────
console.log('\nE. Full-screen blocking page');
const root = read('src/app/_layout.tsx');
ok(
  /ForceUpdateGate\(/.test(root) && root.indexOf('ForceUpdateGate') < root.indexOf('<Stack'),
  'ForceUpdateGate mounts at the ROOT level, above the Stack navigator'
);
ok(
  root.includes('verdict === \'UPDATE_REQUIRED\'') &&
    root.includes('return <ForceUpdateScreen />'),
  'UPDATE_REQUIRED replaces the entire screen (children never rendered)'
);
const screen = read('src/components/ForceUpdateScreen.tsx');
ok(!/Alert\.alert/.test(screen), 'no Alert.alert anywhere in the update UI');
ok(!/from 'react-native'[\s\S]*?\bModal\b/.test(screen.split('styles.')[0]), 'no Modal in the update UI');
ok(screen.includes('Update Now'), 'primary action: Update Now');
ok(screen.includes('openUpdateUrl'), 'Update Now opens the configured production URL');
ok(screen.includes('SafeAreaView'), 'full-screen page is safe-area aware');
ok(screen.includes('update.installedVersionCode'), 'installed build number displayed');
ok(screen.includes('update.latestVersionCode'), 'required build number displayed');
ok(screen.includes('assets/icon.png'), 'MedAcademy branding on the update page');
const hook = read('src/lib/useForceUpdate.ts');
ok(
  hook.includes('dismissedThisSession') && hook.includes("mode === 'OPTIONAL'"),
  'dismissal exists ONLY for OPTIONAL mode; FORCED has no dismiss path'
);
ok(
  !/dismissOptional[\s\S]{0,200}FORCED/.test(hook),
  'no dismiss path is reachable in FORCED mode'
);

// ── F. Verdict semantics (pure model, unchanged contracts) ────────────────────
console.log('\nF. Verdict semantics preserved');
const model = require('../.freebuff/state-build/securityStateModel.js');
ok(model.evaluateUpdateVerdict({ enabled: true, minimumVersionCode: 250, installedVersionCode: 212 }).verdict === 'UPDATE_REQUIRED',
  'installed 212 < minimum 250 → UPDATE_REQUIRED');
ok(model.evaluateUpdateVerdict({ enabled: true, minimumVersionCode: 250, installedVersionCode: 250 }).verdict === 'SUPPORTED',
  'installed 250 = minimum 250 → SUPPORTED');
ok(model.evaluateUpdateVerdict({ enabled: true, minimumVersionCode: 250, installedVersionCode: 300 }).verdict === 'SUPPORTED',
  'installed 300 > minimum 250 → SUPPORTED (newer than production)');
ok(model.evaluateUpdateVerdict({ enabled: false, minimumVersionCode: 250, installedVersionCode: 100 }).verdict === 'SUPPORTED',
  'disabled policy → SUPPORTED (kill switch works)');
ok(model.evaluateUpdateVerdict({ enabled: true, minimumVersionCode: 0, installedVersionCode: 100 }).verdict === 'SUPPORTED',
  'no floor configured → SUPPORTED');
ok(model.evaluateUpdateVerdict({ enabled: true, minimumVersionCode: 250, installedVersionCode: 0 }).verdict === 'SUPPORTED',
  'unknown installed build → stand down (never falsely blocks)');
ok(model.evaluateOfflineUpdatePolicy(null, Date.now()).verdict === 'SUPPORTED',
  'offline + no cache → SUPPORTED (network loss is NOT update-required)');
ok(
  model.evaluateOfflineUpdatePolicy({ verdict: 'UPDATE_REQUIRED', minimumVersionCode: 250, confirmedAt: Date.now() }, Date.now()).verdict === 'UPDATE_REQUIRED',
  'offline + cached UPDATE_REQUIRED → stays blocked (fail-closed)');

// Draft never enforces: the gate config is fed ONLY from publish()/rollback()
// (create/update of draft/ready releases never call promoteToUpdateConfig).
const releaseSrc = read('backend/src/Services/AppReleaseService.php');
const promoteCalls = [...releaseSrc.matchAll(/\$this->promoteToUpdateConfig\(/g)].map((m) => m.index);
ok(promoteCalls.length === 2, 'exactly two promote call sites (publish + rollback)');
for (const idx of promoteCalls) {
  const before = releaseSrc.slice(0, idx);
  const fromPublish = before.lastIndexOf('public function publish');
  const fromRollback = before.lastIndexOf('public function rollback');
  const fromCreate = before.lastIndexOf('public function create');
  const fromUpdate = before.lastIndexOf('public function update');
  const owner = Math.max(fromPublish, fromRollback, fromCreate, fromUpdate);
  ok(
    owner === fromPublish || owner === fromRollback,
    'promote call site belongs to publish()/rollback() (not create/update — drafts never enforce)'
  );
}

console.log(`\n${pass} assertions passed.`);
