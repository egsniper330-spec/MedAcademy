/**
 * useSecurityWebViewStop.ts — immediate playback containment for WEBVIEW players.
 *
 * WHY THIS EXISTS (root cause: "the YouTube/VdoCipher video keeps playing
 * behind the security gate on Android")
 * ──────────────────────────────────────────────────────────────────────────
 * `useSecurityPlaybackStop` returns a ref whose registered stopper calls the
 * native bridge method `pause()` on a `VdoPlayerView`:
 *
 *     playerRef.current?.pause?.()
 *
 * A `react-native-webview` WebView instance has NO `pause()` method. Assigning
 * a WebView node into that ref therefore makes the stopper a SILENT NO-OP: the
 * native VPN signal engages the lock, the gate rises, protected requests are
 * aborted — and the embedded player keeps decoding audio/video behind it.
 *
 * This hook registers a stopper that genuinely stops a WebView:
 *
 *   1. `stopLoading()`  — halts an in-flight media document load.
 *   2. injected script  — pauses the real player:
 *        • Plyr-backed players (the YouTube player embeds PLAYER_SCRIPT, which
 *          exposes `window.__plyr`) → call the documented `pause()` API AND
 *          pause the underlying media element.
 *        • Cross-origin <iframe> players (the VdoCipher embed lives on
 *          player.vdocipher.com) CANNOT be scripted from the parent document —
 *          the same-origin policy forbids it — so the only reliable stop is to
 *          DETACH the iframe, which tears down the player and releases its
 *          audio session. This is lifecycle teardown, not a visual overlay.
 *
 * The script is idempotent (guarded by a window flag) and fully wrapped in
 * try/catch, so a player that has not mounted yet, has already unmounted, or
 * is mid-navigation degrades to a no-op instead of throwing inside containment.
 *
 * ONLY a confirmed security lock invokes this DESTRUCTIVE path. A normal
 * background/resume is owned by `ProtectedContentSurface`, which calls the
 * non-destructive WEBVIEW_SOFT_PAUSE_SCRIPT (pause only; the session and
 * position survive) and hides the native surface. The hard detach below is
 * reserved for an app-access block (VPN, overlay, prohibited window mode, …).
 */

import { useEffect } from 'react';
import { registerPlaybackStopper } from '@/lib/securityLock';

/** Minimal surface of a WebView instance we depend on (both are documented). */
export interface StoppableWebView {
  /** react-native-webview instance method. */
  stopLoading?: () => void;
  /** react-native-webview instance method. */
  injectJavaScript?: (code: string) => void;
}

/**
 * The injected containment script.
 *
 * Safe to run against ANY embedded player and idempotent by construction.
 * Written as an IIFE that always evaluates to `true` so react-native-webview's
 * `injectJavaScript` completes cleanly.
 */
/**
 * SOFT PAUSE for protected-content concealment (background / resume pending).
 *
 * Deliberately NON-DESTRUCTIVE: unlike WEBVIEW_CONTAINMENT_SCRIPT it never
 * detaches the iframe or clears the media source, so the player session and
 * playback position survive a lifecycle transition. It records whether media
 * was actually playing so the reveal can resume exactly that state.
 */
export const WEBVIEW_SOFT_PAUSE_SCRIPT = `
(function () {
  try {
    var wasPlaying = false;
    var plyr = window.__plyr;
    try {
      if (plyr && (plyr.playing === true)) wasPlaying = true;
      if (plyr && typeof plyr.pause === 'function') plyr.pause();
    } catch (e) {}
    try {
      var media = document.querySelectorAll('video, audio');
      for (var i = 0; i < media.length; i++) {
        try { if (!media[i].paused) wasPlaying = true; } catch (e) {}
        try { media[i].pause(); } catch (e) {}
      }
    } catch (e) {}
    window.__medaProtectedWasPlaying = wasPlaying;
  } catch (e) {}
  true;
})();
`;

/**
 * Resume ONLY if the soft pause observed active playback. Never auto-starts a
 * player the user had paused, and never creates a new player/OTP session.
 */
export const WEBVIEW_RESUME_SCRIPT = `
(function () {
  try {
    // The app-level containment flag is cleared by an AUTHORIZED reveal only:
    // ProtectedContentSurface reveals when a fresh verdict proved the app may
    // show protected frames. Leaving the flag set would freeze this player for
    // the rest of the session (its own play/pause and seek helpers refuse to
    // act while it is true) even though the violation is gone.
    window.__medaSecurityStopped = false;
    if (!window.__medaProtectedWasPlaying) return true;
    window.__medaProtectedWasPlaying = false;
    var plyr = window.__plyr;
    if (plyr && typeof plyr.play === 'function') {
      try { plyr.play(); return true; } catch (e) {}
    }
    var media = document.querySelectorAll('video, audio');
    for (var i = 0; i < media.length; i++) {
      try {
        var p = media[i].play();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (e) {}
    }
  } catch (e) {}
  true;
})();
`;

export const WEBVIEW_CONTAINMENT_SCRIPT = `
(function () {
  try {
    if (window.__medaSecurityStopped) return true;
    window.__medaSecurityStopped = true;

    // 1. Plyr-backed players (YouTube): documented pause() on the live instance.
    try {
      var plyr = window.__plyr;
      if (plyr && typeof plyr.pause === 'function') plyr.pause();
      if (plyr && typeof plyr.stop === 'function') plyr.stop();
    } catch (e) {}

    // 2. Any raw media element still decoding in this document.
    try {
      var media = document.querySelectorAll('video, audio');
      for (var i = 0; i < media.length; i++) {
        try { media[i].pause(); } catch (e) {}
        try { media[i].removeAttribute('src'); } catch (e) {}
        try { media[i].load(); } catch (e) {}
      }
    } catch (e) {}

    // 3. Cross-origin iframe players (VdoCipher): cannot be scripted, so the
    //    parent document detaches the frame to stop playback and audio.
    try {
      var frames = document.querySelectorAll('iframe');
      for (var j = 0; j < frames.length; j++) {
        try {
          if (frames[j].parentNode) frames[j].parentNode.removeChild(frames[j]);
        } catch (e) {}
      }
    } catch (e) {}
  } catch (e) {}
  true;
})();
`;

/**
 * Register this component's WebView as a security-lock playback stopper.
 *
 * Takes the component's OWN WebView ref (rather than creating one) so callers
 * keep a single `<WebView ref={...}>` attachment and nothing has to be rewired.
 */
export function useSecurityWebViewStop(ref: {
  current: StoppableWebView | null;
}): void {
  useEffect(() => {
    // `registerPlaybackStopper` returns its own unregister function, which
    // React uses directly as the effect cleanup.
    return registerPlaybackStopper(() => {
      const wv = ref.current;
      if (!wv) return; // not mounted yet — nothing to stop
      try {
        wv.stopLoading?.();
      } catch {
        /* webview already torn down */
      }
      try {
        wv.injectJavaScript?.(WEBVIEW_CONTAINMENT_SCRIPT);
      } catch {
        /* webview already torn down */
      }
    });
    // The ref identity is stable for the component's lifetime, so this effect
    // registers exactly once per mounted player.
  }, [ref]);
}
