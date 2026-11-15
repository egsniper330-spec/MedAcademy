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
import { neuFlatStyle, neuPressedStyle, useLayout, mutedTextStyle } from '@/lib/neu';
import { neuColors } from '@/lib/neu';
import { markEntryIntent } from '@/lib/navigation/navIntent';

interface QuickActionBtnProps {
  icon: React.ElementType;
  label: string;
  color: string;
  path: string;
  c: typeof neuColors.light;
  isDark: boolean;
  /**
   * Exact tile width in dp, computed by the caller from the content width and the
   * number of columns.
   *
   * WHY THE CALLER COMPUTES IT: this tile used to be `width:'22%'` PLUS
   * `maxWidth: touchTarget*1.6`. On a phone 22% was smaller than the cap, so four
   * tiles filled the row; on a tablet/web (e.g. the 768dp-wide Preview panel) 22%
   * was far LARGER than the cap, so each tile shrank to ~70dp while
   * `justifyContent:'space-between'` still spread them across the full row. The
   * result was exactly the reported defect: uneven gaps, icons that looked
   * undersized next to their labels, and a layout that changed character between
   * phone and tablet. A single caller-computed width removes the percentage/cap
   * conflict and keeps every tile identical at every viewport.
   */
  width?: number | `${number}%`;
}

export function QuickActionBtn({ icon: Icon, label, color, path, c, isDark, width }: QuickActionBtnProps) {
  const router  = useRouter();
  const layout  = useLayout();
  // Default: a percentage of the PARENT row, which is what actually needs to fit.
  // A window-derived dp width was tried and rejected: the dashboard row is narrower
  // than the window (drawer + content max-width), so dp tiles overflowed it and the
  // fourth tile wrapped onto its own line. A percentage always tracks the real
  // container, and with the maxWidth cap gone (the actual defect) the tiles are
  // identical at every viewport.
  const tileWidth = width ?? '22%';
  const btnSz   = layout.touchTarget + 10;
  // One icon scale for every quick action (was `btnSz * 0.42`, which produced
  // 23–24px on phones and 22px on tablets while StatCard icons stayed at 16px).
  const iconInner = layout.iconSize.md;
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onPress={() => {
        // A quick action opens the destination FROM this screen: the destination
        // must offer Back (not the drawer menu), even when its route is also a
        // primary drawer/tab destination (e.g. Students).
        markEntryIntent(path, 'nested');
        router.push(path as RelativePathString);
      }}
      accessibilityLabel={label}
      accessibilityRole="button"
      style={{ width: tileWidth, alignItems: 'center', marginBottom: layout.pad.md }}
    >
      <View style={[
        pressed ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
        { width: btnSz, height: btnSz, borderRadius: layout.cardRadius, alignItems: 'center', justifyContent: 'center', marginBottom: layout.pad.xs },
      ]}>
        <Icon size={iconInner} color={color} />
      </View>
      {/* Reserved two-line height keeps every label baseline-aligned even when one
          label wraps and another does not (Arabic strings are wider). */}
      <Text
        style={{
          fontSize: layout.captionSize - 1,
          fontWeight: '700',
          lineHeight: Math.round((layout.captionSize - 1) * 1.35),
          minHeight: Math.round((layout.captionSize - 1) * 1.35) * 2,
          ...mutedTextStyle(c, 0.78),
          textAlign: 'center',
          width: '100%',
        }}
        numberOfLines={2}
      >{label}</Text>
    </Pressable>
  );
}
