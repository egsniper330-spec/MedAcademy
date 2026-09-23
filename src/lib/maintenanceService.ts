/**
 * MAINTENANCE MODE runtime service — the client's authoritative maintenance
 * state, fed by two server signals ONLY:
 *
 *   1. HTTP 503 maintenance_mode on any API call (the php.ts interceptor calls
 *      notifyMaintenance503) — the server reached the device and refused it.
 *   2. GET /maintenance (public, exempt from the gate) — polled while the
 *      maintenance screen is up so recovery is automatic when maintenance ends.
 *
 * Deliberately SEPARATE from OFFLINE (NetInfo owns that) and from AUTH states
 * (php.ts refresh policy owns those). This service never logs the user out,
 * never clears the session, and never fabricates a maintenance state from a
 * network failure — only the server's explicit verdict counts.
 *
 * The React root renders <MaintenanceGate> (app/_layout.tsx) which subscribes
 * via subscribeMaintenance().
 *
 * ─── CANARY (expected-control-flow suppression) ──────────────────────────────
 * While the verdict is MAINTENANCE, any API error that classifies as
 * maintenance (isMaintenanceError) is EXPECTED: getProfile, RPC probes,
 * revocation polls, analytics — they all legitimately receive 503
 * maintenance_mode while the screen is up. Suppressing them here (a module
 * boolean the call sites consult through isExpectedMaintenanceError) prevents
 * red console noise, toast banners, and request-storm retries WITHOUT hiding
 * genuine errors: a 503 without the maintenance code, a 403 account_suspended,
 * a 401 revocation, a timeout — none classify as maintenance and none are
 * suppressed.
 *
 * ─── SA EXEMPTION EVIDENCE ───────────────────────────────────────────────────
 * A Super Admin (or whitelisted user) who was ALREADY using the app when
 * maintenance was switched on must keep using it — the server exempts their
 * requests, so nothing breaks. But the client would still flip the whole UI to
 * the maintenance screen from the FIRST non-exempt-looking 503 they can never
 * receive… except probe/status calls. To keep the shell mounted for verified
 * identities, the service asks GET /maintenance/whoami (server-computed from
 * the verified profile row — never client-declared) and only MOUNTS the gate
 * when the server says NOT exempt. Exemption evidence is cached for
 * EXEMPTION_TTL_MS and invalidated on every account switch so a demoted/
 * un-whitelisted identity re-proves itself on the next 503.
 */

import { apiFetch } from '@/client/php';
import { AppState, type AppStateStatus } from 'react-native';
import {
  nextVerdictAfterProbe,
  verdictFrom503,
  verdictFromStatus,
  isMaintenanceError,
  maintenancePollIntervalMs,
  shouldNotifyVerdictChange,
  shouldClearMaintenanceOnStatusProbe,
  nextProbeDelayMs,
  setMaintenanceControlFlowActive,
  type MaintenanceVerdict,
} from './maintenanceStateModel';
import NetInfo from '@react-native-community/netinfo';
import { backendClient } from '@/client/php';

type Listener = (v: MaintenanceVerdict) => void;

let current: MaintenanceVerdict = { state: 'NORMAL' };
const listeners = new Set<Listener>();

/** Single-flight probe (concurrent 503s + poll must not stack requests). */
let probePromise: Promise<void> | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let lifecycleWired = false;

/** Bounded-backoff state for the silent recovery poll (never surfaces in UI). */
let probeAttempt = 0;

// ── Canary: suppress EXPECTED maintenance control-flow noise ─────────────────

let maintenanceActive = false;

/**
 * True while the server-authoritative maintenance verdict is active AND the
 * error under consideration classifies as maintenance control flow. Call sites
 * use this to keep red console noise / toasts away from EXPECTED states —
 * never to hide genuine errors (a bare 503, a suspension, a revocation, a
 * timeout all fail this check and keep their normal handling).
 */
export function isExpectedMaintenanceError(
  err: { status?: number; code?: string; message?: string } | null | undefined
): boolean {
  return maintenanceActive && isMaintenanceError(err);
}

// ── SA exemption evidence (server-computed, cached briefly) ──────────────────

const EXEMPTION_TTL_MS = 60_000;
let exemptionCache: { value: boolean; readAt: number; userId: string | null } | null = null;

/** Account switches must re-prove exemption (never trust across identities). */
export function invalidateExemptionEvidence(): void {
  exemptionCache = null;
}

async function fetchExemptionEvidence(userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const now = Date.now();
  if (exemptionCache && exemptionCache.userId === userId && now - exemptionCache.readAt < EXEMPTION_TTL_MS) {
    return exemptionCache.value;
  }
  try {
    const net = await NetInfo.fetch();
    if (!net.isConnected) return exemptionCache?.value ?? false;
    const res = await apiFetch<{ exempt?: boolean; maintenance?: boolean }>(
      '/maintenance/whoami',
      { method: 'GET', headers: { 'Cache-Control': 'no-store' } }
    );
    if (res.error || typeof res.data?.exempt !== 'boolean') {
      // Unknown ≠ exempt: keep the previous answer briefly (bounded) so a
      // transient whoami failure cannot eject a verified SA mid-session.
      return exemptionCache?.value ?? false;
    }
    exemptionCache = { value: res.data.exempt, readAt: now, userId };
    return res.data.exempt;
  } catch {
    return exemptionCache?.value ?? false;
  }
}

