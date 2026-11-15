#!/usr/bin/env node
/* eslint-env node */
/**
 * rootFalsePositive.test.cjs
 *
 * REPRODUCTION + REGRESSION SUITE for the reported Android false positives.
 *
 * On a NORMAL, non-rooted device the app showed BOTH
 *   • "Root privileges detected"             (event root_detected)
 *   • "A root management tool is installed"  (event magisk_detected)
 *
 * ROOT CAUSE
 *   detectRoot() and detectMagisk() each started with the SAME root-framework
 *   artifact probe and returned true on the FIRST positive branch, where
 *   "positive" included ANY EACCES:
 *
 *       stat("/debug_ramdisk/su")  →  EACCES
 *
 *   Android 11+ mounts /debug_ramdisk 0700 root:root, so looking up a child
 *   fails for every app whether or not the child exists: the errno proved only
 *   "the parent is not searchable". That single observation set rootDetected AND
 *   magiskDetected. /data/local/* carried the same ambiguity.
 *
 * THE FIX THIS SUITE PINS
 *   • every probe target carries a POLICY for what EACCES proves on stock
 *     Android; root-only (/debug_ramdisk) and OEM/SELinux-dependent (/data/local)
 *     parents yield INCONCLUSIVE, never evidence;
 *   • every signal is one classified check (id / category / result / evidence /
 *     confidence / contributes) and both verdicts are PROJECTIONS over that one
 *     list, so they cannot share an anonymous boolean;
 *   • low-confidence and inconclusive results never decide a verdict;
 *   • a package lookup that fails for any reason other than NameNotFound is
 *     inconclusive, never "detected";
 *   • the mount rule no longer treats a generic "lowerdir=/data" as evidence.
 *
 * TEST PROVENANCE — read this before trusting the result
 *   The scenarios below are MOCKED native reports executed against the pure
 *   model (src/lib/rootDetectionModel.ts), plus STATIC assertions that the
 *   generated Kotlin implements the same rules. NOTHING here ran on a physical
 *   device: the Kotlin cannot execute in this environment (no Android
 *   toolchain), so "normal device → no warning" is verified at the rule level
 *   and by structural equivalence, not on hardware.
 *
 * Usage: node tests/rootFalsePositive.test.cjs
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}
function section(title) { console.log(`\n── ${title} ──`); }

/* ── Model under test (compiled by scripts/state-build-models.cjs) ────────── */

function loadModel() {
  const compiled = path.join(ROOT, 'scripts', 'state-build', 'rootDetectionModel.js');
  if (fs.existsSync(compiled)) return require(compiled);
  const { buildStateModels } = require(path.join(ROOT, 'scripts', 'state-build-models.cjs'));
  buildStateModels();
  return require(compiled);
}
const model = loadModel();

const PLUGIN = read('plugins/withSecurityModule.js');
const KT_MATCH = PLUGIN.match(/const SECURITY_MODULE_KT = `([\s\S]*?)\n`;\n/);
const KT = KT_MATCH ? KT_MATCH[1] : '';
const NATIVE_TS = read('src/lib/nativeSecurity.ts');
const SECURITY_TS = read('src/lib/security.ts');

/** Kotlin body of one member (bounded by the next member). */
function ktFunction(name) {
  const start = KT.indexOf(`private fun ${name}(`);
  if (start < 0) return '';
  const rest = KT.slice(start + 10);
  const next = rest.search(/\n    (private )?(fun|data class|enum class|object|@ReactMethod)/);
  return next < 0 ? rest : rest.slice(0, next);
}
/** The brace-balanced body that follows a member signature. */
function braceBody(signature) {
  const i = KT.indexOf(signature);
  if (i < 0) return '';
  const start = KT.indexOf('{', i);
  if (start < 0) return '';
  let depth = 0;
  let out = '';
  for (let k = start; k < KT.length; k++) {
    const ch = KT[k];
    out += ch;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
  }
  return out;
}
function bracesBalanced(body) {
  let depth = 0;
  let min = 0;
  for (const ch of body) {
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth < min) min = depth; }
  }
  return depth === 0 && min === 0;
}

/** Short window after a needle, for "which constant is used here" checks. */
function snippet(needle, len = 420) {
  const i = KT.indexOf(needle);
  return i < 0 ? '' : KT.slice(i, i + len);
}

/* ── Fixtures: native check reports (mocked) ──────────────────────────────── */

