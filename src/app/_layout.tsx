// Project guard — MUST be the very first import.
// Installs the global fetch interceptor that hard-blocks any request to the
// retired backend (itrcmypbgqyaseexwvks).  Any forgotten dependency
// will throw immediately with a full diagnostic instead of silently succeeding.
import { assertMeDoBlocked } from '@/lib/medo-guard';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Stack } from 'expo-router';
import { View, AppState } from 'react-native';
import { PortalHost } from '@rn-primitives/portal';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as NavigationBar from 'expo-navigation-bar';
// expo-screen-capture: import the JS module directly so we call the real
// preventScreenCaptureAsync / allowScreenCaptureAsync wrapper functions.
//
// WHY NOT requireOptionalNativeModule:
//   requireOptionalNativeModule('ExpoScreenCapture') returns the RAW native
//   module proxy, which only exposes the low-level native methods:
//     .preventScreenCapture()  (no key, no async wrapper)
//     .allowScreenCapture()    (no key, no async wrapper)
//   The public API functions preventScreenCaptureAsync(key) and
//   allowScreenCaptureAsync(key) live in the JS wrapper (ScreenCapture.js),
//   NOT on the native proxy.  Calling .preventScreenCaptureAsync() on the
//   proxy returns undefined → TypeError: undefined is not a function → CRASH.
//
// SAFE IMPORT: expo-screen-capture/build/ScreenCapture.js itself guards every
// call with `if (!ExpoScreenCapture.preventScreenCapture)` before invoking the
// native method, so it is safe even on platforms where the native module is
// not linked (the function throws UnavailabilityError, which we .catch()).
// On web, we guard with process.env.EXPO_OS === 'web' before calling anything.
import * as ScreenCaptureLib from 'expo-screen-capture';

import { SessionProvider, useSession } from '@/ctx';
import { ToastProvider } from '@/components/Toast';
import { ImpersonationBanner } from '@/components/ImpersonationBanner';
import { SecurityProvider, useSecurity } from '@/lib/SecurityContext';
import { SecureAppOverlay } from '@/components/SecureAppOverlay';
import { ForceUpdateScreen } from '@/components/ForceUpdateScreen';
import { useForceUpdate } from '@/lib/useForceUpdate';
import "../global.css";

// Assert the active project is xdvjwfuqipatkpimejcb at startup.
// This runs once when the root layout module is first evaluated.
assertMeDoBlocked();

// ── DIAGNOSTIC: instrument this module's evaluation ───────────────────────────
import { diag, diagError } from '@/lib/diagnostics';
import { DiagScreen } from '@/components/DiagScreen';
diag('LAYOUT', '_layout.tsx module evaluated — JS runtime is alive');

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

/**
 * RootScreenCapture — iOS screenshot/screen-recording protection at the ROOT level.
 *
 * Security guarantee: protection covers all auth screens and the entire session, from
 * the moment the session state is known (isLoading=false) until the app is closed.
 *
 * WHY we wait for isLoading=false before activating:
 * ────────────────────────────────────────────────────────────────────────────────
 * expo-screen-capture's iOS native module (ExpoScreenCapture / ScreenCaptureModule)
 * implements preventScreenCapture() using the UITextField secure-layer trick:
 *
 *   func preventScreenshots() {
 *     let textField = UITextField()
 *     textField.isSecureTextEntry = true
 *     // On iOS 17+, UITextField allocates private CALayer sublayers immediately
 *     // on creation, even before being added to any view hierarchy.
 *     if let sublayer = textField.layer.sublayers?.first {
 *       keyWindow.layer.removeFromSuperlayer()       // ← detaches window from screen
 *       sublayer.addSublayer(keyWindow.layer)        // ← moves into private off-screen layer
 *     }
 *   }
 *
 * On iOS with New Architecture (Fabric/JSI), useEffects fire synchronously with
 * the first JS→native commit, which is dispatched to the main thread in the SAME
 * run-loop cycle as the initial CATransaction.flush(). At that point the window's
 * CALayer tree has been constructed in memory but the layers have NOT yet been
 * presented to the iOS display compositor (the GPU has not received the first frame).
 *
 * When preventScreenCapture() runs at this moment:
 *   1. keyWindow.layer.removeFromSuperlayer() — detaches the window layer from the
 *      screen's root layer before the compositor has registered it.
 *   2. sublayer.addSublayer(keyWindow.layer) — reparents it into UITextField's
 *      private off-screen CALayer (backed by no UIWindow or UIScreen).
 *
 * Result: the entire app renders into an off-screen buffer. The physical display
 * receives no content. The screen appears completely BLACK.
 *
 * Fix: gate preventScreenCapture on isLoading=false. By that point:
 *   • SessionProvider.getSession() has completed (one async round-trip).
 *   • At least one React render cycle and main-thread run-loop iteration have passed.
 *   • The CATransaction for the first frame has been flushed and presented.
 *   • The window's CALayer is fully registered with the display compositor.
 *   • Reparenting now works correctly — content remains visible.
 *
 * Security: the loading phase shows only an ActivityIndicator (no sensitive content).
 * Protection activates before any auth screen or user-owned content is ever rendered.
 *
 * Key = 'root-shell' — distinct from the (app)/ 'app-shell' key and the lesson 'lesson'
 * key. All three locks must be individually released before the OS permits capture again.
 *
 * Super Admin bypass: when a verified Super Admin session is active, we release this
 * root-level lock so they can take screenshots in their administrative capacity.
 *
 * AppState: protection is re-applied on every foreground transition to survive
 * background/foreground cycles where iOS may reset the UITextField secure state.
 */
