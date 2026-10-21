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

// ─── MANDATORY CONNECTION BLOCK (VPN / proxy) ────────────────────────────────
//
// ROOT CAUSE of the reported bypass (real iPhone):
//   VPN detection worked, but the app still showed the DISMISSIBLE
//   security-warning screen with a "Continue Anyway" button, so the user could
//   enter the app and make API requests while the VPN was active.
//
//   The client is fully server-driven (getSecurityPolicies() merges the
//   authoritative security_policies rows over the bundled defaults), and the
//   shipped defaults already said `vpn → block_login`. The observed warn-level
//   behaviour therefore came from the POLICY ROW resolving vpn/proxy to
//   `warn_only` (or a disabled row) — i.e. a *configuration* value was allowed
//   to downgrade a connection-security block into a dismissible warning.
//   docs/DEVICE_VALIDATION_CHECKLIST.md §10 documented exactly that split
//   ("If your server's authoritative security_policies resolves VPN/proxy to
//   warn_only, you instead get the dismissible security-warning screen").
//
// THE RULE (owner requirement): a CONFIRMED VPN/proxy transport can never be
// down-graded below block_login — not by a server row, not by a disabled row,
// not by a deep link, not by a patched screen. This mirrors the backend's own
// MANDATORY_BLOCK write-path refusal (SecurityController), which refuses to
// weaken developer_options/debug/tamper/play_integrity. The floor is applied in
// BOTH planes:
//   • server  — /security/policies serves vpn/proxy as block_login; the admin
//               write path refuses anything weaker.
//   • client  — applyMandatoryConnectionFloor() below, so an offline launch
//               (bundled defaults), a stale cache, or an older/downgraded row
//               cannot resurrect the dismissible path.
//
// SCOPE — deliberately narrow:
//   • only the connection detectors (vpn, proxy);
//   • only a CONFIRMED detection is blocking. A detector that could not run is
//     reported as degraded/unavailable EVIDENCE (weight 0, never a block, never
//     a silent "clean") — see VPN_SIGNAL_DEGRADED_EVENT. Unreliable heuristics
//     must never lock a user out of ordinary Wi-Fi/mobile-data use.
//
// The admin-sanctioned escape hatch is unchanged: security_vpn_whitelist (any
// row ⇒ detection is skipped by design, documented in the checklist §10.9) and
// the five-minute policy cache that re-reads the server rows.

export const CONNECTION_DETECTION_TYPES = ['vpn', 'proxy'] as const;
export type ConnectionDetectionType = (typeof CONNECTION_DETECTION_TYPES)[number];

/** The action vpn/proxy can never be downgraded below. */
export const MANDATORY_CONNECTION_ACTION: PurePolicyAction = 'block_login';

/** Event types emitted by the connection detectors. */
export const CONNECTION_DETECTION_EVENTS = ['vpn_detected', 'proxy_detected'] as const;

/** True for a finding produced by the VPN or proxy detector. */
export function isConnectionFinding(eventType: string): boolean {
  return (CONNECTION_DETECTION_EVENTS as readonly string[]).includes(eventType);
}

/** True when any live finding is a connection (VPN/proxy) finding. */
export function hasConnectionFinding(threats: ReadonlyArray<{ type: string; detected?: boolean }>): boolean {
  return threats.some((t) => t.detected !== false && isConnectionFinding(t.type));
}

/**
 * Applies the mandatory floor to a resolved policy table (pure; returns a new
 * object). `enabled: false` rows cannot opt out either: a disabled detection
 * resolves to log_only everywhere else, but for the connection detectors that
 * would silently re-open the dismissible path the report is about.
 */
export function applyMandatoryConnectionFloor<T extends PurePolicies>(policies: T): T {
  const floored: PurePolicies = { ...policies };
  for (const detection of CONNECTION_DETECTION_TYPES) {
    // Always SET the key (not merely overwrite an existing one): a table that
    // lost it would otherwise resolve to "no action" for a live VPN finding,
    // i.e. fail open.
    floored[detection] = MANDATORY_CONNECTION_ACTION;
  }
  // Generic-preserving cast: the only writes are the two keys named in
  // CONNECTION_DETECTION_TYPES, which every policy table typed by the caller
  // carries (the runtime merge starts from the bundled defaults).
  return floored as T;
}

