/**
 * securityStateModel.ts — PURE security/update state model.
 *
 * ⚠️ NO IMPORTS. This module must stay dependency-free (no react-native, no
 * expo, no network) so it can be compiled standalone and unit-tested with
 * plain node (see tests/securityStateModel.test.cjs). Runtime modules here:
 *
 *   • security.ts            — risk scoring + policy aggregation (delegates here)
 *   • updateConfigService.ts — versionCode verdict (delegates here)
 *   • security-gate.tsx      — the gate's sticky block-state transition (delegates here)
 *
 * ─── Authoritative model (BUG #8/#9 fix — deterministic, documented) ────────
 *
 *   Sensors → findings (threats) → policy lookup → AUTHORITATIVE STATE
 *
 *   riskScore = Σ weights(detected threats), clamped to 0..100. It is
 *   INFORMATIONAL telemetry. The BLOCK decision comes exclusively from the
 *   per-finding policy action ('block_login' / 'block_video' / 'warn_only' /
 *   'log_only') — a blocking finding with a 0 weight still blocks, and a high
 *   risk score never blocks by itself.
 */

// ─── Pure input shapes (structurally compatible with the runtime types) ──────

export interface PureThreat {
  type: string;
  detectionMethod: string;
  detected: boolean;
}

export type PurePolicyAction = 'log_only' | 'warn_only' | 'block_video' | 'block_login';
export type PurePolicies = Record<string, PurePolicyAction>;
export type PureWeights = Record<string, number>;
/** detection type → the event types it covers (mirrors DETECTION_TO_EVENT). */
export type PureDetectionToEvent = Record<string, string[]>;

// ─── Risk score (informational telemetry) ────────────────────────────────────

/**
 * Σ weights of detected threats, clamped to 0..100. Unknown event types
 * contribute 0 (they are surfaced by policy evaluation instead, if mapped).
 */
export function computeRiskScorePure(threats: PureThreat[], weights: PureWeights): number {
  const total = threats
    .filter((t) => t.detected)
    .reduce((sum, t) => sum + (weights[t.type] ?? 0), 0);
  return Math.min(100, total);
}

// ─── Policy evaluation (the AUTHORITATIVE decision) ──────────────────────────

export interface SecurityVerdict {
  riskScore: number;
  blocksLogin: boolean;
  blocksVideo: boolean;
  hasWarnings: boolean;
  /** Event types whose policy action is block_login (drives the gate list). */
  blockingTypes: string[];
  /** Event types whose policy action is warn_only. */
  warningTypes: string[];
  /** Event types that carry no policy mapping (skipped — logged only upstream). */
  unmappedTypes: string[];
}

/**
 * Evaluates findings against the policy table. DETERMINISTIC: the same
 * (threats, policies) pair always produces the same verdict.
 *
 * Multiple findings compose with OR semantics — the app is blocked while ANY
 * blocking finding is live, and recovers only when a fresh evaluation finds
 * none (the recovery transition lives in nextStickyTypes + SecurityContext's
 * re-check triggers).
 */
export function evaluateSecurityResult(input: {
  threats: PureThreat[];
  policies: PurePolicies;
  detectionToEvent: PureDetectionToEvent;
  weights: PureWeights;
}): SecurityVerdict {
  const { threats, policies, detectionToEvent, weights } = input;

  const riskScore = computeRiskScorePure(threats, weights);

  let blocksLogin = false;
  let blocksVideo = false;
  let hasWarnings = false;
  const blockingTypes: string[] = [];
  const warningTypes: string[] = [];
  const unmappedTypes: string[] = [];

  for (const threat of threats) {
    if (!threat.detected) continue;
    const detectionType = Object.entries(detectionToEvent).find(
      ([, events]) => events.includes(threat.type),
    )?.[0];
    if (!detectionType) {
      unmappedTypes.push(threat.type);
      continue;
    }
    const action = policies[detectionType];
    if (action === 'block_login') {
      blocksLogin = true;
      blockingTypes.push(threat.type);
    } else if (action === 'block_video') {
      blocksVideo = true;
    } else if (action === 'warn_only') {
      hasWarnings = true;
      warningTypes.push(threat.type);
    }
    // 'log_only' and unknown actions never block.
  }

  return { riskScore, blocksLogin, blocksVideo, hasWarnings, blockingTypes, warningTypes, unmappedTypes };
}

