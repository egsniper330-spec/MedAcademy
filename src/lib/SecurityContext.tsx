/**
 * SecurityContext — provides security check results app-wide.
 *
 * Phase 1: run once at login, cache result for the session.
 * Phase 2: continuous background monitoring every 30s while authenticated.
 *   - Periodic scheduler runs while the user has an active session.
 *   - Scheduler pauses when app is in background (AppState).
 *   - Any new blocking threat during the session triggers immediate redirect.
 *   - Play Integrity checks are rate-limited to every 10 min (quota safety).
 *
 * Runtime re-validation triggers (hardened, v427):
 *   - Before every protected video playback (checkBeforeVideo)
 *   - After returning from an external app (AppState active transition)
 *   - After network reconnect (NWPathMonitor — iOS / NetInfo — Android)
 *   - After an app update is detected (build number change on active)
 *
 * Super Admin bypass (session-scoped):
 *   - When the backend-verified profile role is 'super_admin', all security
 *     enforcement is disabled for that session only.
 *   - The bypass is NEVER stored in persistent storage and is NEVER derived
 *     from a client-side variable alone — it requires a valid Supabase session
 *     AND a profile row whose role column equals 'super_admin'.
 *   - On logout, session expiry, or any auth change the bypass is automatically
 *     cleared because the profile store is also cleared.
 */
