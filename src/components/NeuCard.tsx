import React, { useRef, useCallback, memo } from 'react';
import { Animated, Pressable, View, ViewProps, useColorScheme } from 'react-native';
import { neuFlatStyle, neuPressedStyle } from '@/lib/neu';
import { radius as r, spacing, animation } from '@/lib/ds';

interface NeuCardProps extends ViewProps {
  /** Show as pressed (inset shadow). Default: false. */
  pressed?: boolean;
  children: React.ReactNode;
  /** Border radius override — defaults to ds.radius.lg (16dp). */
  radius?: number;
  /** If true, animates scale+shadow on press. Default: false. */
  pressable?: boolean;
  onPress?: () => void;
  /** Padding override — defaults to ds.spacing.md (12dp). */
  padding?: number;
  /** Accessibility label for pressable cards */
  accessibilityLabel?: string;
  /** Accessibility hint for pressable cards */
  accessibilityHint?: string;
}

export const NeuCard = memo(function NeuCard({
  pressed = false,
  children,
  style,
  radius = r.lg,
  pressable = false,
  onPress,
  padding = spacing.md,
  accessibilityLabel,
  accessibilityHint,
  ...rest
}: NeuCardProps) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const scale = useRef(new Animated.Value(1)).current;

  const onPressIn = useCallback(() => {
    Animated.spring(scale, { toValue: 0.97, ...animation.springSnappy }).start();
  }, [scale]);

  const onPressOut = useCallback(() => {
    Animated.spring(scale, { toValue: 1, ...animation.springSnappy }).start();
  }, [scale]);

  const shadowStyle = pressed ? neuPressedStyle(isDark) : neuFlatStyle(isDark);

  const inner = (
    <Animated.View
      style={[
        shadowStyle,
        { borderRadius: radius, padding, transform: [{ scale }] },
        style,
      ]}
      {...rest}
    >
      {children}
    </Animated.View>
  );

  if (pressable && onPress) {
    return (
      <Pressable
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        style={{ borderRadius: radius }}
        accessible
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
      >
        {inner}
      </Pressable>
    );
  }
  return inner;
});
