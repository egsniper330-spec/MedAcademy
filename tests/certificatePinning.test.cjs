#!/usr/bin/env node
/**
 * Certificate pinning — first-party API origin (api.medacademy.site).
 *
 * BACKGROUND (what was actually wrong)
 *   The repo carried a complete, configured pin list in app.json
 *   (expo.extra.medaSslPins / medaPinnedHosts). iOS consumed it. Android did
 *   NOT: the pins reached android/gradle.properties and then nothing read them
 *   — no <network-security-config>, no OkHttp CertificatePinner, and
 *   BuildConfig.API_SPKI_PINS was hardcoded to "". Result: TLS was validated
 *   against the SYSTEM TRUST STORE only, so installing a proxy CA was enough to
 *   decrypt the API traffic and read the JSON. Additionally the iOS
 *   implementation hashed SecKeyCopyExternalRepresentation (the RAW key) while
 *   the pins are SPKI hashes, so its check could never match.
 *
 * WHAT THIS LOCKS DOWN
 *   A. The pin source of truth is present and well-formed.
 *   B. Android generates a real <pin-set> for the pinned host, cleartext off,
 *      and — importantly — does NOT trust user-installed CAs for that origin.
 *   C. The manifest actually points at the config (a config file nothing
 *      references is worthless — that was the whole Android bug).
 *   D. The iOS implementation derives the SPKI from the certificate DER, and
 *      NOT from the platform's raw key encoding.
 *   E. DER/SPKI DERIVATION IS CORRECT: the algorithm implemented in Swift is
 *      re-implemented here and run against the REAL api.medacademy.site leaf and
 *      its Let's Encrypt intermediate. Each must reproduce the configured pin
 *      byte-for-byte. This is the check that would have caught the iOS bug.
 *   F. The detection path is live: a TLS identity rejection maps to
 *      pin_mismatch → ssl_pinning_failure (risk 20 → block_login), while a
 *      timeout stays non-blocking.
 *
 * Run: node tests/certificatePinning.test.cjs
 */

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
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