// ── Verdict publishing ───────────────────────────────────────────────────────

function publish(next: MaintenanceVerdict): void {
  const prev = current;
  if (!shouldNotifyVerdictChange(prev, next)) {
    // State textually identical — no UI event, but keep the poll armed.
    schedulePolling();
    return;
  }
  current = next;
  maintenanceActive = next.state === 'MAINTENANCE';
  setMaintenanceControlFlowActive(maintenanceActive);
  for (const l of listeners) {
    try { l(current); } catch { /* listener errors never break the service */ }
  }
  schedulePolling();
}

function schedulePolling(): void {
  const shouldPoll = current.state === 'MAINTENANCE';
  if (shouldPoll && pollTimer == null) {
    // BOUNDED BACKOFF: the first confirmation probe fires at retryAfter
    // (capped 15s–300s by maintenancePollIntervalMs); every subsequent silent
    // probe backs off 15→30→60→120s (capped by MAINT_PROBE_MAX_MS). No visible
    // state ever depends on this — recovery is equally silent at any delay.
    const firstDelay = maintenancePollIntervalMs(current.state === 'MAINTENANCE' ? current.retryAfter : 300);
    const chain = (delay: number) => {
      pollTimer = setTimeout(() => {
        void probeMaintenanceStatus().finally(() => {
          if (current.state === 'MAINTENANCE') chain(nextProbeDelayMs(probeAttempt++));
        });
      }, delay);
    };
    chain(firstDelay);
  } else if (!shouldPoll && pollTimer != null) {
    clearTimeout(pollTimer);
    pollTimer = null;
    probeAttempt = 0;
  }
}

/** Called by the php.ts interceptor on a confirmed maintenance 503. */
export function notifyMaintenance503(
  body: { message?: string; retryAfter?: number },
  ctx?: { hasSession?: boolean }
): void {
  const next = verdictFrom503(body);
  // The synchronous canary (pure module) is armed by php.ts BEFORE this call —
  // every caller's catch block already see expected-control-flow. The
  // module-level flag mirrors it for the poller guard and recovery logic.
  maintenanceActive = true;

  void (async () => {
    // SA/whitelist exemption evidence: only relevant when a session exists.
    const exempt = ctx?.hasSession ? await fetchExemptionEvidence(getExemptionUserId()) : false;
    if (exempt) {
      // Server-verified identity passes the gate — keep the shell mounted.
      // The canary stays armed (this response IS maintenance control flow)
      // and the recovery poll stays armed via the module flag, but the UI
      // verdict is NOT published: an exempt identity keeps using the app, so
      // its pollers must keep running and no maintenance screen may mount.
      return;
    }
    // A 503 only ever arrives for an AUTHENTICATED non-exempt caller (the
    // server exempts the auth endpoints), so the COVER_ALL verdict is correct
    // here by construction.
    publish(next);
  })();
}

/**
 * The user id bound to exemption evidence. Set once per account by the session
 * provider (setMaintenanceExemptionUserId) so the whoami answer is scoped to
 * the CURRENT identity. Returns null before the first bind (→ not exempt).
 */
let exemptionUserId: string | null = null;
export function setMaintenanceExemptionUserId(userId: string | null): void {
  if (userId !== exemptionUserId) {
    exemptionCache = null; // identity changed → previous evidence is void
  }
  exemptionUserId = userId;
}
function getExemptionUserId(): string | null {
  return exemptionUserId;
}

