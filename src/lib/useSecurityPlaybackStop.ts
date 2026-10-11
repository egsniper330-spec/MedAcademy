/**
 * useSecurityPlaybackStop.ts — immediate playback containment on security lock.
 *
 * WHY THIS EXISTS (root cause: "video keeps playing behind the block screen")
 * ─────────────────────────────────────────────────────────────────────────────
 * The security gate is a React overlay rendered ABOVE the app. A VdoCipher
 * player is a NATIVE view: covering it with an overlay does nothing to the
 * decoder or the audio session — it keeps playing behind the gate. React
 * unmounting stops it, but an unmount only happens on the screen's NEXT render
 * pass, and the block path used to be keyed on `blocksVideo` alone (so a VPN,
 * whose policy is `block_login`, never stopped it at all).
 *
 * This hook registers a PLAYBACK STOPPER with the central security lock
 * (securityLock.ts). The lock invokes it SYNCHRONOUSLY at the moment it
 * engages — including the fast provisional containment driven by the native
 * TRANSPORT_VPN callback — which is strictly earlier than any React render,
 * any navigation animation, or the (network-bound) authoritative verdict.
 *
 * The ref it returns must be attached to the native player view so the
 * documented `pause()` instance method can be called. It is intentionally
 * defensive: a player that has not loaded yet, or has already unmounted,
 * is a no-op rather than a crash.
 *
 * BACKGROUND/RESUME (behavior changed deliberately — see below)
 * ─────────────────────────────────────────────────────────────────────────
 * This hook used to state that backgrounding never invoked the stopper, so
 * intentional background playback survived a Home press. That is no longer the
 * contract: the centralized security gate holds a HARD lock the instant the app
 * leaves the foreground (`background-resume` in SecurityContext), precisely so
 * protected lecture audio/video cannot keep running while the app is not in the
 * foreground and cannot be briefly revealed on return before the post-resume
 * checks finish. `Container.test` / `securityGate.test.cjs` assert this.
 *
 * Everything else still holds: a lock is the ONLY thing that stops playback
 * early, it is released as soon as the post-resume verification passes, and
 * public/auth traffic is never contained (see the transport gate in php.ts).
 */

import { useEffect, useRef } from 'react';
import { registerPlaybackStopper } from '@/lib/securityLock';
import type { VdoPlayerView } from 'vdocipher-rn-bridge';

/** Minimal surface a native player must expose for containment to work. */
export interface PausablePlayer {
  /** VdoPlayerView instance method (documented bridge API). */
  pause?: () => void;
}

/**
 * Returns the ref to attach to the native player view.
 *
 * The player type is fixed here (rather than a generic parameter) so call
 * sites stay free of the `<VdoPlayerView>` token — the architecture suites
 * count that token to enforce the "exactly ONE native player instance"
 * invariant, and a type argument would be miscounted as a second mount.
 */
export function useSecurityPlaybackStop(): React.MutableRefObject<VdoPlayerView | null> {
  const playerRef = useRef<VdoPlayerView | null>(null);

  useEffect(() => {
    // `registerPlaybackStopper` returns its OWN unregister function, which
    // React uses directly as the effect cleanup.
    return registerPlaybackStopper(() => {
      try {
        playerRef.current?.pause?.();
      } catch {
        /* player not ready / already released — containment must never throw */
      }
    });
  }, []);

  return playerRef;
}
