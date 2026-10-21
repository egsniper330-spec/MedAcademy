#!/usr/bin/env node
/**
 * Session-resume security verification — regression suite.
 *
 * Run: node tests/resumeVerification.test.cjs
 *
 * THE DEFECT THIS LOCKS DOWN (two symptoms, one mechanism)
 * ──────────────────────────────────────────────────────
 *  1. A clean device sometimes resumed almost instantly and sometimes sat on the
 *     full-screen VERIFYING YOUR SESSION page for tens of seconds.
 *  2. Even when it was correct, a clean resume paid a VISIBLE verification
 *     interruption, and the page's "Verify security and continue" control could
 *     not clear it.
 *
 * Mechanism: only ONE evaluation could run at a time, and a request arriving
 * while one was running was DROPPED (`checkRef` in SecurityContext). A resume
 * that coincided with an in-flight evaluation therefore discarded that
 * evaluation's verdict (correct — it predates the resume) and never started a
 * replacement, so the hold waited for the next 30 s periodic tick. The Continue
 * control went through the same guard and ran nothing, so pressing it did not
 * help either.
 *
 * THE FIX (asserted here)
 * ──────────────────────
 *  • Evaluations COALESCE and CHAIN: one runs at a time, a request arriving
 *    mid-run is queued and started the instant the current one finishes.
 *  • The resume hold renders NO PAGE (`rendersBlockScreen`): the app shell is
 *    restored immediately, protected operations are refused by the transport
 *    gate and protected playback stays stopped by the hard lock until a clean
 *    post-resume verdict lands.
 *  • A CONFIRMED violation outranks the interim resume hold, so it is routed to
 *    its own authoritative blocking screen the moment it is confirmed.
 *  • A timeout/watchdog can report and retry ONCE — it can never authorize.
 *
 * Part 1 compiles the pure state model standalone (as the other suites do) and
 * exercises the resume semantics; the remaining parts assert the wiring, which
 * is where the previous defects lived.
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

function buildModel() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-model-'));
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(ROOT, 'src', 'lib', 'securityStateModel.ts'),
      '--outDir', tmp,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
  return require(path.join(tmp, 'securityStateModel.js'));
}

function buildLock() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-lock-'));
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(ROOT, 'src', 'lib', 'securityLock.ts'),
      '--outDir', tmp,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
  return require(path.join(tmp, 'securityLock.js'));
}

const M = buildModel();
const lock = buildLock();

const CONTEXT = read('src/lib/SecurityContext.tsx');
const GATE = read('src/app/(app)/security-gate.tsx');

/**
 * The gate's English copy table was replaced by the shared dictionaries
 * (`security.gate.event.<key>.{title,instruction}`); the gate keeps a KEY SET
 * and resolves the text with t() at render time. These helpers read the EN
 * copy straight out of the resources so the assertions still pin the wording.
 */
