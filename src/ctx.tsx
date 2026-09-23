import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { Session, PollingChannel } from '@/client/types';
import * as SecureStore from 'expo-secure-store';

import { backendClient } from '@/client/backendClient';
import { getInstallationId, getStoredDeviceFingerprint, clearDeviceFingerprint } from '@/lib/installationId';
import { invalidateCreditCache } from '@/lib/creditService';
import { resetOfflineLibraryForAccountSwitch } from '@/lib/offlineVideoService';
import { isExpectedMaintenanceError } from '@/lib/maintenanceStateModel';
import { useProfileStore } from '@/lib/store';
import { UserRole, type UserRole as UserRoleType } from '@/lib/enums';
import {
  setUploadQueueSessionProvider,
  migrateLegacyQueue,
  useUploadQueueStore,
} from '@/lib/uploadQueueStore';

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

/** Read the authoritative profiles.security_version for a user — the exact column
 *  check_authorization compares against. Returns null when the row cannot be read
 *  (network/server failure) so callers PRESERVE the session instead of guessing. */
async function fetchProfileSecurityVersion(userId: string): Promise<number | null> {
  try {
    const { data, error } = await backendClient
      .from('profiles')
      .select('security_version')
      .eq('id', userId)
      .maybeSingle();
    if (error || data == null) return null;
    const raw = (data as { security_version?: unknown } | null)?.security_version;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
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
  // Tracks whether profiles.security_version was successfully stored for the
  // CURRENT sign-in / restored session. When unconfirmed, a server-side
  // "security_version_changed" verdict can be caused by OUR OWN failed seed
  // (transient network error at login) rather than a genuine revocation — so
  // checkRevocation re-reads the authoritative profile row and re-checks
  // device trust instead of force-signing-out a still-valid session.
  const seedRef            = useRef<{ confirmed: boolean; userId: string | null }>({ confirmed: false, userId: null });
  // Last user id seen by the auth listener — used to detect ACCOUNT SWITCHES so
  // per-account in-memory caches (credit balance TTL cache) are invalidated and
  // the new account can never inherit the previous account's data.
  const lastAccountUidRef  = useRef<string | null>(null);

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

    // Confirmed = we (or the server) have verified the stored version equals the
    // authoritative profiles.security_version for THIS session.
    const seedConfirmed = seedRef.current.confirmed && seedRef.current.userId === userId;

    try {
      const [storedVersion, fingerprint, installationId] = await Promise.all([
        getStoredSecurityVersion(userId),
        getStoredDeviceFingerprint(),
        getInstallationId(),
      ]);
      authLog(`checkRevocation: storedVersion=${storedVersion} fingerprint=${fingerprint ?? 'NONE'} installationId=${installationId}`);

      const invokeAuthCheck = async (storedVer: number) => {
        const { data, error } = await backendClient.functions.invoke('device-binding', {
          body: {
            action:                  'check_authorization',
            fingerprint:             fingerprint ?? undefined,
            installation_id:         installationId,
            stored_security_version: storedVer,
          },
        });
        return { data: data as { authorized?: boolean; reason?: string; security_version?: number } | null, error };
      };

      const primary = await invokeAuthCheck(storedVersion);

      // ── MAINTENANCE: expected control flow, verdict simply UNKNOWN ─────────
      // A non-exempt user's device-binding check legitimately receives 503
      // maintenance_mode while the gate is up. That is NOT a revocation, NOT a
      // security violation, and NOT a network failure — the session is valid
      // and stays untouched. The gate overlay owns the UI; the next poll after
      // recovery re-establishes the verdict. (Verified-exempt identities —
      // SA/whitelist — never receive the 503 and flow through normally.)
      if (isExpectedMaintenanceError(primary.error)) {
        authLog('checkRevocation: skipped — maintenance gate active (expected)');
        return;
      }

      // ── Primary path: server verdict received ──────────────────────────────
      if (!primary.error) {
        const fn = primary.data;
        authLog(`checkRevocation: response authorized=${fn?.authorized} reason=${fn?.reason ?? 'none'} server_version=${fn?.security_version}`);

        // ── Server-authoritative ROLE reconciliation (no logout) ────────────
        // check_authorization now returns the FRESH profile role. When it
        // differs from the locally cached profile, publish it into the profile
        // store: every role consumer (guards, drawer, admin features)
        // re-renders from server truth — USER↔ADMIN changes now propagate
        // within one revocation poll instead of requiring logout/login.
        const freshRole = (primary.data as { role?: string } | null)?.role;
        if (
          typeof freshRole === 'string' &&
          (Object.values(UserRole) as string[]).includes(freshRole)
        ) {
          const p = useProfileStore.getState().profile;
          if (p && p.role !== freshRole) {
            authLog(`checkRevocation: ROLE DRIFT ${String(p.role)} → ${freshRole} (server-authoritative, no logout)`);
            invalidateCreditCache();
            useProfileStore.getState().setProfile({ ...p, role: freshRole as UserRoleType });
          }
        }

        if (fn?.authorized === false) {
          // Self-heal: when the stored version was never confirmed for this
          // session (post-login seed failed on a transient network error), a
          // "security_version_changed" verdict can be caused by OUR stale value
          // rather than a real revocation. Re-read the authoritative profile row
          // and re-check once with the corrected version. Genuine revocations are
          // still caught because check_authorization independently verifies
          // account status + device trust (blocked/revoked) on the corrected check.
          if (fn.reason === 'security_version_changed' && !seedConfirmed) {
            authLog('checkRevocation: security_version_changed but seed NOT confirmed — self-healing');
            const serverVer = await fetchProfileSecurityVersion(userId);
            if (serverVer === null) {
              authLog('checkRevocation: self-heal profile read FAILED (non-fatal) — preserving session');
              return;
            }
            await setStoredSecurityVersion(userId, serverVer);
            authLog(`checkRevocation: self-heal stored ${storedVersion} → ${serverVer}, re-checking`);
            const retry = await invokeAuthCheck(serverVer);
            if (retry.error) {
              authLog(`checkRevocation: self-heal re-check ERROR (non-fatal) — preserving session: ${retry.error.message}`);
              return;
            }
            if (retry.data?.authorized === false) {
              authLog(`checkRevocation: ❌ still REVOKED after self-heal reason="${retry.data.reason}" → forceSignOut`);
              await forceSignOutRef.current(`revoked:${retry.data.reason ?? 'unknown'}`);
              return;
            }
            seedRef.current = { confirmed: true, userId };
            authLog('checkRevocation: ✅ self-healed — session is valid (device trust confirmed)');
            return;
          }
          authLog(`checkRevocation: ❌ REVOKED reason="${fn.reason}" → forceSignOut`);
          await forceSignOutRef.current(`revoked:${fn.reason ?? 'unknown'}`);
          return;
        }
        // Server explicitly confirmed stored version + device trust → seed confirmed.
        seedRef.current = { confirmed: true, userId };
        authLog('checkRevocation: ✅ authorized=true — session is valid');
        return;
      }

      // ── Fallback path: device-binding unreachable/errored ──────────────────
      // The version MUST come from the user's own profiles.security_version row —
      // the exact column check_authorization compares against. The legacy
      // get_security_version RPC maps to /security/version (GLOBAL config version),
      // a different value that made every poll report a mismatch.
      authLog(`checkRevocation: device-binding error — falling back to profile read: ${primary.error.message}`);
      // MAINTENANCE: while the gate is up a non-exempt user's profile read can
      // only return 503 maintenance_mode. That is expected control flow — the
      // session is valid and the revocation verdict is simply UNKNOWN; never
      // treat it as a revocation signal (and stay quiet in __DEV__ logs).
      if (isExpectedMaintenanceError(primary.error)) {
        authLog('checkRevocation: skipped — maintenance gate active (expected)');
        return;
      }
      const serverVer = await fetchProfileSecurityVersion(userId);
      if (serverVer === null) {
        authLog('checkRevocation: fallback profile read FAILED (network) — preserving session');
        return;
      }
      authLog(`checkRevocation: fallback serverVersion=${serverVer} storedVersion=${storedVersion} seedConfirmed=${seedConfirmed}`);
      if (serverVer !== storedVersion) {
        if (!seedConfirmed) {
          // Our own failed seed explains the gap — adopt the authoritative value;
          // the next successful device-binding check verifies device trust.
          await setStoredSecurityVersion(userId, serverVer);
          seedRef.current = { confirmed: true, userId };
          authLog(`checkRevocation: fallback mismatch with unconfirmed seed → stored ${storedVersion} → ${serverVer}, session preserved`);
          return;
        }
        authLog('checkRevocation: ❌ version MISMATCH via fallback → forceSignOut');
        await forceSignOutRef.current('rpc_version_mismatch');
        return;
      }
      seedRef.current = { confirmed: true, userId };
      authLog('checkRevocation: ✅ fallback versions match — session is valid');
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
      // Bind the maintenance exemption-evidence identity to THIS session user
      // (null on sign-out). The service caches GET /maintenance/whoami answers
      // per bound id — an account switch invalidates prior evidence, so a
      // demoted/un-whitelisted identity can never inherit a bypass.
      import('@/lib/maintenanceService').then(({ setMaintenanceExemptionUserId }) =>
        setMaintenanceExemptionUserId(s?.user?.id ?? null)
      );
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
      // Rebind maintenance exemption evidence to the NEW identity (account
      // switch) — previous evidence is void across accounts.
      import('@/lib/maintenanceService').then(({ setMaintenanceExemptionUserId }) =>
        setMaintenanceExemptionUserId(s?.user?.id ?? null)
      );

      // FIX: also treat INITIAL_SESSION as a sign-in for grace-window purposes.
      // On web/reload the session listener emits INITIAL_SESSION when a
      // session already exists — without this guard the grace window never
      // activates and checkRevocation fires immediately from getSession() above.
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && s) {
        lastSignedInAtRef.current = Date.now();
        authLog(`${event}: grace window started at ${lastSignedInAtRef.current}`);

        // ── Per-account cache isolation ────────────────────────────────────
        // When a DIFFERENT account signs in during this process lifetime,
        // every per-account in-memory cache must be dropped so the new
        // account never sees the previous account's data (e.g. the credit
        // balance TTL cache would otherwise hand Doctor B Doctor A's 120
        // credits for up to 30 s). Same-account INITIAL_SESSION (web reload)
        // is a no-op.
        if (lastAccountUidRef.current && lastAccountUidRef.current !== s.user.id) {
          authLog(`account switch detected ${lastAccountUidRef.current.slice(0, 8)}… → ${s.user.id.slice(0, 8)}… — invalidating per-account caches`);
          invalidateCreditCache();
        }
        lastAccountUidRef.current = s.user.id;

        // ── Upload-queue account scoping ────────────────────────────────────
        // Point the queue's ownership provider at the live session, then
        // reconcile the persisted queue for THIS account:
        //   • SIGNED_IN with a DIFFERENT user than the loaded queue → the old
        //     account's in-memory tasks are dropped (its persisted state stays
        //     under its own scoped key) and the new account's queue hydrates.
        //   • Legacy global-key tasks are migrated once and stamped with the
        //     current owner so pre-ownership installs don't lose data.
        setUploadQueueSessionProvider(() => {
          try {
            const s = backendClient.auth.getSession?.();
            // getSession may be async on some adapters — read the stored session
            // synchronously through the same key the client uses.
            if (s && typeof (s as any).then !== 'function') {
              return (s as any)?.data?.session?.user?.id ?? null;
            }
          } catch { /* fall through */ }
          return null;
        });
        (async () => {
          try {
            const session = await backendClient.auth.getSession();
            const uid = session?.data?.session?.user?.id ?? null;
            setUploadQueueSessionProvider(() => uid);
            await migrateLegacyQueue(uid);
            const queue = useUploadQueueStore.getState();
            if (queue.ownerUserId && uid && queue.ownerUserId !== uid) {
              // Different account signed in — drop the previous account's
              // in-memory queue (its persisted state remains under its key).
              queue.clearForAccountSwitch();
            } else if (!queue.ownerUserId && uid) {
              // Same account re-login (or first sign-in): rehydrate THIS
              // account's persisted queue by forcing a persist re-read.
              useUploadQueueStore.persist.rehydrate();
            }
            if (uid) useUploadQueueStore.setState({ ownerUserId: uid });
          } catch (e) {
            if (__DEV__) console.warn('[ctx] upload-queue account scoping failed (non-fatal):', e);
          }
        })();

        // Mark the version seed UNCONFIRMED for this sign-in, then seed from the
        // user's OWN profiles.security_version row — the exact column
        // check_authorization compares against. The legacy get_security_version RPC
        // hits /security/version (GLOBAL config version), which can differ from the
        // per-user profile version (e.g. after a device reset) — seeding the wrong
        // source made every poll report a mismatch and sign the user out ~36s after
        // login. If this fetch fails (transient network error) the seed stays
        // unconfirmed and checkRevocation self-heals instead of force-signing-out.
        seedRef.current = { confirmed: false, userId: s.user.id };
        (async () => {
          const ver = await fetchProfileSecurityVersion(s.user.id);
          if (ver === null) {
            authLog(`${event}: get_security_version failed (non-fatal) — seed unconfirmed`);
            return;
          }
          await setStoredSecurityVersion(s.user.id, ver);
          seedRef.current = { confirmed: true, userId: s.user.id };
          authLog(`${event}: seeded security_version=${ver} for user=${s.user.id}`);
        })();
      }

      if (event === 'TOKEN_REFRESHED') {
        authLog(`TOKEN_REFRESHED: new expires_at=${s?.expires_at ?? 'n/a'}`);
      }

      if (event === 'SIGNED_OUT') {
        authLog('SIGNED_OUT: session cleared — redirecting to login');
        lastSignedInAtRef.current = 0;
        seedRef.current = { confirmed: false, userId: null };
        // The next sign-in must never inherit this account's cached data.
        invalidateCreditCache();
        // Offline-library account isolation: drop the in-memory download
        // library so a subsequent login hydrates fresh (persisted rows are
        // owner-scoped and re-filter by the new user on hydration; DRM
        // licenses remain device-bound in the VdoCipher registry).
        resetOfflineLibraryForAccountSwitch();
        lastAccountUidRef.current = null;

        // ── Upload-queue account scoping ────────────────────────────────────
        // Deactivate the ownership provider FIRST so any in-flight async
        // callback that resolves after logout is rejected by the store's
        // cross-account guards, then drop the in-memory queue. The previous
        // account's persisted tasks remain under their own scoped key.
        setUploadQueueSessionProvider(() => null);
        try {
          useUploadQueueStore.getState().clearForAccountSwitch();
        } catch (e) {
          if (__DEV__) console.warn('[ctx] upload-queue clear on sign-out failed (non-fatal):', e);
        }
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
