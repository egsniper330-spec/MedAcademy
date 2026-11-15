/**
 * RoleTabShell — WEB / other platforms (Web Preview uses this file).
 *
 * This file is a thin PLATFORM WRAPPER: it supplies the floating Liquid Glass
 * bar and the glass navigator options to the shared shell. All
 * navigator/provider/tab-mapping logic lives in `RoleTabShellBase.tsx` — one
 * copy for every platform (see the header there for the full rationale).
 *
 * Platform resolution is BY FILE, never by a runtime branch:
 *
 *     android   → RoleTabShell.android.tsx   (GlassTabBar)
 *     ios       → RoleTabShell.ios.tsx       (native system bar, untouched)
 *     web       → RoleTabShell.tsx           (this file — GlassTabBar)
 *
 * WHY WEB NOW RENDERS THE SAME COMPONENT (not a mock-up)
 * ──────────────────────────────────────────────────────
 * The Liquid Glass pill is the design being reviewed, and it used to be visible
 * only in a native Android build: web rendered the older in-flow neu bar, so
 * every visual adjustment to the pill cost a full native build. Web now mounts
 * the REAL `GlassTabBar` — the same file, the same constants, the same
 * PanResponder and the same shared indicator — so the preview is a faithful
 * preview and design work needs no rebuild.
 *
 * The bar adapts itself per platform internally (browser `backdrop-filter`
 * blur instead of the native blur method); nothing here fakes its appearance.
 *
 * This file must never import `ResponsiveTabBar`, and the shared base must never
 * import either bar. `tests/androidGlassTabBar.test.cjs` enforces both, so the
 * obsolete bar cannot come back on any platform by accident.
 */
import React, { useCallback } from 'react';
import { useColorScheme } from 'react-native';
import GlassTabBar from '@/components/navigation/GlassTabBar';
import RoleTabShellBase, { type RoleTabShellProps } from '@/components/navigation/RoleTabShellBase';
import { GLASS_TAB_BAR_SCREEN_OPTIONS } from '@/components/navigation/glassTabBarOptions';
import { neuColors } from '@/lib/neu';

/** Constant label style: keeps the bar's props referentially stable. */
const LABEL_STYLE = { fontSize: 10, fontWeight: '700' as const, letterSpacing: 0.2, marginTop: 2 };

export default function RoleTabShell({ tabs, initialRouteName, jsIconShrink }: RoleTabShellProps) {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  /**
   * Stable bar renderer: React Navigation calls it on every navigator render.
   * A stable identity means the glass bar is re-rendered — never remounted —
   * when the shell re-renders (theme, locale, profile store), so the indicator
   * position and any in-progress drag survive.
   */
  const renderTabBar = useCallback(
    (props: any) => (
      <GlassTabBar
        {...props}
        activeTintColor={c.primary}
        inactiveTintColor={`${c.text}${isDark ? '99' : '44'}`}
        labelStyle={LABEL_STYLE}
      />
    ),
    [c.primary, c.text, isDark],
  );

  return (
    <RoleTabShellBase
      tabs={tabs}
      initialRouteName={initialRouteName}
      jsIconShrink={jsIconShrink}
      renderTabBar={renderTabBar}
      screenOptions={GLASS_TAB_BAR_SCREEN_OPTIONS}
    />
  );
}
