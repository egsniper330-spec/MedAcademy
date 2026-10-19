#!/usr/bin/env node
/**
 * NETWORK LOCK — temporary app-traffic suspension while a mandatory security
 * verification is pending.
 *
 * Run: node tests/networkLock.test.cjs
 *
 * WHAT THIS LOCKS DOWN
 * ────────────────────
 * Before this work the only thing withholding the app during a pending
 * verification was the UI/transport refusal of *some* requests:
 *   • no lock was engaged at SESSION START at all, and the "immediate check at
 *     session start" never actually ran (it called the periodic-check ref before
 *     it was assigned), so the first authoritative evaluation waited for the
 *     30 s interval tick;
 *   • the RESUME verification ran an evaluation and DROPPED its result (only
 *     `check()` / `runPeriodicCheck` published), so a clean post-resume verdict
 *     could not release the hold — the app stayed locked until the next periodic
 *     tick, up to 30 s later;
 *   • a request arriving while locked was REFUSED, so screens that mounted in
 *     that window rendered empty/error states that never recovered;
 *   • VdoCipher chunk uploads (their own connection) ignored the lock entirely.
 *
 * THE MODEL (asserted here)
 * ─────────────────────────
 *   lock held  → app's OWN traffic is suspended: new API requests are QUEUED
 *                (deduplicated, bounded) and replayed ONCE after a real unlock;
 *                in-flight registered requests are aborted; playback is stopped
 *                and the player is unmounted; direct uploads hold between chunks.
 *   lock clear → queued work flows, without a restart, a tap, or duplicate
 *                non-idempotent operations.
 *   still held → queued work EXPIRES (refused). A bound is never authorization.
 *
 * SCOPE HONESTY: a WebView/iframe/native-SDK connection is NOT suspended by this
 * mechanism and the suite asserts that the code and the documentation say so.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`); }
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const LOCK_SRC     = 'src/lib/securityLock.ts';
const MODEL_SRC    = 'src/lib/securityStateModel.ts';
const TRANSPORT    = 'src/client/php.ts';
const CONTEXT      = 'src/lib/SecurityContext.tsx';
const LESSON       = 'src/app/(app)/lesson/[id].tsx';
const YT_PLAYER    = 'src/components/YouTubePlayer.tsx';
const UPLOAD       = 'src/lib/vdoCipherUpload.ts';

const TRANSPORT_CODE = read(TRANSPORT);
const CONTEXT_CODE   = read(CONTEXT);

/** Compile the dependency-free modules standalone (house convention). */
function buildModules() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netlock-'));
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(ROOT, LOCK_SRC),
      path.join(ROOT, MODEL_SRC),
      '--outDir', tmp,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
  return {
    lock:  require(path.join(tmp, 'securityLock.js')),
    model: require(path.join(tmp, 'securityStateModel.js')),
  };
}

const { lock: L, model: M } = buildModules();

