/**
 * SCREEN-CAPTURE WRAPPER — keyed ref-counting over expo-screen-capture.
 *
 * ─── WHY THIS EXISTS: the native restore-destroying defect ───────────────────
 *
 * expo-screen-capture's iOS implementation (ScreenCaptureModule.swift) works by
 * reparenting the key window's CALayer into a secure UITextField's private
 * off-screen layer:
 *
 *   preventScreenshots():
 *     originalParent  = keyWindow.layer.superlayer        // ← single saved slot
 *     keyWindow.layer.removeFromSuperlayer()
 *     superlayer.addSublayer(textField.layer)
 *     textField.layer.sublayers.first.addSublayer(keyWindow.layer)
 *
 *   allowScreenshots():
 *     window.layer.removeFromSuperlayer()
 *     originalParent.addSublayer(window.layer)            // ← restore from slot
 *
 * The module stores exactly ONE `originalParent`. Two hazards follow, and BOTH
 * are real code paths in this app:
 *
 *  1. CLOBBER (double prevent): a second preventScreenCaptureAsync() with a NEW
 *     key (JS tag set doesn't contain it → native preventScreenshots() re-runs)
 *     overwrites `originalParent` with the ALREADY-RE PARENTED window layer.
 *     Every later allowScreenshots() then re-parents the window INTO THE
 *     DETACHED TEXTFIELD LAYER — the window is stranded off-screen. The process
 *     keeps running, no crash, the display receives nothing: BLACK SCREEN.
 *
 *  2. STRAY RELEASE: allowScreenCaptureAsync() for a key that was never
 *     prevent()'ed (e.g. an unmount cleanup after an effect bailed, or a stale
 *     guard key) deletes the tag and — if it was the last — natively re-parents
 *     the window even though this owner never held protection. The upstream
 *     allowScreenshots() restores from whatever `originalParent` currently
 *     holds; if the native prevent never ran (or already restored), that restore
 *     is a no-op guard-fail upstream... unless a DIFFERENT key still holds
 *     protection, in which case the window is UNCONDITIONALLY restored and
 *     every remaining lock is silently destroyed.
 *
 * Upstream JS only de-dupes by key (activeTags); it does not serialize the
 * prevent/allow sequence. This wrapper adds the missing invariants:
 *
 *   • A native preventScreenshots() runs AT MOST ONCE while any lock is held —
 *     the first taker performs the reparent; everyone else just joins the set.
 *   • A native allowScreenshots() runs ONLY when the LAST lock is released AND
 *     that release corresponds to a native prevent that actually happened.
 *   • Releases for keys that never took a native lock are ignored (no stray
 *     restore), so an effect cleanup can never tear down another owner's lock.
 *   • All calls are serialized through an in-memory promise chain, so two
 *     effects resolving in the same tick can't interleave prevent/allow natively.
 *
 * The public surface mirrors expo-screen-capture 1:1 (same function names,
 * same key semantics, same 'default' key), so importing this module instead of
 * 'expo-screen-capture' is a drop-in change. addScreenshotListener and friends
 * are re-exported untouched — they never reparent the window layer.
 */

import {
  addScreenshotListener,
  removeScreenshotListener,
  useScreenshotListener,
  usePermissions,
  getPermissionsAsync,
  requestPermissionsAsync,
  isAvailableAsync,
  enableAppSwitcherProtectionAsync,
  disableAppSwitcherProtectionAsync,
  PermissionStatus,
} from 'expo-screen-capture';

import { useEffect } from 'react';
import * as Native from 'expo-screen-capture';

/** Keys whose taker has (or is awaiting) the native preventScreenshots() run. */
const nativeLocked = new Set<string>();
/** Every key currently handed out by this wrapper (JS-level accounting). */
const jsTags = new Set<string>();

/** Serializes native prevent/allow so calls can never interleave. */
let chain: Promise<void> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job, job);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

