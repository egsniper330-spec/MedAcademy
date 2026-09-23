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
  nextProbeDelayMs,
  setMaintenanceControlFlowActive,
  type MaintenanceVerdict,
} from './maintenanceStateModel';
import NetInfo from '@react-native-community/netinfo';

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
  // every caller's catch block already sees expected-control-flow. The
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
      const next = nextVerdictAfterProbe(current, true, res.data);
      if (next.state === 'NORMAL' && current.state === 'MAINTENANCE') {
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
