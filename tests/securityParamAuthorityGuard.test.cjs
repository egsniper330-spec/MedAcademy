#!/usr/bin/env node
/**
 * securityParamAuthorityGuard.test.cjs — regression suite for
 * scripts/check-security-param-authority.js
 *
 * Run: node tests/securityParamAuthorityGuard.test.cjs
 *
 * ─── WHAT THIS PINS ──────────────────────────────────────────────────────────
 *
 * The guard exists because a screen once rendered SECURITY FACTS from route
 * params: `router.replace('/security-warning')` passed none, so the param-derived
 * defaults ([], 0, false) were displayed as "no issues, risk 0" while the real
 * verdict said otherwise. A deep link could do the same deliberately.
 *
 * A new guard is only worth having if it (a) catches that, and (b) does not fire
 * on legitimate param use, because noise gets ignored and then deleted. So this
 * suite tests BOTH directions, and tests them against files on disk rather than
 * against patterns in the guard's own source:
 *
 *   • the real app is clean, AND the audit trail proves the guard actually
 *     classified the two security-warning screens (not vacuous);
 *   • every violation shape is caught, with the exact rule id;
 *   • every legitimate shape stays allowed, including the two false-positive
 *     classes the guard shipped with on its first run;
 *   • the pre-login exemption is real, narrow, and VOID once the screen can
 *     consult the authoritative verdict;
 *   • the guard fails closed: an empty or misconfigured scan can never report
 *     success, because "the control never ran" must not read as "satisfied".
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT   = path.resolve(__dirname, '..');
const GUARD  = path.join(ROOT, 'scripts', 'check-security-param-authority.js');
const FIXDIR = path.join(ROOT, 'tests', 'fixtures', 'security-param-authority');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  \u2705 ' + name); }
  else { failed++; console.error('  \u274c ' + name); }
}

/** Run the guard; never throws, so a non-zero exit is data rather than a crash. */
function runGuard(args) {
  const res = spawnSync(process.execPath, [GUARD, ...args], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { json = null; }
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', json };
}

const rulesByFile = (json) => {
  const map = {};
  for (const v of json?.violations ?? []) (map[v.file] ??= []).push(v.rule);
  return map;
};
const fieldsFor = (json, file, reason) =>
  (json?.allowed ?? []).filter((a) => a.file === file && a.reason === reason);

// ════════════════════════════════════════════════════════════════════════════
// PART A — the real app is clean, and that result is NOT vacuous
// ════════════════════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Part A: the app itself passes, with an audit trail \u2500\u2500');
{
  const run = runGuard(['--json', '--verbose']);

  check('the guard runs and exits 0 on the real app', run.status === 0);
  check('no violations are reported', (run.json?.violations ?? []).length === 0);
  check('the guard parsed the app (readRouteParams > 0)', (run.json?.readRouteParams ?? 0) > 0);

  // Non-vacuity: the guard must have SEEN the security-warning screens and
  // classified their param use, not skipped them.
  const guarded = fieldsFor(run.json, 'src/app/(app)/security-warning.tsx', 'authoritative-first fallback');
  check('the authenticated warning screen was analysed and its fallbacks judged authoritative-first',
    guarded.length >= 3
    && ['threats', 'riskScore', 'blocksLogin'].every((f) => guarded.some((g) => g.fields.includes(f))));

  const exempt = fieldsFor(run.json, 'src/app/(auth)/security-warning.tsx', 'pre-login exemption');
  check('the pre-login warning screen was analysed and classified as exempt (not skipped)',
    exempt.length >= 3);

  check('the guard never reports the same file twice for one rule',
    new Set((run.json?.violations ?? []).map((v) => `${v.file}:${v.line}:${v.rule}`)).size
      === (run.json?.violations ?? []).length);
}

// ════════════════════════════════════════════════════════════════════════════
// PART B — every violation shape is caught
// ════════════════════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Part B: violations are caught, with the right rule \u2500\u2500');

/** fixture -> the EXACT rules (and count) that must be reported for it. */
const EXPECTED_VIOLATIONS = {
  'violation-no-authoritative.tsx': [
    'PARAM_AUTHORITY_UNEXEMPTED_DERIVATION',
    'PARAM_AUTHORITY_UNEXEMPTED_DERIVATION',
    'PARAM_AUTHORITY_UNEXEMPTED_DERIVATION',
  ],
  'violation-unguarded-fallback.tsx': ['PARAM_AUTHORITY_UNGUARDED_DERIVATION'],
  'violation-override.tsx': ['PARAM_AUTHORITY_OVERRIDE'],
  'violation-into-security-api.tsx': ['PARAM_AUTHORITY_INTO_SECURITY_API'],
  // computed access / renamed local — the field name is what identifies the value
  'violation-computed-access.tsx': ['PARAM_AUTHORITY_UNEXEMPTED_DERIVATION'],
};

const VALID_FIXTURES = [
  'valid-authoritative-fallback.tsx',
  'valid-param-for-navigation.tsx',
  'valid-vetted-value-downstream.tsx',
  'valid-non-security-blockers.tsx',
  'valid-comment-mentions-params.tsx',
];

/** fixture paths that must exist — a deleted fixture must not silently shrink this suite. */
const REQUIRED_FIXTURES = [
  ...Object.keys(EXPECTED_VIOLATIONS).map((f) => `scan/${f}`),
  ...VALID_FIXTURES.map((f) => `scan/${f}`),
  'prelogin-root/src/app/(auth)/security-warning.tsx',
  'prelogin-root-authoritative/src/app/(auth)/security-warning.tsx',
  'no-param-reads/PlainScreen.tsx',
];

{
  check('every required fixture exists on disk',
    REQUIRED_FIXTURES.every((rel) => fs.existsSync(path.join(FIXDIR, rel))));

  const scanRoot = path.join(FIXDIR, 'scan');
  const run = runGuard(['--root', scanRoot, '--target', '.', '--json', '--verbose']);
  const rules = rulesByFile(run.json);

  check('a violating fixture set exits non-zero (would fail CI)', run.status === 1);

  for (const [file, expected] of Object.entries(EXPECTED_VIOLATIONS)) {
    const actual = (rules[file] ?? []).slice().sort();
    check(`catches ${file} -> ${[...new Set(expected)].join(' + ')}`,
      actual.length === expected.length
      && actual.join(',') === expected.slice().sort().join(','));
  }

  // The original defect must be caught by name — the score, findings and gate flag.
  const buggy = fieldsFor(run.json, 'violation-no-authoritative.tsx', 'authoritative-first fallback');
  const buggyFields = (run.json?.violations ?? [])
    .filter((v) => v.file === 'violation-no-authoritative.tsx')
    .map((v) => v.detail);
  check('the pre-fix screen shape is flagged for all three security values',
    buggy.length === 0
    && ['threats', 'riskScore', 'blocksLogin'].every((f) => buggyFields.some((d) => d.includes(f))));

  check('no rule reports a file/line it cannot point at', (run.json?.violations ?? [])
    .every((v) => v.line > 0 && v.col > 0 && typeof v.code === 'string' && v.code.length > 0));
}

// ════════════════════════════════════════════════════════════════════════════
// PART C — legitimate param use stays allowed (no noise)
// ════════════════════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Part C: legitimate param usage is not flagged \u2500\u2500');
{
  const scanRoot = path.join(FIXDIR, 'scan');
  const run = runGuard(['--root', scanRoot, '--target', '.', '--json', '--verbose']);
  const rules = rulesByFile(run.json);
  const allowedFiles = new Set((run.json?.allowed ?? []).map((a) => a.file));

  for (const file of VALID_FIXTURES) {
    check(`allows ${file} (0 violations)`, (rules[file] ?? []).length === 0);
    // ...and proves the file was analysed rather than skipped.
    check(`analysed ${file} (audit entry present)`, allowedFiles.has(file));
  }

  // The exact false positives the guard shipped with, pinned by name.
  const blockersAllowed = (run.json?.allowed ?? [])
    .some((a) => a.file === 'valid-non-security-blockers.tsx' && a.fields.includes('blockers'));
  check('a non-security "blockers" param is allowed (case-sensitive block* pattern)', blockersAllowed);

  const downstream = rulesByFile(run.json);
  check('display state computed from an already-vetted value is allowed',
    (downstream['valid-vetted-value-downstream.tsx'] ?? []).length === 0
    && (run.json?.allowed ?? []).some(
      (a) => a.file === 'valid-vetted-value-downstream.tsx' && a.reason === 'authoritative-first fallback'));
}

// ════════════════════════════════════════════════════════════════════════════
// PART D — the pre-login exemption is real, narrow, and conditional
// ════════════════════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Part D: pre-login is exempted only while it is presentation-only \u2500\u2500');
{
  const exemptRun = runGuard([
    '--root', path.join(FIXDIR, 'prelogin-root'),
    '--target', '.', '--json', '--verbose',
  ]);
  check('a presentation-only pre-login screen passes', exemptRun.status === 0
    && (exemptRun.json?.violations ?? []).length === 0);

  const exempt = fieldsFor(exemptRun.json, 'src/app/(auth)/security-warning.tsx', 'pre-login exemption');
  check('the exemption is recorded with the exact fields it covers',
    exempt.length === 3
    && ['threats', 'riskScore', 'blocksLogin'].every((f) => exempt.some((e) => e.fields.includes(f))));

  const authoritativeRun = runGuard([
    '--root', path.join(FIXDIR, 'prelogin-root-authoritative'),
    '--target', '.', '--json',
  ]);
  const rules = (authoritativeRun.json?.violations ?? []).map((v) => v.rule);
  check('the exemption is VOID once the screen can consult the authoritative verdict',
    authoritativeRun.status === 1
    && rules.length === 3
    && rules.every((r) => r === 'PARAM_AUTHORITY_UNGUARDED_DERIVATION'));
}

// ════════════════════════════════════════════════════════════════════════════
// PART E — the guard cannot fail open, and it is wired into CI
// ════════════════════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Part E: fail-closed, and integrated into the validation workflow \u2500\u2500');
{
  const empty = runGuard(['--root', path.join(FIXDIR, '__does_not_exist__'), '--target', '.']);
  check('scanning a missing root fails (never a vacuous pass)', empty.status === 1);
  check('the failure explains itself', /refusing to report success/i.test(empty.stderr));

  // Files were found, but none of them reads params: the rule set cannot have
  // been exercised, so a pass here would be meaningless.
  const noParams = runGuard(['--root', FIXDIR, '--target', 'no-param-reads']);
  check('a scan that found files but exercised no param read fails', noParams.status === 1);
  check('that failure explains itself too', /cannot have been exercised/i.test(noParams.stderr));

  const validateAll = fs.readFileSync(path.join(ROOT, 'scripts', 'validate-all.js'), 'utf8');
  check('npm run validate runs the guard as a stage',
    validateAll.includes('check-security-param-authority.js'));

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const scripts = pkg.scripts ?? {};
  const wired = Object.entries(scripts)
    .filter(([, cmd]) => typeof cmd === 'string' && cmd.includes('check-security-param-authority.js'));
  check('package.json exposes the guard as a script', wired.length >= 1);
  check('the guard is reachable from npm test or npm run validate',
    Object.entries(scripts).some(([name, cmd]) =>
      typeof cmd === 'string'
      && cmd.includes('check-security-param-authority.js')
      && (name === 'test' || name === 'validate' || name.startsWith('lint'))));
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log('\n' + '\u2500'.repeat(64));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nSecurity param-authority guard regression suite FAILED');
  process.exit(1);
}
console.log('Security param-authority guard regression suite passed');
