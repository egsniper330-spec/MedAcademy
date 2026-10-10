/**
 * iOS build of tabBarClearance (file resolution: `.ios.ts` wins on iOS, so this
 * is what `useLayout()` gets on iPhone/iPad).
 *
 * ── ROOT CAUSE this exists for ───────────────────────────────────────────────
 * The iOS role shell uses the REAL native tab bar (react-native-bottom-tabs →
 * UITabBar / SwiftUI TabView, rendered as a floating Liquid Glass bar on
 * iOS 26). A native tab bar is laid out by UIKit OUTSIDE the React Native view
 * hierarchy: the screen's RN view keeps the full window height and the bar
 * floats over its bottom edge — that is also how iOS 26 derives the glass
 * material, from the content scrolling BEHIND the bar. Two consequences:
 *
 *   1. `useSafeAreaInsets()` measures the window, so it reports only the home
 *      indicator (~34 pt) and never the bar itself.
 *   2. react-native-bottom-tabs cannot tell us either: its internal
 *      `tabBarHeight` state starts at 0 and is only populated when a CUSTOM JS
 *      tab bar is measured (`renderCustomTabBar` + `measure()`), so its
 *      `useBottomTabBarHeight()` returns 0 for the default native bar.
 *
 * Result: every iOS screen stopped short of the bar. The tail of the content sat
 * UNDER it, which is why it could be rubber-banded into view and then snapped
 * straight back — the scrollable extent never included the obscured strip
 * (bounce, not scroll).
 *
 * ── The values (UIKit's own constants, not arbitrary padding) ────────────────
 *   • Classic UITabBar: 49 pt portrait, 32 pt in compact-height landscape.
 *   • iOS 26 floating (Liquid Glass) bar: a taller capsule inset from the
 *     screen edge — 56 pt portrait, 44 pt landscape reserved height.
 * The caller (`safeBottom`) adds the home-indicator inset separately, so these
 * are the bar's OWN height only — no double counting.
 *
 * Dependency note: caller-relative, no native module import — this stays a pure
 * constant lookup so it is safe in the web/Android bundle graph too (they
 * resolve the sibling implementation).
 */
import { Platform } from 'react-native';

const IOS_MAJOR = (() => {
  const n = parseInt(String(Platform.Version ?? '').split('.')[0], 10);
  return Number.isFinite(n) ? n : 0;
})();

/** iOS 26 introduced the floating Liquid Glass tab bar. */
export const LIQUID_GLASS_TAB_BAR = IOS_MAJOR >= 26;

export const TAB_BAR_CLASSIC_PORTRAIT = 49;
export const TAB_BAR_CLASSIC_LANDSCAPE = 32;
export const TAB_BAR_LIQUID_PORTRAIT = 56;
export const TAB_BAR_LIQUID_LANDSCAPE = 44;

export function tabBarClearance(isLandscape = false): number {
  if (LIQUID_GLASS_TAB_BAR) {
    return isLandscape ? TAB_BAR_LIQUID_LANDSCAPE : TAB_BAR_LIQUID_PORTRAIT;
  }
  return isLandscape ? TAB_BAR_CLASSIC_LANDSCAPE : TAB_BAR_CLASSIC_PORTRAIT;
}
