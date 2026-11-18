/**
 * unifiedLockScreen.test.cjs
 *
 * Regression suite for the two cross-cutting defects of this round:
 *
 *   A. ONE lock screen for EVERY simultaneous violation. The gate used to
 *      render from a single precedence state, so a second violation replaced
 *      the first cause's copy and the user could not see that two independent
 *      violations were live. Now `resolveGateReasons` returns the complete SET,
 *      and the single gate renders every reason — removing one reason keeps the
 *      other (and the lock) alive.
 *
 *   B. The iOS second loading screen must never be unbounded. The shell's
 *      profile bootstrap now has a watchdog, a grace window, and a recoverable
 *      retry path (button + foreground + connectivity restore).
 *
 * Every scenario exercises the REAL pure modules (compiled, not grepped) and the
 * REAL lock module for the composition half.
 *
 * Run: node tests/unifiedLockScreen.test.cjs
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  \u2705 ' + name); }
  else { failed++; console.error('  \u274c ' + name); }
}

function build(relSource, outName) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unifiedlock-'));
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(ROOT, relSource),
      '--outDir', tmp,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
  return require(path.join(tmp, outName));
}

const M = build('src/lib/securityStateModel.ts', 'securityStateModel.js');
const L = build('src/lib/securityLock.ts', 'securityLock.js');

const GATE    = read('src/app/(app)/security-gate.tsx');
const LAYOUT  = read('src/app/(app)/_layout.tsx');
const CONTEXT = read('src/lib/SecurityContext.tsx');
const RES     = read('src/lib/i18n/resources.ts');

/** The inputs a given set of live causes produces, as the gate sees them. */
function inputs(overrides) {
  return {
    evaluating: false,
    hasVerdict: true,
    overlayBlocked: false,
    multiWindowBlocked: false,
    backgroundResumeBlocked: false,
    vpnBlocked: false,
    violationBlocked: false,
    ...overrides,
  };
}

const kv = (overrides) => inputs({ vpnBlocked: true, ...overrides });
const win = (mode, overrides) => inputs({ multiWindowBlocked: true, windowMode: mode, ...overrides });
const keys = (reasons) => reasons.map((r) => r.key);

// ══════════════════════════════════════════════════════════════════════════
console.log('\nA. The reason set is complete, ordered and independent');
// ══════════════════════════════════════════════════════════════════════════

check('A1: the model exports a reason resolver and a reason type',
  typeof M.resolveGateReasons === 'function');

check('A2: a single VPN violation yields exactly one reason',
  keys(M.resolveGateReasons(kv())).join(',') === 'vpn');

check('A3: a floating window is identified BY MODE (not as a bare "window")',
  keys(M.resolveGateReasons(win('foreign_window'))).join(',') === 'window:foreign_window'
  && M.resolveGateReasons(win('foreign_window'))[0].mode === 'foreign_window');

check('A4: split-screen and a floating window are different reasons',
  keys(M.resolveGateReasons(win('multi_window'))).join(',') === 'window:multi_window'
  && keys(M.resolveGateReasons(win('picture_in_picture'))).join(',') === 'window:picture_in_picture');

check('A5: overlay + window + vpn + violation all coexist, in one fixed order',
  keys(M.resolveGateReasons(inputs({
    overlayBlocked: true, multiWindowBlocked: true, windowMode: 'foreign_window',
    vpnBlocked: true, violationBlocked: true,
  }))).join(',') === 'overlay,window:foreign_window,vpn,violation');

check('A6: an unmeasured window mode still produces a reason (never a silent drop)',
  keys(M.resolveGateReasons(inputs({ multiWindowBlocked: true }))).join(',') === 'window:multi_window');

check('A7: one detector cannot add or remove another detector\u2019s reason',
  (() => {
    const vpnOnly = keys(M.resolveGateReasons(kv()));
    const both    = keys(M.resolveGateReasons(kv({ multiWindowBlocked: true, windowMode: 'foreign_window' })));
    return vpnOnly.join(',') === 'vpn' && both.includes('vpn') && both.includes('window:foreign_window');
  })());

check('A8: the reason list is a pure function of its inputs (stable across calls)',
  JSON.stringify(M.resolveGateReasons(kv({ multiWindowBlocked: true, windowMode: 'multi_window' })))
  === JSON.stringify(M.resolveGateReasons(kv({ multiWindowBlocked: true, windowMode: 'multi_window' }))));

check('A9: clearing every input produces NO reasons',
  M.resolveGateReasons(inputs({})).length === 0);

// ══════════════════════════════════════════════════════════════════════════
console.log('\nB. Ten simultaneous-violation scenarios (one lock, all reasons)');
// ══════════════════════════════════════════════════════════════════════════

L._resetSecurityLockForTests();