const chk = (id, category, result, confidence, evidence = '') => ({
  id, category, result, confidence, evidence,
  contributes: result === 'positive' && confidence !== 'low',
});

const ROOT_CHECK_IDS = [
  ['artifact_probe', 'root_privileges'],
  ['su_binary_paths', 'root_privileges'],
  ['su_on_path', 'root_privileges'],
  ['system_writable', 'root_privileges'],
  ['build_props', 'root_privileges'],
  ['mount_view', 'root_privileges'],
  ['test_keys', 'root_privileges'],
  ['artifact_probe', 'root_management'],
  ['root_manager_packages', 'root_management'],
  ['magisk_packages', 'root_management'],
  ['magisk_paths', 'root_management'],
  ['mount_view', 'root_management'],
  ['zygisk_evidence', 'root_management'],
  ['magisk_mounts', 'root_management'],
  ['magisk_maps', 'root_management'],
];

/** Every check negative — the baseline "this device is spotless" report. */
function allNegative(overrides = []) {
  const base = ROOT_CHECK_IDS.map(([id, category]) => chk(id, category, 'negative', 'high'));
  for (const o of overrides) {
    const i = base.findIndex((c) => c.id === o.id && c.category === o.category);
    if (i >= 0) base[i] = { ...base[i], ...o };
    else base.push(o);
  }
  return base;
}

/**
 * STOCK Android 11+ device: /debug_ramdisk is 0700 root:root, so the probe of
 * its children answers EACCES on a clean device. That is the observation that
 * used to produce both warnings.
 */
const NORMAL_DEVICE = allNegative([
  { id: 'artifact_probe', category: 'root_privileges', result: 'inconclusive', confidence: 'low',
    evidence: 'unreadable_scope=/debug_ramdisk/su,/debug_ramdisk/magisk' },
  { id: 'artifact_probe', category: 'root_management', result: 'inconclusive', confidence: 'low',
    evidence: 'unreadable_scope=/debug_ramdisk/su,/debug_ramdisk/magisk' },
  { id: 'artifact_probe_visibility', category: 'root_privileges', result: 'inconclusive', confidence: 'low',
    evidence: 'unreadable_scope=/debug_ramdisk/su,/debug_ramdisk/magisk' },
  { id: 'artifact_probe_visibility', category: 'root_management', result: 'inconclusive', confidence: 'low',
    evidence: 'unreadable_scope=/debug_ramdisk/su,/debug_ramdisk/magisk' },
  { id: 'build_props', category: 'root_privileges', result: 'negative', confidence: 'medium' },
  { id: 'test_keys', category: 'root_privileges', result: 'negative', confidence: 'low' },
]);

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. THE SCENARIO TABLE (mocked native reports → model verdicts)
 * ═══════════════════════════════════════════════════════════════════════════ */
section('1. Scenario table (mocked reports)');

{
  const v = model.evaluateRootDiagnostics({ checks: NORMAL_DEVICE });
  check('normal non-rooted device → NO root warning', v.rootDetected === false,
    JSON.stringify(v.contributingChecks.root_privileges));
  check('normal non-rooted device → NO root-management warning', v.rootManagementDetected === false,
    JSON.stringify(v.contributingChecks.root_management));
  check('the unreadable /debug_ramdisk scope is reported as inconclusive evidence',
    v.inconclusiveChecks.includes('artifact_probe_visibility'),
    v.inconclusiveChecks.join(','));
  check('no positive result at all on a clean device',
    NORMAL_DEVICE.every((c) => c.result !== 'positive'));
}

{
  // OLD BEHAVIOUR, for the record: the same observation used to set BOTH flags.
  const legacyVerdict = (present, denied) =>
    denied.length > 0 || present.some((p) => p !== '/data/adb');
  const legacyDenied = ['/debug_ramdisk/su', '/debug_ramdisk/magisk'];
  check('OLD rule: one EACCES under /debug_ramdisk set rootDetected AND magiskDetected',
    legacyVerdict([], legacyDenied) === true && legacyVerdict([], legacyDenied) === true,
    'both legacy verdicts read the same report');
  const v = model.evaluateRootDiagnostics({ checks: NORMAL_DEVICE });
  check('NEW rule: the same report decides nothing (the false positive is gone)',
    v.rootDetected === false && v.rootManagementDetected === false);
}

