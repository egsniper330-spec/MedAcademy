/**
 * startupStateModel.ts — PURE cold-start routing state machine.
 *
 * ⚠️ NO IMPORTS (mirrors securityStateModel.ts). This module must stay
 * dependency-free (no react-native, no expo, no network, no storage) so it
 * compiles standalone and is unit-tested with plain node
 * (tests/securityStateModel.test.cjs). Runtime consumer: src/app/index.tsx.
 *
 * ─── THE BUG THIS MODEL FIXES ────────────────────────────────────────────────
 * Cold start with the internet OFF used to route a fully-authenticated user to
 * LOGIN. Root cause (traced, not guessed):
 *
 *   1. SessionProvider resolves `session` LOCALLY (SecureStore hydration via
 *      backendClient.auth.getSession() — no API call). Auth hydration itself
 *      is offline-safe.
 *   2. But the OLD landing screen treated connectivity as part of the SAME
 *      decision that gates redirecting: while `isOffline` was still `null`
 *      (NetInfo has not produced its first concrete state), the route effect
 *      could fall through to the unauthenticated landing UI, and any startup
 *      re-evaluation that saw `session===null` DURING hydration sent the user
 *      to /login before the offline branch could resolve. Network absence was
 *      effectively collapsed into "no session".
 *
 * ─── THE CONTRACT ────────────────────────────────────────────────────────────
 * Distinct states are NEVER collapsed:
 *
 *   AUTHENTICATED LOCALLY + ONLINE            → online shell
 *   AUTHENTICATED LOCALLY + OFFLINE           → Offline Mode (offline library)
 *   AUTHENTICATED LOCALLY + CONNECTIVITY UNKNOWN → HOLD (spinner) — never
 *                                               login, never a fake offline
 *   NO PERSISTED SESSION (any connectivity)   → login
 *   EXPLICIT LOGOUT (persisted session gone)  → login
 *   GENUINE SECURITY VIOLATION                → SecurityGate (separate layer,
 *                                               NOT this router's decision)
 *
 * A network failure / unreachable security endpoint is NOT an auth event and
 * can never produce the LOGIN route from this machine. Revocation still works
 * because the ONLY input that reaches login with a previous session is
 * `hasLocalSession=false` — and that flag flips exclusively through the real
 * auth pipeline (signOut()/clearSession()/SIGNED_OUT), never through a
 * network error path.
 *
 * SESSION EXPIRATION: honored per the existing architecture — the persisted
 * compact session carries the refresh token and `auth.getSession()` returns
 * it verbatim; there is no locally verifiable "revoked" state, so this model
 * deliberately does NOT invent one. Server-side validation continues to gate
 * every API call (401 → definitive refresh failure → clearSession → this
 * machine routes to login on the NEXT evaluation). Offline, nothing pretends
 * the account was revoked.
 *
 * RACE SAFETY: the machine is a total function of its inputs. Order and
 * timing of input updates cannot produce a wrong final state:
 *   • hydration AFTER connectivity → inputs settle, final state correct.
 *   • connectivity flip DURING hydration → HOLD, then the settled state.
 *   • logout DURING the offline branch → hasLocalSession=false → login on
 *     the next evaluation (no cached "offline = authenticated" shortcut).
 */

// ─── Pure input shape (structurally compatible with runtime values) ──────────

export interface StartupInputs {
  /**
   * Has SessionProvider finished hydrating the persisted session?
   * (ctx `isLoading === false`.)
   */
  authHydrated: boolean;
  /**
   * A locally persisted authenticated session exists (restored or fresh).
   * Flips to false ONLY through the real auth pipeline (explicit logout,
   * confirmed revocation clearing the store) — never through a network error.
   */
  hasLocalSession: boolean;
  /**
   * Connectivity tri-state exactly as the rest of the app defines it
   * (offlineTransition.useConnectivity): true = online, false = offline,
   * null = not yet determined (NetInfo module boot).
   */
  connectivity: boolean | null;
}

/**
 * The deterministic route the landing screen resolves to.
 *
 *  'spinner'    → keep waiting (auth not hydrated, or connectivity unknown
 *                 while a session exists — NEVER a route decision on unknowns)
 *  'login'      → unauthenticated landing (Sign In / Create Account)
 *  'online'     → authenticated online shell ((app) role-neutral entry)
 *  'offline'    → authenticated Offline Mode (Offline Library)
 */
