/**
 * AnchoredMenu — the ONE direction-aware menu/popover that hangs off a trigger.
 *
 * WHY: anchored menus used to be hand-rolled absolute Views with a hardcoded
 * physical side (`right: 0`), which React Native never mirrors. In Arabic the
 * trigger moved to the right edge but the menu still opened to the left — and
 * could leave the screen. Placement is now computed by
 * src/lib/ui/anchoredMenuPosition.ts:
 *
 *   • the menu's INLINE-START edge aligns to the trigger's inline-start edge
 *     (left/left in LTR, right/right in RTL);
 *   • it opens below the trigger, flips above when there is no room;
 *   • it is clamped inside the window and its height is capped, so it can
 *     never be pushed off-screen on a small device or in split view.
 *
 * The menu is presented through PortalOverlay (the app's single portal host),
 * so the coordinates from `measureInWindow` are in the SAME space the menu is
 * drawn in. A backdrop press and Android hardware back both close it.
 *
 * Accessibility: the container is announced as a menu; the trigger keeps its
 * own `accessibilityState={{ expanded }}` responsibility (owned by the caller).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useColorScheme,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { PortalOverlay } from '@/components/PortalOverlay';
import { neuColors } from '@/lib/neu';
import { useTranslation } from '@/lib/i18n';
import {
  computeMenuPlacement,
  menuDirection,
  type MenuPlacement,
} from '@/lib/ui/anchoredMenuPosition';

export interface AnchoredMenuProps {
  visible: boolean;
  onClose: () => void;
  /** The trigger view — must be a plain RN View/Pressable ref. */
  anchorRef: React.RefObject<View | null>;
  children: React.ReactNode;
  /** Width used before the content has been measured. */
  preferredWidth?: number;
  /** Extra style for the menu card (padding, radius, …). */
  style?: StyleProp<ViewStyle>;
  /** Keep the menu usable when content is taller than the space available. */
  scrollable?: boolean;
  accessibilityLabel?: string;
  /**
   * Render in place instead of through the root portal.
   *
   * Required when the trigger already lives inside a native `<Modal>` (e.g.
   * VideoLibraryPicker): on Android a portal renders in the MAIN window and
   * would appear UNDER that modal's separate window. Placement math is
   * identical — the computed window coordinates are converted back into the
   * anchor's own coordinate space.
   */
  inline?: boolean;
}

export function AnchoredMenu({
  visible,
  onClose,
  anchorRef,
  children,
  preferredWidth = 200,
  style,
  scrollable = true,
  accessibilityLabel,
  inline = false,
}: AnchoredMenuProps) {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { isRTL } = useTranslation();
  const { width: winW, height: winH } = useWindowDimensions();

  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  // Anchor rect in window space — needed to convert back to local coordinates
  // for the inline (inside-a-Modal) variant.
  const [anchorRect, setAnchorRect] = useState<{ x: number; y: number } | null>(null);
  const [content, setContent] = useState({ width: 0, height: 0 });
  const fade = useRef(new Animated.Value(0)).current;

  const measure = useCallback(
    (size: { width: number; height: number }) => {
      const node = anchorRef.current;
      if (!node) return;
      node.measureInWindow((x, y, width, height) => {
        setAnchorRect({ x, y });
        setPlacement(
          computeMenuPlacement({
            anchor: { x, y, width, height },
            menuWidth: size.width || preferredWidth,
            menuHeight: size.height,
            window: { width: winW, height: winH },
            direction: menuDirection(isRTL),
          }),
        );
      });
    },
    [anchorRef, isRTL, preferredWidth, winW, winH],
  );

  // Measure on open, and again when the window (rotation / split view) or the
  // layout direction changes — placement is a pure function of those inputs.
  useEffect(() => {
    if (!visible) {
      setPlacement(null);
      setContent({ width: 0, height: 0 });
      fade.setValue(0);
      return;
    }
    measure(content);
    Animated.timing(fade, {
      toValue: 1,
      duration: 140,
      useNativeDriver: true,
    }).start();
    // `content` is intentionally excluded: it is fed back through onLayout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, winW, winH, isRTL]);

  const onLayout = useCallback(
    (e: { nativeEvent: { layout: { width: number; height: number } } }) => {
      const { width, height } = e.nativeEvent.layout;
      if (Math.abs(width - content.width) < 1 && Math.abs(height - content.height) < 1) return;
      const next = { width, height };
      setContent(next);
      measure(next);
    },
    [content.height, content.width, measure],
  );

  if (!visible) return null;

  // Window coordinates for the portal variant; the SAME placement converted
  // back into the anchor's local space for the inline variant.
  const left = inline
    ? (placement && anchorRect ? placement.left - anchorRect.x : 0)
    : (placement?.left ?? 0);
  const top = inline
    ? (placement && anchorRect ? placement.top - anchorRect.y : 0)
    : (placement?.top ?? 0);

  const card = (
    <Animated.View
      onLayout={onLayout}
      accessibilityRole="menu"
      style={[
        {
          position: 'absolute',
          opacity: fade,
          left,
          top,
          width: placement?.width ?? preferredWidth,
          maxHeight: placement ? Math.max(0, placement.maxHeight) : undefined,
          backgroundColor: c.base,
          borderRadius: 14,
          padding: 8,
          shadowColor: c.shadowDark,
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.35,
          shadowRadius: 12,
          elevation: 12,
          zIndex: inline ? 100 : undefined,
        },
        style,
      ]}
    >
      {scrollable ? (
        <ScrollView
          bounces={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ gap: 2 }}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={{ gap: 2 }}>{children}</View>
      )}
    </Animated.View>
  );

  if (inline) return card;

  return (
    <PortalOverlay visible={visible} onRequestClose={onClose} variant="none" withBackdrop={false}>
      {/* Outside-press catcher. Transparent so it never dims the screen — an
          anchored menu is not a modal. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
      />
      {card}
    </PortalOverlay>
  );
}

export default AnchoredMenu;
