/**
 * useSystemBars — keeps the Android system navigation bar visually part of the
 * app in BOTH light and dark mode.
 *
 * This hook owns exactly one concern: the navigation-bar ICON APPEARANCE and
 * behaviour. It deliberately does NOT set a background colour — the bar is
 * edge-to-edge (transparent, from plugins/withSystemBars.js) so the app's own
 * surface shows through it. Hardcoding white/black would recreate the very
 * "detached strip" this is meant to remove.
 *
 * Division of ownership (do not duplicate):
 *   • plugins/withSystemBars.js → theme level. Disables
 *     android:enforceNavigationBarContrast (the OS scrim that produced the
 *     disconnected white/black band) and seeds the per-theme icon appearance
 *     so the correct look is already applied before JS runs.
 *   • this hook → runtime. Re-asserts the icon style whenever the resolved
 *     colour scheme changes, including a mid-session light↔dark switch.
 *   • lib/fullscreenSystemUi.ts → video fullscreen only. It hides/restores
 *     the bar; it does not manage icons.
 *
 * Android-only: on iOS/web these APIs do not exist and the hook is a no-op.
 */

import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as NavigationBar from 'expo-navigation-bar';

/**
 * @param isDark Resolved dark-mode state (from the app's colour scheme).
 */
export function useSystemBars(isDark: boolean) {
  useEffect(() => {
    if (Platform.OS !== 'android') return;

    // NavigationBar.setButtonStyleAsync('light') → LIGHT icons, for DARK
    // backgrounds. ('dark' → dark icons for light backgrounds.) This mirrors
    // android:windowLightNavigationBar, re-applied at runtime so a scheme
    // change takes effect immediately without relying on the Activity theme.
    const iconStyle: 'light' | 'dark' = isDark ? 'light' : 'dark';

    void (async () => {
      try {
        await NavigationBar.setButtonStyleAsync(iconStyle);
      } catch {
        // Module unavailable (Go edition / odd OEM) — theme value still applies.
      }
      try {
        // Swipe-from-edge reveals the bar transiently instead of pinning an
        // opaque bar over the app surface.
        await NavigationBar.setBehaviorAsync('inset-touch');
      } catch {
        /* non-fatal */
      }
    })();
  }, [isDark]);
}
