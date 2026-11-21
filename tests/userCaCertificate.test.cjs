#!/usr/bin/env node
/**
 * USER-INSTALLED CA CERTIFICATE GATE — contracts, classification model and
 * honest boundaries.
 *
 * Run: node tests/userCaCertificate.test.cjs
 *
 * WHAT THIS PROVES (and what it does NOT)
 * ──────────────────────────────────────────────────────────────────────────
 * • UNIT (pure model): the JS status mapping is TOTAL — 'clean' → CLEAN,
 *   'user_ca' → USER_CA_DETECTED, everything else (missing field, unknown
 *   value, 'inconclusive') → INCONCLUSIVE. Never clean by accident.
 * • MOCKED (alias-classification harness): the documented AOSP alias rule
 *   ("user:" / "system:" prefixes, empty store and unknown aliases →
 *   inconclusive) applied to synthetic alias lists. This mirrors the Kotlin
 *   rule so the behaviour is pinned without a device; it is NOT a device test.
 * • SOURCE CONTRACT (config plugin): the emitted Kotlin uses ONLY the public
 *   AndroidCAStore KeyStore view — no root, no reflection, no non-SDK API, no
 *   filesystem path, no shell, no permission, no issuer/CN/fingerprint match —
 *   and publishes the status to JS.
 * • INTEGRATION (source): detector wiring, the mandatory (non-delegable) block,
 *   the dedicated Arabic/English copy, and the lifecycle (foreground re-check,
 *   no cached clean).
 *
 * PHYSICAL VERIFICATION: none. No build, no device and no emulator was used,
 * so "a certificate installed via Settings is enumerated on a real device" is
 * NOT verified here.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const PLUGIN = read('plugins/withSecurityModule.js');
const SECURITY = read('src/lib/security.ts');
const NATIVE_JS = read('src/lib/nativeSecurity.ts');
const CONTEXT = read('src/lib/SecurityContext.tsx');
const GATE = read('src/app/(app)/security-gate.tsx');
const RES = read('src/lib/i18n/resources.ts');
const NSC_PLUGIN = read('plugins/withNetworkSecurityConfig.js');
const APP_JSON = JSON.parse(read('app.json'));

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  \u2705 ' + name); }
  else { failed++; console.error('  \u274c ' + name); }
}

function build(file) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'userca-'));
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(ROOT, 'src', 'lib', file),
      '--outDir', tmp, '--module', 'commonjs', '--target', 'es2020',
      '--skipLibCheck', '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
  return require(path.join(tmp, file.replace(/\.ts$/, '.js')));
}

const M = build('securityStateModel.ts');

/** The Kotlin detector only, comments stripped (so prose cannot satisfy a rule). */
const KOTLIN = (() => {
  const s = PLUGIN.indexOf('private fun inspectUserCaStore');
  const e = PLUGIN.indexOf('private fun detectRecordingViaServices');
  return PLUGIN.slice(s, e);
})();
const KOTLIN_CODE = KOTLIN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
/** Gate source with comments removed — prose must not satisfy/break a rule. */
const GATE_CODE = GATE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
const DETECTOR = SECURITY.slice(
  SECURITY.indexOf('async function detectUserCaCertificate'),
  SECURITY.indexOf('/**\n * Debug / emulator detection'),
);

/**
 * The documented classification rule, mirrored for synthetic alias lists.
 * It is the SAME rule the Kotlin implements (asserted in section 2): prefix
 * only, never the certificate's content.
 */
function classify(aliases) {
  let count = 0;
  let user = 0;
  for (const alias of aliases) {
    if (typeof alias !== 'string' || alias === '') return { status: 'inconclusive', count: 0 };
    count++;
    if (alias.startsWith('user:')) user++;
    else if (!alias.startsWith('system:')) return { status: 'inconclusive', count: 0 };
  }
  if (count === 0) return { status: 'inconclusive', count: 0 };
  return user > 0 ? { status: 'user_ca', count: user } : { status: 'clean', count: 0 };
}

