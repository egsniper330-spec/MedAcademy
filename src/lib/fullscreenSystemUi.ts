/**
 * fullscreenSystemUi.ts
 *
 * Shared system-UI controller for video fullscreen (Plyr and VdoCipher).
 *
 * Issue 5 (original): the fullscreen experience is an RN Android Modal, which
 * renders in its own Dialog window. RN's ModalHostView copies system-bar
 * visibility FROM the activity window INTO the dialog whenever the modal is
 * shown or the activity's insets change (syncSystemBarsVisibility in
 * ReactModalHostView.kt). Nothing ever hid the bars on the activity window,
 * so Back/Home/Recents stayed on screen over the video.
 *
 * ── BUG FIXED THIS ROUND (white navigation strip in fullscreen) ──────────────
 * The hide DID run — `NavigationBar.setVisibilityAsync('hidden')` maps to
 * `WindowInsetsControllerCompat.hide(navigationBars())` on the activity window,
 * which is the correct edge-to-edge API. But the verification step read the
 * state back *immediately*:
 *
 *     await setVisibilityAsync('hidden');
 *     const visibility = await getVisibilityAsync();   // ← too early
 *     if (visibility !== 'hidden') setVisibilityAsync('visible');   // ← undo!
 *
 * `getVisibilityAsync()` is
 * `window.decorView.rootWindowInsets.isVisible(navigationBars())` and the
 * hide is an ANIMATED insets change (verified on the device:
 * `NavigationBar0 ... mAnimationType=insets_animation`). The read therefore
 * still reported 'visible', and the code explicitly re-showed the bar and
 * released — for the whole fullscreen session. Measured on the physical tablet
 * (SM-T505N, landscape fullscreen): the bottom 40px were a single uniform
 * colour rgb(232,238,246) at 100% share (the OS navigation bar) while the top
 * strip showed video (status bar correctly hidden), and the activity's
 * appBounds stayed [0,0][2000,1128] — 72px never handed to the app.
 *
 * Fix: hide → verify with a BOUNDED RETRY (the insets animation settles within
 * a few frames). If a retry reports 'hidden', we are done. If every attempt
 * fails we simply leave the bar visible — we NEVER force an exit-hide back to
 * 'visible' from a timing artefact.
 *
 * Also fixed: `setBehaviorAsync` is a deprecated no-op under edge-to-edge (it
 * only warns), but it sat BEFORE the hide on the same await chain — a future
 * version that rejects would have skipped the hide entirely. It is now
 * isolated in its own try/catch so it can never short-circuit the hide.
 *
 * Re-assert across rotation: a configuration change can transiently re-show
 * the bars, so while active the controller re-hides on every Dimensions change
 * (rotation). This lives here rather than in each player so all three players
 * (Plyr/YouTube, VdoCipher, offline) get it with no call-site changes.
 *
 * Restoration safety (must never strand the app with hidden bars):
 *   • Ref-counted so overlapping players/screen transitions can't restore
 *     early, and unmount of the owning player always releases.
 *   • Every exit path sets visibility back to 'visible'.
 *   • Android-only: no-ops elsewhere.
 *
 * <StatusBar hidden> inside each player is intentionally NOT re-shown here on
 * exit: RN's StatusBar stack pops on unmount and restores automatically.
 */

import { Dimensions, Platform } from 'react-native';
import * as NavigationBar from 'expo-navigation-bar';

let refCount = 0;
let active = false;
let dimsSubscription: { remove: () => void } | null = null;

/** Bounded retries: the insets hide is animated, so an immediate read lies. */
const HIDE_ATTEMPTS = 6;
const HIDE_SETTLE_MS = 110;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Hide the navigation bar and confirm it with a bounded retry.
 * Returns true when the platform reports the bar hidden.
 */
async function hideNavigationBar(): Promise<boolean> {
  // Deprecated + a no-op under edge-to-edge. Isolated so a rejecting
  // implementation can never prevent the hide below (the original bug).
  try {
    await NavigationBar.setBehaviorAsync('overlay-swipe');
  } catch {
    /* no-op under edge-to-edge */
  }

  for (let attempt = 0; attempt < HIDE_ATTEMPTS; attempt += 1) {
    try {
      await NavigationBar.setVisibilityAsync('hidden');
    } catch {
      return false; // module unavailable (odd OEM / Go edition)
    }
    try {
      if ((await NavigationBar.getVisibilityAsync()) === 'hidden') return true;
    } catch {
      return false;
    }
    // Still mid-animation — let it settle and try once more.
    await delay(HIDE_SETTLE_MS);
  }
  // Could not hide. Leave the bar VISIBLE — a consistent state — rather than
  // forcing anything. Fullscreen still works; the OS simply keeps its bar.
  return false;
}

function startReassertOnRotation(): void {
  if (dimsSubscription) return;
  try {
    dimsSubscription = Dimensions.addEventListener('change', () => {
      if (!active) return;
      void hideNavigationBar();
    });
  } catch {
    dimsSubscription = null;
  }
}

function stopReassertOnRotation(): void {
  try {
    dimsSubscription?.remove();
  } catch {
    /* ignore */
  }
  dimsSubscription = null;
}

/** Hide the status + navigation bars for immersive video fullscreen. */
export async function enterFullscreenSystemUi(): Promise<void> {
  refCount += 1;
  if (Platform.OS !== 'android' || active) return;
  active = true;
  startReassertOnRotation();
  try {
    await hideNavigationBar();
  } catch {
    // Never block fullscreen on system-UI control.
  }
}

/**
 * Re-assert the hidden bars while fullscreen is active (e.g. after an
 * orientation change initiated by the OS rather than by us).
 * No ref-count change; safe to call repeatedly.
 */
export async function reassertFullscreenSystemUi(): Promise<void> {
  if (Platform.OS !== 'android' || !active) return;
  try {
    await hideNavigationBar();
  } catch {
    /* ignore */
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
  stopReassertOnRotation();
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
