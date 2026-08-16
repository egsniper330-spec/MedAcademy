/**
 * video-settings.tsx
 * Video Provider Settings — Super Admin only
 * Shows current provider, health status, storage stats, API/webhook status.
 */
import { useCallback, useState } from 'react';
import {
  ActivityIndicator, Pressable, RefreshControl,
  ScrollView, Text, useColorScheme, View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Activity, AlertTriangle, CheckCircle, Clock, HardDrive,
  RefreshCw, Settings, ShieldCheck, Wifi, WifiOff, Zap,
} from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { supabase } from '@/client/supabase';
import { neuColors, useLayout, neuFlatStyle, neuPressedStyle, safeBottom } from '@/lib/neu';
import { formatBytes } from '@/lib/videoUploadEngine';

type HealthStatus = 'online' | 'offline' | 'degraded' | 'maintenance' | 'unknown';

const HEALTH_CFG: Record<HealthStatus, { label: string; color: string; Icon: any }> = {
  online:      { label: 'Online',      color: '#16A34A', Icon: CheckCircle },
  offline:     { label: 'Offline',     color: '#DC2626', Icon: WifiOff },
  degraded:    { label: 'Degraded',    color: '#D97706', Icon: AlertTriangle },
  maintenance: { label: 'Maintenance', color: '#7C3AED', Icon: Settings },
  unknown:     { label: 'Unknown',     color: '#6B7280', Icon: Clock },
};