// ─── Fixtures: the REAL production chain for api.medacademy.site ─────────────
// Fetched from the live origin and pinned here so this test is hermetic.
// Regenerate with:
//   echo | openssl s_client -connect api.medacademy.site:443 \
//     -servername api.medacademy.site -showcerts
const LEAF_DER_B64 =
  'MIIFGjCCBAKgAwIBAgISBdO8Tc8LW1qSJSDay73lFanvMA0GCSqGSIb3DQEBCwUAMDMxCzAJBgNVBAYTAlVTMRYwFAYDVQQKEw1MZXQncyBFbmNyeXB0MQwwCgYDVQQDEwNZUjIwHhcNMjYwOTE4MTcwMDUxWhcNMjYxMjE3MTcwMDUwWjAeMRwwGgYDVQQDExNhcGkubWVkYWNhZGVteS5zaXRlMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAucvkgwgMViDEZTSvD7ccMvgYBx6LyTg0+lOYDZlbQ7oG7MZA7N1m9L1yv7uDbO/rww4EOQZFOy8ajHBlZUV1BDItauWXCI2na30J0er9Kf5xQh2mVuTvVTuLpfIijzTxNRYbTqVrkUV+zeUA0iWYvRyAio4tyfrUsereRZVT4VwknVp7peeNoovIRFSzZQICjOLqesAo/CX76Tw7Mw+Uf/KoElD3r9MiZmNoj3FinCXKw99vxVfcWi6rHEjhHqwJQaeuDeLUApvMZLmzifif0nwhxbcPEh/stvbUY+YRFg24JArVtjuV+4voEDobX11F9gamR/ufHaQ0J3bf1dGK5wIDAQABo4ICOzCCAjcwDgYDVR0PAQH/BAQDAgWgMBMGA1UdJQQMMAoGCCsGAQUFBwMBMAwGA1UdEwEB/wQCMAAwHQYDVR0OBBYEFCbkN3fUM6sZXwtbfqOEXR6lP89iMB8GA1UdIwQYMBaAFEAVLSZ57TIgnt+ach3WMh+BDIEMMDMGCCsGAQUFBwEBBCcwJTAjBggrBgEFBQcwAoYXaHR0cDovL3lyMi5pLmxlbmNyLm9yZy8wNwYDVR0RBDAwLoITYXBpLm1lZGFjYWRlbXkuc2l0ZYIXd3d3LmFwaS5tZWRhY2FkZW15LnNpdGUwEwYDVR0gBAwwCjAIBgZngQwBAgEwLwYDVR0fBCgwJjAkoCKgIIYeaHR0cDovL3lyMi5jLmxlbmNyLm9yZy8xMTIuY3JsMIIBDAYKKwYBBAHWeQIEAgSB/QSB+gD4AH0ARq+GPTs+5Z+ld96oJF02sNntIqIj9GF3QSKUUu6VUF8AAAGgtaxHhwAIAAAFADF/++sEAwBGMEQCIH1YAoHwHDn6EObEzxTMCHvUcibrDCczWSt4P+efGMzUAiAUyMqlv2i6j83MMMwJjYpcuiRb+Xdzc0+ej3IRric+WwB3ANgJVTuUT3r/yBYZb5RPhauw+Pxeh1UmDxXRLnK7RUsUAAABoLWsR2wAAAQDAEgwRgIhAMD1x0XcRUsC9vC/7fWAmLEBYGVjZHgiZtUodPVU71U4AiEA2QJRuWjWo26n1r3M9kYFbXYYs2XapfbpIyXwJ9hilDYwDQYJKoZIhvcNAQELBQADggEBACCm9JWPE1CVhDJFVhB95mLs4tk4jqgLu6hfq6UhGHd7W8cBdOnLzzEGqfmYd6kJ/ap1Xbhhrwsbd2hk/+YjMPeVx2lukRd0j+f73U3CwDKHpGG6GdTEdJhjtGdbTFo4OHf4LiWoxMgy4NFm3PTATEy1j7+nukok1/TcoeTK1lzzrluZVOhOZh8dnwT0xLcuRhX2aZ7pC1XH/LtGPARqCStBABoTvgsUO4GIqRuStsQIT4tQ83eYl+o0JeZP5Cti70iNPnjfw4XGGMw6kAlGongBt58ngR7XOGa7o1Yo6V6KfxQQhwwsJ7g/zWD1h1ZqRiqzYkt7PUcljX9OHb14nAc=';
