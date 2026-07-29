/**
 * useScreenCapture — screenshot & screen-recording protection
 *
 * Android: activates FLAG_SECURE (blocks screenshots + screen recording)
 *          Uses keyed tag 'screen-capture' so cleanup only removes this hook's
 *          lock and never interferes with useContentProtection's 'lesson' tag.
 * iOS:     detects screenshots via addScreenshotListener
 *          Recording detection requires native module — not available in expo-screen-capture SDK55
 */
import { useEffect } from 'react';
import * as ScreenCapture from 'expo-screen-capture';
import { logSecurityEvent } from '@/lib/security';

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
}

export function useScreenCapture(opts: Options = {}) {
  const {
    blockCapture = true,
    onScreenshotDetected,
    deviceId,
  } = opts;

  // Activate secure capture prevention using a stable keyed tag.
  // Using a key (instead of the no-arg overload) means allowScreenCaptureAsync
  // in cleanup ONLY removes this hook's lock — it never lifts a lock set by
  // another hook (e.g. useContentProtection's 'lesson' tag).
  useEffect(() => {
    if (process.env.EXPO_OS === 'web') return;
    if (!blockCapture) return;

    ScreenCapture.preventScreenCaptureAsync(SC_KEY).catch(() => {
      // Non-fatal — simulators/emulators may reject this
    });

    return () => {
      ScreenCapture.allowScreenCaptureAsync(SC_KEY).catch(() => {});
    };
  }, [blockCapture]);

  // Screenshot detection (addScreenshotListener — available in expo-screen-capture SDK55)
  useEffect(() => {
    if (process.env.EXPO_OS === 'web') return;

    const subscription = ScreenCapture.addScreenshotListener(() => {
      void logSecurityEvent({
        eventType: 'screenshot_detected',
        detectionMethod: 'expo-screen-capture addScreenshotListener',
        deviceId,
      });
      onScreenshotDetected?.();
    });

    return () => subscription.remove();
  }, [onScreenshotDetected, deviceId]);
}
