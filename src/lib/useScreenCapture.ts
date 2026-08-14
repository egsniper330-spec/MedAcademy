/**
 * useScreenCapture — screenshot & screen-recording protection
 *
 * Android: activates FLAG_SECURE (blocks screenshots + screen recording)
 *          Uses keyed tag 'screen-capture' so cleanup only removes this hook's
 *          lock and never interferes with useContentProtection's 'lesson' tag.
 * iOS:     detects screenshots via addScreenshotListener
 *          Recording detection requires native module — not available in expo-screen-capture SDK55
 *
 * Super Admin bypass: when isSuperAdmin is true the FLAG_SECURE lock is released
 * and the screenshot listener is not installed. This must only be set from a
 * backend-verified session (SecurityContext.isSuperAdmin).
 */
import { useEffect } from 'react';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { logSecurityEvent } from '@/lib/security';

type ScreenCaptureModule = typeof import('expo-screen-capture');
const ScreenCapture = requireOptionalNativeModule<ScreenCaptureModule>('ExpoScreenCapture') as ScreenCaptureModule | null;

// Stable key — distinct from useContentProtection's 'lesson' key so the two
// hooks can coexist on the same screen without racing on cleanup.
const SC_KEY = 'screen-capture';

interface Options {
  /** Block screenshots/recording (Android FLAG_SECURE). Default true. */
  blockCapture?: boolean;
  /** Called when a screenshot is detected (iOS + Android). */
  onScreenshotDetected?: () => void;
  /** Device ID to attach to the security log event. */
  deviceId?: string;
  /**
   * True when the authenticated session belongs to a verified Super Admin.
   * When true, FLAG_SECURE is released and screenshot listener is not installed.
   * Must come from SecurityContext.isSuperAdmin (backend-verified profile role).
   */
  isSuperAdmin?: boolean;
}

export function useScreenCapture(opts: Options = {}) {
  const {
    blockCapture = true,
    onScreenshotDetected,
    deviceId,
    isSuperAdmin = false,
  } = opts;

  // Activate secure capture prevention using a stable keyed tag.
  // Super Admin bypass: release the lock so SA can take screenshots freely.
  // Using a key (instead of the no-arg overload) means allowScreenCaptureAsync
  // in cleanup ONLY removes this hook's lock — it never lifts a lock set by
  // another hook (e.g. useContentProtection's 'lesson' tag).
  useEffect(() => {
    if (process.env.EXPO_OS === 'web') return;
    if (!ScreenCapture) return; // native module not linked (missing pod) — no-op
    if (!blockCapture || isSuperAdmin) {
      // Either explicitly disabled or Super Admin bypass active — ensure lock is released
      ScreenCapture.allowScreenCaptureAsync(SC_KEY).catch(() => {});
      return;
    }

    ScreenCapture.preventScreenCaptureAsync(SC_KEY).catch(() => {
      // Non-fatal — simulators/emulators may reject this
    });

    return () => {
      ScreenCapture!.allowScreenCaptureAsync(SC_KEY).catch(() => {});
    };
  }, [blockCapture, isSuperAdmin]);

  // Screenshot detection (addScreenshotListener — available in expo-screen-capture SDK55)
  // Super Admin bypass: do not install listener — SA is allowed to screenshot.
  useEffect(() => {
    if (process.env.EXPO_OS === 'web') return;
    if (!ScreenCapture) return; // native module not linked — no-op
    if (isSuperAdmin) return;

    const subscription = ScreenCapture.addScreenshotListener(() => {
      void logSecurityEvent({
        eventType: 'screenshot_detected',
        detectionMethod: 'expo-screen-capture addScreenshotListener',
        deviceId,
      });
      onScreenshotDetected?.();
    });

    return () => subscription.remove();
  }, [onScreenshotDetected, deviceId, isSuperAdmin]);
}