{
  // Magisk installed and NOT hidden: real artifacts visible.
  const realRoot = allNegative([
    { id: 'artifact_probe', category: 'root_privileges', result: 'positive', confidence: 'high',
      evidence: 'present=/data/adb/magisk,/data/adb/modules' },
    { id: 'artifact_probe', category: 'root_management', result: 'positive', confidence: 'high',
      evidence: 'present=/data/adb/magisk,/data/adb/modules' },
    { id: 'su_binary_paths', category: 'root_privileges', result: 'positive', confidence: 'high',
      evidence: 'present=/system/bin/su' },
    { id: 'magisk_paths', category: 'root_management', result: 'positive', confidence: 'high',
      evidence: 'present=/data/adb/modules' },
  ]);
  const v = model.evaluateRootDiagnostics({ checks: realRoot });
  check('genuinely rooted device → root detected', v.rootDetected === true);
  check('genuinely rooted device → management tool detected', v.rootManagementDetected === true);
  check('the shared artifact observation is named, not hidden',
    v.sharedObservations.includes('artifact_probe'), v.sharedObservations.join(','));
  check('independent su evidence also feeds the privilege verdict',
    v.contributingChecks.root_privileges.includes('su_binary_paths'));
  check('independent package/artifact evidence feeds the management verdict',
    v.contributingChecks.root_management.includes('magisk_paths'));
}

{
  // Magisk on the DenyList: only the data dir + unreadable children survive.
  const denyList = allNegative([
    { id: 'artifact_probe', category: 'root_privileges', result: 'positive', confidence: 'medium',
      evidence: 'data_dir=/data/adb unreadable=/data/adb/magisk,/data/adb/modules' },
    { id: 'artifact_probe', category: 'root_management', result: 'positive', confidence: 'medium',
      evidence: 'data_dir=/data/adb unreadable=/data/adb/magisk,/data/adb/modules' },
  ]);
  const v = model.evaluateRootDiagnostics({ checks: denyList });
  check('rooted + DenyList (data dir with unreadable children) → still detected',
    v.rootDetected === true && v.rootManagementDetected === true,
    JSON.stringify(v.contributingChecks));
}

{
  // A root-MANAGER install with all privilege evidence hidden: management only.
  const managerOnly = allNegative([
    { id: 'magisk_packages', category: 'root_management', result: 'positive', confidence: 'high',
      evidence: 'present=io.github.topjohnwu.magisk' },
  ]);
  const v = model.evaluateRootDiagnostics({ checks: managerOnly });
  check('management detection is INDEPENDENT of the privilege verdict',
    v.rootManagementDetected === true && v.rootDetected === false,
    JSON.stringify(v.contributingChecks));
}

{
  const unrelatedApp = allNegative();
  const v = model.evaluateRootDiagnostics({ checks: unrelatedApp });
  check('non-rooted device with an unrelated app → no management warning',
    v.rootManagementDetected === false && v.rootDetected === false);
  check('the check catalog contains no generic "installed apps" signal',
    !model.ROOT_CHECK_CATALOG.some((c) => /app_count|installedapps/i.test(c.id)));
}

{
  // Developer options / ADB are a SEPARATE policy bucket (debug), tested in
  // their own suites. They must never leak into a root verdict.
  const devSettings = allNegative([
    { id: 'build_props', category: 'root_privileges', result: 'negative', confidence: 'medium',
      evidence: 'ro.debuggable/ro.secure are release values' },
  ]);
  const v = model.evaluateRootDiagnostics({ checks: devSettings });
  check('ordinary developer/debug settings → no root verdict',
    v.rootDetected === false && v.rootManagementDetected === false);
  check('no developer-options signal exists in the root catalog',
    !model.ROOT_CHECK_CATALOG.some((c) => /developer|adb|debug/i.test(c.id)));
}

{
  // Android 11+ package visibility: the lookup itself could not run.
  const restricted = allNegative([
    { id: 'package_lookup', category: 'root_management', result: 'inconclusive', confidence: 'low',
      evidence: 'lookup_unavailable=com.topjohnwu.magisk' },
  ]);
  const v = model.evaluateRootDiagnostics({ checks: restricted });
  check('restricted package lookup → INCONCLUSIVE, not detected',
    v.rootManagementDetected === false && v.inconclusiveChecks.includes('package_lookup'),
    v.inconclusiveChecks.join(','));
}

