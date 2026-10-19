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
 * Super Admin bypass (session-scoped):   *   - When the backend-verified profile role is 'super_admin', all security
   *     enforcement is disabled for that session only.

 *   - The bypass is NEVER stored in persistent storage and is NEVER derived
 *     from a client-side variable alone — it requires a valid PHP backend session
 *     AND a profile row whose role column equals 'super_admin'.
 *   - On logout, session expiry, or any auth change the bypass is automatically
 *     cleared because the profile store is also cleared.
 */
import React, {
  createContext, useContext, useState, useCallback, useRef, useEffect,
} from 'react';
import { AppState, Platform, NativeEventEmitter, NativeModules } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import Constants from 'expo-constants';
import {
  runSecurityChecks, logThreats, getSecurityPolicies, clearAppAttestKey,
  invalidatePolicyCache, SECURITY_UNVERIFIED_WEIGHT,
  type SecurityCheckResult, type SecurityThreat,
  type DetectionType, type PolicyAction,
} from '@/lib/security';
import {
  resolveGatePhase,
  resolveSecurityGateState,
  resolveBackgroundResumeGate,
  acceptsResumeVerification,
  resolveNetworkAccessState,
  hasConnectionFinding,
  type NetworkAccessState,
  canClearOverlayBlock,
  canClearMultiWindowBlock,
  isProhibitedWindowMode,
  isResumeVerificationOverdue,
  RESUME_VERIFICATION_TIMEOUT_MS,
  type GatePhase,
  type SecurityGateState,
} from '@/lib/securityStateModel';
import {
  checkAndRefreshSecurityConfig,
  prewarmSecurityConfig,
  invalidateSecurityConfig,
} from '@/lib/securityConfigService';
import {
  onNativeJailbreakDetected,
  onNativeDebuggerAttached,
  onNativeIntegrityFailed,
  onNativeObscuredChanged,
  isNativeWindowObscured,
  enableNativeOverlayProtection,
  onNativeWindowModeChanged,
  getNativeWindowMode,
  enableNativeWindowModeMonitoring,
} from '@/lib/nativeSecurity';
import { isVpnWhitelistKnownNonEmpty } from '@/lib/security';
import {
  engageSecurityLock,
  releaseSecurityLock,
  releaseAllSecurityLocks,
  isSecurityLocked,
  getSecurityLockState,
  subscribeSecurityLock,
  markNativeVpnSignal,
  markResumeHoldEngaged,
  markResumeEvaluationStarted,
  markResumeVerdictResolved,
  markResumeVerificationOverdue,
  type SecurityLockState,
} from '@/lib/securityLock';
import { useSession } from '@/ctx';
import { useProfileStore } from '@/lib/store';

/** Lock holder names — one per independent signal source (they compose). */
const LOCK_SRC_VERDICT    = 'verdict';      // authoritative policy decision
const LOCK_SRC_NATIVE_VPN = 'native-vpn';   // fast native TRANSPORT_VPN signal
/** Live obscured-window / overlay signal (see the Android security module). */
const LOCK_SRC_OVERLAY    = 'overlay';
/**
 * Prohibited window mode (split-screen / other multi-window mode, or our own
 * picture-in-picture) reported by the platform for THIS app. A window-state
 * cause, not a policy finding — kept as its own lock source so its copy, its
 * release rule and its evidence stay independent of the overlay signal.
 */
const LOCK_SRC_WINDOW_MODE = 'window-mode';
/** The app left the foreground and has not yet re-verified after resuming. */
const LOCK_SRC_BACKGROUND = 'background-resume';

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
   * TRUE while the latest evaluation is not yet confirmed (initial session
   * start, or a foreground re-check forced by reset()).
   *
   * STARTUP-FLASH CONTRACT (fixed): pending evaluation is NOT a violation.
   * The global context serves the NEUTRAL start-up result (no threats, no
   * blocks) until a COMPLETED evaluation lands, so no consumer can render a
   * "Security Block Active" page from an unverified state. The fail-closed
   * UNKNOWN sentinel survives ONLY as the return value of check() for
   * caller-scoped sensitive actions (login, pre-video re-validation), where
   * an in-flight evaluation must keep the ACTION gated — never as global UI
   * state.
   */
  evaluating:  boolean;
  /**
   * TRUE once at least one COMPLETED evaluation has been published for this
   * session (or Super Admin bypass is active). Drives the gate's phase
   * (resolveGatePhase): no verdict → 'pending' → the gate never mounts.
   */
  hasVerdict:  boolean;
  /** Authoritative gate visibility phase (pending ≠ blocked). */
  phase:       GatePhase;
  /**
   * True when the currently authenticated session belongs to a verified Super Admin.
   * Derived from the backend-loaded profile role ('super_admin') — never from
   * a client-side variable or local storage. Cleared automatically on logout.
   * Consumers (FLAG_SECURE, screenshot protection, content protection) use this
   * to lift restrictions for the Super Admin session only.
   */
  isSuperAdmin: boolean;
  /**
   * CENTRAL SECURITY LOCK — TRUE while ANY signal holds the app locked.
   * While locked: protected requests are refused/aborted at the transport and
   * playback is stopped immediately. Consumers that PAUSE playback subscribe
   * to the lock directly (registerPlaybackStopper) rather than polling this.
   */
  securityLocked: boolean;
  /**
   * NETWORK LOCK — TRUE while the app's OWN traffic is suspended (see
   * NETWORK_LOCK_SCOPE in securityStateModel.ts for exactly what that covers
   * and what it cannot: a WebView/YouTube connection is not in scope).
   *
   * Same underlying state as `securityLocked`; this is the name consumers use
   * when the question is "may the app talk to the network right now?".
   */
  networkLocked: boolean;
  /** `NETWORK_LOCKED` while the lock is held, `NETWORK_OPEN` otherwise. */
  networkAccessState: NetworkAccessState;
  /**
   * TRUE while an AUTHORITATIVE (policy-verdict) block holds the lock. Screens
   * use this to UNMOUNT/destroy the native player — a soft (provisional)
   * containment only pauses it.
   */
  securityLockHard: boolean;
  /**
   * THE single authoritative gate state (securityStateModel.ts): one closed
   * vocabulary covering policy blocks, the live overlay signal, the
   * background→resume hold, in-flight checks and the allowed case. Consumers
   * render from this instead of re-deriving a boolean from several flags.
   */
  gateState: SecurityGateState;
  /** A live obscured-window/overlay signal holds the gate. */
  overlayBlocked: boolean;
  /** The platform reports this app in a prohibited multi-window mode. */
  multiWindowBlocked: boolean;
  /**
   * The last window mode the platform reported for this app:
   * 'fullscreen' | 'multi_window' | 'picture_in_picture' | 'unknown'.
   * Evidence for the gate copy; 'unknown' means "not measurable here".
   */
  windowMode: string;
  /** The app is backgrounded, or resumed and not yet re-verified. */
  backgroundBlocked: boolean;
  /**
   * Re-verify security on demand (the overlay / resume recheck control).
   * Re-reads the native obscured signal, runs a fresh evaluation, and bumps
   * the resume token so the released state is provably post-request. It can
   * only REQUEST a recheck — the gate clears solely on a clean platform signal
   * plus a clean verdict, so the warning cannot be dismissed away.
   */
  verifySecurity: () => Promise<void>;
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

