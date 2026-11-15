#!/usr/bin/env node
/**
 * tests/rootArtifactDenyList.test.cjs
 *
 * Magisk DenyList / LSPosed hardening — the native root-framework artifact probe.
 *
 * WHY THIS SUITE EXISTS
 *   The reproduction case is: rooted device + Magisk + LSPosed is detected, the
 *   app is added to Magisk's DenyList, and detection goes quiet. The audit found
 *   the cause is structural, not a missing package name: DenyList scrubs the
 *   MOUNT namespace (no /sbin/.magisk, no /system overlays carrying su, no
 *   Magisk/LSPosed packages), and the old checks additionally used
 *   File.exists(), which answers FALSE for EACCES — so the two /data/adb paths
 *   that still exist on a rooted device never fired either.
 *
 *   This suite locks in the replacement signal and its guard rails:
 *     • the probe is based on stat() + ERRNO (PRESENT / DENIED / ABSENT), so
 *       "exists but is root-only" is distinguishable from "does not exist";
 *     • it runs FIRST in both magisk and root detection;
 *     • a bare /data/adb directory alone cannot flag a device (false-positive
 *       guard), while an unreadable child can;
 *     • the evidence bridge rejects (never resolves "clean") on failure, and the
 *       JS accessor returns null (UNKNOWN) for anything malformed.
 *
 * What this suite CANNOT prove: that a real DenyList device is detected. That
 * needs the physical test matrix in the report; none of it is claimed here.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) {
    passed++;
  } else {
    failures.push(label + (detail ? ' — ' + detail : ''));
    console.log('  ✗ ' + label + (detail ? ' — ' + detail : ''));
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function section(title) {
  console.log('\n── ' + title + ' ──');
}

const plugin = read('plugins/withSecurityModule.js');
const bridge = read('src/lib/nativeSecurity.ts');

/* ── 1. The probe uses stat() + errno, not File.exists() ─────────────────── */

section('1. DenyList-resistant probe: errno, not existence');

ok('probes with Os.stat (preserves EACCES vs ENOENT)',
  /Os\.stat\(path\)/.test(plugin) && /import android\.system\.Os\b/.test(plugin));
ok('classifies EACCES/EPERM as DENIED',
  /OsConstants\.EACCES, OsConstants\.EPERM -> FsProbe\.DENIED/.test(plugin));
ok('classifies ENOENT/ENOTDIR as ABSENT',
  /OsConstants\.ENOENT, OsConstants\.ENOTDIR -> FsProbe\.ABSENT/.test(plugin));
ok('keeps a three-state result (PRESENT / DENIED / ABSENT) plus UNKNOWN',
  /private enum class FsProbe \{ PRESENT, DENIED, ABSENT, UNKNOWN \}/.test(plugin));
