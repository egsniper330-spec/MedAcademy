/**
 * AdaptiveScreen — universal screen wrapper for every MedAcademy screen.
 *
 * Replaces ALL three of:
 *   • AppScreen (basic wrapper)
 *   • Per-screen KeyboardAvoidingView + ScrollView combos
 *   • Per-screen useSafeAreaInsets() calls
 *
 * Handles automatically:
 *   ✅ Neumorphic background color
 *   ✅ Safe-area insets on all devices (status bar, notch, Dynamic Island,
 *      gesture nav, 3-button nav, camera cutout, foldable inner screen)
 *   ✅ Keyboard avoidance — correct behavior on iOS (padding) and Android (height)
 *   ✅ Bottom nav bar clearance for scroll content
 *   ✅ Orientation changes without restart
 *   ✅ Split-screen / multi-window dynamic resizing
 *   ✅ Foldable hinge avoidance via left/right insets
 *
 * Usage:
 *   // Standard list screen (manages its own FlatList scroll)
 *   <AdaptiveScreen>
 *     <AppHeader title="My Screen" showBack />
 *     <FlatList contentContainerStyle={{ paddingBottom: layout.scrollBottom() }} />
 *   </AdaptiveScreen>
 *
 *   // Form screen (auto scroll + keyboard avoidance)
 *   <AdaptiveScreen scroll>
 *     <AppHeader title="Edit Profile" showBack />
 *     <NeuInputRow label="Name" value={name} onChangeText={setName} />
 *     <NeuButton title="Save" onPress={handleSave} />
 *   </AdaptiveScreen>
 *
 *   // Centered tablet form
 *   <AdaptiveScreen scroll centered>
 *     <AppHeader title="Settings" showBack />
 *     <NeuCard>...</NeuCard>
 *   </AdaptiveScreen>
 *
 *   // Extra bottom clearance (clears a floating action button)
 *   <AdaptiveScreen scroll extraBottom={72}>
 *     ...
 *   </AdaptiveScreen>
 */
import React from 'react';
import {
  View, ScrollView, KeyboardAvoidingView,
  StyleSheet, useColorScheme,
  type ViewStyle, type ScrollViewProps,
} from 'react-native';
import { neuColors } from '@/lib/neu';
import { useLayout, spacing } from '@/lib/ds';

export interface AdaptiveScreenProps {
  children: React.ReactNode;

  /**
   * Wrap content in KeyboardAvoidingView + ScrollView.
   * Required for any screen containing TextInput fields.
   */
  scroll?: boolean;

  /**
   * Center content with max-width column (tablet/desktop, no-op on phones).
   * Best for forms, settings, profile, course-detail pages.
   */
  centered?: boolean;

  /**
   * Remove horizontal padding (for full-bleed heroes / video players).
   */
  noPadding?: boolean;

  /**
   * Extra dp added below scroll content (e.g. to clear a FAB).
   * The safe-area inset is already included — this is the additional amount.
   */
  extraBottom?: number;

  /** Override the background color. Defaults to neumorphic c.base. */
  backgroundColor?: string;

  /** Additional root container style. */
  style?: ViewStyle;

  /** ScrollView passthrough props (only when scroll=true). */
  scrollProps?: ScrollViewProps;
}

export function AdaptiveScreen({
  children,
  scroll = false,
  centered = false,
  noPadding = false,
  extraBottom = 0,
  backgroundColor,
  style,
  scrollProps,
}: AdaptiveScreenProps) {
  const scheme  = useColorScheme();
  const isDark  = scheme === 'dark';
  const c       = isDark ? neuColors.dark : neuColors.light;
  const layout  = useLayout();

  const bg     = backgroundColor ?? c.base;
  const hPad   = noPadding ? 0 : layout.screenPx;
  const bPad   = layout.scrollBottom(extraBottom);

  // Max-width centering for tablets (Netflix / Google / Facebook pattern)
  const maxW   = centered ? layout.maxContentWidth : undefined;

  const contentStyle: ViewStyle[] = [
    { flexGrow: 1 },
    { paddingHorizontal: hPad },
    { paddingBottom: bPad },
    maxW != null
      ? { maxWidth: maxW, alignSelf: 'center' as const, width: '100%' }
      : {},
  ];

  if (scroll) {
    return (
      <KeyboardAvoidingView
        style={[styles.root, { backgroundColor: bg }]}
        behavior={process.env.EXPO_OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          {...scrollProps}
          contentContainerStyle={[
            ...contentStyle,
            scrollProps?.contentContainerStyle as ViewStyle | undefined,
          ]}
          style={[styles.root, style]}
        >
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: bg }, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
