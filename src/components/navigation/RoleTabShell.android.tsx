/**
 * RoleTabShell — ANDROID (THE authoritative Android bottom navigation).
 *
 * This file is now a thin PLATFORM WRAPPER: it supplies the floating Liquid
 * Glass bar and the Android-only navigator options to the shared shell. All
 * navigator/provider/tab-mapping logic lives in `RoleTabShellBase.tsx` — one
 * copy for every platform (see the header there for the full rationale).
 *
 * Platform resolution is BY FILE, never by a runtime branch:
 *
 *     android   → RoleTabShell.android.tsx   (this file — GlassTabBar)
 *     ios       → RoleTabShell.ios.tsx       (native system bar, untouched)
 *     web       → RoleTabShell.tsx           (the SAME GlassTabBar, so the
 *                                            preview shows the real pill)
 *
 * Why that distinction matters (root cause of the "new bar disappears, old bar
 * returns" defect): an earlier version chose the bar with
 * `Platform.OS === 'android' ? <GlassTabBar/> : <ResponsiveTabBar/>` inside a
 * single shared file. Both bars were bundled into the Android app and the visible
 * navigation depended on a runtime read, so any surface with an unexpected
 * platform signal rendered the obsolete bar. Resolving by module graph makes the
 * old bar unreachable on Android: `ResponsiveTabBar` is not imported here, so it
 * is not even in the Android bundle.
 *
 * This file must never import ResponsiveTabBar, and the shared base must never
 * import either bar. `tests/androidGlassTabBar.test.cjs` enforces both.
 */
import React, { useCallback } from 'react';
import { useColorScheme } from 'react-native';
import GlassTabBar from '@/components/navigation/GlassTabBar';
import RoleTabShellBase, { type RoleTabShellProps } from '@/components/navigation/RoleTabShellBase';
import { GLASS_TAB_BAR_SCREEN_OPTIONS } from '@/components/navigation/glassTabBarOptions';
import { neuColors } from '@/lib/neu';

/** Constant label style: keeps the bar's props referentially stable. */
const LABEL_STYLE = { fontSize: 10, fontWeight: '700' as const, letterSpacing: 0.2, marginTop: 2 };

// The navigator options that keep the wrapper transparent live in ONE place
// (`glassTabBarOptions.ts`), shared verbatim with the web wrapper: the values
// are identical to the ones Android shipped with, so this is a move, not a
// behaviour change.

export default function RoleTabShell({ tabs, initialRouteName, jsIconShrink }: RoleTabShellProps) {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  /**
   * One stable bar renderer: React Navigation calls this on every navigator
   * render, and a stable identity means the glass bar is re-rendered — never
   * unmounted/remounted — when the shell re-renders (theme, locale, profile
   * store updates). A remount would reset the indicator position and the drag
   * state, which looked like the bar "disappearing and coming back".
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