const SYSTEM = Array.from({ length: 139 }, (_, i) => `system:${(0x1000 + i).toString(16)}.0`);
const REQABLE_CA = 'user:8f3a91c2.0';
const BURP_CA = 'user:1c7be004.0';
const CUSTOM_CA = 'user:00ff00ff.0';

// ══════════════════════════════════════════════════════════════════════════
console.log('\n1. Classification outcomes (unit + mocked alias model)');
// ══════════════════════════════════════════════════════════════════════════
{
  check('1a: no user certificates at all → CLEAN',
    classify(SYSTEM).status === 'clean' && M.resolveUserCaOutcome('clean') === 'CLEAN');
  check('1b: exactly one user CA → USER_CA_DETECTED (count 1)',
    (() => { const r = classify([...SYSTEM, REQABLE_CA]);
      return r.status === 'user_ca' && r.count === 1 && M.resolveUserCaOutcome('user_ca') === 'USER_CA_DETECTED'; })());
  check('1c: multiple user CAs → USER_CA_DETECTED (count 2)',
    (() => { const r = classify([...SYSTEM, REQABLE_CA, BURP_CA]);
      return r.status === 'user_ca' && r.count === 2; })());
  check('1d: a system-only store stays CLEAN even with 139 system CAs',
    classify(SYSTEM).status === 'clean');
  check('1e: a CA left behind by an UNINSTALLED Reqable is still detected',
    (() => {
      const installed = new Set();               // Reqable uninstalled
      const aliases = [...SYSTEM, REQABLE_CA];   // its CA stays in the store
      return !installed.has('com.reqable.android') && classify(aliases).status === 'user_ca';
    })());
  check('1f: a CA left behind by Burp Suite (never an Android package) is detected',
    classify([...SYSTEM, BURP_CA]).status === 'user_ca');
  check('1g: a custom CA with an unrelated issuer/name is detected',
    // The alias is an opaque subject hash: the classifier never parses a DN.
    classify([...SYSTEM, CUSTOM_CA]).status === 'user_ca'
    && !/getSubjectDN|getIssuerDN|getSubjectX500Principal|X500Principal/.test(KOTLIN_CODE));
  check('1h: removing the ONLY user CA clears the finding on the next scan',
    (() => {
      const before = classify([...SYSTEM, REQABLE_CA]);
      const after = classify([...SYSTEM]);   // tombstone is elided by the store
      return before.status === 'user_ca' && after.status === 'clean';
    })());
  check('1i: removing ONE of two user CAs does NOT clear the finding',
    (() => {
      const after = classify([...SYSTEM, BURP_CA]);
      return after.status === 'user_ca' && after.count === 1;
    })());
  check('1j: an empty store is INCONCLUSIVE, never CLEAN',
    classify([]).status === 'inconclusive' && M.resolveUserCaOutcome('clean') === 'CLEAN');
  check('1k: the empty-store reason is a failed/unreadable store, not a clean one',
    /aliasCount == 0 -> "inconclusive"/.test(KOTLIN_CODE));
  check('1l: an unrecognised alias is INCONCLUSIVE (classification failure)',
    classify([...SYSTEM, 'nickname:my-cert']).status === 'inconclusive'
    && /else if \(!alias\.startsWith\("system:"\)\)/.test(KOTLIN_CODE));
  check('1m: a malformed/absent status is INCONCLUSIVE (total mapping)',
    ['inconclusive', undefined, null, '', 'CLEAN', 'unknown'].every(
      (s) => M.resolveUserCaOutcome(s) === 'INCONCLUSIVE' && s !== 'clean'));
  check('1n: only the literal "clean" is CLEAN (case/whitespace cannot fake it)',
    M.resolveUserCaOutcome('Clean') === 'INCONCLUSIVE' && M.resolveUserCaOutcome('clean ') === 'INCONCLUSIVE');
  check('1o: only the literal "user_ca" is a detection',
    M.resolveUserCaOutcome('user-ca') === 'INCONCLUSIVE'
    && M.resolveUserCaOutcome('USER_CA') === 'INCONCLUSIVE');
  check('1p: the mapping is total — every input produces one of the three outcomes',
    ['clean', 'user_ca', 'inconclusive', 'x', undefined].every(
      (s) => ['CLEAN', 'USER_CA_DETECTED', 'INCONCLUSIVE'].includes(M.resolveUserCaOutcome(s))));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n2. Native detection — public API only, exact rule');
// ══════════════════════════════════════════════════════════════════════════
{
  check('2a: the platform CA store is opened through KeyStore "AndroidCAStore"',
    /java\.security\.KeyStore\.getInstance\("AndroidCAStore"\)/.test(KOTLIN_CODE)
    && /store\.load\(null, null\)/.test(KOTLIN_CODE));
  check('2b: aliases are enumerated with the store\'s own API',
    /store\.aliases\(\)/.test(KOTLIN_CODE) && /hasMoreElements\(\)/.test(KOTLIN_CODE));
  check('2c: user-added certificates are identified by the documented "user:" prefix',
    /alias\.startsWith\("user:"\)/.test(KOTLIN_CODE));
  check('2d: system certificates are identified by the documented "system:" prefix',
    /alias\.startsWith\("system:"\)/.test(KOTLIN_CODE));
  check('2e: a user: alias must resolve to a real X.509 certificate',
    /cert !is java\.security\.cert\.X509Certificate/.test(KOTLIN_CODE));
  check('2f: any exception is reported as inconclusive, never clean',
    /catch \(_: Throwable\)[\s\S]{0,120}"inconclusive" to 0/.test(KOTLIN_CODE));
  check('2g: the rule never inspects the certificate\'s identity or fingerprint',
    !/getSubjectDN|getIssuerDN|getSubjectX500Principal|getIssuerX500Principal|getEncoded|MessageDigest|SHA-256|X509_NAME/.test(KOTLIN_CODE));
  check('2h: no root, shell, reflection, hidden API or privileged permission is used',
    !/\bsu\b|Runtime\.getRuntime|ProcessBuilder|exec\(|reflect|Class\.forName|getDeclaredMethod|setAccessible|android\.permission/.test(KOTLIN_CODE));
  check('2i: no direct filesystem access to the credential store',
    !/\/data\/misc|\/system\/etc\/security|cacerts-added|cacerts-removed|java\.io\.File/.test(KOTLIN_CODE));
  check('2j: the classification does not depend on installed packages or running state',
    !/PackageManager|getPackageInfo|getRunningServices|getRunningAppProcesses|ActivityManager|UsageStats/.test(KOTLIN_CODE));
  check('2k: no client-authentication certificate store is consulted',
    !/AndroidKeyStore|KeyChain|choosePrivateKeyAlias|PKCS12/.test(KOTLIN_CODE));
  check('2l: the status and the raw count are published to JS',
    /putString\("userCaStatus"/.test(PLUGIN) && /putInt\("userCaCount"/.test(PLUGIN));
  check('2m: INCONCLUSIVE is added to the unavailable checks (not silently dropped)',
    /if \(userCa\.first == "inconclusive"\) unavailable\.add\("userCaStore"\)/.test(PLUGIN));
  check('2n: a throwing scan is still recorded as unavailable',
    /runCatching \{ inspectUserCaStore\(\) \}[\s\S]{0,120}"inconclusive" to 0/.test(PLUGIN));
  check('2o: the scan is not cached between evaluations (no stale CLEAN)',
    !/cachedUserCa|lastUserCa|userCaCache|@Volatile[\s\S]{0,80}userCa/.test(PLUGIN));
  check('2p: the scan reads no running-service/process state (works when tools are idle)',
    !/getRunningServices|getRunningAppProcesses|isRunning/.test(KOTLIN_CODE));
  check('2q: it performs no enumeration of installed applications',
    !/queryIntentActivities|getInstalledPackages|getInstalledApplications/.test(KOTLIN_CODE));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n3. Engine wiring and the mandatory, non-delegable block');
// ══════════════════════════════════════════════════════════════════════════
{
  check('3a: a detector exists and is registered in the concurrent batch',
    /async function detectUserCaCertificate\(/.test(SECURITY) && /track\('userCa'/.test(SECURITY));
  check('3b: it reads the native flags (no JS certificate enumeration)',
    /getNativeSecurityFlags\(\)/.test(DETECTOR) && !/KeyStore|AndroidCAStore/.test(DETECTOR));
  check('3c: it is Android-only (iOS returns null, never a false claim)',
    /process\.env\.EXPO_OS !== 'android'\) return null/.test(DETECTOR));
  check('3d: it cannot run before the native batch lands (async, no sync shortcut)',
    /await getNativeSecurityFlags\(\)/.test(DETECTOR));
  check('3e: a detection emits the certificate-trust event with the exact method',
    /type: 'ssl_pinning_failure'/.test(DETECTOR)
    && /detectionMethod: USER_CA_DETECTION_METHOD/.test(DETECTOR)
    && M.USER_CA_DETECTION_METHOD === 'User-installed security certificate detected');
  check('3f: INCONCLUSIVE produces NO threat and NO detected:false clean claim',
    /if \(outcome === 'INCONCLUSIVE'\)[\s\S]{0,160}return null;/.test(DETECTOR)
    && !/detected: false/.test(DETECTOR));
  check('3g: the finding forces blocksLogin AND blocksVideo (policy cannot downgrade it)',
    /const userCaForcesBlock = allThreats\.some\(isUserCaFinding\)/.test(SECURITY)
    && /const effectiveBlocksLogin = blocksLogin \|\| userCaForcesBlock;/.test(SECURITY)
    && /const effectiveBlocksVideo = blocksVideo \|\| userCaForcesBlock;/.test(SECURITY)
    && /blocksLogin: effectiveBlocksLogin, blocksVideo: effectiveBlocksVideo,/.test(SECURITY));
  check('3h: the block covers API/video/PDF because it rides the central lock',
    /blocksLogin: effectiveBlocksLogin/.test(SECURITY));
  check('3i: the copy key is derived from the detection method, not a new event type',
    M.resolveFindingCopyKey('ssl_pinning_failure', M.USER_CA_DETECTION_METHOD) === 'user_ca_detected');
  check('3j: a REAL pin failure keeps its own copy key',
    M.resolveFindingCopyKey('ssl_pinning_failure', 'Secure connection to the server could not be verified') === 'ssl_pinning_failure');
  check('3k: the finding is NOT a connection finding (no VPN page)',
    M.isConnectionFinding('ssl_pinning_failure') === false
    && M.hasConnectionFinding([{ type: 'ssl_pinning_failure', detected: true }]) === false);
  check('3l: isUserCaFinding only matches the trust-store finding',
    M.isUserCaFinding({ type: 'ssl_pinning_failure', detectionMethod: M.USER_CA_DETECTION_METHOD }) === true
    && M.isUserCaFinding({ type: 'ssl_pinning_failure', detectionMethod: 'pin mismatch' }) === false
    && M.isUserCaFinding({ type: 'tamper_detected', detectionMethod: M.USER_CA_DETECTION_METHOD }) === false);
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n4. Gate: one screen, dedicated copy, no bypass');
// ══════════════════════════════════════════════════════════════════════════
{
  const gateState = (over) => M.resolveSecurityGateState({
    evaluating: false, hasVerdict: true, multiWindowBlocked: false,
    backgroundResumeBlocked: false, vpnBlocked: false, violationBlocked: false,
    ...over,
  });

  check('4a: a user-CA finding alone is a BLOCK, not ALLOWED',
    gateState({ userCaBlocked: true }) === 'BLOCKED_SECURITY_VIOLATION'
    && M.isGateBlocked(gateState({ userCaBlocked: true })) === true);
  check('4b: it renders the full-screen block page',
    M.rendersBlockScreen(gateState({ userCaBlocked: true })) === true);
  check('4c: it offers NO recheck/dismiss control (no bypass path)',
    M.isGateRecheckable(gateState({ userCaBlocked: true })) === false);
  check('4d: it outranks the resume hold and a VPN (certificate copy is primary)',
    gateState({ userCaBlocked: true, backgroundResumeBlocked: true }) === 'BLOCKED_SECURITY_VIOLATION'
    && gateState({ userCaBlocked: true, vpnBlocked: true }) === 'BLOCKED_SECURITY_VIOLATION');
  check('4e: a prohibited window mode still outranks it',
    gateState({ multiWindowBlocked: true, userCaBlocked: true }) === 'BLOCKED_MULTI_WINDOW');
  check('4f: the certificate and a VPN are BOTH listed as live reasons',
    M.resolveGateReasons({
      evaluating: false, hasVerdict: true, multiWindowBlocked: false,
      backgroundResumeBlocked: false, vpnBlocked: true, violationBlocked: false,
      userCaBlocked: true,
    }).map((r) => r.kind).join(',') === 'user_ca,vpn');
  check('4g: clearing the certificate removes only its own reason',
    M.resolveGateReasons({
      evaluating: false, hasVerdict: true, multiWindowBlocked: false,
      backgroundResumeBlocked: false, vpnBlocked: true, violationBlocked: false,
      userCaBlocked: false,
    }).map((r) => r.kind).join(',') === 'vpn');
  check('4h: the gate derives the state from the finding itself',
    /const userCaBlocked = liveBlocking && threats\.some\(isUserCaFinding\);/.test(GATE));
  check('4i: the header uses the dedicated certificate copy',
    /userCaBlocked[\s\S]{0,120}t\('security\.userCa\.title'\)/.test(GATE)
    && /t\('security\.userCa\.message'\)/.test(GATE));
  check('4j: the findings list is suppressed (the header IS the finding)',
    /windowModeBlockedState \|\| userCaBlocked\s*\?\s*\[\]\s*:\s*gateFindings/.test(GATE));
  check('4k: the certificate reason is rendered in the multi-cause list',
    /reason\.kind === 'user_ca'/.test(GATE));
  check('4l: the footer states the lock is automatic, with no control',
    /t\('security\.gate\.footerUserCa'\)/.test(GATE)
    && !/Continue Anyway/.test(GATE_CODE));
  check('4m: the page never claims interception is happening',
    !/intercept/i.test(read('src/lib/i18n/resources.ts').slice(
      read('src/lib/i18n/resources.ts').indexOf("security.userCa.message") - 40,
      read('src/lib/i18n/resources.ts').indexOf("security.userCa.message") + 400)));
  check('4n: no certificate name, issuer, count or package id is displayed',
    !/userCaCount|userCaCount\)/.test(GATE)
    && !/com\.|getSubjectDN|issuer/i.test(GATE.slice(GATE.indexOf('USER-INSTALLED CA'), GATE.indexOf('const findings'))));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n5. Copy (English + Arabic, exact required messages)');
// ══════════════════════════════════════════════════════════════════════════
{
  const en = "A user-installed security certificate was detected. To protect MedAcademy content, remove all user-installed CA certificates from your device settings and reopen the application.";
  const ar = "تم اكتشاف شهادة أمان مثبتة على الجهاز. لحماية محتوى MedAcademy، يجب حذف جميع شهادات الأمان التي أضافها المستخدم من إعدادات الجهاز، ثم إعادة فتح التطبيق.";
  check('5a: both locales carry the dedicated title/message/footer',
    ['security.userCa.title', 'security.userCa.message', 'security.gate.footerUserCa'].every(
      (k) => (RES.match(new RegExp(`'${k.replace(/\./g, '\\.')}'`, 'g')) || []).length === 2));
  check('5b: the English message is the required sentence, verbatim', RES.includes(en));
  check('5c: the Arabic message is the required sentence, verbatim', RES.includes(ar));
  check('5d: the copy names the app and the remedy (no technical detail)',
    RES.includes('remove all user-installed CA certificates from your device settings'));
  check('5e: no package id leaked into the user-facing copy',
    !/com\.(network|reqable|wujiuye|moni|nutiverse|minhui|realsignal|anetcapture)/.test(RES));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n6. Lifecycle: fresh verification, no stale CLEAN, no content flash');
// ══════════════════════════════════════════════════════════════════════════
{
  check('6a: the detector re-runs in every evaluation (no memoised verdict)',
    /async function detectUserCaCertificate\(/.test(SECURITY)
    && !/cachedUserCaResult|memoizedUserCa/.test(SECURITY));
  check('6b: a foreground return triggers a fresh evaluation (token + acceptance)',
    /resumeTokenRef\.current \+= 1;/.test(CONTEXT) && /acceptsResumeVerification/.test(CONTEXT));
  check('6c: the resume hold is engaged before the certificate result can arrive',
    /resolveBackgroundResumeGate\(/.test(CONTEXT)
    && /acceptsResumeVerification\(\{/.test(CONTEXT));
  check('6d: protected content is withheld while a re-check is in flight',
    /const blocking = isGateBlocked\(gateState\);/.test(GATE)
    && /if \(!blocking \|\| !blockScreen\) return null;/.test(GATE));
  check('6e: the block clears only after a COMPLETED clean evaluation',
    /nextStickyTypes\(gateTypesRef\.current, \{/.test(GATE)
    && /return \[\]; \/\/ completed evaluation, nothing blocking → recover/.test(
      read('src/lib/securityStateModel.ts')));
  check('6f: the check runs off the UI thread (native module thread, single batch call)',
    /@ReactMethod\n    fun getSecurityFlags/.test(PLUGIN));
  check('6g: exactly one enumeration per evaluation (no repeat inside the detector)',
    (KOTLIN_CODE.match(/KeyStore\.getInstance/g) || []).length === 1);
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n7. Existing protections unchanged by this addition');
// ══════════════════════════════════════════════════════════════════════════
{
  check('7a: VPN blocking is untouched',
    /async function detectVPN\(/.test(SECURITY) && /vpn:\s+'block_login'/.test(SECURITY));
  check('7b: interception-app detection is untouched',
    /async function detectInterceptionTools\(/.test(SECURITY)
    && /InterceptionTool\("com\.network\.proxy", "ProxyPin"\)/.test(PLUGIN));
  check('7c: split-screen / PiP protection is untouched',
    /if \(input\.multiWindowBlocked\) return 'BLOCKED_MULTI_WINDOW';/.test(
      read('src/lib/securityStateModel.ts'))
    && /isProhibitedWindowMode/.test(CONTEXT));
  check('7d: certificate pinning / NSC is untouched (system anchors only, no user CA trust)',
    /<certificates src="system" \/>/.test(NSC_PLUGIN)
    && !/<certificates src="user" \/>/.test(NSC_PLUGIN.split('<debug-overrides>')[0]));
  check('7e: no new dangerous permission was introduced',
    // The plugin NAMES the retired permissions only to explain why they are
    // not used, so comments are stripped before the check.
    !/BIND_ACCESSIBILITY_SERVICE|PACKAGE_USAGE_STATS|QUERY_ALL_PACKAGES/.test(
      PLUGIN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''))
    && !(APP_JSON.expo?.android?.permissions || []).some(
      (p) => /ACCESSIBILITY|USAGE_STATS|QUERY_ALL_PACKAGES/.test(p)));
  check('7f: no second VpnService and no restored overlay detection',
    !/extends VpnService/.test(PLUGIN) && !/REASON_OVERLAY|overlayLatched/.test(PLUGIN));
  check('7g: the certificate check does not read the interception catalog',
    !/interceptionTool|INTERCEPTION_TOOLS/.test(DETECTOR) && !/detectInterceptionTools/.test(KOTLIN_CODE));
  check('7h: the native bridge keeps its honest default (inconclusive, never clean)',
    /userCaStatus: 'inconclusive',/.test(NATIVE_JS));
}

console.log('\n' + '\u2500'.repeat(60));
console.log('userCaCertificate: ' + passed + ' passed, ' + failed + ' failed');
console.log('NOTE: classification is a mocked alias model + source contract.');
console.log('No build, device or emulator was used — physical detection is NOT verified.');
process.exit(failed === 0 ? 0 : 1);