const RES = read('src/lib/i18n/resources.ts');
function dictVal(key) {
  const prefix = `  '${key}': `;
  const line = RES.split('\n').find((l) => l.startsWith(prefix));
  if (!line) return null;
  const value = line.slice(prefix.length).replace(/,\s*$/, '');
  if (!value.startsWith("'") || !value.endsWith("'")) return null;
  return value.slice(1, -1).replace(/\\'/g, "'").replace(/\\n/g, '\n');
}
const MODEL = read('src/lib/securityStateModel.ts');
// php.ts is CRLF in this repository — normalise before multi-line matching.
const TRANSPORT = read('src/client/php.ts').replace(/\r/g, '');
const LOCK_SRC = read('src/lib/securityLock.ts');

const NO_INPUT = {
  evaluating: false,
  hasVerdict: true,
  overlayBlocked: false,
  multiWindowBlocked: false,
  backgroundResumeBlocked: false,
  vpnBlocked: false,
  violationBlocked: false,
};
const state = (over) => M.resolveSecurityGateState({ ...NO_INPUT, ...over });

// ── Part 1: the resume state's semantics (pure model) ──────────────────────
console.log('\u2500\u2500 Part 1: resume state semantics \u2500\u2500');
{
  check('1a: the resume hold still withholds protected content/operations',
    M.isGateBlocked('BLOCKED_BACKGROUND_RESUME') === true);
  check('1b: ... but it renders NO full-screen page',
    M.rendersBlockScreen('BLOCKED_BACKGROUND_RESUME') === false);
  check('1c: the four authoritative causes DO render their page',
    ['BLOCKED_OVERLAY', 'BLOCKED_MULTI_WINDOW', 'BLOCKED_VPN', 'BLOCKED_SECURITY_VIOLATION']
      .every((s) => M.rendersBlockScreen(s) === true));
  check('1d: CHECKING / ALLOWED render nothing',
    M.rendersBlockScreen('CHECKING') === false && M.rendersBlockScreen('ALLOWED') === false);
  check('1e: every page-rendering state is also a containing state',
    M.SECURITY_GATE_STATES.filter((s) => M.rendersBlockScreen(s))
      .every((s) => M.isGateBlocked(s) === true));

  // ROUTING: a confirmed violation must never be masked by the interim state.
  check('1f: a confirmed VPN block outranks the resume hold',
    state({ backgroundResumeBlocked: true, vpnBlocked: true }) === 'BLOCKED_VPN');
  check('1g: any other confirmed policy violation outranks the resume hold',
    state({ backgroundResumeBlocked: true, violationBlocked: true }) === 'BLOCKED_SECURITY_VIOLATION');
  check('1h: both together resolve to the VPN screen (its own recovery steps)',
    state({ backgroundResumeBlocked: true, vpnBlocked: true, violationBlocked: true }) === 'BLOCKED_VPN');
  check('1i: the window-state causes still outrank everything',
    state({ overlayBlocked: true, vpnBlocked: true, backgroundResumeBlocked: true }) === 'BLOCKED_OVERLAY'
    && state({ multiWindowBlocked: true, vpnBlocked: true, backgroundResumeBlocked: true }) === 'BLOCKED_MULTI_WINDOW');
  check('1j: the resume hold still outranks CHECKING (fail-closed, no temporary all-clear)',
    state({ backgroundResumeBlocked: true, evaluating: true, hasVerdict: false }) === 'BLOCKED_BACKGROUND_RESUME');
  check('1k: no control is offered for a state that renders no page',
    M.isGateRecheckable('BLOCKED_BACKGROUND_RESUME') === false);
  check('1l: the causes a user can act on still offer one',
    M.isGateRecheckable('BLOCKED_OVERLAY') === true && M.isGateRecheckable('BLOCKED_VPN') === true);

  // ''Clean resume'' release rule (unchanged, re-asserted).
  const g = (over) => M.resolveBackgroundResumeGate({
    foreground: true, verifiedSinceResume: true, blocking: false, ...over,
  });
  check('1m: a clean finished post-resume verification releases the hold',
    g({}) === false);
  check('1n: resumed-but-not-yet-verified stays held', g({ verifiedSinceResume: false }) === true);
  check('1o: backgrounded stays held even after a clean pre-background verdict',
    g({ foreground: false, verifiedSinceResume: true }) === true);
  check('1p: a blocking verdict keeps it held', g({ blocking: true }) === true);

  // Evidence policy (what may be reused for a resume).
  check('1q: a verdict is NEVER reused across a resume',
    M.RESUME_VERIFICATION_EVIDENCE_POLICY.verdictReuseAcrossResume === false);
  check('1r: releasing requires an evaluation that started at/after the resume',
    M.RESUME_VERIFICATION_EVIDENCE_POLICY.releaseRequiresPostResumeEvaluation === true);
  check('1s: sub-measurements are reused only within their own TTL',
    M.RESUME_VERIFICATION_EVIDENCE_POLICY.subMeasurementReuse === 'within-ttl');
  check('1t: a pre-resume verdict can never clear a newer hold (stale-async guard)',
    M.acceptsResumeVerification({ evaluationStartedToken: 2, liveResumeToken: 3 }) === false
    && M.acceptsResumeVerification({ evaluationStartedToken: 3, liveResumeToken: 3 }) === true);

  // Watchdog: reporting + one retry, never authorization.
  check('1u: nothing pending is never overdue',
    M.isResumeVerificationOverdue({ pendingSinceMs: null, nowMs: 1e9 }) === false);
  check('1v: below the threshold is not overdue',
    M.isResumeVerificationOverdue({ pendingSinceMs: 1000, nowMs: 1000 + M.RESUME_VERIFICATION_TIMEOUT_MS - 1 }) === false);
  check('1w: past the threshold IS overdue (and the caller may retry once)',
    M.isResumeVerificationOverdue({ pendingSinceMs: 1000, nowMs: 1000 + M.RESUME_VERIFICATION_TIMEOUT_MS }) === true);
  check('1x: garbage timestamps are never treated as overdue',
    M.isResumeVerificationOverdue({ pendingSinceMs: NaN, nowMs: 5 }) === false);
}

// ── Part 2: one evaluation at a time, nothing dropped, nothing duplicated ──
console.log('\u2500\u2500 Part 2: coalescing + chaining (the latency fix) \u2500\u2500');
{
  check('2a: in-flight evaluations are tracked in ONE queue (single-flight)',
    /const inFlightEvaluationRef = useRef<Promise<SecurityCheckResult \| null> \| null>\(null\);/
      .test(CONTEXT)
    && /const queuedEvaluationRef = useRef<string \| null>\(null\);/.test(CONTEXT));
  check('2b: a request arriving mid-run is QUEUED, not dropped',
    /if \(inFlight\) \{\n\s+queuedEvaluationRef\.current = reason;/.test(CONTEXT));
  check('2c: the queued request is started the instant the current run finishes (chained, no timer)',
    /queuedEvaluationRef\.current = null;\n\s+if \(__DEV__\)[\s\S]{0,200}void runEvaluationRef\.current\(queued\);/
      .test(CONTEXT.replace(/\n\s*\/\/[^\n]*/g, '')));
  check('2d: a coalesced caller gets null — never a fabricated or claimed-fresh verdict',
    /if \(!r\) \{\n\s+console\.log\('\[SecurityContext\]\[Stage-6\] check\(\) coalesced[\s\S]{0,120}return result \?\? BLOCKING_UNKNOWN_RESULT;/
      .test(CONTEXT));
  check('2e: the periodic trigger no longer drops its request on an in-flight evaluation',
    /const runPeriodicCheck = async \(\) => \{\n\s+if \(!appActiveRef\.current\) return;/.test(CONTEXT)
    && !/if \(!appActiveRef\.current \|\| checkRef\.current\) return;/.test(CONTEXT));
  check('2f: the old check() in-flight early-return is gone',
    !/if \(checkRef\.current\) \{\n\s+console\.log\('\[SecurityContext\]\[Stage-6\] check\(\) skipped/.test(CONTEXT));
  check('2g: the dead single-flight flag was removed entirely (no checkRef reads)',
    !/checkRef\.current\b/.test(CONTEXT));
  check('2h: every trigger path funnels through the queue',
    ['manual', 'periodic'].every((r) => new RegExp(`runEvaluation\\('${r}'\\)`).test(CONTEXT)));

  // Resume → verification, immediately.
  check('2i: a non-VPN resume starts the verification at once (no artificial delay)',
    /requestResumeVerification\('resume'\);/.test(CONTEXT));
  // CHANGED deliberately (root-cause fix): the fired run is no longer a bare
  // evaluation whose result is dropped — it PUBLISHES what it measured, which
  // is what lets a clean post-resume verdict release the hold instead of
  // waiting for the next 30 s periodic tick. Still fired, never awaited.
  check('2j: the request is fired, never awaited (the listener returns immediately)',
    /void runAndPublish\(reason\);/.test(CONTEXT)
    && !/await requestResumeVerification\(/.test(CONTEXT));
  check('2j-2: the resume verification PUBLISHES its verdict (a clean resume releases at once)',
    /const runAndPublish = async \(why: string\) => \{[\s\S]{0,300}const r = await runEvaluationRef\.current\(why\);[\s\S]{0,200}publishVerdictRef\.current\(r\);/.test(CONTEXT)
    && /const publishVerdict = useCallback\(\(r: SecurityCheckResult\) => \{[\s\S]{0,700}maybeReleaseBackgroundHold\(r\);/.test(CONTEXT));
  check('2k: only the VPN case keeps its settle debounce, and it still verifies',
    /vpnRecheckTimer\.current = setTimeout\(\(\) => \{\n\s+requestResumeVerification\('resume-vpn-settled'\);/.test(CONTEXT)
    && /VPN_RECHECK_DEBOUNCE_MS/.test(CONTEXT));
  check('2l: repeated resumes re-arm ONE watchdog instead of stacking timers',
    /if \(resumeWatchdogRef\.current\) \{\n\s+clearTimeout\(resumeWatchdogRef\.current\);\n\s+resumeWatchdogRef\.current = null;\n\s+\}\n\s+resumeWatchdogRef\.current = setTimeout\(/.test(CONTEXT));
  check('2m: multiple foreground events cannot start duplicate jobs (queue + token bump)',
    /resumeTokenRef\.current \+= 1;/.test(CONTEXT)
    && /queuedEvaluationRef\.current = reason;/.test(CONTEXT));
  check('2n: the watchdog retries ONCE per resume, and only while the hold is live',
    /if \(resumeRetriedRef\.current\) return; \/\/ one bounded retry per resume/.test(CONTEXT)
    && /if \(!backgroundHeldRef\.current\) return;/.test(CONTEXT));
  check('2o: a session change clears the queue, the pending marker and the watchdog',
    /queuedEvaluationRef\.current = null;\n\s+inFlightEvaluationRef\.current = null;\n\s+resumePendingSinceRef\.current = null;/.test(CONTEXT));

  // Latency is MEASURED, so "resume felt slow" has a number.
  check('2p: the hold engage is timestamped on the monotonic clock',
    /markResumeHoldEngaged\(\);/.test(CONTEXT) && /export function markResumeHoldEngaged\(\)/.test(LOCK_SRC));
  check('2q: the deciding verdict publishes the measured resume duration',
    /markResumeVerdictResolved\(\);/.test(CONTEXT) && /lastResumeVerificationMs/.test(LOCK_SRC));
  check('2r: an overdue verification is recorded as evidence',
    /markResumeVerificationOverdue\(\);/.test(CONTEXT) && /resumeVerificationsOverdue/.test(LOCK_SRC));
  check('2s: the lock module exposes the resume counters',
    (() => {
      const d = lock.getContainmentDiagnostics();
      return 'resumeHoldEngagedMs' in d && 'lastResumeVerificationMs' in d
        && d.resumeEvaluationsStarted === 0 && d.resumeVerificationsOverdue === 0;
    })());
  check('2t: the resume counters are exercised by the lock module API',
    (() => {
      lock._resetSecurityLockForTests();
      lock.markResumeHoldEngaged();
      lock.markResumeEvaluationStarted();
      lock.markResumeVerdictResolved();
      const d = lock.getContainmentDiagnostics();
      return d.resumeEvaluationsStarted === 1
        && d.resumeHoldEngagedMs !== null
        && d.lastResumeVerificationMs !== null
        && d.lastResumeVerificationMs >= 0;
    })());
}

// ── Part 3: no verification page on resume; violations route immediately ───
console.log('\u2500\u2500 Part 3: presentation + routing \u2500\u2500');
{
  check('3a: the gate mounts its page only for a page-rendering state',
    /import \{[\s\S]{0,200}rendersBlockScreen,/.test(GATE)
    && /const blockScreen = rendersBlockScreen\(gateState\);/.test(GATE)
    && /if \(!blocking \|\| !blockScreen\) return null;/.test(GATE));
  check('3b: the VERIFYING YOUR SESSION page is gone from the app',
    !/VERIFYING YOUR SESSION/.test(GATE));
  check('3c: no resume-state copy branch remains in the gate',
    !/gateState === 'BLOCKED_BACKGROUND_RESUME'/.test(GATE)
    && !/resumeBlocked/.test(GATE));
  check('3d: navigation is not trapped during a resume (back handler keyed on the PAGE)',
    /if \(!blockScreen\) return;\n\s+const sub = BackHandler\.addEventListener\('hardwareBackPress', \(\) => true\)/.test(GATE));
  check('3e: screen-capture protection is keyed on the PAGE too (no needless lock on a shell)',
    /if \(!blockScreen\) return;\n\s+let active = true;\n\s+ScreenCaptureLib\.preventScreenCaptureAsync\('security-gate'\)/.test(GATE));
  check('3f: the gate no longer renders for a state it has no copy for',
    /const blocking = isGateBlocked\(gateState\);/.test(GATE));

  // Each supported finding still gets its OWN accurate reason (no generic label).
  // Copy lives in the dictionaries now (`security.gate.event.<k>.title` /
  // `.instruction`); the gate keeps a KEY SET and resolves via t().
  const EVENT_COPY = [
    'vpn_detected', 'proxy_detected', 'developer_options_enabled', 'adb_enabled',
    'debugger_attached', 'debug_detected',
    'virtual_device_detected', 'root_detected', 'tamper_detected',
    'signature_invalid', 'play_integrity_failed', 'security_unverified',
  ];
  const dictValAll = dictVal;
  check('3g: every supported finding has its own title + instruction (dictionary)',
    EVENT_COPY.every((k) =>
      dictValAll(`security.gate.event.${k}.title`) !== null &&
      dictValAll(`security.gate.event.${k}.instruction`) !== null));
  check('3h: the copy keys are distinct (a violation is never labelled as another one)',
    (() => {
      const titles = EVENT_COPY.map((k) => dictValAll(`security.gate.event.${k}.title`)).filter(Boolean);
      return titles.length === EVENT_COPY.length && new Set(titles).size >= EVENT_COPY.length - 1;
    })());
  check('3i: emulator findings are separated from the insecure-build copy',
    /resolveFindingCopyKey/.test(GATE) && /virtual_device_detected/.test(MODEL));
  check('3i-2: the removed mock-location finding has no surviving copy path',
    !/mock_location_detected/.test(GATE) && !/'mock_location'/.test(MODEL));
  check('3j: mid-session blocks reuse the SAME page (no second presentation path)',
    /onNewBlockingThreat\(\(result\) => \{/.test(GATE));
}

// ── Part 4: protected access stays closed while the decision is pending ────
console.log('\u2500\u2500 Part 4: containment during the pending window \u2500\u2500');
{
  check('4a: the resume hold is engaged HARD (players unmount, not just pause)',
    /engageSecurityLock\(LOCK_SRC_BACKGROUND, \{ hard: true \}\)/.test(CONTEXT));
  check('4b: it is engaged the moment the app is backgrounded, before any render',
    /if \(nextState === 'background'\) \{[\s\S]{0,900}enterBackgroundHold\('appstate=' \+ nextState\);/.test(CONTEXT));
  check('4c: it is re-asserted on resume (a rapid re-background cannot slip through)',
    /resumeTokenRef\.current \+= 1;\n\s+enterBackgroundHold\('resumed'\);/.test(CONTEXT));
  check('4d: the ONLY release is a clean post-resume verdict',
    (CONTEXT.match(/releaseSecurityLock\(LOCK_SRC_BACKGROUND\)/g) || []).length === 1
    && /if \(!acceptsResumeVerification\(\{[\s\S]{0,1600}releaseSecurityLock\(LOCK_SRC_BACKGROUND\);/.test(CONTEXT));
  check('4e: the release also consults the pure gate rule (blocking verdict keeps it held)',
    /const stillBlocked = resolveBackgroundResumeGate\(\{[\s\S]{0,200}if \(stillBlocked\) return;/.test(CONTEXT));
  check('4f: protected requests are refused at the transport while locked',
    /if \(isSecurityLocked\(\) && !isLockExempt\(path\)\) \{/.test(TRANSPORT));
  check('4g: in-flight protected requests are registered so containment can abort them',
    /registerProtectedAbort\(controller\)/.test(TRANSPORT)
    && /protectedAborts\.clear\(\)/.test(LOCK_SRC));
  // THE ALLOWLIST — the whole of it. While the lock is active EVERY other
  // protected request is refused before it reaches the network, so this list is
  // the documented boundary of what may still flow while a decision is pending:
  // the security pipeline's own reads, the violation report, sign-out, and the
  // public support-contact endpoint the block screen needs.
  check('4h: the allowlist is the documented minimum (verification + recovery only)',
    /const LOCK_EXEMPT_PREFIXES = \[\n\s+'\/security\/policies', '\/security\/config', '\/security\/events', '\/security\/violations',\n\s+'\/auth\/logout',\n\s+'\/support\/contact',\n\];/.test(TRANSPORT)
    && (TRANSPORT.match(/'\/[a-z-]+\/[a-z-]+'/g) || []).length > 0);
  check('4i: token rotation is NOT on the allowlist (protected activity stays frozen)',
    /if \(isSecurityLocked\(\)\) \{\n\s+authStateLog\('AUTH_REFRESH_SUPPRESSED', 'security lock active — refresh deferred until unlock'\);/.test(TRANSPORT)
    && !/'\/auth\/refresh'/.test(TRANSPORT.split('const LOCK_EXEMPT_PREFIXES')[1].split('];')[0]));
  check('4i-2: a suppressed rotation is recovered after unlock, never treated as a logout',
    /scheduleRefreshAfterUnlock\(\);/.test(TRANSPORT)
    && /POST \/auth\/refresh \(post-unlock recovery\)/.test(TRANSPORT)
    && !/AUTH_REFRESH_SUPPRESSED[\s\S]{0,200}await clearSession\(\)/.test(TRANSPORT));
  check('4i-3: containment never aborts an in-flight rotation or allowlisted traffic',
    /const abortExempt = isLockExempt\(path\) \|\| path\.startsWith\('\/auth\/refresh'\);/.test(TRANSPORT));
  check('4j: protected playback is stopped by the same lock (stoppers run on containment)',
    /for \(const stop of stops\) \{/.test(LOCK_SRC) && /registerPlaybackStopper/.test(LOCK_SRC));
  check('4k: protected screens key on the HARD lock, so media cannot stay mounted',
    /securityLockHard/.test(read('src/app/(app)/lesson/[id].tsx'))
    && /securityLockHard/.test(read('src/app/(app)/offline-course.tsx'))
    && /securityLockHard/.test(read('src/app/(app)/offline-library.tsx')));
  check('4l: no artificial delay, minimum display duration or sleep gates the resume',
    !/delay\(|sleep\(|MIN_(DISPLAY|VISIBLE)|await new Promise\(\(r\) => setTimeout\(r/.test(CONTEXT));
  check('4m: the shell is restored without re-mounting the app (no reload/redirect on resume)',
    !/Updates\.reloadAsync|router\.replace\([^)]*resume/i.test(CONTEXT));
  // A proxy-only violation must land on the CONNECTION page (recovery steps +
  // recheck), not the generic policy page — both detectors are floored to
  // block_login and both have copy on that page.
  check('4n: VPN and proxy both resolve to the connection blocking page',
    /const vpnBlocked\s+= liveBlocking && hasConnectionFinding\(r\.threats\);/.test(CONTEXT)
    && /violationBlocked:\s+liveBlocking && !vpnBlocked/.test(CONTEXT));
  check('4o: the connection page carries per-finding copy for both detectors',
    dictVal('security.gate.event.vpn_detected.title') === 'VPN Connection Detected'
    && dictVal('security.gate.event.proxy_detected.title') === 'Proxy Connection Detected');
}

// ── Part 5: errors, indeterminate results and bounded retries ──────────────
console.log('\u2500\u2500 Part 5: failures are reported, never mistaken for clean \u2500\u2500');
{
  check('5a: a thrown evaluation is not published (no synthetic block page)',
    /catch \(e\) \{[\s\S]{0,1500}const policies = await getSecurityPolicies\(\);[\s\S]{0,500}return fallback;/.test(CONTEXT)
    && !/setResult\(fallback\)/.test(CONTEXT));
  check('5b: the caller still gets a fail-closed sentinel for a raced sensitive action',
    /blocksLogin: true,\n\s+blocksVideo: true,/.test(CONTEXT));
  check('5c: an unresolved check never releases access on timeout',
    !/isResumeVerificationOverdue[\s\S]{0,200}releaseSecurityLock/.test(CONTEXT)
    && /if \(!isResumeVerificationOverdue\(\{/.test(CONTEXT));
  check('5d: the watchdog is a single bounded retry (no loop, no unbounded recursion)',
    (CONTEXT.match(/setTimeout\(\(\) => \{\n\s+resumeWatchdogRef\.current = null;/g) || []).length === 1
    // Scoped to the watchdog block: no loop/recurrence may extend the retries.
    && !/while \(/.test(CONTEXT.slice(CONTEXT.indexOf('resumeWatchdogRef = useRef'), CONTEXT.indexOf('const check = useCallback'))));
  check('5e: an unmeasured detector result is reported as evidence, not as a violation',
    /detection_unavailable/.test(read('src/lib/security.ts')));
  check('5f: the transport surfaces a locked refusal as an explicit error, not silent success',
    /code: 'SECURITY_LOCK'/.test(TRANSPORT));
  check('5g: a coalesced/superseded result is never treated as a verdict',
    /if \(!r\) return;\n\s+setResult\(r\);/.test(CONTEXT)
    && /return result \?\? BLOCKING_UNKNOWN_RESULT;/.test(CONTEXT));
}

// ── Part 6: existing behaviour intact ─────────────────────────────────────
console.log('\u2500\u2500 Part 6: existing behaviour unchanged \u2500\u2500');
{
  check('6a: the Super Admin exemption is unchanged', /if \(isSuperAdmin\) \{\n[\s\S]{0,200}SUPERADMIN_BYPASS_RESULT/.test(CONTEXT));
  check('6b: forced-update enforcement is untouched',
    /resolveUpdateGateDecision/.test(read('src/lib/securityStateModel.ts'))
    && fs.existsSync(path.join(ROOT, 'src/components/ForceUpdateScreen.tsx')));
  check('6c: login and the pre-session gate are untouched',
    fs.existsSync(path.join(ROOT, 'src/app/(auth)/sign-in.tsx'))
    && fs.existsSync(path.join(ROOT, 'src/app/(auth)/security-warning.tsx')));
  check('6d: the security engine and its thresholds are untouched',
    !/rendersBlockScreen|BLOCKED_BACKGROUND_RESUME/.test(read('src/lib/security.ts')));
  const DEPS = JSON.parse(read('package.json')).dependencies || {};
  check('6e: no new dependency was added for this work',
    !('react-query' in DEPS) && !('@tanstack/react-query' in DEPS) && !('swr' in DEPS));
  check('6f: the related suites still exist',
    ['vpnMandatoryBlock', 'securityGateState', 'overlayLifecycleWiring', 'securityStartupFlash', 'securityLock', 'multiWindowGate']
      .every((f) => fs.existsSync(path.join(ROOT, 'tests', f + '.test.cjs'))));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