{
  // An ambiguous filesystem artifact on its own (data dir whose children the
  // errno cannot classify, or a stray directory).
  const ambiguous = allNegative([
    { id: 'artifact_probe', category: 'root_privileges', result: 'inconclusive', confidence: 'low',
      evidence: 'unreadable_scope=/data/local/bin/su' },
    { id: 'artifact_probe', category: 'root_management', result: 'inconclusive', confidence: 'low',
      evidence: 'unreadable_scope=/data/local/bin/su' },
  ]);
  const v = model.evaluateRootDiagnostics({ checks: ambiguous });
  check('ambiguous filesystem artifact alone → NO definitive root verdict',
    v.rootDetected === false && v.rootManagementDetected === false);
}

{
  // A weak signal must not decide on its own.
  const testKeysOnly = allNegative([
    { id: 'test_keys', category: 'root_privileges', result: 'positive', confidence: 'low',
      evidence: 'Build.TAGS=test-keys' },
  ]);
  const v = model.evaluateRootDiagnostics({ checks: testKeysOnly });
  check('test-keys ROM alone → NOT classified as rooted', v.rootDetected === false);
  check('the weak signal is still visible (lowConfidenceOnly)', v.lowConfidenceOnly === true);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. Payload validation + diagnostics surface
 * ═══════════════════════════════════════════════════════════════════════════ */
section('2. Diagnostics payload (parse / normalize / describe)');

{
  check('parseRootDiagnostics rejects empty and garbage payloads',
    model.parseRootDiagnostics('') === null
    && model.parseRootDiagnostics('not json') === null
    && model.parseRootDiagnostics(null) === null
    && model.parseRootDiagnostics({ checks: [] }) === null);
  const parsed = model.parseRootDiagnostics(JSON.stringify({ checks: NORMAL_DEVICE }));
  check('parses a valid report', parsed !== null && parsed.checks.length === NORMAL_DEVICE.length);
  check('drops unknown check ids (catalog is the contract)',
    model.parseRootDiagnostics({ checks: [{ ...chk('made_up_check', 'root_privileges', 'positive', 'high') }] }) === null);
  const claimed = model.parseRootDiagnostics({
    checks: [{ id: 'test_keys', category: 'root_privileges', result: 'positive', confidence: 'low', evidence: 'x', contributes: true }],
  });
  check('a payload cannot claim a low-confidence result contributes',
    claimed !== null && claimed.checks[0].contributes === false);
  check('describeRootDiagnostics is one bounded, id-only line',
    model.describeRootDiagnostics({ checks: NORMAL_DEVICE }).startsWith('root=')
    && model.describeRootDiagnostics(null) === 'root_diagnostics=unavailable');
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. The generated Kotlin implements the same rules (static)
 * ═══════════════════════════════════════════════════════════════════════════ */
section('3. Kotlin: probe policy (what EACCES proves)');

{
  const target = (p) => {
    const m = new RegExp(`ProbeTarget\\("${p.replace(/\//g, '\\/')}"\\s*,\\s*ProbePolicy\\.([A-Z_]+)\\)`).exec(KT);
    return m ? m[1] : '';
  };
  check('stock /debug_ramdisk children are ROOT_ONLY_PARENT (never evidence on EACCES)',
    target('/debug_ramdisk/su') === 'ROOT_ONLY_PARENT'
    && target('/debug_ramdisk/magisk') === 'ROOT_ONLY_PARENT',
    `${target('/debug_ramdisk/su')} / ${target('/debug_ramdisk/magisk')}`);
  check('/data/local is AMBIGUOUS_PARENT (OEM/SELinux dependent)',
    target('/data/local/bin/su') === 'AMBIGUOUS_PARENT', target('/data/local/bin/su'));
  check('/data/adb children are ROOT_MANAGER_PARENT',
    target('/data/adb/magisk') === 'ROOT_MANAGER_PARENT', target('/data/adb/magisk'));
  check('system su paths stay SYSTEM_PARENT (EACCES ⇒ the child exists)',
    target('/system/bin/su') === 'SYSTEM_PARENT' && target('/sbin/su') === 'SYSTEM_PARENT');

  const probe = ktFunction('probeRootArtifacts');
  check('DENIED on a traversable parent is evidence; every other parent is inconclusive',
    /ProbePolicy\.SYSTEM_PARENT -> if \(denied\.size < 8\) denied\.add\(t\.path\)/.test(probe)
    && /else -> if \(indeterminate\.size < 8\) indeterminate\.add\(t\.path\)/.test(probe));
  check('the probe still classifies errno (EACCES≠ENOENT)',
    /OsConstants\.EACCES, OsConstants\.EPERM -> FsProbe\.DENIED/.test(ktFunction('probePath'))
    && /OsConstants\.ENOENT, OsConstants\.ENOTDIR -> FsProbe\.ABSENT/.test(ktFunction('probePath')));

  const evidence = ktFunction('hasRootFrameworkEvidence');
  check('the evidence rule requires a present data dir WITH unreadable children',
    /r\.dataDirWithDeniedChildren/.test(evidence));
  check('the old "ANY EACCES is evidence" wording is gone',
    !/ANY EACCES on the probe set is evidence/.test(KT));
  check('indeterminate paths are never counted as evidence',
    !/r\.indeterminate\.isNotEmpty\(\)\) return true/.test(KT));
}

section('4. Kotlin: independent verdicts, structured checks, confidence');

{
  const root = ktFunction('detectRoot');
  const magisk = ktFunction('detectMagisk');
  check('neither verdict reads the artifact probe directly any more',
    !/probeRootArtifacts\(\)/.test(root) && !/probeRootArtifacts\(\)/.test(magisk)
    && !/inspectMountView\(\)/.test(root) && !/inspectMountView\(\)/.test(magisk));
  check('both verdicts project from the SAME classified check list',
    /rootCheckResults\(\)/.test(root) && /rootCheckResults\(\)/.test(magisk));
  check('a verdict requires result==positive AND contributes',
    /result == ROOT_RESULT_POSITIVE && c\.contributes/.test(root)
    && /result == ROOT_RESULT_POSITIVE && c\.contributes/.test(magisk));
  check('the two verdicts filter on DIFFERENT categories',
    /ROOT_CAT_PRIVILEGES/.test(root) && !/ROOT_CAT_MANAGEMENT/.test(root)
    && /ROOT_CAT_MANAGEMENT/.test(magisk) && !/ROOT_CAT_PRIVILEGES/.test(magisk));
  check('low confidence can never contribute',
    /val contributes = positive && !inconclusive && confidence != ROOT_CONF_LOW/.test(KT));
  check('test-keys is LOW confidence (a build fact, not root)',
    /ROOT_CONF_LOW/.test(snippet('rootCheck("test_keys"')));
  check('dangerous build props are MEDIUM confidence',
    /ROOT_CONF_MEDIUM/.test(snippet('rootCheck("build_props"')));
  check('a present su binary is HIGH confidence',
    /ROOT_CONF_HIGH/.test(snippet('rootCheck("su_binary_paths"')));

  const results = ktFunction('rootCheckResults');
  for (const [id, cat] of ROOT_CHECK_IDS) {
    const catConst = cat === 'root_privileges' ? 'ROOT_CAT_PRIVILEGES' : 'ROOT_CAT_MANAGEMENT';
    check(`catalog entry emitted: ${id} / ${cat}`, results.includes(`rootCheck("${id}", ${catConst}`));
  }
}

section('5. Kotlin: package visibility + mount rule hardening');

{
  const probe = ktFunction('packageProbe');
  check('NameNotFound → absent (declared in <queries>), everything else → unknown',
    /PackageManager\.NameNotFoundException/.test(probe) && /"unknown"/.test(probe)
    && /"absent"/.test(probe) && /"present"/.test(probe));
  check('a failed lookup is reported, not silently clean',
    /"unknown" -> if \(unknownOut\.size < 8\) unknownOut\.add\(p\)/.test(ktFunction('packagesPresent')));
  check('the package catalog is still declared in <queries> (unchanged)',
    /SECURITY_CHECK_PACKAGES/.test(PLUGIN));

  // The CODE line only — the comment above it explains WHY generic /data
  // backing was dropped and therefore mentions the old substrings.
  const dataBackedLine = (KT.match(/val dataBacked = .*/) || [''])[0].trim();
  check('the mount rule requires /data/adb (no generic /data backing)',
    dataBackedLine === 'val dataBacked = hay.contains("/data/adb")', dataBackedLine);
  check('the mount rule still catches Magisk/KernelSU/APatch module mounts',
    /overSystem && dataBacked ->/.test(KT) && /magiskNamed \|\| mntPoint\.startsWith\("\/data\/adb"\)/.test(KT));
}

section('6. Diagnostics exposure (native → JS), no student-facing UI');

{
  check('the batch ships structured diagnostics',
    /r\.putString\("rootDiagnostics", rootDiagnosticsJson\(\)\)/.test(KT));
  check('an on-demand diagnostics method exists',
    /@ReactMethod\s*\n\s*fun getRootDiagnostics\(promise: Promise\)/.test(KT));
  check('its failure path rejects (never a silent empty report)',
    /promise\.reject\("root_diagnostics_failed"/.test(KT));
  check('each check reports id/category/result/evidence/confidence/contributes',
    ['"id"', '"category"', '"result"', '"evidence"', '"confidence"', '"contributes"']
      .every((f) => ktFunction('rootDiagnosticsJson').includes(f)));
  check('shared observations are reported explicitly',
    /"sharedObservations"/.test(ktFunction('rootDiagnosticsJson')));
  check('the evidence surface exposes the indeterminate bucket',
    /o\.put\("indeterminate"/.test(KT) && /o\.put\("managerDenied"/.test(KT));
  check('diagnostics contain no user identity or secret fields',
    !/email|token|userId|sessionId|password/i.test(ktFunction('rootDiagnosticsJson')));

  check('TS parses the native diagnostics into a typed report',
    /rootDiagnostics\?:\s*RootDiagnosticsReport/.test(NATIVE_TS)
    && /function withRootDiagnostics/.test(NATIVE_TS));
  check('TS exposes an on-demand accessor', /export async function getRootDetectionDiagnostics/.test(NATIVE_TS));
  check('TS declares the new probe buckets',
    /indeterminate\?:\s*string\[\]/.test(NATIVE_TS) && /managerDenied\?:\s*string\[\]/.test(NATIVE_TS));
  check('the diagnostics log line is internal only (DEV / operator flag)',
    /EXPO_PUBLIC_SECURITY_DIAGNOSTICS/.test(SECURITY_TS)
    && !/rootDiagnostics/.test(read('src/app/(app)/security-warning.tsx')));
}

section('7. Security preserved: no weakened checks, no policy drift');

{
  check('root_detected keeps its weight (35)', /root_detected:\s+35,/.test(SECURITY_TS));
  check('magisk_detected keeps its weight (25)', /magisk_detected:\s+25,/.test(SECURITY_TS));
  check('root/magisk policies stay block_login',
    /root_jailbreak:\s+'block_login'/.test(SECURITY_TS) && /magisk:\s+'block_login'/.test(SECURITY_TS));
  check('the events are still distinct findings (no merged bucket)',
    /root_jailbreak:\s+\['root_detected', 'jailbreak_detected'\]/.test(SECURITY_TS)
    && /magisk:\s+\['magisk_detected'\]/.test(SECURITY_TS));
  check('magisk detection does not consume rootDetected',
    !/magiskDetected\s*=\s*.*rootDetected/.test(SECURITY_TS));
  check('Xposed / Frida / Zygisk checks are untouched',
    /private fun detectXposed\(\)/.test(KT) && /private fun detectFrida\(\)/.test(KT)
    && /private fun checkZygisk\(\)/.test(KT)
    && /XPOSED_LIB_NEEDLES/.test(KT) && /FRIDA_LIB_NEEDLES/.test(KT));
  check('the iOS module sources are not part of this change',
    !/rootDetectionModel/.test(read('plugins/ios/IOSSecurityModule.swift')));
}

section('8. Structure: the plugin still generates valid Kotlin');

{
  let pluginOk = false;
  try { pluginOk = typeof require(path.join(ROOT, 'plugins', 'withSecurityModule.js')) === 'function'; }
  catch (e) { console.error('       require threw:', e.message); }
  check('the config plugin still loads (template literal intact)', pluginOk);
  check('the Kotlin template is present', KT.length > 1000, `${KT.length} chars`);

  for (const fn of ['detectRoot', 'detectMagisk', 'probeRootArtifacts', 'rootCheckResults',
    'rootObservations', 'artifactVerdict', 'rootDiagnosticsJson', 'hasRootFrameworkEvidence']) {
    const body = braceBody(`private fun ${fn}(`);
    check(`${fn}() braces balance`, body.length > 0 && bracesBalanced(body), `${body.length} chars`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nRoot false-positive suite FAILED');
  process.exit(1);
}
console.log('Root false-positive suite passed (mocked model + static native checks — no device run)');