const INTERMEDIATE_DER_B64 =
  'MIIE2jCCAsKgAwIBAgIQTr0klH4k05SALYSlL9WzGTANBgkqhkiG9w0BAQsFADAuMQswCQYDVQQGEwJVUzENMAsGA1UEChMESVNSRzEQMA4GA1UEAxMHUm9vdCBZUjAeFw0yNTA5MDMwMDAwMDBaFw0yODA5MDIyMzU5NTlaMDMxCzAJBgNVBAYTAlVTMRYwFAYDVQQKEw1MZXQncyBFbmNyeXB0MQwwCgYDVQQDEwNZUjIwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDZ0LxwBppqh84luqMerV/eeL/fXQ7mLQQv1LnpWKZbyvGpx6wh6AfnslAnF6ewTkcHA+gSOoBvm3Dfm06AuGiF+KRut4fAcowqnAQQCW98+QPP/eOv/wug7Iyk4NkOxf2I6g2f55T6nJoOTLFcukeRq80JGQEYan+dPFr9OGUgQK2hGKgNkW87pappsOAuUJcroYhRt5uUis4qaZireiseu32gzDJNBAiKtsvd6HX4v25bpkRNcS/B/Gtc9kVbUpD+2PLPxdei3Tim55k4tfAEXwD2qyiPTxrTNq6lN+AMr5g2c1dNqkOTwjxeV6L5lpP1rGiYvLnRaPlOqyZRPW+5AgMBAAGjge4wgeswDgYDVR0PAQH/BAQDAgGGMBMGA1UdJQQMMAoGCCsGAQUFBwMBMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFEAVLSZ57TIgnt+ach3WMh+BDIEMMB8GA1UdIwQYMBaAFN7nW2DQIm1AKH0/DQH+pLVStFGUMDIGCCsGAQUFBwEBBCYwJDAiBggrBgEFBQcwAoYWaHR0cDovL3lyLmkubGVuY3Iub3JnLzATBgNVHSAEDDAKMAgGBmeBDAECATAnBgNVHR8EIDAeMBygGqAYhhZodHRwOi8veXIuYy5sZW5jci5vcmcvMA0GCSqGSIb3DQEBCwUAA4ICAQB0ZUQWZ9/Yn9COEpo+JfecMnB0h0vwDm/M66IqXqw3LoaLmx9lZvRTeDIS67PUeI3yCA2W6PKRD0/FE/G57lOmS+Xy5AaaL00ICGOqjNcCaMWW8o8nevHOd4i4lqgtznE/28QwlcdJyF8yBiWHpnyjhEpmNWJURgOCOg2xpwRMBCsjMScqYPtOhBeuYQvSwAEeTML2Ukh6uGuX4E14q65Ja8cdjF5bAldnP1eE4FBaAwsZG2fOqqrKV03Y85Nw2btedP1AtliQuJZs/Jo/gXxXdc7LrH3McgnpnbTiAncX7yEShP6kzQejllqMCIt52HOjxDGWafS7Xw+DKwqmH+Eqy8dcbOuag/1AYlQoKNVK3F5qHh6tEDiMqQcLIibGKteE6iHo4A/bIScbzrhXUYuism42ZYzmc48FMVIH3qy4L84ETdAH2gtxw0PAhvRVXp8HP7wfngpzsN/8xOTpeRSbM4+Qbc56G6+Bifmv6sk1ieQbNA3wJdl4DDUuQSV8hBgx6zoI1ZSGORprDFux7c6rhc77QZMSRrEgomBeklervEve86ylWmZ3WWHV6RLMi8xNvjd71r4EPIGgY7BZU/VPBkq+uA7Gb6mbJnFgV43uh3xyLRFgxIAphIukwTGSMZZR+AI+Qnp0BYTWovHXozOf3H8r6hozEoT02JHn0AeTfA==';

// ─── DER reader — a line-for-line port of the Swift implementation ───────────
// tests/… must mirror plugins/ios/PinningURLProtocol.swift. If the Swift walk
// is ever changed, this port must change with it (that is the point).

function readDER(buf, state) {
  if (state.offset >= buf.length) return null;
  const start = state.offset;
  const tag = buf[state.offset++];
  if (state.offset >= buf.length) return null;
  let length = buf[state.offset++];
  if (length & 0x80) {
    const lengthBytes = length & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4 || state.offset + lengthBytes > buf.length) return null;
    length = 0;
    for (let i = 0; i < lengthBytes; i += 1) length = (length << 8) | buf[state.offset++];
  }
  if (state.offset + length > buf.length) return null;
  const valueStart = state.offset;
  const end = valueStart + length;
  state.offset = end;
  return { tag, start, valueStart, end };
}

function subjectPublicKeyInfo(certDER) {
  const s = { offset: 0 };
  const cert = readDER(certDER, s);
  if (!cert || cert.tag !== 0x30) return null;

  const tbsState = { offset: cert.valueStart };
  const tbs = readDER(certDER, tbsState);
  if (!tbs || tbs.tag !== 0x30) return null;

  const fieldState = { offset: tbs.valueStart };
  const first = readDER(certDER, fieldState);
  if (!first || first.tag !== 0xa0) fieldState.offset = tbs.valueStart; // no [0] version

  for (let i = 0; i < 5; i += 1) {
    if (!readDER(certDER, fieldState)) return null;
  }
  const spki = readDER(certDER, fieldState);
  if (!spki || spki.tag !== 0x30) return null;
  return certDER.subarray(spki.start, spki.end);
}