export type StartupRoute = 'spinner' | 'login' | 'online' | 'offline';

/**
 * The authoritative cold-start routing decision.
 *
 * Deterministic: the same inputs always produce the same route. Unknowns
 * HOLD — an undetermined connectivity value can never push a session-holding
 * user to login, and a not-yet-hydrated session can never look unauthenticated.
 */
export function resolveStartupRoute(input: StartupInputs): StartupRoute {
  const { authHydrated, hasLocalSession, connectivity } = input;

  // 1. Auth not hydrated yet → nothing is known. Spinner, never login.
  //    (Route guards run BEFORE hydration was the old failure mode.)
  if (!authHydrated) return 'spinner';

  // 2. Hydrated + no persisted session → genuinely unauthenticated (or an
  //    explicit logout / confirmed revocation cleared the store). Login is
  //    correct here REGARDLESS of connectivity — offline never fabricates a
  //    session, and online cannot invent one either.
  if (!hasLocalSession) return 'login';

  // 3. Session exists. A network failure can never revoke it — the session
  //    flag alone gates authentication. Route purely by connectivity:
  if (connectivity === false) return 'offline';  // direct Offline Mode
  if (connectivity === true) return 'online';    // normal online startup
  // 4. Connectivity undetermined (NetInfo boot) → HOLD. Not login (that was
  //    the bug), not a guessed offline — an unknown is not evidence.
  return 'spinner';
}

// ─── Offline-policy gate (cached offline policy validity) ────────────────────

/**
 * Shape of the cached offline-eligibility policy persisted by the app
 * (mirrors the persisted update-policy cache contract: an explicit server
 * verdict + a confirmation timestamp; garbage parses to null upstream).
 */
export interface CachedOfflinePolicy {
  verdict: 'allowed' | 'denied';
  confirmedAt: number;
}

/** Cache entries older than this are treated as missing (no infinite trust). */
export const CACHED_OFFLINE_POLICY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export type OfflinePolicyDecision =
  | { usable: true; reason: 'cached_allowed' }
  | { usable: true; reason: 'no_cached_policy' }      // absence ≠ denial
  | { usable: false; reason: 'cached_denied' | 'stale_or_invalid' };

/**
 * Pure decision: may THIS device enter Offline Mode given the cached policy?
 *
 * The ONLY denying evidence is an explicit, fresh `verdict:'denied'` from the
 * server. A missing, stale, or corrupt cache is NOT denial — inventing a
 * denial from an absence would be the same class of bug as inventing a
 * logout from a network failure. (The SecurityGate remains an independent,
 * always-on layer: this policy gate never overrides a genuine violation.)
 */
export function evaluateOfflinePolicy(
  cached: CachedOfflinePolicy | null,
  nowMs: number,
  maxAgeMs: number = CACHED_OFFLINE_POLICY_MAX_AGE_MS
): OfflinePolicyDecision {
  if (!cached || typeof cached !== 'object') {
    return { usable: true, reason: 'no_cached_policy' };
  }
  if (
    (cached.verdict !== 'allowed' && cached.verdict !== 'denied') ||
    !Number.isFinite(cached.confirmedAt) ||
    cached.confirmedAt <= 0 ||
    cached.confirmedAt > nowMs + 60_000
  ) {
    return { usable: true, reason: 'no_cached_policy' }; // garbage ≡ absent
  }
  if (cached.verdict === 'denied') {
    // A fresh explicit denial is honored; a STALE denial expires like any
    // other cache entry (staleness never re-arms a block by itself — the
    // live server verdict remains authoritative when reachable).
    if (nowMs - cached.confirmedAt <= maxAgeMs) {
      return { usable: false, reason: 'cached_denied' };
    }
    return { usable: true, reason: 'no_cached_policy' };
  }
  if (nowMs - cached.confirmedAt > maxAgeMs) {
    return { usable: true, reason: 'no_cached_policy' };
  }
  return { usable: true, reason: 'cached_allowed' };
}

// ─── Account-isolation ownership check (offline library) ─────────────────────

/**
 * Owner identity carried by every persisted offline-download metadata row
 * (mirrors OfflineVideoMeta.userId in offlineVideoService.ts).
 */
export interface OwnedOfflineRow {
  meta: { userId: string };
}

