#!/usr/bin/env node
/**
 * BLOCKED-SCREEN TRAFFIC + SESSION RECOVERY — regression contract.
 *
 * Run: node tests/securityLockTrafficAndSessionRecovery.test.cjs
 *
 * THREE OBSERVED DEFECTS, TWO ROOT CAUSES
 * ---------------------------------------
 * Issue 2 (blocked screen): "Could not load support contacts. Check your
 *   connection and try again." The request and the endpoint were fine and
 *   PUBLIC; `/support/contact` was already on the lock's allowlist. The transport
 *   still failed it because EVERY request — including allowlisted ones — was
 *   passed to registerProtectedAbort(), which ABORTS IMMEDIATELY when the lock is
 *   already held. The pre-login block screen runs precisely in that state, so the
 *   allowlist was dead code for every path on it: support contacts, the violation
 *   report (audit gap) and /auth/logout.
 *
 * Issue 3 (logout ~1 min after a ~30 min background): on resume the security lock
 *   engages and containment aborts every registered in-flight request — including
 *   an in-flight POST /auth/refresh. Refresh tokens are SINGLE-USE: if the server
 *   completed the rotation, the client never receives the new pair while the OLD
 *   token is now revoked. The next refresh (the 30 s revocation poll, once the
 *   lock clears) gets a definitive 401, and the definitive-failure policy clears a
 *   perfectly valid session. Two corrections:
 *     • containment never aborts a rotation in flight (it is exempt from the
 *       abort registry, still frozen while the lock is held);
 *     • a suppressed rotation is re-scheduled for the moment the lock FULLY
 *       clears, so a resume recovers without a user re-login.
 *
 * WHAT THIS SUITE PINS
 *   1. registerProtectedAbort semantics (behavioural, compiled).
 *   2. The queue's refusal-vs-replay rule for the recovery path (behavioural).
 *   3. The definitive-vs-transient session model (behavioural) — a network error,
 *      timeout or 5xx during restore never clears; a confirmed 401/revoked token
 *      always does.
 *   4. The transport contract: allowlisted + /auth/refresh are never abort-
 *      registered, /auth/refresh is not allowlisted, single-flight refresh, the
 *      identity-swap discard, and no session clearing on a suppressed refresh.
 *   5. The support-contacts path end to end: public endpoint, client call, error
 *      propagation and a working retry on the blocked screen.
 *   6. A confirmed security violation blocks access WITHOUT clearing the account
 *      session (the two concerns stay separate).
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond) {
  if (cond) { passed++; console.log('  \u2705 ' + name); return true; }
  failed++; failures.push(name); console.error('  \u274c ' + name); return false;
}

const TRANSPORT = 'src/client/php.ts';
const LOCK_SRC = 'src/lib/securityLock.ts';
const AUTH_MODEL = 'src/lib/authFailureModel.ts';
const TRANSPORT_CODE = read(TRANSPORT);

function buildModules() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'locktr-'));
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      path.join(ROOT, LOCK_SRC),
      path.join(ROOT, AUTH_MODEL),
      '--outDir', tmp,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
  return {
    lock: require(path.join(tmp, 'securityLock.js')),
    auth: require(path.join(tmp, 'authFailureModel.js')),
  };
}

const { lock: L, auth: A } = buildModules();

async function main() {
  // ══════════════════════════════════════════════════════════════════════════
  // 1. registerProtectedAbort — containment semantics (behavioural)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n1. registerProtectedAbort (compiled behaviour)');
  {
    L._resetSecurityLockForTests();
    let aborted = 0;
    const c1 = { abort: () => { aborted++; } };
    const un1 = L.registerProtectedAbort(c1);
    check('1a: while unlocked, a request is registered and NOT aborted', aborted === 0);
    L.engageSecurityLock('test', { hard: true });
    check('1b: engaging the lock aborts the registered request', aborted === 1);
    let aborted2 = 0;
    const refusedBefore = L.getContainmentDiagnostics().refusedProtectedRequests;
    const un2 = L.registerProtectedAbort({ abort: () => { aborted2++; } });
    check('1c: a request registered WHILE locked is aborted immediately', aborted2 === 1);
    check('1d: that refusal is recorded as a gate-breach attempt',
      L.getContainmentDiagnostics().refusedProtectedRequests === refusedBefore + 1);
    L.releaseSecurityLock('test');
    check('1e: release clears the lock', L.isNetworkLocked() === false);
    check('1f: unregister functions never throw after their request settled',
      (() => { try { un1(); un2(); return true; } catch { return false; } })());
    L._resetSecurityLockForTests();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 2. Deferral used by the post-unlock rotation (behavioural)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n2. runWhenNetworkUnlocked — refusal vs replay');
  {
    L._resetSecurityLockForTests();
    L.engageSecurityLock('resume', { hard: true });
    let ran = 0;
    const pending = L.runWhenNetworkUnlocked('POST /auth/refresh (post-unlock recovery)', async () => { ran++; }, 200);
    await new Promise((r) => setTimeout(r, 20));
    check('2a: nothing executes while the lock is held', ran === 0);
    const expired = await pending;
    check('2b: a lock that never clears yields a REFUSAL, not a run', expired.ran === false && ran === 0);

    L._resetSecurityLockForTests();
    L.engageSecurityLock('resume', { hard: true });
    L.engageSecurityLock('violation', { hard: true });
    let ranClean = 0;
    const queued = L.runWhenNetworkUnlocked('POST /auth/refresh (post-unlock recovery)', async () => { ranClean++; }, 5000);
    L.releaseSecurityLock('resume');
    await new Promise((r) => setTimeout(r, 20));
    check('2c: a partial release does NOT replay (a confirmed holder still blocks it)', ranClean === 0);
    L.releaseSecurityLock('violation');
    const okRun = await queued;
    check('2d: after a FULL release the rotation runs exactly once', okRun.ran === true && ranClean === 1);

    // Concurrent callers share one execution (the transport's single-flight +
    // queue key: a double resume cannot spend the same refresh token twice).
    L._resetSecurityLockForTests();
    L.engageSecurityLock('resume', { hard: true });
    let once = 0;
    const a = L.runWhenNetworkUnlocked('POST /auth/refresh (post-unlock recovery)', async () => { once++; return 1; }, 5000);
    const b = L.runWhenNetworkUnlocked('POST /auth/refresh (post-unlock recovery)', async () => { once++; return 2; }, 5000);
    L.releaseSecurityLock('resume');
    const [ra, rb] = await Promise.all([a, b]);
    check('2e: identical queued work is deduplicated (one rotation, both callers answered)',
      once === 1 && ra.ran === true && rb.ran === true);
    L._resetSecurityLockForTests();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3. The auth failure model — what may clear a session (behavioural)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n3. definitive vs transient (authFailureModel)');
  {
    check('3a: a 401 from /auth/refresh is definitive (server refused the credential)',
      A.shouldClearSession(A.classifyAuthHttpStatus(401)) === true);
    check('3b: a 403 (suspended account) is definitive',
      A.shouldClearSession(A.classifyAuthHttpStatus(403)) === true);
    check('3c: 400/422 (malformed refresh request) are definitive',
      A.shouldClearSession(A.classifyAuthHttpStatus(400)) === true &&
      A.shouldClearSession(A.classifyAuthHttpStatus(422)) === true);
    check('3d: a network failure (no status) never clears the session',
      A.shouldClearSession(A.classifyAuthHttpStatus(undefined)) === false);
    check('3e: a timeout/no-status restore never clears the session',
      A.shouldClearSession(A.classifyAuthHttpStatus(null)) === false);
    check('3f: a 5xx during restore never clears the session',
      A.shouldClearSession(A.classifyAuthHttpStatus(503)) === false);
    check('3g: a 429 is retryable, never a logout',
      A.shouldClearSession(A.classifyAuthHttpStatus(429)) === false);
    check('3h: only the four definitive kinds are session-terminating',
      ['AUTH_INVALID', 'AUTH_REVOKED', 'ACCOUNT_BLOCKED', 'SESSION_EXPIRED']
        .filter((k) => A.shouldClearSession(k)).length === 4 &&
      ['NETWORK_ERROR', 'TIMEOUT', 'OFFLINE', 'SERVER_5XX', 'SECURITY_UNKNOWN',
        'SECURITY_BLOCKED', 'MAINTENANCE', 'UPDATE_REQUIRED']
        .every((k) => A.shouldClearSession(k) === false));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 4. Transport contract (source, because it imports React Native)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n4. transport contract');
  {
    check('4a: allowlisted paths and /auth/refresh are exempt from abort registration',
      /const abortExempt = isLockExempt\(path\) \|\| path\.startsWith\('\/auth\/refresh'\);/.test(TRANSPORT_CODE) &&
      /const unregisterAbort = abortExempt \? \(\) => \{\} : registerProtectedAbort\(controller\);/.test(TRANSPORT_CODE));

    check('4b: /auth/refresh is still NOT on the lock allowlist (rotation stays frozen)',
      (() => {
        const block = TRANSPORT_CODE.slice(
          TRANSPORT_CODE.indexOf('const LOCK_EXEMPT_PREFIXES'),
          TRANSPORT_CODE.indexOf('function isLockExempt'),
        );
        return !/'\/auth\/refresh'/.test(block);
      })());

    check('4c: a suppressed rotation is deferred exactly once for the post-unlock moment',
      /let unlockRefreshScheduled = false;/.test(TRANSPORT_CODE) &&
      /if \(unlockRefreshScheduled\) return;/.test(TRANSPORT_CODE) &&
      /scheduleRefreshAfterUnlock\(\);\s*\n\s*return false;/.test(TRANSPORT_CODE));

    check('4d: the deferred rotation re-reads the session and never rotates a different identity',
      /const stored = getStoredSession\(\);\s*\n\s*if \(!stored\?\.refresh_token \|\| isSecurityLocked\(\)\) return;/.test(TRANSPORT_CODE));

    check('4e: a lock-suppressed refresh NEVER clears the session',
      /AUTH_REFRESH_SUPPRESSED/.test(TRANSPORT_CODE) &&
      !/AUTH_REFRESH_SUPPRESSED[\s\S]{0,200}clearSession\(\)/.test(TRANSPORT_CODE));

    check('4f: refresh is single-flight (concurrent 401s spend one rotation)',
      /if \(refreshPromise\) \{[\s\S]{0,120}return refreshPromise;/.test(TRANSPORT_CODE));

    check('4g: a rotated pair is discarded when the session identity changed mid-flight',
      /current\.access_token !== stored\.access_token/.test(TRANSPORT_CODE) &&
      /AUTH_REFRESH_DISCARDED/.test(TRANSPORT_CODE));

    check('4h: the foreground handler treats a refresh failure as non-fatal (no sign-out)',
      (() => {
        const CTX = read('src/ctx.tsx');
        return /foreground refreshSession error \(non-fatal, skipping check\)/.test(CTX) &&
          !/foreground refreshSession error[\s\S]{0,240}signOut\(/.test(CTX);
      })());

    // Exactly three call sites: refreshAccessToken's definitive branch, the
    // explicit-token refresh path, and the user-initiated signOut. A generic
    // 401 path never appears here.
    check('4i: only the definitive refresh branches and signOut clear the session',
      (TRANSPORT_CODE.match(/await clearSession\(\)/g) || []).length === 3);

    // Scenario 8 — app termination and relaunch: the restored session comes from
    // storage, not the network, so a cold start after a 30 min background cannot
    // sign the user out before any request is made. Nothing in that path clears.
    check('4i-2: relaunch restores the persisted session offline (no network, no clear)',
      /getSession: async \(\) => \{[\s\S]{0,320}await _hydrationDone;[\s\S]{0,120}const session = getStoredSession\(\);[\s\S]{0,80}return \{ data: \{ session \}, error: null \};/.test(TRANSPORT_CODE) &&
      !/getSession: async \(\) => \{[\s\S]{0,400}clearSession\(\)/.test(TRANSPORT_CODE));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 5. Support contacts — endpoint, client, retry
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n5. support contacts path');
  {
    const ROUTES = read('backend/routes/api.php');
    check('5a: the backend route exists and is PUBLIC (no auth middleware on it)',
      /\$router->get\('\/support\/contact', \[SupportController::class, 'publicContact'\]\);/.test(ROUTES));
    check('5b: the controller method exists', (() => {
      const c = read('backend/src/Controllers/SupportController.php');
      return /public function publicContact\(Request \$request\): void/.test(c) &&
        /support_settings/.test(c);
    })());
    check('5c: the client calls the same path with no session dependency',
      /apiFetch<\{ contacts: PublicSupportContact\[\] \}>\('\/support\/contact'\)/.test(read('src/lib/api.ts')));
    check('5d: the blocked screen surfaces a retry action (not just the error)',
      (() => {
        for (const f of ['src/app/(auth)/security-warning.tsx', 'src/app/(app)/security-warning.tsx']) {
          const s = read(f);
          // The error copy is translated now; the English text must still exist in
          // the dictionary, and the screen must reference its key.
          if (!/t\('security\.supportLoadFailed'\)/.test(s)) return false;
          if (!/'security\.supportLoadFailed': 'Could not load support contacts/.test(read('src/lib/i18n/resources.ts'))) return false;
          if (!/loadSupportContacts/.test(s)) return false;
          // The retry must re-run the loader (the error copy alone is not a fix).
          if (!/onPress=\{\(\) => void loadSupportContacts\(\)\}|onPress=\{loadSupportContacts\}/.test(s)) return false;
          if (!/t\('common\.retry'\)/.test(s)) return false;
        }
        return true;
      })());
    check('5e: the allowlist entry is documented as a public, read-only need',
      /'\/support\/contact'/.test(TRANSPORT_CODE) &&
      /PUBLIC, read-only/.test(TRANSPORT_CODE));
    check('5f: support contacts never unlock the app (no release call in either screen)',
      !/releaseSecurityLock|releaseAllSecurityLocks/.test(read('src/app/(auth)/security-warning.tsx')) &&
      !/releaseSecurityLock|releaseAllSecurityLocks/.test(read('src/app/(app)/security-warning.tsx')));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 6. Blocking a device never clears the account session
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n6. security block ≠ logout');
  {
    const CONTEXT = read('src/lib/SecurityContext.tsx');
    check('6a: SecurityContext never clears the session (a block is not a sign-out)',
      !/clearSession\(/.test(CONTEXT));
    check('6b: the block is expressed through the gate state, not the auth state',
      /resolveSecurityGateState/.test(CONTEXT));
    check('6c: a sign-out still releases the lock for the next identity',
      /!session/.test(CONTEXT) && /releaseAllSecurityLocks|releaseSecurityLock/.test(CONTEXT));
    check('6d: forced-update enforcement is untouched by the session-recovery path',
      /UPDATE_REQUIRED/.test(TRANSPORT_CODE) && /emitUpdateRejection/.test(TRANSPORT_CODE));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