const spkiDigestOf = (derB64) => {
  const der = Buffer.from(derB64, 'base64');
  const spki = subjectPublicKeyInfo(der);
  assert.ok(spki, 'SPKI must be extractable from the certificate DER');
  return crypto.createHash('sha256').update(spki).digest('base64');
};

// ─── A. Pin source of truth ──────────────────────────────────────────────────

const pins = expo?.extra?.medaSslPins;
const hosts = expo?.extra?.medaPinnedHosts;

check('A1 medaSslPins is configured', () => {
  assert.ok(Array.isArray(pins) && pins.length > 0, 'extra.medaSslPins must be a non-empty array');
});
check('A2 every pin is a 32-byte base64 SPKI hash (44 chars)', () => {
  for (const p of pins) assert.equal(p.length, 44, `pin is not 44 chars: ${p}`);
});
check('A3 medaPinnedHosts includes the first-party API origin', () => {
  assert.ok(Array.isArray(hosts) && hosts.includes('api.medacademy.site'), 'api.medacademy.site must be pinned');
});
check('A4 no third-party host is pinned', () => {
  for (const h of hosts) {
    assert.ok(
      !/vdocipher|youtube|google|telegram|ytimg/i.test(h),
      `third-party host must not be pinned (rotation would brick video): ${h}`
    );
  }
});

// ─── B/C. Android network security config ────────────────────────────────────

const nscPlugin = require('../plugins/withNetworkSecurityConfig.js');
const generatedXml = nscPlugin.__internal.buildConfigXml(pins, hosts);

check('B1 plugin is registered in app.json', () => {
  const plugins = JSON.stringify(expo.plugins);
  assert.ok(plugins.includes('withNetworkSecurityConfig'), 'withNetworkSecurityConfig must be in expo.plugins');
});
check('B2 config emits a pin for EVERY configured pin', () => {
  for (const p of pins) {
    assert.ok(generatedXml.includes(`<pin digest="SHA-256">${p}</pin>`), `missing pin: ${p}`);
  }
  const pinCount = (generatedXml.match(/<pin digest="SHA-256">/g) || []).length;
  assert.equal(pinCount, pins.length, 'pin count must match the configured list');
});
check('B3 the pinned host is present with subdomains', () => {
  assert.ok(generatedXml.includes('<domain includeSubdomains="true">api.medacademy.site</domain>'));
});
check('B4 pin-set has an expiration (Android fails OPEN after it — must be maintained)', () => {
  assert.match(generatedXml, /<pin-set expiration="\d{4}-\d{2}-\d{2}">/);
});
check('B5 cleartext is disabled (base + pinned domain)', () => {
  const cleartextOff = (generatedXml.match(/cleartextTrafficPermitted="false"/g) || []).length;
  assert.ok(cleartextOff >= 2, 'both base-config and the pinned domain-config must disable cleartext');
  assert.ok(!/cleartextTrafficPermitted="true"/.test(generatedXml));
});
check('B6 user-installed CAs are NOT a trust anchor for the pinned origin', () => {
  // This is what makes "just install the proxy CA" fail before pinning is even
  // consulted. Only <certificates src="system"/> may appear.
  assert.ok(generatedXml.includes('<certificates src="system" />'));
  assert.ok(
    !generatedXml.includes('src="user"'),
    'src="user" must never appear — a user CA must not be trusted for the API origin'
  );
});
check('B7 no pinning is emitted when no pins are configured (dev)', () => {
  const empty = nscPlugin.__internal.buildConfigXml([], []);
  assert.ok(!empty.includes('<pin-set'), 'unconfigured builds must not emit a pin-set');
  assert.ok(empty.includes('cleartextTrafficPermitted="false"'), 'cleartext must still be off');
});
check('C1 the manifest mod points <application> at @xml/network_security_config', () => {
  const src = read('plugins/withNetworkSecurityConfig.js');
  assert.ok(
    src.includes("application.$['android:networkSecurityConfig'] = '@xml/network_security_config'"),
    'manifest wiring is missing — an unreferenced config file enforces nothing'
  );
  assert.ok(src.includes("application.$['android:usesCleartextTraffic'] = 'false'"));
});
check('C2 the real project source tree contains the wiring (plugins only)', () => {
  // The generated android/ tree is prebuild output; the plugin is the source of truth.
  assert.ok(fs.existsSync(path.join(ROOT, 'plugins', 'withNetworkSecurityConfig.js')));
});

