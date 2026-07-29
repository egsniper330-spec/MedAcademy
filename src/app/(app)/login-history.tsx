/**
 * Login History — shows every login attempt (success/failure) for the current user.
 * Admins passing a target_user_id param see that user's history.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, useColorScheme, FlatList,
  RefreshControl, ActivityIndicator, Platform,
} from 'react-native';
import { useFocusEffect, useRouter, useLocalSearchParams } from 'expo-router';
import { ArrowLeft, CheckCircle, XCircle, Smartphone, Globe, Clock } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { Pressable } from 'react-native';
import { getLoginHistory, LoginHistoryRecord } from '@/lib/api';
import { neuColors, neuFlatStyle } from '@/lib/neu';
import { NeuCard } from '@/components/NeuCard';

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function LoginHistory() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const router = useRouter();
  const params = useLocalSearchParams<{ user_id?: string; user_name?: string }>();
  const userId = params.user_id;
  const userName = params.user_name;

  const [history, setHistory] = useState<LoginHistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const res = await getLoginHistory(userId);
      setHistory(res.history);
    } catch (_) {}
    setLoading(false);
  }, [userId]);

  useFocusEffect(useCallback(() => { setLoading(true); loadData(); }, [loadData]));
  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

  const successCount = history.filter(h => h.success).length;
  const failureCount = history.filter(h => !h.success).length;

  const renderItem = ({ item }: { item: LoginHistoryRecord }) => (
    <NeuCard style={{ marginBottom: 10, padding: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View style={{
          width: 40, height: 40, borderRadius: 12,
          backgroundColor: item.success ? '#16A34A18' : '#DC262618',
          alignItems: 'center', justifyContent: 'center',
          ...Platform.select({ ios: neuFlatStyle(isDark), android: { elevation: 2, backgroundColor: c.base } }),
        }}>
          {item.success
            ? <CheckCircle size={20} color="#16A34A" />
            : <XCircle size={20} color="#DC2626" />
          }
        </View>

        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: item.success ? '#16A34A' : '#DC2626' }}>
              {item.success ? 'Login Successful' : 'Login Failed'}
            </Text>
            <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{formatDate(item.created_at)}</Text>
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
            <Smartphone size={11} color={`${c.text}66`} />
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.6 }}>
              {[item.device_name, item.platform].filter(Boolean).join(' · ') || 'Unknown device'}
            </Text>
          </View>

          {item.ip_address && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
              <Globe size={11} color={`${c.text}66`} />
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>{item.ip_address}</Text>
            </View>
          )}

          {!item.success && item.failure_reason && (
            <View style={{ marginTop: 6, backgroundColor: '#DC262610', borderRadius: 8, padding: 8 }}>
              <Text style={{ fontSize: 11, color: '#DC2626', fontWeight: '600' }}>
                Reason: {item.failure_reason}
              </Text>
            </View>
          )}
        </View>
      </View>
    </NeuCard>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <View style={{ padding: 20, paddingTop: 0 }}>
        {/* Header */}
        <PageHeader title="Login History" subtitle={userName ?? undefined} showBack />

        {/* Summary stats */}
        {!loading && history.length > 0 && (
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 20 }}>
            <NeuCard style={{ flex: 1, padding: 14, alignItems: 'center' }}>
              <Text style={{ fontSize: 22, fontWeight: '800', color: c.primary }}>{history.length}</Text>
              <Text style={{ fontSize: 11, color: c.text, opacity: 0.5, marginTop: 2 }}>Total</Text>
            </NeuCard>
            <NeuCard style={{ flex: 1, padding: 14, alignItems: 'center' }}>
              <Text style={{ fontSize: 22, fontWeight: '800', color: '#16A34A' }}>{successCount}</Text>
              <Text style={{ fontSize: 11, color: c.text, opacity: 0.5, marginTop: 2 }}>Successful</Text>
            </NeuCard>
            <NeuCard style={{ flex: 1, padding: 14, alignItems: 'center' }}>
              <Text style={{ fontSize: 22, fontWeight: '800', color: '#DC2626' }}>{failureCount}</Text>
              <Text style={{ fontSize: 11, color: c.text, opacity: 0.5, marginTop: 2 }}>Failed</Text>
            </NeuCard>
          </View>
        )}
      </View>

      {loading ? (
        <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} />
      ) : history.length === 0 ? (
        <View style={{ alignItems: 'center', paddingVertical: 64 }}>
          <Clock size={56} color={c.primary} opacity={0.15} />
          <Text style={{ color: c.text, opacity: 0.4, fontSize: 16, marginTop: 12 }}>No login history</Text>
        </View>
      ) : (
        <FlatList
          data={history}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
          contentInsetAdjustmentBehavior="automatic"
        />
      )}
    </View>
  );
}
