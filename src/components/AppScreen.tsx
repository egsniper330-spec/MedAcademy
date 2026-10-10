/**
 * AppScreen — the universal screen wrapper for every page in the app.
 *
 * Responsibilities:
 *  • Sets the neumorphic background color (never white/black raw)
 *  • Handles safe-area on all devices (Dynamic Island, notch, gesture bar, 3-button nav)
 *  • Provides two layout modes:
 *     - scroll=false (default): plain View, flex=1, for screens managing their own scroll
 *     - scroll=true: KeyboardAvoidingView + ScrollView, ideal for forms
 *
 * Usage:
 *   // Basic (FlatList / custom scroll)
 *   <AppScreen>
 *     <PageHeader title="My Page" />
 *     <FlatList ... />
 *   </AppScreen>
 *
 *   // Form / content (auto-scrolling)
 *   <AppScreen scroll>
 *     <PageHeader title="Settings" showBack />
 *     <NeuCard>...</NeuCard>
 *   </AppScreen>
 *
 *   // Custom padding
 *   <AppScreen noPadding>
 *     {/* header takes full bleed *}
 *   </AppScreen>
 */
import React from 'react';
import {
  View,
  StyleSheet, type ViewStyle, type ScrollViewProps,
  useColorScheme,
} from 'react-native';
import { neuColors } from '@/lib/neu';
import { useDS } from '@/lib/ds';
import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScrollView';

interface AppScreenProps {
  children: React.ReactNode;
  /** Wrap content in KeyboardAvoidingView + ScrollView (best for forms) */
  scroll?: boolean;
  /** Remove horizontal content padding (useful for full-bleed headers) */
  noPadding?: boolean;
  /** Additional container style */
  style?: ViewStyle;
  /** ScrollView props (only used when scroll=true) */
  scrollProps?: ScrollViewProps;
}

export function AppScreen({
  children,
  scroll = false,
  noPadding = false,
  style,
  scrollProps,
}: AppScreenProps) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const ds = useDS();

  const bg = { backgroundColor: c.base };
  const hPad = noPadding ? 0 : ds.screenPx;

  if (scroll) {
    //  KEYBOARD FIX (was a DOUBLE INSET): see the note in AdaptiveScreen —
    //  iOS adjusted the scroll view's insets AND `behavior="padding"` pushed the
    //  subtree up, and Android's `adjustResize` plus `behavior="height"` shrank
    //  the container twice. KeyboardAwareScrollView applies the single correct
    //  native mechanism per platform instead.
    return (
      <View style={[styles.root, bg]}>
        <KeyboardAwareScrollView
          showsVerticalScrollIndicator={false}
          {...scrollProps}
          contentContainerStyle={[
            { paddingHorizontal: hPad, flexGrow: 1 },
            scrollProps?.contentContainerStyle,
          ]}
          style={[styles.root, style]}
        >
          {children}
        </KeyboardAwareScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.root, bg, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
