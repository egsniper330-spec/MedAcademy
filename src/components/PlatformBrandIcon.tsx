/**
 * PlatformBrandIcon — official social-platform mark for a contact row.
 *
 * Renders the vendored 24x24 brand outline (see platformBrandPaths.ts) through
 * react-native-svg, which the app already depends on, so no font/asset pipeline
 * or new package is involved. The glyph is scaled by `size` only — width and
 * height are always equal, so a logo can never be stretched.
 *
 * Colour: the official brand colour by default, because that is what makes the
 * logo recognisable against the neumorphic card. `tint` overrides it where a
 * brand colour would disappear (e.g. X's near-black mark in dark mode).
 */

import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { brandMarkFor } from '@/components/platformBrandPaths';

interface PlatformBrandIconProps {
  platform: string;
  size: number;
  /** Override the brand colour (used for marks that vanish on a dark card). */
  tint?: string;
  accessibilityLabel?: string;
}

/** True when a real brand mark exists for this platform. */
export function hasPlatformBrandIcon(platform: string): boolean {
  return brandMarkFor(platform) !== null;
}

export function PlatformBrandIcon({ platform, size, tint, accessibilityLabel }: PlatformBrandIconProps) {
  const mark = brandMarkFor(platform);
  if (!mark) return null;
  // Equal width/height is what keeps the mark square: a stretched logo is the
  // classic symptom of sizing only one axis.
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={accessibilityLabel ?? mark.title}
      accessibilityLabel={accessibilityLabel ?? mark.title}
    >
      <Path d={mark.path} fill={tint ?? `#${mark.hex}`} />
    </Svg>
  );
}

/**
 * Brand colour to paint a platform badge with, adapted for the active theme.
 *
 * WhatsApp/Telegram/Facebook/Instagram keep their official colour. X is
 * near-black, which is invisible on the dark neumorphic card, so it falls back
 * to the theme's foreground colour there — still the official mark, just legible.
 */
export function brandIconTint(platform: string, isDark: boolean, foreground: string): string {
  const mark = brandMarkFor(platform);
  if (!mark) return foreground;
  if (platform.toLowerCase() === 'x' && isDark) return foreground;
  return `#${mark.hex}`;
}