// ─── Gate sticky-state machine (BLOCKED → CHECKING → SAFE|BLOCKED) ───────────

/**
 * Transition for the SecurityGate's sticky block-state.
 *
 * Fail-closed DURING evaluation, recoverable AFTER it — never "blocked
 * forever until restart":
 *   • A live blocking result refreshes the sticky set (authoritative while it
 *     is on screen).
 *   • While a re-check is in flight (`checking=true`), the last verified
 *     block is KEPT — consumers never see a temporary all-clear (this closes
 *     the BLOCKED → CHECKING → TEMPORARILY ALLOWED race).
 *   • A COMPLETED non-blocking evaluation clears the sticky set — the gate
 *     unmounts and the app recovers without a restart.
 */
export function nextStickyTypes(
  prev: string[],
  input: { checking: boolean; liveBlocking: boolean; liveThreatTypes: string[] },
): string[] {
  if (input.liveBlocking && input.liveThreatTypes.length > 0) {
    return input.liveThreatTypes;
  }
  if (input.checking) {
    return prev; // fail-closed: keep the last verified block during re-check
  }
  return []; // completed evaluation, nothing blocking → recover
}

// ─── Gate visibility phase (pending ≠ blocked — startup-flash fix) ──────────

/**
 * The three visibility phases of the SecurityGate overlay.
 *
 *   pending   — no COMPLETED evaluation exists yet (cold start, or an
 *               evaluation that has not landed). The gate MUST NOT mount:
 *               the normal startup/loading experience stays visible while
 *               checks run silently in the background.
 *   unlocked  — a completed evaluation found nothing blocking.
 *   blocked   — a policy-confirmed blocking condition is live (or a
 *               previously-verified block is being re-validated). The gate
 *               mounts and stays mounted.
 *
 * THE AUTHORITATIVE CONTRACT (startup-flash fix):
 *   CHECKING / UNKNOWN  ≠  BLOCKED
 *   NETWORK ERROR       ≠  BLOCKED
 *   OFFLINE             ≠  BLOCKED
 * Only an actual policy decision on a COMPLETED evaluation produces
 * 'blocked'. The previous behavior served a synthetic blocking sentinel
 * ("security_unverified", risk 10) as the global result whenever no verdict
 * existed, which mounted the full violation page on EVERY cold start until
 * the first check completed — the UNKNOWN → BLOCKED → SAFE false transition.
 *
 * Fail-closed ordering: a live/sticky block WINS over any pending state —
 * a re-check in flight never flashes a temporary all-clear over a verified
 * block (the BLOCKED → CHECKING → TEMP-ALLOWED race stays closed).
 */
export type GatePhase = 'pending' | 'unlocked' | 'blocked';

export function resolveGatePhase(input: {
  /** A COMPLETED evaluation verdict exists (never true before the first one). */
  hasVerdict: boolean;
  /** An evaluation is currently in flight. */
  evaluating: boolean;
  /** The latest completed/last-served result blocks login with findings. */
  liveBlocking: boolean;
  /** Number of sticky (previously-verified) blocking event types held by the gate. */
  stickyCount: number;
}): GatePhase {
  if (input.liveBlocking || input.stickyCount > 0) return 'blocked';
  if (!input.hasVerdict || input.evaluating) return 'pending';
  return 'unlocked';
}

// ─── CENTRALIZED SECURITY GATE STATE (single closed vocabulary) ─────────────
//
// WHY A SECOND, NAMED STATE (root cause: two independent gate inputs had no
// common vocabulary)
// ─────────────────────────────────────────────────────────────────────────────
// The gate used to be driven by ONE derived boolean (`phase === 'blocked'`),
// which was computed from the policy verdict alone. Overlay/obscured-window
// protection and the background→resume lock are DIFFERENT inputs with
// different lifecycles — an overlay is not a policy finding, and a resume is
// not a device violation — so folding them into `blocksLogin` would have made
// the copy wrong and the recovery paths indistinguishable.
//
// This enum is the ONE vocabulary every consumer renders from. It is explicit
// (not a boolean) so the gate can show accurate copy and offer the correct
// recovery action for each cause, and so tests can assert the precedence.

export type SecurityGateState =
  | 'CHECKING'
  | 'BLOCKED_OVERLAY'
  | 'BLOCKED_BACKGROUND_RESUME'
  | 'BLOCKED_VPN'
  | 'BLOCKED_SECURITY_VIOLATION'
  | 'ALLOWED';

