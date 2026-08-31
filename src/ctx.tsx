import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { Session, PollingChannel } from '@/client/types';
import * as SecureStore from 'expo-secure-store';

import { backendClient } from '@/client/backendClient';
import { getInstallationId, getStoredDeviceFingerprint, clearDeviceFingerprint } from '@/lib/installationId';

// ─────────────────────────────────────────────────────────────────────────────
// AUTH TIMELINE LOGGER — silent in production, active only in __DEV__ builds
// ─────────────────────────────────────────────────────────────────────────────
const _t0 = Date.now();
function authLog(msg: string, data?: unknown) {
  if (!__DEV__) return;
  const now = Date.now();
  const d   = new Date(now);
  const ts  = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
  const pre = `[Auth ${ts} +${now - _t0}ms]`;
  if (data !== undefined) {
    console.log(pre, msg, typeof data === 'object' ? JSON.stringify(data) : data);
  } else {
    console.log(pre, msg);
  }
}
function captureCallStack(label: string) {
  if (!__DEV__) return;
  try { throw new Error(label); } catch (e) {
    const lines = ((e as Error).stack ?? '').split('\n').slice(0, 8).join(' | ');
    authLog(`⚠️  STACK for "${label}":`, lines);
  }
}

// ── Security version persistence ─────────────────────────────────────────────
function secVersionKey(userId: string) { return `med_security_version_${userId}`; }

async function getStoredSecurityVersion(userId: string): Promise<number> {
  try {
    const key = secVersionKey(userId);
    if (process.env.EXPO_OS === 'web') return parseInt(localStorage.getItem(key) ?? '0', 10) || 0;
    return parseInt((await SecureStore.getItemAsync(key)) ?? '0', 10) || 0;
  } catch (_) { return 0; }
}
async function setStoredSecurityVersion(userId: string, v: number): Promise<void> {
  try {
    const key = secVersionKey(userId);
    if (process.env.EXPO_OS === 'web') { localStorage.setItem(key, String(v)); return; }
    await SecureStore.setItemAsync(key, String(v));
  } catch (_) {}
}
async function clearStoredSecurityVersion(userId: string): Promise<void> {
  try {
    const key = secVersionKey(userId);
    if (process.env.EXPO_OS === 'web') { localStorage.removeItem(key); return; }
    await SecureStore.deleteItemAsync(key);
  } catch (_) {}
}

// ── Types ─────────────────────────────────────────────────────────────────────
type SessionContextType = { session: Session | null; isLoading: boolean };
const SessionContext = createContext<SessionContextType>({ session: null, isLoading: true });

