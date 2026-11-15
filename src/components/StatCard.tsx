import React, { useRef } from 'react';
import { Animated, FlatList, View, Text, useColorScheme, Platform } from 'react-native';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, useLayout, mutedTextStyle } from '@/lib/neu';
import { spacing, radius, typography, iconContainer } from '@/lib/ds';

// ─── Simple inline StatCard (admin / doctor / superadmin dashboards) ──────────
interface StatCardProps {
  label: string;
  value: string | number;
  icon?: React.ReactNode;
  color?: string;
  /** Optional navigation shortcut. Omit for decorative (non-clickable) cards. */
  onPress?: () => void;
  /**
   * Take the full content width instead of sharing a wrapped row.
   *
   * Root cause of the reported doctor-dashboard layout: the card carried
   * `flex: 1` inside a `flexWrap` row, so a row of three cards each got a third
   * of the width while a lone trailing card (Balance, Today's Activations)
   * stretched to 100 %. With 7 cards that produced cards that looked
   * “half-positioned” on a phone and a narrow Published Courses tile. Full-width
   * cards stack at one geometry on every screen size — no breakpoint guessing.
   */
  fullWidth?: boolean;
}

export function StatCard({ label, value, icon, color, onPress, fullWidth }: StatCardProps) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  return (
    <NeuCard
      style={fullWidth
        ? { alignSelf: 'stretch', marginVertical: spacing.xs, padding: spacing.md }
        : { minWidth: 130, flex: 1, margin: spacing.xs, padding: spacing.md }}
      pressable={!!onPress}
      onPress={onPress}
      accessibilityLabel={label}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm, gap: spacing.sm }}>
        {icon ? (
          <View style={{
            ...iconContainer.sm,
            backgroundColor: color ?? c.primary,
            alignItems: 'center', justifyContent: 'center',
            // The badge is a fixed square and must never participate in flex
            // shrinking: without flexShrink:0 the label could squeeze it below
            // 32dp on narrow cards, which also stretched the glyph, because the
            // icon then rendered larger than its container.
            flexShrink: 0,
          }}>
            {icon}
          </View>
        ) : null}
        <Text
          style={{ ...typography.caption, ...mutedTextStyle(c, 0.62), flex: 1, minWidth: 0 }}
          numberOfLines={1}
        >{label}</Text>
      </View>
      <Text
        style={{ ...typography.display, color: color ?? c.primary, minHeight: typography.display.fontSize * 1.25 }}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
      >{value}</Text>
    </NeuCard>
  );
}

// ─── Carousel StatCard (student dashboard) ────────────────────────────────────
export interface StatCardItem {
  id: string;
  label: string;
  sublabel?: string;
  value: string | number;
  icon: React.ReactNode;
  color: string;
  isFuture?: boolean;
  /** Optional navigation shortcut. Omit for decorative (non-clickable) cards. */
  onPress?: () => void;
}

const GAP = spacing.sm;

export function StatCardCarousel({ cards }: { cards: StatCardItem[] }) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  // Fluid card dimensions — derived entirely from adaptive tokens.
  // cardImageHeight is a 16:9 fluid value (140–320dp); we halve it for a portrait
  // stat card so it scales continuously: ~70dp compact → ~160dp large tablet.
  // CARD_HEIGHT: touchTarget (44–52dp) × 2.5 gives a comfortable card height
  // that never clips content on small phones and never wastes space on tablets.
  const CARD_HEIGHT = Math.round(layout.touchTarget * 2.5);
  // Card width: ~42% of available content width (after gutters), clamped to a
  // range that keeps cards readable. No breakpoint — pure fluid scaling.
  const availableWidth = layout.width - layout.screenPx * 2;
  const CARD_WIDTH = Math.round(
    Math.max(layout.touchTarget * 2.8, Math.min(availableWidth * 0.45, layout.touchTarget * 4.2))
  );
  const SNAP_INTERVAL = CARD_WIDTH + GAP;

  const scrollX = useRef(new Animated.Value(0)).current;

  const renderCard = ({ item, index }: { item: StatCardItem; index: number }) => {
    const cardCenter = index * SNAP_INTERVAL + CARD_WIDTH / 2;

    const scale = scrollX.interpolate({
      inputRange: [
        cardCenter - SNAP_INTERVAL - CARD_WIDTH / 2,
        cardCenter - CARD_WIDTH / 2,
        cardCenter,
        cardCenter + CARD_WIDTH / 2,
        cardCenter + SNAP_INTERVAL + CARD_WIDTH / 2,
      ],
      outputRange: [0.90, 0.95, 1, 0.95, 0.90],
      extrapolate: 'clamp',
    });

    const opacity = scrollX.interpolate({
      inputRange: [
        cardCenter - SNAP_INTERVAL,
        cardCenter - CARD_WIDTH / 2,
        cardCenter,
        cardCenter + CARD_WIDTH / 2,
        cardCenter + SNAP_INTERVAL,
      ],
      outputRange: [0.55, 0.82, 1, 0.82, 0.55],
      extrapolate: 'clamp',
    });

    return (
      <Animated.View
        style={{
          width: CARD_WIDTH,
          transform: [{ scale }],
          opacity,
          backgroundColor: Platform.OS === 'android' ? c.base : 'transparent',
          borderRadius: radius.lg,
          overflow: Platform.OS === 'android' ? 'hidden' : 'visible',
        }}
      >
        <NeuCard
          radius={layout.cardRadius}
          style={{ height: CARD_HEIGHT, padding: layout.cardPx, justifyContent: 'space-between' }}
          pressable={!!item.onPress}
          onPress={item.onPress}
          accessibilityLabel={item.label}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <View style={{
              // Icon container: fluid 32–44dp, tracks touchTarget
              width: Math.round(layout.touchTarget * 0.76),
              height: Math.round(layout.touchTarget * 0.76),
              borderRadius: layout.cardRadius / 2,
              backgroundColor: item.isFuture ? `${c.text}10` : item.color,
              alignItems: 'center', justifyContent: 'center',
              overflow: 'hidden',
            }}>
              {item.icon}
            </View>
            <Text style={{
              ...typography.micro,
              fontWeight: '600',
              color: c.text,
              opacity: item.isFuture ? 0.35 : 0.6, flex: 1,
            }} numberOfLines={2}>
              {item.label}
            </Text>
          </View>
          <View>
            <Text style={{
              ...typography.displayLg,
              color: item.isFuture ? `${c.text}30` : item.color,
            }}>
              {item.isFuture ? '—' : item.value}
            </Text>
            {item.sublabel ? (
              <Text style={{ ...typography.micro, ...mutedTextStyle(c, 0.35), marginTop: 2 }}>{item.sublabel}</Text>
            ) : null}
          </View>
        </NeuCard>
      </Animated.View>
    );
  };

  return (
    <Animated.FlatList<StatCardItem>
      data={cards}
      keyExtractor={item => item.id}
      horizontal
      showsHorizontalScrollIndicator={false}
      snapToInterval={SNAP_INTERVAL}
      decelerationRate="fast"
      snapToAlignment="start"
      scrollEventThrottle={16}
      contentContainerStyle={{ paddingHorizontal: spacing.xl, gap: GAP, paddingVertical: spacing.xs }}
      onScroll={Animated.event(
        [{ nativeEvent: { contentOffset: { x: scrollX } } }],
        { useNativeDriver: true },
      )}
      renderItem={renderCard}
      getItemLayout={(_, index) => ({
        length: SNAP_INTERVAL,
        offset: SNAP_INTERVAL * index,
        index,
      })}
    />
  );
}
