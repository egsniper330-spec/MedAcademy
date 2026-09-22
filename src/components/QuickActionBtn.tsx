/**
 * QuickActionBtn — shared dashboard quick-action tile.
 *
 * Layout contract (responsive, no device-specific values):
 * • Row: flexWrap + justifyContent:'space-between' (owned by the caller).
 * • Tile: `width: '22%'` — 4 per row on any phone width, wraps naturally on
 *   narrow/small screens; on wide screens the tile caps at touchTarget×1.6 so
 *   4-up stays proportionate instead of stretching (aspect ratio preserved by
 *   the fixed-square icon box).
 * • Icon box: fixed square (touchTarget + 10) → the container ALWAYS wraps its
 *   icon exactly — never stretches vertically. This is deliberately NOT
 *   `flexGrow: 1` inside a wrap row: percentage width + flexGrow in a
 *   flex-wrap row is a known Android/Yoga wrap-line stretch hazard (the
 *   "tall narrow rounded rectangle" bug seen on device dashboards).
 * • Touch target: the whole tile (icon + label) is the Pressable, so the
 *   accessible target comfortably exceeds 44dp in both axes.
 *
 * Derived entirely from runtime layout tokens (useLayout) — nothing hardcoded
 * per device.
 */

import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter, type RelativePathString } from 'expo-router';
import { neuFlatStyle, neuPressedStyle, useLayout } from '@/lib/neu';
import { neuColors } from '@/lib/neu';

interface QuickActionBtnProps {
  icon: React.ElementType;
  label: string;
  color: string;
  path: string;
  c: typeof neuColors.light;
  isDark: boolean;
}

export function QuickActionBtn({ icon: Icon, label, color, path, c, isDark }: QuickActionBtnProps) {
  const router  = useRouter();
  const layout  = useLayout();
  const btnSz   = layout.touchTarget + 10;
  const iconInner = Math.round(btnSz * 0.42);
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onPress={() => router.push(path as RelativePathString)}
      accessibilityLabel={label}
      accessibilityRole="button"
      style={{ width: '22%', maxWidth: Math.round(layout.touchTarget * 1.6), alignItems: 'center', marginBottom: layout.pad.md }}
    >
      <View style={[
        pressed ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
        { width: btnSz, height: btnSz, borderRadius: layout.cardRadius, alignItems: 'center', justifyContent: 'center', marginBottom: layout.pad.xs },
      ]}>
        <Icon size={iconInner} color={color} />
      </View>
      <Text style={{ fontSize: layout.captionSize - 1, fontWeight: '700', color: c.text, opacity: 0.65, textAlign: 'center' }} numberOfLines={2}>{label}</Text>
    </Pressable>
  );
}