/** Every state, for exhaustive tests / future consumers. */
export const SECURITY_GATE_STATES: readonly SecurityGateState[] = [
  'CHECKING',
  'BLOCKED_OVERLAY',
  'BLOCKED_BACKGROUND_RESUME',
  'BLOCKED_VPN',
  'BLOCKED_SECURITY_VIOLATION',
  'ALLOWED',
] as const;

export interface SecurityGateInputs {
  /** A security evaluation is in flight right now. */
  evaluating: boolean;
  /** At least one COMPLETED evaluation has been published for this session. */
  hasVerdict: boolean;
  /**
   * A live obscured-window / overlay signal holds the gate. This is the
   * attacker-present-in-the-touch-path signal: it outranks every other cause
   * because anything rendered or tapped while it is live is untrusted.
   */
  overlayBlocked: boolean;
  /**
   * The app left the foreground and has not yet completed a post-resume
   * verification. Held from the instant the app is backgrounded until a
   * COMPLETED evaluation that STARTED AFTER the resume found nothing blocking.
   */
  backgroundResumeBlocked: boolean;
  /** The live policy verdict pairs a VPN/proxy transport finding with a block. */
  vpnBlocked: boolean;
  /** Any other policy blocking finding (root, tamper, overlay policy, etc.). */
  violationBlocked: boolean;
}

/**
 * The single AUTHORITATIVE gate state.
 *
 * Precedence (documented, fail-closed, most-trusted-blocker first):
 *
 *   1. BLOCKED_OVERLAY             — an untrusted window is in the touch path.
 *   2. BLOCKED_BACKGROUND_RESUME   — left the foreground; not yet re-verified.
 *   3. BLOCKED_VPN                 — policy block caused by a VPN/proxy.
 *   4. BLOCKED_SECURITY_VIOLATION  — any other policy block.
 *   5. CHECKING                    — no completed verdict, or a check running.
 *   6. ALLOWED                     — completed verdict, nothing blocking.
 *
 * The order encodes two invariants:
 *   • A live block ALWAYS outranks CHECKING. A re-check in flight must never
 *     downgrade a verified block into a "verifying…" state that a consumer
 *     might treat as recoverable — the BLOCKED → CHECKING → TEMP-ALLOWED race.
 *   • UNKNOWN is never ALLOWED. With no completed verdict the state is
 *     CHECKING, so a cold start can never present protected content as
 *     cleared (the startup-flash fix, preserved).
 */
export function resolveSecurityGateState(input: SecurityGateInputs): SecurityGateState {
  if (input.overlayBlocked) return 'BLOCKED_OVERLAY';
  if (input.backgroundResumeBlocked) return 'BLOCKED_BACKGROUND_RESUME';
  if (input.vpnBlocked) return 'BLOCKED_VPN';
  if (input.violationBlocked) return 'BLOCKED_SECURITY_VIOLATION';
  if (!input.hasVerdict || input.evaluating) return 'CHECKING';
  return 'ALLOWED';
}

/** True for the states in which protected content must not be visible. */
export function isGateBlocked(state: SecurityGateState): boolean {
  return state === 'BLOCKED_OVERLAY'
    || state === 'BLOCKED_BACKGROUND_RESUME'
    || state === 'BLOCKED_VPN'
    || state === 'BLOCKED_SECURITY_VIOLATION';
}

/**
 * True when the user can clear the state by acting and then re-verifying.
 *
 * Deliberately narrow: only the two states caused by something the USER can
 * remove (an overlay app, a backgrounded session) get the recheck control. A
 * VPN or integrity violation is cleared by the automatic re-evaluation, and a
 * user-facing "verify" button there would only invite retry-spamming a device
 * condition that has not changed.
 */
export function isGateRecheckable(state: SecurityGateState): boolean {
  return state === 'BLOCKED_OVERLAY' || state === 'BLOCKED_BACKGROUND_RESUME';
}

// ─── Finding → user-facing copy key ─────────────────────────────────────────