/**
 * Evidence event for a connection detector that could NOT run its authoritative
 * signal path (iOS without the native two-gate module ⇒ the weak NetInfo
 * fallback, or a thrown probe). It carries weight 0 and is deliberately NOT
 * mapped in DETECTION_TO_EVENT: it can never block and never warn, but it also
 * never lets the device be reported as "verified clean" — the gap is visible in
 * the security event trail (policy_action log_only) and in the diagnostics log.
 */
export const VPN_SIGNAL_DEGRADED_EVENT = 'vpn_detection_degraded';

export type VpnSignalPath = 'native' | 'netinfo-fallback' | 'unavailable';

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
  | 'BLOCKED_MULTI_WINDOW'
  | 'BLOCKED_BACKGROUND_RESUME'
  | 'BLOCKED_VPN'
  | 'BLOCKED_SECURITY_VIOLATION'
  | 'ALLOWED';

/** Every state, for exhaustive tests / future consumers. */
export const SECURITY_GATE_STATES: readonly SecurityGateState[] = [
  'CHECKING',
  'BLOCKED_OVERLAY',
  'BLOCKED_MULTI_WINDOW',
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
   * The platform reports THIS app in a prohibited window mode (split-screen /
   * other multi-window mode, or our own picture-in-picture). A window-state
   * restriction, not a policy finding: it says nothing about the device being
   * compromised, only that protected content must not be presented in a window
   * the user can pair with another app.
   */
  multiWindowBlocked: boolean;
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
 *   2. BLOCKED_MULTI_WINDOW        — this app is in a prohibited window mode.
 *   3. BLOCKED_VPN                 — policy block caused by a VPN/proxy.
 *   4. BLOCKED_SECURITY_VIOLATION  — any other policy block.
 *   5. BLOCKED_BACKGROUND_RESUME   — left the foreground; not yet re-verified.
 *   6. CHECKING                    — no completed verdict, or a check running.
 *   7. ALLOWED                     — completed verdict, nothing blocking.
 *
 * BLOCKED_MULTI_WINDOW ranks directly below BLOCKED_OVERLAY because both are
 * WINDOW-STATE causes rather than policy verdicts: the cause and the recovery
 * are the same window, so the screen must speak about the window rather than
 * list policy findings.
 *
 * WHY A CONFIRMED POLICY BLOCK OUTRANKS THE RESUME HOLD (changed deliberately):
 * the resume hold is an INTERIM state with no screen of its own — the app shell
 * is restored immediately and verified asynchronously — so if it outranked the
 * policy states, a violation confirmed DURING a resume would be masked by a
 * state that renders nothing, and the user would face refused requests with no
 * explanation. Routing the violation to its own authoritative screen the moment
 * it is confirmed is required, and it weakens nothing: CONTAINMENT is driven by
 * the lock holders, not by which state is displayed. The resume holder stays
 * engaged until a clean post-resume evaluation lands, so protected operations
 * remain blocked either way.
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
  if (input.multiWindowBlocked) return 'BLOCKED_MULTI_WINDOW';
  // A CONFIRMED violation always wins over the interim resume hold (see the
  // precedence note above): the hold has no screen, the violation has one.
  if (input.vpnBlocked) return 'BLOCKED_VPN';
  if (input.violationBlocked) return 'BLOCKED_SECURITY_VIOLATION';
  if (input.backgroundResumeBlocked) return 'BLOCKED_BACKGROUND_RESUME';
  if (!input.hasVerdict || input.evaluating) return 'CHECKING';
  return 'ALLOWED';
}

/**
 * Which states RENDER a full-screen authoritative block page.
 *
 * `isGateBlocked` answers "must protected content/operations be withheld?" and
 * stays true for every BLOCKED_* state. This answers the different question
 * "does this state take over the whole screen?" — and the answer for
 * BLOCKED_BACKGROUND_RESUME is NO: an ordinary resume restores the app shell
 * immediately and verifies asynchronously, with protected operations refused by
 * the central lock until a clean post-resume verdict lands. Showing the user a
 * full-screen VERIFYING page for that interim state was the reported defect
 * (a visible verification interruption on a clean device, sometimes for tens of
 * seconds, plus a Continue control that could not clear it).
 */
