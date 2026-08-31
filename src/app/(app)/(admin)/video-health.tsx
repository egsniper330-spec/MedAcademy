/**
 * video-health.tsx
 * Video Health Monitor — Super Admin
 * Full health dashboard, searchable table, bulk actions, scan controls.
 */
import { useCallback, useState } from 'react';
import {
  ActivityIndicator, FlatList, Image, Pressable, RefreshControl,
  ScrollView, Text, TextInput, useColorScheme, View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Activity, AlertTriangle, Archive, BarChart2, CheckCircle, Clock,
  Download, Film, HardDrive, RefreshCw, RotateCcw, Search,
  ShieldAlert, ShieldCheck, Trash2, Upload, XCircle, Zap,
} from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { VideoHealthDetails } from '@/components/VideoHealthDetails';
import { backendClient } from '@/client/backendClient';
import { neuColors, useLayout, neuFlatStyle, neuPressedStyle, safeBottom } from '@/lib/neu';
import { formatBytes } from '@/lib/videoUploadEngine';
import { exportCSV } from '@/lib/exportUtils';

// ─── Types ────────────────────────────────────────────────────────────────────
type HealthFilter =
  | 'all' | 'healthy' | 'uploading' | 'processing' | 'encoding'
  | 'verification_failed' | 'broken' | 'no_thumbnail' | 'recovering'
  | 'deleted' | 'archived';

type SortKey = 'created_at' | 'file_size' | 'health_score' | 'status';

// ─── Status config ─────────────────────────────────────────────────────────────
const STATUS_CFG: Record<string, { label: string; color: string; Icon: any }> = {
  ready:              { label: 'Ready',               color: '#16A34A', Icon: CheckCircle },
  uploading:          { label: 'Uploading',           color: '#3B82F6', Icon: Upload },
  waiting:            { label: 'Waiting',             color: '#6B7280', Icon: Clock },
  processing:         { label: 'Processing',          color: '#D97706', Icon: Clock },
  encoding:           { label: 'Encoding',            color: '#7C3AED', Icon: Activity },
  generating_streams: { label: 'Streaming',           color: '#2563EB', Icon: Activity },
  verifying:          { label: 'Verifying',           color: '#2DA8FF', Icon: ShieldCheck },
  failed:             { label: 'Failed',              color: '#DC2626', Icon: XCircle },
  canceled:           { label: 'Canceled',            color: '#9CA3AF', Icon: XCircle },
  recovering:         { label: 'Recovering',          color: '#D97706', Icon: RotateCcw },
  archived:           { label: 'Archived',            color: '#6B7280', Icon: Archive },
};

// ─── Summary tile ──────────────────────────────────────────────────────────────
function SummaryTile({
  label, value, color, Icon, active, onPress,
}: { label: string; value: string | number; color: string; Icon: any; active: boolean; onPress: () => void }) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  return (
    <Pressable onPress={onPress} style={{ width: '48%' }}>
      <NeuCard style={[
        active ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
        { borderRadius: 14, padding: 14, gap: 5, alignItems: 'center',
          borderWidth: active ? 1.5 : 0, borderColor: color },
      ]}>
        <Icon size={18} color={color} />
        <Text style={{ fontSize: 22, fontWeight: '900', color }}>{value}</Text>
        <Text style={{ fontSize: 10, color: c.text, opacity: 0.5, textAlign: 'center' }}>{label}</Text>
      </NeuCard>
    </Pressable>
  );
}

// ─── Health score ring ─────────────────────────────────────────────────────────
function HealthScoreBadge({ pct, isDark }: { pct: number; isDark: boolean }) {
  const color = pct >= 90 ? '#16A34A' : pct >= 70 ? '#D97706' : '#DC2626';
  const label = pct >= 90 ? 'Healthy' : pct >= 70 ? 'Attention Required' : 'Critical';
  return (
    <View style={{ alignItems: 'center', gap: 4 }}>
      <Text style={{ fontSize: 40, fontWeight: '900', color }}>{pct.toFixed(1)}%</Text>
      <Text style={{ fontSize: 13, fontWeight: '700', color }}>{label}</Text>
    </View>
  );
}

