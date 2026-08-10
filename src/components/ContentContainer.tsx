/**
 * ContentContainer — adaptive max-width centering for tablet/desktop layouts.
 *
 * On phones: renders children full-width (no effect).
 * On tablets/foldables: constrains content to maxContentWidth and centres it,
 * exactly like Netflix, Google Settings, Facebook, and Gmail.
 *
 * Usage:
 *   // Wrap a form, settings list, or profile page:
 *   <ContentContainer>
 *     <NeuCard>...</NeuCard>
 *   </ContentContainer>
 *
 *   // Full-bleed hero + centred content:
 *   <HeroImage />
 *   <ContentContainer>
 *     <CourseDetails />
 *   </ContentContainer>
 *
 *   // With extra horizontal padding override:
 *   <ContentContainer px={spacing.xxl}>
 *     <SettingsList />
 *   </ContentContainer>
 */
import React, { memo } from 'react';
import { View, type ViewStyle } from 'react-native';
import { useAdaptive } from '@/lib/ds';

interface ContentContainerProps {
  children: React.ReactNode;
  /** Override horizontal padding (default: layout.screenPx) */
  px?: number;
  /** Extra style on the outer wrapper */
  style?: ViewStyle;
  /** Extra style on the inner constrained column */
  innerStyle?: ViewStyle;
}

export const ContentContainer = memo(function ContentContainer({
  children, px, style, innerStyle,
}: ContentContainerProps) {
  const layout = useAdaptive();
  const hPad   = px ?? layout.screenPx;
  const maxW   = layout.maxContentWidth;

  // Phones: just apply horizontal padding — zero overhead
  if (!maxW) {
    return (
      <View style={[{ paddingHorizontal: hPad }, style]}>
        {children}
      </View>
    );
  }

  // Tablets / foldables: centre the column
  return (
    <View style={[{ width: '100%', alignItems: 'center' }, style]}>
      <View
        style={[
          { width: '100%', maxWidth: maxW, paddingHorizontal: hPad },
          innerStyle,
        ]}
      >
        {children}
      </View>
    </View>
  );
});