export function rendersBlockScreen(state: SecurityGateState): boolean {
  return state === 'BLOCKED_OVERLAY'
    || state === 'BLOCKED_MULTI_WINDOW'
    || state === 'BLOCKED_VPN'
    || state === 'BLOCKED_SECURITY_VIOLATION';
}

/** True for the states in which protected content must not be visible. */
export function isGateBlocked(state: SecurityGateState): boolean {
  return state === 'BLOCKED_OVERLAY'
    || state === 'BLOCKED_MULTI_WINDOW'
    || state === 'BLOCKED_BACKGROUND_RESUME'
    || state === 'BLOCKED_VPN'
    || state === 'BLOCKED_SECURITY_VIOLATION';
}

/**
 * True when the user can clear the state by acting and then re-verifying.
 *
 * Only states the USER can resolve by acting get the control: an overlay app
 * they can close, a backgrounded session that re-verifies on return, and — new
 * in this round — a VPN/proxy they can switch off. The reported flow is exactly
 * "turn the VPN off, then get back in": the control only REQUESTs a re-check, it
 * can never force the gate open (the state clears when a FRESH authoritative
 * evaluation finds no blocking finding), so it is not a dismiss path.
 *
 * A generic integrity violation (root/tamper) stays without a control: retrying
 * cannot change a device condition that has not changed.
 *
 * BLOCKED_MULTI_WINDOW deliberately has NO control either — and that is the
 * whole point of this restriction. A "Verify" button here would read as an
 * acknowledgement the user can tap while still in split-screen, i.e. a bypass.
 * Returning the app to full-screen is the ONLY way out: the native window-mode
 * signal then reports "fullscreen" (the activity callback, the window layout
 * pass and the resume hook all push it) and the gate re-verifies automatically.
 *
 * BLOCKED_BACKGROUND_RESUME has no control either, because it renders no page:
 * the resume verification always starts on its own and completes on its own, so
 * there is nothing for the user to press — and nothing they COULD press could
 * clear it faster (the previous Continue control was in fact a no-op whenever an
 * evaluation was already running; see the resume-verification suite).
 */
export function isGateRecheckable(state: SecurityGateState): boolean {
  return state === 'BLOCKED_OVERLAY'
    || state === 'BLOCKED_VPN';
}

// ─── NETWORK LOCK (temporary suspension of the app's own traffic) ───────────
//
// WHY: withholding protected CONTENT is not the same as withholding the app's
// own NETWORK ACTIVITY. A video is authorized by a request; a PDF is fetched by
// a request; progress is written by a request. While a mandatory verification
// is pending, the transport therefore suspends the app's traffic instead of
// merely hiding screens — the state below is that suspension, named.
//
// THE LOCK IS TEMPORARY AND SELF-CLEARING: it is released by a completed, clean
// post-event verification (never by a timer, never by a user tap), and a
// confirmed violation keeps a holder engaged so the lock never reaches the
// unlocked state on a blocked device.

export type NetworkAccessState = 'NETWORK_LOCKED' | 'NETWORK_OPEN';

/** Every network-access state, for exhaustive tests / future consumers. */
export const NETWORK_ACCESS_STATES: readonly NetworkAccessState[] = [
  'NETWORK_LOCKED',
  'NETWORK_OPEN',
] as const;

/**
 * The single authoritative answer to "is the app's own traffic suspended?".
 *
 * Deliberately a pure function of ONE input (the central lock's holder state)
 * so it can never disagree with the transport: the transport and every UI
 * consumer derive from the same holders.
 */
export function resolveNetworkAccessState(input: { locked: boolean }): NetworkAccessState {
  return input.locked ? 'NETWORK_LOCKED' : 'NETWORK_OPEN';
}

/**
 * The documented SCOPE of the network lock. Written down (and tested) so nobody
 * — in code, docs or a status report — claims more than the architecture
 * delivers.
 */
