/**
 * roleTabChrome — "is this screen inside a role tab layout?"
 *
 * WHY: the Android floating glass tab bar overlays content (like the native iOS
 * bar), so the bar's height has to be reserved in the screen's bottom padding.
 * But `useLayout()` is app-wide, and most Android screens are NOT tab screens —
 * drawer entries, hub panels, reports, CMS, diagnostics. Reserving the bar there
 * produced 72 dp of dead space under screens that have no bottom bar at all.
 *
 * This context is the switch: `RoleTabShell` (the JS tab shell that renders the
 * bar) provides `true` for everything inside its navigator; every other screen
 * falls back to `false` and keeps its previous spacing.
 *
 * Platform notes:
 *   • iOS never renders `RoleTabShell.tsx` (`.ios.tsx` wins), so the provider is
 *     absent there and the flag stays `false`. iOS clearance keeps its own,
 *     unchanged global behaviour (see tabBarClearance.ios.ts, which ignores this
 *     flag on purpose).
 *   • Web renders the SAME floating pill as Android (Web Preview mounts
 *     GlassTabBar), so `useLayout()` reserves the pill height there too and the
 *     flag is meaningful on both platforms. It stays false on iOS, which keeps
 *     its own clearance rule (tabBarClearance.ios.ts).
 */
import { createContext, useContext } from 'react';

/** True only inside a role tab navigator that draws a floating bar. */
export const RoleTabChromeContext = createContext(false);

export function useRoleTabChrome(): boolean {
  return useContext(RoleTabChromeContext);
}
