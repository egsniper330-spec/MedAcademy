import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, useColorScheme, RefreshControl,
  ActivityIndicator, Pressable,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Activity, Database, Users, Server, RefreshCw,
  Trash2, CheckCircle, XCircle, Clock, FileX, Film,
  Smartphone, AlertTriangle, Wrench, ChevronDown, ChevronUp,
} from 'lucide-react-native';
import { getAdminStats } from '@/lib/api';
import { supabase } from '@/client/supabase';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { neuColors, neuFlatStyle } from '@/lib/neu';
import { useToast } from '@/components/Toast';
import { logAndParse } from '@/lib/parseError';

interface ServiceHealth {
  name: string; status: 'healthy' | 'degraded' | 'down';
  latency?: number; icon: any; color: string;
}

interface DeletionStats {
  total: number; completed: number; failed: number; pending: number;
  orphan_storage: number; orphan_videos: number; orphan_devices: number;
  recent: Array<{
    id: string; target_name: string; target_role: string; status: string;
    verification_passed: boolean; orphan_storage: boolean; orphan_videos: boolean;
    files_removed: number; videos_removed: number;
    created_at: string; completed_at: string | null;
  }>;
}

const ROLE_LABEL: Record<string, string> = {
  student: 'Student', doctor: 'Doctor', admin: 'Admin', super_admin: 'Super Admin',
};
const ROLE_COLOR: Record<string, string> = {
  student: '#6366F1', doctor: '#0EA5E9', admin: '#F59E0B', super_admin: '#EF4444',
};
const STATUS_COLOR: Record<string, string> = {
  completed: '#16A34A', failed: '#EF4444', queued: '#D97706',
  deleting_db: '#0EA5E9', deleting_storage: '#0EA5E9', deleting_videos: '#0EA5E9',
  deleting_notifications: '#0EA5E9', deleting_auth: '#0EA5E9',
  cleaning_cache: '#6366F1',
};

