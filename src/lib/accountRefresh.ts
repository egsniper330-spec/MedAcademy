/**
 * accountRefresh.ts — server-authoritative account-state synchronization.
 *
 * THE PROBLEM (device-proven):
 *   • Super Admin changed USER→ADMIN (or ADMIN→USER) on a logged-in device —
 *     nothing re-fetched the profile, so the app kept the old role until
 *     restart+re-login. Role changes do NOT bump profiles.security_version,
 *     so the existing checkRevocation pipeline (which only detects
 *     revocation-class changes) never noticed.
 *   • Super Admin blocked the account → the NEXT cold start hung forever on a
 *     spinner: AuthMiddleware rejects every authenticated call from a
 *     suspended/blocked account with HTTP 403 code 'account_suspended', so
 *     getProfile() threw; (app)/_layout.tsx swallowed it as "non-fatal" with
 *     profile=null and the role-redirect guard blocked on `!profile` → the
 *     (app)/index spinner never resolved. The dedicated
 *     (app)/account-suspended screen existed but NOTHING ever routed to it.
 *
 * THE FIX (single authoritative refresh, race-guarded, lifecycle-triggered):
 *   refreshAccountState() is the ONE place that fetches the profile row and
 *   publishes it. It is wired at the app root to four triggers:
 *     1. cold start (after session restoration, when ONLINE)
 *     2. foreground return (when ONLINE)
 *     3. OFFLINE → ONLINE transition (via offlineTransition.onConnectivityRestored)
 *     4. explicit calls (post-login, admin actions, profile screens)
 *   Outcomes are classified by the PURE machine
 *   (startupStateModel.classifyProfileRefresh) and handled as follows:
 *     applied         → profile store replaced (role/status propagate through
 *                       every consumer of useProfileStore)
 *     blocked         → the session is PRESERVED and the existing
 *                       (app)/account-suspended screen is shown (its Logout
 *                       performs the real sign-out). A blocked verdict is a
 *                       server fact, not an auth error.
 *     offline_skipped → no request, no state change (offline session intact)
 *     network_error   → no state change (network failure ≠ logout ≠ block)
 *     auth_error      → the existing php.ts definitive-revocation policy owns
 *                       the session; we only surface a diagnostic
 *     error           → no state change (non-fatal)
 *
 * RACE GUARDS:
 *   • Single-flight: concurrent triggers share one in-flight refresh.
 *   • Generation counter: a refresh started for user X cannot publish after a
 *     newer refresh (or an account switch) — only the newest attempt writes.
 *   • Stale-session guard: the fetch targets a specific userId; a response for
 *     a session that has since changed is discarded.
 *
 * OFFLINE GUARANTEE (must not regress): when NetInfo says offline the refresh
 * is skipped BEFORE any request — offline mode keeps its cached profile and
 * downloads; inability to reach the server is never treated as a block or a
 * logout. When connectivity returns, trigger 3 fires the authoritative refresh.
 */

import { NetInfoState, fetch as netFetch } from '@react-native-community/netinfo';
import { apiFetch } from '@/client/php';
import { useProfileStore } from '@/lib/store';
import { invalidateCreditCache } from '@/lib/creditService';
import { classifyProfileRefresh, type ProfileRefreshOutcome } from '@/lib/startupStateModel';
import { onConnectivityRestored } from '@/lib/offlineTransition';
import { AppState } from 'react-native';

// The profile row shape is owned by api.ts's PROFILE_SELECT; this service only
// needs the fields it acts on. Structural typing keeps the coupling minimal.
interface ProfileRow {
  id: string;
  role?: string;
  status?: string;
  [key: string]: unknown;
}

let inflight: Promise<ProfileRefreshOutcome> | null = null;
let generation = 0;

/**
 * Fetch the authoritative profile row for `userId` and publish it.
 *
 * Data path: GET /api/profiles?select=<full>&id=<userId>&limit=1 — the same
 * endpoint/shape api.ts getProfile() reads (DataController::select, owner-
 * scoped: a non-admin token can only ever see its own row; a tampered userId
 * simply yields zero rows → 'auth_error'-adjacent 'error' outcome, never a
 * publish). Single-flight + generation-guarded.
 */
