/**
 * Video Monitor — Admin & Super Admin
 * Video health dashboard: status, verification, storage, recovery, audit logs.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, ActivityIndicator,
  RefreshControl, useColorScheme, Pressable, Image,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  Video, CheckCircle, Clock, XCircle, RefreshCw, Film,
  Upload, Pause, HardDrive, AlertTriangle, Trash2,
  BarChart2, ShieldCheck, ShieldAlert, RotateCcw, ExternalLink,
} from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { supabase } from '@/client/supabase';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, neuFlatStyle, neuPressedStyle, useLayout } from '@/lib/neu';
import { formatBytes } from '@/lib/videoUploadEngine';

type MonitorTab = 'health' | 'uploads' | 'audit';
type HealthFilter = 'all' | 'healthy' | 'failed' | 'verifying' | 'recovering' | 'processing';

const STATUS_MAP: Record<string, { label: string; color: string; Icon: any }> = {
  ready:              { label: 'Ready',         color: '#16A34A', Icon: CheckCircle },
  processing:         { label: 'Processing',    color: '#D97706', Icon: Clock },
  encoding:           { label: 'Encoding',      color: '#7C3AED', Icon: Clock },
  generating_streams: { label: 'Streaming',     color: '#2563EB', Icon: Clock },
  verifying:          { label: 'Verifying',     color: '#2DA8FF', Icon: ShieldCheck },
  uploading:          { label: 'Uploading',     color: '#3B82F6', Icon: Upload },
  waiting:            { label: 'Waiting',       color: '#6B7280', Icon: Clock },
  paused:             { label: 'Paused',        color: '#D97706', Icon: Pause },
  failed:             { label: 'Failed',        color: '#DC2626', Icon: XCircle },
  canceled:           { label: 'Canceled',      color: '#9CA3AF', Icon: XCircle },
  recovering:         { label: 'Recovering',    color: '#D97706', Icon: RotateCcw },
};

const VERIFICATION_MAP: Record<string, { label: string; color: string; Icon: any }> = {
  passed:   { label: 'Verified',    color: '#2DA8FF', Icon: ShieldCheck },
  failed:   { label: 'Error',       color: '#DC2626', Icon: ShieldAlert },
  verifying:{ label: 'Verifying…', color: '#2DA8FF', Icon: ShieldCheck },
  pending:  { label: 'Pending',     color: '#6B7280', Icon: Clock },
  skipped:  { label: 'Skipped',     color: '#9CA3AF', Icon: Clock },
};

export default function VideoMonitorScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const router = useRouter();

  const [uploads, setUploads] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<MonitorTab>('health');
  const [healthFilter, setHealthFilter] = useState<HealthFilter>('all');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ data: uploadData }, { data: auditData }] = await Promise.all([
        supabase
          .from('video_uploads')
          .select(`id, file_name, file_size, mime_type, status, bytes_uploaded,
                   upload_speed_bps, error_message, retry_count, storage_path,
                   thumbnail_url, verification_status, verification_error,
                   verified_at, is_replacement, recovery_state,
                   created_at, upload_started_at, upload_completed_at, ready_at,
                   lesson:lessons(id, title, course_id),
                   course:courses(id, title)`)
          .order('created_at', { ascending: false })
          .limit(200),
        supabase
          .from('upload_audit_logs')
          .select(`id, event, details, created_at, upload:video_uploads(file_name)`)
          .order('created_at', { ascending: false })
          .limit(200),
      ]);
      setUploads(uploadData ?? []);
      setAuditLogs(auditData ?? []);
    } catch (_) {}
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const handleDelete = async (uploadId: string, storagePath: string | null) => {
    if (storagePath) await supabase.storage.from('lesson-materials').remove([storagePath]);
    await supabase.from('video_uploads').delete().eq('id', uploadId);
    setUploads((u) => u.filter((x) => x.id !== uploadId));
  };

  const handleRetry = async (uploadId: string) => {
    await supabase.from('video_uploads').update({
      status: 'waiting', error_message: null,
      verification_status: 'pending', verification_error: null,
    }).eq('id', uploadId);
    setUploads((u) => u.map((x) => x.id === uploadId
      ? { ...x, status: 'waiting', error_message: null, verification_status: 'pending' } : x));
  };

  // ── Health categorization ──────────────────────────────────────────────────
  const healthy    = uploads.filter((u) => u.status === 'ready' && u.verification_status === 'passed');
  const withErrors = uploads.filter((u) => u.status === 'failed' || u.verification_status === 'failed');
  const verifying  = uploads.filter((u) => u.status === 'verifying' || u.verification_status === 'verifying');
  const recovering = uploads.filter((u) => u.recovery_state === 'interrupted' || u.status === 'recovering');
  const processing = uploads.filter((u) => ['processing','encoding','generating_streams'].includes(u.status));

  const totalStorage = healthy.reduce((s, u) => s + (u.file_size ?? 0), 0);

  const HEALTH_TILES = [
    { key: 'healthy' as HealthFilter,    label: 'Healthy',          color: '#16A34A', count: healthy.length,    Icon: CheckCircle },
    { key: 'failed' as HealthFilter,     label: 'Errors',           color: '#DC2626', count: withErrors.length, Icon: ShieldAlert },
    { key: 'verifying' as HealthFilter,  label: 'Verifying',        color: '#2DA8FF', count: verifying.length,  Icon: ShieldCheck },
    { key: 'recovering' as HealthFilter, label: 'Recovery Pending', color: '#D97706', count: recovering.length, Icon: RotateCcw },
  ];

  // Filtered list for health tab
  const healthItems = {
    all:       uploads,
    healthy,
    failed:    withErrors,
    verifying,
    recovering,
    processing,
  }[healthFilter];

  // Filtered list for uploads tab
  const uploadItems = statusFilter ? uploads.filter((u) => u.status === statusFilter) : uploads;

  // ── Render helpers ─────────────────────────────────────────────────────────
  const renderUploadCard = (item: any, showHealthBadge = false) => {
    const statusCfg = STATUS_MAP[item.status ?? 'waiting'] ?? STATUS_MAP.waiting;
    const verCfg = item.verification_status
      ? VERIFICATION_MAP[item.verification_status] ?? VERIFICATION_MAP.pending
      : null;
    const isFailed = item.status === 'failed' || item.verification_status === 'failed';

    return (
      <NeuCard key={item.id} style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 14, gap: 10 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
          {/* Thumbnail or icon */}
          {item.thumbnail_url ? (
            <View style={{ width: 48, height: 48, borderRadius: 10, overflow: 'hidden' }}>
              <Image source={{ uri: item.thumbnail_url }} style={{ width: 48, height: 48 }} resizeMode="cover" />
            </View>
          ) : (
            <View style={{ width: 48, height: 48, borderRadius: 13, backgroundColor: `${statusCfg.color}18`,
              alignItems: 'center', justifyContent: 'center' }}>
              <Film size={22} color={statusCfg.color} />
            </View>
          )}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }} numberOfLines={1}>
              {item.file_name}
            </Text>
            <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }} numberOfLines={1}>
              {item.course?.title ?? '—'} › {item.lesson?.title ?? '—'}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
              <View style={{ backgroundColor: `${statusCfg.color}18`, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}>
                <Text style={{ fontSize: 10, fontWeight: '700', color: statusCfg.color }}>{statusCfg.label}</Text>
              </View>
              {verCfg && (
                <View style={{ backgroundColor: `${verCfg.color}15`, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2,
                  flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                  <verCfg.Icon size={9} color={verCfg.color} />
                  <Text style={{ fontSize: 10, fontWeight: '700', color: verCfg.color }}>{verCfg.label}</Text>
                </View>
              )}
              {item.is_replacement && (
                <View style={{ backgroundColor: '#7C3AED18', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                  <Text style={{ fontSize: 9, fontWeight: '800', color: '#7C3AED' }}>REPLACE</Text>
                </View>
              )}
              <Text style={{ fontSize: 10, color: c.text, opacity: 0.4 }}>{formatBytes(item.file_size ?? 0)}</Text>
              {item.retry_count > 0 && (
                <Text style={{ fontSize: 10, color: '#D97706' }}>Retry ×{item.retry_count}</Text>
              )}
            </View>
          </View>
          {/* Actions */}
          <View style={{ gap: 6 }}>
            {isFailed && (
              <Pressable onPress={() => handleRetry(item.id)} hitSlop={8}
                style={[neuFlatStyle(isDark), { borderRadius: 8, padding: 7 }]}>
                <RefreshCw size={13} color="#3B82F6" />
              </Pressable>
            )}
            {item.lesson?.id && (
              <Pressable hitSlop={8}
                onPress={() => router.push(`/(app)/lesson-editor/${item.lesson.id}` as any)}
                style={[neuFlatStyle(isDark), { borderRadius: 8, padding: 7 }]}>
                <ExternalLink size={13} color={c.primary} />
              </Pressable>
            )}
            <Pressable onPress={() => handleDelete(item.id, item.storage_path)} hitSlop={8}
              style={[neuFlatStyle(isDark), { borderRadius: 8, padding: 7 }]}>
              <Trash2 size={13} color="#DC2626" />
            </Pressable>
          </View>
        </View>

        {/* Error / verification error */}
        {(item.error_message || item.verification_error) && (
          <View style={{ flexDirection: 'row', gap: 6, backgroundColor: '#DC262612', borderRadius: 8, padding: 8 }}>
            <AlertTriangle size={12} color="#DC2626" />
            <Text style={{ fontSize: 11, color: '#DC2626', flex: 1 }} numberOfLines={3}>
              {item.verification_error || item.error_message}
            </Text>
          </View>
        )}
      </NeuCard>
    );
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }}
          contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}>
      <View style={{ padding: layout.screenPx, gap: 16 }}>

        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
          <PageHeader title="Video Monitor" subtitle={`${uploads.length} uploads tracked`} accentColor="#7C3AED" />
          <Pressable onPress={onRefresh}
            style={[neuFlatStyle(isDark), { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center' }]}>
            <RefreshCw size={18} color={c.primary} />
          </Pressable>
        </View>

        {/* Storage summary */}
        <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }]}>
          <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: `${c.primary}18`,
            alignItems: 'center', justifyContent: 'center' }}>
            <HardDrive size={20} color={c.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, fontWeight: '600' }}>Storage Used (ready videos)</Text>
            <Text style={{ fontSize: 20, fontWeight: '800', color: c.primary }}>{formatBytes(totalStorage)}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>{uploads.length} total</Text>
            <Text style={{ fontSize: 12, color: '#16A34A', fontWeight: '700' }}>{healthy.length} healthy</Text>
          </View>
        </NeuCard>

        {/* Health tiles */}
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
          {HEALTH_TILES.map(({ key, label, color, count, Icon }) => {
            const active = healthFilter === key && activeTab === 'health';
            return (
              <Pressable key={key} onPress={() => { setActiveTab('health'); setHealthFilter(active ? 'all' : key); }}
                style={{ flex: 1, minWidth: '45%' }}>
                <NeuCard style={[
                  active ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
                  { borderRadius: 14, padding: 14, alignItems: 'center', gap: 4,
                    borderWidth: active ? 1.5 : 0, borderColor: color },
                ]}>
                  <Icon size={20} color={color} />
                  <Text style={{ fontSize: 24, fontWeight: '800', color }}>{count}</Text>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.5, textAlign: 'center' }}>{label}</Text>
                </NeuCard>
              </Pressable>
            );
          })}
        </View>

        {/* Tab switcher */}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {(['health', 'uploads', 'audit'] as MonitorTab[]).map((t) => (
            <Pressable key={t} onPress={() => setActiveTab(t)}
              style={[
                activeTab === t ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
                { flex: 1, padding: 11, borderRadius: 12, alignItems: 'center' },
              ]}>
              <Text style={{ fontSize: 12, fontWeight: '700',
                color: activeTab === t ? c.primary : `${c.text}70` }}>
                {t === 'health' ? 'Health' : t === 'uploads' ? 'All Uploads' : 'Audit Log'}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Content */}
        {loading ? (
          <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} />
        ) : activeTab === 'health' ? (
          <View style={{ gap: 10 }}>
            {healthItems.length === 0 ? (
              <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 36, alignItems: 'center', gap: 10 }]}>
                <CheckCircle size={34} color={`${c.primary}40`} />
                <Text style={{ color: c.text, opacity: 0.4, fontWeight: '600' }}>No videos in this category</Text>
              </NeuCard>
            ) : healthItems.map((item) => renderUploadCard(item, true))}
          </View>

        ) : activeTab === 'uploads' ? (
          <View style={{ gap: 10 }}>
            {/* Status filter chips */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8, paddingBottom: 4 }}>
              {['ready','uploading','processing','failed','canceled','recovering'].map((s) => {
                const cfg = STATUS_MAP[s];
                const active = statusFilter === s;
                return (
                  <Pressable key={s} onPress={() => setStatusFilter(active ? null : s)}
                    style={[active ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
                      { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10,
                        borderWidth: active ? 1.5 : 0, borderColor: cfg?.color ?? '#888' }]}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: active ? cfg?.color : `${c.text}70` }}>
                      {cfg?.label ?? s}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            {uploadItems.length === 0 ? (
              <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 36, alignItems: 'center', gap: 10 }]}>
                <Film size={34} color={`${c.primary}40`} />
                <Text style={{ color: c.text, opacity: 0.4 }}>No uploads found</Text>
              </NeuCard>
            ) : uploadItems.map((item) => renderUploadCard(item))}
          </View>

        ) : (
          // Audit log
          auditLogs.length === 0 ? (
            <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 36, alignItems: 'center', gap: 10 }]}>
              <BarChart2 size={34} color={`${c.primary}40`} />
              <Text style={{ color: c.text, opacity: 0.4 }}>No audit records yet</Text>
            </NeuCard>
          ) : (
            <View style={{ gap: 8 }}>
              {auditLogs.map((log) => {
                const EVENT_COLORS: Record<string, string> = {
                  upload_completed: '#16A34A', ready: '#16A34A',
                  upload_started: '#3B82F6', upload_resumed: '#3B82F6',
                  upload_failed: '#DC2626', upload_canceled: '#9CA3AF',
                  upload_paused: '#D97706', video_deleted: '#DC2626',
                  video_replaced: '#7C3AED', verification_passed: '#2DA8FF',
                  verification_failed: '#DC2626', thumbnail_generated: '#16A34A',
                  recovery_detected: '#D97706', recovery_started: '#D97706',
                };
                const color = EVENT_COLORS[log.event] ?? '#6B7280';
                const ts = new Date(log.created_at);
                return (
                  <View key={log.id} style={[neuFlatStyle(isDark),
                    { borderRadius: 12, padding: 12, flexDirection: 'row', gap: 10, alignItems: 'flex-start' }]}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color, marginTop: 4 }} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ fontSize: 12, fontWeight: '700', color }}>
                        {log.event.replace(/_/g, ' ')}
                      </Text>
                      <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }} numberOfLines={1}>
                        {(log.upload as any)?.file_name ?? '—'}
                      </Text>
                    </View>
                    <Text style={{ fontSize: 10, color: c.text, opacity: 0.35 }}>
                      {ts.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} {ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}
                    </Text>
                  </View>
                );
              })}
            </View>
          )
        )}
      </View>
    </ScrollView>
  );
}
