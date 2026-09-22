/**
 * offlineTransition.ts
 *
 * Online ⇄ Offline transition service (Android + iOS identical surface).
 *
 * • Detects connectivity transitions via NetInfo (single subscription).
 * • On ONLINE→OFFLINE: preserves the current authoritative security state
 *   (nothing is suppressed — all SecurityContext detectors are local and run
 *   fine offline). Fires the offline library resync no-op guard so the DRM
 *   registry and metadata are not touched mid-transition.
 * • On OFFLINE→ONLINE: refreshes the update policy (authoritative server
 *   verdict), re-runs the full security evaluation (policies may have
 *   changed server-side), reconciles download metadata, and re-validates the
 *   session token — no app restart required.
 * • A debounced transition bridge prevents event storms (NetInfo can emit
 *   rapidly while switching networks).
 */

import { useEffect, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { checkAppUpdate } from './updateConfigService';
import { resyncOfflineLibrary } from './offlineVideoService';
import { invalidatePolicyCache } from './security';

type Handler = () => void;
const onlineHandlers = new Set<Handler>();

let wired = false;
let unsubNetInfo: (() => void) | null = null;
let lastOnline: boolean | null = null;
let lastTransitionAt = 0;
const TRANSITION_DEBOUNCE_MS = 1500;

/** Called when connectivity returns (debounced, once per transition). */
export function onConnectivityRestored(h: Handler): () => void {
  onlineHandlers.add(h);
  return () => { onlineHandlers.delete(h); };
}

/**
 * React hook for the app-wide Online/Offline indicator.
 *
 * Mirrors the transition service's exact definition of connectivity
 * (`isConnected && isInternetReachable !== false`), so the UI pill and the
 * transition behaviors can never disagree. Updates reactively — no app
 * restart, no navigation required.
 */
export function useConnectivity(): boolean | null {
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const map = (state: { isConnected: boolean | null; isInternetReachable: boolean | null }) =>
      !!state.isConnected && state.isInternetReachable !== false;
    const unsub = NetInfo.addEventListener((state) => { if (alive) setOnline(map(state)); });
    void NetInfo.fetch().then((state) => { if (alive) setOnline(map(state)); }).catch(() => {});
    return () => { alive = false; unsub(); };
  }, []);
  return online;
}

async function handleTransition(online: boolean): Promise<void> {
  if (online) {
    // ── OFFLINE → ONLINE ──────────────────────────────────────────────────
    // 1. Security policy cache invalidation: the fetch failed offline, so the
    //    in-memory policy map may be the bundled default; refresh it.
    invalidatePolicyCache();
    // 2. Update policy: authoritative server verdict (also persists the
    //    offline cache used by the next cold start).
    void checkAppUpdate();
    // 3. Download metadata reconciliation against the DRM registry.
    void resyncOfflineLibrary();
    // 4. App-level handlers (session re-validation is handled by the existing
    //    401 auto-refresh in php.ts on the next request; handlers can add more).
    for (const h of onlineHandlers) {
      try { h(); } catch { /* handler errors never break the service */ }
    }
  }
  // ONLINE → OFFLINE: nothing to stop — DRM downloads continue per the OS;
  // the security lifecycle is untouched (all detectors are local).
}

export function initOfflineTransitions(): () => void {
  if (wired) return () => {};
  wired = true;

  void NetInfo.fetch().then((st) => { lastOnline = !!st.isConnected; }).catch(() => {});
  unsubNetInfo = NetInfo.addEventListener((state) => {
    const online = !!state.isConnected && !!state.isInternetReachable !== false;
    if (lastOnline === null) { lastOnline = online; return; }
    if (online === lastOnline) return;
    const now = Date.now();
    if (now - lastTransitionAt < TRANSITION_DEBOUNCE_MS) return; // event storm guard
    lastTransitionAt = now;
    lastOnline = online;
    void handleTransition(online);
  });

  return () => {
    unsubNetInfo?.();
    unsubNetInfo = null;
    wired = false;
  };
}