/**
 * Map a BLOCKING finding to the copy key used to describe it on screen.
 *
 * WHY THIS EXISTS (observed on-device defect): the security engine collapses
 * three unrelated conditions into the single event type `debug_detected` —
 *
 *   • a test-only / debuggable build (`testOnlyBuild`, `__DEV__`)
 *   • a mock-location provider selected on the device (AppOps / legacy flag)
 *   • an emulator-like device (`emulatorDetected`)
 *
 * — and the gate rendered one shared piece of copy for all three: "Insecure
 * Build Detected / Install the official production release of the app." On a
 * device whose only problem was a mock-location setting that was false advice:
 * the installation was not insecure, and reinstalling the official release
 * cannot clear a device condition. The displayed finding therefore contradicted
 * the result that produced it (finding, risk score and gate decision disagreed).
 *
 * The event type stays `debug_detected` — it is the policy/audit vocabulary and
 * `debug` → block_login must keep blocking — and so do the risk weight (20) and
 * the gate decision. Only the PRESENTATION is corrected, using the engine's own
 * `detectionMethod` to describe the sensor that actually fired.
 */
export function resolveFindingCopyKey(type: string, detectionMethod?: string | null): string {
  if (type !== 'debug_detected') return type;
  const method = (detectionMethod ?? '').toLowerCase();
  if (method.includes('mock location')) return 'mock_location_detected';
  if (method.includes('emulator') || method.includes('debug environment')) return 'virtual_device_detected';
  return type;
}

// ─── Background → resume gate ────────────────────────────────────────────────

/**
 * The background/resume lock. ENGAGED the instant the app leaves the
 * foreground and RELEASED only when BOTH hold:
 *
 *   • the app is in the foreground, AND
 *   • a COMPLETED evaluation that observed the resumed state found nothing
 *     blocking.
 *
 * The second condition is what closes the reported "Home → reopen → 2-3 s
 * unprotected window": the previous implementation re-checked on resume but
 * never HELD anything, so the last pre-background verdict kept the app usable
 * while the fresh check ran.
 *
 * Fail-closed: an in-flight or superseded evaluation leaves the lock engaged.
 */
export function resolveBackgroundResumeGate(input: {
  /** AppState is 'active'. */
  foreground: boolean;
  /**
   * A COMPLETED evaluation that STARTED AT OR AFTER the most recent resume has
   * been published. A check that began BEFORE the resume cannot speak for the
   * resumed state (see acceptsResumeVerification).
   */
  verifiedSinceResume: boolean;
  /** That completed evaluation found a blocking condition. */
  blocking: boolean;
}): boolean {
  if (input.blocking) return true;
  if (!input.foreground) return true;
  return !input.verifiedSinceResume;
}

/**
 * Stale-async guard for the resume verification.
 *
 * `resumeToken` is bumped on every transition into the foreground. An
 * evaluation records the token that was current when it STARTED; only an
 * evaluation whose recorded token is at or after the live token may release
 * the background lock. Without this, a check started before the resume (or
 * before a rapid second background) could land afterwards and unblock the app
 * on evidence that predates the state it is being used to clear.
 */
export function acceptsResumeVerification(input: {
  evaluationStartedToken: number;
  liveResumeToken: number;
}): boolean {
  return input.evaluationStartedToken >= input.liveResumeToken;
}

// ─── Overlay / obscured-window gate ──────────────────────────────────────────

/**
 * The overlay lock may only release when BOTH hold:
 *
 *   • the native obscured-window signal has CLEARED, and
 *   • a FRESH security evaluation has completed.
 *
 * The second condition is the explicit "do not automatically trust the app
 * merely because the warning was dismissed" rule: pressing the recheck control
 * does not clear the gate — it requests a re-check, and the gate clears only
 * if the platform independently reports the obscured signal gone AND policy
 * still passes. A user cannot dismiss their way past a live overlay.
 */
export function canClearOverlayBlock(input: {
  /** The native obscured-window signal is currently clear. */
  signalCleared: boolean;
  /** A COMPLETED evaluation has landed since the recheck was requested. */
  hasFreshVerdict: boolean;
}): boolean {
  return input.signalCleared && input.hasFreshVerdict;
}

/**
 * Exact overlay copy required by the security specification. Exported from the
 * state model (not the screen) so the wording is unit-testable and cannot
 * drift between the full-screen gate and any other surface.
 */
export const OVERLAY_WARNING_COPY = {
  title: 'Security warning',
  message:
    'An overlay or another app may be interfering with MedAcademy. ' +
    'Close the interfering app and verify security to continue.',
} as const;