// ─── Video row card ────────────────────────────────────────────────────────────
function VideoRow({
  item, isDark, selected, onSelect, onPress, onScan, onDelete,
}: {
  item: any; isDark: boolean; selected: boolean;
  onSelect: () => void; onPress: () => void;
  onScan: () => void; onDelete: () => void;
}) {
  const c = isDark ? neuColors.dark : neuColors.light;
  const cfg = STATUS_CFG[item.status ?? 'waiting'] ?? STATUS_CFG.waiting;
  const verFailed = item.verification_status === 'failed';
  const noThumb = !item.thumbnail_url;

  return (
    <Pressable onPress={onPress}>
      <NeuCard style={[
        neuFlatStyle(isDark),
        { borderRadius: 14, padding: 12, flexDirection: 'row', alignItems: 'flex-start', gap: 10,
          borderWidth: selected ? 1.5 : 0, borderColor: c.primary },
      ]}>
        {/* Select checkbox */}
        <Pressable onPress={onSelect} hitSlop={8}
          style={[{ width: 20, height: 20, borderRadius: 6, marginTop: 2, alignItems: 'center', justifyContent: 'center' },
            selected ? { backgroundColor: c.primary } : neuPressedStyle(isDark)]}>
          {selected && <CheckCircle size={13} color="#fff" />}
        </Pressable>

        {/* Thumbnail */}
        {item.thumbnail_url ? (
          <View style={{ width: 48, height: 48, borderRadius: 10, overflow: 'hidden' }}>
            <Image source={{ uri: item.thumbnail_url }} style={{ width: 48, height: 48 }} resizeMode="cover" />
          </View>
        ) : (
          <View style={{ width: 48, height: 48, borderRadius: 12, backgroundColor: `${cfg.color}15`,
            alignItems: 'center', justifyContent: 'center' }}>
            <Film size={22} color={cfg.color} />
          </View>
        )}

        {/* Info */}
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }} numberOfLines={1}>
            {item.file_name}
          </Text>
          <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }} numberOfLines={1}>
            {item.course?.title ?? '—'} › {item.lesson?.title ?? '—'}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 3 }}>
            <View style={{ backgroundColor: `${cfg.color}15`, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 }}>
              <Text style={{ fontSize: 9, fontWeight: '800', color: cfg.color }}>{cfg.label}</Text>
            </View>
            {verFailed && (
              <View style={{ backgroundColor: '#DC262615', borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 }}>
                <Text style={{ fontSize: 9, fontWeight: '800', color: '#DC2626' }}>VER FAILED</Text>
              </View>
            )}
            {noThumb && (
              <View style={{ backgroundColor: '#D9770615', borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 }}>
                <Text style={{ fontSize: 9, fontWeight: '800', color: '#D97706' }}>NO THUMB</Text>
              </View>
            )}
            {item.health_score != null && (
              <View style={{ backgroundColor: `${item.health_score >= 80 ? '#16A34A' : '#DC2626'}15`,
                borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 }}>
                <Text style={{ fontSize: 9, fontWeight: '800',
                  color: item.health_score >= 80 ? '#16A34A' : '#DC2626' }}>
                  {item.health_score}%
                </Text>
              </View>
            )}
            <Text style={{ fontSize: 9, color: c.text, opacity: 0.4 }}>
              {`${formatBytes(item.file_size ?? 0)}${item.video_resolution ? ` · ${item.video_resolution}` : ''}`}
            </Text>
          </View>
        </View>

        {/* Actions */}
        <View style={{ gap: 5 }}>
          <Pressable onPress={onScan} hitSlop={8}
            style={[neuFlatStyle(isDark), { borderRadius: 8, padding: 7 }]}>
            <ShieldCheck size={13} color="#2DA8FF" />
          </Pressable>
          <Pressable onPress={onDelete} hitSlop={8}
            style={[neuFlatStyle(isDark), { borderRadius: 8, padding: 7 }]}>
            <Trash2 size={13} color="#DC2626" />
          </Pressable>
        </View>
      </NeuCard>
    </Pressable>
  );
}

