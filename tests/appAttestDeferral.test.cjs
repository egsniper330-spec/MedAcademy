#!/usr/bin/env node
/**
 * App Attest deferral — regression suite for the platform-integrity status model.
 *
 * Run: node tests/appAttestDeferral.test.cjs
 *
 * ─── WHAT THIS PINS ──────────────────────────────────────────────────────────
 *
 * PRODUCT DECISION: full Apple App Attest enforcement is TEMPORARILY DEFERRED
 * (backend verification is not configured — `POST /integrity/app` fails closed
 * with 503 — and the Apple entitlement is not set). Decision record:
 * docs/PRODUCTION_READINESS_AUDIT.md §8.
 *
 * The danger a deferral creates is not that the control is off — it is that a
 * control that never runs gets reported as satisfied. Before this model the
 * pipeline collapsed everything into one nullable boolean, so "we could not
 * check" and "we checked and it is fine" were indistinguishable. That is a
 * security-reporting defect: ATT&CK-relevant coverage that does not exist must
 * not be presented as coverage.
 *
 * The model (src/lib/platformIntegrity.ts) therefore separates five states and
 * enforces two invariants this suite locks down:
 *
 *   • ONLY `passed` means verified success.
 *   • ONLY `failed` may block — every other state is non-blocking, so an
 *     intentionally-deferred control cannot lock users out and equally cannot be
 *     mistaken for coverage.
 *
 * Plus: a deliberate 503 deferral must never be reported as a pass, must never
 * be silently converted into one, and must never be turned into a false
 * `app_attest_failed` finding (a real verified failure and a configuration
 * problem are different outcomes).
 *
 * The module is dependency-free by design, so it is compiled standalone here —
 * matching tests/securityGateState.test.cjs.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/**
 * Strip comments for shape assertions — CONSERVATIVELY.
 *
 * A naive globally-matched block-comment regex is unsafe here: a "/" + "*" that
 * occurs *inside a string* gets paired with the next real comment terminator
 * anywhere later in the file, so the whole span between them is deleted. Two
 * files in this repo trigger it:
 *
 *   • src/app/(app)/security-diagnostics.tsx — a detector doc string quoting the
 *     procfs cmdline glob ("cmdline" under a "/proc/" + "*" path), which
 *     silently deleted lines 114-261 (8 KB of live screen code, including the
 *     line this suite asserts on).
 *   • docs/PRODUCTION_READINESS_AUDIT.md — inline `tests/*.test.cjs` in a table,
 *     which silently deleted lines 11-88 of the audit document.
 *
 * Both produced assertions evaluated against text that did not reflect disk, i.e.
 * failures (and passes) that had nothing to do with the code.
 *
 * So an opener is only treated as a comment when it is NOT inside a string
 * literal — detected by an odd number of quotes earlier on the same line. Every
 * real comment in this repo (doc blocks, banner comments, a catch block's
 * trailing note, JSX comments) still strips exactly as before, because none of
 * them sit inside a quoted span; a string-literal opener is left verbatim so it
 * can never be paired with an unrelated terminator.
 *
 * Known limit: an opener on a line *between* the quotes of a multi-line string
 * is still treated as a comment. No file here does that, and the self-checks in
 * Part H pin both directions of the behaviour that matters.
 */
const stripBlockComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (match, offset, whole) => {
  const lineStart = whole.lastIndexOf('\n', offset) + 1;
  const before    = whole.slice(lineStart, offset);
  const odd       = (q) => (before.split(q).length - 1) % 2 === 1;
  return (odd("'") || odd('"') || odd('`')) ? match : '';   // inside a string → keep
});

const readCode = (rel) => stripBlockComments(read(rel))
  .split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  \u2705 ' + name); }
  else { failed++; console.error('  \u274c ' + name); }
}

function buildModule() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platint-model-'));
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(ROOT, 'src', 'lib', 'platformIntegrity.ts'),
      '--outDir', tmp,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
  return require(path.join(tmp, 'platformIntegrity.js'));
}

const P = buildModule();

const ALL = ['not_checked', 'passed', 'failed', 'deferred', 'unavailable', 'error'];
const NON_VERDICT = ['not_checked', 'deferred', 'unavailable', 'error'];

