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

// Continuous check interval — 30 seconds (balances security vs battery)
const CONTINUOUS_CHECK_INTERVAL_MS = 30_000;
// Dynamic config refresh — every 15 minutes
const CONFIG_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
// Network reconnect debounce — avoid hammering checks on flapping connections
const NETWORK_RECONNECT_DEBOUNCE_MS = 3_000;

interface SecurityContextValue {
  result:      SecurityCheckResult | null;
  checking:    boolean;
  threats:     SecurityThreat[];
  riskScore:   number;
  blocksLogin: boolean;
  blocksVideo: boolean;
  hasWarnings: boolean;
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

const SecurityContext = createContext<SecurityContextValue>({
  result:      null,
  checking:    false,
  threats:     [],
  riskScore:   0,
  blocksLogin: false,
  blocksVideo: false,
  hasWarnings: false,
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
  // Subscribers notified when a new blocking threat is detected during periodic check
  const blockingCbsRef     = useRef<Set<(r: SecurityCheckResult) => void>>(new Set());

  const { session } = useSession();

  // ── Pre-warm cache from SecureStore on mount (before any session) ──────────
  useEffect(() => {
    void prewarmSecurityConfig();
  }, []);

  const check = useCallback(async (deviceId?: string): Promise<SecurityCheckResult> => {
    if (checkRef.current) return result ?? DEFAULT_RESULT;
    checkRef.current = true;
    setChecking(true);
    try {
      const r = await runSecurityChecks();
      setResult(r);
      void logThreats(r.threats, r.policies, r.riskScore, deviceId);
      return r;
    } catch {
      const fallback = { ...DEFAULT_RESULT, policies: await getSecurityPolicies() };
      setResult(fallback);
      return fallback;
    } finally {
      checkRef.current = false;
      setChecking(false);
    }
  }, [result]);

  /**
   * Pre-video re-validation — called by video player screens before showing the player.
   * Bypasses the 30s periodic debounce and runs a fresh check immediately.
   * Returns true if video should be blocked.
   */
  const checkBeforeVideo = useCallback(async (): Promise<boolean> => {
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
  }, []);

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
  useEffect(() => {
    if (!session) {
      if (intervalRef.current)   { clearInterval(intervalRef.current);   intervalRef.current = null; }
      if (configTimerRef.current){ clearInterval(configTimerRef.current); configTimerRef.current = null; }
      void invalidateSecurityConfig();
      void clearAppAttestKey();
      return;
    }

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
          void check();
        }
        lastBuildRef.current = currentBuild;

        // ── Return from external app ──────────────────────────────────────────
        // Trigger a security re-check whenever we come back from background,
        // unless we just started (wasActive was already false at first render).
        if (!wasActive) {
          void runPeriodicCheck();
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
          void runPeriodicCheck();
        }, NETWORK_RECONNECT_DEBOUNCE_MS);
      }
    });

    void checkAndRefreshSecurityConfig();

    const runPeriodicCheck = async () => {
      if (!appActiveRef.current || checkRef.current) return;
      try {
        const r = await runSecurityChecks();
        setResult(r);
        void logThreats(r.threats, r.policies, r.riskScore);
        if (r.blocksLogin || r.blocksVideo) {
          blockingCbsRef.current.forEach((cb) => cb(r));
        }
      } catch { /* non-fatal */ }
    };

    const refreshDynamicConfig = async () => {
      if (!appActiveRef.current) return;
      await checkAndRefreshSecurityConfig();
    };

    intervalRef.current    = setInterval(() => { void runPeriodicCheck(); },    CONTINUOUS_CHECK_INTERVAL_MS);
    configTimerRef.current = setInterval(() => { void refreshDynamicConfig(); }, CONFIG_REFRESH_INTERVAL_MS);

    return () => {
      appStateSub.remove();
      netUnsub();
      if (netReconnectTimer.current) clearTimeout(netReconnectTimer.current);
      if (intervalRef.current)   { clearInterval(intervalRef.current);   intervalRef.current = null; }
      if (configTimerRef.current){ clearInterval(configTimerRef.current); configTimerRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id]);

  const r = result ?? DEFAULT_RESULT;

  return (
    <SecurityContext.Provider value={{
      result,
      checking,
      threats:             r.threats,
      riskScore:           r.riskScore,
      blocksLogin:         r.blocksLogin,
      blocksVideo:         r.blocksVideo,
      hasWarnings:         r.hasWarnings,
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
