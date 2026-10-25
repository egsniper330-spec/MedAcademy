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
import { neuColors, mutedTextStyle, useNeuSpacing } from '@/lib/neu';
import { spacing, typography, safeTop, safeLeft, safeRight } from '@/lib/ds';
import HamburgerButton from '@/components/HamburgerButton';
import { useTranslation } from '@/lib/i18n';

interface DashboardHeaderProps {
  /** Small label above the greeting, e.g. "Doctor Panel" */
  roleLabel?: string;
  /** Main greeting line, e.g. "Hi, Ahmed 👋" */
  greeting: string;
  /**
   * Account name rendered as the SECOND line under the greeting.
   *
   * This is DATA, not UI copy: it is the authenticated profile's own display
   * name and must never be translated, transliterated or replaced by a role
   * label. It therefore gets no `writingDirection` override either — the
   * platform's bidi algorithm lays out an Arabic name right-to-left, a Latin
   * name left-to-right and a mixed-script name correctly in one pass, while
   * `textAlign` still follows the app's own direction so the block starts on
   * the correct edge.
   */
  subtitle?: string;
  /** Optional right-side content (bell, key icon, etc.) */
  rightActions?: React.ReactNode;
  /** Place the secondary role/count line below the title for list-page headers. */
  roleLabelPosition?: 'above' | 'below';
  /** Accessibility label for the subtitle line (defaults to the subtitle). */
  subtitleAccessibilityLabel?: string;
}

export function DashboardHeader({
  roleLabel,
  greeting,
  subtitle,
  rightActions,
  roleLabelPosition = 'above',
  subtitleAccessibilityLabel,
}: DashboardHeaderProps) {
  const scheme  = useColorScheme();
  const isDark  = scheme === 'dark';
  const c       = isDark ? neuColors.dark : neuColors.light;
  const insets  = useSafeAreaInsets();
  const sp      = useNeuSpacing();
  const { isRTL } = useTranslation();

  const topPad   = safeTop(insets.top);
  const leftPad  = safeLeft(insets.left || 0, sp.isTablet);
  const rightPad = safeRight(insets.right || 0);

  return (
    <View style={{
      flexDirection: 'row',
      direction: isRTL ? 'rtl' : 'ltr',
      alignItems: 'center',
      paddingTop: topPad,
      paddingBottom: spacing.md,
      paddingStart: isRTL ? rightPad : leftPad + spacing.sm,
      paddingEnd: isRTL ? leftPad + spacing.sm : rightPad,
    }}>
      {/* Transparent visual treatment; the 40dp control plus hit slop remains tappable. */}
      <HamburgerButton plain color={c.text} />

      {/* Title stack — gap from button. `minWidth: 0` lets a long display name
          truncate instead of pushing the right-hand controls off the row. */}
      <View style={{ flex: 1, minWidth: 0, marginStart: spacing.sm + spacing.xs }}>
        {roleLabel && roleLabelPosition === 'above' ? (
          <Text
            style={[
              typography.overline,
              mutedTextStyle(c, 0.45),
              // Tracking + uppercase exist for Latin caps. On Arabic they break
              // the cursive joins, so the overline runs untracked in RTL.
              isRTL ? { letterSpacing: 0, textTransform: 'none' as const } : null,
              { textAlign: isRTL ? 'right' : 'left', writingDirection: isRTL ? 'rtl' : 'ltr' },
            ]}
            numberOfLines={1}
          >
            {roleLabel}
          </Text>
        ) : null}
        <Text
          style={{
            fontSize: sp.isTablet ? typography.h1.fontSize : typography.h2.fontSize,
            fontWeight: '800',
            color: c.text,
            lineHeight: sp.isTablet ? typography.h1.lineHeight : typography.h2.lineHeight,
            marginTop: roleLabel && roleLabelPosition === 'above' ? 1 : 0,
            textAlign: isRTL ? 'right' : 'left',
            writingDirection: isRTL ? 'rtl' : 'ltr',
          }}
          numberOfLines={1}
        >
          {greeting}
        </Text>
        {subtitle ? (
          <Text
            accessibilityLabel={subtitleAccessibilityLabel ?? subtitle}
            style={[
              typography.bodyLg,
              {
                marginTop: 2,
                color: c.text,
                opacity: 0.85,
                fontWeight: '600',
                textAlign: isRTL ? 'right' : 'left',
              },
            ]}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        ) : null}
        {roleLabel && roleLabelPosition === 'below' ? (
          <Text
            style={[
              typography.caption,
              mutedTextStyle(c, 0.55),
              { marginTop: 1, textAlign: isRTL ? 'right' : 'left', writingDirection: isRTL ? 'rtl' : 'ltr' },
            ]}
            numberOfLines={1}
          >
            {roleLabel}
          </Text>
        ) : null}
      </View>

      {/* Right actions */}
      {!!rightActions && (
        <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center', marginStart: spacing.sm, flexShrink: 0 }}>
          {rightActions}
        </View>
      )}
    </View>
  );
}