const ROOT_SC_KEY = 'root-shell';

function RootScreenCapture() {
  const { isSuperAdmin } = useSecurity();
  const isSuperAdminRef = useRef(isSuperAdmin);
  isSuperAdminRef.current = isSuperAdmin;

  // isLoading from SessionProvider: false once getSession() has resolved.
  // We MUST NOT call preventScreenCaptureAsync until isLoading=false.
  // See detailed explanation in the comment block above.
  const { isLoading } = useSession();

  // DIAG: track every render of RootScreenCapture
  diag('SC', 'RootScreenCapture render', `isLoading=${isLoading} isSuperAdmin=${isSuperAdmin}`);

  // Apply / release based on Super Admin status.
  // Gated on !isLoading so the first native frame is already presented before
  // we reparent keyWindow.layer into the UITextField secure sublayer.
  useEffect(() => {
    if (process.env.EXPO_OS === 'web') return;
    if (isLoading) {
      diag('SC', 'ROOT_SC_KEY effect — isLoading=true SKIPPED (gate active)');
      return;
    }
    diag('SC', `ROOT_SC_KEY effect FIRING`, `isSuperAdmin=${isSuperAdmin}`);
    if (isSuperAdmin) {
      // Super Admin: release the root-level lock so they can screenshot freely
      ScreenCaptureLib.allowScreenCaptureAsync(ROOT_SC_KEY)
        .then(() => diag('SC', 'ROOT_SC_KEY allowScreenCaptureAsync RESOLVED'))
        .catch((e) => diagError('ERR', 'ROOT_SC_KEY allowScreenCaptureAsync FAILED', e));
    } else {
      // Normal user (including unauthenticated): protection must be active
      ScreenCaptureLib.preventScreenCaptureAsync(ROOT_SC_KEY)
        .then(() => diag('SC', 'ROOT_SC_KEY preventScreenCaptureAsync RESOLVED'))
        .catch((e) => diagError('ERR', 'ROOT_SC_KEY preventScreenCaptureAsync FAILED', e));
    }
  }, [isSuperAdmin, isLoading]);

  // Re-apply on every foreground transition — iOS may reset the protection state
  // across background/foreground cycles (particularly on older iOS versions).
  //
  // iOS TIMING FIX — setTimeout(0) in AppState 'active' handler:
  // When iOS resumes from background it re-presents the window on the display
  // compositor. On iOS New Architecture (Fabric/JSI) the AppState 'active' event
  // fires on the same main-thread run-loop iteration as the incoming CATransaction
  // that re-presents the first resumed frame. If preventScreenCapture() runs in
  // that same iteration, it calls keyWindow.layer.removeFromSuperlayer() before
  // the resumed frame has been flushed to the compositor → BLACK SCREEN (identical
  // mechanism to the startup race in the isLoading effect above).
  //
  // A single setTimeout(0) defers the call to the NEXT run-loop iteration, by
  // which point the resume CATransaction has already flushed. The window layer
  // is re-registered with the compositor before we reparent it.
  //
  // Android: FLAG_SECURE never reparents the window layer; this timing is harmless.
  // Web: guarded by the EXPO_OS check.
  useEffect(() => {
    if (process.env.EXPO_OS === 'web') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        diag('SC', 'ROOT_SC_KEY AppState active — scheduling setTimeout(0)');
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          diag('SC', `ROOT_SC_KEY AppState setTimeout(0) FIRED`, `isSuperAdmin=${isSuperAdminRef.current}`);
          if (isSuperAdminRef.current) {
            ScreenCaptureLib.allowScreenCaptureAsync(ROOT_SC_KEY)
              .then(() => diag('SC', 'ROOT_SC_KEY AppState allow RESOLVED'))
              .catch((e) => diagError('ERR', 'ROOT_SC_KEY AppState allow FAILED', e));
          } else {
            ScreenCaptureLib.preventScreenCaptureAsync(ROOT_SC_KEY)
              .then(() => diag('SC', 'ROOT_SC_KEY AppState prevent RESOLVED'))
              .catch((e) => diagError('ERR', 'ROOT_SC_KEY AppState prevent FAILED', e));
          }
        }, 0);
      }
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      sub.remove();
    };
  }, []);

  // Release the root-level lock on unmount (clean state for web/test environments).
  useEffect(() => {
    if (process.env.EXPO_OS === 'web') return;
    return () => {
      ScreenCaptureLib.allowScreenCaptureAsync(ROOT_SC_KEY).catch(() => {});
    };
  }, []);

  return null;
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
  // DIAG: RootLayout component body executing = React has bootstrapped.
  diag('LAYOUT', 'RootLayout component executing');

  // Make the Android system navigation bar fully transparent so React Navigation
  // can render the tab bar edge-to-edge and apply its own safe-area padding.
  // This works in tandem with android.navigationBarColor = "#00000000" in app.json.
  useEffect(() => {
    diag('LAYOUT', 'RootLayout mount useEffect fired');
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
            {/* RootScreenCapture: iOS screenshot protection from app launch (before login) */}
            <RootScreenCapture />
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
        {/*
         * ── DIAGNOSTIC OVERLAY ────────────────────────────────────────────────
         * Rendered OUTSIDE SessionProvider/SecurityProvider so it is visible
         * even when all providers fail or when the normal UI goes black.
         * zIndex 99999 keeps it above every navigator and overlay.
         * Remove this and the DiagScreen import once diagnosis is complete.
         */}
        <DiagScreen />
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
};

export default RootLayout;
