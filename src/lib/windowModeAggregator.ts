/**
 * WINDOW-MODE STATE AGGREGATOR — the ONE decision table for window-state evidence.
 *
 * SCOPE (floating-window protection removed):
 *
 *   This module tracks ONLY the two window states Android documents for an app:
 *   split-screen / freeform multi-window and picture-in-picture. The former
 *   "foreign window" (another app's floating / pop-up window) classification was
 *   REMOVED: it was derived from window-focus loss, produced repeated false
 *   positives (Recents, app switches, Samsung pop-up view teardown) and could not
 *   be proven with any public API. Nothing in the app reads or reports it now.
 *
 *   What remains is the part that was correct and is independent of that feature:
 *
 *     1. RAISE IMMEDIATELY. A prohibited reading from ANY producer is accepted on
 *        the spot. No debounce, no delay, ever.
 *     2. DEDUPLICATE. A reading identical to the state already in force changes
 *        nothing: no containment action, no bridge emission, no timeline mark.
 *     3. RELEASE ON ACTIVITY EVIDENCE. Only activity-level evidence (a real
 *        onMultiWindowModeChanged / onPictureInPictureModeChanged / onResume)
 *        may clear a prohibited hold; a snapshot of the same state may not, so
 *        our own cover taking focus can never unlock the gate.
 *     4. ORDER MATTERS. Observations carry a monotonic sequence; an observation
 *        older than the last accepted one is dropped instead of overwriting
 *        newer evidence.
 *
 * The native side (plugins/withSecurityModule.js, WindowModeBridge) implements
 * this same table so a genuine violation raises the native cover on the same
 * frame; this module is the JS authority for the belief the app acts on.
 */

export type WindowModeName =
  | 'fullscreen'
  | 'multi_window'
  | 'picture_in_picture'
  | 'unknown';

/**
 * Where an observation came from. `activity` (MainActivity callbacks) is
 * activity-level evidence; everything else is a snapshot of the same physical
 * state and is therefore weaker.
 */
export type WindowModeEvidence =
  | 'activity'
  | 'layout'
  | 'flags'
  | 'read'
  | 'install'
  | 'resume';

export type WindowModeDecision = 'accept' | 'duplicate' | 'rejected' | 'ignore-unknown';

export interface WindowModeState {
  /** Last accepted mode (`unknown` until a real measurement lands). */
  mode: WindowModeName;
  /** True only once a REAL measurement was accepted. */
  measured: boolean;
  /** Highest accepted observation sequence. */
  lastSeq: number;
  /** Duplicate observations collapsed since the last accepted transition. */
  suppressed: number;
  /** Weak full-screen snapshots refused while a prohibited mode was in force. */
  rejected: number;
}

export interface WindowModeObservation {
  mode: WindowModeName;
  evidence: WindowModeEvidence;
  /** Monotonic sequence, higher = newer. */
  seq: number;
}

export interface WindowModeTransition {
  state: WindowModeState;
  decision: WindowModeDecision;
  /** Mode the caller may act on; null means "nothing changes". */
  acceptedMode: WindowModeName | null;
  /** Stable marker text for the containment timeline / logs. */
  reason: string;
}

export function initialWindowModeState(): WindowModeState {
  return {
    mode: 'unknown',
    measured: false,
    lastSeq: 0,
    suppressed: 0,
    rejected: 0,
  };
}

/** A prohibited mode is a POSITIVE platform state (split-screen or PiP). */
function prohibited(mode: WindowModeName | string): boolean {
  return mode === 'multi_window' || mode === 'picture_in_picture';
}

/** Activity-level evidence is dispositive; a snapshot of the same state is not. */
export function isAuthoritativeEvidence(evidence: WindowModeEvidence): boolean {
  return evidence === 'activity' || evidence === 'resume';
}

function unchanged(
  state: WindowModeState,
  decision: WindowModeDecision,
  reason: string,
  patch: Partial<WindowModeState> = {},
): WindowModeTransition {
  return { state: { ...state, ...patch }, decision, acceptedMode: null, reason };
}

/**
 * Decide what ONE observation means for the authoritative state.
 *
 * Never mutates `state`; the caller stores `transition.state`.
 */
export function decideWindowMode(
  state: WindowModeState,
  obs: WindowModeObservation,
): WindowModeTransition {
  // An unmeasurable moment is neither a finding nor a clearance.
  if (obs.mode === 'unknown') {
    return unchanged(state, 'ignore-unknown', 'unmeasured-is-never-a-finding');
  }

  // Out-of-order: never let a stale producer overwrite newer evidence.
  if (obs.seq > 0 && obs.seq < state.lastSeq) {
    return unchanged(state, 'rejected', 'out-of-order-observation', { rejected: state.rejected + 1 });
  }
  const next: WindowModeState = { ...state, lastSeq: Math.max(state.lastSeq, obs.seq) };

  // Duplicate of the state already in force: no action, no emission, no mark.
  if (next.measured && obs.mode === next.mode) {
    return unchanged(state, 'duplicate', 'duplicate-observation', {
      lastSeq: next.lastSeq,
      suppressed: next.suppressed + 1,
    });
  }

  if (prohibited(obs.mode)) {
    // FAIL CLOSED, IMMEDIATELY — accepted from any producer, at once.
    return {
      state: { ...next, mode: obs.mode, measured: true, suppressed: 0 },
      decision: 'accept',
      acceptedMode: obs.mode,
      reason: 'prohibited-mode-accepted-immediately',
    };
  }

  // mode === 'fullscreen' — the only branch that can WEAKEN the belief.
  if (next.measured && prohibited(next.mode) && !isAuthoritativeEvidence(obs.evidence)) {
    // A layout pass / flag snapshot that momentarily reports full screen says
    // nothing about the window the platform already told us about.
    return unchanged(state, 'rejected', 'weak-fullscreen-cannot-clear', {
      lastSeq: next.lastSeq,
      rejected: next.rejected + 1,
    });
  }

  return {
    state: { ...next, mode: 'fullscreen', measured: true, suppressed: 0 },
    decision: 'accept',
    acceptedMode: 'fullscreen',
    reason: 'fullscreen-accepted',
  };
}
