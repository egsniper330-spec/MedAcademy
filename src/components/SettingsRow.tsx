/**
 * SettingsRow — the ONE row primitive for Profile ▸ Settings lists.
 *
 * THE BUG THIS REPLACES
 * ─────────────────────
 * Every settings row (Change Password, Sign Out, Terms, Privacy, About,
 * Contact, …) was hand-built as:
 *
 *     <Pressable style={{ flexDirection: 'row', alignItems: 'center' }}>
 *       <Lock size={18} />
 *       <Text style={{ marginLeft: 10 }}>…</Text>
 *       <ChevronRight />
 *     </Pressable>
 *
 * `marginLeft` is a PHYSICAL offset, but React Native mirrors `flexDirection:
 * 'row'` to row-reverse under I18nManager RTL. The icon therefore moved to the
 * right of the label while the gap stayed on the label's LEFT — i.e. the icon
 * and the Arabic label ended up touching (the reported crowding), and longer
 * Arabic labels pushed the chevron off-screen. There was no touch-target floor
 * either, so rows were shorter than the 48dp guideline on small screens.
 *
 * THE CONTRACT (keep new rows on it)
 *   • spacing via `gap` (direction-agnostic), never marginLeft/marginRight;
 *   • the icon keeps a fixed box and never shrinks (`flexShrink: 0`);
 *   • the label owns the free space (`flex: 1`, `minWidth: 0`) and may wrap to
 *     2 lines without ever overlapping the icon or the chevron;
 *   • minHeight 48dp (WCAG/Apple touch target) with vertical padding;
 *   • the chevron points along the reading direction (left in Arabic);
 *   • values render as a second, muted line so long emails/phones wrap instead
 *     of colliding with the label.
 */
import React from 'react';
import { I18nManager, Pressable, Text, View, useColorScheme, type ViewStyle } from 'react-native';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { neuColors, mutedTextStyle } from '@/lib/neu';

export interface SettingsRowProps {
  /** Pre-rendered icon (lucide). Sized ~18 by callers. */
  icon: React.ReactNode;
  label: string;
  /** Optional secondary line (email, phone, value…). */
  value?: string;
  onPress?: () => void;
  /** Red label + red icon container (Sign Out, destructive actions). */
  destructive?: boolean;
  /** Show the trailing chevron (default true when `onPress` is set). */
  chevron?: boolean;
  /** Suppress the bottom divider (last row in a card). */
  last?: boolean;
  /** Explicit accessibility label when the visible text is not descriptive. */
  accessibilityLabel?: string;
  /** Optional extra style for the row container. */
  style?: ViewStyle;
  c?: typeof neuColors.light;
}

export function SettingsRow({
  icon,
  label,
  value,
  onPress,
  destructive = false,
  chevron,
  last = false,
  accessibilityLabel,
  style,
  c,
}: SettingsRowProps) {
  const scheme = useColorScheme();
  const colors = c ?? (scheme === 'dark' ? neuColors.dark : neuColors.light);
  const isRTL = I18nManager.isRTL;

  const labelColor = destructive ? '#DC2626' : colors.text;
  const showChevron = chevron ?? !!onPress;
  const Chevron = isRTL ? ChevronLeft : ChevronRight;

  const content = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        // Direction-agnostic spacing — survives the RTL row-reverse mirror.
        gap: 12,
        minHeight: 48,
        paddingVertical: 12,
      }}
    >
      <View style={{ width: 22, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {icon}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          style={{ fontSize: 15, fontWeight: '600', color: labelColor }}
          numberOfLines={2}
        >
          {label}
        </Text>
        {value ? (
          <Text
            style={{ fontSize: 12, ...mutedTextStyle(colors, 0.5) }}
            numberOfLines={2}
          >
            {value}
          </Text>
        ) : null}
      </View>
      {showChevron ? (
        <Chevron size={16} color={colors.text} opacity={0.3} style={{ flexShrink: 0 }} />
      ) : null}
    </View>
  );

  const containerStyle: ViewStyle = {
    borderBottomWidth: last ? 0 : 1,
    borderBottomColor: `${colors.text}08`,
    ...style,
  };

  if (!onPress) {
    return <View style={containerStyle}>{content}</View>;
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={containerStyle}
    >
      {content}
    </Pressable>
  );
}

export default SettingsRow;