ok('carries the buckets as separate lists (incl. the false-positive split)',
  /private data class RootArtifactReport\(\s*val present: List<String>/.test(plugin) &&
  ['denied', 'managerDenied', 'indeterminate', 'unreadable']
    .every((f) => new RegExp(`val ${f}: List<String>`).test(plugin)));
ok('buffers are bounded (no unbounded path list growth)',
  /if \(present\.size < 8\) present\.add\(t\.path\)/.test(plugin) &&
  /if \(denied\.size < 8\) denied\.add\(t\.path\)/.test(plugin) &&
  /if \(indeterminate\.size < 8\) indeterminate\.add\(t\.path\)/.test(plugin));

/* The paths that survive DenyList: the data directory and its children. */
section('2. The probe targets the paths DenyList cannot unmount');
{
  // The probe set moved into ROOT_PROBE_TARGETS (path + policy per target) so
  // each path declares what an EACCES on it actually proves. The probe function
  // itself only classifies.
  const targetsStart = plugin.indexOf('private val ROOT_PROBE_TARGETS');
  const targets = targetsStart < 0 ? '' : plugin.slice(targetsStart, plugin.indexOf('\n    )', targetsStart));
  ok('stats the /data/adb directory itself', /"\/data\/adb",/.test(targets));
  ok('stats Magisk data children', /"\/data\/adb\/magisk"/.test(targets) && /"\/data\/adb\/magisk\.db"/.test(targets));
  ok('stats /data/adb/modules (module inventory)', /"\/data\/adb\/modules"/.test(targets));
  ok('stats the LSPosed module data dir', /"\/data\/adb\/lspd"/.test(targets));
  ok('covers KernelSU and APatch conventions', /"\/data\/adb\/ksu"/.test(targets) && /"\/data\/adb\/ap"/.test(targets));
  ok('still probes classic su binaries (visible when NOT on the DenyList)',
    /"\/system\/bin\/su"/.test(targets) && /"\/debug_ramdisk\/su"/.test(targets));
  const probeFn = plugin.slice(plugin.indexOf('private fun probeRootArtifacts()'));
  const body = probeFn.slice(0, probeFn.indexOf('private fun hasRootFrameworkEvidence'));
  ok('the probe itself never uses File.exists() (it would drop EACCES)',
    !/File\(/.test(body), 'File() appears in probeRootArtifacts');
}

/* ── 3. The evidence rule and its false-positive guard ────────────────────── */

section('3. Evidence rule (executed model)');

/** Mirrors hasRootFrameworkEvidence() in the Kotlin template. */
function hasRootFrameworkEvidence(r) {
  const managerDenied = r.managerDenied ?? [];
  if (r.denied.length > 0) return true;
  if (r.present.includes('/data/adb') && managerDenied.length > 0) return true;
  return r.present.some((p) => p !== '/data/adb');
}

ok('bare /data/adb only → NOT evidence (legitimate leftover cannot block)',
  hasRootFrameworkEvidence({ present: ['/data/adb'], denied: [], unreadable: [] }) === false);
ok('unreadable child on a traversable parent (EACCES) → evidence',
  hasRootFrameworkEvidence({ present: [], denied: ['/system/bin/su'], unreadable: [] }) === true);
ok('/data/adb PRESENT with unreadable children → evidence (DenyList case)',
  hasRootFrameworkEvidence({ present: ['/data/adb'], denied: [], managerDenied: ['/data/adb/magisk'] }) === true);
ok('visible su binary → evidence',
  hasRootFrameworkEvidence({ present: ['/system/bin/su'], denied: [], unreadable: [] }) === true);
ok('nothing found → no evidence',
  hasRootFrameworkEvidence({ present: [], denied: [], unreadable: [] }) === false);
ok('probe errors alone are not evidence (UNKNOWN ≠ clean, UNKNOWN ≠ guilty)',
  hasRootFrameworkEvidence({ present: [], denied: [], unreadable: ['/data/adb'] }) === false);
ok('FALSE-POSITIVE GUARD: an unreadable root-only parent is not evidence',
  hasRootFrameworkEvidence({
    present: [], denied: [], managerDenied: [],
    indeterminate: ['/debug_ramdisk/su', '/debug_ramdisk/magisk'], unreadable: [],
  }) === false);
ok('the Kotlin rule matches the model',
  /fun hasRootFrameworkEvidence\(r: RootArtifactReport\): Boolean \{\s*if \(r\.denied\.isNotEmpty\(\)\) return true\s*if \(r\.dataDirWithDeniedChildren\) return true\s*return r\.present\.any \{ it != "\/data\/adb" \}/.test(plugin));

/* ── 4. Wiring: the probe runs BEFORE the artifact-dependent checks ───────── */

section('4. Wiring order in the generated Kotlin');

{
  const at = (needle) => plugin.indexOf(needle);
  const observeStart = at('private fun rootObservations()');
  const observeBody = observeStart < 0 ? '' : plugin.slice(observeStart, plugin.indexOf('\n    /** Classified artifact-probe outcome', observeStart));
  const checksStart = at('private fun rootCheckResults()');
  const checksBody = checksStart < 0 ? '' : plugin.slice(checksStart, at('\n    /** Structured diagnostic document'));

  // The probe and every other observation now live in ONE snapshot, and BOTH
  // verdicts are projections over the classified checks — the shared-boolean
  // path that produced "root AND magisk from one EACCES" no longer exists.
  ok('the artifact probe is part of the single observation snapshot',
    /artifacts = probeRootArtifacts\(\)/.test(observeBody));
  ok('artifact_probe is emitted FIRST in the check list (DenyList-resistant priority)',
    checksBody.indexOf('rootCheck("artifact_probe"') !== -1 &&
    checksBody.indexOf('rootCheck("artifact_probe"') < checksBody.indexOf('rootCheck("su_binary_paths"'));
  ok('the artifact verdict is shared by both categories explicitly',
    /rootCheck\("artifact_probe", ROOT_CAT_PRIVILEGES/.test(checksBody) &&
    /rootCheck\("artifact_probe", ROOT_CAT_MANAGEMENT/.test(checksBody));
  ok('detectRoot() projects root_privileges only',
    /rootCheckResults\(\)/.test(plugin.slice(at('private fun detectRoot()'), at('private fun detectRoot()') + 600)) &&
    /c\.category == ROOT_CAT_PRIVILEGES/.test(plugin.slice(at('private fun detectRoot()'), at('private fun detectRoot()') + 600)));
  ok('detectMagisk() projects root_management only',
    /c\.category == ROOT_CAT_MANAGEMENT/.test(plugin.slice(at('private fun detectMagisk()'), at('private fun detectMagisk()') + 600)));
  ok('the flags batch still reads magisk/root through these detectors (no parallel path)',
    /val magisk\s+= runCatching \{ detectMagisk\(\)\s*\}/.test(plugin) &&
    /detectRoot\(\)/.test(plugin));
  ok('the old package-name check is retained (cheap, still valid off-DenyList)',
    /val MAGISK_PACKAGES = listOf\([\s\S]{0,200}"com\.topjohnwu\.magisk"/.test(plugin));
}

/* ── 5. Evidence bridge is fail-closed ───────────────────────────────────── */

section('5. Evidence bridge: reject, never "clean"');

{
  // Brace-bounded slice: the next member (getRootDiagnostics) also resolves a
  // promise, so a fixed byte window would make the fail-closed assertion lie.
  const methodIdx = plugin.indexOf('fun getRootArtifactEvidence(promise: Promise)');
  const start = methodIdx < 0 ? -1 : plugin.indexOf('{', methodIdx);
  let depth = 0;
  let end = start;
  for (let i = start; i >= 0 && i < plugin.length; i++) {
    if (plugin[i] === '{') depth++;
    else if (plugin[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const method = methodIdx < 0 ? '' : plugin.slice(methodIdx, end);
  ok('exposes the probe as a @ReactMethod', /@ReactMethod\s*fun getRootArtifactEvidence\(promise: Promise\)/.test(plugin));
  ok('returns JSON, not a bare boolean',
    /o\.put\("present", JSONArray\(r\.present\)\)/.test(method) &&
    /o\.put\("denied", JSONArray\(r\.denied\)\)/.test(method));
  ok('reports the root-framework verdict explicitly',
    /o\.put\("rootFrameworkEvidence", hasRootFrameworkEvidence\(r\)\)/.test(method));
  ok('reports bootloader state as evidence (not folded into a verdict)',
    /bootloaderUnlocked/.test(method) && /ro\.boot\.verifiedbootstate/.test(plugin));
  ok('REJECTS on failure (a failed probe is never resolved as clean)',
    /promise\.reject\("root_artifact_probe_failed"/.test(method) &&
    !/catch \(e: Exception\) \{[\s\S]{0,120}promise\.resolve\(/.test(method));
  ok('bootloader state alone has no enforcement path (evidence only)',
    !/if \(isBootloaderUnlocked\(\)\) return true/.test(plugin));
}

/* ── 6. JS accessor contract ─────────────────────────────────────────────── */

section('6. JS accessor: null (UNKNOWN) on any failure');

{
  const jsIdx = bridge.indexOf('export async function getNativeRootArtifactEvidence');
  const js = bridge.slice(jsIdx, jsIdx + 1600);
  ok('exists and is typed to the evidence object or null',
    jsIdx !== -1 && /Promise<NativeRootArtifactEvidence \| null>/.test(js));
  ok('non-Android and missing module return null (never an empty "clean" object)',
    /Platform\.OS !== 'android'\) return null/.test(js) && /if \(!mod\) return null/.test(js));
  ok('a throw returns null', /catch \{[\s\S]{0,40}return null/.test(js));
  ok('a malformed payload returns null instead of a partial object',
    /typeof raw !== 'string'/.test(js) &&
    /parsed\?\.available !== true \|\| typeof parsed\.rootFrameworkEvidence !== 'boolean'/.test(js) &&
    /!Array\.isArray\(parsed\.present\) \|\| !Array\.isArray\(parsed\.denied\)/.test(js));
  ok('the old boolean accessors are unchanged for existing callers',
    /export async function isNativeMagiskDetected/.test(bridge) &&
    /export async function isNativeXposedDetected/.test(bridge));
  ok('the probe feeds the same verdict the gate already enforces (no new policy path)',
    /r\.putBoolean\("magiskDetected",\s*magisk\)/.test(plugin) &&
    /magiskDetected:/.test(bridge));
}

/* ── 7. Known limitations are documented next to the code ────────────────── */

section('7. Limitations are stated in the source, not just the report');

ok('the comment names the hooked-stat() limit',
  /hooked stat\(\)/.test(plugin));
ok('the comment states a bare /data/adb is not a verdict',
  /bare, empty \/data\/adb alone is NOT enough/.test(plugin));
ok('the comment keeps the DenyList mechanism explicit (mounts are scrubbed)',
  /SCRUBBED MOUNT NAMESPACE/.test(plugin));

/* The Kotlin lives inside a JS template literal: ONE stray backtick in a
   comment terminates the string and breaks require() at build time (this
   actually happened while adding the probe). Requiring the plugin is the
   cheapest possible guard against that class of mistake. */
ok('the plugin module still loads (template literal intact)', (() => {
  try {
    const mod = require(path.join(ROOT, 'plugins', 'withSecurityModule.js'));
    return typeof mod === 'function';
  } catch {
    return false;
  }
})());

/* ── Result ─────────────────────────────────────────────────────────────── */

console.log('');
if (failures.length) {
  console.log('❌ ' + passed + ' passed, ' + failures.length + ' failed');
  for (const f of failures) console.log('   - ' + f);
  process.exit(1);
}
console.log('✅ ' + passed + ' passed, 0 failed');
