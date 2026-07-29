import { useCallback, useState } from 'react';
import { View, Text, ScrollView, useColorScheme, Pressable, RefreshControl, ActivityIndicator } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Bell, Check, Trash2, ArrowLeft } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { useRouter } from 'expo-router';
import { useProfileStore } from '@/lib/store';
import { getNotifications, markNotificationRead, deleteNotification } from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { neuColors } from '@/lib/neu';

export default function NotificationsShared() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { profile } = useProfileStore();
  const router = useRouter();

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

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }} contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}>
      <View style={{ padding: 20, paddingTop: 0 }}>
          <PageHeader title="Notifications" showBack />

        {loading ? <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} /> : (
          notifications.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 60 }}>
              <Bell size={48} color={c.primary} opacity={0.2} style={{ marginBottom: 12 }} />
              <Text style={{ color: c.text, opacity: 0.4, fontSize: 16 }}>No notifications yet</Text>
            </View>
          ) : notifications.map((n) => (
            <NeuCard key={n.id} pressed={n.is_read} style={{ marginBottom: 10, padding: 16, flexDirection: 'row', alignItems: 'flex-start' }}>
              <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: n.is_read ? `${c.text}10` : `${c.primary}18`, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                <Bell size={18} color={n.is_read ? c.text : c.primary} opacity={n.is_read ? 0.4 : 1} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: n.is_read ? '500' : '700', color: c.text }}>{n.title}</Text>
                <Text style={{ fontSize: 13, color: c.text, opacity: 0.6, marginTop: 2 }}>{n.body}</Text>
                <Text style={{ fontSize: 11, color: c.text, opacity: 0.35, marginTop: 4 }}>{new Date(n.created_at).toLocaleDateString()}</Text>
              </View>
              <View style={{ flexDirection: 'column', gap: 8, marginLeft: 8 }}>
                {!n.is_read && (
                  <Pressable onPress={() => handleRead(n.id)}
                    accessibilityLabel="Mark as read"
                    accessibilityRole="button"
                    style={{ width: 44, height: 44, borderRadius: 13, backgroundColor: '#16A34A18', alignItems: 'center', justifyContent: 'center' }}>
                    <Check size={16} color="#16A34A" />
                  </Pressable>
                )}
                <Pressable onPress={() => handleDelete(n.id)}
                  accessibilityLabel="Delete notification"
                  accessibilityRole="button"
                  style={{ width: 44, height: 44, borderRadius: 13, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}>
                  <Trash2 size={16} color="#DC2626" />
                </Pressable>
              </View>
            </NeuCard>
          ))
        )}
      </View>
    </ScrollView>
  );
}
