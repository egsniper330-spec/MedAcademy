/**
 * Phase-3 micro-gap tests (Part 7). Static-analysis assertions over the
 * authoritative service source — executable without a live MariaDB.
 * Live-DB execution paths are marked PENDING-PHYSICAL/LIVE-DB where noted.
 * Run: node backend/tests/microgap-security.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SVC = path.join(__dirname, '..', 'src', 'Services', 'SecurityEvidenceService.php');
const CTRL = path.join(__dirname, '..', 'src', 'Controllers', 'SecurityEvidenceController.php');
const DK = path.join(__dirname, '..', '..', 'src', 'lib', 'deviceKey.ts');
const CPP = path.join(__dirname, '..', '..', '.freebuff', 'medasec_core.cpp');

const svc = fs.readFileSync(SVC, 'utf8');
const ctrl = fs.readFileSync(CTRL, 'utf8');
const dk = fs.readFileSync(DK, 'utf8');
const cpp = fs.readFileSync(CPP, 'utf8');

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + ' → ' + e.message); }
};

// ── 1. First-seen baseline cannot automatically create TRUSTED ────────────────
test('1. anchoring never grants TRUSTED by itself (anchored ≠ attestation)', () => {
  assert.ok(svc.includes("$integrityState = 'anchored';"), 'anchored state recorded');
  // TRUSTED is returned ONLY after the verified-key check.
  const trusted = svc.indexOf("return ['TRUSTED'");
  const cap = svc.indexOf('unverified_key_capped_at_degraded');
  assert.ok(cap > 0 && trusted > cap, 'TRUSTED return sits after the bootstrap cap');
  assert.ok(!svc.includes("'anchored' => 'TRUSTED'"), 'no anchored→TRUSTED mapping exists');
});

test('1b. promotion requires integrity HISTORY (cannot fabricate retroactively)', () => {
  assert.ok(svc.includes('promotion_require_integrity_history'), 'policy key exists');
  assert.ok(svc.includes("integrity_state IN (\\'anchored\\', \\'ok\\'"), 'history query over decision rows');
  assert.ok(svc.includes("if ((int) $anchored === 0) {") && svc.includes('return false;'), 'zero-history → no promotion');
});

// ── 2. Modified integrity measurement cannot override a server pin ────────────
test('2. pin precedence: pinned digest is compared BEFORE any baseline write', () => {
  const section = svc.slice(svc.indexOf('5c. Server-anchored INTEGRITY BASELINE'), svc.indexOf('6. Consume the challenge'));
  const pinIdx = section.indexOf('pinnedIntegrityBaseline()');
  const anchorIdx = section.indexOf("integrity_baseline_sha256 = ?");
  assert.ok(pinIdx > 0 && pinIdx < anchorIdx, 'pin check precedes first-seen write');
  assert.ok(section.includes("'integrity_mismatch'"), 'mismatch → BLOCKED');
});

test('2b. pin source is server config; client input cannot reach it', () => {
  assert.ok(svc.includes("pinnedIntegrityBaseline()"), 'loader used');
  const loader = svc.slice(svc.indexOf('public static function pinnedIntegrityBaseline'), svc.indexOf('*/', svc.indexOf('pinnedIntegrityBaseline')) + 2);
  assert.ok(!loader.includes('$payload') && !loader.includes('$_REQUEST') && !loader.includes('$body'), 'pin loader reads no client input');
});

// ── 3/4. Wrong digest → intended state; client cannot downgrade ──────────────
test('3/4. mismatch decisions are BLOCKED + integrity_state=rejected', () => {
  const hits = svc.match(/recordDecision\([\s\S]*?'integrity_mismatch'[\s\S]*?'rejected'\)/g) || [];
  assert.ok(hits.length >= 2, 'both pin-mismatch and baseline-mismatch persist rejected rows');
  assert.ok(svc.includes("integrity_state'] ?? '') === 'rejected'"), 'enforcement rejects them');
});

// ── 5. UNVERIFIED key remains capped ─────────────────────────────────────────
test('5. bootstrap cap intact', () => {
  assert.ok(svc.includes('unverified_key_capped_at_degraded'));
});