// ════════════════════════════════════════════════════════════════════════════
// PART A — the two invariants
// ════════════════════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Part A: only `passed` is verified, only `failed` may block \u2500\u2500');
{
  check('every status is handled (no silent fallthrough)',
    ALL.every((s) => typeof P.platformIntegrityLabel(s) === 'string'));

  for (const s of ALL) {
    const rec = { status: s, platform: 'ios', detail: null, updatedAt: null };
    check(`isVerifiedPass('${s}') === ${s === 'passed'}`, P.isVerifiedPass(rec) === (s === 'passed'));
    check(`isVerifiedFailure('${s}') === ${s === 'failed'}`, P.isVerifiedFailure(rec) === (s === 'failed'));
  }

  // The critical pair: a deferred/unavailable/error state is NEITHER a pass NOR a
  // failure — it is "we do not know", and must be reportable as such.
  for (const s of NON_VERDICT) {
    const rec = { status: s, platform: 'ios', detail: null, updatedAt: null };
    check(`'${s}' is not a pass and not a failure`,
      !P.isVerifiedPass(rec) && !P.isVerifiedFailure(rec));
    check(`'${s}' is reported as unverified`, P.isUnverified(rec) === true);
  }

  for (const s of ['passed', 'failed']) {
    const rec = { status: s, platform: 'ios', detail: null, updatedAt: null };
    check(`'${s}' counts as verified (not unverified)`, P.isUnverified(rec) === false);
  }

  check('isDeferred is true only for deferred',
    P.isDeferred({ status: 'deferred', platform: 'ios', detail: null, updatedAt: null }) === true
    && NON_VERDICT.filter((s) => s !== 'deferred')
      .every((s) => P.isDeferred({ status: s, platform: 'ios', detail: null, updatedAt: null }) === false));

  check('VERIFIED_STATUSES is exactly [passed, failed]',
    [...P.VERIFIED_STATUSES].sort().join(',') === 'failed,passed');
  check('NON_VERDICT_STATUSES holds the four non-verdict states',
    [...P.NON_VERDICT_STATUSES].sort().join(',') === 'deferred,error,not_checked,unavailable');
  check('the two lists are disjoint and cover every status',
    P.VERIFIED_STATUSES.length + P.NON_VERDICT_STATUSES.length === ALL.length
    && P.VERIFIED_STATUSES.every((s) => !P.NON_VERDICT_STATUSES.includes(s)));
}

// ════════════════════════════════════════════════════════════════════════════
// PART B — classifying the HTTP 503 "not configured" deferral
// ════════════════════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Part B: a 503 deferral is `deferred`, never a pass \u2500\u2500');
{
  const d503 = P.classifyIntegrityError({ status: 503, message: 'App Attest server verification is not configured' }, 'ios');
  check('HTTP 503 \u21d2 deferred', d503.status === 'deferred');
  check('HTTP 501 \u21d2 deferred', P.classifyIntegrityError({ status: 501 }, 'ios').status === 'deferred');
  check('the deferral detail says it is NOT a pass', /NOT a pass/i.test(d503.detail));
  check('the deferral detail names the status code', /503/.test(d503.detail));

  // A 503 that is the server-wide maintenance gate is NOT a deferral decision.
  check('maintenance 503 \u21d2 error (not a product deferral)',
    P.classifyIntegrityError({ status: 503, code: 'maintenance_mode' }, 'ios').status === 'error');
  check('maintenance matched from the message too',
    P.classifyIntegrityError({ status: 503, message: 'Service under maintenance' }, 'ios').status === 'error');

  // Everything else is inconclusive — also never a pass.
  check('HTTP 500 \u21d2 error', P.classifyIntegrityError({ status: 500 }, 'ios').status === 'error');
  check('HTTP 422 \u21d2 error', P.classifyIntegrityError({ status: 422 }, 'ios').status === 'error');
  const netErr = P.classifyIntegrityError({}, 'ios');
  check('a network error \u21d2 error', netErr.status === 'error');
  check('a network error detail says it is NOT a pass', /NOT a pass/i.test(netErr.detail));
  check('a null/undefined error is handled', P.classifyIntegrityError(null, 'ios').status === 'error');

  check('no classified error ever yields passed',
    [[503, {}], [501, {}], [500, {}], [422, {}], [null, {}], [503, { code: 'maintenance_mode' }]]
      .every(([status, extra]) => P.classifyIntegrityError({ status, ...extra }, 'ios').status !== 'passed'));
  check('no classified error ever yields failed (only a real verdict may)',
    [[503, {}], [500, {}], [422, {}]]
      .every(([status, extra]) => P.classifyIntegrityError({ status, ...extra }, 'ios').status !== 'failed'));
}

