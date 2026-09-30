/**
 * Storage Monitor — Admin & Super Admin
 *
 * DATA CONTRACT (real measurements only — no fake zeros):
 *   GET /storage/stats (server-measured at request time)
 *     • disk     — disk_total_space/disk_free_space on the deployment volume
 *     • uploads  — recursive byte counts of the app's OWN storage dirs
 *     • database — information_schema sizes (same MySQL connection/perms)
 *
 * FAILURE CONTRACT: a section the server could not measure is ABSENT with a
 * structured reason and renders "unavailable + reason" — a failed measurement
 * is NEVER displayed as 0. Load errors get a proper error + Retry state
 * (never a silent catch — the previous catch(_){} here hid every failure).
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, ActivityIndicator,
  RefreshControl, useColorScheme, Pressable,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Database, HardDrive, Image, Film, FileText, RefreshCw, AlertTriangle, CircleCheck } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { getRealStorageStats, type RealStorageStats } from '@/lib/api';
import { formatBytes } from '@/lib/videoUploadEngine';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, useLayout, safeBottom } from '@/lib/neu';

const BUCKET_LABELS: Record<string, string> = {
  avatars: 'Avatars',
  'user-avatars': 'Avatars (legacy)',
  'course-images': 'Course Images',
  'course-covers': 'Course Covers',
  'lesson-thumbnails': 'Lesson Thumbnails',
  'video-thumbnails': 'Video Thumbnails',
  'app-assets': 'App Assets',
  'lesson-pdfs': 'Lesson PDFs',
  'lesson-materials': 'Lesson Materials',
  'video-chunks': 'Video Chunks',
  'video-uploads': 'Video Uploads',
  'temp-uploads': 'Temp Uploads',
  'patch-uploads': 'Patch Uploads',
};

const BUCKET_ICONS: Record<string, React.ElementType> = {
  avatars: Image, 'user-avatars': Image, 'course-images': Image, 'course-covers': Image,
  'lesson-thumbnails': Image, 'video-thumbnails': Image, 'app-assets': Image,
  'lesson-pdfs': FileText, 'lesson-materials': FileText,
  'video-chunks': Film, 'video-uploads': Film, 'temp-uploads': Film, 'patch-uploads': Film,
};

const REASON_LABELS: Record<string, string> = {
  filesystem_measurement_unavailable: 'The server could not read disk usage for the application volume.',
  database_measurement_unavailable: 'The database size could not be read with the current connection permissions.',
  permission_unavailable: 'Storage permissions unavailable on the server.',
  provider_api_unavailable: 'Hosting provider storage API unavailable.',
  configuration_missing: 'Storage measurement is not configured on the server.',
};

function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return 'Measurement unavailable on the server.';
  return REASON_LABELS[reason] ?? `Storage measurement unavailable (${reason}).`;
}

function SectionUnavailable({ reason, isDark, c }: { reason: string | null | undefined; isDark: boolean; c: any }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 }}>
      <AlertTriangle size={14} color="#D97706" />
      <Text style={{ fontSize: 12, color: c.text, opacity: 0.55, flex: 1 }}>
        {reasonLabel(reason)}
      </Text>
    </View>
  );
}

function StatTile({ label, value, sub, color, Icon }: {
  label: string; value: string; sub?: string; color: string; Icon: React.ElementType;
}) {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  return (
    <NeuCard style={{ flex: 1, padding: 14, alignItems: 'center', gap: 4 }}>
      <Icon size={18} color={color} />
      <Text style={{ fontSize: 17, fontWeight: '900', color }}>{value}</Text>
      <Text style={{ fontSize: 10, color: c.text, opacity: 0.5, textAlign: 'center' }}>{label}</Text>
      {sub ? <Text style={{ fontSize: 9, color: c.text, opacity: 0.35, textAlign: 'center' }}>{sub}</Text> : null}
    </NeuCard>
  );
}

export default function StorageMonitorScreen({ backTo }: { backTo?: string } = {}) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  const [stats, setStats] = useState<RealStorageStats | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setStats(await getRealStorageStats());
    } catch (e: any) {
      setLoadError(e?.message ?? 'Storage statistics could not be loaded.');
    }
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const uploads = stats?.uploads;
  const imageBuckets = uploads?.buckets.filter((b) => BUCKET_ICONS[b.name] === Image) ?? [];
  const otherBuckets = uploads?.buckets.filter((b) => BUCKET_ICONS[b.name] !== Image) ?? [];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />} contentContainerStyle={{ paddingBottom: safeBottom(layout.insets.bottom) }}>
      <PageHeader
        title="Storage Monitor"
        subtitle="Live server-measured storage"
        accentColor="#2DA8FF"
        showBack
        backFallback={backTo ?? '/admin-overview'}
      />

      <View style={{ paddingHorizontal: layout.screenPx, paddingBottom: 24 }}>

        {/* ── Error + Retry — never a silent failure ─────────────────── */}
        {loading ? (
          <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} />
        ) : loadError ? (
          <NeuCard style={{ padding: 24, alignItems: 'center', gap: 12, marginTop: 12 }}>
            <AlertTriangle size={28} color="#DC2626" />
            <Text style={{ fontSize: 14, fontWeight: '800', color: c.text }}>Unable to load storage statistics</Text>
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, textAlign: 'center' }}>{loadError}</Text>
            <Pressable onPress={load}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, backgroundColor: c.primary }}>
              <RefreshCw size={14} color="#fff" />
              <Text style={{ fontSize: 13, fontWeight: '800', color: '#fff' }}>Retry</Text>
            </Pressable>
          </NeuCard>
        ) : stats && (
          <>
            {/* ── Hosting storage (disk the app is deployed on) ─────────── */}
            <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 10 }}>Hosting Storage</Text>
            <NeuCard style={{ marginBottom: 16, padding: 16, gap: 10 }}>
              {stats.disk ? (
                <>
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <StatTile label="Total Space" value={formatBytes(stats.disk.total_bytes)} color={c.primary} Icon={HardDrive} />
                    <StatTile label="Used" value={formatBytes(stats.disk.used_bytes)} color="#D97706" Icon={Database} />
                    <StatTile label="Free" value={formatBytes(stats.disk.free_bytes)} color="#16A34A" Icon={CircleCheck} />
                  </View>
                  {/* Usage bar */}
                  <View style={{ height: 8, borderRadius: 4, backgroundColor: `${c.text}12`, overflow: 'hidden' }}>
                    <View style={{ height: 8, width: `${Math.min(100, stats.disk.used_pct)}%`, backgroundColor: stats.disk.used_pct > 90 ? '#DC2626' : c.primary }} />
                  </View>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>
                    {stats.disk.used_pct}% used · Measured: {stats.measured_root_label}
                  </Text>
                </>
              ) : (
                <SectionUnavailable reason={stats.disk_unavailable_reason} isDark={isDark} c={c} />
              )}
            </NeuCard>

            {/* ── Application uploads (physical files) ───────────────────── */}
            {uploads && (
              <>
                <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 10 }}>Application Uploads</Text>
                <NeuCard style={{ marginBottom: 16, padding: 16, gap: 10 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#7C3AED18', alignItems: 'center', justifyContent: 'center' }}>
                      <HardDrive size={18} color="#7C3AED" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>Total Uploaded Files</Text>
                      <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>
                        Physical size of {uploads.public_dir_label} + {uploads.private_dir_label}
                      </Text>
                    </View>
                    <Text style={{ fontSize: 15, fontWeight: '800', color: '#7C3AED' }}>
                      {formatBytes(uploads.total_bytes)}
                    </Text>
                  </View>

                  {/* Image buckets */}
                  {imageBuckets.length > 0 && (
                    <>
                      <View style={{ height: 1, backgroundColor: `${c.text}10` }} />
                      <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.45, textTransform: 'uppercase' }}>Images</Text>
                      {imageBuckets.map((b) => (
                        <View key={b.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 4 }}>
                          <Image size={13} color={c.primary} />
                          <Text style={{ fontSize: 12, color: c.text, flex: 1 }}>{BUCKET_LABELS[b.name] ?? b.name}</Text>
                          <Text style={{ fontSize: 12, fontWeight: '700', color: c.text, opacity: 0.7 }}>
                            {formatBytes(b.bytes)} · {b.files} files
                          </Text>
                        </View>
                      ))}
                    </>
                  )}

                  {/* Other buckets (docs, video, temp) */}
                  {otherBuckets.length > 0 && (
                    <>
                      <View style={{ height: 1, backgroundColor: `${c.text}10` }} />
                      <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.45, textTransform: 'uppercase' }}>Other Files</Text>
                      {otherBuckets.map((b) => {
                        const Icon = BUCKET_ICONS[b.name] ?? FileText;
                        return (
                          <View key={b.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 4 }}>
                            <Icon size={13} color="#D97706" />
                            <Text style={{ fontSize: 12, color: c.text, flex: 1 }}>{BUCKET_LABELS[b.name] ?? b.name}</Text>
                            <Text style={{ fontSize: 12, fontWeight: '700', color: c.text, opacity: 0.7 }}>
                              {formatBytes(b.bytes)} · {b.files} files
                            </Text>
                          </View>
                        );
                      })}
                    </>
                  )}
                </NeuCard>
              </>
            )}

            {/* ── Database (real information_schema sizes) ───────────────── */}
            <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 10 }}>Database</Text>
            <NeuCard style={{ marginBottom: 16, padding: 16, gap: 10 }}>
              {stats.database ? (
                <>
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <StatTile label="Database Size" value={formatBytes(stats.database.total_bytes)} color={c.primary} Icon={Database} />
                    <StatTile label="Tables" value={String(stats.database.table_count)} color="#7C3AED" Icon={FileText} />
                  </View>
                  {stats.database.largest_tables.length > 0 && (
                    <>
                      <View style={{ height: 1, backgroundColor: `${c.text}10` }} />
                      <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.45, textTransform: 'uppercase' }}>Largest Tables</Text>
                      {stats.database.largest_tables.map((t) => (
                        <View key={t.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                          <Text style={{ fontSize: 12, color: c.text, flex: 1 }} numberOfLines={1}>{t.name}</Text>
                          <Text style={{ fontSize: 12, fontWeight: '700', color: c.text, opacity: 0.7 }}>{formatBytes(t.bytes)}</Text>
                        </View>
                      ))}
                    </>
                  )}
                </>
              ) : (
                <SectionUnavailable reason={stats.database_unavailable_reason} isDark={isDark} c={c} />
              )}
            </NeuCard>

            {/* VdoCipher note — videos are NOT on this disk */}
            <NeuCard style={{ marginBottom: 16, padding: 14, flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <Film size={16} color="#2DA8FF" />
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.55, flex: 1 }}>
                Lesson videos are streamed from VdoCipher (external CDN) and do not consume application storage. Live VdoCipher metrics live in Video Settings.
              </Text>
            </NeuCard>

            <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, textAlign: 'center' }}>
              Last checked: {new Date(stats.checked_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })}
            </Text>
          </>
        )}
      </View>
    </ScrollView>
  );
}
