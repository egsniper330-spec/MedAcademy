/**
 * SecureAppOverlay — Recent Apps & background blur protection.
 *
 * Renders a full-screen opaque overlay whenever the app moves to background
 * or inactive state. This prevents:
 *   - App preview thumbnails in the Recent Apps switcher leaking protected content
 *   - Shoulder-surfing via fast background/foreground switching
 *
 * Implementation:
 *   - On Android: FLAG_SECURE (via expo-screen-capture) already prevents
 *     OS-level screenshots; this overlay is a belt-and-suspenders JS layer.
 *   - Overlay appears instantly on 'inactive' (iOS) or 'background' (Android)
 *   - Removed as soon as 'active' is restored
 *   - Content: app logo + "Protected Content" message on a solid background
 *
 * Usage: place inside root _layout.tsx, always mounted.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, AppState, AppStateStatus, useColorScheme } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';

export function SecureAppOverlay() {
  const [visible, setVisible] = useState(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const opacity = useSharedValue(0);
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';

  useEffect(() => {
    if (process.env.EXPO_OS === 'web') return;

    const sub = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;

      const goingToBackground =
        (prev === 'active') &&
        (nextState === 'inactive' || nextState === 'background');

      const comingToForeground =
        (prev === 'inactive' || prev === 'background') &&
        nextState === 'active';

      if (goingToBackground) {
        setVisible(true);
        opacity.value = withTiming(1, { duration: 80 });
      } else if (comingToForeground) {
        opacity.value = withTiming(0, { duration: 200 }, () => {
          // Remove from render tree after fade-out completes
        });
        // Remove slightly after fade starts so animation is smooth
        setTimeout(() => setVisible(false), 200);
      }
    });

    return () => sub.remove();
  }, [opacity]);

  const overlayStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  if (!visible) return null;

  return (
    <Animated.View
      style={[overlayStyle, {
        position: 'absolute',
        top: 0, left: 0, right: 0, bottom: 0,
        zIndex: 99999,
        backgroundColor: isDark ? '#0F172A' : '#F1F5F9',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
      }]}
    >
      {/* Shield icon placeholder — pure View to avoid image loading delay */}
      <View style={{
        width: 72, height: 72, borderRadius: 22,
        backgroundColor: isDark ? '#1E293B' : '#E2E8F0',
        alignItems: 'center', justifyContent: 'center',
        shadowColor: isDark ? '#000' : '#94A3B8',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: isDark ? 0.4 : 0.2,
        shadowRadius: 12,
      }}>
        <Text style={{ fontSize: 36 }}>🔒</Text>
      </View>
      <Text style={{
        fontSize: 16,
        fontWeight: '600',
        color: isDark ? '#94A3B8' : '#64748B',
        letterSpacing: 0.3,
      }}>
        Protected Content
      </Text>
      <Text style={{
        fontSize: 12,
        color: isDark ? '#475569' : '#94A3B8',
      }}>
        MedAcademy
      </Text>
    </Animated.View>
  );
}