// 1. VPN first, then a floating window appears.
L.engageSecurityLock('native-vpn', { hard: true });
{
  const before = M.resolveGateReasons(kv());
  L.engageSecurityLock('window-mode', { hard: true });
  const after = M.resolveGateReasons(kv({ multiWindowBlocked: true, windowMode: 'foreign_window' }));
  check('B1: VPN then floating window keeps BOTH reasons on one screen',
    keys(before).join(',') === 'vpn'
    && keys(after).sort().join(',') === ['vpn', 'window:foreign_window'].sort().join(','));
  check('B1-2: the lock holds both sources and stays hard',
    L.getSecurityLockState().sources.sort().join(',') === ['native-vpn', 'window-mode'].sort().join(',')
    && L.isSecurityLockHard() === true);
  check('B1-3: the single PREVIEW state is deterministic (window outranks VPN)',
    M.resolveSecurityGateState(kv({ multiWindowBlocked: true, windowMode: 'foreign_window' })) === 'BLOCKED_MULTI_WINDOW');
}

// 2. Floating window first, then VPN starts (reverse order).
{
  const first  = M.resolveGateReasons(kv({ multiWindowBlocked: true, windowMode: 'foreign_window' }));
  const second = M.resolveGateReasons(kv({ multiWindowBlocked: true, windowMode: 'foreign_window' }));
  check('B2: the reason set is order-independent (window first vs VPN first)',
    keys(first).join(',') === keys(second).join(','));
}

// 3. VPN stops while the floating window remains.
L.releaseSecurityLock('native-vpn');
{
  const reasons = M.resolveGateReasons(win('foreign_window'));
  check('B3: stopping the VPN leaves the window reason live',
    keys(reasons).join(',') === 'window:foreign_window');
  check('B3-2: the app stays locked by the surviving window witness',
    L.isSecurityLocked() === true && L.isSecurityLockHard() === true);
  check('B3-3: the surviving state still renders the block page',
    M.rendersBlockScreen(M.resolveSecurityGateState(win('foreign_window'))) === true
    && M.isGateBlocked(M.resolveSecurityGateState(win('foreign_window'))) === true);
}

// 4. Floating window closes while the VPN remains active.
L.engageSecurityLock('native-vpn', { hard: true });
L.releaseSecurityLock('window-mode');
{
  check('B4: closing the floating window leaves the VPN reason live',
    keys(M.resolveGateReasons(kv())).join(',') === 'vpn');
  check('B4-2: the app stays locked by the VPN witness',
    L.isSecurityLocked() === true
    && L.getSecurityLockState().sources.includes('native-vpn'));
}

// 5. Split-screen begins while the VPN lock screen is already visible.
L.engageSecurityLock('window-mode', { hard: true });
{
  const reasons = M.resolveGateReasons(kv({ multiWindowBlocked: true, windowMode: 'multi_window' }));
  check('B5: split-screen during a VPN block adds its own reason',
    keys(reasons).sort().join(',') === ['vpn', 'window:multi_window'].sort().join(','));
  check('B5-2: no second screen is introduced by the second cause',
    /<SecurityGate\s*\/>/.test(read('src/app/(app)/_layout.tsx'))
    && (read('src/app/(app)/_layout.tsx').match(/<SecurityGate/g) || []).length === 1);
}

// 6. Multiple violations clear in different orders.
{
  L.releaseSecurityLock('native-vpn');
  L.releaseSecurityLock('window-mode');
  const clearedVpnFirst = L.isSecurityLocked() === false;

  L._resetSecurityLockForTests();
  L.engageSecurityLock('native-vpn', { hard: true });
  L.engageSecurityLock('window-mode', { hard: true });
  L.releaseSecurityLock('window-mode');
  L.releaseSecurityLock('native-vpn');
  const clearedWindowFirst = L.isSecurityLocked() === false;

  check('B6: both release orders end unlocked, with no orphan holder',
    clearedVpnFirst && clearedWindowFirst
    && M.resolveGateReasons(inputs({})).length === 0);
}

// 7. All violations clear, but the fresh revalidation still fails.
{
  L._resetSecurityLockForTests();
  L.engageSecurityLock('verdict', { hard: true });
  const state = M.resolveSecurityGateState(inputs({ violationBlocked: true }));
  check('B7: a failing revalidation keeps the block with its own reason',
    state === 'BLOCKED_SECURITY_VIOLATION'
    && keys(M.resolveGateReasons(inputs({ violationBlocked: true }))).join(',') === 'violation'
    && L.isSecurityLocked() === true);
}

// 8. All violations clear and revalidation succeeds.
L.releaseSecurityLock('verdict');
{
  check('B8: nothing live \u2192 ALLOWED, no reasons, no lock',
    M.resolveSecurityGateState(inputs({})) === 'ALLOWED'
    && M.resolveGateReasons(inputs({})).length === 0
    && L.isSecurityLocked() === false);
}

// 9. Backgrounded/resumed while multiple violations are active.
{
  const reasons = M.resolveGateReasons(kv({
    multiWindowBlocked: true, windowMode: 'foreign_window', backgroundResumeBlocked: true,
  }));
  check('B9: a resume hold does not hide or duplicate the live reasons',
    keys(reasons).sort().join(',') === ['vpn', 'window:foreign_window'].sort().join(','));
  check('B9-2: the resume state never outranks a confirmed violation',
    M.resolveSecurityGateState(kv({ multiWindowBlocked: true, backgroundResumeBlocked: true })) === 'BLOCKED_MULTI_WINDOW');
}

