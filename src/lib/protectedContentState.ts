/**
 * protectedContentState.ts — PURE protected-content access state machine.
 *
 * ⚠️ NO IMPORTS. This module must stay dependency-free (no react-native, no
 * expo, no network) so it can be compiled standalone and unit-tested with
 * plain node (see tests/protectedContentLifecycle.test.cjs).
 *
 * ─── WHY THIS MODULE EXISTS (the lifecycle defect) ──────────────────────────
 *
 * App access security and protected-content access are two DIFFERENT layers:
 *
 *   • APP ACCESS   — "may this device use MedAcademy at all?" (root, VPN,
 *                    Magisk/LSPosed, USB debugging, overlay, split-screen…).
 *                    Enforced by the central security lock + SecurityGate.
 *   • PROTECTED    — "may protected VdoCipher frames be rendered right now?"
 *                    CONTENT
 *
 * The previous implementation merged them: leaving the foreground engaged the
 * central lock HARD, which unmounted the native player (destroying the
 * VdoCipher session/OTP/position), suspended the app's own network traffic,
 * and left the shell unusable until a post-resume evaluation landed. That is
 * why an ordinary Home-and-return felt like the whole application was blocked.
 *
 * This machine controls ONLY layer 2. It is deliberately NOT part of the
 * security lock: a `protected-content` holder in that lock would still suspend
 * the transport (`locked` drives the network lock) and still unmount players
 * on a hard hold. Protected content is withheld by CONCEALING the video surface
 * and pausing the player — the app shell, navigation and non-video screens stay
 * fully usable.
 *
 * ─── FAIL-CLOSED CONTRACT ───────────────────────────────────────────────────
 *
 *   • The INITIAL state is `checking` → video is HIDDEN before any validation.
 *   • Backgrounding → `background_hidden` immediately (a new request id is
 *     issued so any in-flight verification becomes stale).
 *   • Returning to foreground → `checking` (video stays hidden) while a fresh
 *     evaluation runs.
 *   • A clean, post-resume verdict → `allowed`.
 *   • A blocking verdict → `blocked` (video hidden; app access is enforced by
 *     the security gate separately).
 *   • A thrown/timed-out verification → `error` (video hidden; NEVER allowed).
 *   • Only `allowed` exposes protected content. Nothing else does.
 *
 * ─── STALE-RESULT PROTECTION ────────────────────────────────────────────────
 *
 * Every lifecycle transition and every verification carries a monotonically
 * increasing `requestId`. `check-succeeded` / `check-failed` events are only
 * applied when their id equals the live id. Rapid background/foreground
 * transitions therefore cannot be overwritten by an older asynchronous result,
 * and a background transition invalidates a verification that started before
 * it.
 */

/** The protected-content states. Only `allowed` may render video frames. */
export type ProtectedContentStatus =
  | 'allowed'
  | 'background_hidden'
  | 'checking'
  | 'blocked'
  | 'error';

/** Every state, for exhaustive tests and diagnostics. */
export const PROTECTED_CONTENT_STATUSES: readonly ProtectedContentStatus[] = [
  'allowed',
  'background_hidden',
  'checking',
  'blocked',
  'error',
] as const;

export interface ProtectedContentState {
  status: ProtectedContentStatus;
  /**
   * Monotonic id of the verification currently allowed to publish a result.
   * Result events carrying an older id are ignored (stale-async guard).
   */
  requestId: number;
  /** Short machine-readable cause, for diagnostics/tests only. */
  reason: string | null;
}

/**
 * Initial state: video is HIDDEN until a verdict proves it may be shown.
 * `requestId: 0` means no verification has been issued yet.
 */
export const INITIAL_PROTECTED_CONTENT_STATE: ProtectedContentState = {
  status: 'checking',
  requestId: 0,
  reason: 'initial-verification',
};