/** GET /maintenance — public, gate-exempt. OK + enabled=false → recover. */
export async function probeMaintenanceStatus(): Promise<void> {
  if (probePromise) return probePromise;
  probePromise = (async () => {
    try {
      // Explicitly offline → skip (never classify no-network as maintenance).
      const net = await NetInfo.fetch();
      if (!net.isConnected) return;
      const res = await apiFetch<{ enabled?: boolean; message?: string; retryAfter?: number }>('/maintenance', {
        method: 'GET',
        headers: { 'Cache-Control': 'no-store' },
      });
      // apiFetch parses 503 bodies as errors — the interceptor already flipped
      // the state via notifyMaintenance503 in that case. Here a *successful*
      // response (gate exempted the route) decides recovery.
      if (res.error) return; // transient failure → keep current state, poll retries
      // Session-aware verdict: an unauthenticated device gets
      // MAINTENANCE_AUTH_AVAILABLE (Login stays reachable), an authenticated
      // non-exempt user gets the COVER_ALL MAINTENANCE verdict. The session
      // state comes from the real auth pipeline (php.ts's stored session).
      const hasSession = !!(await backendClient.auth.getSession()).data?.session?.access_token;
      const next = nextVerdictAfterProbe(current, true, res.data, hasSession);
      if (hasSession && (next.state === 'MAINTENANCE' || next.state === 'MAINTENANCE_AUTH_AVAILABLE')) {
        // RACE + FOREGROUND GUARD: a server-verified exempt identity (fresh or
        // restored SA/whitelisted session) must never be pushed under the gate
        // by this probe — not even transiently — because the probe can resolve
        // AFTER the sign-in re-evaluation (reevaluateMaintenanceAfterAuth) and
        // would otherwise override its NORMAL verdict. Evidence is
        // server-computed (whoami) and TTL-cached; fail-closed on error.
        const exempt = await fetchExemptionEvidence(getExemptionUserId());
        if (exempt) {
          if (current.state !== 'NORMAL') {
            maintenanceActive = false;
            probeAttempt = 0;
            publish({ state: 'NORMAL' });
          }
          return;
        }
      }
      // Recovery fires ONLY on the server's explicit enabled=false (never a
      // probe failure) — for any current maintenance variant. This is the
      // ONLY exit for a fresh-logged-in SA/whitelisted user (they receive no
      // 503s, so no notifyMaintenance503 path could ever clear their state).
      if (shouldClearMaintenanceOnStatusProbe(current, res.data?.enabled)) {
        // Maintenance ENDED. Clear the canary first, then publish. The gate's
        // recovery effect re-runs the normal server-authoritative bootstrap
        // (profile refresh, revocation poll) — whitelist changes take effect
        // immediately without restart or re-login.
        maintenanceActive = false;
        probeAttempt = 0;
        publish(next);
      } else {
        publish(next);
      }
    } catch {
      // keep current state; the poll retries (bounded backoff below)
    } finally {
      probePromise = null;
    }
  })();
  return probePromise;
}

/**
 * AUTHENTICATED RE-EVALUATION — called by the session provider when a session
 * becomes present (restore or fresh login). Two lockout paths close here:
 *
 *   1. Fresh SA/whitelisted login while MAINTENANCE is active: the verdict is
 *      re-decided with the SERVER-computed exemption evidence
 *      (GET /maintenance/whoami — never a client-declared role). An exempt
 *      identity returns to the normal app immediately.
 *   2. The unauthenticated MAINTENANCE_AUTH_AVAILABLE verdict (Login visible)
 *      is re-classified to the full MAINTENANCE verdict once a session exists,
 *      so a non-exempt user who just signed in lands on the maintenance
 *      screen instead of the app.
 */
export async function reevaluateMaintenanceAfterAuth(): Promise<void> {
  const stored = (await backendClient.auth.getSession()).data?.session;
  const hasSession = !!stored?.access_token;
  if (!hasSession) return; // signed out → nothing to re-decide
  if (current.state !== 'MAINTENANCE' && current.state !== 'MAINTENANCE_AUTH_AVAILABLE') return;

  const exempt = await fetchExemptionEvidence(getExemptionUserId());
  if (exempt) {
    maintenanceActive = false;
    probeAttempt = 0;
    publish({ state: 'NORMAL' });
    return;
  }
  // Non-exempt authenticated user: upgrade the AUTH_AVAILABLE variant to the
  // full gate. Reuse the stored message/retryAfter (same server verdict).
  const v = current as { message?: string; retryAfter?: number };
  publish({
    state: 'MAINTENANCE',
    message: v.message ?? '',
    retryAfter: v.retryAfter ?? 300,
  });
}

/** Cold-start / foreground entry point (wired from app/_layout.tsx). */
export function wireMaintenanceLifecycle(): () => void {
  if (lifecycleWired) return () => {};
  lifecycleWired = true;

  void probeMaintenanceStatus();

  const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
    if (s === 'active') void probeMaintenanceStatus();
  });

  return () => {
    sub.remove();
    lifecycleWired = false;
    if (pollTimer != null) { clearTimeout(pollTimer); pollTimer = null; }
  };
}

export function subscribeMaintenance(l: Listener): () => void {
  listeners.add(l);
  l(current);
  return () => { listeners.delete(l); };
}

export function getMaintenanceVerdict(): MaintenanceVerdict {
  return current;
}

/** Test/detox hook. */
export function __resetMaintenanceForTests(): void {
  current = { state: 'NORMAL' };
  maintenanceActive = false;
  setMaintenanceControlFlowActive(false);
  probeAttempt = 0;
  exemptionCache = null;
  exemptionUserId = null;
  if (pollTimer != null) { clearTimeout(pollTimer); pollTimer = null; }
}

/** Test seam: inspect the raw current verdict (incl. AUTH_AVAILABLE variant). */
export function __maintenanceVerdictForTests(): MaintenanceVerdict {
  return current;
}
