/**
 * PortalOverlay — presents overlay content (sheets, dialogs, panels) inside the
 * app's SINGLE main window via @rn-primitives/portal, replacing React Native's
 * window-based `<Modal>` presentation for every overlay in the app.
 *
 * ── WHY THIS EXISTS (root cause of duplicate/flickering sheets) ──────────────
 * RN's Android `<Modal>` renders each open/close cycle as a NATIVE DIALOG
 * WINDOW (ReactModalHostView → ComponentDialog). Two problems are inherent to
 * that lifecycle on RN 0.83 + New Architecture + edge-to-edge:
 *
 * 1. Every `visible` toggle unmounts/remounts the native view, creating a
 *    brand-new ComponentDialog. `showOrUpdate()` calls async `Dialog.dismiss()`
 *    (the old window plays its exit animation) and then immediately
 *    `newDialog.show()` — two windows visibly coexist → duplicated/stacked
 *    sheets and flicker.
 * 2. `updateProperties()` re-applies `enableEdgeToEdge()` to the dialog window
 *    on every commit — inset churn → the "shaking" artifact.
 *
 * PortalOverlay routes content through the one-and-only PortalHost (mounted in
 * src/app/_layout.tsx as the last child of the root tree), so presentation
 * happens as ordinary views in the main window. One mounted overlay per
 * logical state, a single Animated.Value drives enter/exit, and rapid
 * open/close toggles converge deterministically (stopAnimation → animate to
 * the latest target). Android hardware back is handled via BackHandler while
 * the overlay is open (replacing Modal's onRequestClose).
 *
 * Variants:
 * • 'sheet'  — bottom sheet: backdrop fades, content slides up from the bottom
 *              edge (slide distance = measured content height, no device
 *              hard-coding).
 * • 'dialog' — centred dialog: backdrop fades, content fades + rises slightly.
 * • 'none'   — no built-in animation/backdrop; children manage everything
 *              themselves (used by overlays that own their animations).
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { Portal } from '@rn-primitives/portal';

let overlaySeq = 0;

export type PortalOverlayVariant = 'sheet' | 'dialog' | 'none';

export interface PortalOverlayProps {
  visible: boolean;
  /** Android hardware back while open (replaces Modal onRequestClose) */
  onRequestClose?: () => void;
  /** Backdrop tap (defaults to onRequestClose when provided) */
  onBackdropPress?: () => void;
  /** Animation/presentation style; default 'dialog' */
  variant?: PortalOverlayVariant;
  /** Backdrop fill color. Ignored when variant='none' */
  backdropColor?: string;
  /** Set false to render no backdrop at all (content handles its own) */
  withBackdrop?: boolean;
  children: React.ReactNode;
}

export function PortalOverlay({
  visible,
  onRequestClose,
  onBackdropPress,
  variant = 'dialog',
  backdropColor = '#00000066',
  withBackdrop = true,
  children,
}: PortalOverlayProps) {
  // Stable, unique portal identity per component instance — never changes
  // across re-renders, so the portal never remounts.
  const nameRef = useRef(`portal-overlay-${++overlaySeq}`);
  const progress = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(visible);
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;

  // Measured sheet height → exact slide distance (0 before first layout;
  // falls back to 45% of the runtime window height, no device-specific values).
  const [contentH, setContentH] = useState(0);
  const { height: screenH } = useWindowDimensions();

  // ── Deterministic presentation lifecycle ────────────────────────────────────
  // visible=true  → mount, animate to 1
  // visible=false → animate to 0, unmount when finished
  // Rapid toggles: cancel the in-flight animation and converge to the latest
  // target — there is exactly ONE animation driver and ONE mounted instance.
  useEffect(() => {
    if (visible) setMounted(true);
    progress.stopAnimation((value) => {
      if (variant === 'none') {
        progress.setValue(visible ? 1 : 0);
        if (!visible && mountedRef.current) setMounted(false);
        return;
      }
      Animated.timing(progress, {
        toValue: visible ? 1 : 0,
        duration: visible ? 260 : 200,
        easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished && !visible && mountedRef.current) setMounted(false);
      });
      void value;
    });
  }, [visible, progress, variant]);

  // ── Android hardware back ───────────────────────────────────────────────────
  useEffect(() => {
    if (Platform.OS !== 'android' || !visible || !onRequestClose) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onRequestClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onRequestClose]);

  if (!mounted) return null;

  const backdropOpacity = variant === 'none' ? 1 : progress;
  const handleBackdropPress = onBackdropPress ?? onRequestClose;

  // Content animation per variant
  let contentAnimatedStyle: object = {};
  if (variant === 'sheet') {
    contentAnimatedStyle = {
      transform: [
        {
          translateY: progress.interpolate({
            inputRange: [0, 1],
            outputRange: [contentH || Math.round(screenH * 0.45), 0],
          }),
        },
      ],
    };
  } else if (variant === 'dialog') {
    contentAnimatedStyle = {
      opacity: progress,
      transform: [
        {
          translateY: progress.interpolate({
            inputRange: [0, 1],
            outputRange: [18, 0],
          }),
        },
      ],
    };
  }

  const containerStyle: object =
    variant === 'sheet'
      ? styles.sheetContainer
      : variant === 'dialog'
      ? styles.dialogContainer
      : styles.noneContainer;

  return (
    <Portal name={nameRef.current}>
      {/* Full-screen layer above the entire app (PortalHost is the root tree's
          last child). box-none lets the backdrop receive touches; the content
          wrapper below stops them. */}
      <View style={[StyleSheet.absoluteFill, styles.layer, { pointerEvents: visible ? 'box-none' : 'none' }]}>
        {withBackdrop && (
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: backdropColor, opacity: backdropOpacity }]}>
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={handleBackdropPress}
              accessibilityRole="button"
              accessibilityLabel="Close"
            />
          </Animated.View>
        )}

        <Animated.View
          style={[containerStyle, contentAnimatedStyle]}
          pointerEvents={visible ? 'box-none' : 'none'}
          onLayout={variant === 'sheet' ? (e) => setContentH(e.nativeEvent.layout.height) : undefined}
        >
          {children}
        </Animated.View>
      </View>
    </Portal>
  );
}

const styles = StyleSheet.create({
  layer: {
    // Above everything else rendered by the app inside the main window.
    elevation: 50,
    zIndex: 50,
  },
  sheetContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  dialogContainer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noneContainer: {
    ...StyleSheet.absoluteFillObject,
  },
});