// ── 6/7. verified_at cannot be client-controlled ─────────────────────────────
test('6/7. no client path writes verified_at; registration INSERT omits it', () => {
  const reg = svc.slice(svc.indexOf('public static function registerDeviceKey'), svc.indexOf('public static function', svc.indexOf('public static function registerDeviceKey') + 10));
  assert.ok(!reg.includes('verified_at'), 'registerDeviceKey never touches verified_at');
  // Only tryPromoteKey writes it, guarded by its own server-side checks.
  const writes = [...svc.matchAll(/UPDATE device_keys SET[^']*verified_at[^']*'/g)].map(m => m[0]);
  assert.strictEqual(writes.length, 1, 'exactly one verified_at write');
  assert.ok(svc.indexOf(writes[0]) > svc.indexOf('public static function tryPromoteKey'), 'that write is inside tryPromoteKey');
});

test('6b. controller register endpoint exposes no verified_at/promotion fields', () => {
  assert.ok(!ctrl.includes("'verified_at'"), 'controller never accepts verified_at');
});

// ── 8/9/10. Strict semantics (enforce_strict requires TRUSTED) ────────────────
test('8/9. enforce_strict accepts TRUSTED only (unverified device cannot use)', () => {
  assert.ok(svc.includes("? [(string) $row['assurance']] === ['TRUSTED']"), 'strict = TRUSTED-only');
  assert.ok(svc.includes("'key_not_verified_or_assurance_low'"), 'explicit rejection reason');
});

test('10. device_bind tier defaults unchanged (log_only default preserved)', () => {
  assert.ok(svc.includes("'device_bind' => 'log_only'"), 'default tier untouched — operator flips explicitly');
});

// ── 11–14. Replay / wrong device / wrong session / wrong hash ────────────────
test('11. transactional single-use challenge (replay)', () => {
  assert.ok(svc.includes('WHERE id = ? AND consumed_at IS NULL') && svc.includes('rowCount() === 1'));
});
test('12. wrong device key rejected', () => {
  assert.ok(svc.includes("'challenge_device_mismatch'") && svc.includes("'device_key_unregistered'"));
});
test('13. wrong session rejected', () => {
  assert.ok(svc.includes('challenge_session_mismatch'));
});
test('14. wrong request hash rejected', () => {
  assert.ok(svc.includes('request_hash_mismatch') && svc.includes('hash_equals'));
});

// ── 15. Runtime evidence changes reflect correctly (counter/vpn) ─────────────
test('15. vpn_state model wired from payload level', () => {
  assert.ok(svc.includes("$payload['vpn_state'] ?? null"), 'threaded from payload');
  assert.ok(svc.includes("['blocking_signals' => ['vpn_state_on']]"), 'on → BLOCKED');
  assert.ok(svc.includes("'vpn_state_suspicious'"), 'suspicious → warning (not block)');
});

// ── 16. Native security evidence included correctly ──────────────────────────
test('16. native_net validated and bounded when present', () => {
  assert.ok(svc.includes("native_net'] ?? null"), 'validated field');
  assert.ok(dk.includes('parsed.native_net = JSON.parse(netRaw)'), 'client threads it into integrity blob');
  assert.ok(cpp.includes('networkEvidenceJson') && cpp.includes('/proc/net/dev') && cpp.includes('/proc/net/route'), 'C++ collector present');
});

// ── 17. Unsupported evidence versions rejected safely ─────────────────────────
test('17. strict schema_version equality (v1 payload → rejected)', () => {
  assert.ok(svc.includes("(int) ($evidence['schema_version'] ?? 0) !== self::EVIDENCE_VERSION"));
  assert.ok(svc.includes('EVIDENCE_VERSION = 2'));
});

// ── 18. Pinned integrity cannot be changed by the client ─────────────────────
test('18. pin lives in security_config (server DB), not in any client-writable surface', () => {
  const loader = svc.slice(svc.indexOf('public static function pinnedIntegrityBaseline'), svc.indexOf('public static function canonicalJson'));
  assert.ok(loader.includes("policy['integrity_pinned_sha256']"), 'pin read from server policy');
  assert.ok(!loader.includes('$payload') && !loader.includes('$body'), 'no client input');
  // Client cannot set it: registration/verify payload keys never include the pin.
  assert.ok(!svc.includes("$body['integrity_pinned"), 'no body path for pin');
});

// ── Part 1: string protection honest classification ──────────────────────────
test('P1. string tables decode exactly (obfuscation, not encryption)', () => {
  const tun = [...cpp.match(/kTunPatterns\[\]\[12\] = \{([\s\S]*?)\};/)[1].matchAll(/\{(\d+), \{([\s\S]*?)\}\}/g)];
  const wants = ['tun', 'tap', 'ppp', 'tun0', 'tunl0', 'ppp0', 'ipsec', 'gsm0'];
  tun.forEach((m, i) => {
    const len = +m[1];
    const got = m[2].split(',').map(x => parseInt(x.trim(), 16)).slice(0, len).map(b => String.fromCharCode(b ^ 0x5A)).join('');
    assert.strictEqual(got, wants[i], 'tun row ' + i);
  });
  const thr = [...cpp.match(/kThreadIndicatorsEnc\[4\]\[11\] = \{([\s\S]*?)\};/)[1].matchAll(/\{(\d+), \{([\s\S]*?)\}\}/g)];
  const tw = ['gmain', 'gdbus', 'frida', 'pool-frida'];
  thr.forEach((m, i) => {
    const len = +m[1];
    const got = m[2].split(',').map(x => parseInt(x.trim(), 16)).slice(0, len).map(b => String.fromCharCode(b ^ 0x3C)).join('');
    assert.strictEqual(got, tw[i], 'thread row ' + i);
  });
});

// ── Part 2: R8 config evidence ───────────────────────────────────────────────
test('P2. R8: library-wide keeps narrowed (okhttp/okio/kotlin/expo/play-integrity)', () => {
  const pg = fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'proguard-rules.pro'), 'utf8');
  assert.ok(!pg.includes('-keep class okhttp3.**'), 'okhttp blanket removed');
  assert.ok(!pg.includes('-keep class kotlin.**'), 'kotlin blanket removed');
  assert.ok(!pg.includes('-keep class expo.modules.**'), 'expo blanket removed');
  assert.ok(pg.includes('-keep class com.google.android.play.core.integrity.IntegrityManagerFactory'), 'play narrowed to entry class');
  assert.ok(pg.includes('-keep class com.medacademy.security.**'), 'security keep retained (RN bridge reflection)');
  assert.ok(pg.includes('-keepclasseswithmembernames class com.medacademy.security.SecurityNativeCore'), 'JNI keep retained');
});

console.log(failed ? `\n${failed} FAILED / ${passed} passed` : `\nALL ${passed} MICRO-GAP TESTS PASS`);
process.exit(failed ? 1 : 0);