// ─── Main screen ───────────────────────────────────────────────────────────────
export default function VideoHealthScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const insets = layout.insets;

  const [uploads, setUploads] = useState<any[]>([]);
  const [dailyReport, setDailyReport] = useState<any>(null);
  const [providerInfo, setProviderInfo] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanAllProgress, setScanAllProgress] = useState<string | null>(null);

  const [activeFilter, setActiveFilter] = useState<HealthFilter>('all');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [detailUpload, setDetailUpload] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'videos' | 'alerts' | 'reports'>('dashboard');
  const [alerts, setAlerts] = useState<any[]>([]);
  const [loadingAlerts, setLoadingAlerts] = useState(false);

  const load = useCallback(async () => {
    try {
      const [{ data: uploadData }, { data: vdoLessons }, { data: report }, { data: provider }] = await Promise.all([
        // Plyr / upload-based videos
        backendClient
          .from('video_uploads')
          .select(`id, file_name, file_size, mime_type, status, bytes_uploaded,
                   error_message, retry_count, storage_path, public_url,
                   thumbnail_url, verification_status, verification_error,
                   verified_at, is_replacement, recovery_state, provider,
                   provider_video_id, health_score, last_health_check_at,
                   playback_status, thumbnail_missing, archived_at,
                   video_resolution, video_duration_sec,
                   created_at, upload_completed_at, ready_at,
                   lesson:lessons(id, title),
                   course:courses(id, title)`)
          .order('created_at', { ascending: false })
          .limit(500),
        // VdoCipher videos stored directly in lessons (no video_upload row)
        backendClient
          .from('lessons')
          .select('id, title, video_type, video_id, video_status, created_at, course:courses(id, title)')
          .eq('video_type', 'vdocipher')
          .not('video_id', 'is', null)
          .neq('video_id', '')
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(500),
        backendClient
          .from('video_daily_health_reports')
          .select('*')
          .order('report_date', { ascending: false })
          .limit(1)
          .maybeSingle(),
        backendClient
          .from('video_provider_config')
          .select('*')
          .eq('is_default', true)
          .maybeSingle(),
      ]);

      // Normalize VdoCipher lessons into the same shape as video_upload rows
      const vdoRows = (vdoLessons ?? []).map((l: any) => ({
        id:                 `vdo-${l.id}`,
        file_name:          l.title ?? `VdoCipher: ${l.video_id}`,
        file_size:          null,
        mime_type:          'video/vdocipher',
        status:             l.video_status === 'ready' ? 'ready' : (l.video_status ?? 'processing'),
        bytes_uploaded:     null,
        error_message:      null,
        retry_count:        0,
        storage_path:       null,
        public_url:         null,
        thumbnail_url:      null,
        verification_status:'skipped',
        verification_error: null,
        verified_at:        null,
        is_replacement:     false,
        recovery_state:     null,
        provider:           'vdocipher',
        provider_video_id:  l.video_id,
        health_score:       l.video_status === 'ready' ? 100 : null,
        last_health_check_at: null,
        playback_status:    l.video_status === 'ready' ? 'ok' : null,
        thumbnail_missing:  true,
        archived_at:        null,
        video_resolution:   null,
        video_duration_sec: null,
        created_at:         l.created_at,
        upload_completed_at:null,
        ready_at:           null,
        lesson:             { id: l.id, title: l.title },
        course:             l.course,
      }));

      setUploads([...(uploadData ?? []), ...vdoRows]);
      setDailyReport(report);
      setProviderInfo(provider);
    } catch (_) {}
    setLoading(false);
  }, []);

  const loadAlerts = useCallback(async () => {
    setLoadingAlerts(true);
    const { data } = await backendClient
      .from('video_health_alerts')
      .select(`*, upload:video_uploads(file_name, lesson:lessons(title), course:courses(title))`)
      .eq('resolved', false)
      .order('created_at', { ascending: false })
      .limit(100);
    setAlerts(data ?? []);
    setLoadingAlerts(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // ── Stats ──────────────────────────────────────────────────────────────────
  const total        = uploads.length;
  const healthy      = uploads.filter((u) => u.status === 'ready' && u.verification_status === 'passed');
  const uploading    = uploads.filter((u) => u.status === 'uploading');
  const processing   = uploads.filter((u) => u.status === 'processing');
  const encoding     = uploads.filter((u) => u.status === 'encoding');
  const verFailed    = uploads.filter((u) => u.verification_status === 'failed');
  const broken       = uploads.filter((u) => u.status === 'failed' || u.playback_status === 'error');
  const noThumb      = uploads.filter((u) => !u.thumbnail_url);
  const recovering   = uploads.filter((u) => u.status === 'recovering' || u.recovery_state === 'interrupted');
  const archived     = uploads.filter((u) => !!u.archived_at);
  const totalStorage = uploads.reduce((s, u) => s + (u.file_size ?? 0), 0);
  const avgSize      = total > 0 ? totalStorage / total : 0;
  const largest      = uploads.reduce((mx, u) => Math.max(mx, u.file_size ?? 0), 0);
  const healthPct    = dailyReport?.health_pct ??
    (total > 0 ? Math.round((healthy.length / total) * 10000) / 100 : 100);

  const filterMap: Record<HealthFilter, any[]> = {
    all: uploads, healthy, uploading, processing, encoding,
    verification_failed: verFailed, broken, no_thumbnail: noThumb,
    recovering, deleted: [], archived,
  };

  // ── Search + filter ────────────────────────────────────────────────────────
  const baseList = filterMap[activeFilter] ?? uploads;
  const q = search.toLowerCase();
  const filtered = q
    ? baseList.filter((u) =>
        u.file_name?.toLowerCase().includes(q) ||
        u.course?.title?.toLowerCase().includes(q) ||
        u.lesson?.title?.toLowerCase().includes(q),
      )
    : baseList;

  const sorted = [...filtered].sort((a, b) => {
    if (sortKey === 'file_size') return (b.file_size ?? 0) - (a.file_size ?? 0);
    if (sortKey === 'health_score') return (b.health_score ?? 0) - (a.health_score ?? 0);
    if (sortKey === 'status') return (a.status ?? '').localeCompare(b.status ?? '');
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  // ── Scan all ───────────────────────────────────────────────────────────────
  const handleScanAll = async () => {
    setScanning(true);
    setScanAllProgress('Starting scan…');
    try {
      const { data, error } = await backendClient.functions.invoke('video-health-scan', {
        body: { action: 'scan_all' },
      });
      if (error) throw error;
      setScanAllProgress(
        `Scan complete: ${data.passed} passed, ${data.failed} failed — Health: ${data.healthPct}%`,
      );
      await load();
    } catch (e) {
      setScanAllProgress(`Scan failed: ${String(e)}`);
    }
    setScanning(false);
  };

  // ── Scan single ────────────────────────────────────────────────────────────
  const handleScanOne = async (uploadId: string) => {
    await backendClient.functions.invoke('video-health-scan', {
      body: { action: 'scan_one', upload_id: uploadId },
    });
    await load();
  };

  // ── Delete ─────────────────────────────────────────────────────────────────
  const handleDelete = async (uploadId: string, storagePath: string | null) => {
    if (storagePath) await backendClient.storage.from('lesson-materials').remove([storagePath]);
    await backendClient.from('video_uploads').delete().eq('id', uploadId);
    setUploads((u) => u.filter((x) => x.id !== uploadId));
    setSelectedIds((s) => { s.delete(uploadId); return new Set(s); });
  };

  // ── Bulk actions ───────────────────────────────────────────────────────────
  const handleBulkRetry = async () => {
    for (const id of selectedIds) {
      await backendClient.from('video_uploads').update({
        status: 'waiting', error_message: null, verification_status: 'pending',
      }).eq('id', id);
    }
    setSelectedIds(new Set());
    await load();
  };

  const handleBulkScan = async () => {
    for (const id of selectedIds) await handleScanOne(id);
    setSelectedIds(new Set());
  };

  const handleBulkDelete = async () => {
    for (const id of selectedIds) {
      const u = uploads.find((x) => x.id === id);
      await handleDelete(id, u?.storage_path ?? null);
    }
  };

  const handleResolveAlert = async (alertId: string) => {
    await backendClient.from('video_health_alerts').update({
      resolved: true, resolved_at: new Date().toISOString(),
    }).eq('id', alertId);
    setAlerts((a) => a.filter((x) => x.id !== alertId));
  };

  // ── Toggle select ──────────────────────────────────────────────────────────
  const toggleSelect = (id: string) => {
    setSelectedIds((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const TILES = [
    { key: 'healthy' as HealthFilter,             label: 'Healthy',          color: '#16A34A', Icon: CheckCircle,  value: healthy.length },
    { key: 'uploading' as HealthFilter,           label: 'Uploading',        color: '#3B82F6', Icon: Upload,       value: uploading.length },
    { key: 'processing' as HealthFilter,          label: 'Processing',       color: '#D97706', Icon: Activity,     value: processing.length },
    { key: 'encoding' as HealthFilter,            label: 'Encoding',         color: '#7C3AED', Icon: Zap,          value: encoding.length },
    { key: 'verification_failed' as HealthFilter, label: 'Verify Failed',    color: '#DC2626', Icon: ShieldAlert,  value: verFailed.length },
    { key: 'broken' as HealthFilter,              label: 'Broken',           color: '#DC2626', Icon: XCircle,      value: broken.length },
    { key: 'no_thumbnail' as HealthFilter,        label: 'No Thumbnail',     color: '#D97706', Icon: Film,         value: noThumb.length },
    { key: 'recovering' as HealthFilter,          label: 'Recovery Pending', color: '#D97706', Icon: RotateCcw,    value: recovering.length },
  ];

  const TABS = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'videos',    label: `Videos (${total})` },
    { key: 'alerts',    label: `Alerts (${alerts.length})` },
    { key: 'reports',   label: 'Reports' },
  ] as const;

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
        style={{ flex: 1 }}>
        <View style={{ padding: layout.screenPx, gap: 16, paddingBottom: layout.scrollBottom() }}>

          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
            <PageHeader title="Video Health" subtitle={`Platform health monitor`} accentColor="#2DA8FF" />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pressable onPress={onRefresh}
                style={[neuFlatStyle(isDark), { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' }]}>
                <RefreshCw size={16} color={c.primary} />
              </Pressable>
              <Pressable onPress={handleScanAll} disabled={scanning}
                style={[neuPressedStyle(isDark), { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 11,
                  flexDirection: 'row', gap: 6, alignItems: 'center', backgroundColor: scanning ? `${c.primary}40` : c.primary }]}>
                {scanning ? <ActivityIndicator size={13} color="#fff" /> : <ShieldCheck size={13} color="#fff" />}
                <Text style={{ fontSize: 12, fontWeight: '800', color: '#fff' }}>
                  {scanning ? 'Scanning…' : 'Scan All'}
                </Text>
              </Pressable>
            </View>
          </View>

          {/* Scan progress */}
          {scanAllProgress && (
            <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 12, padding: 12, flexDirection: 'row', gap: 8, alignItems: 'center' }]}>
              <Activity size={14} color={c.primary} />
              <Text style={{ fontSize: 12, color: c.text, flex: 1 }}>{scanAllProgress}</Text>
              <Pressable onPress={() => setScanAllProgress(null)} hitSlop={8}>
                <XCircle size={14} color={`${c.text}50`} />
              </Pressable>
            </NeuCard>
          )}

          {/* Tabs */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ flexDirection: 'row', gap: 8 }}>
            {TABS.map(({ key, label }) => (
              <Pressable key={key}
                onPress={() => {
                  setActiveTab(key);
                  if (key === 'alerts' && alerts.length === 0) loadAlerts();
                }}
                style={[
                  activeTab === key ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
                  { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10 },
                ]}>
                <Text style={{ fontSize: 12, fontWeight: '700',
                  color: activeTab === key ? c.primary : `${c.text}70` }}>
                  {label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          {loading ? (
            <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} />
          ) : (

            // ── DASHBOARD ────────────────────────────────────────────────────
            activeTab === 'dashboard' ? (
              <View style={{ gap: 14 }}>
                {/* Health score */}
                <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 18, padding: 20, alignItems: 'center', gap: 10 }]}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: c.text, opacity: 0.5 }}>
                    PLATFORM VIDEO HEALTH
                  </Text>
                  <HealthScoreBadge pct={healthPct} isDark={isDark} />
                  {dailyReport && (
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.35 }}>
                      Last scan: {new Date(dailyReport.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </Text>
                  )}
                </NeuCard>

                {/* Provider status */}
                {providerInfo && (
                  <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 14, flexDirection: 'row', gap: 12, alignItems: 'center' }]}>
                    <View style={{ width: 42, height: 42, borderRadius: 11, backgroundColor: `${c.primary}18`,
                      alignItems: 'center', justifyContent: 'center' }}>
                      <Activity size={20} color={c.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>
                        {providerInfo.display_name}
                      </Text>
                      <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>Video Provider</Text>
                    </View>
                    <View style={{
                      backgroundColor: providerInfo.health_status === 'online' ? '#16A34A18' : '#DC262618',
                      borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4,
                    }}>
                      <Text style={{
                        fontSize: 11, fontWeight: '800',
                        color: providerInfo.health_status === 'online' ? '#16A34A' : '#DC2626',
                        textTransform: 'uppercase',
                      }}>
                        {providerInfo.health_status}
                      </Text>
                    </View>
                  </NeuCard>
                )}

                {/* Storage summary */}
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  {[
                    { label: 'Total Storage', value: formatBytes(totalStorage), Icon: HardDrive, color: c.primary },
                    { label: 'Avg Size',       value: formatBytes(avgSize),      Icon: BarChart2, color: '#7C3AED' },
                    { label: 'Largest',        value: formatBytes(largest),      Icon: Film,      color: '#D97706' },
                    { label: 'Total Videos',   value: String(total),             Icon: Film,      color: '#2DA8FF' },
                  ].map(({ label, value, Icon: Ic, color }) => (
                    <NeuCard key={label} style={[neuFlatStyle(isDark),
                      { flex: 1, borderRadius: 12, padding: 10, alignItems: 'center', gap: 4 }]}>
                      <Ic size={14} color={color} />
                      <Text style={{ fontSize: 13, fontWeight: '800', color }} numberOfLines={1}>{value}</Text>
                      <Text style={{ fontSize: 9, color: c.text, opacity: 0.4, textAlign: 'center' }}>{label}</Text>
                    </NeuCard>
                  ))}
                </View>

                {/* Status tiles */}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                  {TILES.map(({ key, label, color, Icon: Ic, value }) => (
                    <SummaryTile key={key} label={label} value={value} color={color} Icon={Ic}
                      active={activeFilter === key && (activeTab as string) === 'videos'}
                      onPress={() => { setActiveFilter(key); setActiveTab('videos'); }} />
                  ))}
                </View>

                {/* Daily report */}
                {dailyReport && (
                  <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 14, gap: 10 }]}>
                    <Text style={{ fontSize: 13, fontWeight: '800', color: c.text }}>Last Daily Report</Text>
                    {[
                      { label: 'Date',     value: dailyReport.report_date },
                      { label: 'Healthy',  value: `${dailyReport.healthy_count} / ${dailyReport.total_videos}` },
                      { label: 'Broken',   value: String(dailyReport.broken_count) },
                      { label: 'Health %', value: `${dailyReport.health_pct}%` },
                      { label: 'Duration', value: `${dailyReport.scan_duration_s ?? 0}s` },
                    ].map(({ label, value }) => (
                      <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>{label}</Text>
                        <Text style={{ fontSize: 12, fontWeight: '600', color: c.text }}>{value}</Text>
                      </View>
                    ))}
                  </NeuCard>
                )}
              </View>

            // ── VIDEOS ────────────────────────────────────────────────────────
            ) : activeTab === 'videos' ? (
              <View style={{ gap: 12 }}>
                {/* Search bar */}
                <View style={[neuPressedStyle(isDark), { borderRadius: 13, flexDirection: 'row',
                  alignItems: 'center', paddingHorizontal: 12, paddingVertical: 11, gap: 8, minWidth: 0 }]}>
                  <Search size={15} color={`${c.text}60`} style={{ flexShrink: 0 }} />
                  <TextInput
                    value={search} onChangeText={setSearch}
                    placeholder="Search by course, lesson, or file name…"
                    placeholderTextColor={`${c.text}50`}
                    style={{ flex: 1, minWidth: 0, fontSize: 13, color: c.text, paddingVertical: 0 }}
                  />
                  {search.length > 0 && (
                    <Pressable onPress={() => setSearch('')} hitSlop={8}>
                      <XCircle size={15} color={`${c.text}50`} />
                    </Pressable>
                  )}
                </View>

                {/* Filter chips */}
                <ScrollView horizontal showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 8, paddingBottom: 2 }}>
                  {(['all', 'healthy', 'broken', 'verification_failed', 'no_thumbnail', 'recovering', 'processing', 'uploading'] as HealthFilter[]).map((f) => (
                    <Pressable key={f} onPress={() => setActiveFilter(f)}
                      style={[
                        activeFilter === f ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
                        { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9 },
                      ]}>
                      <Text style={{ fontSize: 11, fontWeight: '700',
                        color: activeFilter === f ? c.primary : `${c.text}70` }}>
                        {f === 'all' ? `All (${total})` : f.replace(/_/g, ' ')}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>

                {/* Sort */}
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {([['created_at', 'Date'], ['file_size', 'Size'], ['health_score', 'Health'], ['status', 'Status']] as [SortKey, string][]).map(([key, label]) => (
                    <Pressable key={key} onPress={() => setSortKey(key)}
                      style={[
                        sortKey === key ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
                        { flex: 1, padding: 8, borderRadius: 9, alignItems: 'center' },
                      ]}>
                      <Text style={{ fontSize: 11, fontWeight: '700',
                        color: sortKey === key ? c.primary : `${c.text}60` }}>
                        {label}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {/* Bulk actions bar */}
                {selectedIds.size > 0 && (
                  <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 12, padding: 10, flexDirection: 'row', gap: 8,
                    alignItems: 'center', borderWidth: 1.5, borderColor: c.primary }]}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary, flex: 1 }}>
                      {selectedIds.size} selected
                    </Text>
                    {[
                      { label: 'Retry', onPress: handleBulkRetry, color: '#3B82F6', Icon: RefreshCw },
                      { label: 'Scan',  onPress: handleBulkScan,  color: '#2DA8FF', Icon: ShieldCheck },
                      { label: 'Delete',onPress: handleBulkDelete, color: '#DC2626', Icon: Trash2 },
                    ].map(({ label, onPress, color, Icon: Ic }) => (
                      <Pressable key={label} onPress={onPress}
                        style={[neuFlatStyle(isDark), { flexDirection: 'row', gap: 4, paddingHorizontal: 10,
                          paddingVertical: 7, borderRadius: 8, alignItems: 'center' }]}>
                        <Ic size={12} color={color} />
                        <Text style={{ fontSize: 11, fontWeight: '700', color }}>{label}</Text>
                      </Pressable>
                    ))}
                    <Pressable onPress={() => setSelectedIds(new Set())} hitSlop={8}>
                      <XCircle size={16} color={`${c.text}50`} />
                    </Pressable>
                  </NeuCard>
                )}

                {/* Video list */}
                {sorted.length === 0 ? (
                  <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 36, alignItems: 'center', gap: 10 }]}>
                    <Film size={32} color={`${c.text}25`} />
                    <Text style={{ color: c.text, opacity: 0.4 }}>No videos match this filter</Text>
                  </NeuCard>
                ) : sorted.map((item) => (
                  <VideoRow key={item.id} item={item} isDark={isDark}
                    selected={selectedIds.has(item.id)}
                    onSelect={() => toggleSelect(item.id)}
                    onPress={() => setDetailUpload(item)}
                    onScan={() => handleScanOne(item.id)}
                    onDelete={() => handleDelete(item.id, item.storage_path)}
                  />
                ))}
              </View>

            // ── ALERTS ────────────────────────────────────────────────────────
            ) : activeTab === 'alerts' ? (
              loadingAlerts ? (
                <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} />
              ) : alerts.length === 0 ? (
                <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 36, alignItems: 'center', gap: 10 }]}>
                  <CheckCircle size={32} color="#16A34A40" />
                  <Text style={{ color: '#16A34A', fontWeight: '700' }}>No active alerts</Text>
                </NeuCard>
              ) : (
                <View style={{ gap: 10 }}>
                  {alerts.map((alert) => {
                    const sevColor = alert.severity === 'critical' ? '#DC2626' : '#D97706';
                    return (
                      <NeuCard key={alert.id} style={[neuFlatStyle(isDark),
                        { borderRadius: 14, padding: 14, gap: 8,
                          borderLeftWidth: 3, borderLeftColor: sevColor }]}>
                        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
                          <AlertTriangle size={16} color={sevColor} />
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 13, fontWeight: '700', color: sevColor }}>{alert.title}</Text>
                            <Text style={{ fontSize: 12, color: c.text, opacity: 0.6, marginTop: 2 }}>
                              {(alert.upload as any)?.file_name ?? '—'}
                            </Text>
                            <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>{alert.message}</Text>
                          </View>
                          <Pressable onPress={() => handleResolveAlert(alert.id)} hitSlop={8}
                            style={[neuFlatStyle(isDark), { borderRadius: 8, padding: 6 }]}>
                            <CheckCircle size={14} color="#16A34A" />
                          </Pressable>
                        </View>
                        <Text style={{ fontSize: 10, color: c.text, opacity: 0.3 }}>
                          {new Date(alert.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </Text>
                      </NeuCard>
                    );
                  })}
                </View>
              )

            // ── REPORTS ───────────────────────────────────────────────────────
            ) : (
              <View style={{ gap: 12 }}>
                <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 16, gap: 12 }]}>
                  <Text style={{ fontSize: 14, fontWeight: '800', color: c.text }}>Export Report</Text>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.55, lineHeight: 18 }}>
                    Export the full video health report including status, doctor, course, errors, storage, and upload dates.
                  </Text>
                  {(['CSV', 'JSON'] as const).map((fmt) => (
                    <Pressable key={fmt}
                      onPress={async () => {
                        const rows = uploads.map((u) => ({
                          file: u.file_name, status: u.status,
                          verification: u.verification_status ?? '',
                          health: u.health_score ?? '',
                          course: u.course?.title ?? '',
                          lesson: u.lesson?.title ?? '',
                          size: u.file_size ?? 0,
                          resolution: u.video_resolution ?? '',
                          provider: u.provider ?? 'medacademy',
                          created: u.created_at,
                          error: u.error_message ?? u.verification_error ?? '',
                        }));
                        if (fmt === 'CSV') {
                          exportCSV(rows, Object.keys(rows[0] ?? {}), 'video-health-report');
                        }
                      }}
                      style={[neuFlatStyle(isDark), { flexDirection: 'row', gap: 8, padding: 13,
                        borderRadius: 12, alignItems: 'center' }]}>
                      <Download size={15} color={c.primary} />
                      <Text style={{ fontSize: 13, fontWeight: '700', color: c.primary }}>
                        Export {fmt}
                      </Text>
                    </Pressable>
                  ))}
                </NeuCard>
              </View>
            )
          )}
        </View>
      </ScrollView>

      {/* Video details modal */}
      <VideoHealthDetails
        upload={detailUpload}
        visible={!!detailUpload}
        onClose={() => setDetailUpload(null)}
        onScanComplete={() => { load(); setDetailUpload(null); }}
      />
    </View>
  );
}