// ── Fail-closed UNKNOWN result (CALLER-SCOPED) ──────────────────────────────
// Returned BY check() to the CALLER while the evaluation it triggered has not
// CONFIRMED a verdict (fresh login, superseded check). Deliberately NOT the
// all-clear: an attacker must never reach "UNKNOWN → sensitive action
// allowed". This result is NEVER published as global context state — the
// startup-flash fix removed exactly that publication, which used to mount the
// "Security Block Active / Risk Score: 10" page on every cold start.
//
// STATE-SYNC FIX (historical): the sentinel event is 'security_unverified' —
// an honest "the check is running" state. The previous sentinel reused
// 'tamper_detected', so EVERY cold start briefly displayed "App Integrity
// Compromised" on the OFFICIAL APK. It never reaches the backend logger and
// never masquerades as a device finding.
const BLOCKING_UNKNOWN_RESULT: SecurityCheckResult = {
  threats: [{ type: 'security_unverified', detectionMethod: 'Security evaluation in progress (fail-closed)', detected: true }],
  riskScore:   SECURITY_UNVERIFIED_WEIGHT,
  policies:    {} as Record<DetectionType, PolicyAction>,
  blocksLogin: true,
  blocksVideo: true,
  hasWarnings: false,
};

// ── Neutral start-up result (global pre-verdict state) ───────────────────────
// Served app-wide while NO completed evaluation exists (cold start, login
// screen). Deliberately NOT blocking: an evaluation in progress is not a
// security violation, and showing "Security Block Active / Risk Score: 10"
// during ordinary startup was the reported bug. Sensitive actions stay
// independently gated: sign-in calls check() (whose caller-scoped fallback IS
// fail-closed) and every video surface re-validates via checkBeforeVideo().
const NEUTRAL_STARTUP_RESULT: SecurityCheckResult = {
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
  /**
   * STARTUP-FLASH CONTRACT: during evaluation (fresh session, foreground
   * re-check) the context serves the LAST VERDICT when one exists, or the
   * NEUTRAL start-up result when none does — never a synthetic violation.
   * A verified block is held by the gate's sticky set (nextStickyTypes), so
   * the BLOCKED → CHECKING → TEMP-ALLOWED race stays closed WITHOUT
   * fabricating a global blocking sentinel for unverified states.
   */
  evaluating:  false,
  hasVerdict:  false,
  phase:       'pending',
  threats:     [],
  riskScore:   0,
  blocksLogin: false,
  blocksVideo: false,
  hasWarnings: false,
  isSuperAdmin: false,
  securityLocked:   false,
  networkLocked:    false,
  networkAccessState: 'NETWORK_OPEN',
  securityLockHard: false,
  gateState:        'CHECKING',
  overlayBlocked:   false,
  multiWindowBlocked: false,
  windowMode:       'unknown',
  backgroundBlocked: false,
  verifySecurity:   async () => {},
  check:            async () => DEFAULT_RESULT,
  checkBeforeVideo: async () => false,
  reset:       () => {},
  onNewBlockingThreat: null,
});

