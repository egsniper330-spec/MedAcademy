/**
 * glassTabBarOptions — the navigator options that go with GlassTabBar.
 *
 * ONE definition for every platform that renders the floating pill (Android and
 * Web Preview). The navigator still computes a default tab-bar height and paints
 * `tabBarStyle` behind whatever wraps the custom bar; any background arriving
 * through that path (theme surface colour, a border, an elevation shadow) shows
 * up as a full-width opaque band around and under the pill. Pinning the wrapper
 * to transparent with no border/elevation/shadow removes that path entirely.
 *
 * No `height` is set on purpose: the height would drive the navigator's reserved
 * space, and the floating bar must not reserve any. The space the pill actually
 * covers is accounted for once, in `lib/tabBarClearance.ts`, so screens can
 * scroll clear of it.
 *
 * Module scope: the same object on every render, so the navigator never sees new
 * options because an unrelated component re-rendered.
 */
export const GLASS_TAB_BAR_SCREEN_OPTIONS: Record<string, unknown> = {
  headerShown: false,
  tabBarStyle: {
    backgroundColor: 'transparent',
    borderTopWidth: 0,
    borderTopColor: 'transparent',
    elevation: 0,
    shadowOpacity: 0,
    shadowColor: 'transparent',
  },
};