export const NETWORK_LOCK_SCOPE = {
  /** Suspended while the lock is held (before any network I/O). */
  covered: [
    'central API client (apiFetch / apiFetchOnce): queued, then replayed once on unlock, or refused at the bound',
    'in-flight registered protected requests: aborted immediately by containment',
    'storage uploads through the API client: refused while locked',
    'VdoCipher chunk uploads: held between chunks, resumed on unlock',
    'protected playback: native player and WebView player stopped and unmounted',
  ],
  /**
   * NOT suspended. These are separate TCP connections opened by a WebView, an
   * iframe, a native media SDK or the OS — invisible to any JS-layer gate.
   */
  notCovered: [
    'the YouTube embed inside the player WebView (it talks to YouTube on its own connection)',
    'an already-established native media stream that ignores pause()',
    'any traffic the OS or another app performs on the device',
  ],
  /**
   * What is used instead where a socket-level block is unavailable: stop the
   * load, pause the player, detach the cross-origin frame, and (for a player
   * that has not mounted yet) never render it in the first place.
   */
  mitigation: 'stop-load + player teardown + unmount gate; never claimed to be a device-wide block',
} as const;

// ─── Finding → user-facing copy key ─────────────────────────────────────────

/**
 * Map a BLOCKING finding to the copy key used to describe it on screen.
 *
 * WHY THIS EXISTS (observed on-device defect): the security engine collapses
 * unrelated conditions into the single event type `debug_detected` —
 *
 *   • a test-only / debuggable build (`testOnlyBuild`, `__DEV__`)
 *   • an emulator-like device (`emulatorDetected`)
 *
 * — and the gate rendered one shared piece of copy for both: "Insecure Build
 * Detected / Install the official production release of the app." On an
 * emulator-like device that is false advice: the installation is not insecure,
 * and reinstalling the official release cannot clear a device condition. The
 * displayed finding therefore contradicted the result that produced it
 * (finding, risk score and gate decision disagreed).
 *
 * The event type stays `debug_detected` — it is the policy/audit vocabulary and
 * `debug` → block_login must keep blocking — and so do the risk weight (20) and
 * the gate decision. Only the PRESENTATION is corrected, using the engine's own
 * `detectionMethod` to describe the sensor that actually fired.
 *
 * Mock location is NOT a producer of `debug_detected` any more: that detector
 * was removed outright (no field, no event, no score) — see
 * docs/MOCK_LOCATION_REMOVAL.md. Any legacy `mock_location_detected` key still
 * arriving from persisted evidence falls through to the generic copy, which is
 * accurate because the condition is no longer evaluated.
 */
