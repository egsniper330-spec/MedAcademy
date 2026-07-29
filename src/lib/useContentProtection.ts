/**
 * useContentProtection
 *
 * Cross-platform content protection for protected lesson screens:
 *   Android: FLAG_SECURE (blocks screenshots + screen recording, hides from recents)
 *            + native SecurityModule polling for active MediaProjection/recording
 *              → immediate pause callback + block overlay + violation report
 *   iOS:     addScreenshotListener → blur overlay + strike
 *            isRecordingAsync poll (500 ms) → block overlay + strike
 *
 * onPauseVideo: called immediately when recording is detected on Android.
 *               The lesson screen passes its pause handler here so the video
 *               stops before the overlay appears.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '@/client/supabase';
import { getInstallationId } from '@/lib/installationId';
import {
  isNativeScreenBeingRecorded,
  onScreenRecordingStarted,
  onScreenRecordingStopped,
  onNativeScreenshotTaken,
} from '@/lib/nativeSecurity';

export type ViolationAction = 'warning' | 'logout' | 'suspend' | 'ban';

export interface ContentProtectionState {
  /** iOS only: screenshot was just detected, show blur + ack modal */
  screenshotDetected: boolean;
  /** Active screen recording detected (iOS poll or Android native) */
  recordingActive: boolean;
  /** Action returned by the server for the latest violation */
  lastAction: ViolationAction | null;
  /** Server-side warning message for the modal */
  warningMessage: string;
  /** Current strike count from server response */
  strikeCount: number;
  /** Acknowledge screenshot warning (clears blur) */
  acknowledgeScreenshot: () => void;
}

const DEFAULT_WARNING =
  'Screenshots of protected educational content are prohibited. ' +
  'Repeated violations may result in temporary account suspension.';

