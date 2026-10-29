import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, useColorScheme, Pressable,
  RefreshControl, ActivityIndicator, useWindowDimensions,
} from 'react-native';
import { Bell, Check, Trash2 } from 'lucide-react-native';
import { useProfileStore } from '@/lib/store';
import { getNotifications, markNotificationRead, deleteNotification } from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, useLayout, neuMicroStyle, safeTop, safeBottom, mutedTextStyle } from '@/lib/neu';
import { PageHeader } from '@/components/PageHeader';
import { DrawerProvider } from '@/components/DrawerContext';
import DrawerNav from '@/components/DrawerNav';
import { useTranslation } from '@/lib/i18n';
import { localizeNotification } from '@/lib/notificationCopy';
import { useStaleWhileRevalidateFocus } from '@/lib/useStaleWhileRevalidateFocus';

function NotificationsContent() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { profile } = useProfileStore();
  const layout = useLayout();
  const insets = layout.insets;
  const { t, locale } = useTranslation();
  const { height: screenHeight } = useWindowDimensions();

  const [notifications, setNotifications] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async () => {
    if (!profile) return;
    try { setNotifications(await getNotifications(profile.id)); } catch (_) {}
    setLoading(false);
  }, [profile]);

  // STALE-WHILE-REVALIDATE (performance): returning to this screen used to
  // raise a full-screen spinner and hide the notifications the user was just
  // reading, because every focus did `setLoading(true)` + a refetch. The list
  // now stays mounted and refreshes in the background; the spinner only appears
  // when there is genuinely nothing to show (first entry / empty). The request
  // itself is unchanged, and one focus can no longer start duplicate batches.
  useStaleWhileRevalidateFocus(loadData, {
    setLoading,
    hasContent: () => notifications.length > 0,
  });
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
  const approxHeaderHeight = layout.headerTop + 48;

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      {/* ── Global-standard header: hamburger + title, safe-area aware ── */}
      <PageHeader title={t('common.notifications')} />

      {/* ── Scrollable content ────────────────────────────────────────── */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          // Horizontal grid must follow the shared screen token (matches
          // dashboard/explore/course screens); 20dp sat inside the standard
          // 30dp grid and pulled cards 15px in on tablets.
          paddingHorizontal: layout.screenPx,
          paddingTop: 8,
          paddingBottom: 20,
        }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
      >
        {loading ? (
          <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} />
        ) : notifications.length === 0 ? (

          // ── Empty state — vertically centred in visible screen space ──
          <View style={{
            minHeight: screenHeight - approxHeaderHeight - layout.insets.bottom - 40,
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
              {t('notifications.empty')}
            </Text>
            <Text style={{ fontSize: 14, ...mutedTextStyle(c, 0.45), textAlign: 'center', lineHeight: 22 }}>
              {t('notifications.emptyHint')}
            </Text>
          </View>

        ) : (
          // ── Notification list ────────────────────────────────────────
          notifications.map((n) => {
            const copy = localizeNotification(n, t);
            return (
            <NeuCard key={n.id} pressed={n.is_read} style={{ marginBottom: 10, padding: 16, flexDirection: 'row', alignItems: 'flex-start' }}>
              <View style={{
                width: 40, height: 40, borderRadius: 12,
                backgroundColor: n.is_read ? `${c.text}10` : `${c.primary}18`,
                alignItems: 'center', justifyContent: 'center',
                marginEnd: 12,
              }}>
                <Bell size={18} color={n.is_read ? c.text : c.primary} opacity={n.is_read ? 0.4 : 1} />
              </View>

              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: n.is_read ? '500' : '700', color: c.text }}>{copy.title}</Text>
                <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.6), marginTop: 2 }}>{copy.body}</Text>
                <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.35), marginTop: 4 }}>
                  {new Date(n.created_at).toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en-US', {
                    numberingSystem: 'latn', month: 'short', day: 'numeric', year: 'numeric',
                  })}
                </Text>
              </View>

              <View style={{ flexDirection: 'column', gap: 8, marginStart: 8 }}>
                {!n.is_read && (
                  <Pressable
                    onPress={() => handleRead(n.id)}
                    accessibilityLabel={t('notifications.markRead')}
                    accessibilityRole="button"
                    style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#16A34A18', alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Check size={16} color="#16A34A" />
                  </Pressable>
                )}
                <Pressable
                  onPress={() => handleDelete(n.id)}
                  accessibilityLabel={t('notifications.delete')}
                  accessibilityRole="button"
                  style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}
                >
                  <Trash2 size={16} color="#DC2626" />
                </Pressable>
              </View>
            </NeuCard>
            );
          })
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