// ── Grace window after sign-in / restored-session events ──────────────────────
// Suppresses all checkRevocation calls for this many ms after a sign-in event.
// Rationale: get_security_version seeding and storeDeviceFingerprint are both
// async fire-and-forget. If checkRevocation runs first it sees storedVersion=0
// → version mismatch → forceSignOut. The grace window buys time for both to
// complete before the first real check runs.
const POST_SIGNIN_GRACE_MS = 8_000;

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession]   = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const sessionRef         = useRef<Session | null>(null);
  const revokingRef        = useRef(false);
  const appState           = useRef(AppState.currentState);
  // Non-zero = SIGNED_IN or INITIAL_SESSION fired this process lifetime.
  // Zero     = no auth event yet (safe to check immediately on a restored session).
  const lastSignedInAtRef  = useRef<number>(0);
  const pollingChannelRef = useRef<PollingChannel | null>(null);
  const pollingUserIdRef  = useRef<string | null>(null);

  // ── forceSignOut ──────────────────────────────────────────────────────────
  const forceSignOutRef = useRef(async (reason: string) => {
    authLog(`🚨 forceSignOut CALLED reason="${reason}"`);
    captureCallStack(`forceSignOut:${reason}`);

    if (revokingRef.current) {
      authLog('forceSignOut: already in progress — skipping duplicate call');
      return;
    }
    revokingRef.current = true;
    try {
      const userId = sessionRef.current?.user?.id;
      authLog(`forceSignOut: clearing credentials userId=${userId ?? 'none'}`);
      if (userId) await clearStoredSecurityVersion(userId);
      await clearDeviceFingerprint();
      const { error } = await backendClient.auth.signOut();
      if (error) {
        authLog(`forceSignOut: backendClient.auth.signOut() ERROR: ${error.message}`);
      } else {
        authLog('forceSignOut: backendClient.auth.signOut() SUCCESS → SIGNED_OUT event will follow');
      }
    } finally {
      revokingRef.current = false;
    }
  });

  // ── checkRevocation ───────────────────────────────────────────────────────
  const checkRevocationRef = useRef(async (sess: Session | null, trigger = 'unknown') => {
    authLog(`checkRevocation: called from trigger="${trigger}" session=${sess?.user?.id ?? 'null'}`);
    if (!sess || revokingRef.current) {
      authLog(`checkRevocation: SKIP — sess=${!!sess} revoking=${revokingRef.current}`);
      return;
    }
    const userId = sess.user?.id;
    if (!userId) return;

    // Grace window guard
    if (lastSignedInAtRef.current > 0) {
      const ms = Date.now() - lastSignedInAtRef.current;
      if (ms < POST_SIGNIN_GRACE_MS) {
        authLog(`checkRevocation: GRACE WINDOW — ${ms}ms since sign-in < ${POST_SIGNIN_GRACE_MS}ms, skipping`);
        return;
      }
    }

    try {
      const [storedVersion, fingerprint, installationId] = await Promise.all([
        getStoredSecurityVersion(userId),
        getStoredDeviceFingerprint(),
        getInstallationId(),
      ]);
      authLog(`checkRevocation: storedVersion=${storedVersion} fingerprint=${fingerprint ?? 'NONE'} installationId=${installationId}`);

      const { data: fnData, error: fnError } = await backendClient.functions.invoke('device-binding', {
        body: {
          action:                  'check_authorization',
          fingerprint:             fingerprint ?? undefined,
          installation_id:         installationId,
          stored_security_version: storedVersion,
        },
      });

      if (fnError) {
        authLog(`checkRevocation: Edge Function error — falling back to RPC: ${fnError.message}`);
        const { data: rpcData, error: rpcError } = await backendClient.rpc('get_security_version');
        if (rpcError) { authLog(`checkRevocation: RPC fallback error: ${rpcError.message}`); return; }
        const serverVer = Number(rpcData ?? 0);
        authLog(`checkRevocation: RPC fallback serverVersion=${serverVer} storedVersion=${storedVersion}`);
        if (serverVer !== storedVersion) {
          authLog(`checkRevocation: ❌ version MISMATCH via RPC → forceSignOut`);
          await forceSignOutRef.current('rpc_version_mismatch');
        }
        return;
      }

      authLog(`checkRevocation: response authorized=${fnData?.authorized} reason=${fnData?.reason ?? 'none'} server_version=${fnData?.security_version}`);

      if (fnData?.authorized === false) {
        authLog(`checkRevocation: ❌ REVOKED reason="${fnData?.reason}" → forceSignOut`);
        await forceSignOutRef.current(`revoked:${fnData?.reason ?? 'unknown'}`);
        return;
      }
      authLog('checkRevocation: ✅ authorized=true — session is valid');
    } catch (err) {
      authLog(`checkRevocation: unexpected error (non-fatal): ${err}`);
    }
  });

  useEffect(() => {
    authLog('SessionProvider: mounting');

    // ── 1. Initial session load ───────────────────────────────────────────────
    (async () => {
      authLog('getSession: START');
      let s: Session | null = null;
      try {
        const { data } = await backendClient.auth.getSession();
        s = data.session;
        authLog(`getSession: DONE user=${s?.user?.id ?? 'none'} expires_at=${s?.expires_at ?? 'n/a'} has_access_token=${!!s?.access_token} has_refresh_token=${!!s?.refresh_token}`);
      } catch (err) {
        // getSession() should never throw (backendClient-js returns {data, error}), but if
        // the network layer rejects (e.g. completely unreachable host on first network
        // call), we must still resolve isLoading so the UI renders instead of staying
        // black.
        authLog(`getSession: UNEXPECTED ERROR (non-fatal, treating as no session): ${err}`);
      }

      if (s) {
        const [storedFp, storedVer] = await Promise.all([
          getStoredDeviceFingerprint(),
          getStoredSecurityVersion(s.user.id),
        ]);
        authLog('── DEVICE IDENTITY ──────────────────────────────────');
        authLog(`  userId            : ${s.user.id}`);
        authLog(`  storedFingerprint : ${storedFp ?? '⚠️  NONE — device may not be registered yet'}`);
        authLog(`  storedSecVersion  : ${storedVer}`);
        authLog(`  lastSignedInAt    : ${lastSignedInAtRef.current} (0 = restored session)`);
        authLog('─────────────────────────────────────────────────────');
      }

      setSession(s);
      sessionRef.current = s;
      setIsLoading(false);
      authLog('setIsLoading(false)');

      // Only check on a truly RESTORED session (lastSignedInAt=0 means no
      // SIGNED_IN/INITIAL_SESSION has fired yet → storedVersion from previous launch).
      if (s && lastSignedInAtRef.current === 0) {
        authLog('getSession: restored session detected → running checkRevocation');
        await checkRevocationRef.current(s, 'initial_restored_session');
      } else if (s) {
        authLog('getSession: fresh login in progress → skipping checkRevocation (grace window active)');
      }
    })();

    // ── 2. Auth state listener ────────────────────────────────────────────────
    const { data: { subscription } } = backendClient.auth.onAuthStateChange((event, s) => {
      authLog(`onAuthStateChange: event=${event} user=${s?.user?.id ?? 'none'} expires_at=${s?.expires_at ?? 'n/a'} has_access_token=${!!s?.access_token} has_refresh_token=${!!s?.refresh_token}`);
      setSession(s);
      sessionRef.current = s;

      // FIX: also treat INITIAL_SESSION as a sign-in for grace-window purposes.
      // On web/reload the session listener emits INITIAL_SESSION when a
      // session already exists — without this guard the grace window never
      // activates and checkRevocation fires immediately from getSession() above.
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && s) {
        lastSignedInAtRef.current = Date.now();
        authLog(`${event}: grace window started at ${lastSignedInAtRef.current}`);

        // Seed security_version from server baseline.
        (async () => {
          try {
            const { data, error } = await backendClient.rpc('get_security_version');
            if (error) {
              authLog(`${event}: get_security_version RPC ERROR: ${error.message}`);
            } else if (data != null) {
              await setStoredSecurityVersion(s.user.id, Number(data));
              authLog(`${event}: seeded security_version=${data} for user=${s.user.id}`);
            }
          } catch (err) {
            authLog(`${event}: get_security_version failed (non-fatal): ${err}`);
          }
        })();
      }

      if (event === 'TOKEN_REFRESHED') {
        authLog(`TOKEN_REFRESHED: new expires_at=${s?.expires_at ?? 'n/a'}`);
      }

      if (event === 'SIGNED_OUT') {
        authLog('SIGNED_OUT: session cleared — redirecting to login');
        lastSignedInAtRef.current = 0;
      }

      if (event === 'USER_UPDATED') {
        authLog('USER_UPDATED: user metadata changed');
      }
    });

    // ── 3. Polling — single deduplicated subscription ────────────────────────
    const subscribePolling = (userId: string) => {
      if (pollingUserIdRef.current === userId && pollingChannelRef.current) {
        authLog(`Polling: already subscribed for user=${userId}, skipping duplicate`);
        return;
      }
      if (pollingChannelRef.current) {
        backendClient.removePoller(pollingChannelRef.current);
        pollingChannelRef.current = null;
        pollingUserIdRef.current  = null;
      }
      authLog(`Polling: subscribing for user=${userId}`);
      pollingChannelRef.current = backendClient
        .poll(`revocation:${userId}`)
        .on('php_polling',
          { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${userId}` },
          (payload) => {
            const newVer = payload.new?.security_version as number | undefined;
            authLog(`Polling profiles UPDATE: new security_version=${newVer}`);
            checkRevocationRef.current(sessionRef.current, 'polling_profiles_update');
          })
        .on('php_polling',
          { event: 'UPDATE', schema: 'public', table: 'devices', filter: `user_id=eq.${userId}` },
          (payload) => {
            const tl = payload.new?.trust_level as string | undefined;
            const st = payload.new?.status     as string | undefined;
            authLog(`Polling devices UPDATE: trust_level=${tl} status=${st}`);
            if (tl === 'revoked' || st === 'logged_out') {
              checkRevocationRef.current(sessionRef.current, 'polling_devices_update');
            }
          })
        .subscribe((state) => { authLog(`Polling channel state: ${state}`); });
      pollingUserIdRef.current = userId;
    };

    const { data: { subscription: pollingAuthSub } } = backendClient.auth.onAuthStateChange((event, s) => {
      if (event === 'SIGNED_IN' && s?.user?.id) subscribePolling(s.user.id);
      if (event === 'INITIAL_SESSION' && s?.user?.id) subscribePolling(s.user.id);
      if (event === 'SIGNED_OUT') {
        if (pollingChannelRef.current) {
          backendClient.removePoller(pollingChannelRef.current);
          pollingChannelRef.current = null;
          pollingUserIdRef.current  = null;
        }
      }
    });
    // NOTE: The extra getSession() call that was here has been removed.
    // It was redundant (the IIFE above already calls getSession and the
    // INITIAL_SESSION event above covers restored sessions for polling),
    // and it introduced a race: a second navigator.lock acquisition could
    // resolve after SIGNED_IN but before registerDevice + storeDeviceFingerprint
    // completed, causing a stale-fingerprint check_authorization call.

    // ── 4. Polling — 30-second fallback ──────────────────────────────────────
    const pollInterval = setInterval(() => {
      authLog('poll tick — checking revocation');
      checkRevocationRef.current(sessionRef.current, 'poll');
    }, 30_000);

    // ── 5. App foreground handler ─────────────────────────────────────────────
    // Non-fatal on refreshSession error — transient network errors must NOT
    // sign the user out. The PHP refresh endpoint handles token rotation.
    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (appState.current.match(/inactive|background/) && nextState === 'active') {
        authLog('app foregrounded — refreshSession + revocation check');
        (async () => {
          if (process.env.EXPO_OS !== 'web') {
            const { error, data } = await backendClient.auth.refreshSession();
            if (error) {
              authLog(`foreground refreshSession error (non-fatal, skipping check): ${error.message}`);
              return;
            }
            authLog(`foreground refreshSession OK expires_at=${data.session?.expires_at ?? 'n/a'}`);
            await checkRevocationRef.current(data.session, 'foreground_refresh');
          } else {
            const { data: { session: s } } = await backendClient.auth.getSession();
            await checkRevocationRef.current(s, 'foreground_web');
          }
        })();
      }
      appState.current = nextState;
    });

    return () => {
      authLog('SessionProvider: unmounting — cleaning up listeners');
      subscription.unsubscribe();
      pollingAuthSub.unsubscribe();
      if (pollingChannelRef.current) backendClient.removePoller(pollingChannelRef.current);
      appStateSubscription.remove();
      clearInterval(pollInterval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <SessionContext.Provider value={{ session, isLoading }}>
      {children}
    </SessionContext.Provider>
  );
}

export const useSession = () => useContext(SessionContext);