export function SecurityProvider({ children }: { children: React.ReactNode }) {
  const [result, setResult]     = useState<SecurityCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  // NOTE: the old single-flight guard (`checkRef`) is gone. It REJECTED a request
  // that arrived while an evaluation ran, which is exactly how the post-resume
  // re-check used to be dropped. runEvaluation now coalesces and CHAINS instead;
  // in-flight state lives in `inFlightEvaluationRef` (declared with the queue).
  // ── Probe generation guard (stale-result race fix) ─────────────────────────
  // Multiple entry points (periodic tick, foreground transition, network
  // change, native VPN callback, pre-video re-validation) can start security
  // checks concurrently. Without ordering, an OLDER slow check (e.g. a probe
  // that spends its full timeout on a weak network) could land AFTER a newer
  // successful one and overwrite the fresh verdict with stale findings — the
  // classic "failure result after successful result" race. Every runner tags
  // its invocation with a monotonically increasing generation; only the
  // newest generation is allowed to publish its result.
  const checkGenRef = useRef(0);

  // ── Native-signal sequence → stale-verdict containment guard ──────────────
  // The native TRANSPORT_VPN callback engages PROVISIONAL containment at once,
  // before any network-bound check can decide whether the VPN is allowed. The
  // authoritative verdict then either upgrades that to a HARD lock or releases
  // it (an admin may whitelist a corporate VPN).
  //
  // THE RACE: a check that STARTED before the VPN signal can land a
  // non-blocking verdict AFTER containment engaged. The previous code released
  // the provisional holder unconditionally, silently dropping containment while
  // the VPN was still up — the exact interception window this feature exists to
  // close. So: every native signal bumps `nativeSignalSeqRef`; every published
  // verdict records the sequence that was current when ITS CHECK STARTED. A
  // verdict may only release the provisional holder if it started at or after
  // the newest signal, i.e. it actually observed that VPN state. A stale
  // verdict keeps containment, and the 1.5s VPN re-check lands a fresh one.
  const nativeSignalSeqRef  = useRef(0);
  const verdictNativeSeqRef = useRef(0);
  //  Re-runs the verdict effect when a NEW verdict lands with identical block
  //  flags and threat types — without it the effect could not re-evaluate the
  //  provisional holder and a legitimately-allowed VPN would stay locked.
  const [verdictSerial, setVerdictSerial] = useState(0);

  const runGuardedCheck = useCallback(async (): Promise<SecurityCheckResult | null> => {
    const gen = ++checkGenRef.current;
    //  Snapshot BEFORE the probes run: a VPN signal arriving mid-check is newer
    //  than this verdict's observation window and must not be cleared by it.
    const nativeSeqAtStart = nativeSignalSeqRef.current;
    //  Same idea for the resume gate: record which resume this evaluation is
    //  answering. Set BEFORE the probes so a background transition during the
    //  check makes this result ineligible to release the hold.
    evaluationStartTokenRef.current = resumeTokenRef.current;
    const r = await runSecurityChecks();
    if (gen !== checkGenRef.current) {
      if (__DEV__) console.log('[SecurityContext] discarding stale security result (gen superseded)');
      return null;
    }
    verdictNativeSeqRef.current = nativeSeqAtStart;
    setVerdictSerial((s) => s + 1);
    return r;
  }, []);

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
  // Authoritative role comes from the backend-loaded profile,
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

  // ── Central security lock — observable state ─────────────────────────────
  // The lock itself lives in a pure module (securityLock.ts) so non-React code
  // (the transport) can consult it synchronously. React mirrors it here for
  // rendering. subscribeSecurityLock fires immediately with the current state,
  // so a lock engaged before mount is never missed.
  const [lockState, setLockState] = useState<SecurityLockState>(getSecurityLockState);
  const diagnosticsRef = useRef<{ nativeVPNSignalTimeMs?: number; lockEngagedTimeMs?: number }>({});
  const [diagnostics, setDiagnostics] = useState<{ nativeVPNSignalTimeMs?: number; lockEngagedTimeMs?: number }>({});
  useEffect(() => subscribeSecurityLock(setLockState), []);

  // ── Background → resume gate bookkeeping (pure model: securityStateModel) ─
  // `resumeTokenRef`        — bumped on EVERY transition into the foreground.
  // `evaluationStartTokenRef` — the token live when the running evaluation STARTED.
  // A verdict may only release the background hold when the evaluation that
  // produced it began at or after the resume it is being used to clear
  // (acceptsResumeVerification). Without this, a check started BEFORE the
  // resume — or before a rapid second background — could land afterwards and
  // unblock the app on evidence that predates the state it claims to verify.
  const resumeTokenRef = useRef(0);
  const evaluationStartTokenRef = useRef(0);
  const backgroundHeldRef = useRef(false);

  // ── COALESCED EVALUATION QUEUE (the resume-latency fix) ────────────────────
  // ROOT CAUSE of "sometimes instant, sometimes tens of seconds": only ONE
  // evaluation could run at a time (`checkRef`), and a request that arrived
  // while one was running was silently DROPPED rather than queued. A resume that
  // coincided with an in-flight evaluation therefore (a) discarded that
  // evaluation's verdict — correct, it predates the resume — and (b) never
  // started its replacement, so the hold waited for the next 30 s periodic tick.
  // The user's Continue control could not help either: it went through the same
  // in-flight guard and returned without running anything.
  //
  // Now: one evaluation still runs at a time (the probes are native/network
  // work and the transport is locked anyway), but a request that arrives mid-run
  // is REMEMBERED and started the instant the current run finishes — chained,
  // not dropped, with no timer and no polling.
  const inFlightEvaluationRef = useRef<Promise<SecurityCheckResult | null> | null>(null);
  const queuedEvaluationRef = useRef<string | null>(null);
  /** Monotonic ms the current resume verification was requested (null = none). */
  const resumePendingSinceRef = useRef<number | null>(null);
  const resumeWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumeRetriedRef = useRef(false);
  const runEvaluationRef = useRef<(reason: string) => Promise<SecurityCheckResult | null>>(
    async () => null,
  );

  // ── Overlay gate bookkeeping ────────────────────────────────────────────
  // `overlaySignalRef`      — the native obscured-window belief (live).
  // `overlayEngagedSerialRef` — the verdict serial current when the overlay
  //   lock engaged. The lock clears only when the signal is CLEAR *and* a
  //   NEWER completed verdict exists (canClearOverlayBlock) — so dismissing or
  //   ignoring the warning can never clear it.
  const overlaySignalRef = useRef(false);
  const overlayEngagedSerialRef = useRef(-1);
  // ── Multi-window gate bookkeeping ───────────────────────────────────────
  // `windowModeRef`           — the platform's last reported window mode.
  // `windowModeEngagedSerialRef` — the verdict serial current when the lock
  //   engaged; the lock clears only when the platform reports FULL SCREEN *and*
  //   a NEWER completed verdict exists (canClearMultiWindowBlock). Both are read
  //   synchronously from the lock module, because React state is stale inside
  //   the native event listener.
  const windowModeRef = useRef<string>('unknown');
  // The mode the CURRENT hold is about. Kept separately from the live reading so
  // the blocking screen keeps describing the PROHIBITED mode while the platform
  // already reports full screen but the fresh verdict is still pending (the
  // copy must not flip to "you are fine" before the block is actually released).
  const windowModeEngagedModeRef = useRef<string>('multi_window');
  const windowModeEngagedSerialRef = useRef(-1);
  const verdictSerialRef = useRef(0);

  /**
   * Engage the background/resume hold. Hard, so screens UNMOUNT the native
   * player (a soft hold would only pause it), and idempotent.
   *
   * Containment is the ONLY thing this does: it no longer implies a full-screen
   * page (see rendersBlockScreen in the state model). The shell returns at once,
   * protected operations stay refused until a clean post-resume verdict.
   */
  const enterBackgroundHold = useCallback((why: string) => {
    if (isSuperAdmin) return;
    if (backgroundHeldRef.current) return;
    backgroundHeldRef.current = true;
    if (__DEV__) console.log('[SecurityContext] background hold engaged (' + why + ')');
    engageSecurityLock(LOCK_SRC_BACKGROUND, { hard: true });
  }, [isSuperAdmin]);

  /**
   * Release the background hold ONLY for a verdict that began at or after the
   * current resume and found nothing blocking. Called from every publish path
   * (session start, periodic, foreground resume, pre-video, manual recheck), so
   * whichever evaluation finishes first is the one that can clear it.
   */
  const maybeReleaseBackgroundHold = useCallback((result: SecurityCheckResult) => {
    if (!backgroundHeldRef.current) return;
    if (!acceptsResumeVerification({
      evaluationStartedToken: evaluationStartTokenRef.current,
      liveResumeToken:       resumeTokenRef.current,
    })) {
      if (__DEV__) console.log('[SecurityContext] holding background lock — verdict predates the current resume');
      return;
    }
    const stillBlocked = resolveBackgroundResumeGate({
      foreground:          appActiveRef.current,
      verifiedSinceResume: true,
      blocking:            result.blocksLogin || result.blocksVideo,
    });
    if (stillBlocked) return; // the policy verdict holder keeps the app blocked
    backgroundHeldRef.current = false;
    // The resume verification is DECIDED. Record its measured duration, drop the
    // pending marker and disarm the watchdog — a resolved verification must never
    // leave a timer that could later "retry" against a released lock.
    resumePendingSinceRef.current = null;
    if (resumeWatchdogRef.current) {
      clearTimeout(resumeWatchdogRef.current);
      resumeWatchdogRef.current = null;
    }
    markResumeVerdictResolved();
    if (__DEV__) console.log('[SecurityContext] background hold cleared — post-resume verification passed');
    releaseSecurityLock(LOCK_SRC_BACKGROUND);
  }, []);

  /**
   * PUBLISH a completed evaluation to the whole app: the authoritative verdict
   * state, the blocking callbacks, the threat log, and the background/resume
   * hold release.
   *
   * ROOT-CAUSE FIX (resume stuck for up to a full period): the resume
   * verification used to run an evaluation and DROP its result — only `check()`
   * and `runPeriodicCheck` published. A clean post-resume verdict therefore
   * could not release the hold, and the app stayed network-locked (protected
   * requests refused / queued, playback stopped) until the NEXT 30 s periodic
   * tick happened to publish one. Every trigger now shares this single publish
   * path, so a resume is decided by the resume's own verification.
   */
  const publishVerdict = useCallback((r: SecurityCheckResult) => {
    setResult(r);
    // Keep the VPN threat flag current so foreground re-checks are scheduled
    // correctly (mirrors the periodic path).
    hasActiveVpnThreat.current = r.threats.some((t) => t.type === 'vpn_detected');
    void logThreats(r.threats, r.policies, r.riskScore, undefined, r.evidence);
    // Blocking callbacks: this is what routes a CONFIRMED violation to its
    // authoritative screen when the resume verification is the trigger.
    if (r.blocksLogin || r.blocksVideo) blockingCbsRef.current.forEach((cb) => cb(r));
    // Releases the resume/startup hold ONLY on a clean verdict that started at
    // or after the current resume (acceptsResumeVerification inside).
    maybeReleaseBackgroundHold(r);
  }, [maybeReleaseBackgroundHold]);
  // Stable handle for the resume scheduler (registered once, reads through ref).
  const publishVerdictRef = useRef(publishVerdict);
  publishVerdictRef.current = publishVerdict;

  /**
   * Run ONE security evaluation, COALESCING concurrent requests.
   *
   * Returns the evaluation's result when THIS call actually ran one, or null when
   * it was coalesced into a run that was already in flight — in which case the
   * evaluation that was queued for afterwards is the authoritative one for this
   * request (exactly like a superseded result: null is never a verdict).
   *
   * One evaluation runs at a time (the detectors are native/network work and the
   * transport is locked meanwhile), but a request arriving mid-run is REMEMBERED
   * and started the moment the current one finishes. No timer, no polling loop,
   * and — critically — no dropped request: dropping the post-resume re-check is
   * what used to leave the app holding for up to a full periodic interval.
   */
  const runEvaluation = useCallback(async (reason: string): Promise<SecurityCheckResult | null> => {
    const inFlight = inFlightEvaluationRef.current;
    if (inFlight) {
      queuedEvaluationRef.current = reason;
      if (__DEV__) console.log('[SecurityContext] evaluation coalesced (one in flight) — queued: ' + reason);
      await inFlight;
      return null;
    }
    const started = (async () => {
      try {
        return await runGuardedCheck();
      } finally {
        inFlightEvaluationRef.current = null;
      }
    })();
    inFlightEvaluationRef.current = started;
    const result = await started;
    // Chain the queued request immediately (no waiting for the next tick).
    const queued = queuedEvaluationRef.current;
    if (queued !== null) {
      queuedEvaluationRef.current = null;
      if (__DEV__) console.log('[SecurityContext] starting queued evaluation immediately: ' + queued);
      void runEvaluationRef.current(queued);
    }
    return result;
  }, [runGuardedCheck]);
  // Self-reference for the chained start (a useCallback cannot depend on itself).
  runEvaluationRef.current = runEvaluation;

  /**
   * Request a RESUME verification: one evaluation (queued if one is already
   * running) plus a bounded watchdog that reports an overdue verification and
   * retries it ONCE.
   *
   * What this deliberately does NOT do:
   *   • it never waits for anything before returning — the caller (the AppState
   *     listener) returns immediately and the app shell stays responsive;
   *   • it never releases the hold: only a clean verdict that STARTED at or after
   *     this resume can (maybeReleaseBackgroundHold);
   *   • a watchdog fire is evidence + one retry — never authorization. An
   *     unresolved mandatory check stays closed.
   */
  const requestResumeVerification = useCallback((reason: string) => {
    /**
     * Run one evaluation and PUBLISH it (see publishVerdict). Defined here so it
     * closes over refs only and needs no dependency list of its own.
     */
    const runAndPublish = async (why: string) => {
      const r = await runEvaluationRef.current(why);
      // Coalesced/superseded (null) → the run that superseded this one publishes
      // its own result; publishing an older one would be a stale verdict.
      if (!r) return;
      publishVerdictRef.current(r);
    };

    resumePendingSinceRef.current = Date.now();
    resumeRetriedRef.current = false;
    markResumeHoldEngaged();
    if (resumeWatchdogRef.current) {
      clearTimeout(resumeWatchdogRef.current);
      resumeWatchdogRef.current = null;
    }
    resumeWatchdogRef.current = setTimeout(() => {
      resumeWatchdogRef.current = null;
      if (!backgroundHeldRef.current) return;
      if (!isResumeVerificationOverdue({
        pendingSinceMs: resumePendingSinceRef.current,
        nowMs: Date.now(),
      })) return;
      markResumeVerificationOverdue();
      if (resumeRetriedRef.current) return; // one bounded retry per resume
      resumeRetriedRef.current = true;
      markResumeEvaluationStarted();
      if (__DEV__) console.warn('[SecurityContext] resume verification overdue — retrying once; protected access stays closed');
      void runAndPublish('resume-retry');
    }, RESUME_VERIFICATION_TIMEOUT_MS);
    markResumeEvaluationStarted();
    void runAndPublish(reason);
  }, []);

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
    console.log('[SecurityContext][Stage-6] check() ▶ requesting evaluation');
    setChecking(true);
    setEvaluating(true);
    try {
      // COALESCED (root-cause fix): a request that arrives while an evaluation is
      // already running is QUEUED and started the instant it finishes, instead of
      // being dropped by an in-flight guard. Returns null when it coalesced — the
      // queued run is then the authoritative one, and the last published verdict
      // is served meanwhile (never a fabricated block, never a claimed fresh
      // result).
      const r = await runEvaluation('manual');
      if (!r) {
        console.log('[SecurityContext][Stage-6] check() coalesced into an in-flight evaluation — queued a fresh one');
        return result ?? BLOCKING_UNKNOWN_RESULT;
      }
      console.log('[SecurityContext][Stage-6] setResult() with threats=', r.threats.map(t => t.type).join(',') || 'none',
        'blocksLogin=', r.blocksLogin, 'blocksVideo=', r.blocksVideo, 'riskScore=', r.riskScore);
      setResult(r);
      // Track whether a VPN threat is currently active for stale-state monitoring
      hasActiveVpnThreat.current = r.threats.some(t => t.type === 'vpn_detected');
      maybeReleaseBackgroundHold(r);
      void logThreats(r.threats, r.policies, r.riskScore, deviceId, r.evidence);
      return r;
    } catch (e) {
      // The evaluation itself threw. See the fail-closed contract below: the
      // last COMPLETED verdict stays authoritative and no synthetic block is
      // published — the CALLER receives the sentinel so a sensitive action that
      // raced this failure stays gated.
      console.error('[SecurityContext][Stage-6] ❌ runSecurityChecks() threw — keeping last verdict, caller gets fail-closed fallback:', e);
      // STARTUP-FLASH + NETWORK-ERROR CONTRACT:
      //   • A thrown evaluation (backend timeout, transient network failure,
      //     detector crash) is a FAILURE STATE, not a security violation — it
      //     must NOT be published globally as a synthetic block.
      //   • The LAST COMPLETED verdict stays authoritative (if a previous
      //     evaluation proved the device safe, the app stays unlocked; if it
      //     proved a violation, the gate's sticky set keeps the block mounted).
      //   • The CALLER still receives the fail-closed sentinel so a sensitive
      //     action racing this failed evaluation stays gated — without any
      //     user-facing "Security Block Active" page being fabricated.
      //   • The periodic/foreground triggers re-run the evaluation, so a
      //     transient failure recovers automatically when the next check lands.
      try {
        const policies = await getSecurityPolicies();
        const fallback: SecurityCheckResult = {
          threats: [{ type: 'security_unverified', detectionMethod: 'Security evaluation failed (fail-closed)', detected: true }],
          riskScore:   SECURITY_UNVERIFIED_WEIGHT,
          policies,
          blocksLogin: true,
          blocksVideo: true,
          hasWarnings: false,
        };
        return fallback;
      } catch {
        // getSecurityPolicies has its own fail-secure fallback and does not
        // reject in practice; this belt-and-suspenders branch keeps the same
        // contract without a policies map.
        return BLOCKING_UNKNOWN_RESULT;
      }
    } finally {
      setChecking(false);
      setEvaluating(false);
    }
  }, [isSuperAdmin, result, runEvaluation, maybeReleaseBackgroundHold]);

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
      const r = await runGuardedCheck();
      if (!r) {
        // A newer check superseded this pre-video revalidation — publish
        // nothing; the newer verdict is authoritative. Fail-closed callers
        // re-check via the gate's live blocksVideo mirror either way.
        return false;
      }
      setResult(r);
      maybeReleaseBackgroundHold(r);
      void logThreats(r.threats, r.policies, r.riskScore, undefined, r.evidence);
      // Fire blocking callbacks for both login-blocking and video-blocking threats
      // so _layout.tsx can redirect even when checkBeforeVideo is the trigger.
      if (r.blocksLogin || r.blocksVideo) blockingCbsRef.current.forEach((cb) => cb(r));
      return r.blocksVideo;
    } catch {
      return false; // fail-open for non-security errors (network down etc.)
    }
  }, [isSuperAdmin, runGuardedCheck, maybeReleaseBackgroundHold]);

  const reset = useCallback(() => {
    // FAIL-CLOSED reset: the previous verdict is retained (NOT nulled) so the
    // gate stays mounted while the fresh check runs, and `evaluating` gates
    // consumers on "UNKNOWN until verified" semantics.
    // No in-flight flag is force-cleared any more: a re-check request can never
    // be swallowed by an in-flight evaluation (it is QUEUED through
    // runEvaluation), so clearing a flag here would only hide real work.
    setChecking(true);
    setEvaluating(true);
  }, []);

  const onNewBlockingThreat = useCallback((cb: (r: SecurityCheckResult) => void) => {
    blockingCbsRef.current.add(cb);
    return () => { blockingCbsRef.current.delete(cb); };
  }, []);

  // ── Android live obscured-window / overlay signal → security gate ─────────
  /**
   * Release the overlay hold only when the platform signal is CLEAR and a
   * completed verdict NEWER than the engage has landed (canClearOverlayBlock).
   * Not callable by UI code: the recheck control calls verifySecurity(), which
   * RE-READS the native signal instead of asserting it. `getSecurityLockState()`
   * is the synchronous module state — reading React state here would go stale
   * inside the event listener.
   */
  const tryReleaseOverlayLock = useCallback(() => {
    if (!getSecurityLockState().sources.includes(LOCK_SRC_OVERLAY)) return;
    const clears = canClearOverlayBlock({
      signalCleared:   !overlaySignalRef.current,
      hasFreshVerdict: verdictSerialRef.current > overlayEngagedSerialRef.current,
    });
    if (!clears) return;
    if (__DEV__) console.log('[SecurityContext] overlay lock cleared — signal gone and a fresh verdict landed');
    overlayEngagedSerialRef.current = -1;
    releaseSecurityLock(LOCK_SRC_OVERLAY);
  }, []);

  // SEPARATE INPUT, not a lifecycle proxy. The security specification is
  // explicit that an AppState listener alone must not stand in for overlay
  // detection: this subscription carries the FRAMEWORK's own "a touch arrived
  // through an obscured window" evidence from Android (SecurityModule.kt),
  // which a lifecycle transition cannot produce.
  //
  // On a positive signal the gate engages AT ONCE and the lock is hard, so
  // protected playback is unmounted, in-flight protected requests are aborted
  // and the transport refuses new ones. Only the NATIVE side sets this belief.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const unsub = onNativeObscuredChanged((obscured) => {
      if (isSuperAdmin) return;
      overlaySignalRef.current = obscured;
      if (obscured) {
        if (!getSecurityLockState().sources.includes(LOCK_SRC_OVERLAY)) {
          // Remember the verdict serial at engage time: only a NEWER completed
          // verdict may clear this block, so the warning cannot be dismissed.
          overlayEngagedSerialRef.current = verdictSerialRef.current;
          if (__DEV__) console.log('[SecurityContext] OVERLAY BLOCK — obscured touch observed; gate engaged');
          engageSecurityLock(LOCK_SRC_OVERLAY, { hard: true });
        }
        return;
      }
      // Signal cleared. A cleared signal alone is NOT verification — a fresh
      // verdict is still required (canClearOverlayBlock).
      tryReleaseOverlayLock();
    });
    return unsub;
  }, [isSuperAdmin, tryReleaseOverlayLock]);

  // ── Android multi-window / split-screen signal → security gate ────────────
  /**
   * Release the multi-window hold only when BOTH hold (canClearMultiWindowBlock):
   * the platform reports the app back in FULL SCREEN, and a completed verdict
   * NEWER than the engage exists. Reading the lock synchronously (not React
   * state) keeps this correct inside the native event listener, and the second
   * condition guarantees the app can never unblock on a verdict that predates
   * the prohibited state.
   */
  const tryReleaseWindowModeLock = useCallback(() => {
    if (!getSecurityLockState().sources.includes(LOCK_SRC_WINDOW_MODE)) return;
    const clears = canClearMultiWindowBlock({
      modeRestored:    !isProhibitedWindowMode(windowModeRef.current),
      hasFreshVerdict: verdictSerialRef.current > windowModeEngagedSerialRef.current,
    });
    if (!clears) return;
    if (__DEV__) console.log('[SecurityContext] multi-window lock cleared — platform reports full-screen and a fresh verdict landed');
    windowModeEngagedSerialRef.current = -1;
    windowModeEngagedModeRef.current = 'multi_window';
    releaseSecurityLock(LOCK_SRC_WINDOW_MODE);
  }, []);

  /**
   * Apply ONE authoritative window-mode reading.
   *
   * Prohibited mode  → engage the HARD lock at once (players unmount, in-flight
   *   protected requests abort, the transport refuses new ones) and remember the
   *   verdict serial so only a NEWER verdict may clear it.
   * Full screen      → hand the reading to the release rule, and (when asked)
   *   request the fresh verdict that rule requires. There is NO dismiss path: the
   *   user cannot acknowledge their way out, only return the app to full screen.
   * 'unknown'        → neither: an unmeasurable mode is never a finding, and it
   *   is never treated as restored either (the release rule sees a prohibited
   *   hold as still-active until the platform positively reports full screen).
   */
  const applyWindowModeReading = useCallback((mode: string, requestVerdict: boolean) => {
    windowModeRef.current = mode;
    if (isSuperAdmin) return;
    if (isProhibitedWindowMode(mode)) {
      if (!getSecurityLockState().sources.includes(LOCK_SRC_WINDOW_MODE)) {
        windowModeEngagedSerialRef.current = verdictSerialRef.current;
        windowModeEngagedModeRef.current = mode;
        if (__DEV__) console.log('[SecurityContext] MULTI-WINDOW BLOCK — platform reports mode=' + mode + '; gate engaged');
        engageSecurityLock(LOCK_SRC_WINDOW_MODE, { hard: true });
      }
      return;
    }
    tryReleaseWindowModeLock();
    if (requestVerdict && mode === 'fullscreen') void check();
  }, [check, isSuperAdmin, tryReleaseWindowModeLock]);

  // SEPARATE INPUT, not a lifecycle proxy — the same rule the overlay signal
  // follows. This subscription carries the PLATFORM's own window-mode
  // transitions (activity callback relayed by MainActivity, window layout pass,
  // host resume) so a cold start that lands DIRECTLY in split-screen and a live
  // transition both reach the gate. The native side emits only on a real change,
  // so there is one event per transition — no duplicate polling loop and no
  // bridge chatter.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const unsub = onNativeWindowModeChanged((reading) => {
      // requestVerdict: returning to full screen must be re-verified by a FRESH
      // authoritative evaluation before the gate opens (never by the event alone).
      applyWindowModeReading(reading.mode, true);
    });
    return unsub;
  }, [applyWindowModeReading]);

  /**
   * Manual recheck (the overlay / resume gate control).
   *
   * RE-READS the native obscured signal AND the platform window mode,
   * invalidates verdicts that predate the request (so an older in-flight check
   * cannot clear the hold), runs a fresh evaluation, then re-evaluates both
   * release conditions. It cannot force the gate open: clearing still requires
   * the platform to report the condition gone AND policy to pass. The
   * multi-window restriction deliberately offers no control of its own (see
   * isGateRecheckable) — the platform's own signal is what clears it.
   */
  const verifySecurity = useCallback(async () => {
    if (Platform.OS === 'android') {
      try {
        overlaySignalRef.current = await isNativeWindowObscured();
      } catch {
        // Keep the last known belief — an unreadable signal is NOT a clear one.
      }
      try {
        const reading = await getNativeWindowMode();
        if (reading.measured) applyWindowModeReading(reading.mode, false);
      } catch {
        // Same rule: an unreadable window mode is not a restored one.
      }
    }
    resumeTokenRef.current += 1;
    await check();
    tryReleaseOverlayLock();
    tryReleaseWindowModeLock();
  }, [applyWindowModeReading, check, tryReleaseOverlayLock, tryReleaseWindowModeLock]);

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
      // A lock is SESSION-SCOPED: on logout/account-switch every holder is
      // dropped so the next identity cannot inherit a stale block (and the
      // transport gate reopens for the auth flows it must serve).
      releaseAllSecurityLocks();
      // The gate BOOKKEEPING is session-scoped too. Without this reset the
      // next identity would start with backgroundHeldRef=true and a stale
      // verdict serial, so its first post-resume evaluation would be judged
      // against the previous account's state (and could release a hold that
      // was never engaged, or hold forever without one).
      backgroundHeldRef.current = false;
      // The evaluation queue and the resume watchdog are session-scoped as well:
      // a queued evaluation from the previous identity must never run, and a
      // pending watchdog must not outlive the hold it belongs to.
      queuedEvaluationRef.current = null;
      inFlightEvaluationRef.current = null;
      resumePendingSinceRef.current = null;
      resumeRetriedRef.current = false;
      if (resumeWatchdogRef.current) {
        clearTimeout(resumeWatchdogRef.current);
        resumeWatchdogRef.current = null;
      }
      overlaySignalRef.current = false;
      overlayEngagedSerialRef.current = -1;
      // The window-mode belief is session-scoped too: 'unknown' (not
      // 'fullscreen') so the next identity cannot inherit this one's reading.
      windowModeRef.current = 'unknown';
      windowModeEngagedSerialRef.current = -1;
      windowModeEngagedModeRef.current = 'multi_window';
      verdictSerialRef.current = 0;
      resumeTokenRef.current = 0;
      evaluationStartTokenRef.current = 0;
      void invalidateSecurityConfig();
      void clearAppAttestKey();
      // Server policy + VPN whitelist caches are session-scoped: drop them on
      // logout/account switch so the next session re-fetches authoritative
      // policy instead of reusing the previous account's 5-min cache window.
      invalidatePolicyCache();
      return;
    }

    // ── NETWORK LOCK AT SESSION START ───────────────────────────────────────
    // A mandatory verification is PENDING the moment an authenticated session
    // exists (a previous process's verdict is not evidence for this one), so the
    // app's own traffic is suspended BEFORE that verification runs and protected
    // operations are withheld while it does.
    //
    // RACE ARGUMENT (why this holds even though child effects run first): a
    // screen can only send traffic through the transport, and the transport
    // consults this lock synchronously before any I/O — a request that raced
    // past the check is registered and aborted by containment, one that arrives
    // afterwards is queued. Nothing protected leaves the device either way.
    //
    // Released by the same path as every other hold: a COMPLETED, clean verdict
    // that started at/after this session (`maybeReleaseBackgroundHold`). A
    // confirming violation keeps the lock engaged and shows its own screen.
    // Super Admin sessions bypass it (enterBackgroundHold returns early).
    //  Only when NO verdict has been published in this process. After an in-app
    //  sign-in the pre-session `check()` has already produced one, so engaging
    //  here would only delay the post-login bootstrap requests (device
    //  registration, profile load) without adding any evidence. A cold start
    //  with a restored session has no verdict yet — that is the case this
    //  protects.
    if (result === null) enterBackgroundHold('session-start');

    // ── runPeriodicCheck ──────────────────────────────────────────────────────
    // Defined inside the effect so it closes over the current isSuperAdmin value.
    // Written into a stable ref so the AppState / network handlers (registered
    // once) always invoke the most-recent version without stale-closure issues.
    const runPeriodicCheck = async () => {
      if (!appActiveRef.current) return;
      // NOTE: an in-flight evaluation no longer makes this a no-op — the request
      // is queued and started the moment the current run finishes (runEvaluation).
      // Dropping it is what used to let a resume-triggered re-check disappear
      // until the NEXT tick.
      // Super Admin bypass: no checks needed during the bypass window
      if (isSuperAdmin) {
        if (__DEV__) console.log('[SecurityContext] Super Admin bypass — skipping periodic check');
        setResult(SUPERADMIN_BYPASS_RESULT);
        hasActiveVpnThreat.current = false;
        return;
      }
      try {
        const r = await runEvaluation('periodic');
        // null = coalesced into a run already in flight (or superseded by a newer
        // one); that newer result is authoritative and will publish itself.
        if (!r) return;
        setResult(r);
        // Update VPN threat tracking so foreground re-checks are scheduled correctly
        hasActiveVpnThreat.current = r.threats.some(t => t.type === 'vpn_detected');
        void logThreats(r.threats, r.policies, r.riskScore, undefined, r.evidence);
        if (r.blocksLogin || r.blocksVideo) {
          blockingCbsRef.current.forEach((cb) => cb(r));
        }
        maybeReleaseBackgroundHold(r);
      } catch { /* non-fatal */ }
    };
    // Keep the stable ref up-to-date with the latest closure
    runPeriodicCheckRef.current = runPeriodicCheck;

    //  ORDERING FIX (the session-start verification never ran): the immediate
    //  session-start check used to be invoked BEFORE this assignment, so on the
    //  first execution of this effect it called the ref's inert initializer
    //  (`async () => {}`) and the first authoritative evaluation was deferred to
    //  the 30 s interval tick — the app ran on a previous process's state (or on
    //  no verdict at all) for up to half a minute. Assign first, then call, so
    //  the real implementation runs at start.
    void runPeriodicCheckRef.current();

    // ── Background → resume gate ───────────────────────────────────────────
    // TWO directions, and both are load-bearing:
    //
    //   LEAVING the foreground  → engage the hold IMMEDIATELY (before any React
    //     render, synchronously with the state change): protected playback is
    //     paused, in-flight protected requests are aborted, and new ones are
    //     refused by the transport gate. Previously nothing was held here, so
    //     protected content stayed live behind the Home button and the last
    //     pre-background verdict kept the app usable after returning.
    //
    //   RETURNING to the foreground → the hold STAYS ENGAGED (containment is what
    //     protects protected content), a post-resume evaluation starts at once,
    //     and the app SHELL is restored immediately. The hold is no longer
    //     rendered as a full-screen VERIFYING page: protected operations are
    //     refused by the transport gate, protected playback stays stopped by the
    //     hard lock, and the shell is usable. A confirmed violation is routed to
    //     its own blocking screen the moment the verdict lands.
    //
    // Super Admin sessions bypass the hold (matching every other enforcement
    // path). The hold is SESSION-SCOPED: `!session` releases all holders, so
    // the next identity never inherits it.
    // (enterBackgroundHold / maybeReleaseBackgroundHold are provider-scope
    //  callbacks — every publish path must be able to release the hold.)

    // Track foreground/background; trigger re-validation on return from external app
    const appStateSub = AppState.addEventListener('change', (nextState) => {
      const wasActive = appActiveRef.current;
      appActiveRef.current = nextState === 'active';

      if (nextState === 'background') {
        // Left the foreground → hold at once (hard: screens unmount the player).
        //
        // Only 'background', deliberately NOT 'inactive'. On Android a real
        // stop (Home, recents, app switch) is the only thing that reports
        // 'background' — a system dialog, the keyboard, or a trusted system UI
        // surface keeps the activity visible and does NOT produce one, so those
        // legitimate cases cannot trip the gate. On iOS 'inactive' additionally
        // fires for the app switcher, a call banner and Control Centre, and
        // gating on it would block every benign interruption; iOS keeps its
        // existing resume re-check behavior.
        enterBackgroundHold('appstate=' + nextState);
      }

      if (nextState === 'active' && !wasActive) {
        // Resume: bump the token FIRST so any evaluation already in flight is
        // ineligible to clear this hold, then keep the CONTAINMENT engaged until a
        // fresh post-resume verification completes. The hold is no longer
        // rendered as a page (see rendersBlockScreen): the app shell comes back
        // immediately, while protected operations stay refused and protected
        // media stays stopped until the verdict lands.
        resumeTokenRef.current += 1;
        enterBackgroundHold('resumed');
        // Re-assert the native overlay protection on the (possibly recreated)
        // activity — Android can rebuild the window across a background cycle.
        void enableNativeOverlayProtection();
        // Same for the multi-window triggers (the activity can be recreated, so
        // the layout watcher is gone) plus a fresh reading: returning from
        // another app is exactly when a split-screen change may have happened.
        void enableNativeWindowModeMonitoring().then(() => getNativeWindowMode()).then((reading) => {
          if (reading.measured) applyWindowModeReading(reading.mode, false);
        }).catch(() => {});
      }

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
        // ── Resume verification ────────────────────────────────────────────────
        // ALWAYS requested on a real background→foreground transition, started
        // at once (no artificial delay) and queued rather than dropped if an
        // evaluation is already running. The VPN case keeps its short debounce
        // alone, because that one waits for the network stack to settle after a
        // tunnel teardown — the hold stays engaged for those 1.5 s, and the
        // value read afterwards is the first one that can speak for the new
        // transport state.
        if (hasActiveVpnThreat.current) {
          if (vpnRecheckTimer.current) clearTimeout(vpnRecheckTimer.current);
          vpnRecheckTimer.current = setTimeout(() => {
            requestResumeVerification('resume-vpn-settled');
          }, VPN_RECHECK_DEBOUNCE_MS);
        } else {
          requestResumeVerification('resume');
        }
      }
    });

    // Record the build number when the session starts so we can detect an update
    lastBuildRef.current = Constants.expoConfig?.version ?? null;

    // ── Network reconnect trigger ──────────────────────────────────────────
    // Run a security check on ANY network state change — not just reconnect.
    //
    // BUG FIX: The previous condition `if (state.isConnected && ...)` only fired
    // when transitioning offline→online. When a VPN is enabled WHILE the device is
    // already connected (the common case), isConnected stays true and the handler's
    // condition was already met — NetInfo may not fire a new event at all, or when
    // it does fire the condition suppressed the re-check via the debounce timer.
    //
    // The fix: respond to EVERY NetInfo state change event so that the VPN-enable
    // transition (Wi-Fi→Wi-Fi+VPN while isConnected stays true) is always caught.
    // The 3s debounce still prevents thrashing on flapping connections.
    //
    // NOTE: Android NetworkCallback (in SecurityModule.kt) is the primary VPN
    // detection mechanism — it fires immediately via the vpnStateChanged event.
    // This NetInfo listener is a belt-and-suspenders catch-all for transitions
    // the NetworkCallback may miss (e.g. VPN-over-cellular on some OEMs).
    const netUnsub = NetInfo.addEventListener((state) => {
      if (!appActiveRef.current) return;
      if (netReconnectTimer.current) clearTimeout(netReconnectTimer.current);
      netReconnectTimer.current = setTimeout(() => {
        void runPeriodicCheckRef.current();
      }, NETWORK_RECONNECT_DEBOUNCE_MS);
    });

    // ── Android native VPN state callback ─────────────────────────────────
    // SecurityModule.kt registers a ConnectivityManager.NetworkCallback for
    // TRANSPORT_VPN. When a VPN network becomes available or is torn down,
    // it emits "vpnStateChanged" to JS immediately (no polling delay).
    // This is the primary path for real-time VPN detection on Android — it
    // fires within milliseconds of the user enabling/disabling their VPN app,
    // regardless of whether the device stays internet-connected.
    let vpnEventUnsub: (() => void) | null = null;
    if (Platform.OS === 'android' && NativeModules.SecurityModule) {
      try {
        const emitter = new NativeEventEmitter(NativeModules.SecurityModule);
        const subscription = emitter.addListener('vpnStateChanged', (event: { vpnActive: boolean; signalTimeMs?: number }) => {
          const signalTimeMs = event?.signalTimeMs ?? 0;
          console.log('[SecurityContext][VpnCallback] vpnStateChanged event received vpnActive=', event?.vpnActive, 'signalTimeMs=', signalTimeMs);
          //  Record JS receipt + bump the native-signal sequence BEFORE any
          //  containment work, so the measured latency excludes nothing and a
          //  verdict landing mid-window cannot release this newer signal.
          nativeSignalSeqRef.current += 1;
          markNativeVpnSignal(signalTimeMs > 0 ? signalTimeMs : null);

          // ── IMMEDIATE CONTAINMENT (latency fix) ──────────────────────────
          // The network-bound verdict below needs a full check cycle (policy
          // fetch + Play Integrity + SSL probe) before it can decide, and that
          // window was long enough for an interception tool to capture API
          // traffic and for the native player to keep running behind the gate.
          // TRANSPORT_VPN is an OS-level FACT, not a heuristic, so we contain
          // AT ONCE: pause playback + abort/halt protected requests. The
          // authoritative verdict then either upgrades this to a HARD lock or
          // releases it (admins may whitelist a corporate VPN).
          //   • Super Admin sessions bypass containment entirely.
          //   • A known-non-empty admin whitelist skips it (mirrors detectVPN).
          if (isSuperAdmin) {
            releaseSecurityLock(LOCK_SRC_NATIVE_VPN);
          } else if (event?.vpnActive === true && !isVpnWhitelistKnownNonEmpty()) {
            engageSecurityLock(LOCK_SRC_NATIVE_VPN);
            if (signalTimeMs > 0 && event?.vpnActive) {
              const lockEngageMs = Date.now();
              diagnosticsRef.current = { nativeVPNSignalTimeMs: signalTimeMs, lockEngagedTimeMs: lockEngageMs };
              setDiagnostics(diagnosticsRef.current);
            }
          } else if (event?.vpnActive !== true) {
            releaseSecurityLock(LOCK_SRC_NATIVE_VPN);
          }

          if (!appActiveRef.current) return;
          // Immediate re-check — no debounce needed because the NetworkCallback
          // already confirmed the VPN state changed. Use the VPN_RECHECK_DEBOUNCE_MS
          // (1.5s) just to let the network stack settle before we read CM again.
          if (vpnRecheckTimer.current) clearTimeout(vpnRecheckTimer.current);
          vpnRecheckTimer.current = setTimeout(() => {
            void runPeriodicCheckRef.current();
          }, VPN_RECHECK_DEBOUNCE_MS);
        });
        vpnEventUnsub = () => subscription.remove();
        console.log('[SecurityContext][VpnCallback] NativeEventEmitter subscribed to vpnStateChanged');
      } catch (e) {
        console.warn('[SecurityContext][VpnCallback] NativeEventEmitter setup failed:', e);
      }
    }

    void checkAndRefreshSecurityConfig();
    // Install the native overlay protection as soon as an authenticated
    // session exists. Idempotent; resolves false on platforms without it.
    void enableNativeOverlayProtection();
    // Install the multi-window triggers (activity callback relay, window layout
    // watcher, host-resume hook) and take ONE authoritative reading — this is
    // what catches an app that was LAUNCHED directly into split-screen, where an
    // event-only design would never fire. A reading that could not be measured
    // ('unknown') is not a finding and not a clearance.
    void enableNativeWindowModeMonitoring().then(() => getNativeWindowMode()).then((reading) => {
      if (reading.measured) applyWindowModeReading(reading.mode, false);
    }).catch(() => {});

    const refreshDynamicConfig = async () => {
      if (!appActiveRef.current) return;
      await checkAndRefreshSecurityConfig();
    };

    intervalRef.current    = setInterval(() => { void runPeriodicCheckRef.current(); }, CONTINUOUS_CHECK_INTERVAL_MS);
    configTimerRef.current = setInterval(() => { void refreshDynamicConfig(); }, CONFIG_REFRESH_INTERVAL_MS);

    return () => {
      appStateSub.remove();
      netUnsub();
      vpnEventUnsub?.();
      if (netReconnectTimer.current) clearTimeout(netReconnectTimer.current);
      if (vpnRecheckTimer.current)   clearTimeout(vpnRecheckTimer.current);
      if (intervalRef.current)   { clearInterval(intervalRef.current);   intervalRef.current = null; }
      if (configTimerRef.current){ clearInterval(configTimerRef.current); configTimerRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id, isSuperAdmin]);

  // When Super Admin bypass is active, always expose a clean zero-threat result
  // regardless of what runSecurityChecks() may have returned previously.
  // Otherwise serve the LAST COMPLETED verdict; while none exists (cold start,
  // login screen) serve the NEUTRAL start-up result — NOT a synthetic block.
  // STARTUP-FLASH FIX: this line used to serve BLOCKING_UNKNOWN_RESULT
  // ("security_unverified", risk 10, blocksLogin) as the GLOBAL result before
  // the first evaluation landed, which mounted the "Security Block Active"
  // page on every startup. The sentinel now lives only as check()'s
  // caller-scoped fallback (sensitive actions), never as global UI state.
  const r = isSuperAdmin
    ? SUPERADMIN_BYPASS_RESULT
    : (result ?? NEUTRAL_STARTUP_RESULT);
  const hasVerdict = isSuperAdmin || result !== null;

  // ── LOCK DRIVEN BY THE AUTHORITATIVE VERDICT ─────────────────────────────
  // THE root-cause fix for "video keeps playing behind the security screen":
  // the block SCREEN used to be driven by blocksLogin while the PLAYER was
  // stopped ONLY by blocksVideo. VPN/proxy policy is block_login, so a VPN
  // produced blocksLogin:true + blocksVideo:false — gate up, native player
  // still running. The lock unifies both: a completed blocking verdict holds
  // a HARD lock (screens unmount the player, transport refuses requests), and
  // any non-blocking COMPLETED verdict releases the verdict holder AND drops
  // the provisional native containment (so an allowed/whitelisted VPN cannot
  // lock the app forever).
  //
  // `verdictTypes` is part of the dependency list deliberately: a verdict can
  // land with the SAME block flags but different findings (e.g. VPN cleared by
  // the whitelist), and the provisional holder must still be released then.
  const verdictTypes = r.threats.map((t) => t.type).join(',');
  useEffect(() => {
    // Publish the new verdict serial to the ref FIRST (the overlay gate's
    // engage-time snapshot and its release test both read the ref from contexts
    // where React state would already be stale), then give the overlay gate its
    // chance to clear now that a NEWER completed verdict exists.
    verdictSerialRef.current = verdictSerial;
    tryReleaseOverlayLock();
    // Same hand-off for the multi-window hold: a NEWER completed verdict is one
    // of its two release conditions (canClearMultiWindowBlock). The other one —
    // the platform reporting full screen — is owned by the native signal, so a
    // verdict alone can never open this gate.
    tryReleaseWindowModeLock();

    if (!isSuperAdmin && hasVerdict && (r.blocksLogin || r.blocksVideo)) {
      engageSecurityLock(LOCK_SRC_VERDICT, { hard: true });
      return;
    }
    releaseSecurityLock(LOCK_SRC_VERDICT);
    // Only clear provisional containment once a COMPLETED verdict exists —
    // before the first verdict, containment must stay fail-closed — AND only
    // when that verdict started at or after the newest native VPN signal. A
    // verdict that began before the signal cannot speak for the VPN state now
    // in force, so dropping containment on it would reopen the interception
    // window (see nativeSignalSeqRef above). The VPN re-check that follows every
    // signal lands a fresh verdict that can legitimately release containment.
    if (hasVerdict && verdictNativeSeqRef.current >= nativeSignalSeqRef.current) {
      releaseSecurityLock(LOCK_SRC_NATIVE_VPN);
    } else if (hasVerdict && __DEV__) {
      console.log('[SecurityContext] holding provisional VPN containment — verdict predates the latest native signal');
    }
  }, [isSuperAdmin, hasVerdict, r.blocksLogin, r.blocksVideo, verdictTypes, tryReleaseOverlayLock, tryReleaseWindowModeLock, verdictSerial]);

  const phase: GatePhase = resolveGatePhase({
    hasVerdict,
    evaluating,
    liveBlocking:  r.blocksLogin && r.threats.length > 0,
    stickyCount:   0,
  });

  // ── THE CENTRALIZED GATE STATE ───────────────────────────────────────────
  // One closed vocabulary (securityStateModel.resolveSecurityGateState) built
  // from ALL FOUR independent inputs, so every consumer renders from the same
  // decision instead of re-deriving a boolean from a different subset of flags:
  //
  //   • policy verdict        → vpn / violation blocks
  //   • live overlay signal   → overlay block (from the native touch filter)
  //   • foreground lifecycle  → background/resume hold (the security lock)
  //   • evaluation progress   → CHECKING (never a fabricated block)
  //
  // The overlay and background causes are read from the LOCK, not from a
  // separate React flag: the lock is the single source of truth for "protected
  // content is contained", so the gate and the transport can never disagree.
  const overlayBlocked    = !isSuperAdmin && lockState.sources.includes(LOCK_SRC_OVERLAY);
  const multiWindowBlocked = !isSuperAdmin && lockState.sources.includes(LOCK_SRC_WINDOW_MODE);
  const backgroundBlocked = !isSuperAdmin && lockState.sources.includes(LOCK_SRC_BACKGROUND);
  const liveBlocking      = r.blocksLogin && r.threats.length > 0;
  // CONNECTION BLOCK (VPN **or** proxy). Both detectors are floored to
  // block_login (applyMandatoryConnectionFloor) and both have their own copy on
  // the connection page, so they must resolve to the SAME state: matching only
  // `vpn_detected` sent a proxy-only violation to the generic
  // BLOCKED_SECURITY_VIOLATION page, which has no recovery steps and no recheck
  // control — i.e. the correct finding, the wrong screen and no way to recover
  // after switching the proxy off.
  const vpnBlocked        = liveBlocking && hasConnectionFinding(r.threats);
  const gateState: SecurityGateState = isSuperAdmin
    ? 'ALLOWED'      : resolveSecurityGateState({
        evaluating:             evaluating || checking,
        hasVerdict,
        overlayBlocked,
        multiWindowBlocked,
        backgroundResumeBlocked: backgroundBlocked,
        vpnBlocked,
        violationBlocked:        liveBlocking && !vpnBlocked,
      });

  return (
    <SecurityContext.Provider value={{
      result:              isSuperAdmin ? SUPERADMIN_BYPASS_RESULT : result,
      checking,
      evaluating,
      hasVerdict,
      phase,
      threats:             r.threats,
      riskScore:           r.riskScore,
      blocksLogin:         r.blocksLogin,
      blocksVideo:         r.blocksVideo,
      hasWarnings:         r.hasWarnings,
      isSuperAdmin,
      securityLocked:      lockState.locked,
      networkLocked:       lockState.locked,
      networkAccessState:  resolveNetworkAccessState({ locked: lockState.locked }),
      securityLockHard:    lockState.hard,
      gateState,
      overlayBlocked,
      multiWindowBlocked,
      windowMode:          multiWindowBlocked ? windowModeEngagedModeRef.current : windowModeRef.current,
      backgroundBlocked,
      verifySecurity,
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
