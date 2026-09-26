/**
 * securityStartupFlash.test.cjs — startup "Security Block Active" flash regression.
 *
 * BUG (fixed): every cold start briefly rendered the full-screen
 *   "SECURITY BLOCK ACTIVE / Security Check Incomplete / Risk Score: 10"
 * page, online AND offline, because SecurityContext served a synthetic
 * blocking sentinel (security_unverified, risk 10, blocksLogin) as the GLOBAL
 * result whenever no completed evaluation existed, and SecurityGate mounted
 * on `blocksLogin && threats.length > 0`. Transition was UNKNOWN → BLOCKED →
 * SAFE — a false violation display, not a timeout race (no timer hack was or
 * is involved).
 *
 * FIX under test (state-machine level):
 *   • resolveGatePhase() — pure, dependency-free (securityStateModel.ts) —
 *     is the single authoritative gate-visibility decision:
 *       pending  (no completed verdict / evaluation in flight) → gate NEVER mounts
 *       unlocked (completed non-blocking verdict)              → gate unmounted
 *       blocked  (policy-confirmed live or sticky block)       → gate mounted
 *   • SecurityContext publishes NEUTRAL_STARTUP_RESULT (no threats, no fake
 *     risk score) before the first verdict; the fail-closed UNKNOWN sentinel
 *     survives ONLY as check()'s caller-scoped return (login, pre-video).
 *   • Evaluation THROWS keep the last verdict globally (a network/backend
 *     failure is not a violation) while the caller still gets fail-closed.
 *
 * Scenarios map (task spec):
 *   A online startup   → A1 CHECKING no block UI, A2 SAFE normal, A3 BLOCKED gate
 *   B offline startup  → network checks unavailable ⇒ no block UI; local safe ⇒ continues
 *   C real violation   → offline + local detector violation ⇒ BLOCKED
 *   D network failure  → thrown evaluation ⇒ NOT globally blocked
 *   E risk score       → no "Risk Score: 10" from the sentinel; pill only with verdict
 *   F foreground       → re-evaluation never flashes the gate on a safe device
 *   G regression       → offline fast-path, sticky recovery, login fail-closed,
 *                        video re-validation, gate copy, no timer-based hiding
 *
 * Run: node tests/securityStartupFlash.test.cjs
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
const failures = [];
function check(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failures.push(msg); console.error(`  ✗ ${msg}`); }
}
function checkEq(actual, expected, msg) {
  check(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkDeep(actual, expected, msg) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// ── Compile the PURE state model standalone (same contract as run-state-tests) ─
function buildStateModel() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'flashbuild-'));
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(ROOT, 'src', 'lib', 'securityStateModel.ts'),
      '--outDir', out,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
    ],
    { stdio: 'pipe' },
  );
  return require(path.join(out, 'securityStateModel.js'));
}
const model = buildStateModel();
const { resolveGatePhase, nextStickyTypes } = model;

const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r/g, '');
const ctxSrc = src('src/lib/SecurityContext.tsx');
const gateSrc = src('src/app/(app)/security-gate.tsx');
const secSrc = src('src/lib/security.ts');
const signInSrc = src('src/app/(auth)/sign-in.tsx');
const lessonSrc = src('src/app/(app)/lesson/[id].tsx');

// ═══ A. ONLINE STARTUP ═══════════════════════════════════════════════════════
console.log('\n── A. Online startup ──');
{
  // A1: CHECKING (no verdict yet, evaluation in flight) → pending → NO gate.
  checkEq(
    resolveGatePhase({ hasVerdict: false, evaluating: true, liveBlocking: false, stickyCount: 0 }),
    'pending',
    'A1 CHECKING resolves pending — gate never mounts during startup evaluation',
  );
  checkEq(
    resolveGatePhase({ hasVerdict: false, evaluating: false, liveBlocking: false, stickyCount: 0 }),
    'pending',
    'A1 no verdict at all (pre-first-check) resolves pending — no block UI',
  );

  // A2: completed SAFE verdict → unlocked (normal app).
  checkEq(
    resolveGatePhase({ hasVerdict: true, evaluating: false, liveBlocking: false, stickyCount: 0 }),
    'unlocked',
    'A2 SAFE verdict resolves unlocked — normal app, no gate',
  );

  // A3: completed BLOCKING verdict → blocked (gate mounts), even mid-recheck.
  checkEq(
    resolveGatePhase({ hasVerdict: true, evaluating: false, liveBlocking: true, stickyCount: 0 }),
    'blocked',
    'A3 BLOCKED verdict resolves blocked — gate mounts',
  );
  checkEq(
    resolveGatePhase({ hasVerdict: true, evaluating: true, liveBlocking: true, stickyCount: 0 }),
    'blocked',
    'A3 live block wins over an in-flight re-check (no temp all-clear)',
  );
}

// ═══ B. OFFLINE STARTUP ══════════════════════════════════════════════════════
console.log('\n── B. Offline startup ──');
{
  // Before the (offline-capable) evaluation lands: pending, never blocked.
  checkEq(
    resolveGatePhase({ hasVerdict: false, evaluating: true, liveBlocking: false, stickyCount: 0 }),
    'pending',
    'B offline cold start resolves pending — no "Security Check Incomplete" wall',
  );
  // After it lands with local checks safe: unlocked → offline app continues.
  checkEq(
    resolveGatePhase({ hasVerdict: true, evaluating: false, liveBlocking: false, stickyCount: 0 }),
    'unlocked',
    'B offline + local checks safe resolves unlocked — offline mode continues',
  );
  // The offline detector-skip contract is still in place (network absence is
  // handled INSIDE the pipeline; it never produces a blocking finding).
  check(
    /genuinely offline[^\n]*skipping network-bound detectors/.test(secSrc),
    'B security pipeline keeps the genuine-offline fast-path (network absence ≠ security finding)',
  );
}

// ═══ C. REAL LOCAL VIOLATION (offline) ═══════════════════════════════════════
console.log('\n── C. Real local violation still blocks ──');
{
  checkEq(
    resolveGatePhase({ hasVerdict: false, evaluating: true, liveBlocking: true, stickyCount: 0 }),
    'blocked',
    'C a live policy-confirmed block mounts the gate regardless of pending state',
  );
  checkEq(
    resolveGatePhase({ hasVerdict: true, evaluating: true, liveBlocking: false, stickyCount: 2 }),
    'blocked',
    'C a previously-verified sticky block stays mounted while re-validating offline',
  );
}

// ═══ D. NETWORK FAILURE ≠ BLOCKED ════════════════════════════════════════════
console.log('\n── D. Network/backend failure during evaluation ──');
{
  // The catch path must NOT publish the fail-closed fallback globally anymore.
  const catchBlock = ctxSrc.slice(ctxSrc.indexOf('runSecurityChecks() threw'), ctxSrc.indexOf('} finally {', ctxSrc.indexOf('runSecurityChecks() threw')));
  assert(catchBlock.length > 0, 'D SecurityContext evaluation catch block located');
  check(
    !/setResult\(/.test(catchBlock),
    'D thrown evaluation does NOT publish a synthetic block globally (last verdict/neutral stays)',
  );
  check(
    /return fallback;/.test(catchBlock) || /return BLOCKING_UNKNOWN_RESULT;/.test(catchBlock),
    'D the CALLER still receives the fail-closed fallback (sensitive action stays gated)',
  );
  // A failure before any verdict keeps the global state pending — not blocked.
  checkEq(
    resolveGatePhase({ hasVerdict: false, evaluating: false, liveBlocking: false, stickyCount: 0 }),
    'pending',
    'D failed first evaluation (no verdict) leaves the global phase pending — not blocked',
  );
}

// ═══ E. RISK SCORE ═══════════════════════════════════════════════════════════
console.log('\n── E. Risk score sentinel never displayed pre-verdict ──');
{
  check(
    /result \?\? NEUTRAL_STARTUP_RESULT/.test(ctxSrc),
    'E global pre-verdict result is NEUTRAL (riskScore 0, no threats) — never the sentinel',
  );
  // The global provider tail must default to NEUTRAL, never the sentinel.
  // (check()'s caller-scoped `return result ?? BLOCKING_UNKNOWN_RESULT` is
  // intentional and preserved — it gates the sensitive ACTION, not global UI.)
  const globalR = ctxSrc.match(/const r = isSuperAdmin\s*\?[\s\S]*?;\n/);
  check(
    globalR !== null && /NEUTRAL_STARTUP_RESULT/.test(globalR[0]) && !/BLOCKING_UNKNOWN_RESULT/.test(globalR[0]),
    'E the blocking sentinel is no longer served as the global default (provider tail uses NEUTRAL)',
  );
  // The gate renders the risk pill ONLY from a completed verdict. (Use the
  // LAST 'Risk Score:' occurrence — earlier ones exist inside comments.)
  const pillIdx = gateSrc.lastIndexOf('Risk Score:');
  const pillGuard = gateSrc.lastIndexOf('{hasVerdict && (', pillIdx);
  check(
    pillGuard !== -1 && pillIdx - pillGuard < 800,
    'E gate renders the risk pill only when hasVerdict (no fake "Risk Score: 10")',
  );
  // The neutral result carries score 0 with no synthetic threat.
  const neutral = ctxSrc.slice(ctxSrc.indexOf('const NEUTRAL_STARTUP_RESULT'), ctxSrc.indexOf('};', ctxSrc.indexOf('const NEUTRAL_STARTUP_RESULT')));
  assert(/riskScore:\s*0/.test(neutral) && /threats:\s*\[\]/.test(neutral), 'E NEUTRAL_STARTUP_RESULT has riskScore 0 and no synthetic threat');
}

// ═══ F. FOREGROUND RECHECK — no false flash ══════════════════════════════════
console.log('\n── F. Foreground re-evaluation ──');
{
  // Safe device, recheck in flight: pending/unlocked — the gate stays unmounted.
  const safeRecheck = resolveGatePhase({ hasVerdict: true, evaluating: true, liveBlocking: false, stickyCount: 0 });
  check(safeRecheck !== 'blocked', 'F recheck on a safe device never mounts the gate (no flash)');
  // Blocked device, recheck in flight: gate stays mounted (sticky + live).
  checkEq(
    resolveGatePhase({ hasVerdict: true, evaluating: true, liveBlocking: false, stickyCount: 1 }),
    'blocked',
    'F recheck while blocked keeps the gate mounted (sticky fail-closed preserved)',
  );
  // Sticky machine: in-flight recheck keeps a verified block; completed safe clears it.
  checkDeep(
    nextStickyTypes(['vpn_detected'], { checking: true, liveBlocking: false, liveThreatTypes: [] }),
    ['vpn_detected'],
    'F nextStickyTypes keeps the verified block during an in-flight recheck',
  );
  checkDeep(
    nextStickyTypes(['vpn_detected'], { checking: false, liveBlocking: false, liveThreatTypes: [] }),
    [],
    'F nextStickyTypes clears on a completed non-blocking evaluation (auto-recovery)',
  );
}

// ═══ G. REGRESSION ═══════════════════════════════════════════════════════════
console.log('\n── G. Regressions (security preserved) ──');
{
  // The state machine is the single mount decision — driven by state, not time.
  check(
    /resolveGatePhase\(\{/.test(gateSrc) && /phase === 'blocked'/.test(gateSrc),
    'G gate mount decision comes from resolveGatePhase (state-driven, no timer)',
  );
  check(
    !/setTimeout\([\s\S]{0,80}blocking\s*=\s*false/.test(gateSrc),
    'G no timer-based hiding of the security block',
  );
  check(
    /if \(!blocking\) return null;/.test(gateSrc),
    'G gate renders null when not blocking (normal startup/loading stays visible)',
  );
  // context exposes the new contract
  assert(/hasVerdict:/.test(ctxSrc) && /phase:/.test(ctxSrc), 'G context exposes hasVerdict + phase');
  // check() caller-scoped fail-closed preserved for login
  check(
    /const secResult = await check\(installationId\);/.test(signInSrc) &&
      /if \(secResult\.blocksLogin\)/.test(signInSrc),
    'G sign-in still gates login on check() blocksLogin (fail-closed preserved)',
  );
  // video surfaces still re-validate before playback
  check(
    /const blocked = await checkBeforeVideo\(\);/.test(lessonSrc),
    'G lesson playback still re-validates via checkBeforeVideo (video protection intact)',
  );
  // sticky set still authoritative in the gate
  assert(/nextStickyTypes\(/.test(gateSrc), 'G gate still uses the sticky transition (verified blocks survive rechecks)');
  // the historical mislabeled sentinel stays fixed (never 'tamper_detected')
  check(
    !/type: 'tamper_detected', detectionMethod: 'Security evaluation/.test(ctxSrc),
    'G fail-closed sentinel remains security_unverified (never masquerades as tamper)',
  );
}

console.log(`\n═══ securityStartupFlash: ${passed} passed, ${failures.length} failed ═══`);
if (failures.length) {
  failures.forEach((f) => console.error(`  FAIL: ${f}`));
  process.exit(1);
}
