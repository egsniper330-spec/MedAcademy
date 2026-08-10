// Project guard — MUST be the very first import.
// Installs the global fetch interceptor that hard-blocks any request to the
// retired backend (itrcmypbgqyaseexwvks).  Any forgotten dependency
// will throw immediately with a full diagnostic instead of silently succeeding.
import { assertMeDoBlocked } from '@/lib/medo-guard';

import React, { useState, useCallback, useEffect } from 'react';
import { Stack } from 'expo-router';
import { View } from 'react-native';
import { PortalHost } from '@rn-primitives/portal';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as NavigationBar from 'expo-navigation-bar';

import { SessionProvider, useSession } from '@/ctx';
import { ToastProvider } from '@/components/Toast';
import { ImpersonationBanner } from '@/components/ImpersonationBanner';
import { SecurityProvider } from '@/lib/SecurityContext';
import { SecureAppOverlay } from '@/components/SecureAppOverlay';
import { ForceUpdateScreen } from '@/components/ForceUpdateScreen';
import { useForceUpdate } from '@/lib/useForceUpdate';
import "../global.css";

// Assert the active project is xdvjwfuqipatkpimejcb at startup.
// This runs once when the root layout module is first evaluated.
assertMeDoBlocked();

/**
 * ForceUpdateGate — rendered at the ROOT level, above ALL navigation.
 *
 * Execution order guarantees:
 *   ForceUpdateGate > authentication > home > course loading > video playback
 *
 * Hard block (isForceUpdateRequired):
 *   • Replaces the entire screen — Stack navigator is never rendered.
 *   • Android Back button is intercepted by ForceUpdateScreen.
 *   • No navigation, auth, or content is accessible.
 *
 * Soft update (isSoftUpdateAvailable):
 *   • The banner is rendered ABOVE the Stack navigator.
 *   • The user can dismiss it once per session; the app remains fully usable.
 *   • On foreground resume the hook re-evaluates; if still applicable the
 *     dismissed state is reset so the banner reappears after a full restart.
 */
function ForceUpdateGate({ children }: { children: React.ReactNode }) {
  const updateState = useForceUpdate();
  const [softDismissed, setSoftDismissed] = useState(false);

  const onDismissSoft = useCallback(() => {
    setSoftDismissed(true);
  }, []);

  // ── Hard block ────────────────────────────────────────────────────────────
  if (updateState.isForceUpdateRequired) {
    return (
      <ForceUpdateScreen
        {...updateState}
        soft={false}
      />
    );
  }

  // ── Normal + optional soft banner ─────────────────────────────────────────
  return (
    <View style={{ flex: 1 }}>
      {children}
      {updateState.isSoftUpdateAvailable && !softDismissed && (
        <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0 }}>
          <ForceUpdateScreen
            {...updateState}
            soft
            onDismiss={onDismissSoft}
          />
        </View>
      )}
    </View>
  );
}

function RootLayoutNav() {
  const { session, isLoading } = useSession();

  // CRITICAL: <Stack> MUST always be rendered — returning early (spinner) before
  // the navigator mounts leaves expo-router with an empty route table.
  // When the app opens via deep link (medacademy:///) the path "/" arrives before
  // isLoading settles, causing "Unmatched Route" if Stack isn't mounted yet.
  //
  // Fix: always render Stack. The root index.tsx handles the loading/redirect logic.
  // Stack.Protected with guard=false simply removes routes from the active table;
  // expo-router then falls back to the nearest registered sibling ("index").
  // index is registered OUTSIDE Protected so it is always available as the fallback.
  return (
    <Stack screenOptions={{ headerShown: false }}>
      {/* index is ALWAYS in the route table — serves as loading screen and landing page */}
      <Stack.Screen name="index" />
      {/* Public routes (sign-in, sign-up, etc.) — active only when not logged in */}
      <Stack.Protected guard={!session && !isLoading}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
      {/* Protected routes — active only when logged in and session resolved */}
      <Stack.Protected guard={!!session && !isLoading}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
    </Stack>
  );
}

const RootLayout: React.FC = () => {
  // Make the Android system navigation bar fully transparent so React Navigation
  // can render the tab bar edge-to-edge and apply its own safe-area padding.
  // This works in tandem with android.navigationBarColor = "#00000000" in app.json.
  useEffect(() => {
    if (process.env.EXPO_OS === 'android') {
      NavigationBar.setPositionAsync('absolute');
      NavigationBar.setBackgroundColorAsync('#00000000');
      NavigationBar.setButtonStyleAsync('dark');
    }
  }, []);

  return (
    // SafeAreaProvider MUST be at root — provides insets to every useSafeAreaInsets()
    // call throughout the entire app. Without it, insets.top/bottom return 0 on Android.
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SessionProvider>
          <SecurityProvider>
            {/* ForceUpdateGate wraps ALL content — runs before auth, before navigation */}
            <ForceUpdateGate>
              <ToastProvider>
                <View style={{ flex: 1 }}>
                  {/* Impersonation banner — shown above everything when Login As is active */}
                  <ImpersonationBanner />
                  <RootLayoutNav />
                </View>
                {/* Recent Apps protection: opaque overlay on inactive/background */}
                <SecureAppOverlay />
                <PortalHost />
              </ToastProvider>
            </ForceUpdateGate>
          </SecurityProvider>
        </SessionProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
};

export default RootLayout;