// ════════════════════════════════════════════════════════════════════════════
// PART C — reporting never renders an unverified state as PASS
// ════════════════════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Part C: diagnostics/report text can never say PASS when unverified \u2500\u2500');
{
  check('the passed label is PASS', P.platformIntegrityLabel('passed') === 'PASS');
  check('the failed label is FAIL', P.platformIntegrityLabel('failed') === 'FAIL');

  for (const s of NON_VERDICT) {
    const label = P.platformIntegrityLabel(s);
    check(`'${s}' label is not PASS`, !/\bPASS\b/.test(label));
    check(`'${s}' label never claims a verified result`,
      /NOT VERIFIED|NOT CHECKED/.test(label));
  }

  check('deferred is labelled DEFERRED / NOT VERIFIED',
    P.platformIntegrityLabel('deferred') === 'DEFERRED / NOT VERIFIED');
  check('unavailable is labelled UNAVAILABLE / NOT VERIFIED',
    P.platformIntegrityLabel('unavailable') === 'UNAVAILABLE / NOT VERIFIED');
  check('error is labelled INCONCLUSIVE / NOT VERIFIED',
    P.platformIntegrityLabel('error') === 'INCONCLUSIVE / NOT VERIFIED');
  check('not_checked is labelled NOT CHECKED',
    P.platformIntegrityLabel('not_checked') === 'NOT CHECKED');

  for (const s of NON_VERDICT) {
    const desc = P.describePlatformIntegrity({ status: s, platform: 'ios', detail: null, updatedAt: null });
    check(`describe('${s}') never says PASS`, !/\bPASS\b/.test(desc));
  }
  const deferDesc = P.describePlatformIntegrity({
    status: 'deferred', platform: 'ios', detail: 'Server verification not configured (HTTP 503) — NOT a pass', updatedAt: 1,
  });
  check('describe(deferred) reads DEFERRED / NOT VERIFIED (ios)', /^DEFERRED \/ NOT VERIFIED \(ios\)/.test(deferDesc));
  check('describe carries the reason', /HTTP 503/.test(deferDesc));
}

// ════════════════════════════════════════════════════════════════════════════
// PART D — the recording store
// ════════════════════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Part D: the recorder is last-write-wins, resettable, and non-mutating \u2500\u2500');
{
  P.resetPlatformIntegrity();
  check('a fresh store is not_checked', P.getPlatformIntegrity().status === 'not_checked');
  check('a fresh store has no timestamp', P.getPlatformIntegrity().updatedAt === null);

  P.resetPlatformIntegrity();
  P.recordPlatformIntegrity({ status: 'unavailable', platform: 'android', detail: 'no Play Services', now: 111 });
  check('a recorded status is readable', P.getPlatformIntegrity().status === 'unavailable');
  check('the platform is recorded', P.getPlatformIntegrity().platform === 'android');
  check('the detail is recorded', P.getPlatformIntegrity().detail === 'no Play Services');
  check('the timestamp is recorded', P.getPlatformIntegrity().updatedAt === 111);

  P.recordPlatformIntegrity({ status: 'passed', platform: 'android', detail: 'ok', now: 222 });
  check('last write wins', P.getPlatformIntegrity().status === 'passed');
  check('the newer detail replaces the older one', P.getPlatformIntegrity().detail === 'ok');

  const snapshot = P.getPlatformIntegrity();
  snapshot.status = 'failed';
  snapshot.detail = 'mutated';
  check('getPlatformIntegrity returns a copy (callers cannot corrupt the store)',
    P.getPlatformIntegrity().status === 'passed');

  P.resetPlatformIntegrity();
  check('reset returns the store to not_checked', P.getPlatformIntegrity().status === 'not_checked');

  // Platform inference must not throw without EXPO_OS.
  check('platform inference degrades safely to "unknown"',
    P.platformFromProcessEnv() === 'unknown');
  const prevOs = process.env.EXPO_OS;
  process.env.EXPO_OS = 'ios';
  check('platform inference reads EXPO_OS', P.platformFromProcessEnv() === 'ios');
  process.env.EXPO_OS = prevOs;
}

