#!/usr/bin/env node
/**
 * iOS pinning COVERAGE — every networking stack the app actually uses.
 *
 * BACKGROUND (what was actually wrong)
 *   tests/certificatePinning.test.cjs proves the pin VALUES and the Swift
 *   verification logic are correct. It does NOT prove the pinning protocol is
 *   installed on every stack that carries first-party traffic. Two gaps existed
 *   that no amount of correct Swift could close:
 *
 *   GAP 1 — expo/fetch bypass.
 *     `import { fetch } from 'expo/fetch'` does NOT go through React Native's
 *     RCTHTTPRequestHandler. ExpoFetchModule builds its own lazily-created
 *     URLSession from URLSessionConfiguration.default, and NSURLSession consults
 *     ONLY configuration.protocolClasses — the global URLProtocol.registerClass
 *     registry that PinningInitializer also performs does not apply to
 *     NSURLSession. Nothing in the repo ever called Expo's
 *     setCustomURLSessionConfigurationProvider, so every request through
 *     expo/fetch (notably uploadVideoChunk, which carries
 *     `Authorization: Bearer`) left the device with NO pin validation and was
 *     therefore readable by an interception proxy.
 *
 *   GAP 2 — expected_cert_configured was Android-only.
 *     iOS never returned the key, so every iOS security event reported
 *     expected_cert_configured=false and a genuinely pinned build looked
 *     unpinned in the backend audit trail.
 *
 * WHAT THIS LOCKS DOWN
 *   A. Both network stacks are wired, from one shared configuration builder.
 *   B. The pin protocol is PREPENDED (first in protocolClasses).
 *   C. The expo wiring is behind the pinsConfigured guard (dev builds inert).
 *   D. iOS reports pin configuration truthfully, from the very key the native
 *      pinner reads.
 *   E. The pinned host list covers the host the app will actually build with,
 *      and stays scoped to first-party origins (no VdoCipher/YouTube/Google).
 *   F. The inventory of expo/fetch call sites is closed — adding a new one
 *      without considering pinning fails this suite.
 *   G. Proxy detection stays warn_only while a real pin mismatch stays
 *      block_login — the two are deliberately different severities.
 *
 * Run: node tests/iosPinningCoverage.test.cjs
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const appJson = JSON.parse(read('app.json'));
const expo = appJson.expo;

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}

const initializer = read('plugins/ios/PinningInitializer.m');
const iosModule = read('plugins/ios/IOSSecurityModule.swift');
const pinningProtocol = read('plugins/ios/PinningURLProtocol.swift');
const securityTs = read('src/lib/security.ts');

// ─── A. Both stacks wired, from ONE shared builder ───────────────────────────

check('A1 React Native stack is wired (RCTSetCustomNSURLSessionConfigurationProvider)', () => {
  ok(
    /RCTSetCustomNSURLSessionConfigurationProvider\s*\(/.test(initializer),
    'RN provider hook is not called — globalThis.fetch / XHR would be unpinned',
  );
});

check('A2 expo/fetch stack is wired (ExpoFetchCustomExtension)', () => {
  ok(
    initializer.includes('EXFetchCustomExtension'),
    'expo/fetch provider class is not referenced — expo/fetch traffic bypasses pinning',
  );
  ok(
    initializer.includes('setCustomURLSessionConfigurationProvider'),
    'expo/fetch provider selector missing',
  );
});

check('A3 expo/fetch provider is actually INVOKED, not just referenced', () => {
  const invoke = initializer.match(/\[cls\s+performSelector:[^\]]*\]/g) || [];
  ok(invoke.length >= 1, 'provider selector is never sent to the Expo class');
  const installCall = initializer.match(/installExpoFetchProvider\s*\]/g) || [];
  ok(installCall.length >= 1, 'installExpoFetchProvider is never called from install');
});

check('A4 both stacks share ONE configuration builder (they cannot drift apart)', () => {
  // 1 definition + 1 call from the RN provider + 1 call from the expo provider.
  const builder = initializer.match(/MEDA_pinnedConfiguration\s*\(/g) || [];
  ok(
    builder.length >= 3,
    `expected the shared builder to be defined once and called by both providers (found ${builder.length} reference(s))`,
  );
  // Neither provider may inline its own protocolClasses manipulation.
  const inlined = initializer.match(/configuration\.protocolClasses\s*=/g) || [];
  ok(
    inlined.length <= 1,
    `protocolClasses is assigned in ${inlined.length} places — providers have diverged`,
  );
});

check('A5 the pin protocol is PREPENDED, not appended', () => {
  ok(
    /insertObject:\s*pinningClass\s+atIndex:\s*0/.test(initializer),
    'PinningURLProtocol must be first in protocolClasses to run before DNS',
  );
  ok(
    !/addObject:\s*pinningClass/.test(initializer),
    'appending the pin protocol would let another protocol handle the request first',
  );
});

check('A6 expo/fetch wiring sits behind the pinsConfigured guard', () => {
  const guardIdx = initializer.indexOf('pinsConfigured');
  const expoIdx = initializer.indexOf('installExpoFetchProvider');
  ok(guardIdx >= 0 && expoIdx > guardIdx, 'expo wiring must run after the pinsConfigured guard');
  ok(
    /if\s*\(!\[self pinsConfigured\]\)[\s\S]{0,200}return;/.test(initializer),
    'dev/unconfigured builds must stay completely inert',
  );
});

check('A7 re-entrancy is guarded (inner session never re-enters the protocol)', () => {
  ok(
    pinningProtocol.includes('PinningURLProtocol.Type) == nil'),
    'inner session must strip the pin protocol or every request recurses',
  );
});

// ─── D. iOS reports pin configuration truthfully ─────────────────────────────

check('D1 iOS getSecurityFlags returns expectedCertConfigured', () => {
  ok(
    iosModule.includes('"expectedCertConfigured"'),
    'iOS never reports expectedCertConfigured — events claim a pinned build is unpinned',
  );
});

check('D2 the iOS value derives from MEDA_SPKI_PINS, the key the pinner reads', () => {
  ok(
    iosModule.includes('MEDA_SPKI_PINS'),
    'expectedCertConfigured must be read from the same Info.plist key PinningURLProtocol enforces',
  );
  // Same key in both files ⇒ JS evidence can never contradict real enforcement.
  ok(
    pinningProtocol.includes('MEDA_SPKI_PINS'),
    'PinningURLProtocol no longer reads MEDA_SPKI_PINS — the two sources have diverged',
  );
});

check('D3 the iOS flag is evidence, not a threat signal', () => {
  ok(
    /NEVER a threat signal/.test(iosModule),
    'expectedCertConfigured must be documented as observability-only',
  );
  ok(
    securityTs.includes('expectedCertConfigured'),
    'JS evidence layer no longer forwards the flag',
  );
});

// ─── E. Host coverage + scoping ──────────────────────────────────────────────

const pinnedHosts = (expo.extra && expo.extra.medaPinnedHosts) || [];
const pins = (expo.extra && expo.extra.medaSslPins) || [];

check('E1 a pinned host list and pin set are configured', () => {
  ok(pinnedHosts.length >= 1, 'medaPinnedHosts is empty — no host is ever pinned');
  ok(pins.length >= 1, 'medaSslPins is empty — the native pinner is inert');
  ok(pins.every((p) => typeof p === 'string' && p.length > 0), 'blank pin entry');
});

check('E2 at least one backup pin is configured (rotation does not break the app)', () => {
  ok(pins.length >= 2, `only ${pins.length} pin(s) — no backup for certificate rotation`);
});

check('E3 pinning is scoped to first-party origins only', () => {
  const thirdParty = /vdocipher|youtube|google|gstatic|apple|icloud|cloudflare/i;
  const offenders = pinnedHosts.filter((h) => thirdParty.test(h));
  ok(
    offenders.length === 0,
    `MedAcademy pins must not be applied to third-party hosts: ${offenders.join(', ')}`,
  );
});

check('E4 the effective build API host is covered by the pinned host list', () => {
  // Expo/dotenv precedence, later files win. Only the EFFECTIVE value matters:
  // pinning a host the build does not use is indistinguishable from no pinning.
  const order = ['.env', '.env.local', '.env.production', '.env.production.local'];
  let apiUrl = '';
  for (const rel of order) {
    if (!exists(rel)) continue;
    const m = read(rel).match(/^\s*EXPO_PUBLIC_PHP_API_URL\s*=\s*(\S+)\s*$/m);
    if (m) apiUrl = m[1];
  }
  if (!apiUrl) {
    console.log('        (no EXPO_PUBLIC_PHP_API_URL found — skipped)');
    return;
  }
  let host = '';
  try {
    host = new URL(apiUrl).hostname.toLowerCase();
  } catch {
    throw new Error(`EXPO_PUBLIC_PHP_API_URL is not a URL: ${apiUrl.slice(0, 40)}…`);
  }
  ok(
    pinnedHosts.map((h) => String(h).toLowerCase()).includes(host),
    `effective API host "${host}" is NOT in medaPinnedHosts [${pinnedHosts.join(', ')}] — ` +
      'the app would run entirely unpinned while looking configured',
  );
});

// ─── F. Closed inventory of expo/fetch call sites ────────────────────────────

check('F1 every expo/fetch import site is accounted for', () => {
  const srcRoot = path.join(ROOT, 'src');
  const hits = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        if (/from\s+['"]expo\/fetch['"]/.test(text)) {
          hits.push(path.relative(ROOT, full).replace(/\\/g, '/'));
        }
      }
    }
  })(srcRoot);

  // Each entry must be a KNOWN, reasoned site. Adding a new one without
  // deciding whether its traffic must be pinned fails here.
  const known = new Set([
    'src/lib/api.ts', // uploadVideoChunk — first-party, Authorization: Bearer
    'src/app/(app)/(hubs)/bulk-import.tsx', // reads a LOCAL document uri, not network
    'src/app/(app)/(hubs)/bulk-import-students.tsx', // reads a LOCAL document uri, not network
  ]);
  const unknown = hits.filter((f) => !known.has(f));
  ok(
    unknown.length === 0,
    `unreviewed expo/fetch call site(s): ${unknown.join(', ')} — decide whether they ` +
      'carry first-party traffic, then add them to the known set in this test',
  );
  ok(hits.length >= 1, 'expected at least one expo/fetch site (the suite guards nothing)');
});

check('F2 the first-party expo/fetch site is now served by a pinned session', () => {
  ok(initializer.includes('EXFetchCustomExtension'), 'expo/fetch is not pinned');
  const api = read('src/lib/api.ts');
  ok(
    /expoFetch\(url/.test(api),
    'uploadVideoChunk no longer uses expo/fetch — re-audit this test’s assumptions',
  );
});

// ─── G. Severity separation: connection block vs pin block ───────────────────

// POLICY UPDATE (mandatory connection block — migration 033 + client floor):
// proxy used to be warn_only here; a confirmed VPN/proxy can no longer be
// downgraded below block_login in any plane (see docs/VPN_PROXY_MANDATORY_BLOCK.md).
check('G1 proxy detection is floored to block_login (mandatory connection block)', () => {
  ok(
    /proxy:\s+'block_login'/.test(securityTs),
    'proxy is a mandatory block: a dismissed proxy finding was the reported iOS bypass',
  );
  ok(
    /applyMandatoryConnectionFloor/.test(securityTs),
    'the client floor must still be applied so a weakened server row cannot reopen the dismiss path',
  );
});

check('G2 a verified pin mismatch stays block_login', () => {
  ok(
    /ssl_pinning:\s+'block_login'/.test(securityTs),
    'a real TLS identity rejection must block, not merely log',
  );
  ok(
    /ssl_pinning_failure/.test(securityTs),
    'ssl_pinning_failure event type is gone',
  );
});

check('G3 proxy_detected and ssl_pinning_failure are distinct event types', () => {
  ok(securityTs.includes("'proxy_detected'"), 'proxy_detected type missing');
  ok(securityTs.includes("'ssl_pinning_failure'"), 'ssl_pinning_failure type missing');
});

// ─── Report ──────────────────────────────────────────────────────────────────

console.log('');
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} failed.`);
  failures.forEach((f) => console.log(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`${passed} assertions passed.`);
console.log('iOS pinning coverage regression suite: OK');
