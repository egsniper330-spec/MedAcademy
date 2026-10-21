/**
 * updateConfigService.ts — App Update Enforcement client service.
 *
 * Fetches the platform update configuration from GET /app/version (public,
 * never blocked by the update gate) and exposes the authoritative
 * SUPPORTED / UPDATE_REQUIRED / UNKNOWN decision based on versionCode.
 *
 * ─── Comparison contract ────────────────────────────────────────────────────
 * versionCode (integer, from the Android build) is the AUTHORITATIVE value.
 * Version names are display-only and are NEVER compared.
 *
 * ─── Background-check policy (the check NEVER gates a first render) ─────────
 *  • The check is started at app initialization and NOT awaited by any screen:
 *    the splash / landing / sign-in screens and the authenticated shell all
 *    render immediately. There is no "Checking for updates…" startup page —
 *    that wall (the old fail-closed UNKNOWN state) was the reported defect.
 *  • UNKNOWN (no verdict yet: a check is in flight, or the last attempt failed):
 *    evaluating=true while a request is genuinely in flight, false once an
 *    attempt has finished without an answer. Either way the app stays usable;
 *    `lastCheckFailed` records the failure so it is never reported as
 *    "no update needed".
 *  • UPDATE_REQUIRED (explicit verdict): full-screen block on the protected
 *    shell and on every authentication checkpoint. Never auto-clears — only a
 *    fresh successful evaluation (this build now ≥ minimum) can clear it.
 *  • SUPPORTED (explicit verdict): normal app. A LATER check that cannot
 *    reach the endpoint (network down / endpoint error) PRESERVES the last
 *    explicit verdict — a temporary outage never locks out a user whose
 *    version was already verified supported, and never destroys the session.
 *    The verdict is refreshed on every foreground return; a stale "supported"
 *    is replaced the moment the server says otherwise.
 *
 * ─── One shared, race-safe request ──────────────────────────────────────────
 *  Every trigger (cold start, foreground, reconnect, auth checkpoint, manual
 *  re-check) funnels through `checkAppUpdate()`, which joins the in-flight
 *  promise instead of opening a second request, and a monotonic generation
 *  (`updateSeq`) drops late answers that a newer check or a server 426 has
 *  already superseded. Auth checkpoints call `awaitUpdateCheck()`: join the
 *  shared request for a bounded budget, never a duplicate request, never an
 *  indefinite wait.
 *
 * ─── Server-side 426 handling ───────────────────────────────────────────────
 * Every authenticated API call carries X-App-Platform / X-App-Version-Code
 * (injected here at the single fetch choke point). If the PHP backend answers
 * HTTP 426 UPDATE_REQUIRED (server-side enforcement, bypass-proof), the
 * interceptor immediately flips the authoritative state to UPDATE_REQUIRED
 * and opens the update URL. No client UI survives that transition.
 */

import Constants from 'expo-constants';
import { Platform as RNPlatform, AppState, Linking } from 'react-native';
import { apiFetch } from '@/client/php';
import { backendApiBase } from '@/client/php';
// Authoritative NATIVE installed identity (Android versionCode AND iOS
// CFBundleVersion via Application.nativeBuildVersion — never JS config alone).
import { getInstalledBuildNumber as getNativeBuildNumber, getInstalledVersionName as getNativeVersionName, getAppPlatform } from './appIdentity';
// PURE verdict model (no react-native/expo imports) — the versionCode
// comparison is delegated there so it is unit-testable with plain node.
import {
  evaluateUpdateVerdict,
  evaluateOfflineUpdatePolicy,
  resolveUpdateGateDecision,
  resolveUpdateCheckpoint,
  raceUpdateCheckWithTimeout,
  updateGateBlocks,
  type UpdateGateDecision,
  type UpdateCheckpointPlan,
} from './securityStateModel';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';

// ─── Types ────────────────────────────────────────────────────────────────────

export type UpdateVerdict = 'SUPPORTED' | 'UPDATE_REQUIRED' | 'UNKNOWN';
export type UpdateMode = 'FORCED' | 'OPTIONAL';

