// Project guard — MUST be the very first import.
// Installs the global fetch interceptor that hard-blocks any request to the
// retired backend (itrcmypbgqyaseexwvks).  Any forgotten dependency
// will throw immediately with a full diagnostic instead of silently succeeding.
import { assertMeDoBlocked } from '@/lib/medo-guard';

import React, { useState, useCallback } from 'react';
import { Stack } from 'expo-router';
import {
  ActivityIndicator, View,
  Text,
} from 'react-native';
import { PortalHost } from '@rn-primitives/portal';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

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

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EEF2F7' }}>
        <ActivityIndicator size="large" color="#1E90FF" />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      {/* Public routes: no login required */}
      <Stack.Protected guard={!session}>
        <Stack.Screen name="index" />
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
      {/* Protected routes: guard=false removes route from table, falls back to nearest available */}
      <Stack.Protected guard={!!session}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
    </Stack>
  );
}

const RootLayout: React.FC = () => {
  return (
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
  );
};

export default RootLayout;
