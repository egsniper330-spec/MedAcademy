import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, RefreshControl, ActivityIndicator,
  useColorScheme, Pressable,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AlertTriangle, CheckCircle, Clock, Zap } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout } from '@/lib/neu';
import { supabase } from '@/client/supabase';
import { getContactDisplay } from '@/lib/api';

type FraudFlag = {
  id: string;
  flag_type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  resolved: boolean;
  details: Record<string, unknown>;
  created_at: string;
  doctor_id?: string;
  doctor?: { full_name: string; email: string } | null;
};

const SEV_COLOR: Record<string, string> = {
  low: '#6B7280', medium: '#D97706', high: '#DC2626', critical: '#7C3AED',
};

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function FraudAlertsScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const { showToast } = useToast();

  const [flags, setFlags] = useState<FraudFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('fraud_flags')
        .select('*, doctor:profiles!fraud_flags_doctor_id_fkey(full_name, email)')
        .order('created_at', { ascending: false })
        .limit(200);
      setFlags(data ?? []);
    } catch (_) {}
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const resolve = async (flag: FraudFlag) => {
    setResolvingId(flag.id);
    try {
      const { error } = await supabase.from('fraud_flags')
        .update({ resolved: true, resolved_at: new Date().toISOString() })
        .eq('id', flag.id);
      if (error) throw error;
      setFlags(p => p.map(f => f.id === flag.id ? { ...f, resolved: true } : f));
      showToast({ type: 'success', message: 'Flag resolved.' });
    } catch (e: any) {
      showToast({ type: 'error', message: e.message ?? 'Failed to resolve.' });
    }
    setResolvingId(null);
  };

  const visible = flags.filter(f => showResolved ? f.resolved : !f.resolved);
  const unresolvedCount = flags.filter(f => !f.resolved).length;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
    >
      <View style={{ padding: layout.screenPx }}>
        <PageHeader title="Fraud Alerts" subtitle="Platform anomaly detection" accentColor="#DC2626" />

        {/* Summary bar */}
        <NeuCard style={{ padding: 16, marginBottom: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}>
            <AlertTriangle size={22} color="#DC2626" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 22, fontWeight: '800', color: '#DC2626' }}>{unresolvedCount}</Text>
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>unresolved alerts</Text>
          </View>
          <Pressable
            onPress={() => setShowResolved(v => !v)}
            style={{ backgroundColor: showResolved ? c.primary + '20' : `${c.text}0E`, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 }}
          >
            <Text style={{ fontSize: 12, fontWeight: '700', color: showResolved ? c.primary : c.text }}>
              {showResolved ? 'Show Active' : 'Show Resolved'}
            </Text>
          </Pressable>
        </NeuCard>

        {loading && <ActivityIndicator size="large" color="#DC2626" style={{ marginTop: 40 }} />}

        {!loading && visible.length === 0 && (
          <NeuCard style={{ padding: 48, alignItems: 'center' }}>
            <CheckCircle size={40} color="#16A34A" style={{ marginBottom: 12 }} />
            <Text style={{ fontSize: 16, fontWeight: '700', color: '#16A34A' }}>
              {showResolved ? 'No resolved flags' : 'No active fraud alerts'}
            </Text>
            <Text style={{ fontSize: 13, color: c.text, opacity: 0.5, marginTop: 4 }}>
              {showResolved ? '' : 'The platform looks clean.'}
            </Text>
          </NeuCard>
        )}

        {visible.map(flag => {
          const col = SEV_COLOR[flag.severity] ?? '#6B7280';
          return (
            <NeuCard key={flag.id} style={{ marginBottom: 10, padding: 14 }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: `${col}20`, alignItems: 'center', justifyContent: 'center', marginTop: 2 }}>
                  <Zap size={17} color={col} />
                </View>
                <View style={{ flex: 1 }}>
                  {/* Flag type + severity */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>
                      {flag.flag_type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                    </Text>
                    <View style={{ backgroundColor: `${col}20`, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}>
                      <Text style={{ fontSize: 10, fontWeight: '800', color: col, textTransform: 'uppercase' }}>{flag.severity}</Text>
                    </View>
                    {flag.resolved && (
                      <View style={{ backgroundColor: '#16A34A20', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: '#16A34A' }}>RESOLVED</Text>
                      </View>
                    )}
                  </View>

                  {/* Actor */}
                  {flag.doctor && (
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.6, marginBottom: 2 }}>
                      Doctor: {flag.doctor.full_name} · {getContactDisplay(flag.doctor)}
                    </Text>
                  )}

                  {/* Details */}
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.45, fontFamily: 'monospace' }}>
                    {JSON.stringify(flag.details ?? {}, null, 0).slice(0, 120)}
                  </Text>

                  {/* Time */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 }}>
                    <Clock size={11} color={c.text} style={{ opacity: 0.4 }} />
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{timeAgo(flag.created_at)}</Text>
                  </View>
                </View>
              </View>

              {!flag.resolved && (
                <View style={{ marginTop: 12 }}>
                  <NeuButton
                    label="Mark Resolved"
                    onPress={() => resolve(flag)}
                    loading={resolvingId === flag.id}
                    variant="secondary"
                    style={{ alignSelf: 'flex-start' }}
                  />
                </View>
              )}
            </NeuCard>
          );
        })}
      </View>
    </ScrollView>
  );
}