export type ProtectedContentEvent =
  /** The app left the foreground. Hide now; invalidate any in-flight check. */
  | { type: 'background'; requestId: number; reason?: string }
  /** The app returned. Stay hidden while the fresh verification runs. */
  | { type: 'foreground'; requestId: number; reason?: string }
  /** A protected-content verification started (id must be the newest). */
  | { type: 'check-started'; requestId: number; reason?: string }
  /** That verification completed cleanly. */
  | { type: 'check-succeeded'; requestId: number; reason?: string }
  /** That verification completed with a blocking finding. */
  | { type: 'check-failed'; requestId: number; reason?: string }
  /** The verification could not decide (throw/timeout). Stays hidden. */
  | { type: 'check-error'; requestId: number; reason?: string }
  /** App-level security enforcement engaged (blocking verdict / live signal). */
  | { type: 'app-blocked'; requestId: number; reason?: string }
  /** Leave the session (logout / account switch): fail closed immediately. */
  | { type: 'reset'; requestId: number; reason?: string };

/**
 * The single reducer for protected-content access.
 *
 * Rules, in order:
 *   1. `background` and `foreground` ALWAYS apply (they are the authoritative
 *      lifecycle edges) and always hide video.
 *   2. `app-blocked` ALWAYS applies and hides video.
 *   3. `check-started` only applies if it is the newest request.
 *   4. Result events apply only when they belong to the LIVE request.
 *   5. `allowed` is reachable ONLY from a matching `check-succeeded`.
 */
export function reduceProtectedContent(
  state: ProtectedContentState,
  event: ProtectedContentEvent,
): ProtectedContentState {
  switch (event.type) {
    case 'background':
      return {
        status: 'background_hidden',
        requestId: event.requestId,
        reason: event.reason ?? 'background',
      };

    case 'foreground':
      return {
        status: 'checking',
        requestId: event.requestId,
        reason: event.reason ?? 'foreground-verification',
      };

    case 'reset':
      return {
        status: 'checking',
        requestId: event.requestId,
        reason: event.reason ?? 'session-reset',
      };

    case 'app-blocked':
      return {
        status: 'blocked',
        requestId: event.requestId,
        reason: event.reason ?? 'app-security-block',
      };

    case 'check-started':
      // A newer request always wins. An OLDER start event cannot regress the
      // live id (that would let a stale result match again).
      if (event.requestId < state.requestId) return state;
      return {
        status: 'checking',
        requestId: event.requestId,
        reason: event.reason ?? 'verification',
      };

    case 'check-succeeded':
      // Stale result: never allow on a superseded verification.
      if (event.requestId !== state.requestId) return state;
      // A clean verdict cannot expose video while the app is in the
      // background. The foreground handler re-verifies on return.
      if (state.status === 'background_hidden') return state;
      return {
        status: 'allowed',
        requestId: state.requestId,
        reason: event.reason ?? 'verification-passed',
      };

    case 'check-failed':
      if (event.requestId !== state.requestId) return state;
      return {
        status: 'blocked',
        requestId: state.requestId,
        reason: event.reason ?? 'verification-blocked',
      };

    case 'check-error':
      if (event.requestId !== state.requestId) return state;
      return {
        status: 'error',
        requestId: state.requestId,
        reason: event.reason ?? 'verification-error',
      };

    default:
      return state;
  }
}

/** TRUE only for the single state in which protected frames may be rendered. */
export function isProtectedContentVisible(state: ProtectedContentState): boolean {
  return state.status === 'allowed';
}

/** TRUE while the state requires the native player to be paused and concealed. */
export function isProtectedContentConcealed(state: ProtectedContentState): boolean {
  return !isProtectedContentVisible(state);
}

/**
 * How long a protected-content verification may stay unresolved before it is
 * reported as `error` (which keeps video hidden). A timeout is never an
 * authorization: it can only move the state further from `allowed`.
 */
export const PROTECTED_CONTENT_VERIFICATION_TIMEOUT_MS = 8_000;

/**
 * Bounded timeout guard for a verification. Returns a boolean about the
 * PENDING state; callers must never convert `true` into access. Kept pure so
 * the fail-closed timing rule is unit-tested.
 */
export function isProtectedContentVerificationOverdue(input: {
  startedAtMs: number | null;
  nowMs: number;
  timeoutMs?: number;
}): boolean {
  if (input.startedAtMs === null) return false;
  if (!Number.isFinite(input.startedAtMs) || !Number.isFinite(input.nowMs)) return false;
  const timeout = input.timeoutMs ?? PROTECTED_CONTENT_VERIFICATION_TIMEOUT_MS;
  return input.nowMs - input.startedAtMs >= timeout;
}
