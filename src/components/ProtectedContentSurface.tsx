/**
 * ProtectedContentSurface — the RENDER BOUNDARY for protected video.
 *
 * Every VdoCipher player (native SDK, WebView fallback, offline) renders INSIDE
 * this surface. It is the one place where "may protected frames be visible?"
 * is applied, so a screen cannot accidentally paint video during a lifecycle
 * transition, an in-flight verification, a failed check or an app-level block.
 *
 * ─── HOW VIDEO IS ACTUALLY HIDDEN (non-destructive) ─────────────────────────
 *
 * A VdoCipher player is a native view and hiding a React Native view alone is
 * not proof that its frames are hidden. This component therefore:
 *
 *   1. Calls the player's own `onConceal`, which invokes the SDK's documented
 *      `pause()` (and `exitFullscreenV2()` where supported). Pause stops the
 *      decoder/audio pipeline. `pause()` is a UIManager command — it is
 *      dispatched synchronously from JS but executed on the native main
 *      thread, so it is not a same-instruction stop.
 *   2. Applies `opacity: 0` to the player host and `opacity: 1` to an opaque
 *      cover. Both are applied IMMEDIATELY with `setNativeProps` on the
 *      AppState edge (before React re-renders), and again from the normal
 *      React style on every render so the native props cannot drift.
 *   3. Keeps the surface MOUNTED and its layout intact. The previous approach
 *      used `display:'none'`, which removes the native view from layout; on
 *      Android that can tear down/recreate the SurfaceView (VdoCipher renderer
 *      6120 risk) and on iOS can detach the AVPlayer layer. We deliberately
 *      avoid layout destruction so the player instance, DRM/OTP session and
 *      playback position survive.
 *
 * WHY AN OPAQUE RN VIEW IS ABOVE THE VIDEO
 * ────────────────────────────────────────
 * The existing `NativeWatermarkOverlay` is a normal RN view rendered above the
 * same native player in BOTH inline and app-fullscreen modes; it is visible in
 * production. That is direct structural evidence that the SDK surface is
 * composited BELOW the RN sibling view hierarchy (Android SurfaceView behind
 * the window / iOS subview). The cover is a later sibling of the player host
 * with a high `zIndex` + `elevation`, so it paints above the frames. The app
 * shell's FLAG_SECURE additionally covers the Android recents snapshot.
 *
 * The surface is revealed ONLY by the validated `allowed` state. Concealment is
 * fail-closed at registration, so a player mounted while validation is pending
 * is covered before it can present a frame.
 *
 * The watermark overlay lives INSIDE the player host, so exactly one watermark
 * exists, it stays above the video in fullscreen, and it is covered together
 * with the video (no watermark floating over a concealed player).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { useSecurity } from '@/lib/SecurityContext';
import { isProtectedContentVisible } from '@/lib/protectedContentState';
import {
  isProtectedContentConcealed,
  registerProtectedContentConcealer,
  type ConcealReason,
} from '@/lib/protectedContentVisibility';

export interface ProtectedContentSurfaceProps {
  /** The player + watermark tree. Stays mounted while concealed. */
  children: React.ReactNode;
  /** Outer sizing/style (16:9 inline block or fullscreen window pixels). */
  style?: StyleProp<ViewStyle>;
  /**
   * Pause/stop the player and leave native fullscreen. MUST NOT throw. Called
   * synchronously on the background edge and on every block.
   */
  onConceal?: (reason: ConcealReason) => void;
  /**
   * Show the player again. Resuming playback is the player's own decision and
   * may only happen when it was playing before concealment.
   */
  onReveal?: () => void;
  /** Layout diagnostics for the existing VDO_WM_* instrumentation. */
  onLayout?: (e: LayoutChangeEvent) => void;
}

