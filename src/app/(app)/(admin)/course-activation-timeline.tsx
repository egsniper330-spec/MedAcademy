/**
 * Course Activation Timeline — shows all codes, usage stats, and expiry info for a course.
 * Accessed via course_id + course_title params.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, FlatList, ActivityIndicator, RefreshControl,
  useColorScheme, Pressable,
} from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
  Ticket, CheckCircle, XCircle, Clock, BookOpen,
  ArrowLeft, Hash,
} from 'lucide-react-native';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, useLayout } from '@/lib/neu';
import { getActivationLedger } from '@/lib/api';

type CodeRow = {
  id: string; code: string; status: string; created_at: string;
  used_by_name: string | null; used_at: string | null;
  expires_at: string | null; batch_label: string | null; notes: string | null;
};

const STATUS_COLOR: Record<string, string> = {
  active: '#2DA8FF', used: '#16A34A', expired: '#D97706',
  disabled: '#DC2626', deactivated: '#DC2626', deleted: '#6B7280',
};
const STATUS_ICON: Record<string, any> = {
  used: CheckCircle, expired: Clock, disabled: XCircle, deactivated: XCircle,
  active: Ticket, deleted: XCircle,
};

function fmt(d: string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function CourseActivationTimelineScreen() {
  const { course_id, course_title } = useLocalSearchParams<{ course_id: string; course_title?: string }>();
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const router = useRouter();

  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [codes, setCodes]           = useState<CodeRow[]>([]);
  const [filter, setFilter]         = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!course_id) { setLoading(false); return; }
    try {
      const rows = await getActivationLedger({ courseId: course_id, limit: 1000 });
      setCodes(rows as CodeRow[]);
    } catch (_) {}
    setLoading(false);
  }, [course_id]);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const stats = {
    total:    codes.length,
    used:     codes.filter(c => c.status === 'used').length,
    active:   codes.filter(c => c.status === 'active').length,
    expired:  codes.filter(c => c.status === 'expired').length,
    disabled: codes.filter(c => ['disabled', 'deactivated'].includes(c.status)).length,
  };

  const filtered = filter ? codes.filter(c => c.status === filter) : codes;

  // Build per-month chart
  const monthChart = (() => {
    const map: Record<string, number> = {};
    for (const code of codes.filter(c => c.status === 'used' && c.used_at)) {
      const mo = code.used_at!.slice(0, 7);
      map[mo] = (map[mo] ?? 0) + 1;
    }
    const months = Object.keys(map).sort().slice(-6);
    const vals   = months.map(m => map[m]);
    const maxV   = Math.max(...vals, 1);
    return { months, vals, maxV };
  })();

  const StatPill = ({
    label, value, color, status,
  }: { label: string; value: number; color: string; status: string | null }) => (
    <Pressable onPress={() => setFilter(filter === status ? null : status)}
      style={{ flex: 1, minWidth: 80, alignItems: 'center', padding: 12, borderRadius: 14,
        backgroundColor: filter === status ? `${color}20` : `${color}0D`,
        borderWidth: filter === status ? 1.5 : 0, borderColor: color }}>
      <Text style={{ fontSize: 20, fontWeight: '900', color }}>{value}</Text>
      <Text style={{ fontSize: 10, color, opacity: 0.8, marginTop: 2 }}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <FlatList
        data={filtered}
        keyExtractor={item => item.id}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
        ListHeaderComponent={
          <View style={{ padding: layout.screenPx, paddingTop: 8 }}>
            {/* Back */}
            <Pressable onPress={() => router.back()}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <ArrowLeft size={18} color={c.primary} />
              <Text style={{ fontSize: 14, color: c.primary, fontWeight: '600' }}>Back</Text>
            </Pressable>

            {/* Header */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 20 }}>
              <View style={{ width: 46, height: 46, borderRadius: 15, backgroundColor: '#D97706' + '18',
                alignItems: 'center', justifyContent: 'center' }}>
                <BookOpen size={24} color="#D97706" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 20, fontWeight: '900', color: c.text }} numberOfLines={1}>
                  {course_title ?? 'Course Timeline'}
                </Text>
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.4 }}>Activation Code Timeline</Text>
              </View>
            </View>

            {/* Stats pills — tap to filter */}
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              <StatPill label="Total"    value={stats.total}    color={c.primary}  status={null} />
              <StatPill label="Used"     value={stats.used}     color="#16A34A"    status="used" />
              <StatPill label="Active"   value={stats.active}   color="#2DA8FF"    status="active" />
              <StatPill label="Expired"  value={stats.expired}  color="#D97706"    status="expired" />
              <StatPill label="Disabled" value={stats.disabled} color="#DC2626"    status="disabled" />
            </View>

            {/* Monthly redemption chart */}
            {monthChart.months.length > 0 && (
              <>
                <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.4, marginBottom: 8 }}>
                  MONTHLY REDEMPTIONS
                </Text>
                <NeuCard style={{ padding: 14, marginBottom: 20 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 72 }}>
                    {monthChart.vals.map((v, i) => (
                      <View key={monthChart.months[i]} style={{ flex: 1, alignItems: 'center' }}>
                        <Text style={{ fontSize: 8, color: c.text, opacity: 0.4, marginBottom: 2 }}>{v}</Text>
                        <View style={{
                          width: '75%', height: Math.max(4, (v / monthChart.maxV) * 60),
                          backgroundColor: '#16A34A', borderRadius: 4, opacity: 0.8,
                        }} />
                      </View>
                    ))}
                  </View>
                  <View style={{ flexDirection: 'row', gap: 6, marginTop: 4 }}>
                    {monthChart.months.map(m => (
                      <Text key={m} style={{ flex: 1, fontSize: 8, color: c.text, opacity: 0.3, textAlign: 'center' }}>
                        {m.slice(5)}
                      </Text>
                    ))}
                  </View>
                </NeuCard>
              </>
            )}

            <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.4, marginBottom: 10 }}>
              {filter ? `${filter.toUpperCase()} CODES` : 'ALL CODES'} ({filtered.length})
            </Text>
            {loading && <ActivityIndicator size="large" color={c.primary} style={{ marginVertical: 20 }} />}
          </View>
        }
        renderItem={({ item: code }) => {
          const col  = STATUS_COLOR[code.status] ?? '#6B7280';
          const Icon = STATUS_ICON[code.status] ?? Ticket;
          return (
            <View style={{ paddingHorizontal: layout.screenPx, marginBottom: 8 }}>
              <NeuCard style={{ padding: 12 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <Icon size={18} color={col} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '800', color: c.text,
                      fontFamily: 'monospace', letterSpacing: 1 }}>{code.code}</Text>
                    {code.used_by_name && (
                      <Text style={{ fontSize: 11, color: c.text, opacity: 0.55 }}>
                        {`Redeemed by ${code.used_by_name}${code.used_at ? ` · ${fmt(code.used_at)}` : ''}`}
                      </Text>
                    )}
                    {code.batch_label && (
                      <Text style={{ fontSize: 10, color: c.text, opacity: 0.35 }}>
                        Batch: {code.batch_label}
                      </Text>
                    )}
                    {code.expires_at && (
                      <Text style={{ fontSize: 10, color: '#D97706', opacity: 0.7 }}>
                        Expires {fmt(code.expires_at)}
                      </Text>
                    )}
                  </View>
                  <View style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, backgroundColor: `${col}15` }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: col, textTransform: 'uppercase' }}>
                      {code.status}
                    </Text>
                  </View>
                </View>
              </NeuCard>
            </View>
          );
        }}
        ListEmptyComponent={!loading ? (
          <View style={{ padding: 60, alignItems: 'center' }}>
            <Ticket size={40} color={c.primary} opacity={0.2} />
            <Text style={{ color: c.text, opacity: 0.4, marginTop: 16 }}>No codes match filter</Text>
          </View>
        ) : null}
      />
    </View>
  );
}
