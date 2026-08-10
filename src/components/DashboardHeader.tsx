/**
 * DashboardHeader — shared header for ALL role dashboards.
 *
 * Pixel-identical to PageHeader spacing via shared ds.ts tokens.
 *  • Same safe-area contract (safeTop / safeLeft / safeRight)
 *  • Same button edge position (safeArea.hEdge from safe-area edge)
 *  • Same button sizing (iconContainer.md)
 *  • Same gap between button and title (spacing.sm + spacing.xs)
 *  • Same vertical rhythm
 *
 * Layout:  [HamburgerButton]  [gap]  [roleLabel / greeting]  [rightActions]
 */
import React from 'react';
import { View, Text, useColorScheme } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { neuColors, useNeuSpacing } from '@/lib/neu';
import { spacing, typography, safeTop, safeLeft, safeRight } from '@/lib/ds';
import HamburgerButton from '@/components/HamburgerButton';

interface DashboardHeaderProps {
  /** Small label above the greeting, e.g. "Doctor Panel" */
  roleLabel?: string;
  /** Main greeting line, e.g. "Hi, Ahmed 👋" */
  greeting: string;
  /** Optional right-side content (bell, key icon, etc.) */
  rightActions?: React.ReactNode;
}

export function DashboardHeader({ roleLabel, greeting, rightActions }: DashboardHeaderProps) {
  const scheme  = useColorScheme();
  const isDark  = scheme === 'dark';
  const c       = isDark ? neuColors.dark : neuColors.light;
  const insets  = useSafeAreaInsets();
  const sp      = useNeuSpacing();

  const topPad   = safeTop(insets.top);
  const leftPad  = safeLeft(insets.left || 0, sp.isTablet);
  const rightPad = safeRight(insets.right || 0);

  return (
    <View style={{
      flexDirection: 'row',
      alignItems: 'center',
      paddingTop: topPad,
      paddingBottom: spacing.md,
      paddingLeft: leftPad,
      paddingRight: rightPad,
    }}>
      {/* Hamburger — sits at safeArea.hEdge from safe-area edge */}
      <HamburgerButton />

      {/* Title stack — gap from button */}
      <View style={{ flex: 1, marginLeft: spacing.sm + spacing.xs }}>
        {!!roleLabel && (
          <Text
            style={{
              ...typography.overline,
              color: c.text,
              opacity: 0.45,
            }}
            numberOfLines={1}
          >
            {roleLabel}
          </Text>
        )}
        <Text
          style={{
            fontSize: sp.isTablet ? typography.h1.fontSize : typography.h2.fontSize,
            fontWeight: '800',
            color: c.text,
            lineHeight: sp.isTablet ? typography.h1.lineHeight : typography.h2.lineHeight,
            marginTop: roleLabel ? 1 : 0,
          }}
          numberOfLines={1}
        >
          {greeting}
        </Text>
      </View>

      {/* Right actions */}
      {!!rightActions && (
        <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center', marginLeft: spacing.sm }}>
          {rightActions}
        </View>
      )}
    </View>
  );
}

