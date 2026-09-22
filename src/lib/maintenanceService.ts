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
 */

import { apiFetch } from '@/client/php';
import { AppState, type AppStateStatus } from 'react-native';
import {
  nextVerdictAfterProbe,
  verdictFrom503,
  verdictFromStatus,
  maintenancePollIntervalMs,
  type MaintenanceVerdict,
} from './maintenanceStateModel';
import NetInfo from '@react-native-community/netinfo';

type Listener = (v: MaintenanceVerdict) => void;

let current: MaintenanceVerdict = { state: 'NORMAL' };
const listeners = new Set<Listener>();

/** Single-flight probe (concurrent 503s + poll must not stack requests). */
let probePromise: Promise<void> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lifecycleWired = false;

function publish(next: MaintenanceVerdict): void {
  const prev = current;
  current = next;
  if (prev.state !== next.state || JSON.stringify(prev) !== JSON.stringify(next)) {
    for (const l of listeners) {
      try { l(current); } catch { /* listener errors never break the service */ }
    }
  }
  schedulePolling();
}

function schedulePolling(): void {
  const shouldPoll = current.state === 'MAINTENANCE';
  if (shouldPoll && pollTimer == null) {
    const interval = maintenancePollIntervalMs(current.state === 'MAINTENANCE' ? current.retryAfter : 300);
    pollTimer = setInterval(() => { void probeMaintenanceStatus(); }, interval);
  } else if (!shouldPoll && pollTimer != null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Called by the php.ts interceptor on a confirmed maintenance 503. */
export function notifyMaintenance503(body: { message?: string; retryAfter?: number }): void {
  publish(verdictFrom503(body));
  // Fire an immediate confirmation probe (also arms the recovery poll).
  void probeMaintenanceStatus();
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
      publish(nextVerdictAfterProbe(current, true, res.data));
    } catch {
      // keep current state; the poll retries
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
    if (pollTimer != null) { clearInterval(pollTimer); pollTimer = null; }
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
  if (pollTimer != null) { clearInterval(pollTimer); pollTimer = null; }
}
