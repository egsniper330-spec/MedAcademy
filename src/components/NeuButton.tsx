import React, { useRef, useState } from 'react';
import { Animated, Pressable, Text, ActivityIndicator, View, useColorScheme, ViewStyle, TextStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { neuFlatStyle, neuPressedStyle, neuColors } from '@/lib/neu';
import { radius, spacing, typography } from '@/lib/ds';

interface NeuButtonProps {
  label: string;
  onPress: () => void;
  loading?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  style?: ViewStyle;
  textStyle?: TextStyle;
  fullWidth?: boolean;
  icon?: React.ReactNode;
}

/**
 * NeuButton — shared button used by every modal footer and form.
 *
 * LAYOUT CONTRACT (read before modifying — fixes Android collapsed footer
 * buttons; physical-device bug, web never reproduced it):
 *
 * Callers conventionally pass `style={{ flex: 1 }}` (62 call sites) so
 * buttons share the modal footer row. `flex` is a CHILD-OF-ROW property: it
 * must live on the component that is the row's direct child — the outer
 * Pressable. Historically it was forwarded to the INNER content view while
 * the Pressable stayed content-sized ("shrink-to-fit"), so on device the row
 * gave the button its intrinsic (near-zero) width and Yoga collapsed the
 * ellipsized label; web's CSS min-content floor masked it.
 *
 * New rule (v2 — direction-safe after the landing-screen regression):
 * • Caller passes `flex` (always a row-footer child in this codebase) → the
 *   OUTER Pressable becomes the flex row participant: flexGrow = caller's
 *   flex (default 1), flexShrink: 1, flexBasis: 0, minWidth: 0 (Yoga's real
 *   "share the row, never collapse" recipe). The caller's `flex`/
 *   `minWidth`/`alignSelf` are consumed there and NOT double-applied to the
 *   inner view.
 * • Caller passes `fullWidth` → WIDTH ONLY. Applied as width:'100%' +
 *   flexShrink:1 + minWidth:0 — NEVER flexGrow/flexBasis. fullWidth buttons
 *   live in column containers (landing, auth screens, forms); grow/basis
 *   there would expand them VERTICALLY to fill the screen (v1 regression:
 *   blank stretched buttons, labels centered off-screen), and in a row it
 *   would fight siblings. flexShrink+minWidth keep it collapse-proof while
 *   staying correct in both directions.
 * • The inner view keeps its comfortable default horizontal padding and is
 *   sized by the wrapper — an explicit `paddingHorizontal` in `style` still
 *   overrides the default, and other inner props (backgroundColor, margins)
 *   keep applying to the inner view exactly as before.
 * • Callers WITHOUT `flex`/`fullWidth` (marginTop / alignSelf / plain) get
 *   the exact legacy geometry: transparent wrapper, full style on the inner
 *   view, content-sized Pressable.
 *
 * Responsive by construction: pure flexbox math, no device classes, no
 * fixed pixel widths, works portrait/landscape/phone/tablet/web/iOS.
 */
export function NeuButton({
  label, onPress, loading = false, variant = 'primary',
  disabled = false, style, textStyle, fullWidth = false, icon,
}: NeuButtonProps) {
  const [pressed, setPressed] = useState(false);
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const scale = useRef(new Animated.Value(1)).current;

  // Partition the caller's style: row-participation keys → wrapper,
  // everything else → inner view (unchanged semantics).
  const s = (style ?? {}) as ViewStyle;
  const { flex, minWidth, alignSelf, ...innerStyle } = s;
  const wantsDistribute = fullWidth || flex != null;

  const wrapperStyle: ViewStyle = wantsDistribute
    ? flex != null
      ? // Row participant: grow to the caller's weight, shrink under pressure,
        // zero basis so the row's free width (not intrinsic content) decides
        // the size, and minWidth: 0 so Yoga never clamps to content width.
        {
            flexGrow: flex as number,
            flexShrink: 1,
            flexBasis: 0,
            minWidth: 0,
            alignSelf,
            borderRadius: radius.md,
          }
      : // fullWidth — WIDTH ONLY (direction-safe): fills the parent's width
        // in a column without any main-axis growth, and cannot collapse.
        {
            width: '100%',
            flexShrink: 1,
            minWidth: 0,
            alignSelf,
            borderRadius: radius.md,
          }
    : {
        // Legacy transparent wrapper — identical to the pre-fix geometry.
        borderRadius: radius.md,
      };

  const handlePressIn = () => {
    setPressed(true);
    if (variant === 'danger') {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } else {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    Animated.spring(scale, { toValue: 0.96, useNativeDriver: true, tension: 120, friction: 14 }).start();
  };
  const handlePressOut = () => {
    setPressed(false);
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, tension: 120, friction: 14 }).start();
  };

  const shadowStyle = pressed || disabled ? neuPressedStyle(isDark) : neuFlatStyle(isDark);
  const bgColor = variant === 'primary' ? c.primary : variant === 'danger' ? '#DC2626' : c.base;
  const labelColor = variant === 'primary' || variant === 'danger' ? '#FFFFFF' : c.text;

  return (
    <Pressable
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={onPress}
      disabled={disabled || loading}
      style={wrapperStyle}
    >
      <Animated.View
        style={[
          shadowStyle,
          {
            borderRadius: radius.md,
            paddingVertical: spacing.md,
            paddingHorizontal: spacing.xxl,
            backgroundColor: bgColor,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: disabled ? 0.58 : 1,
            flexDirection: 'row',
            gap: spacing.sm,
            transform: [{ scale }],
          },
          // Inner style: everything except the row-participation keys when
          // distributing (avoids the Yoga flex-on-both-levels conflict);
          // the FULL original style when in legacy mode.
          wantsDistribute ? innerStyle : s,
        ]}
      >
        {loading ? (
          <ActivityIndicator color={labelColor} size="small" />
        ) : (
          <>
            {icon && <View>{icon}</View>}
            <Text
              numberOfLines={1}
              style={[{
                ...typography.label,
                color: labelColor,
                letterSpacing: 0.2,
                flexShrink: 1,
              }, textStyle]}
            >
              {label}
            </Text>
          </>
        )}
      </Animated.View>
    </Pressable>
  );
}