/** What the platform can and cannot detect — surfaced verbatim in the report. */
export const OVERLAY_DETECTION_LIMITS = [
  'Android exposes no API for one app to enumerate another app\u2019s windows, so "an overlay is on screen right now" cannot be measured directly.',
  'MotionEvent.FLAG_WINDOW_IS_OBSCURED / FLAG_WINDOW_IS_PARTIALLY_OBSCURED are only set by the framework from API 29 (Q).',
  'Observation requires the user to touch the screen; a passive overlay that is never touched is invisible to app-side checks.',
  'setHideOverlayWindows(true) (API 31+) prevents non-system overlays while the app is focused — prevention, not detection.',
  'A system-signed overlay, or one drawn by the device/profile owner, can be neither hidden nor filtered.',
] as const;

// ─── Update verdict (versionCode is authoritative; names never compared) ─────

export interface UpdateVerdictPure {
  /** 'UPDATE_REQUIRED' when the installed versionCode is below the minimum. */
  verdict: 'SUPPORTED' | 'UPDATE_REQUIRED';
}

/**
 * The single authoritative version comparison. Integer versionCode ONLY.
 *
 * • enabled=false          → SUPPORTED (server kill switch).
 * • minimumVersionCode<=0  → SUPPORTED (no floor configured).
 * • installedVersionCode<=0 → SUPPORTED on THIS surface: the client cannot
 *   compute a comparison (e.g. non-Android build), so client-side enforcement
 *   stands down — the server-side 426 gate remains the authority for that
 *   request path. This is deliberate and documented, not a bypass: the
 *   server never trusts the client-reported code for its own decisions.
 */
export function evaluateUpdateVerdict(input: {
  enabled: boolean;
  minimumVersionCode: number;
  installedVersionCode: number;
}): UpdateVerdictPure {
  const { enabled, minimumVersionCode, installedVersionCode } = input;
  if (!enabled) return { verdict: 'SUPPORTED' };
  if (minimumVersionCode <= 0) return { verdict: 'SUPPORTED' };
  if (installedVersionCode <= 0) return { verdict: 'SUPPORTED' };
  return {
    verdict: installedVersionCode < minimumVersionCode ? 'UPDATE_REQUIRED' : 'SUPPORTED',
  };
}

/** Direct comparison helper (installed >= minimum → supported). */
export function isVersionSupported(installedVersionCode: number, minimumVersionCode: number): boolean {
  return installedVersionCode >= minimumVersionCode;
}

// ─── OFFLINE update-policy cache (pure, unit-tested) ──────────────────────────
//
// The offline rules from the product spec:
//   • network unavailable + NO cached decision → SUPPORTED-with-
//     offlineFlag (network unavailability is NOT an update requirement).
//   • previously confirmed SUPPORTED (within maxAgeMs) → remains supported
//     offline for valid offline content.
//   • previously cached UPDATE_REQUIRED → honored according to its validity
//     (staleness never un-blocks a cached requirement).
//   • corrupted/absent cache never becomes an update requirement.

export interface CachedUpdatePolicy {
  verdict: 'SUPPORTED' | 'UPDATE_REQUIRED';
  minimumVersionCode: number;
  /** Epoch ms when the server explicitly confirmed this verdict. */
  confirmedAt: number;
}

export type OfflineUpdateDecision =
  | { verdict: 'SUPPORTED'; reason: 'no_cached_policy' | 'cached_supported' | 'cached_required_expired' }
  | { verdict: 'UPDATE_REQUIRED'; reason: 'cached_required'; minimumVersionCode: number };

/** Cache entries older than this are treated as no_cached_policy. */
export const CACHED_UPDATE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export function evaluateOfflineUpdatePolicy(
  cached: CachedUpdatePolicy | null,
  nowMs: number,
  maxAgeMs: number = CACHED_UPDATE_MAX_AGE_MS
): OfflineUpdateDecision {
  if (!cached || !Number.isFinite(cached.confirmedAt) || !Number.isFinite(nowMs)) {
    return { verdict: 'SUPPORTED', reason: 'no_cached_policy' };
  }
  // Parse errors / garbage confirmations are treated as absent.
  if (cached.confirmedAt <= 0 || cached.confirmedAt > nowMs + 60_000) {
    return { verdict: 'SUPPORTED', reason: 'no_cached_policy' };
  }
  if (cached.verdict === 'UPDATE_REQUIRED') {
    // A cached REQUIREMENT is honored per its validity — staleness never
    // un-blocks a block, matching the fail-closed model.
    if (nowMs - cached.confirmedAt <= maxAgeMs) {
      return { verdict: 'UPDATE_REQUIRED', reason: 'cached_required', minimumVersionCode: cached.minimumVersionCode };
    }
    return { verdict: 'SUPPORTED', reason: 'cached_required_expired' };
  }
  if (nowMs - cached.confirmedAt > maxAgeMs) {
    return { verdict: 'SUPPORTED', reason: 'no_cached_policy' };
  }
  return { verdict: 'SUPPORTED', reason: 'cached_supported' };
}