// ─── D. iOS implementation shape ─────────────────────────────────────────────

const swift = read('plugins/ios/PinningURLProtocol.swift');

// Strip //-comments so a comment that DOCUMENTS the old bug cannot be mistaken
// for a reintroduction of it.
const swiftCode = swift
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');

check('D1 iOS hashes the certificate SPKI, not the raw platform key', () => {
  // The bug: SecKeyCopyExternalRepresentation returns PKCS#1 / raw EC bytes,
  // which can NEVER equal an SPKI pin — the check could never match.
  assert.ok(
    !/SecKeyCopyExternalRepresentation/.test(swiftCode),
    'raw-key hashing must not be used in the SPKI pin comparison'
  );
  assert.ok(swiftCode.includes('subjectPublicKeyInfo'), 'SPKI extraction helper is missing');
  assert.ok(
    swiftCode.includes('SecCertificateCopyData'),
    'SPKI must be read from the certificate DER'
  );
});
check('D2 iOS still evaluates system trust BEFORE the pin restriction', () => {
  assert.ok(swift.includes('SecTrustEvaluateWithError'), 'system trust evaluation must remain');
  const trustIdx = swift.indexOf('guard SecTrustEvaluateWithError');
  const chainIdx = swift.indexOf('SecTrustCopyCertificateChain');
  assert.ok(trustIdx > -1 && chainIdx > trustIdx, 'trust must be evaluated before the pin check');
});
check('D3 iOS still fails closed on a pin mismatch', () => {
  assert.ok(swift.includes('.cancelAuthenticationChallenge'), 'a pin mismatch must cancel, never proceed');
});
check('D4 the DER reader rejects malformed input instead of trapping', () => {
  assert.ok(/lengthBytes > 0, lengthBytes <= 4/.test(swift), 'length field must be bounded');
  assert.ok(!/try!|as!|\)!\./.test(swift), 'no force-unwrap/force-try in the pinning path');
});

// ─── E. Algorithm correctness against the REAL chain ─────────────────────────

check('E1 leaf certificate SPKI reproduces pins[0] byte-for-byte', () => {
  assert.equal(spkiDigestOf(LEAF_DER_B64), pins[0]);
});
check('E2 Let’s Encrypt intermediate SPKI reproduces pins[1] byte-for-byte', () => {
  assert.equal(spkiDigestOf(INTERMEDIATE_DER_B64), pins[1]);
});
check('E3 intermediate pin is present (survives 90-day leaf rotation)', () => {
  // Without a CA-level pin, the 90-day leaf renewal would break the app.
  assert.equal(spkiDigestOf(INTERMEDIATE_DER_B64), pins[1]);
  assert.notEqual(pins[0], pins[1], 'leaf and intermediate pins must be distinct');
});
check('E4 DER reader rejects truncated / garbage input', () => {
  assert.equal(subjectPublicKeyInfo(Buffer.from('deadbeef', 'hex')), null);
  assert.equal(subjectPublicKeyInfo(Buffer.alloc(0)), null);
});

// ─── F. Detection path is live (not dead code) ───────────────────────────────

const securityTs = read('src/lib/security.ts');

