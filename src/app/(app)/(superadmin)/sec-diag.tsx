import { useCallback, useState } from 'react';
import { View, Text, ScrollView, useColorScheme, RefreshControl, ActivityIndicator, Pressable, Modal } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { ShieldAlert, Eye, Lock, AlertTriangle, CheckCircle, X, ChevronRight } from 'lucide-react-native';
import { getAuditLogs, getAllUsers } from '@/lib/api';
import { supabase } from '@/client/supabase';
import { NeuCard } from '@/components/NeuCard';
import { neuColors } from '@/lib/neu';
import { PageHeader } from '@/components/PageHeader';

function isSecurityEvent(action: string = '') {
  return ['login', 'logout', 'suspend', 'revoke', 'device', 'auth', 'password', 'delete', 'impersonat'].some(k => action.toLowerCase().includes(k));
}

export default function SuperAdminSecurity() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  const [logs, setLogs] = useState<any[]>([]);
  const [suspendedCount, setSuspendedCount] = useState(0);
  const [multiDeviceUsers, setMultiDeviceUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [auditData, usersData, deviceCountsRes] = await Promise.all([
        getAuditLogs(50),
        getAllUsers(),
        supabase
          .from('devices')
          .select('user_id')
          .then(({ data }) => {
            const counts: Record<string, number> = {};
            for (const row of data ?? []) {
              counts[row.user_id] = (counts[row.user_id] ?? 0) + 1;
            }
            return counts;
          }),
      ]);
      setLogs(auditData);
      const suspended = usersData.filter((u: any) => u.status === 'suspended');
      setSuspendedCount(suspended.length);
      setMultiDeviceUsers(
        usersData
          .filter((u: { id: string }) => (deviceCountsRes[u.id] ?? 0) > 1)
          .map((u: { id: string; full_name: string; email: string }) => ({
            user: u,
            count: deviceCountsRes[u.id],
          }))
      );
    } catch (_) {}
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); loadData(); }, [loadData]));
  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

  const securityAlerts = [
    { label: 'Suspended Accounts', value: suspendedCount, icon: Lock, color: suspendedCount > 0 ? '#DC2626' : '#16A34A', severity: suspendedCount > 0 ? 'warning' : 'ok' },
    { label: 'Multi-Device Users', value: multiDeviceUsers.length, icon: AlertTriangle, color: multiDeviceUsers.length > 0 ? '#D97706' : '#16A34A', severity: multiDeviceUsers.length > 0 ? 'warning' : 'ok' },
  ];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }} contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}>
      <View style={{ padding: 20 }}>
        <Text style={{ fontSize: 24, fontWeight: '800', color: c.text, marginBottom: 8, marginTop: 8 }}>Security Diagnostics</Text>
        <Text style={{ fontSize: 13, color: c.text, opacity: 0.5, marginBottom: 20 }}>Platform security overview and threat analysis</Text>

        {loading ? <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} /> : (
          <>
            {/* Security Alerts */}
            <Text style={{ fontSize: 17, fontWeight: '700', color: c.text, marginBottom: 14 }}>Security Alerts</Text>
            <View style={{ flexDirection: 'row', gap: 12, marginBottom: 24 }}>
              {securityAlerts.map(({ label, value, icon: Icon, color, severity }) => (
                <NeuCard key={label} style={{ flex: 1, alignItems: 'center', padding: 18 }}>
                  <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: `${color}20`, alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}>
                    {severity === 'ok' ? <CheckCircle size={22} color={color} /> : <Icon size={22} color={color} />}
                  </View>
                  <Text style={{ fontSize: 22, fontWeight: '800', color }}>{value}</Text>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.55, textAlign: 'center', marginTop: 4 }}>{label}</Text>
                </NeuCard>
              ))}
            </View>

            {/* Multi-device users */}
            {multiDeviceUsers.length > 0 && (
              <>
                <Text style={{ fontSize: 17, fontWeight: '700', color: c.text, marginBottom: 14 }}>⚠️ Multi-Device Users</Text>
                {multiDeviceUsers.map(({ user, count }) => (
                  <NeuCard key={user.id} style={{ marginBottom: 10, padding: 14, flexDirection: 'row', alignItems: 'center' }}>
                    <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#D9780620', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                      <AlertTriangle size={18} color="#D97706" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{user.full_name}</Text>
                      <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>{user.email} · {count} devices</Text>
                    </View>
                  </NeuCard>
                ))}
              </>
            )}

            {/* Recent Security Events */}
            <Text style={{ fontSize: 17, fontWeight: '700', color: c.text, marginBottom: 14, marginTop: 8 }}>Recent Security Events</Text>
            {logs.filter(l => isSecurityEvent(l.action)).slice(0, 20).map(log => (
              <NeuCard key={log.id} style={{ marginBottom: 8, padding: 14, flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
                  <ShieldAlert size={16} color="#DC2626" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{log.action?.replace(/_/g, ' ')}</Text>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>{log.user?.full_name ?? 'System'} · {log.user?.email}</Text>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.35, marginTop: 2 }}>{new Date(log.created_at).toLocaleString()}</Text>
                </View>
              </NeuCard>
            ))}

            {logs.filter(l => isSecurityEvent(l.action)).length === 0 && (
              <NeuCard style={{ alignItems: 'center', padding: 32 }}>
                <CheckCircle size={40} color="#16A34A" style={{ marginBottom: 10 }} />
                <Text style={{ fontSize: 15, fontWeight: '600', color: c.text }}>No security events</Text>
              </NeuCard>
            )}
          </>
        )}
      </View>
    </ScrollView>
  );
}
