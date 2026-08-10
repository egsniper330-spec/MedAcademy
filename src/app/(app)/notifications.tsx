import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, useColorScheme, Pressable,
  RefreshControl, ActivityIndicator, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { Bell, Check, Trash2 } from 'lucide-react-native';
import { useProfileStore } from '@/lib/store';
import { getNotifications, markNotificationRead, deleteNotification } from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, neuMicroStyle } from '@/lib/neu';
import { PageHeader } from '@/components/PageHeader';
import { DrawerProvider } from '@/components/DrawerContext';
import DrawerNav from '@/components/DrawerNav';

function NotificationsContent() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { profile } = useProfileStore();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();

  const [notifications, setNotifications] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async () => {
    if (!profile) return;
    try { setNotifications(await getNotifications(profile.id)); } catch (_) {}
    setLoading(false);
  }, [profile]);

  useFocusEffect(useCallback(() => { setLoading(true); loadData(); }, [loadData]));
  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

  const handleRead = async (id: string) => {
    await markNotificationRead(id);
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
  };

  const handleDelete = async (id: string) => {
    await deleteNotification(id);
    setNotifications(prev => prev.filter(n => n.id !== id));
  };

  // Approximate header height for the empty-state centering calculation.
  // PageHeader paddingTop = max(insets.top + 10, 24), paddingBottom = 14,
  // title line-height = 24 → total ≈ insets.top + 10 + 14 + 24 = insets.top + 48.
  const approxHeaderHeight = Math.max(insets.top + 48, 72);

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      {/* ── Global-standard header: hamburger + title, safe-area aware ── */}
      <PageHeader title="Notifications" />

      {/* ── Scrollable content ────────────────────────────────────────── */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          padding: 20,
          paddingTop: 8,
          paddingBottom: Math.max(insets.bottom, 24) + 16,
        }}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
      >
        {loading ? (
          <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} />
        ) : notifications.length === 0 ? (

          // ── Empty state — vertically centred in visible screen space ──
          <View style={{
            minHeight: screenHeight - approxHeaderHeight - insets.bottom - 40,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 32,
          }}>
            <View style={{
              width: 96, height: 96, borderRadius: 48,
              alignItems: 'center', justifyContent: 'center',
              marginBottom: 24,
              ...neuMicroStyle(isDark),
            }}>
              <Bell size={40} color={c.primary} opacity={0.55} />
            </View>
            <Text style={{ fontSize: 18, fontWeight: '800', color: c.text, textAlign: 'center', marginBottom: 8 }}>
              No Notifications Yet
            </Text>
            <Text style={{ fontSize: 14, color: c.text, opacity: 0.45, textAlign: 'center', lineHeight: 22 }}>
              You're all caught up.{'\n'}New notifications will appear here.
            </Text>
          </View>

        ) : (
          // ── Notification list ────────────────────────────────────────
          notifications.map((n) => (
            <NeuCard key={n.id} pressed={n.is_read} style={{ marginBottom: 10, padding: 16, flexDirection: 'row', alignItems: 'flex-start' }}>
              <View style={{
                width: 40, height: 40, borderRadius: 12,
                backgroundColor: n.is_read ? `${c.text}10` : `${c.primary}18`,
                alignItems: 'center', justifyContent: 'center',
                marginRight: 12,
              }}>
                <Bell size={18} color={n.is_read ? c.text : c.primary} opacity={n.is_read ? 0.4 : 1} />
              </View>

              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: n.is_read ? '500' : '700', color: c.text }}>{n.title}</Text>
                <Text style={{ fontSize: 13, color: c.text, opacity: 0.6, marginTop: 2 }}>{n.body}</Text>
                <Text style={{ fontSize: 11, color: c.text, opacity: 0.35, marginTop: 4 }}>
                  {new Date(n.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </Text>
              </View>

              <View style={{ flexDirection: 'column', gap: 8, marginLeft: 8 }}>
                {!n.is_read && (
                  <Pressable
                    onPress={() => handleRead(n.id)}
                    accessibilityLabel="Mark as read"
                    accessibilityRole="button"
                    style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#16A34A18', alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Check size={16} color="#16A34A" />
                  </Pressable>
                )}
                <Pressable
                  onPress={() => handleDelete(n.id)}
                  accessibilityLabel="Delete notification"
                  accessibilityRole="button"
                  style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}
                >
                  <Trash2 size={16} color="#DC2626" />
                </Pressable>
              </View>
            </NeuCard>
          ))
        )}
      </ScrollView>
    </View>
  );
}

// Wrap in DrawerProvider so PageHeader's HamburgerButton has a context to call.
// DrawerNav is included so the drawer slides in correctly on this screen too.
export default function NotificationsShared() {
  return (
    <DrawerProvider>
      <View style={{ flex: 1 }}>
        <NotificationsContent />
        <DrawerNav />
      </View>
    </DrawerProvider>
  );
}
