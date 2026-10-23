#!/usr/bin/env node
/* eslint-env node */
/**
 * rootDetectionSecondPass.test.cjs
 *
 * Pins the second-pass root/Magisk/Zygisk/LSPosed audit changes:
 *
 *   1. The C++ obfuscated hook-indicator table decodes to exactly the expected
 *      names (including the new LSPosed/Riru/Zygisk/LSPatch rows) — an
 *      encoding typo would silently disable every native maps signal.
 *   2. Package-visibility sync: every package the Kotlin detectors probe is
 *      declared in <queries> (Android 11+ otherwise answers NameNotFound for
 *      all of them — the checks were dead code without this).
 *   3. Fail-open conversion: no check inside getSecurityFlags() silently
 *      resolves a thrown probe to "clean"; failures land in
 *      detectionsUnavailable while default VALUES stay unchanged (no new
 *      blocking path).
 *   4. The C++ core (libmedasec) is actually wired: detect* consult it, the
 *      batch exports its status, and the TS layer declares the fields.
 *   5. LSPosed-class in-process needles exist in BOTH the Kotlin verdict path
 *      and the C++ table (with coverage parity), and the verdict needles stay
 *      tight (no bare "gadget" false-positive surface).
 *   6. Provenance arrays are emitted per detector (shared-source visibility)
 *      and the duplicate /proc/self/maps readers were consolidated into one
 *      memoised snapshot.
 *   7. hidepid-awareness: the process scan reports UNAVAILABLE on Android 10+
 *      instead of implying "no frida process".
 *
 * Every assertion reads files on disk. None of this claims a device test.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const PLUGIN = read('plugins/withSecurityModule.js');
const KT_MATCH = PLUGIN.match(/const SECURITY_MODULE_KT = `([\s\S]*?)\n`;\n/);
const KT = KT_MATCH ? KT_MATCH[1] : '';
const NATIVE_TS = read('src/lib/nativeSecurity.ts');
const SECURITY_TS = read('src/lib/security.ts');
const DEVICE_KEY_TS = read('src/lib/deviceKey.ts');

// Kotlin body of one member, bounded by the next top-level member.
function ktFunction(name) {
  const start = KT.indexOf(`private fun ${name}(`);
  if (start < 0) return '';
  const rest = KT.slice(start + 10);
  const next = rest.search(/\n    (private )?(fun|data class|enum class|object|@ReactMethod)/);
  return next < 0 ? rest : rest.slice(0, next);
}

// Public fun variant (getSecurityFlags has no `private` modifier).
function ktPublicFunction(name) {
  const start = KT.indexOf(`    fun ${name}(`);
  if (start < 0) return '';
  const rest = KT.slice(start + 6);
  const next = rest.search(/\n    (private )?(fun|data class|enum class|object|@ReactMethod)/);
  return next < 0 ? rest : rest.slice(0, next);
}

console.log('\n── Sources ──────────────────────────────────────────────────');
check('Kotlin template extracted', KT.length > 1000, `extracted ${KT.length} chars`);

// ═══════════════════════════════════════════════════════════════════════════
// 1. C++ XOR hook-indicator table decodes to the expected names
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── 1. C++ hook-indicator table (decode == expectation) ──────');

const EXPECTED_HOOK_NAMES = [
  // pre-existing rows (pass 1)
  'libfrida', 'frida-agent', 'libgum-js-loop', 'gadget', 'libxposed',
  'libsubstrate', 'libmsf', 'libgadget', 'libgameguardian', 'libgg',
  // second-pass rows (LSPosed/Riru/Zygisk/LSPatch era)
  'lspd', 'riru', 'lsplant', 'zygisk', 'lspatch', 'edxp', 'yahfa',
];

{
  const encStart = PLUGIN.indexOf('kHookIndicatorsEnc[] = {');
  check('kHookIndicatorsEnc table present in the C++ source', encStart > 0);
  const encEnd = PLUGIN.indexOf('};', encStart);
  const region = PLUGIN.slice(encStart, encEnd);

  const rowRe = /\{(\d+),\s*\{([0-9a-fx,\s]+)\}\}/g;
  const decoded = [];
  let badRows = 0;
  let m;
  while ((m = rowRe.exec(region)) !== null) {
    const len = parseInt(m[1], 10);
    const cells = m[2].split(',').map((s) => parseInt(s.trim(), 16));
    if (!Number.isFinite(len) || cells.some((c) => !Number.isFinite(c)) || len > cells.length) {
      badRows++;
      continue;
    }
    const name = cells
      .slice(0, len)
      .map((b) => String.fromCharCode(b ^ 0x5a))
      .join('');
    decoded.push(name);
  }

  check('every row parses and stays within the 20-byte struct', badRows === 0, `${badRows} bad rows`);
  check(
    'the decoded table equals the expected set exactly',
    decoded.length === EXPECTED_HOOK_NAMES.length &&
      EXPECTED_HOOK_NAMES.every((n) => decoded.includes(n)),
    `decoded=[${decoded.join(',')}]`,
  );
  check(
    'second-pass LSPosed/Riru/Zygisk rows are present',
    ['lspd', 'riru', 'lsplant', 'zygisk', 'lspatch', 'edxp', 'yahfa']
      .every((n) => decoded.includes(n)),
    `decoded=[${decoded.join(',')}]`,
  );
  const printable = decoded.every((n) => /^[a-z0-9._-]+$/.test(n));
  check('no row decodes to garbage (an encoding typo would read as noise)', printable);
  check(
    'the rows are documented as evidence-only in the file header',
    /EVIDENCE for the signed security-evidence schema/.test(PLUGIN),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Package visibility: Kotlin probe lists ⊆ <queries> catalogs
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── 2. Package visibility (<queries> sync) ──────────────────');

function ktStringList(valName) {
  const re = new RegExp(`val ${valName} = listOf\\(`);
  const m = re.exec(KT);
  if (!m) return [];
  // Balance parens from the opening one: the list body contains doc comments
  // with their own parentheses, which would truncate a naive non-greedy match.
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < KT.length && depth > 0) {
    if (KT[i] === '(') depth++;
    else if (KT[i] === ')') depth--;
    i++;
  }
  const body = KT.slice(start, i - 1);
  return [...body.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function jsStringList(constName) {
  const re = new RegExp(`const ${constName} = \\[([\\s\\S]*?)\\];`);
  const m = PLUGIN.match(re);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const kotlinPackages = [
  ...ktStringList('rootPackages'),
  ...ktStringList('magiskPackages'),
  ...ktStringList('xposedPackages'),
];
const queriesPackages = [
  ...jsStringList('SECURITY_CHECK_PACKAGES'),
  ...jsStringList('TARGET_APP_CATALOG'),
];

check('the Kotlin detectors expose three package lists', kotlinPackages.length >= 24,
  `found ${kotlinPackages.length}`);
check('the plugin declares SECURITY_CHECK_PACKAGES', jsStringList('SECURITY_CHECK_PACKAGES').length >= 20);

const missingFromQueries = kotlinPackages.filter((p) => !queriesPackages.includes(p));
check(
  'every Kotlin-probed package is declared in <queries> (else dead on Android 11+)',
  missingFromQueries.length === 0,
  `missing: ${missingFromQueries.join(', ')}`,
);

for (const pkg of ['io.github.topjohnwu.magisk', 'me.weishu.kernelsu', 'me.bmax.apatch']) {
  check(`modern root-manager ID covered: ${pkg}`,
    kotlinPackages.includes(pkg) && queriesPackages.includes(pkg));
}

const manifestBody = PLUGIN.slice(
  PLUGIN.indexOf('const withTargetAppQueries'),
  PLUGIN.indexOf('const withOverlayWindowPermission'),
);
check('the injection loop merges both catalogs',
  /\[\.\.\.TARGET_APP_CATALOG, \.\.\.SECURITY_CHECK_PACKAGES\]/.test(manifestBody));
check('scoped <queries> is used (no QUERY_ALL_PACKAGES permission)'
  , !/android\.permission\.QUERY_ALL_PACKAGES/.test(PLUGIN) && /withTargetAppQueries/.test(PLUGIN));

// ═══════════════════════════════════════════════════════════════════════════
// 3. Fail-open → detectionsUnavailable (values unchanged, availability added)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── 3. Fail-open conversion in getSecurityFlags() ───────────');

const FLAGS = ktPublicFunction('getSecurityFlags');
check('getSecurityFlags() extracted', FLAGS.length > 1000, `extracted ${FLAGS.length} chars`);
check('declares the unavailable accumulator',
  /val unavailable = ArrayList<String>/.test(FLAGS));
check('emits detectionsUnavailable to JS',
  /putStringList\(r, "detectionsUnavailable", unavailable\)/.test(FLAGS));

const recordedChecks = [
  'developerOptions', 'adbEnabled', 'debugger', 'testOnlyBuild', 'screenRecording',
  'frida', 'xposed', 'magisk', 'overlay', 'signatureCheck', 'tamper',
  'vpn', 'root', 'emulator',
];
const missingRecords = recordedChecks.filter((c) => !FLAGS.includes(`unavailable.add("${c}")`));
check('every batch check records its failure by name', missingRecords.length === 0,
  `missing: ${missingRecords.join(', ')}`);

check('no silent getOrDefault remains in the batch',
  !/getOrDefault\((false|true)\)/.test(FLAGS),
  (FLAGS.match(/getOrDefault\((false|true)\)/g) || []).join(', '));

// The batch regex pinned by tests/rootArtifactDenyList.test.cjs must survive.
check('magisk/root still flow through the same detectors (no parallel path)',
  /val magisk\s+= runCatching \{ detectMagisk\(\)\s*\}/.test(PLUGIN) &&
  /val rooted\s+= runCatching \{ detectRoot\(\)/.test(PLUGIN));

// No NEW blocking path: the signature value keeps its fail-safe default on
// exception; only availability is recorded. Locate the getOrElse block and
// require `true` as its result expression.
{
  const sigIdx = FLAGS.indexOf('checkSignatureValid() }.getOrElse');
  const sigBlock = sigIdx >= 0 ? FLAGS.slice(sigIdx, sigIdx + 700) : '';
  check('a thrown signature check does NOT flip the verdict value',
    sigBlock.includes('unavailable.add("signatureCheck")') &&
    /unavailable\.add\("signatureCheck"\)[\s\S]{0,80}\n\s*true\s*\n\s*\}/.test(sigBlock),
    sigBlock.slice(0, 300));
}
check('sub-check availability: hidepid process scan',
  FLAGS.includes('if (!_fridaProcessScanAvailable) unavailable.add("fridaProcessScan")'));
check('sub-check availability: unreadable maps',
  FLAGS.includes('if (_procMapsUnreadable) unavailable.add("procMapsScan")'));
check('sub-check availability: missing native core',
  FLAGS.includes('if (!core.available) unavailable.add("nativeCore")'));

// ═══════════════════════════════════════════════════════════════════════════
// 4. C++ core wiring (was previously unreachable from JS)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── 4. libmedasec core is wired into verdicts + batch ───────');

const fridaBody = ktFunction('detectFrida');
const xposedBody = ktFunction('detectXposed');
const zygiskBody = ktFunction('checkZygisk');
check('detectFrida() consults the C++ core', /coreRaspEvidence\(\)/.test(fridaBody));
check('detectXposed() consults the C++ core', /coreRaspEvidence\(\)/.test(xposedBody));
check('checkZygisk() consults the C++ core', /coreRaspEvidence\(\)/.test(zygiskBody));
check('coreRaspEvidence() memoises (one parse per batch)',
  /private fun coreRaspEvidence\(\)/.test(KT) && /_coreRaspCache/.test(KT));
check('batch exports core availability + hook-lib evidence',
  FLAGS.includes('r.putBoolean("coreAvailable", core.available)') &&
  FLAGS.includes('r.putBoolean("coreHookLibs", core.hookLibs.isNotEmpty())') &&
  FLAGS.includes('putStringList(r, "coreHookLibNames", core.hookLibs)') &&
  FLAGS.includes('r.putInt("coreFridaThreads", core.fridaThreads)') &&
  FLAGS.includes('r.putBoolean("coreThreadMismatch", core.threadMismatch)'));
check('the dead getNativeCoreSnapshot-only path is no longer the only surface',
  /fun getNativeCoreSnapshot\(promise: Promise\)/.test(KT)); // still exists for diagnostics

// TS side
check('TS declares the core + second-pass fields',
  /coreHookLibNames\?:\s*string\[\];/.test(NATIVE_TS) &&
  /detectionsUnavailable\?:\s*string\[\];/.test(NATIVE_TS) &&
  /rootEvidenceSignals\?:\s*string\[\];/.test(NATIVE_TS) &&
  /magiskEvidenceSignals\?:\s*string\[\];/.test(NATIVE_TS));
check('SAFE_FLAGS does NOT claim detectionsUnavailable=[] (a failed batch must not read as "all ran")',
  !/detectionsUnavailable:/.test(NATIVE_TS.slice(NATIVE_TS.indexOf('const SAFE_FLAGS'),
    NATIVE_TS.indexOf('function getModule'))));

// ═══════════════════════════════════════════════════════════════════════════
// 5. LSPosed-class needles: present, tight, and covered by the C++ table
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── 5. LSPosed/Xposed in-process needles ────────────────────');

const xposedNeedlesMatch = KT.match(/private val XPOSED_LIB_NEEDLES = listOf\(\s*([^)]*)\)/);
const xposedNeedles = xposedNeedlesMatch
  ? [...xposedNeedlesMatch[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
  : [];
check('XPOSED_LIB_NEEDLES declared with LSPosed-era names',
  ['xposed', 'lspd', 'riru', 'lsplant', 'lspatch', 'edxp', 'yahfa', 'substrate']
    .every((n) => xposedNeedles.includes(n)),
  `found=[${xposedNeedles.join(',')}]`);
check('detectXposed() scans its own maps with those needles',
  /mapsHas\(XPOSED_LIB_NEEDLES\)/.test(xposedBody));

// Parity: every Kotlin verdict needle must be reachable from a C++ decoded
// row (otherwise the core path could never fire for that needle).
{
  const encStart = PLUGIN.indexOf('kHookIndicatorsEnc[] = {');
  const encEnd = PLUGIN.indexOf('};', encStart);
  const region = PLUGIN.slice(encStart, encEnd);
  const rowRe = /\{(\d+),\s*\{([0-9a-fx,\s]+)\}\}/g;
  const decoded = [];
  let m;
  while ((m = rowRe.exec(region)) !== null) {
    const len = parseInt(m[1], 10);
    const cells = m[2].split(',').map((s) => parseInt(s.trim(), 16));
    decoded.push(cells.slice(0, len).map((b) => String.fromCharCode(b ^ 0x5a)).join(''));
  }
  const uncovered = xposedNeedles.filter((n) => !decoded.some((d) => d.includes(n)));
  check('every XPOSED verdict needle is covered by a C++ table row', uncovered.length === 0,
    `uncovered: ${uncovered.join(', ')}`);
}

const fridaNeedlesMatch = KT.match(/private val FRIDA_LIB_NEEDLES = listOf\("([^"]*)", "([^"]*)", "([^"]*)"\)/);
const fridaNeedles = fridaNeedlesMatch ? fridaNeedlesMatch.slice(1) : [];
check('FRIDA verdict needles stay tight (no bare "gadget")',
  fridaNeedles.length === 3 && !fridaNeedles.includes('gadget'),
  `found=[${fridaNeedles.join(',')}]`);
check('checkProcMapsForFrida() uses the tight needle set',
  /mapsHas\(FRIDA_LIB_NEEDLES\)/.test(ktFunction('checkProcMapsForFrida')));
check('the duplicate checkLoadedLibraries() scan is gone',
  !/private fun checkLoadedLibraries/.test(KT) && !/checkLoadedLibraries\(\)/.test(fridaBody));

// ═══════════════════════════════════════════════════════════════════════════
// 6. Provenance arrays + snapshot consolidation
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── 6. Evidence provenance + one consistent snapshot ────────');

for (const [fn, field] of [
  ['detectRoot', '_lastRootSignals'],
  ['detectMagisk', '_lastMagiskSignals'],
  ['detectFrida', '_lastFridaSignals'],
  ['detectXposed', '_lastXposedSignals'],
]) {
  const body = ktFunction(fn);
  check(`${fn}() records provenance in a finally block`,
    new RegExp(`finally \\{\\s*\\n\\s*${field} = signals\\.toList\\(\\)`).test(body),
    body.slice(-200));
  check(`${fn}() names its individual signals`,
    (body.match(/signals\.add\("/g) || []).length >= 4);
}
check('batch exports all four provenance arrays',
  ['rootEvidenceSignals', 'magiskEvidenceSignals', 'fridaEvidenceSignals', 'xposedEvidenceSignals']
    .every((k) => FLAGS.includes(`putStringList(r, "${k}"`)));
check('the shared-source caveat is documented at the emission site',
  /shared source visible instead of two look-like confirmations/.test(FLAGS));

// Exactly ONE reader of /proc/self/maps in Kotlin now (the memoised snapshot).
const mapsReads = (KT.match(/File\("\/proc\/self\/maps"\)/g) || []).length;
check('one /proc/self/maps reader (memoised snapshot)', mapsReads === 1, `found ${mapsReads}`);
check('the snapshot distinguishes read-failure (null) from empty',
  /private fun procMapsLines\(\): List<String>\?/.test(KT) &&
  /_procMapsUnreadable = true/.test(KT));

// Artifact probe memoised so one batch sees one consistent probe pass.
check('probeRootArtifacts() memoised (≤3 stat passes per batch → 1)',
  /_rootArtifactsCache/.test(KT));

// ═══════════════════════════════════════════════════════════════════════════
// 7. hidepid awareness (process scan reports UNKNOWN, not clean)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── 7. hidepid / availability of the process scan ───────────');

const scanBody = ktFunction('scanProcessesForFrida');
check('mountinfo parser captures hidepid', /indexOf\("hidepid="\)/.test(ktFunction('inspectMountView')));
check('_procHidepid declared (null = unknown)', /private var _procHidepid: Boolean\? = null/.test(KT));
check('the scan reports itself unavailable under hidepid',
  /_procHidepid == true \|\| \(listed > 4 && readable == 0\)/.test(scanBody));
check('the scan resets availability per run',
  /_fridaProcessScanAvailable = true/.test(fridaBody) &&
  /_fridaProcessScanAvailable = false/.test(scanBody));
check('the scan still detects a genuine foreign match',
  /text\.contains\("frida"\) \|\| text\.contains\("gadget"\)/.test(scanBody));

// ═══════════════════════════════════════════════════════════════════════════
// 8. Kotlin structural balance (cheapest guard against a broken prebuild)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── 8. Kotlin template structural checks ────────────────────');

for (const fn of ['detectRoot', 'detectMagisk', 'detectFrida', 'detectXposed',
  'checkZygisk', 'scanProcessesForFrida', 'probeRootArtifacts']) {
  const body = ktFunction(fn);
  let depth = 0;
  let min = 0;
  for (const ch of body) {
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth < min) min = depth; }
  }
  check(`${fn}() braces balance`, body.length > 0 && depth === 0 && min === 0,
    `depth=${depth} min=${min}`);
}
{
  const flagsBody = ktPublicFunction('getSecurityFlags');
  let depth = 0;
  let min = 0;
  for (const ch of flagsBody) {
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth < min) min = depth; }
  }
  check('getSecurityFlags() braces balance', depth === 0 && min === 0, `depth=${depth} min=${min}`);
}
check('detectZygisk helper no longer reads /proc/modules as an oracle',
  !/File\("\/proc\/modules"\)/.test(zygiskBody) && /inspectMountView\(\)/.test(zygiskBody));
check('the plugin module still loads (template literal intact)', (() => {
  try {
    const mod = require(path.join(ROOT, 'plugins', 'withSecurityModule.js'));
    return typeof mod === 'function';
  } catch (e) {
    console.error('       require threw:', e.message);
    return false;
  }
})());

// ═══════════════════════════════════════════════════════════════════════════
// 9. JS-side availability is surfaced, weight-0, and never blocking
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── 9. JS evidence surface (observability only) ─────────────');

check('SecurityEvidence carries unavailableChecks',
  /unavailableChecks\?:\s*string\[\];/.test(SECURITY_TS));
check('runSecurityChecks() populates it from the native flags',
  /unavailableChecks:\s*rawFlags\?\.detectionsUnavailable \?\? undefined/.test(SECURITY_TS));
check('partial degradation fires a log_only, weight-0 telemetry event',
  /reportPartialDetectionUnavailableOnce/.test(SECURITY_TS) &&
  /eventType: 'detection_unavailable'/.test(SECURITY_TS));
{
  const fnStart = SECURITY_TS.indexOf('function reportPartialDetectionUnavailableOnce');
  const fnBody = SECURITY_TS.slice(fnStart, fnStart + 900);
  check('the partial telemetry is bounded and never escalates',
    /slice\(0, 24\)/.test(fnBody) && /policyAction: 'log_only'/.test(fnBody) &&
    /riskScore: 0/.test(fnBody));
}
check('partial telemetry cannot block (capped list, catch-all)',
  /void reportPartialDetectionUnavailableOnce\(unavailableChecks\)/.test(SECURITY_TS));
check('signed evidence carries checks_unavailable only when non-empty',
  /checks_unavailable = flags\.detectionsUnavailable\.slice\(0, 24\)/.test(DEVICE_KEY_TS) &&
  /Array\.isArray\(flags\.detectionsUnavailable\) && flags\.detectionsUnavailable\.length > 0/.test(DEVICE_KEY_TS));
check('the root-artifact evidence surface now has a real consumer (signed bundle)',
  /getNativeRootArtifactEvidence/.test(DEVICE_KEY_TS) &&
  /out\.root_evidence = \{/.test(DEVICE_KEY_TS));
check('root_evidence rides the evidence map inside a best-effort guard',
  /catch \{ \/\* evidence surface is optional/.test(DEVICE_KEY_TS));
check('optional fields are dropped before the server 8 KB cap can reject the round',
  /OPTIONAL_EVIDENCE_BUDGET_BYTES = 7000/.test(DEVICE_KEY_TS) &&
  /delete ev\.root_evidence/.test(DEVICE_KEY_TS) &&
  /delete ev\.checks_unavailable/.test(DEVICE_KEY_TS));
check('no weights, event types or policies were touched by this pass',
  !/detectionsUnavailable.*weight|new weight/i.test(SECURITY_TS));

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