import React, {
  createContext, useContext, useState, useCallback, useRef, useEffect,
} from 'react';
import { AppState, Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import Constants from 'expo-constants';
import {
  runSecurityChecks, logThreats, getSecurityPolicies, clearAppAttestKey,
  type SecurityCheckResult, type SecurityThreat,
  type DetectionType, type PolicyAction,
} from '@/lib/security';
import {
  checkAndRefreshSecurityConfig,
  prewarmSecurityConfig,
  invalidateSecurityConfig,
} from '@/lib/securityConfigService';
import {
  onNativeJailbreakDetected,
  onNativeDebuggerAttached,
  onNativeIntegrityFailed,
} from '@/lib/nativeSecurity';
import { useSession } from '@/ctx';
import { useProfileStore } from '@/lib/store';

// Continuous check interval — 30 seconds (balances security vs battery)
const CONTINUOUS_CHECK_INTERVAL_MS = 30_000;
// Dynamic config refresh — every 15 minutes
const CONFIG_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
// Network reconnect debounce — avoid hammering checks on flapping connections
const NETWORK_RECONNECT_DEBOUNCE_MS = 3_000;
// VPN-specific re-check: after VPN detected, re-check on every foreground to
// clear the stale threat once the user disconnects the VPN.
const VPN_RECHECK_DEBOUNCE_MS = 1_500;

interface SecurityContextValue {
  result:      SecurityCheckResult | null;
  checking:    boolean;
  threats:     SecurityThreat[];
  riskScore:   number;
  blocksLogin: boolean;
  blocksVideo: boolean;
  hasWarnings: boolean;
  /**
   * True when the currently authenticated session belongs to a verified Super Admin.
   * Derived from the backend-loaded profile role ('super_admin') — never from
   * a client-side variable or local storage. Cleared automatically on logout.
   * Consumers (FLAG_SECURE, screenshot protection, content protection) use this
   * to lift restrictions for the Super Admin session only.
   */
  isSuperAdmin: boolean;
  /** Run all security checks. Returns the result. */
  check:       (deviceId?: string) => Promise<SecurityCheckResult>;
  /**
   * Run a targeted security check immediately before video playback.
   * Returns true if playback should be blocked.
   * Call from the video player screen before showing the player.
   */
  checkBeforeVideo: () => Promise<boolean>;
  /** Invalidate cached result so next check re-runs. */
  reset:       () => void;
  /** Called by _layout to notify context when a new blocking threat is found during periodic check */
  onNewBlockingThreat: ((cb: (r: SecurityCheckResult) => void) => () => void) | null;
}

const DEFAULT_RESULT: SecurityCheckResult = {
  threats:     [],
  riskScore:   0,
  policies:    {} as Record<DetectionType, PolicyAction>,
  blocksLogin: false,
  blocksVideo: false,
  hasWarnings: false,
};

// ── Super Admin bypass result ─────────────────────────────────────────────────
// When a verified Super Admin session is active, return this result so all
// security enforcement is silently bypassed. No threats, no blocks.
const SUPERADMIN_BYPASS_RESULT: SecurityCheckResult = {
  threats:     [],
  riskScore:   0,
  policies:    {} as Record<DetectionType, PolicyAction>,
  blocksLogin: false,
  blocksVideo: false,
  hasWarnings: false,
};

const SecurityContext = createContext<SecurityContextValue>({
  result:      null,
  checking:    false,
  threats:     [],
  riskScore:   0,
  blocksLogin: false,
  blocksVideo: false,
  hasWarnings: false,
  isSuperAdmin: false,
  check:            async () => DEFAULT_RESULT,
  checkBeforeVideo: async () => false,
  reset:       () => {},
  onNewBlockingThreat: null,
});

export function SecurityProvider({ children }: { children: React.ReactNode }) {
  const [result, setResult]     = useState<SecurityCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const checkRef           = useRef(false);
  const intervalRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const configTimerRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const appActiveRef       = useRef(true);
  const lastBuildRef       = useRef<string | null>(null);
  const netReconnectTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  // VPN re-check: set when a VPN threat is currently active so every foreground
  // transition triggers a fresh check (clears stale threat once VPN disconnected).
  const vpnRecheckTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasActiveVpnThreat = useRef(false);
  // Subscribers notified when a new blocking threat is detected during periodic check
  const blockingCbsRef     = useRef<Set<(r: SecurityCheckResult) => void>>(new Set());

  const { session } = useSession();

  // ── Super Admin bypass ────────────────────────────────────────────────────
  // Authoritative role comes from the backend-loaded profile (Supabase DB row),
  // never from session JWT user_metadata or any client-side variable.
  // The profile is loaded by (app)/_layout.tsx via getProfile() and stored in
  // useProfileStore. It is null when no session exists (profile is cleared on
  // SIGNED_OUT in clearProfile()). This means:
  //   • No session → profile null → isSuperAdmin false → all protections active.
  //   • Student/Doctor/Admin session → role !== 'super_admin' → protections active.
  //   • Super Admin session → role === 'super_admin' → bypass active.
  //   • After logout → clearProfile() → role gone → bypass immediately revoked.
  const { profile } = useProfileStore();
  const isSuperAdmin = profile?.role === 'super_admin';

  // ── Pre-warm cache from SecureStore on mount (before any session) ──────────
  useEffect(() => {
    void prewarmSecurityConfig();
  }, []);

  const check = useCallback(async (deviceId?: string): Promise<SecurityCheckResult> => {
    // ── Super Admin bypass ────────────────────────────────────────────────────
    // Short-circuit ALL security checks for verified Super Admin sessions.
    // Role is read from the backend-loaded profile, not from any client-side flag.
    if (isSuperAdmin) {
      if (__DEV__) console.log('[SecurityContext] Super Admin bypass active — skipping security checks');
      setResult(SUPERADMIN_BYPASS_RESULT);
      hasActiveVpnThreat.current = false;
      return SUPERADMIN_BYPASS_RESULT;
    }
    if (checkRef.current) {
      console.log('[SecurityContext][Stage-6] check() skipped — already in progress, returning cached result');
      return result ?? DEFAULT_RESULT;
    }
    checkRef.current = true;
    setChecking(true);
    console.log('[SecurityContext][Stage-6] check() ▶ starting runSecurityChecks()');
    try {
      const r = await runSecurityChecks();
      console.log('[SecurityContext][Stage-6] setResult() with threats=', r.threats.map(t => t.type).join(',') || 'none',
        'blocksLogin=', r.blocksLogin, 'blocksVideo=', r.blocksVideo, 'riskScore=', r.riskScore);
      setResult(r);
      // Track whether a VPN threat is currently active for stale-state monitoring
      hasActiveVpnThreat.current = r.threats.some(t => t.type === 'vpn_detected');
      void logThreats(r.threats, r.policies, r.riskScore, deviceId);
      return r;
    } catch (e) {
      console.error('[SecurityContext][Stage-6] ❌ runSecurityChecks() threw — falling back to DEFAULT_RESULT:', e);
      const fallback = { ...DEFAULT_RESULT, policies: await getSecurityPolicies() };
      setResult(fallback);
      return fallback;
    } finally {
      checkRef.current = false;
      setChecking(false);
    }
  }, [isSuperAdmin, result]);

  /**
   * Pre-video re-validation — called by video player screens before showing the player.
   * Bypasses the 30s periodic debounce and runs a fresh check immediately.
   * Returns true if video should be blocked.
   */
  const checkBeforeVideo = useCallback(async (): Promise<boolean> => {
    // Super Admin sessions are never blocked from video playback
    if (isSuperAdmin) {
      if (__DEV__) console.log('[SecurityContext] Super Admin bypass — video always allowed');
      return false;
    }
    try {
      const r = await runSecurityChecks();
      setResult(r);
      void logThreats(r.threats, r.policies, r.riskScore);
      // Fire blocking callbacks for both login-blocking and video-blocking threats
      // so _layout.tsx can redirect even when checkBeforeVideo is the trigger.
      if (r.blocksLogin || r.blocksVideo) blockingCbsRef.current.forEach((cb) => cb(r));
      return r.blocksVideo;
    } catch {
      return false; // fail-open for non-security errors (network down etc.)
    }
  }, [isSuperAdmin]);

  const reset = useCallback(() => {
    setResult(null);
    checkRef.current = false;
  }, []);

  const onNewBlockingThreat = useCallback((cb: (r: SecurityCheckResult) => void) => {
    blockingCbsRef.current.add(cb);
    return () => { blockingCbsRef.current.delete(cb); };
  }, []);

  // ── Native iOS security event bridge → unified logging pipeline ───────────
  // Subscribe to IOSSecurityModule events; map each to the existing logSecurityEvent
  // infrastructure so iOS detections appear identically to Android detections in the DB.
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const unsubJailbreak  = onNativeJailbreakDetected(() => { void check(); });
    const unsubDebugger   = onNativeDebuggerAttached(() => { void check(); });
    const unsubIntegrity  = onNativeIntegrityFailed(() => { void check(); });
    return () => { unsubJailbreak(); unsubDebugger(); unsubIntegrity(); };
  // Subscribe once on mount — check callback is stable
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Continuous background scheduler + runtime re-validation ───────────────
  // runPeriodicCheck is placed in a stable ref so the AppState listener (which
  // is registered once and never re-registered) always calls the latest version
  // — this is the root-cause fix for the stale-closure VPN re-check bug where
  // the foreground handler held an old closure that never saw hasActiveVpnThreat.
  const runPeriodicCheckRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    if (!session) {
      if (intervalRef.current)   { clearInterval(intervalRef.current);   intervalRef.current = null; }
      if (configTimerRef.current){ clearInterval(configTimerRef.current); configTimerRef.current = null; }
      void invalidateSecurityConfig();
      void clearAppAttestKey();
      return;
    }

    // ── runPeriodicCheck ──────────────────────────────────────────────────────
    // Defined inside the effect so it closes over the current isSuperAdmin value.
    // Written into a stable ref so the AppState / network handlers (registered
    // once) always invoke the most-recent version without stale-closure issues.
    const runPeriodicCheck = async () => {
      if (!appActiveRef.current || checkRef.current) return;
      // Super Admin bypass: no checks needed during the bypass window
      if (isSuperAdmin) {
        if (__DEV__) console.log('[SecurityContext] Super Admin bypass — skipping periodic check');
        setResult(SUPERADMIN_BYPASS_RESULT);
        hasActiveVpnThreat.current = false;
        return;
      }
      try {
        const r = await runSecurityChecks();
        setResult(r);
        // Update VPN threat tracking so foreground re-checks are scheduled correctly
        hasActiveVpnThreat.current = r.threats.some(t => t.type === 'vpn_detected');
        void logThreats(r.threats, r.policies, r.riskScore);
        if (r.blocksLogin || r.blocksVideo) {
          blockingCbsRef.current.forEach((cb) => cb(r));
        }
      } catch { /* non-fatal */ }
    };
    // Keep the stable ref up-to-date with the latest closure
    runPeriodicCheckRef.current = runPeriodicCheck;

    // Track foreground/background; trigger re-validation on return from external app
    const appStateSub = AppState.addEventListener('change', (nextState) => {
      const wasActive = appActiveRef.current;
      appActiveRef.current = nextState === 'active';

      if (nextState === 'active') {
        void checkAndRefreshSecurityConfig();

        // ── Post-update detection ─────────────────────────────────────────────
        // If the build number changed while backgrounded, this is an app update.
        // Run a full security check and also clear App Attest key (new build =
        // new attestation required).
        const currentBuild = Constants.expoConfig?.version ?? null;
        if (lastBuildRef.current && currentBuild && lastBuildRef.current !== currentBuild) {
          void clearAppAttestKey();
          void runPeriodicCheckRef.current();
        }
        lastBuildRef.current = currentBuild;

        // ── Return from external app / VPN disconnect detection ───────────────
        // Always re-check on foreground when a VPN threat is active — the user
        // may have just disconnected the VPN and we must clear the stale state.
        // Also re-check whenever returning from background for the first time.
        // FIX: use runPeriodicCheckRef.current so the AppState handler always
        // calls the latest closure (avoids stale-closure VPN re-check bug).
        if (!wasActive || hasActiveVpnThreat.current) {
          // Small debounce so the network stack has settled after resume
          if (vpnRecheckTimer.current) clearTimeout(vpnRecheckTimer.current);
          vpnRecheckTimer.current = setTimeout(() => {
            void runPeriodicCheckRef.current();
          }, hasActiveVpnThreat.current ? VPN_RECHECK_DEBOUNCE_MS : 0);
        }
      }
    });

    // Record the build number when the session starts so we can detect an update
    lastBuildRef.current = Constants.expoConfig?.version ?? null;

    // ── Network reconnect trigger ──────────────────────────────────────────
    // Run a security check after a genuine reconnect (offline → online transition).
    // Debounced by 3 s to avoid thrashing on flapping connections.
    const netUnsub = NetInfo.addEventListener((state) => {
      if (state.isConnected && appActiveRef.current) {
        if (netReconnectTimer.current) clearTimeout(netReconnectTimer.current);
        netReconnectTimer.current = setTimeout(() => {
          void runPeriodicCheckRef.current();
        }, NETWORK_RECONNECT_DEBOUNCE_MS);
      }
    });

    void checkAndRefreshSecurityConfig();

    const refreshDynamicConfig = async () => {
      if (!appActiveRef.current) return;
      await checkAndRefreshSecurityConfig();
    };

    intervalRef.current    = setInterval(() => { void runPeriodicCheckRef.current(); }, CONTINUOUS_CHECK_INTERVAL_MS);
    configTimerRef.current = setInterval(() => { void refreshDynamicConfig(); }, CONFIG_REFRESH_INTERVAL_MS);

    return () => {
      appStateSub.remove();
      netUnsub();
      if (netReconnectTimer.current) clearTimeout(netReconnectTimer.current);
      if (vpnRecheckTimer.current)   clearTimeout(vpnRecheckTimer.current);
      if (intervalRef.current)   { clearInterval(intervalRef.current);   intervalRef.current = null; }
      if (configTimerRef.current){ clearInterval(configTimerRef.current); configTimerRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id, isSuperAdmin]);

  // When Super Admin bypass is active, always expose a clean zero-threat result
  // regardless of what runSecurityChecks() may have returned previously.
  const r = isSuperAdmin ? SUPERADMIN_BYPASS_RESULT : (result ?? DEFAULT_RESULT);

  return (
    <SecurityContext.Provider value={{
      result:              isSuperAdmin ? SUPERADMIN_BYPASS_RESULT : result,
      checking,
      threats:             r.threats,
      riskScore:           r.riskScore,
      blocksLogin:         r.blocksLogin,
      blocksVideo:         r.blocksVideo,
      hasWarnings:         r.hasWarnings,
      isSuperAdmin,
      check,
      checkBeforeVideo,
      reset,
      onNewBlockingThreat,
    }}>
      {children}
    </SecurityContext.Provider>
  );
}

export function useSecurity() {
  return useContext(SecurityContext);
}
