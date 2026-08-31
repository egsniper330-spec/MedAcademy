/**
 * VideoHealthDetails.tsx
 * Modal showing full details for a single video upload:
 * metadata, health checks, audit logs, storage info.
 */
import { useCallback, useState } from 'react';
import {
  ActivityIndicator, Image, Modal, Pressable, ScrollView,
  Text, useColorScheme, View,
} from 'react-native';
import {
  X, Film, ShieldCheck, ShieldAlert, Clock, CheckCircle,
  XCircle, HardDrive, RefreshCw, ExternalLink, AlertTriangle,
  RotateCcw, Layers, FileText,
} from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { backendClient } from '@/client/backendClient';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, neuFlatStyle, neuPressedStyle } from '@/lib/neu';
import { formatBytes } from '@/lib/videoUploadEngine';

type CheckStatus = 'pass' | 'fail' | 'skip' | 'error' | 'running';

interface Props {
  upload: any;
  visible: boolean;
  onClose: () => void;
  onScanComplete?: () => void;
}

const CHECK_LABELS: Record<string, string> = {
  metadata: 'Metadata',
  playback: 'Playback URL',
  thumbnail: 'Thumbnail',
  lesson_link: 'Lesson Link',
  attachment: 'Attachments',
  streaming: 'Streaming',
};