/**
 * Pure filter: which persisted rows may THIS session see?
 *
 * Offline Mode must NEVER expose Account A's downloads to Account B. Rows are
 * shown only when their owner binding equals the CURRENT session's user id —
 * a malformed row (missing meta/userId) can never match and is dropped. The
 * runtime store applies the same rule at hydration and on every account
 * switch (resetOfflineLibraryForAccountSwitch), so both a cold start after an
 * account switch and a hot switch converge to an empty library for the wrong
 * account.
 */
export function filterOwnedRows<T extends OwnedOfflineRow>(
  rows: T[],
  sessionUserId: string | null | undefined
): T[] {
  if (!sessionUserId) return [];
  return rows.filter((r) => r?.meta && r.meta.userId === sessionUserId);
}

// ─── Hydration truncation rule (the offline→login bug, machine-level) ────────

/**
 * Pure rule: may an auth-hydration read be TRUNCATED by a timeout?
 *
 * NO — a hydration read that has not completed is an UNKNOWN, not a negative.
 * Truncating it to `session = null` (with `isLoading = false`) converted a
 * slow LOCAL storage read into a fake unauthenticated state on offline cold
 * starts — the root cause of "internet OFF → login screen". The machine
 * rejects every truncation: callers must await the real read (the only
 * bounded exception is a hung native bridge, which the runtime handles by
 * surfacing genuine 'no readable session' — see startupStateModel.ts docs).
 */
export function mayTruncateHydration(readCompleted: boolean): boolean {
  return readCompleted;
}

// ─── Server-authoritative account-state refresh (role/status sync) ───────────

/**
 * Outcome of one server-authoritative profile refresh (runtime module:
 * accountRefresh.ts). The classifier below is the PURE decision core; the
 * runtime module supplies triggers (cold start, foreground, reconnect) and
 * the generation guard.
 *
 * Terminal-state guarantee: every refresh resolves to exactly one outcome —
 * a refresh can NEVER end in "nothing happened" (the infinite-spinner class
 * of bug). The UI reacts to each outcome deterministically:
 *   applied        → profile store replaced with the server row (role/status)
 *   blocked        → server authoritatively says suspended/blocked → the
 *                    existing account-suspended screen (session kept so the
 *                    screen can render; its own Logout clears the session)
 *   offline_skipped→ no connectivity → NO request, NO state change (offline
 *                    session preserved; never treated as blocked or logout)
 *   network_error  → transport failure / 5xx / timeout → session + profile
 *                    PRESERVED (a network failure is not a logout, not a block)
 *   auth_error     → 401 after the existing auto-refresh pipeline → the
 *                    existing definitive-revocation policy decides
 *   error          → unexpected (4xx other) → non-fatal, state preserved
 */
export type ProfileRefreshOutcome =
  | 'applied'
  | 'blocked'
  | 'offline_skipped'
  | 'network_error'
  | 'auth_error'
  | 'maintenance'
  | 'error';

/** Structural error shape thrown by the API layer ({ message, code?, status? }). */
export interface ProfileFetchErrorShape {
  status?: number;
  code?: string;
  message?: string;
}

/**
 * Pure classification of one profile fetch against server authority.
 *
 * THE BACKEND CONTRACT (AuthMiddleware): a suspended/blocked account receives
 * HTTP 403 with code 'account_suspended' on every authenticated call — this
 * is the server's blocked verdict; the client recognizes it verbatim and
 * NEVER synthesizes a block from anything else. A network failure carries no
 * HTTP status and must never be conflated with 401/403/5xx.
 */
export function classifyProfileRefresh(
  isConnected: boolean | null,
  err: ProfileFetchErrorShape | null
): ProfileRefreshOutcome {
  // Connectivity decides FIRST: when the device is offline (or its state is
  // unknown) the runtime never issues the request, so "no error object"
  // cannot mean "applied" — the only correct outcome is offline_skipped.
  // (The test suite caught this exact ordering bug: err=null + offline
  // previously fell through to 'applied'.)
  if (isConnected !== true) return 'offline_skipped';
  if (err === null) return 'applied';
  const status = err.status;
  const code = err.code ?? '';
  const msg = err.message ?? '';
  // MAINTENANCE (503 maintenance_mode): a server fact about the PLATFORM, not
  // about this account. It must not classify as network_error (which screens
  // may render as a plain fetch failure) — the MaintenanceGate owns the UI.
  // The maintenanceService interceptor already flipped the global state from
  // the same response; here we just avoid mis-classification.
  if (status === 503 && (code === 'maintenance_mode' || /maintenance/i.test(msg))) {
    return 'maintenance';
  }
  // Genuine blocked verdict ONLY: the server's explicit code (or its exact
  // message when a proxy strips the code). Anything else that merely smells
  // like failure stays non-blocking.
  if (status === 403 && (code === 'account_suspended' || /suspended|blocked/i.test(msg))) {
    return 'blocked';
  }
  if (status == null) return 'network_error'; // transport: timeout/DNS/refused
  if (status >= 500) return 'network_error';  // temporary server error (non-maintenance)
  if (status === 401) return 'auth_error';    // existing refresh/revocation policy
  return 'error';
}