export default function VideoSettingsScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const insets = layout.insets;

  const [provider, setProvider] = useState<any>(null);
  const [stats, setStats] = useState({ total: 0, ready: 0, storage: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [pingResult, setPingResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: prov }, { data: plyrUploads }, { data: vdoLessons }] = await Promise.all([
      supabase
        .from('video_provider_config')
        .select('*')
        .eq('is_default', true)
        .maybeSingle(),
      // Plyr: only active (non-deleted, non-failed, non-canceled) uploads
      supabase
        .from('video_uploads')
        .select('status, file_size')
        .in('status', ['ready', 'uploading', 'processing', 'encoding', 'verifying', 'waiting']),
      // VdoCipher: lessons that have a vdocipher video set and are not deleted
      supabase
        .from('lessons')
        .select('id, video_type, video_id')
        .eq('video_type', 'vdocipher')
        .not('video_id', 'is', null)
        .neq('video_id', '')
        .is('deleted_at', null),
    ]);
    setProvider(prov);
    const plyr = plyrUploads ?? [];
    const vdo  = vdoLessons ?? [];
    setStats({
      total:   plyr.length + vdo.length,
      ready:   plyr.filter((u: any) => u.status === 'ready').length + vdo.length,
      storage: plyr.reduce((s: number, u: any) => s + (u.file_size ?? 0), 0),
    });
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const handlePingProvider = async () => {
    setPinging(true);
    setPingResult(null);
    const { data, error } = await supabase.functions.invoke('video-health-scan', {
      body: { action: 'provider_health' },
    });
    if (error) setPingResult(`Error: ${error.message}`);
    else {
      setPingResult(`Provider status: ${data?.status ?? 'unknown'}`);
      await load();
    }
    setPinging(false);
  };

  const healthKey: HealthStatus = (provider?.health_status as HealthStatus) ?? 'unknown';
  const healthCfg = HEALTH_CFG[healthKey];

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
        contentContainerStyle={{ padding: layout.screenPx, gap: 16, paddingBottom: layout.scrollBottom() }}>

        <View style={{ marginTop: 8 }}>
          <PageHeader title="Video Settings" subtitle="Provider & health configuration" accentColor="#7C3AED" />
        </View>

        {loading ? (
          <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} />
        ) : (
          <View style={{ gap: 14 }}>

            {/* Current provider card */}
            <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 18, padding: 18, gap: 14 }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ width: 46, height: 46, borderRadius: 14, backgroundColor: `${c.primary}18`,
                  alignItems: 'center', justifyContent: 'center' }}>
                  <Zap size={22} color={c.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '800', color: c.text }}>
                    {provider?.display_name ?? 'MedAcademy Video'}
                  </Text>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>
                    Current Video Provider
                  </Text>
                </View>
                <View style={{ backgroundColor: `${healthCfg.color}18`, borderRadius: 10,
                  paddingHorizontal: 10, paddingVertical: 5,
                  flexDirection: 'row', gap: 5, alignItems: 'center' }}>
                  <healthCfg.Icon size={11} color={healthCfg.color} />
                  <Text style={{ fontSize: 11, fontWeight: '800', color: healthCfg.color }}>
                    {healthCfg.label}
                  </Text>
                </View>
              </View>

              {/* Ping */}
              <Pressable onPress={handlePingProvider} disabled={pinging}
                style={[pinging ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
                  { borderRadius: 12, padding: 12, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' }]}>
                {pinging ? <ActivityIndicator size={14} color={c.primary} /> : <Wifi size={14} color={c.primary} />}
                <Text style={{ fontSize: 13, fontWeight: '700', color: c.primary }}>
                  {pinging ? 'Pinging Provider…' : 'Ping Provider'}
                </Text>
              </Pressable>

              {pingResult && (
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.6, textAlign: 'center' }}>
                  {pingResult}
                </Text>
              )}
            </NeuCard>

            {/* Provider details */}
            <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 16, gap: 10 }]}>
              <Text style={{ fontSize: 13, fontWeight: '800', color: c.text }}>Provider Details</Text>
              {[
                { label: 'Provider Key',       value: provider?.provider_key ?? 'medacademy' },
                { label: 'Streaming',          value: provider?.config?.supports_streaming ? 'Yes' : 'No' },
                { label: 'DRM Protection',     value: provider?.config?.supports_drm ? 'Yes' : 'No' },
                { label: 'Max File Size',      value: `${provider?.config?.max_file_size_gb ?? 5} GB` },
                { label: 'API Status',         value: healthCfg.label },
                { label: 'Last Health Check',  value: provider?.health_checked_at ? new Date(provider.health_checked_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) : 'Never' },
                { label: 'Last Sync',          value: provider?.last_sync_at ? new Date(provider.last_sync_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) : 'Never' },
              ].map(({ label, value }) => (
                <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between',
                  paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>{label}</Text>
                  <Text style={{ fontSize: 12, fontWeight: '600', color: c.text }}>{value}</Text>
                </View>
              ))}
            </NeuCard>

            {/* Platform stats */}
            <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 16, gap: 10 }]}>
              <Text style={{ fontSize: 13, fontWeight: '800', color: c.text }}>Platform Stats</Text>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                {[
                  { label: 'Total Videos', value: String(stats.total), color: '#2DA8FF', Icon: Activity },
                  { label: 'Ready',        value: String(stats.ready), color: '#16A34A', Icon: CheckCircle },
                  { label: 'Storage',      value: formatBytes(stats.storage), color: '#7C3AED', Icon: HardDrive },
                ].map(({ label, value, color, Icon: Ic }) => (
                  <NeuCard key={label} style={[neuFlatStyle(isDark),
                    { flex: 1, borderRadius: 12, padding: 12, alignItems: 'center', gap: 5 }]}>
                    <Ic size={16} color={color} />
                    <Text style={{ fontSize: 18, fontWeight: '900', color }}>{value}</Text>
                    <Text style={{ fontSize: 10, color: c.text, opacity: 0.4, textAlign: 'center' }}>{label}</Text>
                  </NeuCard>
                ))}
              </View>
            </NeuCard>

            {/* Webhook info */}
            <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 16, gap: 10 }]}>
              <Text style={{ fontSize: 13, fontWeight: '800', color: c.text }}>Webhook Configuration</Text>
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center',
                backgroundColor: '#2DA8FF18', padding: 10, borderRadius: 10 }}>
                <ShieldCheck size={14} color="#2DA8FF" />
                <Text style={{ fontSize: 12, color: '#2DA8FF', flex: 1 }}>
                  Webhook endpoint: /functions/v1/vdocipher-otp/webhook
                </Text>
              </View>
              {[
                'Processing Completed → video status updated',
                'Upload Failed → alert created',
                'Encoding Failed → alert + retry available',
                'Thumbnail Ready → thumbnail_url stored',
              ].map((item) => (
                <View key={item} style={{ flexDirection: 'row', gap: 8 }}>
                  <Activity size={12} color={`${c.text}50`} />
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>{item}</Text>
                </View>
              ))}
            </NeuCard>

            {/* Future providers info */}
            <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 16, gap: 10 }]}>
              <Text style={{ fontSize: 13, fontWeight: '800', color: c.text }}>Available Providers</Text>
              {[
                { name: 'MedAcademy Video', active: true,  color: '#16A34A' },
                { name: 'Cloudflare Stream', active: false, color: '#D97706' },
                { name: 'Mux',               active: false, color: '#D97706' },
                { name: 'Bunny Stream',       active: false, color: '#D97706' },
                { name: 'AWS MediaConvert',   active: false, color: '#D97706' },
              ].map(({ name, active, color }) => (
                <View key={name} style={[neuFlatStyle(isDark),
                  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                    borderRadius: 10, padding: 10 }]}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{name}</Text>
                  <View style={{ backgroundColor: `${color}15`, borderRadius: 6,
                    paddingHorizontal: 8, paddingVertical: 3 }}>
                    <Text style={{ fontSize: 10, fontWeight: '800', color }}>
                      {active ? 'ACTIVE' : 'FUTURE'}
                    </Text>
                  </View>
                </View>
              ))}
            </NeuCard>

          </View>
        )}
      </ScrollView>
    </View>
  );
}
