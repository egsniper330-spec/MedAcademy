import React, { useRef, useState } from 'react';
import { Animated, Pressable, Text, ActivityIndicator, View, useColorScheme, ViewStyle, TextStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { neuFlatStyle, neuPressedStyle, neuColors } from '@/lib/neu';

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

export function NeuButton({
  label, onPress, loading = false, variant = 'primary',
  disabled = false, style, textStyle, fullWidth = false, icon,
}: NeuButtonProps) {
  const [pressed, setPressed] = useState(false);
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const scale = useRef(new Animated.Value(1)).current;

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
      style={{ width: fullWidth ? '100%' : undefined, borderRadius: 14 }}
    >
      <Animated.View
        style={[
          shadowStyle,
          {
            borderRadius: 14,
            paddingVertical: 14,
            paddingHorizontal: 24,
            backgroundColor: bgColor,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: disabled ? 0.58 : 1,
            flexDirection: 'row',
            gap: 8,
            transform: [{ scale }],
          },
          style,
        ]}
      >
        {loading ? (
          <ActivityIndicator color={labelColor} size="small" />
        ) : (
          <>
            {icon && <View style={{ marginRight: 2 }}>{icon}</View>}
            <Text
              numberOfLines={1}
              style={[{
                fontSize: 15, fontWeight: '700', color: labelColor,
                letterSpacing: 0.2, flexShrink: 1,
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