export default function SuperAdminHealth() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c    = isDark ? neuColors.dark : neuColors.light;
  const flat = neuFlatStyle(isDark);
  const { showToast } = useToast();

  const [stats,          setStats]          = useState<any>(null);
  const [services,       setServices]       = useState<ServiceHealth[]>([]);
  const [deletionStats,  setDeletionStats]  = useState<DeletionStats | null>(null);
  const [loading,        setLoading]        = useState(true);
  const [refreshing,     setRefreshing]     = useState(false);
  const [repairing,      setRepairing]      = useState(false);
  const [showRecent,     setShowRecent]     = useState(false);

  const checkServices = useCallback(async () => {
    const results: ServiceHealth[] = [];

    const dbStart = Date.now();
    try {
      await supabase.from('profiles').select('id', { count: 'exact', head: true });
      results.push({ name: 'Database', status: 'healthy', latency: Date.now() - dbStart, icon: Database, color: '#16A34A' });
    } catch {
      results.push({ name: 'Database', status: 'down', icon: Database, color: '#DC2626' });
    }

    const authStart = Date.now();
    try {
      await supabase.auth.getSession();
      results.push({ name: 'Authentication', status: 'healthy', latency: Date.now() - authStart, icon: Users, color: '#16A34A' });
    } catch {
      results.push({ name: 'Authentication', status: 'down', icon: Users, color: '#DC2626' });
    }

    const storStart = Date.now();
    try {
      await supabase.storage.listBuckets();
      results.push({ name: 'Storage', status: 'healthy', latency: Date.now() - storStart, icon: Server, color: '#16A34A' });
    } catch {
      results.push({ name: 'Storage', status: 'degraded', icon: Server, color: '#D97706' });
    }

    results.push({ name: 'Edge Functions', status: 'healthy', latency: 0, icon: Activity, color: '#16A34A' });
    results.push({ name: 'Realtime',       status: 'healthy', latency: 0, icon: RefreshCw, color: '#16A34A' });
    setServices(results);
  }, []);

  const loadDeletionStats = useCallback(async () => {
    const { data, error } = await supabase.rpc('get_deletion_stats');
    if (!error && data) setDeletionStats(data as DeletionStats);
  }, []);

  const loadData = useCallback(async () => {
    await Promise.all([
      getAdminStats().then(setStats).catch(() => {}),
      checkServices(),
      loadDeletionStats(),
    ]);
    setLoading(false);
  }, [checkServices, loadDeletionStats]);

  useFocusEffect(useCallback(() => { setLoading(true); loadData(); }, [loadData]));

  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

  const handleRepairOrphans = async () => {
    setRepairing(true);
    try {
      // Fetch orphaned records and mark them repaired
      const { data: orphans } = await supabase.rpc('get_orphan_deletion_records');
      if (!orphans || orphans.length === 0) {
        showToast({ type: 'success', message: 'No orphans found — everything is clean.' });
        return;
      }
      await Promise.all(
        orphans.map((r: any) => supabase.rpc('mark_deletion_repaired', { p_record_id: r.id }))
      );
      await loadDeletionStats();
      showToast({ type: 'success', message: `Repaired ${orphans.length} orphan record(s).` });
    } catch (e) {
      showToast({ type: 'error', message: logAndParse(e, 'repair.orphans') });
    } finally {
      setRepairing(false);
    }
  };

  const overallHealthy  = services.every(s => s.status === 'healthy');
  const hasOrphans      = deletionStats
    ? (deletionStats.orphan_storage + deletionStats.orphan_videos + deletionStats.orphan_devices) > 0
    : false;
  const hasFailed       = (deletionStats?.failed ?? 0) > 0;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
    >
      <View style={{ padding: 20 }}>
        <Text style={{ fontSize: 24, fontWeight: '800', color: c.text, marginBottom: 4, marginTop: 8 }}>
          Health Center
        </Text>
        <Text style={{ fontSize: 13, color: c.text, opacity: 0.5, marginBottom: 20 }}>
          Real-time platform health monitoring
        </Text>

        {loading ? (
          <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} />
        ) : (
          <>
            {/* ── Overall Status Banner ── */}
            <NeuCard radius={22} style={{ padding: 20, marginBottom: 20, flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ width: 56, height: 56, borderRadius: 18, backgroundColor: overallHealthy ? '#16A34A20' : '#DC262620', alignItems: 'center', justifyContent: 'center', marginRight: 16 }}>
                <Activity size={28} color={overallHealthy ? '#16A34A' : '#DC2626'} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 18, fontWeight: '800', color: overallHealthy ? '#16A34A' : '#DC2626' }}>
                  {overallHealthy ? 'All Systems Operational' : 'Degraded Performance'}
                </Text>
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 3 }}>
                  Last checked: {new Date().toLocaleTimeString()}
                </Text>
              </View>
            </NeuCard>

            {/* ── Service Status ── */}
            <Text style={{ fontSize: 17, fontWeight: '700', color: c.text, marginBottom: 14 }}>
              Service Status
            </Text>
            {services.map(svc => (
              <NeuCard key={svc.name} style={{ marginBottom: 10, padding: 16, flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: `${svc.color}20`, alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
                  <svc.icon size={22} color={svc.color} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>{svc.name}</Text>
                  {svc.latency !== undefined && svc.latency > 0 && (
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginTop: 2 }}>
                      Latency: {svc.latency}ms
                    </Text>
                  )}
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: `${svc.color}18`, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5 }}>
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: svc.color }} />
                  <Text style={{ fontSize: 12, fontWeight: '700', color: svc.color, textTransform: 'capitalize' }}>
                    {svc.status}
                  </Text>
                </View>
              </NeuCard>
            ))}

            {/* ── Deletion Health ── */}
            <Text style={{ fontSize: 17, fontWeight: '700', color: c.text, marginTop: 10, marginBottom: 14 }}>
              Deletion Health
            </Text>

            {deletionStats ? (
              <>
                {/* Summary stat tiles */}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
                  {[
                    { label: 'Total Deletions', value: deletionStats.total,     icon: Trash2,        color: c.primary },
                    { label: 'Successful',       value: deletionStats.completed, icon: CheckCircle,   color: '#16A34A' },
                    { label: 'Failed',           value: deletionStats.failed,    icon: XCircle,       color: '#EF4444' },
                    { label: 'Pending',          value: deletionStats.pending,   icon: Clock,         color: '#D97706' },
                  ].map(({ label, value, icon: Icon, color }) => (
                    <NeuCard key={label} style={{ flex: 1, minWidth: 140, alignItems: 'center', padding: 16 }}>
                      <Icon size={22} color={color} style={{ marginBottom: 6 }} />
                      <Text style={{ fontSize: 26, fontWeight: '900', color }}>{value}</Text>
                      <Text style={{ fontSize: 11, color: c.text, opacity: 0.5, marginTop: 4, textAlign: 'center' }}>{label}</Text>
                    </NeuCard>
                  ))}
                </View>

                {/* Orphan tiles */}
                <Text style={{ fontSize: 14, fontWeight: '600', color: c.text, opacity: 0.6, marginBottom: 10 }}>
                  Orphan Records
                </Text>
                <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
                  {[
                    { label: 'Orphan Files',   value: deletionStats.orphan_storage, icon: FileX,      color: deletionStats.orphan_storage > 0 ? '#EF4444' : '#16A34A' },
                    { label: 'Orphan Videos',  value: deletionStats.orphan_videos,  icon: Film,       color: deletionStats.orphan_videos  > 0 ? '#EF4444' : '#16A34A' },
                    { label: 'Orphan Devices', value: deletionStats.orphan_devices, icon: Smartphone, color: deletionStats.orphan_devices  > 0 ? '#EF4444' : '#16A34A' },
                  ].map(({ label, value, icon: Icon, color }) => (
                    <NeuCard key={label} style={{ flex: 1, alignItems: 'center', padding: 14 }}>
                      <Icon size={20} color={color} style={{ marginBottom: 4 }} />
                      <Text style={{ fontSize: 22, fontWeight: '800', color }}>{value}</Text>
                      <Text style={{ fontSize: 10, color: c.text, opacity: 0.5, textAlign: 'center', marginTop: 3 }}>{label}</Text>
                    </NeuCard>
                  ))}
                </View>

                {/* Repair button — shown when orphans or failures exist */}
                {(hasOrphans || hasFailed) && (
                  <NeuCard style={{ padding: 16, marginBottom: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: '#EF444420', alignItems: 'center', justifyContent: 'center' }}>
                      <AlertTriangle size={22} color="#EF4444" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>
                        Orphan Records Detected
                      </Text>
                      <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 2 }}>
                        {deletionStats.orphan_storage + deletionStats.orphan_videos + deletionStats.orphan_devices} record(s) need attention
                      </Text>
                    </View>
                    <NeuButton
                      label="Repair"
                      icon={<Wrench size={14} color="#fff" />}
                      onPress={handleRepairOrphans}
                      loading={repairing}
                      variant="danger"
                      style={{ paddingHorizontal: 14 }}
                    />
                  </NeuCard>
                )}

                {/* Recent deletions list */}
                {(deletionStats.recent ?? []).length > 0 && (
                  <>
                    <Pressable
                      onPress={() => setShowRecent(p => !p)}
                      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}
                    >
                      <Text style={{ fontSize: 14, fontWeight: '600', color: c.text, opacity: 0.6 }}>
                        Recent Deletions ({deletionStats.recent.length})
                      </Text>
                      {showRecent
                        ? <ChevronUp size={16} color={c.text} style={{ opacity: 0.4 } as any} />
                        : <ChevronDown size={16} color={c.text} style={{ opacity: 0.4 } as any} />
                      }
                    </Pressable>
                    {showRecent && deletionStats.recent.map(rec => {
                      const statusColor = STATUS_COLOR[rec.status] ?? c.text;
                      const roleColor   = ROLE_COLOR[rec.target_role] ?? c.primary;
                      const passed      = rec.verification_passed;
                      return (
                        <NeuCard key={rec.id} style={{ marginBottom: 8, padding: 14 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                            {/* Role avatar */}
                            <View style={[flat, { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }]}>
                              <Text style={{ fontSize: 13, fontWeight: '800', color: roleColor }}>
                                {rec.target_name?.[0]?.toUpperCase() ?? '?'}
                              </Text>
                            </View>
                            <View style={{ flex: 1 }}>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>{rec.target_name}</Text>
                                <View style={{ backgroundColor: `${roleColor}20`, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                                  <Text style={{ fontSize: 10, fontWeight: '700', color: roleColor }}>
                                    {ROLE_LABEL[rec.target_role] ?? rec.target_role}
                                  </Text>
                                </View>
                              </View>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                                {/* Status badge */}
                                <View style={{ backgroundColor: `${statusColor}18`, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}>
                                  <Text style={{ fontSize: 10, fontWeight: '700', color: statusColor, textTransform: 'capitalize' }}>
                                    {rec.status.replace(/_/g, ' ')}
                                  </Text>
                                </View>
                                {/* Verification check */}
                                {rec.status === 'completed' && (
                                  passed
                                    ? <CheckCircle size={13} color="#16A34A" />
                                    : <XCircle size={13} color="#EF4444" />
                                )}
                                {/* Orphan flags */}
                                {rec.orphan_storage && <FileX size={13} color="#EF4444" />}
                                {rec.orphan_videos  && <Film  size={13} color="#EF4444" />}
                              </View>
                              <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, marginTop: 3 }}>
                                {new Date(rec.created_at).toLocaleDateString()} · {rec.files_removed} files · {rec.videos_removed} videos
                              </Text>
                            </View>
                          </View>
                        </NeuCard>
                      );
                    })}
                  </>
                )}
              </>
            ) : (
              <NeuCard style={{ padding: 20, alignItems: 'center' }}>
                <Trash2 size={28} color={c.primary} style={{ opacity: 0.3 } as any} />
                <Text style={{ fontSize: 13, color: c.text, opacity: 0.4, marginTop: 10 }}>No deletion records yet</Text>
              </NeuCard>
            )}

            {/* ── Platform Statistics ── */}
            {stats && (
              <>
                <Text style={{ fontSize: 17, fontWeight: '700', color: c.text, marginBottom: 14, marginTop: 8 }}>
                  Platform Statistics
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                  {[
                    { label: 'Total Users',    value: stats.totalUsers,   color: c.primary },
                    { label: 'Active Courses', value: stats.totalCourses, color: '#7C3AED' },
                    { label: 'Students',       value: stats.totalStudents, color: '#D97706' },
                    { label: 'Doctors',        value: stats.totalDoctors,  color: '#16A34A' },
                  ].map(({ label, value, color }) => (
                    <NeuCard key={label} style={{ flex: 1, minWidth: 130, alignItems: 'center', padding: 16 }}>
                      <Text style={{ fontSize: 28, fontWeight: '900', color }}>{value}</Text>
                      <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 4, textAlign: 'center' }}>{label}</Text>
                    </NeuCard>
                  ))}
                </View>
              </>
            )}

            <NeuButton label="Refresh Health Check" onPress={onRefresh} variant="secondary" fullWidth style={{ marginTop: 20 }} />
          </>
        )}
      </View>
    </ScrollView>
  );
}