export function resolveFindingCopyKey(type: string, detectionMethod?: string | null): string {
  if (type !== 'debug_detected') return type;
  const method = (detectionMethod ?? '').toLowerCase();
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
 * ─── Resume-verification evidence policy (what may be reused, and when) ─────
 *
 * The resume re-check must be FAST without being weaker. The rules, in one
 * place so a reviewer can audit them rather than infer them:
 *
 *  1. A VERDICT IS NEVER REUSED ACROSS A RESUME. `acceptsResumeVerification`
 *     below is the enforcement: only an evaluation that STARTED at or after the
 *     current resume may clear the hold, so "it was clean two minutes ago" can
 *     never stand in for "it is clean now". A resume therefore always runs a
 *     real evaluation; the async/coalesced scheduler is what makes it fast, not
 *     a skipped check.
 *  2. SUB-MEASUREMENTS INSIDE ONE EVALUATION may be reused under their own
 *     existing, bounded validity rules — the native flags batch (a single bridge
 *     call, short TTL) and the server policy/config caches (long TTL, refreshed
 *     independently). A chained re-run that starts within those windows reuses
 *     them instead of paying for the same native/network work twice.
 *  3. EVERYTHING ELSE INVALIDATES: a native signal (VPN state change, window-mode
 *     change), a network change, a foreground transition, a new verdict or a
 *     session identity change all bump a sequence/token, which makes any older
 *     evaluation ineligible to release a hold. Fail-closed by construction.
 */
export const RESUME_VERIFICATION_EVIDENCE_POLICY = {
  /** Cross-resume verdict reuse: never. */
  verdictReuseAcrossResume: false,
  /** Sub-measurements are reused only within their own bounded validity window. */
  subMeasurementReuse: 'within-ttl',
  /** Clearing the hold requires an evaluation that STARTED at/after the resume. */
  releaseRequiresPostResumeEvaluation: true,
} as const;

/**
 * How long a resume verification may stay UNRESOLVED before the app treats it as
 * overdue, retries it once, and reports it as evidence.
 *
 * A timeout is a REPORTING threshold, never an authorization: crossing it must
 * not release protected access (see `isResumeVerificationOverdue` — it returns a
 * boolean about the PENDING state, and the caller is forbidden to convert it
 * into a release). The periodic scheduler and the retry keep working after it.
 */
export const RESUME_VERIFICATION_TIMEOUT_MS = 8000;

/**
 * True when a resume verification has been pending longer than `timeoutMs`.
 * Outreach used for: (a) reporting/instrumentation, (b) scheduling the single
 * bounded retry. NOTHING may use it to release the hold — an unresolved
 * mandatory check stays closed.
 */
export function isResumeVerificationOverdue(input: {
  /** Monotonic ms when the resume verification was requested (null = none pending). */
  pendingSinceMs: number | null;
  /** Monotonic ms now. */
  nowMs: number;
  timeoutMs?: number;
}): boolean {
  const timeout = input.timeoutMs ?? RESUME_VERIFICATION_TIMEOUT_MS;
  if (input.pendingSinceMs === null) return false;
  if (!Number.isFinite(input.pendingSinceMs) || !Number.isFinite(input.nowMs)) return false;
  return input.nowMs - input.pendingSinceMs >= timeout;
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

// ─── Multi-window / split-screen gate (mandatory full-screen usage) ──────────

/**
 * The three window modes the native module can REPORT. They are the platform's
 * own documented values, not an inference:
 *
 *   fullscreen         nothing to enforce.
 *   multi_window       split-screen, a freeform/desktop app window, or any
 *                      other Android multi-window presentation of THIS app.
 *   picture_in_picture THIS app is floating in PiP (documented as a special
 *                      case of multi-window, which is why it is classified
 *                      first and worded separately from a split screen).
 *
 * `unknown` (the fourth platform value) is NOT listed as a prohibited mode: an
 * unmeasurable signal must never become a confirmed finding.
 */
export type WindowMode = 'fullscreen' | 'multi_window' | 'picture_in_picture' | 'unknown';

/** True for the modes in which protected content must not be presented. */
export function isProhibitedWindowMode(mode: WindowMode | string | null | undefined): boolean {
  return mode === 'multi_window' || mode === 'picture_in_picture';
}

/**
 * Exact copy for the two prohibited window modes. Split-screen and a floating
 * window are DIFFERENT conditions with different recovery actions, and neither
 * is an overlay — so the wording never claims an overlay was detected (an
 * overlay is a separate, separately-measured signal: OVERLAY_WARNING_COPY).
 */
export const MULTI_WINDOW_WARNING_COPY = {
  title: 'Full-screen required',
  message:
    'Split-screen detected. MedAcademy must be used full-screen, so protected '
    + 'content is hidden until you close split-screen and the app is back to '
    + 'normal full-screen usage.',
} as const;

export const PICTURE_IN_PICTURE_WARNING_COPY = {
  title: 'Full-screen required',
  message:
    'MedAcademy is in a floating window (picture-in-picture), which is not '
    + 'allowed. Close the floating window and open the app full-screen to '
    + 'continue — access is restored automatically.',
} as const;

/** Pick the copy for the mode the platform actually reported. */
export function windowModeBlockCopy(mode: WindowMode | string | null | undefined): {
  title: string;
  message: string;
} {
  return mode === 'picture_in_picture' ? PICTURE_IN_PICTURE_WARNING_COPY : MULTI_WINDOW_WARNING_COPY;
}

/**
 * What the user must do, per mode. Rendered on the blocking screen; kept here
 * (like connectionBlockInstructions) so the instructions cannot drift between
 * the gate and any other surface.
 */
export function windowModeBlockSteps(mode: WindowMode | string | null | undefined): readonly string[] {
  if (mode === 'picture_in_picture') {
    return [
      'Close the floating MedAcademy window (drag it to the bottom of the screen, or open the app from Recents).',
      'Open MedAcademy normally \u2014 it must fill the screen.',
      'Access returns automatically as soon as the app is full-screen again.',
    ];
  }
  return [
    'Open the recent-apps view (the square/gesture button) and choose "Full screen" / drag the divider to the top or bottom edge.',
    'Or close the app paired with MedAcademy and reopen MedAcademy on its own.',
    'Access returns automatically as soon as MedAcademy is back to full-screen.',
  ];
}

/**
 * The multi-window lock may only release when BOTH hold:
 *
 *   • the platform reports the app back in FULL SCREEN, and
 *   • a FRESH security evaluation has completed.
 *
 * Same two-condition shape as the overlay rule, for the same reason: the first
 * condition is the required proof that the prohibited state is gone, and the
 * second one guarantees the app never unblocks on a verdict that predates it.
 * There is deliberately NO third, user-tappable condition — the user cannot
 * acknowledge their way past this restriction. Both are read from the
 * authoritative lock/verdict state, never from UI state.
 */
export function canClearMultiWindowBlock(input: {
  /** The platform now reports the app in the permitted (full-screen) mode. */
  modeRestored: boolean;
  /** A COMPLETED evaluation has landed since the lock was engaged. */
  hasFreshVerdict: boolean;
}): boolean {
  return input.modeRestored && input.hasFreshVerdict;
}

/**
 * What Android can and cannot tell us about other apps' windows — surfaced
 * verbatim in the implementation report. Split-screen/multi-window detection of
 * THIS app is real and mandatory; "another app is floating over us" is NOT
 * detectable, and nothing here pretends otherwise.
 */
export const MULTI_WINDOW_DETECTION_LIMITS = [
  'Activity.isInMultiWindowMode() (API 24+) answers for THIS app only: split-screen, a freeform/desktop app window, and our own picture-in-picture all report true (PiP is documented as a special case of multi-window).',
  'Activity.isInPictureInPictureMode() (API 24+) reports only that THIS app is floating in PiP. Another app being in PiP, split-screen, or a floating window is NOT observable: Android provides no public API for one app to enumerate another app\u2019s windows.',
  'AccessibilityService.getWindows() could observe other apps\u2019 windows, but it requires an accessibility service \u2014 a broad, sensitive permission this app deliberately does not request for a learning product (privacy, and Play policy). No permission is requested for multi-window detection: the APIs above need none.',
  'OEM floating-window features (MIUI, One UI, EMUI and similar) are vendor UI layered over the documented APIs. When a vendor puts MedAcademy itself in a resizable/floating window the documented multi-window state reports it; when a vendor feature only affects OTHER apps, nothing is claimed.',
  'The multi-window signal and the obscured-window/overlay signal are DIFFERENT measurements and are never conflated: a prohibited window mode is never reported as an overlay, and the touch-path overlay evidence is never reported as a split screen.',
  'A failed, absent or not-yet-available measurement reports "unknown" and is treated as "not measurable on this device" \u2014 never as proof of full-screen use, and never as a confirmed finding.',
] as const;

/** What the platform can and cannot detect — surfaced verbatim in the report. */
// ─── VPN / proxy block copy + documented iOS detection limits ────────────────

export type VpnBlockCopy = { title: string; message: string };

/**
 * Exact copy for the mandatory VPN/proxy block. Lives in the pure model (like
 * OVERLAY_WARNING_COPY) so the wording is unit-testable, shared by the
 * authenticated gate AND the pre-login block screen, and cannot drift.
 *
 * It deliberately does NOT claim the app can disable a third-party VPN: iOS
 * gives an app no API to stop a Network Extension another app owns.
 */
export const VPN_WARNING_COPY: VpnBlockCopy = {
  title: 'VPN or proxy detected',
  message:
    'MedAcademy cannot be used while a VPN or proxy is active. Turn it off in '
    + 'iOS Settings or in your VPN app, then return to this screen \u2014 the app re-checks automatically.',
};

/**
 * Step-by-step guidance per platform. Rendered on the blocking screen; kept
 * here so the same instructions are used pre-login and post-login.
 */
export function connectionBlockInstructions(platform: string): readonly string[] {
  if (platform === 'ios') {
    return [
      'Open Settings \u2192 General \u2192 VPN & Device Management \u2192 VPN and set Status to Not Connected.',
      'If a VPN app installed it (WireGuard, OpenVPN, Tailscale, NordVPN, WARP\u2026), open that app and disconnect there \u2014 iOS only manages it from Settings when it is configured as a personal VPN.',
      'If a proxy is configured, open Settings \u2192 Wi-Fi \u2192 (i) next to your network \u2192 Configure Proxy \u2192 Off.',
      'Return to MedAcademy. Access is restored when the next check finds no VPN or proxy.',
    ];
  }
  if (platform === 'android') {
    return [
      'Open Settings \u2192 Network & internet \u2192 VPN and disconnect the active profile.',
      'Or open the VPN app and disconnect there, then stop its always-on/per-app VPN setting.',
      'If a proxy is configured, open the Wi-Fi network \u2192 Advanced \u2192 Proxy and set it to None.',
      'Return to MedAcademy. Access is restored when the next check finds no VPN or proxy.',
    ];
  }
  return [
    'Disconnect the active VPN or proxy on this device.',
    'Return to MedAcademy. Access is restored when the next check finds no VPN or proxy.',
  ];
}

/**
 * What iOS can and cannot tell us — the honest limits, surfaced verbatim in the
 * implementation report (mirrors OVERLAY_DETECTION_LIMITS).
 */
export const VPN_DETECTION_LIMITS = [
  'iOS never names the VPN vendor: NO public API lets an app enumerate VPN configurations or read the active tunnel\u2019s owner.',
  'The authoritative iOS signal is a two-gate check \u2014 NWPathMonitor (is the active path a non-standard interface type?) plus getifaddrs with IFF_UP (is a utun*/ipsec*/ppp* interface actually up?). Both must agree, which is what removed the old 100% false-positive rate from iOS\u2019s permanent utun0/1/2 interfaces.',
  'Without the native SecurityModule the detector falls back to @react-native-community/netinfo where ONLY type===\'vpn\' counts; packet-tunnel VPNs (WireGuard, OpenVPN, Tailscale, Cloudflare WARP) commonly report as wifi/other and are MISSED. That degraded path is reported as evidence (' + VPN_SIGNAL_DEGRADED_EVENT + ') \u2014 never as a verified clean device.',
  'DNS-only VPNs, per-app VPNs that never become the active path transport, and iCloud Private Relay (Apple surfaces it as .wifi/.cellular) are accepted gaps, not detections.',
  'Proxy detection uses CFNetworkCopySystemProxySettings (HTTP/HTTPS/SOCKS); a PAC/auto-config URL is reported as a proxy configuration.',
  'An app cannot turn a third-party VPN off: the blocking screen must instruct the user, and only the fresh security evaluation can restore access.',
] as const;

export const OVERLAY_DETECTION_LIMITS = [
  'Android exposes no API for one app to enumerate another app\u2019s windows, so "an overlay is on screen right now" cannot be measured directly.',
  'MotionEvent.FLAG_WINDOW_IS_OBSCURED / FLAG_WINDOW_IS_PARTIALLY_OBSCURED are only set by the framework from API 29 (Q).',
  'Observation requires the user to touch the screen; a passive overlay that is never touched is invisible to app-side checks.',
  'setHideOverlayWindows(true) (API 31+) prevents non-system overlays while the app is focused — prevention, not detection.',
  'A system-signed overlay, or one drawn by the device/profile owner, can be neither hidden nor filtered.',
] as const;

// ─── Update verdict (versionCode is authoritative; names never compared) ─────

// ─── Update gate placement (block ONLY a confirmed mandatory update) ─────────
//
// Two startup-wall defects lived here; both came from treating the BACKGROUND
// version request as a render dependency.
//
//  ROOT CAUSE #1 (first fix): the root ForceUpdateGate hard-blocked on
//    `verdict === 'UNKNOWN' && evaluating` (and on any UPDATE_REQUIRED) for the
//    WHOLE app, above authentication — a signed-out cold start rendered the
//    update screen instead of the normal startup/sign-in flow purely because
//    the request had not answered yet.
//
//  ROOT CAUSE #2 (this fix): the SAME unresolved state STILL hard-blocked the
//    protected surface. A restored session therefore replaced the entire app
//    shell with a full-screen "Checking for updates…" spinner until
//    /app/version answered, and because a failed attempt left `evaluating`
//    true forever, an unreachable or slow endpoint left that wall up
//    permanently.
//
// The verdict is now one of three values, and only one of them may block:
//
//   SUPPORTED        → nothing to do; normal app.
//   UPDATE_REQUIRED  → confirmed mandatory update: full-screen gate blocks the
//                      protected shell AND the authentication checkpoints.
//   UNKNOWN          → unresolved (a check is in flight, or the last attempt
//                      failed). The app renders normally; the result is applied
//                      the moment it lands. NEVER a reason to hide the UI.
//
// `resolveUpdateGateDecision` still reports UNKNOWN as 'pending' so callers can
// distinguish "no verdict yet" from "verdict says fine", but the single
// predicate both gates use — `updateGateBlocks` — blocks ONLY on a confirmed
// requirement. Enforcement is not weakened: a confirmed requirement blocks the
// protected shell (root gate + (app) gate) and every authentication checkpoint
// (`resolveUpdateCheckpoint`), and the server-side HTTP 426 rejection of every
// protected call remains the real boundary — an unknown state can never be
// spent to reach protected data.
//
// NOTE: the mode is intentionally NOT part of the block decision — that is the
// shipped semantics (any UPDATE_REQUIRED blocks), preserved here so this change
// cannot weaken enforcement. The OPTIONAL banner path in ForceUpdateScreen is
// left untouched.

export type UpdateGateDecision = 'none' | 'pending' | 'required';

export function resolveUpdateGateDecision(input: {
  verdict: 'SUPPORTED' | 'UPDATE_REQUIRED' | 'UNKNOWN';
  /** A version check is currently in flight (informational — never blocks). */
  evaluating: boolean;
  /** The surface about to render is the authenticated/protected shell. */
  protectedSurface: boolean;
}): UpdateGateDecision {
  if (!input.protectedSurface) return 'none';
  if (input.verdict === 'UPDATE_REQUIRED') return 'required';
  // Unresolved (in flight OR the last attempt failed) — a background request,
  // never a shield in front of the app.
  if (input.verdict === 'UNKNOWN') return 'pending';
  return 'none';
}

/** True when the decision must BLOCK (only a confirmed mandatory update). */
export function updateGateBlocks(decision: UpdateGateDecision): boolean {
  return decision === 'required';
}

/**
 * What an authentication checkpoint should do with the current verdict.
 *
 *   'block'   — confirmed mandatory update: do not create a session; the
 *               full-screen update gate takes over.
 *   'proceed' — explicit SUPPORTED verdict: authenticate normally.
 *   'wait'    — a check is in flight: join it (one shared request) for a bounded
 *               budget, then re-plan.
 *   'retry'   — UNKNOWN with no check running (the last attempt failed): start a
 *               fresh check once and await it, bounded; a failure is never
 *               mistaken for "no update needed", and never blocks sign-in.
 */
export type UpdateCheckpointPlan = 'block' | 'proceed' | 'wait' | 'retry';

export function resolveUpdateCheckpoint(input: {
  verdict: 'SUPPORTED' | 'UPDATE_REQUIRED' | 'UNKNOWN';
  evaluating: boolean;
}): UpdateCheckpointPlan {
  if (input.verdict === 'UPDATE_REQUIRED') return 'block';
  if (input.verdict === 'SUPPORTED') return 'proceed';
  return input.evaluating ? 'wait' : 'retry';
}

/**
 * Races a pending version check against a bounded budget.
 *
 * Needed so an authentication checkpoint can "wait for the answer if it is
 * imminent" without ever stranding the user on an endpoint that never answers.
 * The pending promise keeps running after a timeout (its result still lands in
 * the shared store); only the WAIT is bounded. Pure timing helper — no React,
 * no react-native — so the behaviour is unit-tested with plain node timers.
 */
export async function raceUpdateCheckWithTimeout<T>(
  pending: Promise<T>,
  timeoutMs: number
): Promise<{ value: T | null; timedOut: boolean }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { value: null, timedOut: true };
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<{ value: null; timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ value: null, timedOut: true }), timeoutMs);
  });
  try {
    return await Promise.race([
      pending.then((value) => ({ value, timedOut: false as const })),
      timeout,
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

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
