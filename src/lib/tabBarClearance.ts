/**
 * tabBarClearance — vertical space the ROLE TAB BAR occupies ON TOP OF the
 * safe-area bottom inset reported by react-native-safe-area-context.
 *
 * ANDROID / WEB (this file — iOS has its own `.ios.ts`, which Metro resolves
 * first on iOS).
 *
 *   ANDROID → the bar is now the FLOATING Liquid Glass pill (GlassTabBar),
 *     rendered as an ABSOLUTE OVERLAY outside the layout flow, exactly like the
 *     native bar on iOS: the screen keeps the full window height and the pill
 *     floats over its bottom edge so content is visible around and behind it.
 *     Because the screen no longer ends above the bar, the bar's own height has
 *     to be reserved here — otherwise the tail of every scrollable screen rests
 *     under the pill and can never be scrolled clear of it. The value is the
 *     pill height plus its float gap (no system inset — `safeBottom()` adds
 *     that separately), and it is identical in both orientations because the
 *     pill has one height.
 *
 *     SCOPED: this only applies when `inRoleTabs` is true, i.e. the caller is
 *     inside a role tab navigator (RoleTabChromeContext). Drawer/hub/report
 *     screens on Android have no bottom bar, so they must keep the exact bottom
 *     spacing they had before — reserving the pill there added 72 dp of dead
 *     space under them.
 *
 *   WEB → the SAME floating pill (Web Preview mounts GlassTabBar), so it
 *     overlays the page exactly like Android: the screen keeps the full height
 *     and its content scrolls behind the pill. The pill height must therefore
 *     be reserved here as well, otherwise the last rows of every scrollable
 *     screen sit under the pill and can never be scrolled clear of it. The
 *     navigator's own tab-bar slot is transparent and sets no height, so this
 *     is the only place the space is accounted for — never twice.
 *
 * See tabBarClearance.ios.ts for the iOS case (native bar floating over the RN
 * content) and the evidence behind its value. This module is never used on
 * iOS, which is why it does not branch on platform at all: the only branch that
 * matters is "is this screen inside a role tab navigator?".
 */

/** GlassTabBar's pill height (see GlassTabBar.tsx — kept in sync deliberately). */
export const GLASS_TAB_BAR_HEIGHT = 62;
/** Gap between the pill and the safe-area bottom edge. */
export const GLASS_TAB_BAR_GAP = 10;

export function tabBarClearance(_isLandscape = false, inRoleTabs = false): number {
  // Only screens that actually sit under the floating pill reserve its height.
  // (Drawer/hub/report screens have no bottom bar.) Android and Web both float.
  if (!inRoleTabs) return 0;
  return GLASS_TAB_BAR_HEIGHT + GLASS_TAB_BAR_GAP;
}
