/**
 * tabBarClearance — vertical space the ROLE TAB BAR occupies ON TOP OF the
 * safe-area bottom inset reported by react-native-safe-area-context.
 *
 * ANDROID / WEB (this file — iOS has its own `.ios.ts`, which Metro resolves
 * first on iOS):
 *   The bottom bar is the JS `ResponsiveTabBar`, rendered by the tab navigator
 *   IN THE LAYOUT FLOW. The screen's viewport already ends above it, so the
 *   correct extra clearance is ZERO. Adding the bar's height here would reserve
 *   the space TWICE and leave a dead gap under the last card — the reason this
 *   returns 0 instead of mirroring the iOS value.
 *
 * See tabBarClearance.ios.ts for the iOS case (native bar floating over the RN
 * content) and the evidence behind its value.
 */
export function tabBarClearance(_isLandscape = false): number {
  return 0;
}