export function useContentProtection(
  enabled: boolean,
  /** Optional: called immediately when recording starts — use to pause video */
  onPauseVideo?: () => void,
): ContentProtectionState {
  const [screenshotDetected, setScreenshotDetected] = useState(false);
  const [recordingActive, setRecordingActive]       = useState(false);
  const [lastAction, setLastAction]                 = useState<ViolationAction | null>(null);
  const [warningMessage, setWarningMessage]         = useState(DEFAULT_WARNING);
  const [strikeCount, setStrikeCount]               = useState(0);
  const recordingPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMounted = useRef(true);

  // ── Fetch policy warning message once ─────────────────────────────────────
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('content_protection_policies')
        .select('warning_message')
        .eq('id', '00000000-0000-0000-0000-000000000001')
        .maybeSingle();
      if (data?.warning_message && isMounted.current) {
        setWarningMessage(data.warning_message);
      }
    })();
    return () => { isMounted.current = false; };
  }, []);

  // ── Report a violation to the Edge Function ───────────────────────────────
  const reportViolation = useCallback(async (
    type: 'screenshot_detected' | 'screen_recording_detected',
  ) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const installId = await getInstallationId();
      const platform  = process.env.EXPO_OS ?? 'unknown';

      const { data, error } = await supabase.functions.invoke('process-violation', {
        body: {
          user_id:          user.id,
          violation_type:   type,
          platform,
          installation_id:  installId,
        },
      });
      if (error) {
        // Never log error.context in production — it may contain server response bodies
        if (__DEV__) {
          const msg = await error?.context?.text?.();
          console.warn('[ContentProtection] process-violation error:', msg ?? error.message);
        }
        return;
      }
      if (!isMounted.current) return;
      setLastAction((data as { action: ViolationAction }).action ?? 'warning');
      setStrikeCount((data as { strike_count: number }).strike_count ?? 0);

      // If server says logout or suspend, sign out locally.
      // IMPORTANT: only apply content-protection violations to 'student' role.
      // Doctors, Admins and Super Admins can view lesson content legitimately
      // (previewing courses, quality checks, etc.) and must never be penalised
      // for screenshots or recordings they take in their administrative capacity.
      // The server now returns action='exempt' for non-students and never
      // increments their strike count, so this guard is a belt-and-suspenders
      // defence in case an older server version is deployed.
      const action     = (data as { action: string }).action;
      const serverRole = (data as { role?: string }).role ?? 'student';
      if (action === 'exempt' || serverRole !== 'student') {
        if (__DEV__) console.log(`[ContentProtection] violation exempt for role="${serverRole}" — no penalty applied`);
        return;
      }
      if (action === 'logout' || action === 'suspend' || action === 'ban') {
        await supabase.auth.signOut({ scope: 'global' });
      }
    } catch (err) {
      if (__DEV__) console.warn('[ContentProtection] reportViolation:', err);
    }
  }, []);

  // ── Android: activate FLAG_SECURE ─────────────────────────────────────────
  useEffect(() => {
    if (!enabled || process.env.EXPO_OS === 'web') return;
    if (process.env.EXPO_OS !== 'android') return;

    let cleanup: (() => void) | undefined;
    (async () => {
      try {
        const SC = await import('expo-screen-capture');
        await SC.preventScreenCaptureAsync('lesson');
        cleanup = () => { SC.allowScreenCaptureAsync('lesson').catch(() => {}); };
      } catch (e) {
        if (__DEV__) console.warn('[ContentProtection] FLAG_SECURE activate:', e);
      }
    })();

    return () => { cleanup?.(); };
  }, [enabled]);

  // ── Android: native screen-recording detection ─────────────────────────────
  // Two-layer detection on Android:
  //   1. NativeEventEmitter events (push): fired by SecurityModule polling thread
  //   2. JS-side poll (500 ms fallback):   in case the native emitter is not yet
  //      wired up (e.g. first install before first EAS prebuild runs)
  // When recording starts → pause video immediately + show overlay + report.
  useEffect(() => {
    if (!enabled || process.env.EXPO_OS !== 'android') return;

    let alreadyReported = false;

    const handleStart = () => {
      if (!isMounted.current) return;
      onPauseVideo?.();           // pause video before overlay appears
      setRecordingActive(true);
      if (!alreadyReported) {
        alreadyReported = true;
        void reportViolation('screen_recording_detected');
      }
    };

    const handleStop = () => {
      if (!isMounted.current) return;
      alreadyReported = false;
      setRecordingActive(false);
    };

    // Layer 1: subscribe to NativeEventEmitter push events
    const unsubStart = onScreenRecordingStarted(handleStart);
    const unsubStop  = onScreenRecordingStopped(handleStop);

    // Layer 2: JS-side fallback poll (500 ms)
    recordingPollRef.current = setInterval(async () => {
      try {
        const recording = await isNativeScreenBeingRecorded();
        if (!isMounted.current) return;
        if (recording && !alreadyReported) {
          handleStart();
        } else if (!recording && alreadyReported) {
          handleStop();
        }
      } catch { /* non-fatal */ }
    }, 500);

    return () => {
      unsubStart();
      unsubStop();
      if (recordingPollRef.current) clearInterval(recordingPollRef.current);
    };
  // reportViolation and onPauseVideo are stable callbacks (useCallback / inline)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // ── iOS screenshot detection ───────────────────────────────────────────────
  // Layer 1: IOSSecurityModule NativeEventEmitter (iOSScreenshotTaken)
  //          Fires from UIApplication.userDidTakeScreenshotNotification — instant.
  // Layer 2: expo-screen-capture addScreenshotListener (fallback for Expo Go / older builds)
  useEffect(() => {
    if (!enabled || process.env.EXPO_OS !== 'ios') return;

    // Layer 1: native module emitter (preferred — faster, no JS thread polling)
    const unsubNative = onNativeScreenshotTaken(async () => {
      if (!isMounted.current) return;
      setScreenshotDetected(true);
      await reportViolation('screenshot_detected');
    });

    // Layer 2: expo-screen-capture fallback (handles Expo Go where native module is absent)
    let expoSub: { remove: () => void } | null = null;
    (async () => {
      try {
        const SC = await import('expo-screen-capture');
        expoSub = SC.addScreenshotListener(async () => {
          if (!isMounted.current) return;
          setScreenshotDetected(true);
          await reportViolation('screenshot_detected');
        });
      } catch (e) {
        if (__DEV__) console.warn('Screenshot listener (expo fallback):', e);
      }
    })();

    return () => {
      unsubNative();
      expoSub?.remove();
    };
  }, [enabled, reportViolation]);

  // ── iOS screen recording detection ────────────────────────────────────────
  // Layer 1: IOSSecurityModule NativeEventEmitter push events
  //          iOSScreenRecordingStarted / iOSScreenRecordingStopped
  //          Fired by UIScreen.capturedDidChangeNotification + 0.5s timer in Swift.
  // Layer 2: JS-side poll via isNativeScreenBeingRecorded() (500 ms fallback)
  //          Handles Expo Go and first-install before prebuild runs.
  useEffect(() => {
    if (!enabled || process.env.EXPO_OS !== 'ios') return;

    let alreadyReported = false;

    const handleStart = async () => {
      if (!isMounted.current) return;
      onPauseVideo?.();
      setRecordingActive(true);
      if (!alreadyReported) {
        alreadyReported = true;
        await reportViolation('screen_recording_detected');
      }
    };

    const handleStop = () => {
      if (!isMounted.current) return;
      alreadyReported = false;
      setRecordingActive(false);
    };

    // Layer 1: subscribe to IOSSecurityModule NativeEventEmitter push events
    // onScreenRecordingStarted/Stopped now routes to iOSScreenRecordingStarted/Stopped on iOS
    const unsubStart = onScreenRecordingStarted(() => { void handleStart(); });
    const unsubStop  = onScreenRecordingStopped(handleStop);

    // Layer 2: JS-side fallback poll (500 ms) via IOSSecurityModule isScreenBeingRecorded
    recordingPollRef.current = setInterval(async () => {
      try {
        const recording = await isNativeScreenBeingRecorded();
        if (!isMounted.current) return;
        if (recording && !alreadyReported) {
          void handleStart();
        } else if (!recording && alreadyReported) {
          handleStop();
        }
      } catch { /* non-fatal */ }
    }, 500);

    return () => {
      unsubStart();
      unsubStop();
      if (recordingPollRef.current) clearInterval(recordingPollRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const acknowledgeScreenshot = useCallback(() => {
    setScreenshotDetected(false);
  }, []);

  return {
    screenshotDetected,
    recordingActive,
    lastAction,
    warningMessage,
    strikeCount,
    acknowledgeScreenshot,
  };
}