check('F1 a TLS rejection is classified as tls_rejected, before network patterns', () => {
  assert.ok(securityTs.includes('const tlsRejected'), 'enforcement must classify TLS rejections');
  assert.ok(securityTs.includes("'tls_rejected'"), 'tls_rejected category must be emitted');
  assert.ok(securityTs.includes('SSLPeerUnverifiedException'), 'Android/Conscrypt signature must be matched');
  assert.ok(
    securityTs.includes('certification path not found'),
    'untrusted-chain signature must be matched'
  );
  assert.ok(securityTs.includes('ServerCertificateUntrusted'), 'iOS signature must be matched');
  // The TLS test must come BEFORE the generic network pattern, otherwise a pin
  // failure would be downgraded to a weight-0 reachability observation.
  assert.ok(
    securityTs.indexOf('? \'tls_rejected\'') < securityTs.indexOf("? 'timeout'"),
    'tls_rejected must be resolved before timeout/network_error'
  );
});
check('F2 pinning failure stays BLOCKING (risk 20 → block_login)', () => {
  assert.match(securityTs, /ssl_pinning_failure:\s*20/);
  assert.match(securityTs, /ssl_pinning:\s*'block_login'/);
  assert.match(securityTs, /ssl_pinning:\s*\['ssl_pinning_failure'\]/);
});
check('F3 a probe timeout stays NON-blocking (no mass false positives)', () => {
  assert.match(securityTs, /connection_probe_degraded:\s*0/);
  assert.match(securityTs, /connection_probe:\s*'log_only'/);
});
check('F4 the stale "no native pin enforcement is wired" note is gone', () => {
  assert.ok(
    !securityTs.includes('no native pin enforcement'),
    'the comment claiming Android has no pinning must be removed now that it does'
  );
});

// Classifier behaviour (pure function, shipped defaults).
// Compiled by scripts/run-state-tests.cjs (npm run test:state) into
// scripts/state-build/, with the legacy .freebuff/state-build/ still honoured.
function requireStateModel(name) {
  const path = require('node:path');
  const fs = require('node:fs');
  for (const dir of ['scripts/state-build', '.freebuff/state-build']) {
    const p = path.join(__dirname, '..', dir, name);
    if (fs.existsSync(p)) return require(p);
  }
  throw new Error(`compiled state model not found: ${name} — run: npm run test:state`);
}
let model = null;
try {
  model = requireStateModel('securityStateModel.js');
} catch {
  model = null;
}
if (model) {
  check('F5 classifier: tls_rejected + online → pin_mismatch (blocking)', () => {
    assert.equal(model.classifySslProbe(false, true, 'tls_rejected'), 'pin_mismatch');
    assert.equal(model.isSslProbeSecurityFinding('pin_mismatch'), true);
  });
  check('F6 classifier: timeout + online → origin_unreachable (NOT blocking)', () => {
    assert.equal(model.classifySslProbe(false, true, 'timeout'), 'origin_unreachable');
    assert.equal(model.isSslProbeSecurityFinding('origin_unreachable'), false);
  });
  check('F7 classifier: both probes failed → no_connectivity (NOT blocking)', () => {
    assert.equal(model.classifySslProbe(false, false, 'tls_rejected'), 'no_connectivity');
    assert.equal(model.isSslProbeSecurityFinding('no_connectivity'), false);
  });
  check('F8 classifier: origin answered → pin_verified', () => {
    assert.equal(model.classifySslProbe(true, null, 'none'), 'pin_verified');
  });
} else {
  console.log('  note  compiled securityStateModel.js absent (run npm run test:state) — classifier checks skipped');
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed} assertions passed${failures.length ? ` — ${failures.length} FAILED` : ''}.`);
if (failures.length) {
  failures.forEach((f) => console.log(`  ✗ ${f}`));
  process.exitCode = 1;
} else {
  console.log('Certificate pinning regression suite: OK\n');
}