// ════════════════════════════════════════════════════════════════════════════
// PART E — security.ts wiring
// ════════════════════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Part E: the pipeline records an honest status at every exit \u2500\u2500');
{
  const security = readCode('src/lib/security.ts');

  check('the pipeline imports the status model', /from '@\/lib\/platformIntegrity'/.test(security));
  check('the pipeline records statuses via a single helper', /function settlePlatformIntegrity\(/.test(security));
  check('every exit records through the helper',
    (security.match(/settlePlatformIntegrity\(/g) || []).length >= 10);

  // The OLD fail-open: `if (!token) { _piResult = true; ... }` presented a device
  // with no Play Services as a pass. It must now be reported as unavailable.
  check('a missing Play Integrity token is reported UNAVAILABLE, not passed',
    /settlePlatformIntegrity\('unavailable', 'Play Integrity token unavailable/.test(security));
  check('the threat-decision cache is documented as NOT a verdict',
    /_piResult.*THREAT-DECISION cache|THREAT-DECISION cache/.test(read('src/lib/security.ts')));

  // A verdict status may only be recorded from an explicit server confirmation.
  const verdictRecords = security.match(/settlePlatformIntegrity\(\s*(?:passed|dcPassed) \? 'passed' : 'failed'/g) || [];
  check('verdicts are recorded only from an explicit server result', verdictRecords.length === 3);
  check('every recorded pass is guarded by a `passed === true` check',
    /verifyData\?\.passed === true/.test(security) && /dcData\?\.passed === true/.test(security));

  // No error branch may record a pass.
  check('no verify-error branch records a pass',
    !/if \(verifyErr\) \{[\s\S]{0,300}?settlePlatformIntegrity\(\s*'passed'/.test(security));
  check('no deferred branch records a pass',
    !/status === 'deferred'[\s\S]{0,120}?settlePlatformIntegrity\(\s*'passed'/.test(security));

  // A deliberate deferral must not become a false finding.
  check('app_attest_failed is emitted only from a real negative verdict',
    (security.match(/if \(!(?:dc)?[Pp]assed\) \{\s*return \{\s*\n?\s*type: 'app_attest_failed'/g) || []).length === 2);
  check('the deferral path returns no threat',
    /classifyIntegrityError\(attestErr, 'ios'\)/.test(security)
    && /finishUnverified/.test(security));
  check('the unverified exit is typed to return null',
    /const finishUnverified = \(\): null => \{/.test(security));

  // Logout must not leave a stale status describing a previous session.
  check('clearing the App Attest key resets the recorded status',
    /resetPlatformIntegrity\(\)/.test(security));
}

console.log('\n\u2500\u2500 Part E2: the Super Admin diagnostics surface shows the status \u2500\u2500');
{
  const screen = readCode('src/app/(app)/security-diagnostics.tsx');
  check('the diagnostics screen reads the status model', /from '@\/lib\/platformIntegrity'/.test(screen));
  check('it renders the label', /platformIntegrityLabel\(integrity\.status\)/.test(screen));
  check('it renders the reason', /\{integrity\.detail &&/.test(screen));
  check('it states that only PASS means verified',
    /ONLY\s*“PASS”\s*means the platform actually verified this device/.test(read('src/app/(app)/security-diagnostics.tsx')));
  // Anchored to the start of a line, so only a real statement satisfies it — prose
  // or a commented-out copy of the call cannot.
  check('it keeps reading the live status (refreshed on run)',
    /\n[ \t]*setIntegrity\(getPlatformIntegrity\(\)\);/.test(screen));
}

// ════════════════════════════════════════════════════════════════════════════
// PART F — no other control was weakened to accommodate the deferral
// ════════════════════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Part F: every other security control is unchanged \u2500\u2500');
{
  const security = readCode('src/lib/security.ts');
  const guard = readCode('src/lib/screenCaptureGuard.ts');
  const signing = readCode('plugins/withProductionSigning.js');

  // Integrity weights/policies (both platforms).
  check('app_attest_failed weight is still 30', /app_attest_failed:\s+30/.test(security));
  check('app_attest policy is still block_login', /app_attest:\s*'block_login'/.test(security));
  check('play_integrity_failed weight is still 30', /play_integrity_failed:\s+30/.test(security));
  check('play_integrity policy is still block_login', /play_integrity:\s*'block_login'/.test(security));
  check('Android Play Integrity is still enforced (not short-circuited)',
    /PLAY_INTEGRITY_READY/.test(security) && /requestPlayIntegrityToken\(/.test(security));

  // Other restored protections.
  check('FLAG_SECURE capture protection has no disable constant',
    !/FLAG_SECURE_DEBUG_DISABLED/.test(guard) && /preventScreenCaptureAsync/.test(guard));
  check('the capture opt-out is development-only (ANDed with __DEV__)',
    /__DEV__\s*===?\s*true\s*&&[\s\S]{0,120}EXPO_DISABLE_CAPTURE_PROTECTION|__DEV__/.test(guard));
  check('ADB detection is unconditional (no disable constant)',
    /flags\.adbEnabled/.test(security) && !/DEBUG_DISABLE_DEV_OPTIONS_AND_ADB/.test(security));
  check('Developer-Options detection is unconditional', /flags\.developerOptionsEnabled/.test(security));
  check('mock-location detection is REMOVED (no field, no event, no score)',
    !/mockLocationDetected/.test(security) && !/detectMockLocation/.test(security));
  check('VPN/proxy weights unchanged', /vpn_detected:\s+15/.test(security) && /proxy_detected:\s+15/.test(security));

  // Signing pin still fail-closed.
  check('the release build still fails without the signing pin', /GradleException/.test(signing));
  check('tamper detection still requires a configured pin',
    /expectedCertConfigured/.test(security));
}

// ════════════════════════════════════════════════════════════════════════════
// PART G — the deferral is documented, and never claimed to be working
// ════════════════════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Part G: the decision record exists and is honest \u2500\u2500');
{
  const audit = read('docs/PRODUCTION_READINESS_AUDIT.md');

  check('a decision record exists', /## 8\. App Attest — DECISION RECORD \(deferred\)/.test(audit));
  check('it states the decision', /TEMPORARILY DEFERRED/.test(audit));
  check('it states it is NOT an active enforcement control',
    /NOT an active enforcement control/.test(audit));
  check('it records the reason (backend verification not configured)', /verification is not configured/i.test(audit));
  check('it records the reason (entitlement not completed)', /entitlement[\s\S]{0,80}not completed/i.test(audit));
  check('it has a Scope section', /### 8\.3 Scope/.test(audit));
  check('it has a Remaining-risk section', /### 8\.4 Remaining risk/.test(audit));
  check('it lists the work required to enable it later', /### 8\.5 Required work to enable it later/.test(audit));
  check('it has a revisit condition', /### 8\.6 Revisit condition/.test(audit));
  check('it confirms other controls remain mandatory', /### 8\.7 Other security controls remain mandatory/.test(audit));
  check('it documents the five-state status model',
    /`deferred`/.test(audit) && /`unavailable`/.test(audit) && /`passed`/.test(audit) && /`failed`/.test(audit));
  check('it states the residual risk explicitly',
    /iOS has no active\s+platform-integrity\s+enforcement|no active global platform|cannot be emitted/.test(audit)
    || /iOS has no active/.test(audit.replace(/\s+/g, ' ')));

  const checklist = read('docs/DEVICE_VALIDATION_CHECKLIST.md');
  check('the device checklist marks iOS integrity DEFERRED / NOT VERIFIED',
    /DEFERRED \/ NOT VERIFIED/.test(checklist));
  check('the checklist says it must never read PASS',
    /never `PASS`|never \*\*display\*\* `PASS`/.test(checklist));
}

// ════════════════════════════════════════════════════════════════════════════
// PART H — the harness itself cannot lie about what is on disk
// ════════════════════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Part H: the comment-stripping harness is conservative \u2500\u2500');
{
  // The failure this part exists for: readCode() silently deleted 8 KB of the
  // diagnostics screen because a doc string contained "/proc/*/cmdline". If that
  // regresses, every assertion in Part E2 is evaluated against text that is not
  // the file, so assertions pass and fail for no real reason.
  const diagRaw    = read('src/app/(app)/security-diagnostics.tsx');
  const diagCode   = readCode('src/app/(app)/security-diagnostics.tsx');
  const auditRaw   = read('docs/PRODUCTION_READINESS_AUDIT.md');
  const auditCode  = readCode('docs/PRODUCTION_READINESS_AUDIT.md');

  check('a "/*" inside a string does not delete the code that follows it',
    diagCode.includes('setIntegrity(getPlatformIntegrity());'));
  check('a "/*" inside a string does not swallow the detector table',
    diagCode.includes('emulatorDetected:') && diagCode.includes('fridaDetected:'));
  check('inline-code "/*" in the audit doc does not delete the doc',
    auditCode.includes('| `tests/*.test.cjs` |'));
  check('the audit doc keeps its decision-record prose',
    /DECISION RECORD|Decision record/.test(auditCode));
  check('stripping still removes real line-start block comments '
    + '(the nav-path helpers doc)',
    /Security Diagnostics Screen/.test(diagRaw) && !/Security Diagnostics Screen/.test(diagCode));
  check('stripping still removes line comments',
    !/^\s*\/\//m.test(diagCode) && diagCode.length < diagRaw.length);
  check('the audit doc is not treated as code (no comment stripping of prose)',
    auditCode.length === auditRaw.length);
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log('\n' + '\u2500'.repeat(64));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nApp Attest deferral regression suite FAILED');
  process.exit(1);
}
console.log('App Attest deferral regression suite passed');