async function main() {

// ════════════════════════════════════════════════════════════════════════════
// 1. The vocabulary and its documented scope (pure)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n1. NETWORK_LOCKED — vocabulary and scope');
{
  check('1a: exactly two network-access states are enumerated',
    JSON.stringify(M.NETWORK_ACCESS_STATES) === JSON.stringify(['NETWORK_LOCKED', 'NETWORK_OPEN']));

  check('1b: a held lock resolves NETWORK_LOCKED, a clear one NETWORK_OPEN',
    M.resolveNetworkAccessState({ locked: true }) === 'NETWORK_LOCKED'
    && M.resolveNetworkAccessState({ locked: false }) === 'NETWORK_OPEN');

  check('1c: the transport predicate and the lock predicate are the same state',
    L.isNetworkLocked() === false && L.isNetworkLocked() === L.isSecurityLocked());

  // SCOPE — the suite pins the claim so nobody can quietly overstate it.
  const scope = M.NETWORK_LOCK_SCOPE;
  check('1d: the scope names the central API client as covered',
    scope.covered.some((s) => /apiFetch/.test(s)));
  check('1e: the scope names the YouTube/WebView connection as NOT covered',
    scope.notCovered.some((s) => /YouTube/i.test(s)));
  check('1f: the scope states the mitigation for what cannot be blocked',
    /stop-load|teardown/i.test(scope.mitigation));
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Behaviour: waiting, queueing, dedupe, bound, re-engage
// ════════════════════════════════════════════════════════════════════════════
console.log('\n2. lock behaviour — wait, queue, dedupe, expire');
const tick = () => new Promise((r) => setTimeout(r, 0));
{
  L._resetSecurityLockForTests();

  // 2a. waitForNetworkUnlock resolves true the moment the lock clears.
  L.engageSecurityLock('test', { hard: true });
  const waitA = L.waitForNetworkUnlock(50);
  L.releaseSecurityLock('test');
  check('2a: a wait resolves true when the lock clears', (await waitA) === true);

  // 2b. …and false when the bound expires — never "authorized".
  L._resetSecurityLockForTests();
  L.engageSecurityLock('test', { hard: true });
  check('2b: a wait resolves false when the bound expires', (await L.waitForNetworkUnlock(10)) === false);

  // 2c. An immediate run executes (no lock held).
  L._resetSecurityLockForTests();
  let ran = 0;
  const immediate = await L.runWhenNetworkUnlocked('k', async () => { ran++; return 'v'; }, 50);
  check('2c: with no lock the work runs immediately',
    immediate.ran === true && immediate.value === 'v' && ran === 1);

  // 2d. While locked the work does NOT run until the lock clears.
  L._resetSecurityLockForTests();
  L.engageSecurityLock('test', { hard: true });
  ran = 0;
  const queued = L.runWhenNetworkUnlocked('q1', async () => { ran++; return 'ok'; }, 200);
  await tick();
  const ranWhileLocked = ran;
  L.releaseSecurityLock('test');
  const queuedOutcome = await queued;
  check('2d: nothing runs while the lock is held', ranWhileLocked === 0);
  check('2e: the queued work runs ONCE after the lock clears',
    queuedOutcome.ran === true && queuedOutcome.value === 'ok' && ran === 1);

  // 2f. IDENTICAL keys join one entry — a non-idempotent op cannot be duplicated.
  L._resetSecurityLockForTests();
  L.engageSecurityLock('test', { hard: true });
  let executions = 0;
  const first  = L.runWhenNetworkUnlocked('same', async () => { executions++; return 1; }, 200);
  const second = L.runWhenNetworkUnlocked('same', async () => { executions++; return 2; }, 200);
  await tick();
  check('2f: a duplicate request joins the queued entry (not queued again)',
    L._pendingRunsForTests() === 1);
  L.releaseSecurityLock('test');
  const [r1, r2] = await Promise.all([first, second]);
  check('2g: the shared entry executes exactly once for both callers',
    executions === 1 && r1.value === 1 && r2.value === 1);

  // 2h. Distinct keys run independently.
  L._resetSecurityLockForTests();
  L.engageSecurityLock('test', { hard: true });
  const c = L.runWhenNetworkUnlocked('c', async () => 'c', 200);
  const d = L.runWhenNetworkUnlocked('d', async () => 'd', 200);
  await tick();
  check('2h: distinct requests are tracked separately', L._pendingRunsForTests() === 2);
  L.releaseSecurityLock('test');
  check('2i: both run after the unlock', (await c).value === 'c' && (await d).value === 'd');

  // 2j. A CONFIRMED VIOLATION keeps queued work unexecuted (bound expiry).
  L._resetSecurityLockForTests();
  L.engageSecurityLock('verdict', { hard: true });   // never released — the block stands
  ran = 0;
  const blocked = await L.runWhenNetworkUnlocked('v', async () => { ran++; return 1; }, 20);
  check('2j: a confirmed violation leaves queued work UNEXECUTED and refused',
    blocked.ran === false && ran === 0);

  // 2k. While the lock is HELD the wait must not resolve (no premature unlock).
  L._resetSecurityLockForTests();
  L.engageSecurityLock('a', { hard: true });
  const reWait = L.waitForNetworkUnlock(200);
  let settled = 'pending';
  void reWait.then((v) => { settled = v ? 'true' : 'false'; });
  await tick();
  await tick();
  check('2k: a held lock keeps the wait pending (no premature unlock)', settled === 'pending');
  // A rapid second event before the tick: the release below is the one that
  // clears the lock, and the pending wait resolves on it.
  L.engageSecurityLock('b', { hard: true });
  L.releaseSecurityLock('a');
  await tick();
  check('2k-2: releasing one of two holders leaves the wait pending', settled === 'pending');
  L.releaseSecurityLock('b');
  check('2l: the final release resolves the pending wait', (await reWait) === true);

  // 2m. A queued entry that sees the lock re-engage refuses rather than sends.
  L._resetSecurityLockForTests();
  L.engageSecurityLock('a', { hard: true });
  ran = 0;
  const raced = L.runWhenNetworkUnlocked('race', async () => { ran++; return 1; }, 30);
  await tick();
  L.releaseSecurityLock('a');
  L.engageSecurityLock('b', { hard: true });          // re-locked before the replay
  const racedOutcome = await raced;
  check('2m: a replay that would land behind a re-engaged lock is refused',
    racedOutcome.ran === false && ran === 0);

  // 2n. Diagnostics: queue/defer counts and the lock/unlock transitions.
  L._resetSecurityLockForTests();
  L.engageSecurityLock('diag', { hard: true });
  const whileLocked = L.getContainmentDiagnostics();
  check('2n: engaging records the lock engagement time and clear unlock time is null',
    whileLocked.networkLockMs !== null && whileLocked.networkUnlockMs === null);
  const deferredBefore = whileLocked.deferredProtectedRequests;
  const diagRun = L.runWhenNetworkUnlocked('diag', async () => 1, 200);
  await tick();
  check('2o: queueing is counted', L.getContainmentDiagnostics().deferredProtectedRequests === deferredBefore + 1);
  L.releaseSecurityLock('diag');
  await diagRun;
  const afterUnlock = L.getContainmentDiagnostics();
  check('2p: unlocking records the unlock time (traffic restored)',
    afterUnlock.networkUnlockMs !== null && afterUnlock.networkLockMs <= afterUnlock.networkUnlockMs);
  check('2q: queueing leaves no entries behind', L._pendingRunsForTests() === 0);

  L._resetSecurityLockForTests();
}

// ════════════════════════════════════════════════════════════════════════════
// 3. The transport: queue, never send behind the lock, minimal allowlist
// ════════════════════════════════════════════════════════════════════════════
console.log('\n3. transport — the central choke point');
{
  check('3a: every non-exempt request consults the lock before any I/O',
    /if \(isSecurityLocked\(\) && !isLockExempt\(path\)\) \{[\s\S]{0,400}deferUntilNetworkUnlocked<T>\(path, opts\);/.test(TRANSPORT_CODE));
  check('3b: the deferral replays through the normal path (fresh headers/token/timeout)',
    /runWhenNetworkUnlocked\([\s\S]{0,300}\(\) => apiFetchOnce<unknown>\(path, opts\)/.test(TRANSPORT_CODE));
  check('3c: the queue key includes method, path AND body (dedupe cannot merge different writes)',
    /`\$\{opts\.method \?\? 'GET'\} \$\{path\} \$\{body\}`/.test(TRANSPORT_CODE));
  check('3d: a bound expiry is a refusal with the SECURITY_LOCK code',
    /if \(!outcome\.ran\) return networkLockRefusal<T>\(\);/.test(TRANSPORT_CODE)
    && /code: 'SECURITY_LOCK'/.test(TRANSPORT_CODE));
  check('3e: the queue is bounded (no unbounded wait, no eternal pending screen)',
    /NETWORK_LOCK_DEFER_MAX_MS = 20_000/.test(TRANSPORT_CODE));
  check('3f: results are cloned per caller (no shared mutable result object)',
    /function cloneApiResult<T>\(r: ApiResult<unknown>\): ApiResult<T>/.test(TRANSPORT_CODE));

  // THE ALLOWLIST — unchanged, and still minimal: verification, audit, logout
  // and the public support contacts the block screen needs. Nothing that
  // returns protected content.
  const exemptBlock = TRANSPORT_CODE
    .slice(TRANSPORT_CODE.indexOf('const LOCK_EXEMPT_PREFIXES'), TRANSPORT_CODE.indexOf('function isLockExempt'));
  const listed = (exemptBlock.match(/'\/[a-z-]+(\/[a-z-]+)*'/g) || []).map((s) => s.replace(/'/g, ''));
  check('3g: the allowlist is exactly the documented six verification/recovery paths',
    JSON.stringify(listed) === JSON.stringify([
      '/security/policies', '/security/config', '/security/events', '/security/violations',
      '/auth/logout', '/support/contact',
    ]));
  check('3h: no protected-content prefix is exempt',
    !listed.some((p) => /lesson|course|video|material|storage|admin|user/.test(p)));
  check('3i: token rotation is still NOT exempt (protected activity stays frozen)',
    /if \(isSecurityLocked\(\)\) \{\s*\n\s*authStateLog\('AUTH_REFRESH_DEFINITIVE_FAILURE'/.test(TRANSPORT_CODE)
    && !listed.includes('/auth/refresh'));

  // The one direct fetch that carries app data must consult the lock itself.
  check('3j: the direct storage upload is refused (a write is never queued for replay)',
    /NETWORK LOCK: this upload goes through `globalThis\.fetch` directly[\s\S]{0,400}if \(isSecurityLocked\(\)\) \{[\s\S]{0,300}code: 'SECURITY_LOCK'/.test(TRANSPORT_CODE));
  check('3k: the security pipeline\'s own probes are not blocked by the lock',
    // The TLS/pinning probe uses globalThis.fetch to our own origin and is part
    // of verification — it must never be gated by the lock.
    !/isSecurityLocked|isNetworkLocked/.test(read('src/lib/security.ts')));
}

// ════════════════════════════════════════════════════════════════════════════
// 4. SecurityContext: startup lock, session-start ordering, resume publishing
// ════════════════════════════════════════════════════════════════════════════
console.log('\n4. SecurityContext — triggers, ordering and release');
{
  check('4a: the lock is engaged at SESSION START (app start is a mandatory verification event)',
    /if \(result === null\) enterBackgroundHold\('session-start'\);/.test(CONTEXT_CODE));
  check('4a-2: …only when no verdict exists yet in this process (an in-app sign-in already produced one)',
    /result === null\) enterBackgroundHold\('session-start'\)/.test(CONTEXT_CODE));
  check('4b: the session-start hold is released only by a completed clean verdict',
    /const maybeReleaseBackgroundHold = useCallback[\s\S]{0,1600}releaseSecurityLock\(LOCK_SRC_BACKGROUND\);/.test(CONTEXT_CODE));

  // ORDERING: the immediate check must be invoked AFTER the ref is assigned,
  // otherwise it calls the inert initializer and the first evaluation waits 30 s.
  const assignIdx = CONTEXT_CODE.indexOf('runPeriodicCheckRef.current = runPeriodicCheck;');
  const callIdx   = CONTEXT_CODE.indexOf('void runPeriodicCheckRef.current();');
  check('4c: the session-start check runs with the real implementation (ref assigned first)',
    assignIdx !== -1 && callIdx !== -1 && assignIdx < callIdx);
  check('4d: there is exactly one immediate session-start check invocation',
    (CONTEXT_CODE.match(/^ {4}void runPeriodicCheckRef\.current\(\);$/gm) || []).length === 1);

  // RESUME PUBLISHING: the resume verification must publish its verdict, or the
  // hold can only be released by the next 30 s tick.
  check('4e: one publish path writes the verdict, the callbacks, the log and the hold release',
    /const publishVerdict = useCallback\(\(r: SecurityCheckResult\) => \{[\s\S]{0,700}setResult\(r\);[\s\S]{0,500}blockingCbsRef\.current\.forEach\(\(cb\) => cb\(r\)\);[\s\S]{0,200}maybeReleaseBackgroundHold\(r\);/.test(CONTEXT_CODE));
  check('4f: the resume verification publishes what it measured',
    /const runAndPublish = async \(why: string\) => \{[\s\S]{0,300}const r = await runEvaluationRef\.current\(why\);[\s\S]{0,300}publishVerdictRef\.current\(r\);/.test(CONTEXT_CODE));
  check('4g: the resume watchdog retry publishes too (bounded retry, no silent drop)',
    /void runAndPublish\('resume-retry'\);/.test(CONTEXT_CODE));
  check('4h: a coalesced/superseded run is NOT published (no stale verdict)',
    /if \(!r\) return;[\s\S]{0,120}publishVerdictRef\.current\(r\);/.test(CONTEXT_CODE));

  // EXPOSED STATE
  check('4i: the context exposes networkLocked and networkAccessState',
    /networkLocked:       lockState\.locked,/.test(CONTEXT_CODE)
    && /networkAccessState:  resolveNetworkAccessState\(\{ locked: lockState\.locked \}\),/.test(CONTEXT_CODE));
  check('4j: the context default is NETWORK_OPEN (no lock before any signal)',
    /networkAccessState: 'NETWORK_OPEN',/.test(CONTEXT_CODE));
  check('4k: Super Admin still bypasses the hold',
    /const enterBackgroundHold = useCallback[\s\S]{0,200}if \(isSuperAdmin\) return;/.test(CONTEXT_CODE));
  check('4l: logout/session change releases every holder (no cross-identity leak)',
    /releaseAllSecurityLocks\(\);/.test(CONTEXT_CODE));
}

// ════════════════════════════════════════════════════════════════════════════
// 5. The ten playback/verification scenarios
// ════════════════════════════════════════════════════════════════════════════
console.log('\n5. YouTube / protected playback scenarios');
{
  const LESSON_CODE = read(LESSON);
  const YT_CODE     = read(YT_PLAYER);

  // 1. Resume while a video is playing.
  check('5.1a: leaving the foreground engages a HARD lock, so the player unmounts',
    /enterBackgroundHold\('appstate=' \+ nextState\);/.test(CONTEXT_CODE)
    && /engageSecurityLock\(LOCK_SRC_BACKGROUND, \{ hard: true \}\)/.test(CONTEXT_CODE));
  check('5.1b: containment stops the WebView player immediately (load halted, Plyr paused, frame detached)',
    /wv\.stopLoading\?\.\(\);/.test(read('src/lib/useSecurityWebViewStop.ts'))
    && /__medaSecurityStopped/.test(read('src/lib/useSecurityWebViewStop.ts'))
    && /frames\[j\]\.parentNode\.removeChild\(frames\[j\]\)/.test(read('src/lib/useSecurityWebViewStop.ts')));

  // 2 + 3. Opening a video (or the WebView initializing) during the pending window.
  check('5.2a: the lesson screen does not render the player while the hard lock is held',
    /!blocksVideo && !securityLockHard && \(lesson\.video_type === 'vdocipher' \|\| lesson\.video_type === 'youtube'\)/.test(LESSON_CODE));
  check('5.2b: the single in-place fullscreen container is gated on the same condition',
    /const isPinnedPlayer = !blocksVideo && !securityLockHard && playerVisible/.test(LESSON_CODE));
  check('5.3a: a player that mounts DURING the lock is stopped on registration',
    /Register an immediate playback-stop callback[\s\S]{0,900}if \(holders\.size > 0\) \{\n\s+try \{\n\s+stop\(\);/.test(read(LOCK_SRC)));
  check('5.3b: the lesson screen re-validates before playback and refuses on an unknown verdict',
    /const blocked = await checkBeforeVideo\(\)/.test(LESSON_CODE)
    && /fullscreenVerdictNow=\{\(\) => isSuperAdmin \|\| \(!blocksVideo && !securityLockHard\)\}/.test(LESSON_CODE));

  // 4. A clean verification clears the lock and the player loads normally.
  check('5.4a: release requires a clean verdict that started at/after the event',
    /acceptsResumeVerification\(\{/.test(CONTEXT_CODE)
    && /const stillBlocked = resolveBackgroundResumeGate\(\{/.test(CONTEXT_CODE)
    && /if \(stillBlocked\) return;/.test(CONTEXT_CODE));
  check('5.4b: the render condition is purely derived from the lock (no manual step to unlock)',
    !/Continue Anyway/.test(LESSON_CODE)
    && /!securityLockHard/.test(LESSON_CODE));

  // 5. A confirmed VPN/proxy keeps traffic blocked and routes to the block screen.
  check('5.5a: a confirmed violation engages the hard verdict holder (queued work can never replay)',
    /engageSecurityLock\(LOCK_SRC_VERDICT, \{ hard: true \}\)/.test(CONTEXT_CODE));
  check('5.5b: the violation reaches its authoritative screen through the blocking callbacks',
    /if \(r\.blocksLogin \|\| r\.blocksVideo\) blockingCbsRef\.current\.forEach\(\(cb\) => cb\(r\)\);/.test(CONTEXT_CODE));
  check('5.5c: VPN and proxy both resolve to the connection block page',
    /const vpnBlocked\s+= liveBlocking && hasConnectionFinding\(r\.threats\);/.test(CONTEXT_CODE));

  // 6. A failure does not release the lock.
  check('5.6a: a thrown evaluation publishes nothing (no synthetic clean verdict)',
    !/catch \(e\) \{[\s\S]{0,200}setResult\(/.test(CONTEXT_CODE.slice(CONTEXT_CODE.indexOf('const check = useCallback'), CONTEXT_CODE.indexOf('const checkBeforeVideo'))));
  check('5.6b: the watchdog retries once and never authorizes',
    /if \(resumeRetriedRef\.current\) return;/.test(CONTEXT_CODE)
    && /markResumeVerificationOverdue\(\);/.test(CONTEXT_CODE)
    && !/isResumeVerificationOverdue[\s\S]{0,200}releaseSecurityLock/.test(CONTEXT_CODE));

  // 7. No alternate network path from the player surfaces.
  check('5.7a: the video player is mounted from exactly ONE place in the app',
    (() => {
      const hits = [];
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { walk(p); continue; }
          if (!/\.(tsx|ts)$/.test(e.name)) continue;
          if (/components[\\/](VideoPlayer|YouTubePlayer)\.tsx$/.test(p)) continue;
          const src = fs.readFileSync(p, 'utf8');
          if (/<VideoPlayer|<YouTubePlayer/.test(src)) hits.push(p);
        }
      };
      walk(path.join(ROOT, 'src'));
      return hits.length === 1 && hits[0].endsWith(path.join('lesson', '[id].tsx'));
    })());
  check('5.7b: the WebView player consults the security gate at the fullscreen boundary',
    /shouldAllowFullscreen/.test(YT_CODE) && /securityGateRef/.test(YT_CODE));

  // 8. In-flight / established connections.
  check('5.8a: every protected request is registered so containment can abort it',
    /registerProtectedAbort\(controller\)/.test(TRANSPORT_CODE)
    && /protectedAborts\.clear\(\)/.test(read(LOCK_SRC)));
  check('5.8b: the documentation states that an established external connection is not revoked',
    /notCovered/.test(read(MODEL_SRC))
    && /already-established/i.test(read(MODEL_SRC)));

  // 9. Repeated transitions must not deadlock or leave the app permanently offline.
  L._resetSecurityLockForTests();
  for (let i = 0; i < 5; i++) {
    L.engageSecurityLock('background', { hard: true });
    L.engageSecurityLock('background', { hard: true });   // idempotent
    L.releaseSecurityLock('background');
  }
  check('5.9a: repeated background/foreground cycles end unlocked (no deadlock)',
    L.isNetworkLocked() === false && L._pendingRunsForTests() === 0);
  L.engageSecurityLock('background', { hard: true });
  L.releaseSecurityLock('background');
  check('5.9b: a release clears the lock for the next cycle', L.isNetworkLocked() === false);
  L._resetSecurityLockForTests();

  // 10. Essential flows keep working.
  check('5.10a: the security/integrity/logout/support paths are exempt (verification never deadlocks)',
    /'\/security\/policies', '\/security\/config', '\/security\/events', '\/security\/violations'/.test(TRANSPORT_CODE)
    && /'\/auth\/logout',/.test(TRANSPORT_CODE)
    && /'\/support\/contact',/.test(TRANSPORT_CODE));
  check('5.10b: the evaluation\'s own reads are exempt, so the pipeline cannot be starved by the lock',
    // getSecurityPolicies → /security/policies, getSecurityConfig → /security/config,
    // logThreats → /security/events, VPN whitelist → /security/policies payload.
    /'get-security-policies':\s+'\/security\/policies'/.test(TRANSPORT_CODE)
    && /'get-security-config':\s+'\/security\/config'/.test(TRANSPORT_CODE)
    && /'security-logger':\s+'\/security\/events'/.test(TRANSPORT_CODE));
  check('5.10c: forced-update / maintenance keep working because non-exempt GETs are QUEUED, not refused',
    /apiFetch<RemoteUpdateConfig>\('\/app\/version'/.test(read('src/lib/updateConfigService.ts'))
    && /deferUntilNetworkUnlocked/.test(TRANSPORT_CODE));
  check('5.10d: login and the pre-session gate are untouched (no session → no lock)',
    !/securityLock|isSecurityLocked|isNetworkLocked/.test(read('src/app/(auth)/sign-in.tsx'))
    && fs.existsSync(path.join(ROOT, 'src/app/(auth)/security-warning.tsx')));
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Direct uploads and the absence of a device-wide block
// ════════════════════════════════════════════════════════════════════════════
console.log('\n6. direct uploads and honest scope');
{
  const UPLOAD_CODE = read(UPLOAD);
  check('6a: chunked uploads hold while the lock is held',
    /const holdWhileNetworkLocked = async \(\) => \{[\s\S]{0,300}await waitForNetworkUnlock\(UPLOAD_NETWORK_LOCK_WAIT_MS\)/.test(UPLOAD_CODE));
  check('6b: no chunk starts behind the lock',
    /await holdWhileNetworkLocked\(\);/.test(UPLOAD_CODE));
  check('6c: an upload that cannot resume is PAUSED, never silently successful',
    /throw new Error\('Upload paused or cancelled'\)/.test(UPLOAD_CODE));
  check('6d: the upload wait is bounded',
    /UPLOAD_NETWORK_LOCK_WAIT_MS = 30_000/.test(UPLOAD_CODE));

  // HONESTY GUARDS: nothing may claim the device (or the WebView) is offline.
  const lockAndModel = read(LOCK_SRC) + read(MODEL_SRC);
  check('6e: no device-wide blocking mechanism is introduced (no VPNService, no proxy, no privilege request)',
    !/\bVpnService\b|setGlobalProxy|ACTION_ACCESSIBILITY_SETTINGS|ACTION_VPN_SETTINGS|createVpnProfile|establish\(\)/i
      .test(lockAndModel));
  check('6e-2: the only accessibility mention is a documented NON-use (multi-window evidence)',
    !/AccessibilityService/.test(read(LOCK_SRC))
    && /it requires an accessibility service/.test(read(MODEL_SRC))
    && /this app deliberately does not request/.test(read(MODEL_SRC)));
  check('6e-3: the lock is scoped to the app (no OS-wide network change is possible from this code)',
    !/System\.setProperty|ConnectivityManager\.set|iptables|pfctl/.test(lockAndModel));
  check('6f: the YouTube connection is described as out of scope, not as blocked',
    !/YouTube[^.]{0,80}(blocked|offline|suspended)/i.test(read(MODEL_SRC)));
  check('6g: no new dependency was added for the network lock',
    (() => {
      const d = JSON.parse(read('package.json')).dependencies || {};
      return !('@react-native-community/netinfo-block' in d) && !('react-native-network-lock' in d);
    })());
}

}

main()
  .then(() => {
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    console.error('networkLock suite crashed:', e);
    process.exit(1);
  });
