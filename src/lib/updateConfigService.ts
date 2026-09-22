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
 * ─── Fail-closed / fail-open policy (documented, matches the security gate) ─
 *  • UNKNOWN (no successful check yet, e.g. cold start with endpoint down):
 *    evaluating=true → the root ForceUpdateGate renders a blocking
 *    "Checking for updates…" wall. Protected content is NOT granted until a
 *    check completes. This is the fail-closed startup state.
 *  • UPDATE_REQUIRED (explicit verdict): hard block (FORCED) or dismissible
 *    banner (OPTIONAL) until a fresh check clears it. Never auto-clears.
 *  • SUPPORTED (explicit verdict): normal app. A LATER check that cannot
 *    reach the endpoint (network down / endpoint error) PRESERVES the last
 *    explicit verdict — a temporary outage never locks out a user whose
 *    version was already verified supported, and never destroys the session.
 *    The verdict is refreshed on every foreground return; a stale "supported"
 *    is replaced the moment the server says otherwise.
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
// PURE verdict model (no react-native/expo imports) — the versionCode
// comparison is delegated there so it is unit-testable with plain node.
import { evaluateUpdateVerdict, evaluateOfflineUpdatePolicy } from './securityStateModel';
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
  /** True during the very first check (fail-closed startup wall). */
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
}

// ─── Installed identity (from the native build, not JS config) ────────────────

const INSTALLED_NAME = (Constants.expoConfig?.version ?? '1.0.0').trim();
const INSTALLED_CODE =
  RNPlatform.OS === 'android'
    ? (Constants.expoConfig?.android?.versionCode ?? 0)
    : 0;

export function getInstalledVersionCode(): number {
  return INSTALLED_CODE;
}
export function getInstalledVersionName(): string {
  return INSTALLED_NAME;
}
export function getPlatform(): string {
  return RNPlatform.OS === 'android' ? 'android' : 'ios';
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
 */
export function markServerUpdateRequired(meta: {
  latestVersion?: string;
  latestVersionCode?: number;
  minimumVersionCode?: number;
  updateUrl?: string;
  updateMode?: string;
}): void {
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
  });
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
 *      - if UNKNOWN (first check of the process) → stay UNKNOWN; the gate
 *        keeps the fail-closed startup wall until a check succeeds.
 */
export async function checkAppUpdate(): Promise<UpdateState> {
  try {
    // Native platforms send explicit identity headers; on web the headers are
    // omitted (CORS allowlist on the deployed backend does not include them
    // and the server falls back to its non-android default).
    const nativeHeaders: Record<string, string> = RNPlatform.OS === 'web'
      ? {}
      : { 'X-App-Platform': getPlatform(), 'X-App-Version-Code': String(INSTALLED_CODE) };
    const res = await apiFetch<RemoteUpdateConfig>('/app/version', {
      method: 'GET',
      headers: nativeHeaders,
    });
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
        });
        return state;
      }
      // Transient failure — keep any explicit verdict (see policy above).
      if (state.verdict === 'UNKNOWN') {
        setState({ evaluating: true, usingCachedVerdict: true });
      } else {
        setState({ usingCachedVerdict: true, lastCheckedAt: Date.now() });
      }
      return state;
    }
    applyRemoteConfig(res.data);
    return state;
  } catch {
    if (state.verdict === 'UNKNOWN') {
      setState({ evaluating: true, usingCachedVerdict: true });
    } else {
      setState({ usingCachedVerdict: true, lastCheckedAt: Date.now() });
    }
    return state;
  }
}

/** Applies an explicit server verdict (and persists it for offline use). */
function applyRemoteConfig(cfg: RemoteUpdateConfig): void {
  // Feature disabled server-side → not enforced (kill switch).
  if (!cfg.enabled) {
    setState({
      verdict: 'SUPPORTED',
      evaluating: false,
      usingCachedVerdict: false,
      lastCheckedAt: Date.now(),
      minimumVersionCode: 0,
      updateUrl: '',
      releaseNotes: null,
    });
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
  });

  // OFFLINE CACHE: persist every explicit server verdict so a later offline
  // cold launch honors the last known policy instead of guessing.
  void persistCachedUpdatePolicy({
    verdict: verdict === 'UPDATE_REQUIRED' ? 'UPDATE_REQUIRED' : 'SUPPORTED',
    minimumVersionCode: minCode,
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

const UPDATE_POLICY_CACHE_KEY = '@medacademy/update_policy_cache_v1';

async function persistCachedUpdatePolicy(entry: {
  verdict: 'SUPPORTED' | 'UPDATE_REQUIRED';
  minimumVersionCode: number;
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
 * If the cached policy says UPDATE_REQUIRED, the fail-closed startup wall
 * becomes the cached Update Required page immediately — no temporary usable
 * window and no endless spinner while offline.
 *
 * NO-CACHE OFFLINE RULE: network unavailability is NOT an update requirement
 * (evaluateOfflineUpdatePolicy → 'no_cached_policy' → SUPPORTED). With no
 * cached policy, this function arms a one-shot NetInfo probe: if the device
 * is actually offline, the fail-closed startup wall resolves to SUPPORTED so
 * the offline flow (Offline Library) can proceed; if online, the wall stays
 * up until the live check lands. The first request that does reach the
 * server re-establishes the authoritative verdict either way (and the global
 * HTTP 426 interceptor remains the real boundary).
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
      confirmedAt?: unknown;
    } | null;
    const decision = evaluateOfflineUpdatePolicy(
      cached && typeof cached === 'object' &&
        (cached.verdict === 'SUPPORTED' || cached.verdict === 'UPDATE_REQUIRED') &&
        typeof cached.minimumVersionCode === 'number' &&
        typeof cached.confirmedAt === 'number'
        ? { verdict: cached.verdict, minimumVersionCode: cached.minimumVersionCode, confirmedAt: cached.confirmedAt }
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
    }
    // cached SUPPORTED → nothing to do: the online check will confirm; while
    // unreachable, the existing in-memory fail policy keeps the app usable
    // and the server 426 gate stays the boundary.
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
    } catch { /* probe failed → leave the fail-closed wall up */ }
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
 * layout. Startup fires the first (fail-closed) check; every foreground
 * return re-checks — matching the security-gate lifecycle so the two gates
 * never create a gap.
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

  void checkAppUpdate(); // cold-start check (fail-closed until it lands)

  const sub = AppState.addEventListener('change', (s) => {
    if (s === 'active') void checkAppUpdate();
  });
  return () => {
    sub.remove();
    lifecycleWired = false;
  };
}

// Re-export for convenience in screens (base URL shown on error states).
export { backendApiBase as updateApiBase };