export interface RemoteUpdateConfig {
  platform: string;
  enabled: boolean;
  latestVersion?: string;
  latestVersionCode?: number;
  minimumVersionCode?: number;
  updateMode?: UpdateMode;
  updateUrl?: string;
  releaseNotes?: string | null;
}

export interface UpdateState {
  verdict: UpdateVerdict;
  /** True while a version request is on the wire (never a blocking UI state). */
  evaluating: boolean;
  mode: UpdateMode;
  installedVersionName: string;
  installedVersionCode: number;
  latestVersionName: string;
  latestVersionCode: number;
  minimumVersionCode: number;
  updateUrl: string;
  releaseNotes: string | null;
  lastCheckedAt: number | null;
  /** True when the last refresh failed and a previous verdict is being kept. */
  usingCachedVerdict: boolean;
  /**
   * True when the most recent attempt finished WITHOUT an answer (network /
   * timeout / endpoint error). Kept separately from `evaluating` so a finished
   * failure is never mistaken for "still checking" (that was the permanent
   * startup wall) and never reported as "no update needed".
   */
  lastCheckFailed: boolean;
}

// ─── Installed identity (from the native build, not JS config) ────────────────

const INSTALLED_NAME = getNativeVersionName();
const INSTALLED_CODE = getNativeBuildNumber();

export function getInstalledVersionCode(): number {
  return INSTALLED_CODE;
}
export function getInstalledVersionName(): string {
  return INSTALLED_NAME;
}
export function getPlatform(): string {
  return getAppPlatform();
}

// ─── Global 426 interception state ────────────────────────────────────────────

type Listener = (s: UpdateState) => void;
const listeners = new Set<Listener>();
let state: UpdateState = {
  verdict: 'UNKNOWN',
  evaluating: true,
  mode: 'FORCED',
  installedVersionName: INSTALLED_NAME,
  installedVersionCode: INSTALLED_CODE,
  latestVersionName: '',
  latestVersionCode: 0,
  minimumVersionCode: 0,
  updateUrl: '',
  releaseNotes: null,
  lastCheckedAt: null,
  usingCachedVerdict: false,
  lastCheckFailed: false,
};

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => {
    try { l(state); } catch { /* listener errors never break the service */ }
  });
}

export function getUpdateState(): UpdateState {
  return state;
}

