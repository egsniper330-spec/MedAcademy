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
ok('carries the three buckets as separate lists',
  /private data class RootArtifactReport\(\s*val present: List<String>,\s*val denied: List<String>,\s*val unreadable: List<String>/.test(plugin));
ok('buffers are bounded (no unbounded path list growth)',
  /if \(present\.size < 8\) present\.add\(p\)/.test(plugin) &&
  /if \(denied\.size < 8\) denied\.add\(p\)/.test(plugin));

/* The paths that survive DenyList: the data directory and its children. */
section('2. The probe targets the paths DenyList cannot unmount');
{
  const probeFn = plugin.slice(plugin.indexOf('private fun probeRootArtifacts()'));
  const body = probeFn.slice(0, probeFn.indexOf('private fun hasRootFrameworkEvidence'));
  ok('stats the /data/adb directory itself', /"\/data\/adb",/.test(body));
  ok('stats Magisk data children', /"\/data\/adb\/magisk"/.test(body) && /"\/data\/adb\/magisk\.db"/.test(body));
  ok('stats /data/adb/modules (module inventory)', /"\/data\/adb\/modules"/.test(body));
  ok('stats the LSPosed module data dir', /"\/data\/adb\/lspd"/.test(body));
  ok('covers KernelSU and APatch conventions', /"\/data\/adb\/ksu"/.test(body) && /"\/data\/adb\/ap"/.test(body));
  ok('still probes classic su binaries (visible when NOT on the DenyList)',
    /"\/system\/bin\/su"/.test(body) && /"\/debug_ramdisk\/su"/.test(body));
  ok('the probe itself never uses File.exists() (it would drop EACCES)',
    !/File\(/.test(body), 'File() appears in probeRootArtifacts');
}

/* ── 3. The evidence rule and its false-positive guard ────────────────────── */

section('3. Evidence rule (executed model)');

/** Mirrors hasRootFrameworkEvidence() in the Kotlin template. */
function hasRootFrameworkEvidence(r) {
  if (r.denied.length > 0) return true;
  return r.present.some((p) => p !== '/data/adb');
}

ok('bare /data/adb only → NOT evidence (legitimate leftover cannot block)',
  hasRootFrameworkEvidence({ present: ['/data/adb'], denied: [], unreadable: [] }) === false);
ok('unreadable child (EACCES) → evidence',
  hasRootFrameworkEvidence({ present: ['/data/adb'], denied: ['/data/adb/magisk'], unreadable: [] }) === true);
ok('visible su binary → evidence',
  hasRootFrameworkEvidence({ present: ['/system/bin/su'], denied: [], unreadable: [] }) === true);
ok('nothing found → no evidence',
  hasRootFrameworkEvidence({ present: [], denied: [], unreadable: [] }) === false);
ok('probe errors alone are not evidence (UNKNOWN ≠ clean, UNKNOWN ≠ guilty)',
  hasRootFrameworkEvidence({ present: [], denied: [], unreadable: ['/data/adb'] }) === false);
ok('the Kotlin rule matches the model',
  /fun hasRootFrameworkEvidence\(r: RootArtifactReport\): Boolean \{\s*if \(r\.denied\.isNotEmpty\(\)\) return true\s*return r\.present\.any \{ it != "\/data\/adb" \}/.test(plugin));

/* ── 4. Wiring: the probe runs BEFORE the artifact-dependent checks ───────── */

section('4. Wiring order in the generated Kotlin');

{
  const magiskIdx = plugin.indexOf('private fun detectMagisk(): Boolean {');
  const rootIdx = plugin.indexOf('private fun detectRoot(): Boolean {');
  // Slice to the NEXT member, not a fixed byte count: the detectors legitimately
  // grew (mount-view + PATH probes), and a fixed window silently truncated the
  // su path list and made this ordering assertion fail for the wrong reason.
  const bodyOfKt = (start, fallbackLen) => {
    if (start < 0) return '';
    const next = plugin.indexOf('\n    private fun ', start + 10);
    return plugin.slice(start, next === -1 ? start + fallbackLen : next);
  };
  const magiskBody = bodyOfKt(magiskIdx, 2600);
  const rootBody = bodyOfKt(rootIdx, 2600);

  ok('detectMagisk() probes first, before the visible-path list',
    magiskBody.indexOf('probeRootArtifacts()') !== -1 &&
    magiskBody.indexOf('probeRootArtifacts()') < magiskBody.indexOf('1. Known Magisk binary'));
  ok('detectMagisk() returns true on the metadata evidence',
    /hasRootFrameworkEvidence\(artifacts\)[\s\S]{0,160}return true/.test(magiskBody));
  ok('detectRoot() probes first, before the su path list',
    rootBody.indexOf('probeRootArtifacts()') !== -1 &&
    rootBody.indexOf('1. su binary path scan') !== -1 &&
    rootBody.indexOf('probeRootArtifacts()') < rootBody.indexOf('1. su binary path scan'));
  // The DenyList-resistant probe must also precede the two checks added with the
  // mount-view/PATH work — those are independent evidence, never a substitute.
  ok('detectRoot() probes before the mount-view and PATH checks',
    rootBody.indexOf('probeRootArtifacts()') < rootBody.indexOf('inspectMountView()') &&
    rootBody.indexOf('probeRootArtifacts()') < rootBody.indexOf('suOnPath()'));
  ok('detectRoot() returns true on the metadata evidence',
    /hasRootFrameworkEvidence\(rootArtifacts\)[\s\S]{0,160}return true/.test(rootBody));
  ok('the flags batch still reads magisk/root through these detectors (no parallel path)',
    /val magisk\s+= runCatching \{ detectMagisk\(\)\s*\}/.test(plugin) &&
    /detectRoot\(\)/.test(plugin));
  ok('the old package-name check is retained (cheap, still valid off-DenyList)',
    /"com\.topjohnwu\.magisk"/.test(magiskBody));
}

/* ── 5. Evidence bridge is fail-closed ───────────────────────────────────── */

section('5. Evidence bridge: reject, never "clean"');

{
  const methodIdx = plugin.indexOf('fun getRootArtifactEvidence(promise: Promise)');
  const method = plugin.slice(methodIdx, methodIdx + 1400);
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
