/**
 * fullscreenOrientation.ts
 *
 * Early orientation request for Android video fullscreen.
 *
 * ── The latency this removes (Plyr fullscreen "too slow") ────────────────────
 * Every player enters fullscreen in this order:
 *
 *   1. the user taps the fullscreen control,
 *   2. the SECURITY GATE is awaited — `checkBeforeVideo()` →
 *      `runSecurityChecks()`, which runs 14 detectors in parallel including the
 *      NETWORK-bound ones (Play Integrity: backend nonce → Google → backend
 *      verify) plus the server policy fetch. Each is bounded by
 *      DETECTOR_TIMEOUT_MS, so on a real device this legitimately takes
 *      hundreds of milliseconds,
 *   3. only THEN does `isFullscreen` flip and the orientation effect run
 *      `lockAsync(LANDSCAPE)`.
 *
 * Because the rotation was requested at step 3, the two delays were SERIAL: the
 * user pressed fullscreen, and then waited for (security verdict) + (OS rotation
 * animation) before the landscape fullscreen actually appeared.
 *
 * This module only changes the ORDER. The rotation is requested as soon as the
 * fullscreen action arrives, so the OS rotation animation overlaps the security
 * evaluation instead of following it. Nothing about the verdict changes: the
 * player still waits for the gate before committing fullscreen, and a denial
 * calls `releaseFullscreenOrientation()` to roll the rotation back.
 *
 * ── Why this is safe ────────────────────────────────────────────────────────
 * • Android-only. On iOS the app NEVER touches the orientation API (see the
 *   player headers): fullscreen keeps the user's current orientation and the
 *   system Rotation Lock is never overridden. This is a no-op there.
 * • Idempotent: locking to the same target twice is a no-op, so the existing
 *   `isFullscreen` effects stay the steady-state owner of the lock/unlock and
 *   need no change.
 * • Fail-safe: every call is fire-and-forget and swallows platform errors, so a
 *   device that refuses the lock can never stall or crash the transition.
 * • Never strands the screen: the exit path (the effect cleanup) always restores
 *   PORTRAIT_UP, and the denial path restores it immediately.
 */

import { Platform } from 'react-native';
import * as ScreenOrientation from 'expo-screen-orientation';

/** Request landscape NOW so the rotation overlaps the security evaluation. */
export function beginFullscreenOrientation(): void {
  if (Platform.OS !== 'android') return;
  void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
}

/**
 * Roll the early rotation back — used when the security gate refuses fullscreen
 * so a blocked request never leaves the device stuck in landscape.
 */
export function releaseFullscreenOrientation(): void {
  if (Platform.OS !== 'android') return;
  void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
}