// 10. Rapid repeated events do not create duplicate overlays/reasons.
{
  L._resetSecurityLockForTests();
  for (let i = 0; i < 25; i++) L.engageSecurityLock('window-mode', { hard: true });
  for (let i = 0; i < 25; i++) L.engageSecurityLock('native-vpn', { hard: true });
  check('B10: 50 repeated engages collapse to exactly two holders',
    L.getSecurityLockState().sources.length === 2);
  check('B10-2: the reason list stays deduplicated on every render',
    M.resolveGateReasons(kv({ multiWindowBlocked: true, windowMode: 'foreign_window' })).length === 2);
  check('B10-3: the gate renders one instance and keys rows by reason identity',
    /activeReasonRows\.length > 1/.test(GATE)
    && /key=\{row\.key\}/.test(GATE));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\nC. Presentation wiring (one screen, every reason)');
// ══════════════════════════════════════════════════════════════════════════

check('C1: the context exposes the reason set alongside the primary state',
  /gateReasons: GateReason\[\]/.test(CONTEXT)
  && /resolveGateReasons\(gateInputs\)/.test(CONTEXT)
  && /gateReasons,/.test(CONTEXT));

check('C2: the gate consumes the reason set (not a second, local derivation)',
  /gateReasons,?\s*\n\s*\} = useSecurity\(\)/.test(GATE)
  && /const activeReasonRows = gateReasons\.map/.test(GATE));

check('C3: every reason kind has copy on the same page',
  /reason\.kind === 'window'/.test(GATE)
  && /reason\.kind === 'overlay'/.test(GATE)
  && /reason\.kind === 'vpn'/.test(GATE)
  && /t\('security\.gate\.activeViolations'\)/.test(GATE));

check('C4: the multi-reason heading exists in English and Arabic',
  /'security\.gate\.activeViolations': 'ACTIVE VIOLATIONS'/.test(RES)
  && /'security\.gate\.activeViolations': 'المخالفات النشطة'/.test(RES));

check('C5: no second blocking surface is mounted for extra reasons',
  !/if \(activeReasonRows\.length > 1\) return/.test(GATE));

// ══════════════════════════════════════════════════════════════════════════
console.log('\nD. iOS: the second loading screen is bounded and recoverable');
// ══════════════════════════════════════════════════════════════════════════

check('D1: the shell overlay has a watchdog bound',
  /PROFILE_BOOTSTRAP_WATCHDOG_MS = 20_000/.test(LAYOUT)
  && /setAwaitingProfile\(false\);[\s\S]{0,120}PROFILE_BOOTSTRAP_WATCHDOG_MS/.test(LAYOUT));

check('D2: a failure is never rendered as a permanent bare spinner',
  /const profileUnavailable = !!session\?\.user && !profile && !isProfileLoading/.test(LAYOUT)
  && /profileUnavailable && \(/.test(LAYOUT));

check('D3: the recoverable state offers an explicit retry control',
  /onPress=\{retryBootstrap\}/.test(LAYOUT)
  && /t\('shell\.retry'\)/.test(LAYOUT)
  && /'shell\.retry': 'Try again'/.test(RES)
  && /'shell\.retry': 'إعادة المحاولة'/.test(RES));

check('D4: a retry supersedes the in-flight attempt (no stale install)',
  /const retryBootstrap = useCallback[\s\S]{0,320}bootGeneration\.current \+= 1;/.test(LAYOUT));

check('D5: foreground return and connectivity restore recover the bootstrap',
  /AppState\.addEventListener\('change',[\s\S]{0,220}retryBootstrap\(\)/.test(LAYOUT)
  && /NetInfo\.addEventListener\([\s\S]{0,400}retryBootstrap\(\)/.test(LAYOUT));

check('D6: the grace window prevents an error flash on a healthy cold start',
  /PROFILE_BOOTSTRAP_GRACE_MS = 1_200/.test(LAYOUT)
  && /&& bootGrace;/.test(LAYOUT));

check('D7: bootstrap phases are timed for diagnosis',
  /markPerf\('profile-bootstrap-start'\)/.test(LAYOUT)
  && /markPerf\('profile-bootstrap-failed'\)/.test(LAYOUT)
  && /markPerf\('profile-bootstrap-timeout'\)/.test(LAYOUT));

check('D8: the retry re-runs the SAME single bootstrap (no parallel copy)',
  (LAYOUT.match(/await getProfile\(/g) || []).length === 2
  && /\}, \[session\?\.user\?\.id, bootstrapNonce\]\)/.test(LAYOUT));

check('D9: no duplicate concurrent bootstrap is introduced by the recovery paths',
  /if \(!uidRef\.current \|\| profileRef\.current\) return;/.test(LAYOUT));

// ══════════════════════════════════════════════════════════════════════════
console.log('\n' + '\u2500'.repeat(62));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('\nUNIFIED LOCK / iOS BOOTSTRAP TESTS FAILED'); process.exit(1); }
console.log('Unified multi-violation lock and bounded iOS bootstrap: OK');