function CheckRow({ label, check, isDark }: { label: string; check: any; isDark: boolean }) {
  const c = isDark ? neuColors.dark : neuColors.light;
  const cfg: Record<CheckStatus, { color: string; Icon: any }> = {
    pass:    { color: '#16A34A', Icon: CheckCircle },
    fail:    { color: '#DC2626', Icon: XCircle },
    error:   { color: '#DC2626', Icon: AlertTriangle },
    skip:    { color: '#9CA3AF', Icon: Clock },
    running: { color: '#3B82F6', Icon: Clock },
  };
  const status: CheckStatus = check?.status ?? 'skip';
  const { color, Icon } = cfg[status] ?? cfg.skip;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7,
      borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
      <Icon size={14} color={color} />
      <Text style={{ flex: 1, fontSize: 13, color: c.text, fontWeight: '500' }}>{label}</Text>
      <View style={{ backgroundColor: `${color}15`, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
        <Text style={{ fontSize: 11, fontWeight: '700', color }}>{status.toUpperCase()}</Text>
      </View>
      {check?.message && (
        <Text style={{ fontSize: 11, color: c.text, opacity: 0.5, maxWidth: 120 }} numberOfLines={1}>
          {check.message}
        </Text>
      )}
    </View>
  );
}

export function VideoHealthDetails({ upload, visible, onClose, onScanComplete }: Props) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const router = useRouter();

  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<any>(null);
  const [auditLogs, setAuditLogs] = useState<any[] | null>(null);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'checks' | 'audit' | 'storage'>('overview');

  const loadAuditLogs = useCallback(async () => {
    if (!upload?.id || auditLogs) return;
    setLoadingAudit(true);
    const { data } = await backendClient
      .from('upload_audit_logs')
      .select('id, event, details, created_at')
      .eq('upload_id', upload.id)
      .order('created_at', { ascending: false })
      .limit(50);
    setAuditLogs(data ?? []);
    setLoadingAudit(false);
  }, [upload?.id, auditLogs]);

  const handleScan = async () => {
    if (!upload?.id) return;
    setScanning(true);
    setScanResult(null);
    try {
      const { data, error } = await backendClient.functions.invoke('video-health-scan', {
        body: { action: 'scan_one', upload_id: upload.id },
      });
      if (error) throw error;
      setScanResult(data);
      onScanComplete?.();
    } catch (e) {
      setScanResult({ error: String(e) });
    }
    setScanning(false);
  };

  const handleRegenerateThumbnail = async () => {
    if (!upload?.id) return;
    await backendClient.functions.invoke('video-health-scan', {
      body: {
        action: 'regenerate_thumbnail',
        upload_id: upload.id,
        provider_video_id: upload.provider_video_id,
      },
    });
    onScanComplete?.();
  };

  if (!upload) return null;

  const checks = scanResult?.checks ?? {};
  const hasChecks = Object.keys(checks).length > 0;
  const ts = (d: string) => {
    const dt = new Date(d);
    return `${dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} ${dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}`;
  };

  const TABS = [
    { key: 'overview', label: 'Overview' },
    { key: 'checks',   label: 'Health Checks' },
    { key: 'audit',    label: 'Audit Log' },
    { key: 'storage',  label: 'Storage' },
  ] as const;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
        <View style={[{ backgroundColor: c.base, borderTopLeftRadius: 24, borderTopRightRadius: 24,
          maxHeight: '92%', paddingBottom: 32 }, neuFlatStyle(isDark)]}>

          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: 18, gap: 12,
            borderBottomWidth: 1, borderBottomColor: `${c.text}10` }}>
            {upload.thumbnail_url ? (
              <View style={{ width: 44, height: 44, borderRadius: 10, overflow: 'hidden' }}>
                <Image source={{ uri: upload.thumbnail_url }} style={{ width: 44, height: 44 }} resizeMode="cover" />
              </View>
            ) : (
              <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: `${c.primary}18`,
                alignItems: 'center', justifyContent: 'center' }}>
                <Film size={22} color={c.primary} />
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: '800', color: c.text }} numberOfLines={1}>
                {upload.file_name}
              </Text>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }} numberOfLines={1}>
                {upload.course?.title ?? '—'} › {upload.lesson?.title ?? '—'}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pressable onPress={handleScan} disabled={scanning} hitSlop={8}
                style={[neuFlatStyle(isDark), { borderRadius: 10, padding: 9, flexDirection: 'row', gap: 5, alignItems: 'center' }]}>
                {scanning
                  ? <ActivityIndicator size={14} color={c.primary} />
                  : <ShieldCheck size={14} color={c.primary} />}
                <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>
                  {scanning ? 'Scanning…' : 'Scan'}
                </Text>
              </Pressable>
              <Pressable onPress={onClose} hitSlop={8}
                style={[neuFlatStyle(isDark), { borderRadius: 10, padding: 9 }]}>
                <X size={16} color={c.text} opacity={0.5} />
              </Pressable>
            </View>
          </View>

          {/* Tabs */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 10 }}>
            {TABS.map(({ key, label }) => (
              <Pressable key={key}
                onPress={() => { setActiveTab(key); if (key === 'audit') loadAuditLogs(); }}
                style={[
                  activeTab === key ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
                  { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
                ]}>
                <Text style={{ fontSize: 12, fontWeight: '700',
                  color: activeTab === key ? c.primary : `${c.text}70` }}>
                  {label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 20 }}
            showsVerticalScrollIndicator={false}>

            {/* ── OVERVIEW ── */}
            {activeTab === 'overview' && (
              <View style={{ gap: 10 }}>
                {/* Health score */}
                {(upload.health_score != null || scanResult?.healthScore != null) && (
                  <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 16, alignItems: 'center', gap: 6 }]}>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.5, fontWeight: '600' }}>HEALTH SCORE</Text>
                    {(() => {
                      const score = scanResult?.healthScore ?? upload.health_score ?? 0;
                      const color = score >= 80 ? '#16A34A' : score >= 50 ? '#D97706' : '#DC2626';
                      return (
                        <>
                          <Text style={{ fontSize: 40, fontWeight: '900', color }}>{score}</Text>
                          <Text style={{ fontSize: 12, color, fontWeight: '700' }}>
                            {score >= 80 ? 'Healthy' : score >= 50 ? 'Attention Required' : 'Critical'}
                          </Text>
                        </>
                      );
                    })()}
                  </NeuCard>
                )}

                {/* Key fields */}
                {[
                  { label: 'Provider', value: 'MedAcademy Video' },
                  { label: 'Status', value: upload.status },
                  { label: 'Verification', value: upload.verification_status ?? '—' },
                  { label: 'File Size', value: formatBytes(upload.file_size ?? 0) },
                  { label: 'Resolution', value: upload.video_resolution ?? '—' },
                  { label: 'Duration', value: upload.video_duration_sec ? `${Math.round(upload.video_duration_sec / 60)} min` : '—' },
                  { label: 'Upload Date', value: upload.created_at ? ts(upload.created_at) : '—' },
                  { label: 'Last Health Check', value: upload.last_health_check_at ? ts(upload.last_health_check_at) : 'Never' },
                  { label: 'Doctor', value: upload.doctor?.full_name ?? upload.doctor?.email ?? '—' },
                  { label: 'Course', value: upload.course?.title ?? '—' },
                  { label: 'Lesson', value: upload.lesson?.title ?? '—' },
                ].map(({ label, value }) => (
                  <View key={label} style={[neuFlatStyle(isDark),
                    { borderRadius: 12, padding: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }]}>
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>{label}</Text>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: c.text, maxWidth: '60%', textAlign: 'right' }} numberOfLines={1}>
                      {String(value)}
                    </Text>
                  </View>
                ))}

                {/* Quick actions */}
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
                  <Pressable onPress={handleRegenerateThumbnail}
                    style={[neuFlatStyle(isDark), { flex: 1, padding: 12, borderRadius: 12,
                      flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center' }]}>
                    <RefreshCw size={13} color="#7C3AED" />
                    <Text style={{ fontSize: 12, fontWeight: '600', color: '#7C3AED' }}>Regen Thumbnail</Text>
                  </Pressable>
                  {upload.lesson?.id && (
                    <Pressable
                      onPress={() => { onClose(); router.push(`/(app)/lesson-editor/${upload.lesson.id}` as any); }}
                      style={[neuFlatStyle(isDark), { flex: 1, padding: 12, borderRadius: 12,
                        flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center' }]}>
                      <ExternalLink size={13} color={c.primary} />
                      <Text style={{ fontSize: 12, fontWeight: '600', color: c.primary }}>Open Lesson</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            )}

            {/* ── HEALTH CHECKS ── */}
            {activeTab === 'checks' && (
              <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 16, gap: 4 }]}>
                {hasChecks ? (
                  Object.entries(checks).map(([key, check]) => (
                    <CheckRow key={key} label={CHECK_LABELS[key] ?? key} check={check} isDark={isDark} />
                  ))
                ) : (
                  <View style={{ alignItems: 'center', padding: 28, gap: 10 }}>
                    <ShieldCheck size={32} color={`${c.text}25`} />
                    <Text style={{ color: c.text, opacity: 0.4, fontSize: 13 }}>
                      Run a scan to see health check results
                    </Text>
                    <Pressable onPress={handleScan} disabled={scanning}
                      style={{ backgroundColor: c.primary, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10 }}>
                      <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>
                        {scanning ? 'Scanning…' : 'Scan Now'}
                      </Text>
                    </Pressable>
                  </View>
                )}

                {/* Scan errors summary */}
                {scanResult?.errors?.length > 0 && (
                  <View style={{ backgroundColor: '#DC262612', borderRadius: 10, padding: 10, gap: 4, marginTop: 8 }}>
                    {scanResult.errors.map((e: string, i: number) => (
                      <View key={i} style={{ flexDirection: 'row', gap: 6 }}>
                        <AlertTriangle size={12} color="#DC2626" />
                        <Text style={{ fontSize: 12, color: '#DC2626', flex: 1 }}>{e}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </NeuCard>
            )}

            {/* ── AUDIT LOG ── */}
            {activeTab === 'audit' && (
              loadingAudit ? (
                <ActivityIndicator color={c.primary} style={{ marginTop: 30 }} />
              ) : (auditLogs ?? []).length === 0 ? (
                <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 32, alignItems: 'center', gap: 10 }]}>
                  <FileText size={30} color={`${c.text}25`} />
                  <Text style={{ color: c.text, opacity: 0.4 }}>No audit records</Text>
                </NeuCard>
              ) : (
                <View style={{ gap: 8 }}>
                  {(auditLogs ?? []).map((log) => {
                    const EVENT_COLORS: Record<string, string> = {
                      upload_completed: '#16A34A', ready: '#16A34A',
                      upload_started: '#3B82F6', verification_passed: '#2DA8FF',
                      verification_failed: '#DC2626', thumbnail_generated: '#16A34A',
                      video_replaced: '#7C3AED', upload_failed: '#DC2626',
                    };
                    const color = EVENT_COLORS[log.event] ?? '#6B7280';
                    return (
                      <View key={log.id} style={[neuFlatStyle(isDark),
                        { borderRadius: 12, padding: 11, flexDirection: 'row', gap: 10, alignItems: 'center' }]}>
                        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 12, fontWeight: '700', color }}>
                            {log.event.replace(/_/g, ' ')}
                          </Text>
                        </View>
                        <Text style={{ fontSize: 10, color: c.text, opacity: 0.35 }}>
                          {ts(log.created_at)}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              )
            )}

            {/* ── STORAGE ── */}
            {activeTab === 'storage' && (
              <View style={{ gap: 10 }}>
                {[
                  { label: 'Provider', value: 'MedAcademy Video' },
                  { label: 'Provider Video ID', value: upload.provider_video_id ?? '—' },
                  { label: 'Storage Path', value: upload.storage_path ?? '—' },
                  { label: 'File Size', value: formatBytes(upload.file_size ?? 0) },
                  { label: 'MIME Type', value: upload.mime_type ?? '—' },
                  { label: 'Thumbnail URL', value: upload.thumbnail_url ? 'Set' : 'Missing' },
                  { label: 'Public URL', value: upload.public_url ? 'Available' : 'None' },
                  { label: 'Is Replacement', value: upload.is_replacement ? 'Yes' : 'No' },
                  { label: 'Old Storage Path', value: upload.old_storage_path ?? 'N/A' },
                ].map(({ label, value }) => (
                  <View key={label} style={[neuFlatStyle(isDark),
                    { borderRadius: 12, padding: 12, gap: 3 }]}>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, fontWeight: '600' }}>{label}</Text>
                    <Text style={{ fontSize: 12, color: c.text, fontWeight: '500' }} numberOfLines={2}>
                      {value}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
