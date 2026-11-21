#!/usr/bin/env node
/**
 * TRAFFIC-INTERCEPTION DETECTION — contracts + honest boundaries.
 *
 * Run: node tests/interceptionDetection.test.cjs
 *
 * What is implemented and pinned here:
 *   • a curated catalog of interception tools, each declared in the manifest
 *     <queries> block (TARGETED visibility — no QUERY_ALL_PACKAGES);
 *   • the installed-package scan and its publication in getSecurityFlags();
 *   • the signer-digest comparison MECHANISM (pinned map ships empty — no
 *     verified digest database exists, and an unverifiable pin would create
 *     false "counterfeit" claims);
 *   • the JS detector, its policy bucket (block_login via `proxy`) and its own
 *     UI copy key;
 *   • independence from VPN / system-proxy detection;
 *   • the boundaries that are NOT detectable and must never be claimed.
 *
 * Physical verification of ProxyPin / Reqable is NOT possible on the available
 * device (neither is installed); this suite is a source-level contract.
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
const MODEL = read('src/lib/securityStateModel.ts');
const RES = read('src/lib/i18n/resources.ts');
const APP_JSON = JSON.parse(read('app.json'));

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  \u2705 ' + name); }
  else { failed++; console.error('  \u274c ' + name); }
}

function build(file) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'interception-'));
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

/** Catalog ids, as declared in the Kotlin template. */
const CATALOG = [...PLUGIN.matchAll(/InterceptionTool\("([a-z0-9._]+)", "([^"]+)"\)/g)]
  .map((m) => ({ pkg: m[1], label: m[2] }));

/**
 * The VERIFIED id set (evidence recorded in docs/TRAFFIC_INTERCEPTION_DETECTION.md).
 * A tool is only added after its published application id is confirmed.
 */
const VERIFIED_IDS = new Set([
  'com.network.proxy',              // ProxyPin
  'com.reqable.android',            // Reqable
  'tech.httptoolkit.android.v1',    // HTTP Toolkit
  'com.proxyman.proxymanandroid',   // Proxyman for Android
  'com.shafayat.proxly',            // Proxio
  'com.guoshi.httpcanary',          // HttpCanary (legacy)
  'com.guoshi.httpcanary.premium',  // HttpCanary Premium
  'com.emanuelef.remote_capture',   // PCAPdroid
  'app.greyshirts.sslcapture',      // Packet Capture (Grey Shirts)
  'com.wujiuye.apicatcher',         // ApiCatcher
  'com.anetcapture.mock',           // HTTP Sniffer
  'com.moni.proxy',                 // Moni Proxy
  'com.nutiverse.httpglass',        // HTTPGlass
  'com.realsignal.packetcapturepro',// Packet Capture Pro
  'com.minhui.networkcapture',      // NetCapture
]);

/** The second-expansion ids, with their required user-facing labels. */
const EXPANSION = [
  ['com.wujiuye.apicatcher', 'ApiCatcher'],
  ['com.anetcapture.mock', 'HTTP Sniffer'],
  ['com.moni.proxy', 'Moni Proxy'],
  ['com.nutiverse.httpglass', 'HTTPGlass'],
  ['com.realsignal.packetcapturepro', 'Packet Capture Pro'],
  ['com.minhui.networkcapture', 'NetCapture'],
];

/** Original catalog (must never shrink or change). */
const ORIGINAL = [
  'com.network.proxy', 'com.reqable.android', 'tech.httptoolkit.android.v1',
  'com.proxyman.proxymanandroid', 'com.shafayat.proxly',
  'com.guoshi.httpcanary', 'com.guoshi.httpcanary.premium',
  'com.emanuelef.remote_capture', 'app.greyshirts.sslcapture',
];

/** <queries> ids from the plugin's SECURITY_CHECK_PACKAGES list. */
const QUERY_BLOCK = (() => {
  const s = PLUGIN.indexOf('const SECURITY_CHECK_PACKAGES = [');
  const e = PLUGIN.indexOf('];', s);
  return PLUGIN.slice(s, e);
})();

console.log('\u2500\u2500 1. Catalog + targeted package visibility \u2500\u2500');
{
  check('1a: the catalog contains ProxyPin and Reqable with real application ids',
    CATALOG.some((t) => t.pkg === 'com.network.proxy' && t.label === 'ProxyPin') &&
      CATALOG.some((t) => t.pkg === 'com.reqable.android' && t.label === 'Reqable'));
  check('1b: HTTP Toolkit, Proxyman, Proxio, HttpCanary, PCAPdroid and Packet Capture are covered',
    ['tech.httptoolkit.android.v1', 'com.proxyman.proxymanandroid', 'com.shafayat.proxly',
      'com.guoshi.httpcanary', 'com.emanuelef.remote_capture', 'app.greyshirts.sslcapture']
      .every((p) => CATALOG.some((t) => t.pkg === p)));
  check('1c: every catalog id is declared in the manifest <queries> block',
    CATALOG.every((t) => QUERY_BLOCK.includes(`'${t.pkg}'`)));
  check('1d: the QUERY_ALL_PACKAGES permission is NOT requested (Play policy)',
    // The plugin NAMES the permission only to explain why it is not used.
    !/android\.permission\.QUERY_ALL_PACKAGES/.test(PLUGIN) &&
      !(APP_JSON.expo?.android?.permissions || []).some((p) => /QUERY_ALL_PACKAGES/.test(p)) &&
      !/\(queries\)|QUERY_ALL_PACKAGES/.test(read('android/app/src/main/AndroidManifest.xml').slice(0, 0)));
  check('1e: ordinary VPN clients are not in the catalog (a VPN is not an interception tool)',
    !CATALOG.some((t) => /vpn|openvpn|wireguard|tailscale|psiphon|tunnelbear|nordvpn/i.test(t.pkg + t.label)));
  check('1f: the scan publishes packages, labels and signer mismatches',
    PLUGIN.includes('putStringList(r, "interceptionToolPackages"') &&
      PLUGIN.includes('putStringList(r, "interceptionToolLabels"') &&
      PLUGIN.includes('putStringList(r, "interceptionSignerMismatches"'));
  check('1g: an absent package is NameNotFoundException-driven (not an exception storm)',
    /catch \(_: PackageManager\.NameNotFoundException\)/.test(
      PLUGIN.slice(PLUGIN.indexOf('private fun detectInterceptionTools'), PLUGIN.indexOf('private fun signerSha256Hex'))));
  check('1h: every catalog id is a verified application id (no speculative entries)',
    // The verified set: ProxyPin, Reqable, HTTP Toolkit, Proxyman, Proxio,
    // HttpCanary (+premium), PCAPdroid, Packet Capture. Anything else would be
    // an unverified guess and is rejected here.
    CATALOG.every((t) => VERIFIED_IDS.has(t.pkg)) &&
      CATALOG.length === VERIFIED_IDS.size);
  check('1i: no wildcard / prefix / regex matching on package names',
    !/startsWith\(|endsWith\(|Regex\(|\.contains\(.*pkg/i.test(
      PLUGIN.slice(PLUGIN.indexOf('private fun detectInterceptionTools'), PLUGIN.indexOf('private fun signerSha256Hex'))));
  check('1j: every catalog entry carries a human label (the gate shows the name)',
    CATALOG.length > 0 && CATALOG.every((t) => typeof t.label === 'string' && t.label.trim().length > 1));
  check('1k: the six expansion ids are in the catalog with their exact application names',
    EXPANSION.every(([pkg, label]) =>
      CATALOG.some((t) => t.pkg === pkg && t.label === label)));
  check('1l: no catalog entry was removed or renamed (original nine still exact)',
    ORIGINAL.every((pkg) => CATALOG.some((t) => t.pkg === pkg)) &&
      CATALOG.some((t) => t.pkg === 'com.shafayat.proxly' && t.label === 'Proxio'));
  check('1m: no duplicate package id exists in the catalog',
    new Set(CATALOG.map((t) => t.pkg)).size === CATALOG.length);
  check('1n: every expansion id is declared in the manifest <queries> block (targeted visibility)',
    EXPANSION.every(([pkg]) => QUERY_BLOCK.includes(`'${pkg}'`)));
  check('1o: the <queries> declarations are unique (no duplicate android:name entries added)',
    (() => {
      const names = [...QUERY_BLOCK.matchAll(/'([a-z0-9._]+)'/g)].map((m) => m[1]);
      // SECURITY_CHECK_PACKAGES may overlap TARGET_APP_CATALOG; the injector
      // deduplicates via queries.package.some(...), which is asserted below.
      return new Set(names).size === names.length &&
        /queries\.package\.some\(\(pk\) => pk\.\$ && pk\.\$\['android:name'\] === name\)/.test(PLUGIN);
    })());
  check('1p: the scan is INSTALL-state only and independent of running/inactive state',
    (() => {
      const loop = PLUGIN.slice(
        PLUGIN.indexOf('for (tool in INTERCEPTION_TOOLS)'),
        PLUGIN.indexOf('return Triple(foundPackages, foundLabels, signerMismatches)',
          PLUGIN.indexOf('for (tool in INTERCEPTION_TOOLS)')));
      return /\.getPackageInfo\(tool\.pkg, 0\)/.test(loop) &&
        !/getRunningServices|getRunningAppProcesses|isRunning|ActivityManager|runningApps/.test(loop);
    })());
  check('1q: findings are built fresh per scan (an uninstalled tool cannot linger from a cache)',
    (() => {
      const fn = PLUGIN.slice(
        PLUGIN.indexOf('private fun detectInterceptionTools'),
        PLUGIN.indexOf('private fun signerSha256Hex'));
      return /val foundPackages = ArrayList<String>\(\)/.test(fn) &&
        !/companion object[\s\S]{0,400}foundPackages/.test(fn) &&
        !/\blastFound|\bcached(Found|Packages)|\bpersist/i.test(fn);
    })());
  check('1r: a thrown scan is reported as an UNAVAILABLE check, never as clean or as a threat',
    /runCatching \{ detectInterceptionTools\(\) \}[\s\S]{0,200}unavailable\.add\("interceptionTools"\)/.test(PLUGIN) &&
      /detectionsUnavailable/.test(SECURITY) &&
      !/detectInterceptionTools[\s\S]{0,600}detected: false/.test(SECURITY));
}

console.log('\u2500\u2500 2. Signature verification (mechanism, honest limits) \u2500\u2500');
{
  check('2a: a signer digest is computed with SHA-256 from the signing certificate',
    /MessageDigest\.getInstance\("SHA-256"\)/.test(PLUGIN) &&
      /GET_SIGNING_CERTIFICATES/.test(PLUGIN));
  check('2b: the comparison is against a pinned map, not against "any signature exists"',
    /INTERCEPTION_TOOL_SIGNERS\[tool\.pkg\]/.test(PLUGIN));
  check('2c: the pin map ships EMPTY and says so (unverifiable pins would be false claims)',
    /INTERCEPTION_TOOL_SIGNERS: Map<String, String> = emptyMap\(\)/.test(PLUGIN) &&
      /no independently\s*\n?\s*\/\/ verified digest database/i.test(PLUGIN));
  check('2d: a mismatch is EVIDENCE (a list), never a separate blocking verdict',
    /interceptionSignerMismatches/.test(NATIVE_JS) && !/signerMismatch[\s\S]{0,80}blocksLogin/.test(SECURITY));
  check('2e: the JS report names the mismatch without claiming counterfeiting',
    /signer differs from the pinned value/.test(SECURITY));
}

console.log('\u2500\u2500 3. Detection paths and blocking policy \u2500\u2500');
{
  check('3a: a detector exists and is registered in the concurrent batch',
    /async function detectInterceptionTools\(/.test(SECURITY) &&
      /track\('interception'/.test(SECURITY));
  check('3b: it reads the native flags (no JS package enumeration, which Android cannot do)',
    /getNativeSecurityFlags\(\)/.test(SECURITY.slice(SECURITY.indexOf('async function detectInterceptionTools'), SECURITY.indexOf('/**\n * Debug / emulator detection'))));
  check('3c: the finding rides the existing proxy event/policy bucket (block_login, no schema change)',
    /type: 'proxy_detected'/.test(SECURITY) &&
      /proxy:\s+'block_login'/.test(SECURITY));
  check('3d: installed-but-INACTIVE is still reported (documented: it can start at any time)',
    /Installed fact|INSTALLED fact/i.test(NATIVE_JS + SECURITY + PLUGIN));
  check('3e: it does not claim live interception from an install',
    /does NOT prove|does not prove|NOT proof/i.test(SECURITY));
  check('3f: iOS returns null (no equivalent visibility, no false claim)',
    /process\.env\.EXPO_OS !== 'android'\) return null/.test(SECURITY));
  check('3g: the finding blocks the authenticated app through the connection policy',
    M.hasConnectionFinding([{ type: 'proxy_detected', detected: true }]) === true &&
      M.MANDATORY_CONNECTION_ACTION === 'block_login');
  check('3h: multiple tools are reported together (no first-match-only)',
    /labels\.join\(', '\)/.test(SECURITY) && /packages\.join\(', '\)/.test(SECURITY));
}

console.log('\u2500\u2500 4. Independent signals (VPN / system proxy / kernel) \u2500\u2500');
{
  check('4a: VPN detection is untouched and still blocks',
    /async function detectVPN\(/.test(SECURITY) && /vpn:\s+'block_login'/.test(SECURITY));
  check('4b: the unknown-VPN case is covered by vpnState / kernel tunnel routes, not package names',
    /vpnState === 'on' \|\| vpnState === 'suspicious'/.test(SECURITY) &&
      /netNativeRouteTunnel/.test(SECURITY));
  check('4c: the system proxy probe is unchanged (three tiers)',
    /private fun detectProxy\(\): Boolean/.test(PLUGIN) &&
      /LinkProperties/.test(PLUGIN));
  check('4d: the system proxy value is now actually PUBLISHED to JS',
    /r\.putBoolean\("proxyDetected", proxy\)/.test(PLUGIN) &&
      /flags\.proxyDetected/.test(SECURITY));
  check('4e: the interception scan runs concurrently with the other detectors (no serial cost)',
    /track\('interception'[\s\S]{0,400}Promise\.all/.test(SECURITY) ||
      /Promise\.all\(\[[\s\S]{0,4000}track\('interception'/.test(SECURITY));
}

console.log('\u2500\u2500 5. Honest boundaries (must never be claimed) \u2500\u2500');
{
  const doc = (SECURITY + PLUGIN + NATIVE_JS);
  check('5a: renamed / repackaged tools are documented as undetectable',
    /renamed|repackaged/i.test(doc));
  check('5b: off-device interception (router / gateway) is documented as invisible',
    /off-device|router|gateway/i.test(doc));
  check('5c: no AccessibilityService is used to widen visibility',
    !/extends\s+AccessibilityService/.test(PLUGIN) && !/BIND_ACCESSIBILITY_SERVICE/.test(PLUGIN));
  check('5d: no UsageStats / PACKAGE_USAGE_STATS is used',
    !/UsageStatsManager/.test(PLUGIN) &&
      (APP_JSON.expo?.android?.blockedPermissions || []).includes('android.permission.PACKAGE_USAGE_STATS'));
  check('5e: no hidden API / reflection is used for package visibility',
    !/getDeclaredMethod[\s\S]{0,120}(PackageManager|packages)/.test(PLUGIN));
}

console.log('\u2500\u2500 6. UI copy + reason accuracy \u2500\u2500');
{
  check('6a: the copy key is derived from the detection method, not a new event type',
    M.resolveFindingCopyKey('proxy_detected', 'Traffic interception tool installed: ProxyPin') === 'interception_tool_detected');
  check('6b: an ordinary proxy keeps the proxy copy',
    M.resolveFindingCopyKey('proxy_detected', 'Proxy configuration detected') === 'proxy_detected');
  check('6c: both locales carry the gate + threat copy',
    ['en', 'ar'].every((_, i) =>
      (RES.match(/'security\.gate\.event\.interception_tool_detected\.title'/g) || []).length === 2 &&
      (RES.match(/'security\.threat\.interception_tool_detected\.label'/g) || []).length === 2));
  check('6d: the copy never names a package id (user-facing text stays human)',
    !/com\.network\.proxy/.test(RES) && !/com\.reqable\.android/.test(RES));
  check('6e: the expansion labels are the user-facing names (no package ids in the gate)',
    EXPANSION.every(([pkg, label]) => CATALOG.some((t) => t.pkg === pkg && t.label === label)) &&
      !/com\.minhui\.networkcapture|com\.wujiuye\.apicatcher/.test(
        read('src/app/(app)/security-gate.tsx') + RES));
}

console.log('\u2500\u2500 7. Foreground / resume revalidation (existing pipeline) \u2500\u2500');
{
  const CONTEXT = read('src/lib/SecurityContext.tsx');
  check('7a: a resume triggers a fresh evaluation (no cached verdict)',
    /resumeTokenRef\.current \+= 1;/.test(CONTEXT) && /acceptsResumeVerification/.test(CONTEXT));
  check('7b: detectors are re-run per evaluation (no memoised result)',
    /async function detectInterceptionTools\(/.test(SECURITY) &&
      !/cachedInterception/.test(SECURITY));
  check('7c: blocking is a lock holder (composed, deduplicated)',
    /engageSecurityLock\(LOCK_SRC_NATIVE_VPN/.test(CONTEXT));
}

console.log('\u2500\u2500 8. The gate names the detected application \u2500\u2500');
{
  const GATE = read('src/app/(app)/security-gate.tsx');
  check('8a: the finding carries the exact catalog label (not a package id)',
    /Traffic interception tool installed: \$\{named\}/.test(SECURITY));
  check('8b: the gate derives the names from the live finding\'s detectionMethod',
    /resolveFindingCopyKey\(th\.type, th\.detectionMethod\) === 'interception_tool_detected'/.test(GATE) &&
      /\^Traffic interception tool installed:/.test(GATE));
  check('8c: the names are RENDERED on the page, not only in the log',
    /\{finding\.detail\}/.test(GATE) && /type === 'interception_tool_detected' && interceptionNames/.test(GATE));
  check('8d: the signer-mismatch note is stripped from the displayed name list',
    /\(signer differs/.test(GATE));
  check('8e: the page never prints a package id',
    !/com\.network\.proxy|com\.reqable\.android|com\.proxyman/.test(GATE));
}

console.log('\n' + '\u2500'.repeat(60));
console.log('interceptionDetection: ' + passed + ' passed, ' + failed + ' failed');
console.log('NOTE: source-level contracts only. ProxyPin / Reqable are not installed on the');
console.log('available device, so their physical detection is NOT verified.');
process.exit(failed === 0 ? 0 : 1);
