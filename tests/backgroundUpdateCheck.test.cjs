/**
 * App-update check is a BACKGROUND request — regression tests.
 *
 * Run: node tests/backgroundUpdateCheck.test.cjs
 *
 * THE DEFECT THIS PINS
 * ───────────────────
 * The mandatory-update gate used to treat the version request as a render
 * dependency: the root ForceUpdateGate hard-blocked the WHOLE tree on
 * `verdict === 'UNKNOWN' && evaluating`, and ForceUpdateScreen drew a
 * full-screen "Checking for updates…" spinner for that state. Two failures
 * followed:
 *   • a restored session on cold start was replaced by that wall until
 *     GET /app/version answered (a slow network = a long stall);
 *   • a failed attempt left `evaluating: true` forever, so an unreachable or
 *     timed-out endpoint pinned the wall up permanently.
 *
 * The contract now:
 *   • the first screen renders immediately — nothing awaits the network;
 *   • ONE shared, race-safe request (single-flight + monotonic generation)
 *     serves startup, foreground, reconnect, auth checkpoints and manual
 *     re-checks; no duplicates, no stale answers overwriting newer ones;
 *   • a CONFIRMED mandatory update blocks (protected shell, authentication
 *     checkpoints, server 426) and cannot be bypassed by navigation;
 *   • an unresolved check — in flight OR failed — never blocks and is never
 *     reported as "no update needed"; auth checkpoints wait on it for a
 *     BOUNDED time only and retry it at the next checkpoint.
 *
 * Sections A–C and E–H pin shipped source shape (the ordering guarantees live
 * in React/native lifecycles that node cannot mount); section B and D also run
 * the real compiled pure model, and the bounded-wait helper is exercised
 * behaviourally with real timers.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✔ ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

/** Compiled pure state model (npm run test:state builds scripts/state-build/). */
function requireStateModel(name) {
  for (const dir of ['scripts/state-build', '.freebuff/state-build']) {
    const p = path.join(ROOT, dir, name);
    if (fs.existsSync(p)) return require(p);
  }
  throw new Error(`compiled state model not found: ${name} — run: npm run test:state`);
}
const model = requireStateModel('securityStateModel.js');

const rootLayout = read('src/app/_layout.tsx');
const appLayout = read('src/app/(app)/_layout.tsx');
const authLayout = read('src/app/(auth)/_layout.tsx');
const authGate = read('src/components/UpdateAuthGate.tsx');
const forceScreen = read('src/components/ForceUpdateScreen.tsx');
const service = read('src/lib/updateConfigService.ts');
const hook = read('src/lib/useForceUpdate.ts');
const signIn = read('src/app/(auth)/sign-in.tsx');
const signUp = read('src/app/(auth)/sign-up.tsx');

