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
 * ONLY a security lock invokes this — and leaving the foreground NOW ENGAGES
 * one (the `background-resume` holder in SecurityContext), so an embedded
 * protected player is torn down on a Home press instead of continuing behind
 * it. Deliberate contract change: protected media must not keep decoding while
 * the app is backgrounded, and no protected screen may be briefly revealed on
 * return before the post-resume verification completes. The holder is released
 * as soon as that verification passes.
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
