/**
 * protectedContentVisibility.ts — SYNCHRONOUS native concealment bus.
 *
 * WHY THIS EXISTS (why the React state alone is not enough)
 * ────────────────────────────────────────────────────────
 * A VdoCipher player is a NATIVE view. Covering it from a React state update
 * may not commit before the OS backgrounds the activity. On the background
 * edge the registered concealer therefore pauses the SDK's own player and
 * applies the cover/host opacity through `setNativeProps` in the same JS turn
 * as the AppState event. Concealment is NON-DESTRUCTIVE: it never removes the
 * player from layout or unmounts it, so the native surface, DRM/OTP session
 * and playback position survive. (The SDK exposes no visibility API; pause +
 * an opaque native sibling is the supported combination.)
 *
 * The security context owns the decision (`protectedContentState.ts`). Mounted
 * players register a CONCEALER with this module; the context calls
 * `setProtectedContentConcealed(...)` on every decision edge. Registration is
 * fail-closed: a player that mounts while content is concealed is concealed
 * immediately.
 *
 * This module is intentionally React-free and side-effect-only, so it can never
 * become a second source of truth: it holds no security decision, only the
 * current CONCEALMENT belief and the list of surfaces to apply it to.
 */

export type ConcealReason = string;

export interface ProtectedContentConcealer {
  /**
   * Pause the player and hide its native surface. MUST be synchronous,
   * MUST NOT throw, and MUST be idempotent.
   */
  conceal: (reason: ConcealReason) => void;
  /**
   * Show the surface again. Resuming playback is the player's own decision
   * (only if it was playing before concealment) — this is not an authorization.
   */
  reveal: () => void;
}

const concealers = new Set<ProtectedContentConcealer>();

/**
 * Fail-closed default: until the security context publishes a validated
 * `allowed` state, every newly mounted surface is concealed immediately.
 */
let concealed = true;
let lastReason: ConcealReason = 'initial-verification';

export function isProtectedContentConcealed(): boolean {
  return concealed;
}

export function getProtectionConcealmentReason(): ConcealReason {
  return lastReason;
}

/**
 * Apply the concealment belief to every registered surface and remember it for
 * surfaces that mount later.
 */
export function setProtectedContentConcealed(next: boolean, reason: ConcealReason): void {
  concealed = next;
  lastReason = reason;
  for (const concealer of concealers) {
    try {
      if (next) concealer.conceal(reason);
      else concealer.reveal();
    } catch {
      /* containment must never throw into the lifecycle handler */
    }
  }
}

/**
 * Register a player surface. Returns its unregister function. If content is
 * currently concealed the surface is concealed before registration returns.
 */
export function registerProtectedContentConcealer(
  concealer: ProtectedContentConcealer,
): () => void {
  concealers.add(concealer);
  if (concealed) {
    try {
      concealer.conceal(lastReason);
    } catch {
      /* a failing concealer must not break registration */
    }
  }
  return () => {
    concealers.delete(concealer);
  };
}

/** Test/diagnostic helper: how many surfaces are currently registered. */
export function getProtectedContentConcealerCount(): number {
  return concealers.size;
}

/** Test helper: drop every registered concealer (never used in production). */
export function __resetProtectedContentConcealersForTests(): void {
  concealers.clear();
  concealed = true;
  lastReason = 'initial-verification';
}