export function ProtectedContentSurface({
  children,
  style,
  onConceal,
  onReveal,
  onLayout,
}: ProtectedContentSurfaceProps) {
  const { protectedContent } = useSecurity();
  const allowedByState = isProtectedContentVisible(protectedContent);
  // The synchronous bus is AUTHORITATIVE across renders. React state can lag a
  // concealment by a frame; a re-render for an unrelated prop must not re-show
  // a surface the security context has already concealed.
  //
  // WHY STATE AND NOT A REF (root cause of "the video is still visible after I
  // come back"): concealment used to be expressed ONLY as alpha (opacity 0 on
  // the player host + an opaque cover sibling) while the WebView stayed
  // mounted. A ref change re-renders nothing, and on this device an
  // alpha/zIndex-composited layer inside a clipped parent can paint nothing at
  // all (proven by the Liquid Bar bubble, which was laid out, hit-testable and
  // alpha-1 yet invisible in a full pixel scan). Concealment therefore could
  // not be trusted to hide — or to stop — a decoding player. The boundary now
  // RE-RENDERS on every concealment/reveal and UNMOUNTS the player while
  // concealed, so no frame and no media request can survive an interruption.
  const [busConcealed, setBusConcealed] = useState(() => isProtectedContentConcealed());
  const visible = allowedByState && !busConcealed;

  // Stable indirection so the registered concealer always calls the latest
  // callbacks without re-registering (which could momentarily drop the surface
  // out of the bus and leave it visible).
  const concealRef = useRef(onConceal);
  const revealRef = useRef(onReveal);
  concealRef.current = onConceal;
  revealRef.current = onReveal;

  // Native refs used for the synchronous (pre-render) concealment on the
  // AppState edge. They only change opacity — never layout, visibility or the
  // view tree — so the native player surface is never destroyed.
  const hostRef = useRef<View>(null);
  const coverRef = useRef<View>(null);

  const applyNativeConcealment = useCallback((concealed: boolean) => {
    try {
      if (concealed) {
        // Cover FIRST, then fade the player host: no naked frame escapes even
        // if the SDK takes a moment to process the native pause command.
        coverRef.current?.setNativeProps({ style: { opacity: 1 } });
        hostRef.current?.setNativeProps({ style: { opacity: 0 } });
      } else {
        // Reveal only after validation; show the host before removing the
        // cover so the transition cannot flash an empty black frame.
        hostRef.current?.setNativeProps({ style: { opacity: 1 } });
        coverRef.current?.setNativeProps({ style: { opacity: 0 } });
      }
    } catch {
      // A native-props failure must never break containment. The React style
      // below is re-applied on the next render regardless.
    }
  }, []);

  useEffect(() => {
    return registerProtectedContentConcealer({
      conceal: (reason) => {
        // Stop the player FIRST (pause/teardown of the host), then let the
        // re-render remove it from the tree.
        try {
          concealRef.current?.(reason);
        } catch {
          /* containment must never throw into the lifecycle handler */
        }
        applyNativeConcealment(true);
        setBusConcealed(true);
      },
      reveal: () => {
        // Reveal is NOT an authorization and never restarts playback: the
        // player is re-created from scratch, paused/ready, and only an
        // explicit Play action starts it (see the lesson screen).
        applyNativeConcealment(false);
        setBusConcealed(false);
        try {
          revealRef.current?.();
        } catch {
          /* reveal failure must not break the transition */
        }
      },
    });
  }, [applyNativeConcealment]);

  // Belt-and-suspenders: if the React state says concealed, conceal even when
  // the synchronous bus call was missed (e.g. the surface mounted after the
  // decision). Never reveal from an effect — reveal happens through the bus,
  // which is only driven by a validated `allowed` decision.
  useEffect(() => {
    if (visible) return;
    applyNativeConcealment(true);
    setBusConcealed(true);
    try {
      concealRef.current?.('render-state');
    } catch {
      /* no-op */
    }
  }, [visible, applyNativeConcealment]);

  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      if (!visible) return;
      onLayout?.(e);
    },
    [onLayout, visible],
  );

  return (
    <View style={style} onLayout={handleLayout}>
      {/* The player exists ONLY while the content is authorised. While
          concealed it is removed from the tree: a mounted WebView can keep
          its media session and issue requests even behind an opaque view, so
          "covered" is not the same as "stopped". Unmounting is the only
          control this player architecture offers that provably stops both. */}
      {visible ? (
        <View
          ref={hostRef}
          style={[styles.fill, styles.hostVisible]}
          pointerEvents="auto"
        >
          {children}
        </View>
      ) : (
        /* Opaque cover: a PLAIN filled view (no zIndex, no elevation, no
           transform, no children) — the paint-safe primitive on this device. */
        <View
          ref={coverRef}
          pointerEvents="auto"
          style={[styles.fill, styles.cover]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  hostVisible: {
    opacity: 1,
  },
  /** Opaque, paint-safe cover (no composited layer). */
  cover: {
    backgroundColor: '#000',
  },
});
