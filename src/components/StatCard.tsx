import React, { useRef } from 'react';
import { Animated, FlatList, View, Text, useWindowDimensions, useColorScheme } from 'react-native';
import { NeuCard } from '@/components/NeuCard';
import { neuColors } from '@/lib/neu';

// ─── Simple inline StatCard (admin / doctor / superadmin dashboards) ──────────
interface StatCardProps {
  label: string;
  value: string | number;
  icon?: React.ReactNode;
  color?: string;
}

export function StatCard({ label, value, icon, color }: StatCardProps) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  return (
    <NeuCard style={{ minWidth: 130, flex: 1, margin: 5, padding: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8 }}>
        {icon ? (
          <View style={{
            width: 32, height: 32, borderRadius: 10,
            backgroundColor: color ?? c.primary,
            alignItems: 'center', justifyContent: 'center',
          }}>
            {icon}
          </View>
        ) : null}
        <Text style={{ fontSize: 12, color: c.text, opacity: 0.55, flex: 1 }} numberOfLines={1}>{label}</Text>
      </View>
      <Text style={{ fontSize: 26, fontWeight: '800', color: color ?? c.primary, lineHeight: 30 }}>{value}</Text>
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
}

const CARD_HEIGHT = 118;
const GAP = 10;

export function StatCardCarousel({ cards }: { cards: StatCardItem[] }) {
  const { width: screenWidth } = useWindowDimensions();
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  // Responsive card width:
  // • Tablets (≥768): ~28% screen width, max 180
  // • Phones: ~40% screen width, max 155
  // • Floor at 130 so cards never clip on iPhone SE (320pt) or small Androids
  const isTablet = screenWidth >= 768;
  const CARD_WIDTH = isTablet
    ? Math.max(130, Math.min(180, Math.floor(screenWidth * 0.28)))
    : Math.max(130, Math.min(155, Math.floor(screenWidth * 0.40)));
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
      <Animated.View style={{ width: CARD_WIDTH, transform: [{ scale }], opacity }}>
        <NeuCard radius={18} style={{ height: CARD_HEIGHT, padding: 14, justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{
              width: 36, height: 36, borderRadius: 11,
              backgroundColor: item.isFuture ? `${c.text}10` : item.color,
              alignItems: 'center', justifyContent: 'center',
            }}>
              {item.icon}
            </View>
            <Text style={{
              fontSize: 11, fontWeight: '600', color: c.text,
              opacity: item.isFuture ? 0.35 : 0.6, flex: 1,
            }} numberOfLines={2}>
              {item.label}
            </Text>
          </View>
          <View>
            <Text style={{
              fontSize: 28, fontWeight: '800', lineHeight: 32,
              color: item.isFuture ? `${c.text}30` : item.color,
            }}>
              {item.isFuture ? '—' : item.value}
            </Text>
            {item.sublabel ? (
              <Text style={{ fontSize: 10, color: c.text, opacity: 0.35, marginTop: 2 }}>{item.sublabel}</Text>
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
      contentContainerStyle={{ paddingHorizontal: 20, gap: GAP, paddingVertical: 6 }}
      onScroll={Animated.event(
        [{ nativeEvent: { contentOffset: { x: scrollX } } }],
        { useNativeDriver: true }
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
