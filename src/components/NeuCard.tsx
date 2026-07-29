import React, { useRef } from 'react';
import { Animated, Pressable, View, ViewProps, useColorScheme } from 'react-native';
import { neuFlatStyle, neuPressedStyle } from '@/lib/neu';

interface NeuCardProps extends ViewProps {
  /** Show as pressed (inset shadow). Default: false. */
  pressed?: boolean;
  children: React.ReactNode;
  radius?: number;
  /** If true, animates scale+shadow on press. Default: true. */
  pressable?: boolean;
  onPress?: () => void;
}

export function NeuCard({
  pressed = false,
  children,
  style,
  radius = 18,
  pressable = false,
  onPress,
  ...rest
}: NeuCardProps) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const scale = useRef(new Animated.Value(1)).current;

  const onPressIn = () => {
    Animated.spring(scale, {
      toValue: 0.97,
      useNativeDriver: true,
      tension: 120,
      friction: 14,
    }).start();
  };
  const onPressOut = () => {
    Animated.spring(scale, {
      toValue: 1,
      useNativeDriver: true,
      tension: 120,
      friction: 14,
    }).start();
  };

  const shadowStyle = pressed ? neuPressedStyle(isDark) : neuFlatStyle(isDark);

  const inner = (
    <Animated.View
      style={[
        shadowStyle,
        { borderRadius: radius, padding: 14, transform: [{ scale }] },
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
      >
        {inner}
      </Pressable>
    );
  }
  return inner;
}
