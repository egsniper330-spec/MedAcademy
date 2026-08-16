import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, useColorScheme,
  RefreshControl, ActivityIndicator, Pressable,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  ShieldAlert, Eye, Lock, AlertTriangle, CheckCircle,
  ShieldCheck, ShieldX, RefreshCw, Wifi, Bug, Smartphone,
  MapPin, Code, Layers, Wrench, Cpu, Fingerprint,
} from 'lucide-react-native';
import { getAuditLogs, getAllUsers } from '@/lib/api';
import { supabase } from '@/client/supabase';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, useLayout } from '@/lib/neu';
import { PageHeader } from '@/components/PageHeader';
import { getNativeSecurityFlags, type NativeSecurityFlags } from '@/lib/nativeSecurity';

function isSecurityEvent(action: string = '') {
  return ['login', 'logout', 'suspend', 'revoke', 'device', 'auth', 'password', 'delete', 'impersonat']
    .some(k => action.toLowerCase().includes(k));
}

interface CheckRow {
  key: keyof NativeSecurityFlags;
  label: string;
  description: string;
  threatWhenTrue: boolean;
  icon: React.ComponentType<{ size: number; color: string }>;
}

const CHECK_ROWS: CheckRow[] = [
  { key: 'vpnDetected',             label: 'VPN Active',           description: 'ConnectivityManager TRANSPORT_VPN + tun/vpn/ppp interface scan', threatWhenTrue: true,  icon: Wifi },
  { key: 'rootDetected',            label: 'Root Detected',        description: 'su paths + system props + test-keys + /system write test',       threatWhenTrue: true,  icon: ShieldX },
  { key: 'emulatorDetected',        label: 'Emulator Detected',    description: 'Build fingerprint/model/manufacturer + QEMU props + sensor count',threatWhenTrue: true,  icon: Smartphone },
  { key: 'mockLocationDetected',    label: 'Mock Location',        description: 'AppOpsManager MOCK_LOCATION + Settings.Secure + permission scan', threatWhenTrue: true,  icon: MapPin },
  { key: 'developerOptionsEnabled', label: 'Developer Options',    description: 'Settings.Global.DEVELOPMENT_SETTINGS_ENABLED',                   threatWhenTrue: true,  icon: Wrench },
  { key: 'adbEnabled',              label: 'USB Debugging (ADB)', description: 'Settings.Global.ADB_ENABLED',                                     threatWhenTrue: true,  icon: Code },
  { key: 'debuggerAttached',        label: 'Debugger Attached',   description: 'Debug.isDebuggerConnected() / sysctl P_TRACED (iOS)',              threatWhenTrue: true,  icon: Bug },
  { key: 'screenBeingRecorded',     label: 'Screen Recording',    description: 'MediaProjection / UIScreen.isCaptured',                            threatWhenTrue: true,  icon: Eye },
  { key: 'fridaDetected',           label: 'Frida Detected',      description: 'Port probe 27042-27045 + /proc/maps + process scan + disk files',  threatWhenTrue: true,  icon: Layers },
  { key: 'xposedDetected',          label: 'Xposed / LSPosed',    description: 'XposedBridge class load + package scan + stack trace',             threatWhenTrue: true,  icon: Cpu },
  { key: 'magiskDetected',          label: 'Magisk / Zygisk',     description: 'Magisk paths + mount points + packages + DenyList',                threatWhenTrue: true,  icon: ShieldX },
  { key: 'overlayDetected',         label: 'Overlay Attack',      description: 'SYSTEM_ALERT_WINDOW + suspicious overlay packages',                threatWhenTrue: true,  icon: Layers },
  { key: 'tampered',                label: 'App Tampered',        description: 'Installer source + native lib presence',                           threatWhenTrue: true,  icon: ShieldAlert },
  { key: 'signatureValid',          label: 'Signature Valid',     description: 'Cert SHA-256 vs trusted fingerprints',                             threatWhenTrue: false, icon: Fingerprint },
];

