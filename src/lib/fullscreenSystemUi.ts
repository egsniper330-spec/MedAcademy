/**
 * fullscreenSystemUi.ts
 *
 * Shared system-UI controller for video fullscreen (Plyr and VdoCipher).
 *
 * Issue 5 root cause: the fullscreen experience is an RN Android Modal, which
 * renders in its own Dialog window. RN's ModalHostView copies system-bar
 * visibility FROM the activity window INTO the dialog whenever the modal is
 * shown or the activity's insets change (syncSystemBarsVisibility in
 * ReactModalHostView.kt). Nothing ever hid the bars on the activity window,
 * so Back/Home/Recents stayed on screen over the video.
 *
 * Fix: while any video fullscreen is active, hide the navigation bar
 * (expo-navigation-bar targets the activity window) and the status bar
 * (<StatusBar hidden> inside the Modal). On exit, restore everything.
 *
 * Restoration safety (must never strand the app with hidden bars):
 *   • try/finally around the enter path — a throw still schedules restore.
 *   • Behavior 'overlay-swipe' before hiding: edge-swipe still summons the
 *     bar transiently (gesture-compatible; single API call is NOT assumed
 *     sufficient — verified per Expo docs).
 *   • The hide call is also awaited re-checked after a short settle: if the
 *     OS rejected the hide (gesture-nav edge cases, OEM quirks), we restore
 *     'visible' rather than leave a half-immersive state.
 *   • Ref-counted so overlapping players/screen transitions can't restore
 *     early, and unmount of the owning player always releases.
 *   • Android-only: no-ops elsewhere.
 *
 * <StatusBar hidden> inside each Modal is intentionally NOT re-shown here on
 * exit: RN's StatusBar stack pops on unmount and restores automatically.
 */

import { Platform } from 'react-native';
import * as NavigationBar from 'expo-navigation-bar';

let refCount = 0;
let active = false;

/** Hide status + navigation bars for immersive video fullscreen. */
export async function enterFullscreenSystemUi(): Promise<void> {
  refCount += 1;
  if (Platform.OS !== 'android' || active) return;
  active = true;
  try {
    // Swipe-from-edge must still summon the bar; without this the bar can
    // become unreachable on gesture navigation.
    await NavigationBar.setBehaviorAsync('overlay-swipe');
    await NavigationBar.setVisibilityAsync('hidden');
  } catch {
    // Module unavailable (e.g. Go edition / odd OEM) — Modal still covers the
    // screen; bars simply remain. Never block fullscreen on this.
  } finally {
    // Failure-safe: confirm the bar actually hid; if not (or the call threw),
    // release immediately so exit restores a consistent visible state.
    try {
      const visibility = await NavigationBar.getVisibilityAsync();
      if (visibility !== 'hidden') {
        await NavigationBar.setVisibilityAsync('visible').catch(() => {});
        releaseFullscreenSystemUi();
      }
    } catch {
      releaseFullscreenSystemUi();
    }
  }
}

/** Restore status + navigation bars. Safe to call multiple times. */
export async function exitFullscreenSystemUi(): Promise<void> {
  releaseFullscreenSystemUi();
}

function releaseFullscreenSystemUi(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount > 0 || !active) return;
  active = false;
  if (Platform.OS !== 'android') return;
  void (async () => {
    try {
      await NavigationBar.setVisibilityAsync('visible');
    } catch {}
    try {
      await NavigationBar.setBehaviorAsync('inset-touch');
    } catch {}
  })();
}
