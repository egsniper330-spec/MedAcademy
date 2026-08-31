/**
 * DeviceManagerSheet — full device management panel.
 * Shows all registered devices for a user with inline actions:
 * reset, logout, block/unblock, delete, set limit, unlimited toggle.
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, ScrollView, ActivityIndicator, Pressable,
  useColorScheme, TextInput,
} from 'react-native';
import {
  Smartphone, Wifi, WifiOff, Shield, ShieldOff, Trash2,
  RefreshCw, LogOut, Infinity, Settings, CheckCircle, Clock,
} from 'lucide-react-native';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { neuColors } from '@/lib/neu';
import { useActionLoading } from '@/lib/useActionLoading';
import {
  getAdminUserDevices, logoutDevice, forceLogoutDevice, blockDevice, unblockDevice,
  deleteDevice, resetUserDevice, setDeviceLimit,
  type DeviceRecord,
} from '@/lib/api';
import { parseError } from '@/lib/parseError';
import { useToast } from '@/components/Toast';
import { backendClient } from '@/client/backendClient';

interface DeviceManagerSheetProps {
  visible: boolean;
  onClose: () => void;
  userId: string;
  userName?: string;
}

export function DeviceManagerSheet({ visible, onClose, userId, userName }: DeviceManagerSheetProps) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { showToast } = useToast();
  const { isLoading, run } = useActionLoading();

  const [devices, setDevices]           = useState<DeviceRecord[]>([]);
  const [maxDevices, setMaxDevices]     = useState<number | null>(null);
  const [unlimited, setUnlimited]       = useState(false);
  const [loading, setLoading]           = useState(false);
  const [limitInput, setLimitInput]     = useState('');
  const [showLimitInput, setShowLimitInput] = useState(false);

  // Keep a ref so Polling callback can read latest devices without closure staleness
  const devicesRef = useRef<DeviceRecord[]>([]);
  useEffect(() => { devicesRef.current = devices; }, [devices]);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const res = await getAdminUserDevices(userId);
      setDevices((res as any)?.devices ?? []);
      const profile = (res as any)?.profile;
      setMaxDevices(profile?.max_devices ?? null);
      // unlimited = max_devices IS NULL (allow_unlimited column removed from schema)
      setUnlimited(profile?.max_devices === null || profile?.role === 'super_admin');
      setLimitInput(String(profile?.max_devices ?? 1));
    } catch (e) {
      showToast({ type: 'error', message: parseError(e, 'Failed to load devices.') });
    }
    setLoading(false);
  }, [userId]);

  // Load when sheet opens
  useEffect(() => { if (visible) load(); }, [visible, load]);

  // ── Polling: live device updates while sheet is open ──────────────────────
  // INSERT → new device registered (e.g. user just logged in on a new device)
  // UPDATE → status/trust_level changed (block, logout, revoke, etc.)
  useEffect(() => {
    if (!visible || !userId) return;
    const channel = backendClient
      .poll(`device_sheet_${userId}`)
      .on(
        'php_polling',
        { event: 'INSERT', schema: 'public', table: 'devices', filter: `user_id=eq.${userId}` },
        (payload) => {
          const newDev = payload.new as DeviceRecord;
          setDevices(prev => {
            // Avoid duplicates (Polling can occasionally deliver twice)
            if (prev.some(d => d.id === newDev.id)) return prev;
            return [newDev, ...prev];
          });
        }
      )
      .on(
        'php_polling',
        { event: 'UPDATE', schema: 'public', table: 'devices', filter: `user_id=eq.${userId}` },
        (payload) => {
          const updated = payload.new as DeviceRecord;
          setDevices(prev => prev.map(d => d.id === updated.id ? { ...d, ...updated } : d));
        }
      )
      .on(
        'php_polling',
        { event: 'DELETE', schema: 'public', table: 'devices', filter: `user_id=eq.${userId}` },
        (payload) => {
          const deleted = payload.old as { id: string };
          setDevices(prev => prev.filter(d => d.id !== deleted.id));
        }
      )
      .subscribe();

    return () => { backendClient.removePoller(channel); };
  }, [visible, userId]);

  const handle = async (key: string, fn: () => Promise<unknown>, successMsg: string) => {
    const result = await run(key, async () => {
      await fn();
      return true;
    });
    if (result) {
      showToast({ type: 'success', message: successMsg });
      await load();
    }
  };

  const handleAction = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    try {
      await handle(key, fn, msg);
    } catch (e) {
      showToast({ type: 'error', message: parseError(e) });
    }
  };

  const handleSetLimit = async () => {
    const val = parseInt(limitInput, 10);
    if (isNaN(val) || val < 1) {
      showToast({ type: 'error', message: 'Enter a valid number ≥ 1.' });
      return;
    }
    await handleAction('set_limit', () => setDeviceLimit(userId, val) as Promise<unknown>, `Device limit set to ${val}.`);
    setShowLimitInput(false);
  };

  const handleToggleUnlimited = async () => {
    const newVal = !unlimited;
    await handleAction(
      'unlimited',
      () => setDeviceLimit(userId, newVal ? null : (maxDevices ?? 1)) as Promise<unknown>,
      newVal ? 'Unlimited devices enabled.' : 'Device limit restored.'
    );
  };

  const online = devices.filter(d => {
    const last = d.last_active_at ? new Date(d.last_active_at).getTime() : 0;
    return Date.now() - last < 5 * 60 * 1000; // within 5 min = online
  });

  function relativeTime(iso: string) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins  = Math.floor(diff / 60000);
    const hours = Math.floor(mins / 60);
    const days  = Math.floor(hours / 24);
    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (mins > 0) return `${mins}m ago`;
    return 'Just now';
  }

  return (
    <ResponsiveModal
      visible={visible}
      onClose={onClose}
      title={`Devices — ${userName ?? 'User'}`}
      subtitle={unlimited ? 'Unlimited devices enabled' : `Max ${maxDevices ?? 1} device${(maxDevices ?? 1) !== 1 ? 's' : ''}`}
    >
      {loading ? (
        <ActivityIndicator color={c.primary} style={{ marginVertical: 30 }} />
      ) : (
        // Remove fixed maxHeight — ResponsiveModal already caps the sheet to
        // (screenH - safeTop) * 0.92 and provides its own ScrollView.
        // Wrapping in another maxHeight-constrained ScrollView double-caps the
        // height and breaks layout on small phones (SE) and landscape.
        <View>
          {/* Summary row */}
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            {[
              { label: 'Total',    value: devices.length,                                              color: c.primary },
              { label: 'Online',   value: online.length,                                               color: '#16A34A' },
              { label: 'Offline',  value: devices.length - online.length,                              color: '#6B7280' },
              { label: 'Blocked',  value: devices.filter(d => d.status === 'blocked').length,          color: '#DC2626' },
            ].map(s => (
              <NeuCard key={s.label} style={{ flex: 1, minWidth: 72, padding: 10, alignItems: 'center' }}>
                <Text style={{ fontSize: 18, fontWeight: '800', color: s.color }}>{s.value}</Text>
                <Text style={{ fontSize: 10, color: c.text, opacity: 0.45 }}>{s.label}</Text>
              </NeuCard>
            ))}
          </View>

          {/* Device limit controls */}
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
            <Pressable
              onPress={handleToggleUnlimited}
              disabled={isLoading('unlimited')}
              style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 14,
                backgroundColor: unlimited ? '#2DA8FF18' : `${c.text}0A` }}>
              {isLoading('unlimited')
                ? <ActivityIndicator size="small" color="#2DA8FF" />
                : <Infinity size={16} color="#2DA8FF" />}
              <Text style={{ fontSize: 13, fontWeight: '600', color: '#2DA8FF' }}>
                {unlimited ? 'Disable Unlimited' : 'Enable Unlimited'}
              </Text>
            </Pressable>
            <Pressable onPress={() => setShowLimitInput(p => !p)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 14, backgroundColor: `${c.text}0A` }}>
              <Settings size={16} color={c.text} style={{ opacity: 0.6 } as any} />
              <Text style={{ fontSize: 13, fontWeight: '600', color: c.text, opacity: 0.7 }}>Set Limit</Text>
            </Pressable>
          </View>

          {showLimitInput && (
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14, alignItems: 'center' }}>
              <TextInput
                value={limitInput}
                onChangeText={setLimitInput}
                keyboardType="number-pad"
                placeholder="Max devices"
                placeholderTextColor={`${c.text}55`}
                style={{ flex: 1, backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11,
                  shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.45, shadowRadius: 5,
                  fontSize: 15, color: c.text }}
              />
              <NeuButton label="Apply" onPress={handleSetLimit} loading={isLoading('set_limit')} style={{ paddingHorizontal: 18 }} />
            </View>
          )}

          {/* Admin reset all */}
          <NeuButton
            label="Reset All Devices"
            icon={<RefreshCw size={15} color="#fff" />}
            onPress={() => handleAction('reset_all', () => resetUserDevice(userId) as Promise<unknown>, 'All devices reset.')}
            loading={isLoading('reset_all')}
            variant="danger"
            fullWidth
            style={{ marginBottom: 16 }}
          />

          {/* Device list */}
          {devices.length === 0 ? (
            <View style={{ alignItems: 'center', padding: 30 }}>
              <Smartphone size={36} color={c.primary} style={{ opacity: 0.2 } as any} />
              <Text style={{ color: c.text, opacity: 0.4, marginTop: 12 }}>No registered devices</Text>
            </View>
          ) : (
            devices.map(device => {
              const isOnline = online.some(d => d.id === device.id);
              const isBlocked = device.status === 'blocked';
              return (
                <NeuCard key={device.id} style={{ marginBottom: 10, padding: 14 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                    {/* Icon */}
                    <View style={{ width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
                      backgroundColor: isBlocked ? '#DC262612' : isOnline ? '#16A34A12' : `${c.text}0A` }}>
                      <Smartphone size={18} color={isBlocked ? '#DC2626' : isOnline ? '#16A34A' : c.text} />
                    </View>

                    {/* Info */}
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>
                        {device.device_name ?? device.device_model ?? 'Unknown Device'}
                      </Text>
                      <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>
                        {[device.platform, device.os, device.os_version].filter(Boolean).join(' · ')}
                      </Text>
                      {device.app_version && (
                        <Text style={{ fontSize: 10, color: c.text, opacity: 0.35 }}>App v{device.app_version}</Text>
                      )}
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 }}>
                        {isOnline
                          ? <><Wifi size={11} color="#16A34A" /><Text style={{ fontSize: 10, color: '#16A34A', fontWeight: '600' }}>Online</Text></>
                          : <><WifiOff size={11} color="#6B7280" /><Text style={{ fontSize: 10, color: '#6B7280' }}>{device.last_active_at ? relativeTime(device.last_active_at) : 'Never'}</Text></>
                        }
                        {isBlocked && (
                          <View style={{ backgroundColor: '#DC262618', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1, marginLeft: 4 }}>
                            <Text style={{ fontSize: 9, fontWeight: '700', color: '#DC2626' }}>BLOCKED</Text>
                          </View>
                        )}
                      </View>
                    </View>
                  </View>

                  {/* Action row */}
                  <View style={{ flexDirection: 'row', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                    {/* Logout — uses force_logout so security_version is bumped and device is kicked immediately */}
                    <ActionChip
                      label="Logout" icon={<LogOut size={12} color="#D97706" />} color="#D97706"
                      loading={isLoading(`logout_${device.id}`)}
                      onPress={() => handleAction(`logout_${device.id}`, () => forceLogoutDevice(device.id) as Promise<unknown>, 'Device logged out.')}
                    />
                    {/* Block / Unblock */}
                    {isBlocked ? (
                      <ActionChip
                        label="Unblock" icon={<ShieldOff size={12} color="#16A34A" />} color="#16A34A"
                        loading={isLoading(`unblock_${device.id}`)}
                        onPress={() => handleAction(`unblock_${device.id}`, () => unblockDevice(device.id) as Promise<unknown>, 'Device unblocked.')}
                      />
                    ) : (
                      <ActionChip
                        label="Block" icon={<Shield size={12} color="#DC2626" />} color="#DC2626"
                        loading={isLoading(`block_${device.id}`)}
                        onPress={() => handleAction(`block_${device.id}`, () => blockDevice(device.id) as Promise<unknown>, 'Device blocked.')}
                      />
                    )}
                    {/* Delete */}
                    <ActionChip
                      label="Delete" icon={<Trash2 size={12} color="#DC2626" />} color="#DC2626"
                      loading={isLoading(`delete_${device.id}`)}
                      onPress={() => handleAction(`delete_${device.id}`, () => deleteDevice(device.id) as Promise<unknown>, 'Device record deleted.')}
                    />
                  </View>
                </NeuCard>
              );
            })
          )}
        </View>
      )}
    </ResponsiveModal>
  );
}

function ActionChip({ label, icon, color, loading, onPress }: {
  label: string; icon: React.ReactNode; color: string;
  loading: boolean; onPress: () => void;
}) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  return (
    <Pressable onPress={onPress} disabled={loading}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6,
        borderRadius: 10, backgroundColor: `${color}12` }}>
      {loading ? <ActivityIndicator size="small" color={color} style={{ width: 12 }} /> : icon}
      <Text style={{ fontSize: 12, fontWeight: '600', color }}>{label}</Text>
    </Pressable>
  );
}