export default function SuperAdminSecurity() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  const [logs, setLogs]                         = useState<any[]>([]);
  const [suspendedCount, setSuspendedCount]     = useState(0);
  const [multiDeviceUsers, setMultiDeviceUsers] = useState<any[]>([]);
  const [loading, setLoading]                   = useState(true);
  const [refreshing, setRefreshing]             = useState(false);

  const [nativeFlags, setNativeFlags]         = useState<NativeSecurityFlags | null>(null);
  const [flagsLoading, setFlagsLoading]       = useState(false);
  const [flagsError, setFlagsError]           = useState<string | null>(null);
  const [flagsTimestamp, setFlagsTimestamp]   = useState<Date | null>(null);

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

  const runNativeChecks = useCallback(async () => {
    setFlagsLoading(true);
    setFlagsError(null);
    try {
      const flags = await getNativeSecurityFlags();
      console.log('[SecDiag] raw native flags:', JSON.stringify(flags));
      setNativeFlags(flags);
      setFlagsTimestamp(new Date());
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      console.log('[SecDiag] getNativeSecurityFlags error:', msg);
      setFlagsError(msg);
    } finally {
      setFlagsLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    setLoading(true);
    loadData();
    runNativeChecks();
  }, [loadData, runNativeChecks]));

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadData(), runNativeChecks()]);
    setRefreshing(false);
  };

  const securityAlerts = [
    { label: 'Suspended',    value: suspendedCount,       icon: Lock,          color: suspendedCount > 0       ? '#DC2626' : '#16A34A', severity: suspendedCount > 0       ? 'warning' : 'ok' },
    { label: 'Multi-Device', value: multiDeviceUsers.length, icon: AlertTriangle, color: multiDeviceUsers.length > 0 ? '#D97706' : '#16A34A', severity: multiDeviceUsers.length > 0 ? 'warning' : 'ok' },
  ];

  const nativeThreatCount = nativeFlags
    ? CHECK_ROWS.filter(row => {
        const raw = nativeFlags[row.key] as boolean | undefined;
        return row.threatWhenTrue ? raw === true : raw === false;
      }).length
    : null;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
    >
      <View style={{ padding: layout.screenPx }}>
        <Text style={{ fontSize: 24, fontWeight: '800', color: c.text, marginBottom: 4, marginTop: 8 }}>
          Security Diagnostics
        </Text>
        <Text style={{ fontSize: 13, color: c.text, opacity: 0.5, marginBottom: 20 }}>
          Platform security overview and threat analysis
        </Text>

        {loading ? (
          <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} />
        ) : (
          <>
            {/* Summary alerts */}
            <Text style={{ fontSize: 17, fontWeight: '700', color: c.text, marginBottom: 14 }}>Security Alerts</Text>
            <View style={{ flexDirection: 'row', gap: 12, marginBottom: 24 }}>
              {securityAlerts.map(({ label, value, icon: Icon, color, severity }) => (
                <NeuCard key={label} style={{ flex: 1, alignItems: 'center', padding: 18 }}>
                  <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: color + '20', alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}>
                    {severity === 'ok' ? <CheckCircle size={22} color={color} /> : <Icon size={22} color={color} />}
                  </View>
                  <Text style={{ fontSize: 22, fontWeight: '800', color }}>{value}</Text>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.55, textAlign: 'center', marginTop: 4 }}>{label}</Text>
                </NeuCard>
              ))}
              {nativeThreatCount !== null && (
                <NeuCard style={{ flex: 1, alignItems: 'center', padding: 18 }}>
                  <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: nativeThreatCount > 0 ? '#DC262620' : '#16A34A20', alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}>
                    {nativeThreatCount > 0 ? <ShieldX size={22} color="#DC2626" /> : <ShieldCheck size={22} color="#16A34A" />}
                  </View>
                  <Text style={{ fontSize: 22, fontWeight: '800', color: nativeThreatCount > 0 ? '#DC2626' : '#16A34A' }}>{nativeThreatCount}</Text>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.55, textAlign: 'center', marginTop: 4 }}>Native Threats</Text>
                </NeuCard>
              )}
            </View>

            {/* Live Native Security Checks */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <Text style={{ fontSize: 17, fontWeight: '700', color: c.text }}>Live Device Checks</Text>
              <Pressable
                onPress={runNativeChecks}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 6,
                  backgroundColor: c.primary + '18', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 }}
              >
                {flagsLoading
                  ? <ActivityIndicator size="small" color={c.primary} />
                  : <RefreshCw size={14} color={c.primary} />
                }
                <Text style={{ fontSize: 13, fontWeight: '600', color: c.primary }}>Run Checks</Text>
              </Pressable>
            </View>

            {flagsError ? (
              <NeuCard style={{ padding: 16, marginBottom: 16 }}>
                <Text style={{ fontSize: 13, color: '#DC2626' }}>⚠️ Native module error: {flagsError}</Text>
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 4 }}>
                  Runs on Android/iOS only. Web preview always returns safe defaults.
                </Text>
              </NeuCard>
            ) : flagsLoading && !nativeFlags ? (
              <NeuCard style={{ padding: layout.screenPx, alignItems: 'center', marginBottom: 16 }}>
                <ActivityIndicator color={c.primary} />
                <Text style={{ fontSize: 13, color: c.text, opacity: 0.6, marginTop: 10 }}>Running native checks…</Text>
              </NeuCard>
            ) : nativeFlags ? (
              <>
                {flagsTimestamp && (
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, marginBottom: 10 }}>
                    Last checked: {flagsTimestamp.toLocaleTimeString()}
                  </Text>
                )}
                {CHECK_ROWS.map((row) => {
                  const raw = nativeFlags[row.key] as boolean | undefined;
                  const isThreat = row.threatWhenTrue ? raw === true : raw === false;
                  const statusColor = isThreat ? '#DC2626' : '#16A34A';
                  const Icon = row.icon;
                  return (
                    <NeuCard key={row.key} style={{ marginBottom: 8, padding: 14 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <View style={{ width: 36, height: 36, borderRadius: 10,
                          backgroundColor: statusColor + '18',
                          alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                          <Icon size={18} color={statusColor} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{row.label}</Text>
                            <View style={{ backgroundColor: statusColor + '18', borderRadius: 6,
                              paddingHorizontal: 7, paddingVertical: 2 }}>
                              <Text style={{ fontSize: 10, fontWeight: '700', color: statusColor }}>
                                {isThreat ? 'DETECTED' : 'CLEAR'}
                              </Text>
                            </View>
                          </View>
                          <Text style={{ fontSize: 11, color: c.text, opacity: 0.5, marginTop: 2 }}>
                            {row.description}
                          </Text>
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={{ fontSize: 11, fontWeight: '700',
                            color: raw === undefined ? '#94A3B8' : (isThreat ? '#DC2626' : '#16A34A') }}>
                            {raw === undefined ? 'N/A' : String(raw)}
                          </Text>
                          <Text style={{ fontSize: 10, color: c.text, opacity: 0.35 }}>raw</Text>
                        </View>
                      </View>
                    </NeuCard>
                  );
                })}
              </>
            ) : null}

            {/* Multi-device users */}
            {multiDeviceUsers.length > 0 && (
              <>
                <Text style={{ fontSize: 17, fontWeight: '700', color: c.text, marginBottom: 14, marginTop: 8 }}>
                  ⚠️ Multi-Device Users
                </Text>
                {multiDeviceUsers.map(({ user, count }) => (
                  <NeuCard key={user.id} style={{ marginBottom: 10, padding: 14, flexDirection: 'row', alignItems: 'center' }}>
                    <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#D9780620',
                      alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                      <AlertTriangle size={18} color="#D97806" />
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
            <Text style={{ fontSize: 17, fontWeight: '700', color: c.text, marginBottom: 14, marginTop: 8 }}>
              Recent Security Events
            </Text>
            {logs.filter(l => isSecurityEvent(l.action)).slice(0, 20).map(log => (
              <NeuCard key={log.id} style={{ marginBottom: 8, padding: 14, flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: '#DC262618',
                  alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
                  <ShieldAlert size={16} color="#DC2626" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>
                    {log.action?.replace(/_/g, ' ')}
                  </Text>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>
                    {log.user?.full_name ?? 'System'} · {log.user?.email}
                  </Text>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.35, marginTop: 2 }}>
                    {new Date(log.created_at).toLocaleString('en-US', {
                      month: 'short', day: 'numeric', year: 'numeric',
                      hour: '2-digit', minute: '2-digit', hour12: true,
                    })}
                  </Text>
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