let warnedOnce = false;
function warnUnavailable(api: string) {
  if (!warnedOnce) {
    warnedOnce = true;
    console.warn(`[ScreenCaptureGuard] expo-screen-capture unavailable (${api}) — protection inactive.`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TEMPORARY SWITCH — SCREEN-CAPTURE (FLAG_SECURE) PROTECTION
//
//   true  → protection ACTIVE  (production default; restore this)
//   false → protection TEMPORARILY DISABLED: no FLAG_SECURE is ever applied,
//           no screenshot/recording detection or violation reporting runs.
//
// WHY IT LIVES HERE: every FLAG_SECURE activation in the app goes through
// `preventScreenCaptureAsync` in THIS module — the root layout ('root-shell'),
// the authenticated shell ((app)/_layout, 'app-shell'), the security gate
// ('security-gate'), the lesson screen ('lesson') and useScreenCapture
// ('screen-capture'). Each of them re-applies the flag on mount/focus/resume,
// so gating this one function is what actually prevents the flag from coming
// back; gating a call site would only hide it until the next re-apply.
//
// Re-enable by setting this to `true` (single line, no other change needed).
// ═══════════════════════════════════════════════════════════════════════════
export const SCREEN_CAPTURE_PROTECTION_ENABLED = false;

/** Read the switch from call sites that gate their own listeners/polling. */
export function isScreenCaptureProtectionEnabled(): boolean {
  return SCREEN_CAPTURE_PROTECTION_ENABLED;
}

// ═══ SCREEN-CAPTURE PROTECTION ═════════════════════════════════════════════
// The switch above is authoritative. The second, pre-existing escape hatch is
// the DEVELOPMENT-build opt-in used to capture on-device evidence with ADB
// `screencap`:
//
//     EXPO_PUBLIC_DISABLE_CAPTURE_PROTECTION=1     # .env.local, dev builds only
//
// Its `__DEV__` conjunct makes it UNREACHABLE from a release bundle: the
// release compiler folds `__DEV__` to `false`, so this half can never switch a
// shipped production release off on its own.
// ═══════════════════════════════════════════════════════════════════════════
const CAPTURE_PROTECTION_DISABLED =
  !SCREEN_CAPTURE_PROTECTION_ENABLED ||
  (typeof __DEV__ !== 'undefined' &&
    __DEV__ === true &&
    process.env.EXPO_PUBLIC_DISABLE_CAPTURE_PROTECTION === '1');

/**
 * Keyed prevent. The FIRST key to arrive while no native lock is held performs
 * the native reparent; later keys only join the accounting set. Resolves once
 * this key is durably registered (and the native lock, if it was the first,
 * has been applied).
 */
export async function preventScreenCaptureAsync(key = 'default'): Promise<void> {
  // Development-only opt-out (see the gate comment above). Always false in a
  // release bundle, so production always activates native FLAG_SECURE.
  if (CAPTURE_PROTECTION_DISABLED) return;
  if (jsTags.has(key)) return; // idempotent per key
  jsTags.add(key);
  const first = nativeLocked.size === 0;
  nativeLocked.add(key);
  if (!first) return; // native lock already held by an earlier key — nothing to do
  await enqueue(async () => {
    if (nativeLocked.size === 0) return; // released while we were queued
    try {
      await Native.preventScreenCaptureAsync(key);
    } catch (e) {
      nativeLocked.delete(key);
      warnUnavailable('preventScreenCaptureAsync');
      throw e;
    }
  });
}

/**
 * Keyed allow. Only the release of the LAST key that actually holds the native
 * lock triggers the native restore. Stray releases (key never locked natively)
 * are ignored — they can never tear down another owner's protection.
 */
export async function allowScreenCaptureAsync(key = 'default'): Promise<void> {
  // Development-only opt-out (see the gate comment above).
  if (CAPTURE_PROTECTION_DISABLED) {
    jsTags.delete(key);
    nativeLocked.delete(key);
    return;
  }
  jsTags.delete(key);
  if (!nativeLocked.has(key)) return; // stray release — never touched the native lock
  nativeLocked.delete(key);
  if (nativeLocked.size > 0) return; // another key still holds the native lock
  await enqueue(async () => {
    if (nativeLocked.size > 0) return; // a prevent arrived while we were queued
    try {
      await Native.allowScreenCaptureAsync(key);
    } catch (e) {
      warnUnavailable('allowScreenCaptureAsync');
      throw e;
    }
  });
}

/**
 * Same contract as upstream usePreventScreenCapture, routed through the guard
 * so hook-based call sites get the same clobber/stray-release protection.
 */
export function usePreventScreenCapture(key = 'default'): void {
  useEffect(() => {
    void preventScreenCaptureAsync(key);
    return () => {
      void allowScreenCaptureAsync(key);
    };
  }, [key]);
}

export {
  addScreenshotListener,
  removeScreenshotListener,
  useScreenshotListener,
  usePermissions,
  getPermissionsAsync,
  requestPermissionsAsync,
  isAvailableAsync,
  enableAppSwitcherProtectionAsync,
  disableAppSwitcherProtectionAsync,
  PermissionStatus,
};
export default Native;