export async function refreshAccountState(
  userId: string,
  opts: { reason?: string } = {}
): Promise<ProfileRefreshOutcome> {
  if (!userId) return 'error';

  // Single-flight: a second trigger during an in-flight refresh joins it
  // instead of racing it (prevents duplicate requests AND the A-finishes-last
  // overwrite — the joiner receives the freshest outcome).
  if (inflight) return inflight;

  const myGeneration = ++generation;
  inflight = (async (): Promise<ProfileRefreshOutcome> => {
    // ── Connectivity gate — BEFORE any request ─────────────────────────────
    // Offline: skip entirely. No request can fail, so no outcome can ever be
    // derived from network absence. The cached profile stays authoritative
    // locally until a later online refresh.
    let state: NetInfoState | null = null;
    try {
      state = await netFetch();
    } catch {
      state = null;
    }
    const online = !!state?.isConnected && state.isInternetReachable !== false;
    if (state == null || !online) {
      return 'offline_skipped';
    }

    try {
      const select = [
        'id', 'role', 'status',
      ].join(',');
      const { data, error } = await apiFetch<ProfileRow[]>(
        `/api/profiles?select=${encodeURIComponent(select)}&id=${encodeURIComponent(userId)}&limit=1`
      );
      if (error) {
        const outcome = classifyProfileRefresh(true, error);
        // 401/403-plain are delegated: php.ts's auto-refresh already retried;
        // ctx's checkRevocation owns definitive revocation. No state change here.
        return outcome;
      }
      const row = Array.isArray(data) ? data[0] : (data as unknown as ProfileRow | null);
      // Generation + identity guard: only the newest refresh for the CURRENT
      // session user may publish. A stale/foreign response is discarded.
      if (myGeneration !== generation) return 'error';
      if (!row || row.id !== userId) return 'error';
      publishProfile(row as Record<string, unknown>);
      return 'applied';
    } catch {
      // apiFetch resolves (never throws) for HTTP errors; reaching here means
      // an unexpected JS error — non-fatal, state preserved.
      return classifyProfileRefresh(true, { status: undefined });
    }
  })().finally(() => {
    if (inflight) {
      inflight = null;
    }
  });

  return inflight;
}

/**
 * Publish a fetched profile row into the profile store — the single write
 * point for server-authoritative account state. Role/status changes flow to
 * every consumer through zustand's subscriber update; per-account caches are
 * invalidated when the role actually changed so role-scoped caching cannot
 * serve stale data.
 */
function publishProfile(row: Record<string, unknown>): void {
  const store = useProfileStore.getState();
  const prev = store.profile;
  const roleChanged = !!prev && !!row.role && prev.role !== row.role;
  const statusChanged = !!prev && !!row.status && prev.status !== row.status;
  if (roleChanged) {
    // Role-scoped caches must never survive a role change.
    invalidateCreditCache();
  }
  // Merge with the previous profile so this minimal select never erases
  // fields other screens loaded (avatar, university, etc.). Server fields
  // always win — that is the authority contract.
  store.setProfile({ ...(prev ?? {}), ...row } as typeof prev);
  if (__DEV__ && (roleChanged || statusChanged)) {
    console.log(
      `[accountRefresh] server authority applied: role ${prev?.role ?? '?'} → ${String(row.role)}` +
      (statusChanged ? `, status ${prev?.status ?? '?'} → ${String(row.status)}` : '')
    );
  }
}

/**
 * Handle a completed refresh outcome that requires navigation.
 * Called by the lifecycle wiring (and by (app)/_layout for its own trigger).
 */
export async function handleRefreshOutcome(
  outcome: ProfileRefreshOutcome,
  opts: { userId: string; reason?: string }
): Promise<void> {
  if (outcome !== 'blocked') return;
  // BLOCKED — server-authoritative. Preserve the session and show the
  // existing account-suspended screen (its Logout clears the session; a
  // BLOCKED→ACTIVE unblock then simply refreshes back to normal).
  // router is imported lazily to keep this module import-safe at provider
  // construction time (expo-router hoisting).
  const { router } = await import('expo-router');
  try {
    router.replace('/account-suspended');
  } catch (e) {
    if (__DEV__) console.warn('[accountRefresh] navigate to account-suspended failed:', e);
  }
}

// ── Lifecycle wiring (called ONCE from the root layout) ──────────────────────

let wired = false;

/**
 * Wire the four lifecycle triggers. Cold-start refresh is invoked explicitly
 * by SessionProvider after session restoration (with the restored userId);
 * this function wires foreground + connectivity-restored triggers.
 */
export function initAccountRefreshLifecycle(): () => void {
  if (wired) return () => {};
  wired = true;

  const currentUserId = (): string | null => {
    const p = useProfileStore.getState().profile;
    return p?.id ?? null;
  };

  // Trigger 2: foreground return (ONLINE devices get an authoritative refresh;
  // offline devices short-circuit inside refreshAccountState).
  const appSub = AppState.addEventListener('change', (s) => {
    if (s !== 'active') return;
    const uid = currentUserId();
    if (!uid) return;
    void refreshAccountState(uid, { reason: 'foreground' }).then((outcome) => {
      void handleRefreshOutcome(outcome, { userId: uid });
    });
  });

  // Trigger 3: OFFLINE → ONLINE transition → authoritative refresh.
  const offConnectivity = onConnectivityRestored(() => {
    const uid = currentUserId();
    if (!uid) return;
    void refreshAccountState(uid, { reason: 'connectivity_restored' }).then((outcome) => {
      void handleRefreshOutcome(outcome, { userId: uid });
    });
  });

  return () => {
    appSub.remove();
    offConnectivity();
    wired = false;
  };
}