/** Slice a function body by name (first occurrence after `startAt`). */
function bodyOf(src, name, startAt = 0) {
  const start = src.indexOf(name, startAt);
  if (start < 0) return '';
  // Walk braces so nested functions are kept.
  const open = src.indexOf('{', start);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

// ── A. The first screen renders without waiting for the request ──────────────
console.log('\nA. Startup is not gated by the version request');
ok(
  /const hardBlocked = protectedSurface && update\.gateBlocks;/.test(rootLayout),
  'root gate blocks ONLY on a confirmed requirement (gateBlocks), never on "pending"'
);
ok(
  !/gateDecision !== 'none'/.test(rootLayout),
  'the old `decision !== none` block (which included pending) is gone'
);
ok(
  /protectedDecision === 'required'/.test(hook) &&
    /const gateBlocks = protectedDecision === 'required';/.test(hook),
  'useUpdate derives gateBlocks as "required" only — pending is never a block'
);
ok(
  /const updateBlocks = update\.gateBlocks;/.test(appLayout),
  '(app) shell gate uses gateBlocks too (both gates agree, no flash window)'
);
ok(
  /initUpdateLifecycle\(\);\n\s*const un2/.test(rootLayout),
  'update lifecycle is started from an effect (fired after the first render, not awaited)'
);
ok(
  !/await\s+checkAppUpdate\(/.test(rootLayout) && !/await\s+initUpdateLifecycle/.test(rootLayout),
  'the root layout never awaits the version check before rendering'
);
// The dedicated blocking check screen is gone.
ok(
  !/update\.evaluating/.test(forceScreen),
  'ForceUpdateScreen no longer renders a "checking for updates" state from evaluating'
);
ok(
  !/update\.checking/.test(forceScreen),
  'no "Checking for updates…" copy anywhere in the update screen'
);
ok(
  /const showGate = required;/.test(forceScreen),
  'the full-screen update page renders ONLY for a confirmed UPDATE_REQUIRED verdict'
);
ok(
  /if \(hardBlocked\) \{\n\s*return <ForceUpdateScreen \/>;\n\s*\}/.test(rootLayout) &&
    /return \(\n\s*<View style=\{\{ flex: 1 \}\}>/.test(rootLayout),
  'root gate returns children (the real app) unless a mandatory update is confirmed'
);
// Soft banner path preserved (no unrelated redesign).
ok(
  /softAvailable = update\.verdict === 'UPDATE_REQUIRED' && update\.mode === 'OPTIONAL'/.test(rootLayout),
  'OPTIONAL-mode soft banner path is preserved'
);

// ── B. Pure decision model ───────────────────────────────────────────────────
console.log('\nB. Pure gate + checkpoint decisions');
ok(
  model.resolveUpdateGateDecision({ verdict: 'UNKNOWN', evaluating: true, protectedSurface: true }) === 'pending',
  'UNKNOWN + in flight → "pending" (unresolved, informational)'
);
ok(
  model.updateGateBlocks('pending') === false,
  'a pending verdict does NOT block — the app renders while the check runs'
);
ok(
  model.resolveUpdateGateDecision({ verdict: 'UNKNOWN', evaluating: false, protectedSurface: true }) === 'pending',
  'UNKNOWN after a FAILED attempt → still "pending" (resolved by a retry, never by inventing a verdict)'
);
ok(
  model.updateGateBlocks(model.resolveUpdateGateDecision({ verdict: 'UNKNOWN', evaluating: false, protectedSurface: true })) === false,
  'a failed/timed-out check does not block the app'
);
ok(
  model.resolveUpdateGateDecision({ verdict: 'UPDATE_REQUIRED', evaluating: false, protectedSurface: true }) === 'required',
  'confirmed mandatory update → "required"'
);
ok(
  model.updateGateBlocks('required') === true,
  'a confirmed mandatory update BLOCKS (enforcement preserved)'
);
ok(
  model.resolveUpdateGateDecision({ verdict: 'UPDATE_REQUIRED', evaluating: true, protectedSurface: true }) === 'required',
  'a confirmed requirement blocks even while a re-check runs'
);
ok(
  model.resolveUpdateGateDecision({ verdict: 'SUPPORTED', evaluating: false, protectedSurface: true }) === 'none',
  'no-update verdict → no gate'
);
ok(
  model.resolveUpdateGateDecision({ verdict: 'UPDATE_REQUIRED', evaluating: false, protectedSurface: false }) === 'none',
  'a non-protected surface is never gated by this decision (auth gate owns the checkpoint)'
);
ok(
  model.resolveUpdateCheckpoint({ verdict: 'UPDATE_REQUIRED', evaluating: false }) === 'block',
  'checkpoint: confirmed mandatory update → block authentication'
);
ok(
  model.resolveUpdateCheckpoint({ verdict: 'SUPPORTED', evaluating: false }) === 'proceed',
  'checkpoint: explicit SUPPORTED → proceed with auth'
);
ok(
  model.resolveUpdateCheckpoint({ verdict: 'UNKNOWN', evaluating: true }) === 'wait',
  'checkpoint: check in flight → wait (join the shared request)'
);
ok(
  model.resolveUpdateCheckpoint({ verdict: 'UNKNOWN', evaluating: false }) === 'retry',
  'checkpoint: previous attempt failed → retry once (never treated as "no update")'
);

// ── C. A slow/pending request cannot stall startup or auth ──────────────────
console.log('\nC. Bounded wait (behavioural, real timers)');
(async () => {
  {
    // Never-resolving check → the bounded wait must return, and quickly.
    const started = Date.now();
    const r = await model.raceUpdateCheckWithTimeout(new Promise(() => {}), 40);
    const elapsed = Date.now() - started;
    ok(r.timedOut === true && r.value === null, 'a never-answering check times out instead of hanging');
    ok(elapsed >= 30 && elapsed < 2000, `bounded wait returned promptly (${elapsed}ms, budget 40ms)`);
  }
  {
    const r = await model.raceUpdateCheckWithTimeout(Promise.resolve('verdict'), 500);
    ok(r.timedOut === false && r.value === 'verdict', 'a fast answer is returned with timedOut=false');
  }
  {
    const started = Date.now();
    const r = await model.raceUpdateCheckWithTimeout(new Promise(() => {}), 0);
    ok(r.timedOut === true && Date.now() - started < 1000, 'a non-positive budget cannot wait at all');
  }

  // ── D. Confirmed mandatory update blocks across every surface ─────────────
  console.log('\nD. Confirmed mandatory update blocks everywhere');
  ok(
    /update\.gateBlocks/.test(authGate) && /<ForceUpdateScreen \/>/.test(authGate),
    'UpdateAuthGate renders the existing full-screen update page for a confirmed requirement'
  );
  ok(
    /\{children\}/.test(authGate) && /StyleSheet\.absoluteFill/.test(authGate),
    'the auth navigator stays mounted under a non-dismissible overlay (no empty route table)'
  );
  ok(
    /<UpdateAuthGate>/.test(authLayout) && /<Stack screenOptions=\{\{ headerShown: false \}\} \/>/.test(authLayout),
    'the whole (auth) route group is mounted behind the checkpoint gate'
  );
  ok(
    /ensureUpdateCheck\(\)/.test(authGate),
    'reaching an auth screen starts/joins the background check (no duplicate request)'
  );
  ok(
    /if \(updateCheckpoint\.plan === 'block'\) \{\n\s*setLoading\(false\);\n\s*return;\n\s*\}/.test(signIn),
    'sign-in refuses to create a session when a mandatory update is confirmed'
  );
  ok(
    /const updateCheckpoint = await awaitUpdateCheck\(\);[\s\S]{0,400}if \(updateCheckpoint\.plan === 'block'\)/.test(signUp),
    'sign-up applies the same checkpoint (no account created on a blocked build)'
  );
  {
    const cpIdx = signIn.indexOf('await awaitUpdateCheck()');
    const authIdx = signIn.indexOf('signInWithPassword(');
    ok(cpIdx > -1 && authIdx > cpIdx, 'the update checkpoint runs BEFORE the credential request');
  }
  ok(
    /ForceUpdateGate\(/.test(rootLayout) && rootLayout.indexOf('ForceUpdateGate') < rootLayout.indexOf('<Stack'),
    'the update gate sits above the navigator, so route navigation cannot bypass it'
  );
  ok(
    /wireUpdateInterceptor\(\)/.test(service) && /markServerUpdateRequired/.test(service),
    'server-side HTTP 426 enforcement is still wired (bypass-proof boundary preserved)'
  );
  ok(
    /emitUpdateRejection/.test(read('src/client/php.ts')),
    'apiFetch still reports 426 rejections to the update service'
  );

  // ── E. No-update answer → normal authentication ──────────────────────────
  console.log('\nE. No-update path');
  {
    const awaitFn = bodyOf(service, 'export async function awaitUpdateCheck');
    ok(awaitFn.length > 0, 'awaitUpdateCheck exists');
    ok(
      /if \(initial !== 'wait' && initial !== 'retry'\) \{\n\s*return \{ plan: initial, state, timedOut: false \};\n\s*\}/.test(awaitFn),
      'an explicit verdict returns immediately (no request, no waiting)'
    );
    ok(
      /checkAppUpdate\(\)/.test(awaitFn) && !/apiFetch/.test(awaitFn),
      'the checkpoint joins the shared check function (never opens its own request)'
    );
  }

  // ── F. Failed / timed-out check ─────────────────────────────────────────┐
  console.log('\nF. Failure semantics (never "no update", never a permanent block)');
  {
    const failed = bodyOf(service, 'function recordFailedAttempt');
    ok(failed.length > 0, 'failures go through a single recordFailedAttempt path');
    ok(
      /evaluating: false/.test(failed),
      'a finished failure clears evaluating (this was the permanent startup wall)'
    );
    ok(
      /lastCheckFailed: true/.test(failed),
      'the failure is recorded separately (distinguishable from "still checking")'
    );
    ok(
      !/verdict: 'SUPPORTED'/.test(failed),
      'a network failure is NEVER converted into a SUPPORTED ("no update") verdict'
    );
    ok(
      /scheduleUpdateRetryAfterFailure\(\)/.test(failed),
      'a failed attempt arms the bounded retry chain'
    );
    const retry = bodyOf(service, 'function scheduleUpdateRetryAfterFailure');
    ok(
      /UPDATE_RETRY_DELAYS_MS/.test(retry) && /updateRetryAttempt >= UPDATE_RETRY_DELAYS_MS\.length/.test(retry),
      'retries are bounded (no infinite retry loop)'
    );
    const delays = service.match(/const UPDATE_RETRY_DELAYS_MS = \[([^\]]+)\]/);
    ok(
      delays !== null && delays[1].split(',').filter((s) => s.trim()).length <= 4 &&
        delays[1].split(',').filter((s) => s.trim()).length >= 1,
      'the retry chain is a short, explicit delay list'
    );
    ok(
      /clearUpdateRetry\(\)/.test(service.slice(service.indexOf('export function initUpdateLifecycle'))),
      'lifecycle teardown cancels a pending retry timer'
    );
    ok(
      /if \(state\.verdict === 'UNKNOWN' && state\.evaluating\) \{/.test(service),
      'cached-policy application still defers to an in-flight live check'
    );
  }

  // ── G. Authentication during a pending check ────────────────────────────
  console.log('\nG. Sign-in while a check is still running');
  {
    const awaitFn = bodyOf(service, 'export async function awaitUpdateCheck');
    ok(
      /raceUpdateCheckWithTimeout\(pending, timeoutMs\)/.test(awaitFn),
      'the checkpoint waits for the SHARED promise under a bounded budget'
    );
    ok(
      /plan: resolveUpdateCheckpoint\(\{ verdict: state\.verdict, evaluating: state\.evaluating \}\)/.test(awaitFn),
      'the plan is re-derived from the authoritative store after the wait (fresh verdict wins)'
    );
    ok(
      /UPDATE_CHECKPOINT_TIMEOUT_MS = 4_000/.test(service),
      'the wait has a small, explicit budget (never "indefinitely")'
    );
    ok(
      /timedOut/.test(signIn),
      'the sign-in screen reports the timeout outcome in its diagnostics (clear, not silent)'
    );
    ok(
      /checkFailed/.test(hook) && /checkInFlight/.test(hook),
      'the hook exposes in-flight / failed state so a retry UI can be offered'
    );
  }

  // ── H. Duplicate & racing checks ────────────────────────────────────────
  console.log('\nH. One shared request, no stale results');
  {
    const checkFn = bodyOf(service, 'export async function checkAppUpdate');
    ok(
      /if \(updateCheckInFlight\) return updateCheckInFlight;/.test(checkFn),
      'concurrent callers join the in-flight request (no duplicate network calls)'
    );
    ok(
      /if \(updateCheckInFlight === promise\) updateCheckInFlight = null;/.test(checkFn),
      'only the owning promise clears the shared slot (a superseded check cannot un-dedupe a newer one)'
    );
    ok(
      /let updateSeq = 0;/.test(service) && /if \(mySeq !== updateSeq\) return state;/.test(service),
      'a monotonic generation drops late answers that a newer check already superseded'
    );
    ok(
      /export function markServerUpdateRequired[\s\S]{0,1200}?updateSeq \+= 1;/.test(service),
      'a server 426 invalidates any in-flight check (a late SUPPORTED cannot clear it)'
    );
    const ensure = bodyOf(service, 'export function ensureUpdateCheck');
    ok(
      /if \(updateCheckInFlight\) return;/.test(ensure) && /if \(state\.verdict !== 'UNKNOWN'\) return;/.test(ensure),
      'ensureUpdateCheck is idempotent: no request while one runs, none once a verdict exists'
    );
    ok(
      /void checkAppUpdate\(\);\n\s*const sub = AppState\.addEventListener/.test(service),
      'cold-start check is fired (not awaited) before the foreground subscription'
    );
    ok(
      /if \(s === 'active'\) void checkAppUpdate\(\);/.test(service),
      'app resume re-checks through the same single-flight entry point'
    );
  }

  // ── I. Cross-suite invariants kept ──────────────────────────────────────
  console.log('\nI. Enforcement and unrelated behaviour preserved');
  ok(
    /evaluateUpdateVerdict/.test(service) && /minimumVersionCode/.test(service),
    'versionCode comparison / minimum supported version rules untouched'
  );
  ok(
    /update_policy_cache_v2/.test(service),
    'offline policy cache unchanged'
  );
  ok(
    /openUpdateUrl/.test(forceScreen) && /Check again|update\.checkAgain/.test(forceScreen),
    'update download/store-opening actions and manual re-check preserved'
  );
  ok(
    /<SecurityGate \/>/.test(appLayout),
    'SecurityGate is still mounted in the authenticated shell'
  );
  ok(
    /update\.dismissOptional/.test(forceScreen),
    'OPTIONAL dismiss path untouched'
  );
  ok(
    !/bypass|skipUpdate|disableUpdate/i.test(authGate),
    'no bypass/skip escape hatch was introduced in the new auth gate'
  );

  console.log('\n──────────────────────────────────────────────');
  if (failures.length) {
    console.log(`RESULT: ${pass} passed, ${failures.length} failed`);
    for (const f of failures) console.log('  FAILED: ' + f);
    process.exit(1);
  }
  console.log(`RESULT: ${pass} passed, 0 failed`);
  console.log('ALL BACKGROUND-UPDATE-CHECK TESTS PASSED');
})().catch((e) => {
  console.error('suite crashed:', e);
  process.exit(1);
});
