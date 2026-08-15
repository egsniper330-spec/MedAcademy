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
// Import the JS wrapper module directly — NOT requireOptionalNativeModule.
//
// WHY: requireOptionalNativeModule('ExpoScreenCapture') returns the raw native
// module proxy, which only exposes .preventScreenCapture() and .allowScreenCapture()
// (native-level, no key argument).  The public keyed API functions
// preventScreenCaptureAsync(key) and allowScreenCaptureAsync(key) are JS
// wrapper functions defined in expo-screen-capture/build/ScreenCapture.js —
// they do NOT exist on the native proxy.  Calling them on the proxy gives
// undefined → TypeError: undefined is not a function → fatal crash on Android.
//
// The JS module itself guards every native call with availability checks
// (`if (!ExpoScreenCapture.preventScreenCapture)`), so it is safe even when
// the native module is unavailable.
import * as ScreenCaptureLib from 'expo-screen-capture';
import { logSecurityEvent } from '@/lib/security';

import { diag, diagError } from '@/lib/diagnostics';

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
  //
  // iOS TIMING FIX — setTimeout(0):
  // On iOS with New Architecture (Fabric/JSI), useEffects fire in the same
  // main-thread run-loop cycle as the React commit that mounts this screen.
  // If preventScreenCapture() runs at that moment it calls
  // keyWindow.layer.removeFromSuperlayer() before the first CATransaction for
  // the new screen has flushed → window layer reparented into UITextField's
  // off-screen CALayer → screen goes BLACK.
  // A single setTimeout(0) defers the call to the next run-loop iteration, by
  // which point the initial CATransaction has already flushed and the window
  // layer is properly registered with the display compositor.
  // Android: FLAG_SECURE sets a SurfaceView flag, never reparents the window
  // layer, and is not affected by this timing issue — behaviour unchanged.
  useEffect(() => {
    if (process.env.EXPO_OS === 'web') return;
    let cancelled = false;
    if (!blockCapture || isSuperAdmin) {
      // Release path is immediate — allowScreenCaptureAsync never reparents
      // the window layer so there is no compositor timing risk.
      diag('USE_SC', `SC_KEY allow (immediate)`, `blockCapture=${blockCapture} isSuperAdmin=${isSuperAdmin}`);
      ScreenCaptureLib.allowScreenCaptureAsync(SC_KEY)
        .then(() => diag('USE_SC', 'SC_KEY allowScreenCaptureAsync RESOLVED'))
        .catch((e) => diagError('ERR', 'SC_KEY allowScreenCaptureAsync FAILED', e));
      return;
    }

    diag('USE_SC', `SC_KEY prevent SCHEDULED setTimeout(0)`);
    const timer = setTimeout(() => {
      if (cancelled) return;
      diag('USE_SC', 'SC_KEY setTimeout(0) FIRED — calling preventScreenCaptureAsync');
      ScreenCaptureLib.preventScreenCaptureAsync(SC_KEY)
        .then(() => diag('USE_SC', 'SC_KEY preventScreenCaptureAsync RESOLVED'))
        .catch((e) => diagError('ERR', 'SC_KEY preventScreenCaptureAsync FAILED', e));
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      ScreenCaptureLib.allowScreenCaptureAsync(SC_KEY).catch(() => {});
    };
  }, [blockCapture, isSuperAdmin]);

  // Screenshot detection (addScreenshotListener — available in expo-screen-capture SDK55)
  // Super Admin bypass: do not install listener — SA is allowed to screenshot.
  useEffect(() => {
    if (process.env.EXPO_OS === 'web') return;
    if (isSuperAdmin) return;

    const subscription = ScreenCaptureLib.addScreenshotListener(() => {
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