export function subscribeUpdateState(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * Called by the apiFetch interceptor when the server rejects a request with
 * HTTP 426 UPDATE_REQUIRED. This is the authoritative server-side verdict —
 * it overrides any locally cached SUPPORTED state instantly.
 *
 * It also INVALIDATES any in-flight version check (see updateSeq): a response
 * that was already on the wire when the server said 426 must never land
 * afterwards and clear the authoritative verdict it already contradicted.
 */
export function markServerUpdateRequired(meta: {
  latestVersion?: string;
  latestVersionCode?: number;
  minimumVersionCode?: number;
  updateUrl?: string;
  updateMode?: string;
}): void {
  updateSeq += 1; // supersede every in-flight check (stale-response guard)
  setState({
    verdict: 'UPDATE_REQUIRED',
    evaluating: false,
    mode: meta.updateMode === 'OPTIONAL' ? 'OPTIONAL' : 'FORCED',
    latestVersionName: meta.latestVersion ?? state.latestVersionName,
    latestVersionCode: meta.latestVersionCode ?? state.latestVersionCode,
    minimumVersionCode: meta.minimumVersionCode ?? state.minimumVersionCode,
    updateUrl: meta.updateUrl ?? state.updateUrl,
    usingCachedVerdict: false,
    lastCheckedAt: Date.now(),
    lastCheckFailed: false,
  });
  clearUpdateRetry();      // a server verdict settles the question
  updateRetryAttempt = 0;
}

/** apiFetch ↔ service wiring (idempotent). */
let interceptorWired = false;
export function wireUpdateInterceptor(): void {
  if (interceptorWired) return;
  interceptorWired = true;
  setUpdateRejectionHandler((meta) => markServerUpdateRequired(meta));
}

// Handler slot implemented in php.ts to avoid an import cycle (php.ts cannot
// import this module at module-eval time because this module imports php.ts).
type RejectionHandler = (meta: Record<string, unknown>) => void;
let rejectionHandler: RejectionHandler | null = null;
export function setUpdateRejectionHandler(h: RejectionHandler | null): void {
  rejectionHandler = h;
}
export function emitUpdateRejection(meta: Record<string, unknown>): void {
  try { rejectionHandler?.(meta); } catch { /* never throw from the interceptor */ }
}

// ─── URL opening ──────────────────────────────────────────────────────────────

/**
 * Opens the remotely configured update destination with the platform's
 * standard external mechanism. The URL is NOT hardcoded anywhere: APK files,
 * Play Store, App Store, or any https page all work — the Super Admin controls
 * the destination without a client rebuild. Invalid/missing URLs surface a
 * visible error state instead of failing silently.
 */
export async function openUpdateUrl(url: string): Promise<{ ok: boolean; error?: string }> {
  const target = (url || state.updateUrl || '').trim();
  if (!target) {
    return { ok: false, error: 'No update URL configured. Contact support.' };
  }
  if (!/^https?:\/\//i.test(target)) {
    return { ok: false, error: 'Configured update URL is invalid. Contact support.' };
  }
  try {
    await Linking.openURL(target);
    return { ok: true };
  } catch {
    return { ok: false, error: 'Could not open the update link. Check your browser and try again.' };
  }
}

// ─── Remote check ─────────────────────────────────────────────────────────────

/**
 * Fetches GET /app/version and re-evaluates. Never throws.
 *
 * Fail policy:
 *  • endpoint unreachable / non-JSON / enabled=false:
 *      - if we already have an explicit verdict (SUPPORTED or
 *        UPDATE_REQUIRED) → KEEP it (usingCachedVerdict=true). No lockout on
 *        transient failures; no staleness for a block.
 *      - if UNKNOWN (no verdict yet) → stay UNKNOWN with evaluating=false and
 *        lastCheckFailed=true; the app keeps working and the bounded retry /
 *        next checkpoint asks again. A failure is NEVER published as SUPPORTED.
 */
/**
 * Monotonic request generation. Every check records the generation it started
 * in and may only publish its result while that generation is still current:
 *   • markServerUpdateRequired() bumps it (an HTTP 426 supersedes a check that
 *     was already in flight — the late "SUPPORTED" answer can no longer clear
 *     an authoritative server verdict);
 *   • a newer check supersedes an older one (out-of-order completions cannot
 *     overwrite fresher state).
 */
let updateSeq = 0;
/**
 * In-flight check shared by every concurrent caller. Multiple triggers fire at
 * the same moment in real life — cold start, app-state 'active', the offline
 * transition hook, a screen unfurling its own re-check — and each used to open
 * its own request. One shared promise means one request, one verdict, one set
 * of listeners notified, and no competing responses to race.
 */
let updateCheckInFlight: Promise<UpdateState> | null = null;

export async function checkAppUpdate(): Promise<UpdateState> {
  if (updateCheckInFlight) return updateCheckInFlight;
  const promise = runUpdateCheck();
  updateCheckInFlight = promise;
  try {
    return await promise;
  } finally {
    // Only the promise that is still the shared one may clear the slot, so a
    // superseded check can never un-deduplicate a newer request.
    if (updateCheckInFlight === promise) updateCheckInFlight = null;
  }
}

/** True while a version request is on the wire (used by diagnostics/tests). */
export function isUpdateCheckInFlight(): boolean {
  return updateCheckInFlight !== null;
}

/**
 * Starts the background check when this session has no verdict yet, joining an
 * existing request instead of opening another. Every authentication surface
 * calls this on mount, so a check is guaranteed to be in flight by the time
 * the user can submit credentials — without any screen awaiting it.
 */
export function ensureUpdateCheck(): void {
  if (updateCheckInFlight) return;
  if (state.verdict !== 'UNKNOWN') return;
  void checkAppUpdate();
}

// ─── Bounded retry after a failed attempt ────────────────────────────────────
// A finished failure leaves verdict=UNKNOWN (never SUPPORTED — an unreachable
// endpoint is not evidence that no update is required). The checkpoints below
// retry it: foreground (initUpdateLifecycle), reconnect (offlineTransition),
// an authentication attempt (awaitUpdateCheck), the manual "Check again"
// button, and this bounded timer chain so a user who never backgrounds the app
// still converges on the server's verdict. Three attempts, then stop — no
// unbounded retry loop, and any explicit verdict cancels the chain.
const UPDATE_RETRY_DELAYS_MS = [20_000, 45_000, 90_000] as const;
let updateRetryAttempt = 0;
let updateRetryTimer: ReturnType<typeof setTimeout> | null = null;

function clearUpdateRetry(): void {
  if (updateRetryTimer !== null) {
    clearTimeout(updateRetryTimer);
    updateRetryTimer = null;
  }
}

function scheduleUpdateRetryAfterFailure(): void {
  if (state.verdict !== 'UNKNOWN') return;
  if (updateRetryAttempt >= UPDATE_RETRY_DELAYS_MS.length) return;
  const delay = UPDATE_RETRY_DELAYS_MS[updateRetryAttempt];
  updateRetryAttempt += 1;
  clearUpdateRetry();
  updateRetryTimer = setTimeout(() => {
    updateRetryTimer = null;
    if (state.verdict === 'UNKNOWN') void checkAppUpdate();
  }, delay);
}

async function runUpdateCheck(): Promise<UpdateState> {
  const mySeq = ++updateSeq;
  // "A check is on the wire" — accurate for the whole request, so an auth
  // checkpoint can tell 'wait' (join it) from 'retry' (nothing running).
  setState({ evaluating: true });
  try {
    // Native platforms send explicit identity headers; on web the headers are
    // omitted (CORS allowlist on the deployed backend does not include them
    // and the server falls back to its non-android default).
    const nativeHeaders: Record<string, string> = RNPlatform.OS === 'web'
      ? {}
      : { 'X-App-Platform': getPlatform(), 'X-App-Version-Code': String(INSTALLED_CODE) };    const res = await apiFetch<RemoteUpdateConfig>('/app/version', {
      method: 'GET',
      headers: nativeHeaders,
    });
    // A superseded check must not publish anything (see updateSeq).
    if (mySeq !== updateSeq) return state;
    if (res.error || !res.data) {
      // 404/405 = the endpoint does not exist on this backend build — an
      // EXPLICIT server answer meaning "update enforcement not deployed".
      // Treat as supported (never enforced) instead of bricking the app;
      // the server-side 426 gate protects the API the moment it ships.
      if (res.error?.status === 404 || res.error?.status === 405) {
        setState({
          verdict: 'SUPPORTED',
          evaluating: false,
          usingCachedVerdict: false,
          lastCheckedAt: Date.now(),
          lastCheckFailed: false,
        });
        clearUpdateRetry();
        updateRetryAttempt = 0;
        return state;
      }
      return recordFailedAttempt();
    }
    applyRemoteConfig(res.data);
    return state;
  } catch {
    if (mySeq !== updateSeq) return state;
    return recordFailedAttempt();
  }
}

/**
 * The single failure path: an attempt finished without an answer.
 *
 * What it deliberately does NOT do:
 *   • it does NOT resolve the verdict (a network failure is not evidence that
 *     the installed build is supported);
 *   • it does NOT leave `evaluating` true (that was the permanent full-screen
 *     "Checking for updates…" wall on an unreachable endpoint).
 * What it does: marks the failure, keeps any previous explicit verdict, and
 * arms the bounded retry chain so the next checkpoint converges on the truth.
 */
function recordFailedAttempt(): UpdateState {
  if (state.verdict === 'UNKNOWN') {
    setState({
      evaluating: false,
      usingCachedVerdict: true,
      lastCheckFailed: true,
      lastCheckedAt: Date.now(),
    });
  } else {
    setState({ usingCachedVerdict: true, lastCheckFailed: true, lastCheckedAt: Date.now() });
  }
  scheduleUpdateRetryAfterFailure();
  return state;
}

/**
 * The single authoritative decision consumed by BOTH gates (root and the
 * authenticated shell): does the surface about to render have to wait for / be
 * replaced by the update state?
 *
 * Pure delegation to securityStateModel.resolveUpdateGateDecision — a
 * NON-protected surface (splash, sign-in, auth screens) is never gated by the
 * version check, and an unresolved ('pending') result never gates ANY surface:
 * the check is a background request. Only a confirmed UPDATE_REQUIRED blocks,
 * and callers must use `updateGateBlocks` / `isUpdateAuthBlocked` — never
 * `decision !== 'none'` — so 'pending' can never turn back into a wall.
 */
export function getUpdateGateDecision(protectedSurface: boolean): UpdateGateDecision {
  return resolveUpdateGateDecision({
    verdict: state.verdict,
    evaluating: state.evaluating,
    protectedSurface,
  });
}

export function isProtectedSurfaceBlocked(protectedSurface: boolean): boolean {
  return updateGateBlocks(getUpdateGateDecision(protectedSurface));
}

/**
 * True when a CONFIRMED mandatory update must prevent authentication.
 * An unresolved check is not a confirmation, so it never blocks a sign-in
 * attempt on its own — the server's 426 rejection still guards the API.
 */
export function isUpdateAuthBlocked(): boolean {
  return state.verdict === 'UPDATE_REQUIRED';
}

/** How long an authentication checkpoint may wait on a shared in-flight check. */
export const UPDATE_CHECKPOINT_TIMEOUT_MS = 4_000;

export interface UpdateCheckpointResult {
  /** What the caller should do with this verdict (see resolveUpdateCheckpoint). */
  plan: UpdateCheckpointPlan;
  state: UpdateState;
  /** True when the bounded wait expired before an answer landed. */
  timedOut: boolean;
}

/**
 * Authentication checkpoint: make sure the version check is running (or join
 * the one already running) and wait for it — for a BOUNDED time only.
 *
 * Contract:
 *   • never opens a duplicate request (checkAppUpdate is single-flight);
 *   • returns immediately with 'block' / 'proceed' when a verdict exists;
 *   • joins an in-flight check for up to `timeoutMs` ('wait');
 *   • starts exactly one fresh check when the previous attempt failed
 *     ('retry') — an auth attempt is an appropriate retry checkpoint;
 *   • on timeout returns the CURRENT plan (never blocks, never throws): the
 *     request keeps running and its result still lands in the shared store, so
 *     a confirmed mandatory update blocks the shell the moment it arrives.
 */
export async function awaitUpdateCheck(
  timeoutMs: number = UPDATE_CHECKPOINT_TIMEOUT_MS
): Promise<UpdateCheckpointResult> {
  const initial = resolveUpdateCheckpoint({ verdict: state.verdict, evaluating: state.evaluating });
  if (initial !== 'wait' && initial !== 'retry') {
    return { plan: initial, state, timedOut: false };
  }
  // 'wait' → join the shared promise. 'retry' → checkAppUpdate starts exactly
  // one request (no other check is running, or it would have been 'wait').
  const pending = checkAppUpdate();
  const raced = await raceUpdateCheckWithTimeout(pending, timeoutMs);
  return {
    plan: resolveUpdateCheckpoint({ verdict: state.verdict, evaluating: state.evaluating }),
    state,
    timedOut: raced.timedOut,
  };
}

/**
 * Applies an explicit server verdict (and persists it for offline use).
 */
function applyRemoteConfig(cfg: RemoteUpdateConfig): void {
  // Feature disabled server-side → not enforced (kill switch).
  if (!cfg.enabled) {
    setState({
      verdict: 'SUPPORTED',
      evaluating: false,
      usingCachedVerdict: false,
      lastCheckedAt: Date.now(),
      lastCheckFailed: false,
      minimumVersionCode: 0,
      updateUrl: '',
      releaseNotes: null,
    });
    clearUpdateRetry();
    updateRetryAttempt = 0;
    void persistCachedUpdatePolicy(null); // explicit server "off" clears the cache
    return;
  }

  const minCode = cfg.minimumVersionCode ?? 0;
  // PURE model comparison (tests/securityStateModel.test.cjs): integer
  // versionCode only, never version-name strings. Semantics unchanged:
  //   enabled=false | no floor | no installed code → SUPPORTED
  //   installed < minimum                          → UPDATE_REQUIRED
  // The updateMode drives the UX (blocking page vs dismissible banner);
  // it does NOT change the verdict.
  //
  // CACHE GUARD: a cached verdict is bound to the installed build that
  // confirmed it. After the user updates, the NEW build must re-evaluate —
  // a stale cached UPDATE_REQUIRED (or SUPPORTED) for a different build is
  // discarded, so the fresh native build resolves via the live check and the
  // full-screen page disappears exactly when the new build is confirmed.
  const cachedForThisBuild =
    cachedPolicyVerdict !== null && cachedPolicyInstalledCode === INSTALLED_CODE;
  const verdict = evaluateUpdateVerdict({
    enabled: true,
    minimumVersionCode: minCode,
    installedVersionCode: INSTALLED_CODE,
  }).verdict;

  setState({
    verdict: verdict === 'UPDATE_REQUIRED' ? 'UPDATE_REQUIRED' : 'SUPPORTED',
    evaluating: false,
    mode: cfg.updateMode === 'OPTIONAL' ? 'OPTIONAL' : 'FORCED',
    latestVersionName: cfg.latestVersion ?? '',
    latestVersionCode: cfg.latestVersionCode ?? 0,
    minimumVersionCode: minCode,
    updateUrl: cfg.updateUrl ?? '',
    releaseNotes: cfg.releaseNotes ?? null,
    usingCachedVerdict: false,
    lastCheckedAt: Date.now(),
    lastCheckFailed: false,
  });
  // A real server answer settles the question → cancel the bounded retry chain.
  clearUpdateRetry();
  updateRetryAttempt = 0;

  // OFFLINE CACHE: persist every explicit server verdict so a later offline
  // cold launch honors the last known policy instead of guessing. Bound to
  // the installed build that confirmed it (see the cache guard above).
  const verdictFinal = verdict === 'UPDATE_REQUIRED' ? 'UPDATE_REQUIRED' : 'SUPPORTED';
  cachedPolicyVerdict = verdictFinal;
  cachedPolicyInstalledCode = INSTALLED_CODE;
  void persistCachedUpdatePolicy({
    verdict: verdictFinal,
    minimumVersionCode: minCode,
    installedVersionCode: INSTALLED_CODE,
    confirmedAt: Date.now(),
  });
}

// ─── Offline update-policy cache (AsyncStorage) ──────────────────────────────
//
// Rules (product spec + evaluateOfflineUpdatePolicy, unit-tested):
//  • offline cold launch + cached SUPPORTED (within max age) → app usable
//    offline (valid offline content); no invented update URL.
//  • offline cold launch + cached UPDATE_REQUIRED (within max age) →
//    UPDATE_REQUIRED per the cached policy (fail-closed, no staleness
//    un-blocking).
//  • offline + no/invalid cache → SUPPORTED with reason 'no_cached_policy'
//    — "network unavailable" is NOT an update requirement. The server-side
//    426 gate remains the authority once any request does go out.
//
// Cache v2: every entry is bound to the installed build that confirmed it
// (installedVersionCode). After the user installs the update, the NEW build
// discards the old cache entry entirely and re-evaluates from the live
// server — the full-screen page disappears exactly when the new build is
// confirmed, never earlier and never through a stale cache path.

let cachedPolicyVerdict: 'SUPPORTED' | 'UPDATE_REQUIRED' | null = null;
let cachedPolicyInstalledCode = 0;

const UPDATE_POLICY_CACHE_KEY = '@medacademy/update_policy_cache_v2';

async function persistCachedUpdatePolicy(entry: {
  verdict: 'SUPPORTED' | 'UPDATE_REQUIRED';
  minimumVersionCode: number;
  installedVersionCode: number;
  confirmedAt: number;
} | null): Promise<void> {
  try {
    if (entry === null) await AsyncStorage.removeItem(UPDATE_POLICY_CACHE_KEY);
    else await AsyncStorage.setItem(UPDATE_POLICY_CACHE_KEY, JSON.stringify(entry));
  } catch { /* storage unavailable → online checks remain authoritative */ }
}

/**
 * Applies the persisted offline policy at cold start BEFORE the first
 * (possibly unreachable) online check. Called once from initUpdateLifecycle.
 * If the cached policy says UPDATE_REQUIRED, the full-screen Update Required
 * page is applied immediately (protected shell + auth checkpoints) — no
 * temporary usable window on a blocked build while offline.
 *
 * NO-CACHE OFFLINE RULE: network unavailability is NOT an update requirement
 * (evaluateOfflineUpdatePolicy → 'no_cached_policy' → SUPPORTED). With no
 * cached policy, this function arms a one-shot NetInfo probe: if the device
 * is actually offline, the unresolved verdict resolves to SUPPORTED so the
 * offline flow (Offline Library) can proceed; if online, the live check
 * decides as usual (and the app renders normally in the meantime — there is
 * no startup wall to hold). The first request that does reach the server
 * re-establishes the authoritative verdict either way (and the global HTTP 426
 * interceptor remains the real boundary).
 */
export async function applyCachedUpdatePolicyOffline(): Promise<void> {
  let probeOffline: (() => void) | null = null;
  try {
    const raw = await AsyncStorage.getItem(UPDATE_POLICY_CACHE_KEY);
    if (!raw) {
      // No cache → arm the offline probe (see doc above). One-shot: removed
      // as soon as it fires or the live check completes.
      probeOffline = armOfflineStartupProbe();
      return;
    }
    const cached = JSON.parse(raw) as {
      verdict?: unknown;
      minimumVersionCode?: unknown;
      installedVersionCode?: unknown;
      confirmedAt?: unknown;
    } | null;
    // The cached verdict is only meaningful for the build that confirmed it.
    // A different installed build (the user updated) must re-evaluate live.
    const cacheValid =
      cached !== null && typeof cached === 'object' &&
      (cached.verdict === 'SUPPORTED' || cached.verdict === 'UPDATE_REQUIRED') &&
      typeof cached.minimumVersionCode === 'number' &&
      typeof cached.installedVersionCode === 'number' &&
      typeof cached.confirmedAt === 'number' &&
      cached.installedVersionCode === INSTALLED_CODE;
    const decision = evaluateOfflineUpdatePolicy(
      cacheValid
        ? { verdict: cached.verdict as 'SUPPORTED' | 'UPDATE_REQUIRED',
            minimumVersionCode: cached.minimumVersionCode as number,
            confirmedAt: cached.confirmedAt as number }
        : null,
      Date.now()
    );
    if (decision.verdict === 'UPDATE_REQUIRED') {
      // Apply ONLY while the live check is still unresolved (evaluating=true);
      // the online check result remains authoritative once it lands.
      if (state.verdict === 'UNKNOWN' && state.evaluating) {
        setState({
          verdict: 'UPDATE_REQUIRED',
          evaluating: false,
          usingCachedVerdict: true,
          minimumVersionCode: decision.minimumVersionCode,
          lastCheckedAt: null,
        });
      }
    } else if (decision.reason === 'cached_supported' && state.verdict === 'UNKNOWN' && state.evaluating) {
      // CACHED SUPPORTED FOR *THIS* BUILD → resolve the pending state now.
      //
      // WHY: the cached entry is an explicit, server-issued verdict for the very
      // build that is installed, written at most CACHED_UPDATE_MAX_AGE_MS ago
      // (14 days) and discarded the moment the installed build changes. It
      // resolves the UNKNOWN state from the offline cache instead of waiting on
      // a network answer that may not come — so a re-check never delays an
      // already-verified build.
      //
      // This does NOT weaken enforcement: the live check still runs immediately
      // afterwards and OVERWRITES this verdict (SUPPORTED or UPDATE_REQUIRED),
      // and the server-side HTTP 426 gate remains the real boundary for every
      // protected call. The enforced direction is untouched — a cached
      // UPDATE_REQUIRED is still honored above, and with no cache at all the
      // verdict simply stays unresolved (never invented) while the app renders
      // and the retries run.
      setState({
        verdict: 'SUPPORTED',
        evaluating: false,
        usingCachedVerdict: true,
        lastCheckedAt: null,
      });
    }
    // No cache at all → the armed offline probe + the live check decide (see
    // armOfflineStartupProbe): no cached policy means we cannot assume either
    // direction.
  } catch { /* unreadable cache → normal online flow */ } finally {
    // A completed live check (or any verdict) retires the probe.
    if (probeOffline && state.verdict !== 'UNKNOWN') probeOffline();
  }
}

/**
 * One-shot NetInfo probe for the no-cache offline cold launch. If the device
 * is offline when it fires AND the live check has not resolved, the verdict
 * resolves to SUPPORTED (documented policy: no cache + no internet ≠
 * UPDATE_REQUIRED; the server 426 gate re-arms the moment any request gets
 * through, and connectivity-restore re-runs the authoritative check).
 */
function armOfflineStartupProbe(): () => void {
  let fired = false;
  const resolveIfOffline = async (): Promise<void> => {
    if (fired || state.verdict !== 'UNKNOWN' || !state.evaluating) return;
    try {
      const st = await NetInfo.fetch();
      if (fired) return;
      if (!st.isConnected) {
        fired = true;
        if (state.verdict === 'UNKNOWN' && state.evaluating) {
          setState({
            verdict: 'SUPPORTED',
            evaluating: false,
            usingCachedVerdict: false,
            lastCheckedAt: null,
          });
        }
        unsubscribe();
      }
    } catch { /* probe failed → leave the verdict unresolved; retries decide */ }
  };
  const unsubscribe = NetInfo.addEventListener(() => { void resolveIfOffline(); });
  void resolveIfOffline();
  // Retire after a generous window: a genuinely offline device resolves on
  // the first fetch; online devices resolve via the live check long before.
  const timer = setTimeout(() => { unsubscribe(); }, 30_000);
  return () => { clearTimeout(timer); unsubscribe(); };
}

// ─── Lifecycle integration (startup + foreground) ─────────────────────────────

let lifecycleWired = false;
/**
 * Wires the update check into the app lifecycle. Called once from the root
 * layout. Startup fires the first BACKGROUND check (never awaited); every
 * foreground return re-checks — matching the security-gate lifecycle so the
 * two gates never create a gap.
 */
export function initUpdateLifecycle(): () => void {
  if (lifecycleWired) return () => {};
  lifecycleWired = true;
  wireUpdateInterceptor();

  // OFFLINE COLD START: apply the persisted policy first so an offline launch
  // with a cached UPDATE_REQUIRED shows the Update Required page immediately
  // (no endless spinner, no temporary usable window), then fire the live
  // check which stays authoritative when the network is available.
  void applyCachedUpdatePolicyOffline();

  // COLD-START CHECK — started, never awaited. The first screen (splash,
  // sign-in, or the restored authenticated shell) renders immediately; the
  // verdict is applied to the shared store the moment it lands.
  void checkAppUpdate();

  const sub = AppState.addEventListener('change', (s) => {
    // Foreground is a checkpoint: refresh the verdict (and retry a failed
    // attempt) without ever unmounting the current screen while it runs.
    if (s === 'active') void checkAppUpdate();
  });
  return () => {
    sub.remove();
    clearUpdateRetry();
    lifecycleWired = false;
  };
}

// Re-export for convenience in screens (base URL shown on error states).
export { backendApiBase as updateApiBase };