// ─── Auth-failure classification (network failure ≠ logout) ──────────────────

/**
 * Classification of an auth-session verification outcome. The runtime auth
 * layer (php.ts refresh path + ctx.tsx checkRevocation) maps its results onto
 * these; the machine's rule is total:
 *
 *   'authenticated'      → session stays
 *   'network_unreachable' / 'timeout' / 'server_error' / 'inconclusive'
 *                        → session STAYS (a network failure is not a logout)
 *   'revoked'            → the ONLY classification that ends the session
 *                          (definitive 401/400/422/403 refresh failure or an
 *                          explicit server verdict — never a transport error)
 */
export type SessionVerification =
  | 'authenticated'
  | 'network_unreachable'
  | 'timeout'
  | 'server_error'
  | 'inconclusive'
  | 'revoked';

/**
 * Pure rule: does this verification outcome terminate the persisted session?
 * Exactly one classification does. Everything else preserves the session —
 * including timeouts and unreachable servers.
 */
export function sessionTerminates(v: SessionVerification): boolean {
  return v === 'revoked';
}

// ─── Startup-race regression matrix (machine-level, mirrors the test file) ──

/**
 * Convenience projector used by tests to assert the 15-item startup matrix in
 * one place. Each case is a (inputs, expectedRoute) pair; the test file feeds
 * them through resolveStartupRoute. Kept here so the matrix documents itself
 * next to the machine.
 */
export const STARTUP_MATRIX: ReadonlyArray<{
  name: string;
  inputs: StartupInputs;
  expected: StartupRoute;
}> = [
  { name: '1. ONLINE + persisted valid session → Online Mode',
    inputs: { authHydrated: true, hasLocalSession: true, connectivity: true }, expected: 'online' },
  { name: '2. OFFLINE + persisted valid session → authenticated Offline Mode',
    inputs: { authHydrated: true, hasLocalSession: true, connectivity: false }, expected: 'offline' },
  { name: '3. OFFLINE + no persisted session → Login',
    inputs: { authHydrated: true, hasLocalSession: false, connectivity: false }, expected: 'login' },
  { name: '4. OFFLINE + network/API failure with persisted session → Offline Mode (never logout)',
    inputs: { authHydrated: true, hasLocalSession: true, connectivity: false }, expected: 'offline' },
  { name: '5. ONLINE + no session → Login',
    inputs: { authHydrated: true, hasLocalSession: false, connectivity: true }, expected: 'login' },
  { name: '6. Explicit logout (session cleared, online) → Login',
    inputs: { authHydrated: true, hasLocalSession: false, connectivity: true }, expected: 'login' },
  { name: '7. Genuine security violation offline → gate layer handles it (router still routes offline; gate overlays)',
    inputs: { authHydrated: true, hasLocalSession: true, connectivity: false }, expected: 'offline' },
  { name: '8. Valid offline session + cached policy → Offline Mode with no API wait',
    inputs: { authHydrated: true, hasLocalSession: true, connectivity: false }, expected: 'offline' },
  { name: '11. Hydration completes AFTER connectivity known → still correct',
    inputs: { authHydrated: true, hasLocalSession: true, connectivity: false }, expected: 'offline' },
  { name: '12. Connectivity flips DURING hydration → HOLD, never login',
    inputs: { authHydrated: true, hasLocalSession: true, connectivity: null }, expected: 'spinner' },
  { name: '13. Network timeout does not mutate authenticated state (session persists)',
    inputs: { authHydrated: true, hasLocalSession: true, connectivity: false }, expected: 'offline' },
  { name: '14. Security-check timeout does not mutate authenticated state',
    inputs: { authHydrated: true, hasLocalSession: true, connectivity: false }, expected: 'offline' },
];