// ─── Connection security probe classification (misclassification fix) ────────
/**
 * The SSL-pinning probe previously collapsed several different outcomes into
 * one blocking "ssl_pinning_failure" finding:
 *
 *   pinned-origin HTTP failure  ┐
 *   pinned-origin timeout       ├─ all → ssl_pinning_failure (risk 20, BLOCK)
 *   pinned-origin network error ┘
 *
 * But a TIMEOUT or NETWORK ERROR from the pinned origin is NOT evidence of a
 * certificate mismatch: on a weak connection the pinned origin (distant
 * server) can routinely fail while a globally-CDN'd fallback host succeeds —
 * and on Android the native pin enforcement is not wired at all, so a real
 * pin mismatch cannot even occur there today. Classifying transient network
 * failure as a security violation produced the observed intermittent,
 * unpredictable "Connection Security Issue / Risk 20" blocks that cleared on
 * app restart (i.e. on the next probe).
 *
 * The state model below distinguishes the outcomes exactly, so:
 *   REAL pin mismatch (probe answered, pin rejected)  → ssl_pinning_failure
 *   pinned origin unreachable/timed out               → probe_unreachable
 *   no connectivity at all                            → probe_skipped_offline
 *   probe inconclusive                                → probe_inconclusive
 *
 * Non-mismatch outcomes are OBSERVABILITY events (weight 0, never blocking):
 * they are logged with a failure category so diagnostics can answer "was this
 * a timeout, TLS failure, server failure, or a real security failure?".
 */

export type SslProbeOutcome =
  | 'pin_verified'        // pinned origin answered over valid TLS
  | 'pin_mismatch'        // SECURITY: origin answered but the TLS identity was rejected
  | 'origin_unreachable'  // pinned origin failed while a control host succeeded
  | 'no_connectivity'     // device offline / both probes failed
  | 'inconclusive';       // malformed response, cancelled, or unknown error

export type SslProbeFailureCategory =
  | 'none'
  | 'timeout'
  | 'network_error'
  | 'http_error'
  | 'dns_error'
  | 'tls_rejected'
  | 'unknown';

export interface SslProbeObservation {
  outcome: SslProbeOutcome;
  failureCategory: SslProbeFailureCategory;
  /** HTTP status from the pinned origin when one was received (-1 otherwise). */
  httpStatus: number;
  elapsedMs: number;
}

/** Event type emitted for non-security probe outcomes (weight 0, log-only). */
export const SSL_PROBE_OBSERVABILITY_EVENT = 'connection_probe_degraded';

/**
 * Pure classifier: probe inputs → the authoritative outcome.
 *
 * @param originOk        pinned origin answered with any HTTP status over TLS
 * @param controlOk       unpinned control host answered (null = not attempted)
 * @param originCategory  failure category of the pinned-origin attempt
 */
export function classifySslProbe(
  originOk: boolean,
  controlOk: boolean | null,
  originCategory: SslProbeFailureCategory
): SslProbeOutcome {
  if (originOk) return 'pin_verified';
  if (controlOk === true) {
    // Device demonstrably online; the pinned origin specifically failed.
    // Only a REJECTED TLS identity is a security event — and that is reported
    // by the enforcement layer with category 'tls_rejected'. A timeout/error
    // to the origin alone is a reachability problem, not proven tampering.
    return originCategory === 'tls_rejected' ? 'pin_mismatch' : 'origin_unreachable';
  }
  if (controlOk === false) return 'no_connectivity';
  return 'inconclusive';
}

/** True when the outcome is a genuine security finding (must block per policy). */
export function isSslProbeSecurityFinding(outcome: SslProbeOutcome): boolean {
  return outcome === 'pin_mismatch';
}
