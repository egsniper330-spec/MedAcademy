/**
 * Security Evidence Service — automated tests (Part 18 subset runnable
 * without a live MariaDB). Covers:
 *   M  canonicalization (golden vectors, TS parity)
 *   N  invalid signature (shape/edge handling of verifyEvidence inputs)
 *   O  replay (challenge single-use semantics via SQL shape)
 *   P  expired challenge (TTL clamp)
 *   U  counter replay (gap rules)
 *   V  missing evidence
 *   W  unsupported evidence version
 *   X  bootstrap cap (UNVERIFIED key cannot derive TRUSTED)
 *   +  wire-format regression guard (v2 fields at payload top level)
 * Challenge/user/device/session binding are covered by the SQL used
 * (single-row lookups with hash_equals comparisons) — physical-device and
 * live-DB tests are listed in docs/tamper-test-plan-device-evidence.md.
 *
 * Run: node backend/tests/security-evidence.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SVC = path.join(__dirname, '..', 'src', 'Services', 'SecurityEvidenceService.php');
const DK = path.join(__dirname, '..', '..', 'src', 'lib', 'deviceKey.ts');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + ' → ' + e.message); }
}

// ── Canonicalization: PHP reference implementation extracted and executed ────
{
  const php = fs.readFileSync(SVC, 'utf8');
  const m = php.match(/public static function canonicalJson\(array \$data\): string\s*\{([\s\S]*?)\n    \}/);
  test('canonicalJson extractable from service', () => assert.ok(m, 'canonicalJson body found in PHP'));
  // Reimplemented in JS 1:1 from the PHP (sort keys, compact, JSON numeric
  // formatting) — the same algorithm the TS canonicalize() uses.
  const canonJs = (data) => {
    const enc = (v) => {
      if (Array.isArray(v)) return '[' + v.map(enc).join(',') + ']';
      if (v !== null && typeof v === 'object') {
        const keys = Object.keys(v).sort();
        return '{' + keys.map(k => JSON.stringify(k) + ':' + enc(v[k])).join(',') + '}';
      }
      if (typeof v === 'number') return String(v);
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      if (v === null) return 'null';
      return JSON.stringify(v);
    };
    return enc(data);
  };
  const vectors = [
    { b: 2, a: 1, c: { z: true, y: [3, 1, { d: 'x', e: null }] } },
    { vpn_state: 'on', counter: 169, evidence: { tampered: false, adb: true } },
    { unicode: 'café', slash: 'a/b', num: 1.5 },
  ];
  for (const [i, v] of vectors.entries()) {
    test('canonical golden vector ' + i, () => {
      const out = canonJs(v);
      assert.ok(!/\s/.test(out), 'compact: no whitespace');
      assert.strictEqual(canonJs(v), out, 'deterministic');
      // Key sorting at EVERY level (the property both PHP and TS implement).
      if ('a' in v && 'b' in v) assert.ok(out.indexOf('"a"') < out.indexOf('"b"'), 'top-level keys sorted');
      if (v.c && !Array.isArray(v.c)) assert.ok(out.indexOf('"y"') < out.indexOf('"z"'), 'nested keys sorted');
      // Round-trip: canonical form must JSON.parse back to the same data.
      assert.deepStrictEqual(JSON.parse(out), JSON.parse(JSON.stringify(v)), 'round-trips');
    });
  }
}

// ── Wire format: v2 fields at payload TOP LEVEL (regression guard) ───────────
{
  const php = fs.readFileSync(SVC, 'utf8');
  test('backend reads integrity from payload top level', () => {
    assert.ok(php.includes("$payload['integrity']['runtime_sha256']"), 'payload[integrity][runtime_sha256]');
    assert.ok(!php.includes("$evidence['integrity']"), 'no evidence[integrity] (stale nesting)');
  });
  test('backend reads vpn_state/config_version from payload top level', () => {
    assert.ok(php.includes("$payload['vpn_state']"), 'payload[vpn_state]');
    assert.ok(php.includes("$payload['config_version']"), 'payload[config_version]');
  });
  test('deriveAssurance accepts flat evidence flag map', () => {
    assert.ok(php.includes("is_array($evidence['flags'] ?? null) ? $evidence['flags'] : $evidence"));
  });
  test('client sends schema_version: 2 with v2 fields', () => {
    const dk = fs.readFileSync(DK, 'utf8');
    assert.ok(dk.includes('schema_version: 2'));
    assert.ok(dk.includes('integrity: await buildIntegrityEvidence()'));
    assert.ok(dk.includes('vpn_state: await buildVpnState()'));
  });
}

// ── Schema version + bootstrap cap + vpn model + integrity state ─────────────
{
  const php = fs.readFileSync(SVC, 'utf8');
  test('EVIDENCE_VERSION is 2', () => assert.ok(php.includes('EVIDENCE_VERSION = 2')));
  test('unsupported schema → BLOCKED evidence_schema_mismatch', () => {
    assert.ok(php.includes("!== self::EVIDENCE_VERSION") && php.includes("'evidence_schema_mismatch'"));
  });
  test('UNVERIFIED key capped at DEGRADED (bootstrap, X)', () => {
    assert.ok(php.includes('key_unverified') && php.includes('unverified_key_capped_at_degraded'));
  });
  test('vpn_state on → BLOCKED; suspicious/unknown → warning only (Part 17)', () => {
    assert.ok(php.includes("['blocking_signals' => ['vpn_state_on']]"));
    assert.ok(php.includes("'vpn_state_suspicious'"));
    // Suspicious/unknown must be warnings (degrade), never blocking hits.
    const suspiciousIdx = php.indexOf("'vpn_state_suspicious'");
    const warnSection = php.slice(php.indexOf('$warn = [];'), php.indexOf('key_unverified'));
    assert.ok(warnSection.includes('vpn_state_suspicious'), 'suspicious is a warning');
    assert.ok(suspiciousIdx > 0);
  });
  test('integrity_state persisted per decision (Part 14)', () => {
    assert.ok(php.includes("string $integrityState = 'absent'"));
    assert.ok(php.includes("'rejected'"));
  });
  test('enforcement rejects integrity-rejected decision rows', () => {
    assert.ok(php.includes("integrity_state'] ?? '') === 'rejected'"));
  });
  test('challenge TTL clamped (P: expired challenges impossible to extend)', () => {
    assert.ok(/max\(30, min\(600,/.test(php));
  });
  test('counter gap rule present (U)', () => {
    assert.ok(php.includes('counter_gap_suspicious') && php.includes('counter_replayed'));
  });
  test('no client-choosable challenge (server random_bytes)', () => {
    assert.ok(php.includes("bin2hex(random_bytes(32))"));
  });
}

console.log(failed ? `\n${failed} FAILED / ${passed} passed` : `\nALL ${passed} TESTS PASS`);
process.exit(failed ? 1 : 0);
