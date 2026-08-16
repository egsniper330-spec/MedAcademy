/**
 * Admin Device Management — full enterprise device control panel.
 * Per-account device listing, block/unblock, logout, delete, limit config, reset, history.
 *
 * REALTIME: subscribes to `devices` table INSERT+UPDATE events so newly
 * registered devices appear instantly without any manual refresh.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, useColorScheme, Pressable,
  RefreshControl, TextInput, ActivityIndicator, FlatList, Platform,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import {
  Smartphone, Search, RotateCcw, Shield, ShieldOff, LogOut,
  Trash2, ChevronRight, ChevronDown, Settings, Wifi, WifiOff,
  Globe, Clock, CheckCircle, XCircle, Infinity, Hash, AlertTriangle,
} from 'lucide-react-native';
import {
  getAllUsers, getAdminUserDevices, resetUserDevice,
  blockDevice, unblockDevice, forceLogoutDevice, deleteDevice,
  setDeviceLimit, DeviceRecord,
} from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { neuColors, neuFlatStyle, useLayout } from '@/lib/neu'
import { PageHeader } from '@/components/PageHeader';
import { getPublicEmail } from '@/lib/api';
import { supabase } from '@/client/supabase';

const LIMIT_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: '1 Device', value: 1 },
  { label: '2 Devices', value: 2 },
  { label: '3 Devices', value: 3 },
  { label: '5 Devices', value: 5 },
  { label: '10 Devices', value: 10 },
  { label: 'Unlimited', value: null },
];

type UserRow = {
  id: string;
  full_name: string;
  email: string;
  role: string;
  max_devices?: number | null;
  // Pre-loaded from DB so the header shows correct count before the row is expanded.
  // Updated optimistically by the Realtime INSERT handler.
  device_count?: number;
};

type DeviceAction =
  | { type: 'block'; device: DeviceRecord; userId: string }
  | { type: 'unblock'; device: DeviceRecord; userId: string }
  | { type: 'logout'; device: DeviceRecord; userId: string }
  | { type: 'delete'; device: DeviceRecord; userId: string }
  | { type: 'reset'; user: UserRow }
  | { type: 'set_limit'; user: UserRow }
  | null;

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function isOnline(lastActive: string) {
  return Date.now() - new Date(lastActive).getTime() < 5 * 60 * 1000;
}

function RoleBadge({ role, c }: { role: string; c: typeof neuColors.light }) {
  const colors: Record<string, string> = {
    student: '#7C3AED', doctor: '#16A34A',
    admin: '#1E90FF', super_admin: '#DC2626',
  };
  const col = colors[role] ?? c.primary;
  return (
    <View style={{ backgroundColor: `${col}18`, borderRadius: 7, paddingHorizontal: 7, paddingVertical: 2 }}>
      <Text style={{ fontSize: 9, fontWeight: '800', color: col, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {role.replace('_', ' ')}
      </Text>
    </View>
  );
}

export default function AdminDevices() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const router = useRouter();

  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [userDeviceMap, setUserDeviceMap] = useState<Record<string, { devices: DeviceRecord[]; loaded: boolean }>>({});
  const [action, setAction] = useState<DeviceAction>(null);
  const [blockReason, setBlockReason] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [selectedLimit, setSelectedLimit] = useState<number | null>(1);

  // Keep a ref to the current map so Realtime callbacks can read it without
  // going stale inside the subscription closure.
  const deviceMapRef = useRef(userDeviceMap);
  useEffect(() => { deviceMapRef.current = userDeviceMap; }, [userDeviceMap]);

  const loadUsers = useCallback(async () => {
    try {
      const data = await getAllUsers();
      // Fetch max_devices AND device count per user in one query.
      // device_count is needed so the header badge ("X / max devices") shows the
      // correct number even before the user row is expanded — previously it
      // always showed 0 because activeCount was derived from the lazy-loaded
      // deviceData which isn't fetched until expand.
      const { data: profileLimits } = await supabase
        .from('profiles')
        .select('id,max_devices');
      const { data: deviceCounts } = await supabase
        .from('devices')
        .select('user_id')
        .neq('status', 'logged_out'); // count active+blocked (not logged-out)
      const limitMap: Record<string, number | null> = {};
      (profileLimits ?? []).forEach((p: { id: string; max_devices: number | null }) => {
        limitMap[p.id] = p.max_devices;
      });
      const countMap: Record<string, number> = {};
      (deviceCounts ?? []).forEach((d: { user_id: string }) => {
        countMap[d.user_id] = (countMap[d.user_id] ?? 0) + 1;
      });
      setUsers(data.map((u: UserRow) => ({
        ...u,
        max_devices:  limitMap[u.id] ?? null,
        device_count: countMap[u.id] ?? 0,
      })));
    } catch (_) {}
    setLoading(false);
  }, []);

  // On every focus: reload user list AND clear the per-user device cache so
  // stale entries never block newly-registered devices from showing up.
  useFocusEffect(useCallback(() => {
    setLoading(true);
    // Clear all cached device lists — forces fresh fetch on next expand
    setUserDeviceMap({});
    loadUsers();
  }, [loadUsers]));

  // ── Realtime subscription ────────────────────────────────────────────────────
  // Listens for INSERT and UPDATE events on the `devices` table.
  // INSERT → new device just registered (e.g. fresh login):
  //   1. Bump device_count on the user row so the header badge updates immediately.
  //   2. If that user's row is currently expanded, prepend the device to the list.
  // UPDATE → existing device changed (status, trust_level, last_active_at, etc.):
  //   patch the matching record in-place so block/logout changes are live.
  useEffect(() => {
    const channel = supabase
      .channel('admin_devices_realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'devices' },
        (payload) => {
          const newDevice = payload.new as DeviceRecord & { user_id: string };
          const userId = newDevice.user_id;

          // Always bump the header count — visible even when row is collapsed.
          setUsers(prev => prev.map(u =>
            u.id === userId
              ? { ...u, device_count: (u.device_count ?? 0) + 1 }
              : u
          ));

          // If the row is expanded, prepend the device to the live list too.
          const existing = deviceMapRef.current[userId];
          if (!existing?.loaded) return;
          setUserDeviceMap(prev => ({
            ...prev,
            [userId]: {
              loaded: true,
              devices: [newDevice, ...(prev[userId]?.devices ?? [])],
            },
          }));
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'devices' },
        (payload) => {
          const updated = payload.new as DeviceRecord & { user_id: string };
          const userId = updated.user_id;
          setUserDeviceMap(prev => {
            const entry = prev[userId];
            if (!entry?.loaded) return prev;
            return {
              ...prev,
              [userId]: {
                loaded: true,
                devices: entry.devices.map(d => d.id === updated.id ? { ...d, ...updated } : d),
              },
            };
          });
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  // Full refresh: reload user list + clear all cached device maps so they
  // re-fetch fresh when expanded. Preserves query/filter/scroll position.
  const onRefresh = async () => {
    setRefreshing(true);
    setUserDeviceMap({});   // clear cached per-user device lists
    await loadUsers();
    setRefreshing(false);
  };

  // Always force-reload on expand — never skip due to stale `loaded` flag.
  // This ensures that re-expanding a user always shows the latest devices.
  const loadUserDevices = async (userId: string, forceReload = false) => {
    if (deviceMapRef.current[userId]?.loaded && !forceReload) return;
    try {
      const res = await getAdminUserDevices(userId);
      setUserDeviceMap(prev => ({ ...prev, [userId]: { devices: res.devices, loaded: true } }));
    } catch (_) {
      setUserDeviceMap(prev => ({ ...prev, [userId]: { devices: [], loaded: true } }));
    }
  };

  const toggleExpand = async (userId: string) => {
    if (expandedUser === userId) { setExpandedUser(null); return; }
    setExpandedUser(userId);
    // Always force-reload on expand so new logins are never missed
    setUserDeviceMap(prev => ({ ...prev, [userId]: { devices: [], loaded: false } }));
    await loadUserDevices(userId, true);
  };

  const refreshUserDevices = async (userId: string) => {
    setUserDeviceMap(prev => ({ ...prev, [userId]: { devices: [], loaded: false } }));
    await loadUserDevices(userId, true);
  };

  const executeAction = async () => {
    if (!action) return;
    setActionLoading(true);
    setErrorMsg('');
    try {
      if (action.type === 'block') {
        await blockDevice(action.device.id, blockReason);
        setUserDeviceMap(prev => ({
          ...prev,
          [action.userId]: {
            ...prev[action.userId],
            devices: prev[action.userId]?.devices.map(d =>
              d.id === action.device.id ? { ...d, status: 'blocked', block_reason: blockReason } : d
            ) ?? [],
          },
        }));
      } else if (action.type === 'unblock') {
        await unblockDevice(action.device.id);
        setUserDeviceMap(prev => ({
          ...prev,
          [action.userId]: {
            ...prev[action.userId],
            devices: prev[action.userId]?.devices.map(d =>
              d.id === action.device.id ? { ...d, status: 'active', block_reason: null } : d
            ) ?? [],
          },
        }));
      } else if (action.type === 'logout') {
        // forceLogoutDevice bumps security_version → target device is kicked immediately
        await forceLogoutDevice(action.device.id);
        setUserDeviceMap(prev => ({
          ...prev,
          [action.userId]: {
            ...prev[action.userId],
            devices: prev[action.userId]?.devices.map(d =>
              d.id === action.device.id ? { ...d, status: 'logged_out', trust_level: 'revoked' } : d
            ) ?? [],
          },
        }));
      } else if (action.type === 'delete') {
        await deleteDevice(action.device.id);
        setUserDeviceMap(prev => ({
          ...prev,
          [action.userId]: {
            ...prev[action.userId],
            devices: prev[action.userId]?.devices.filter(d => d.id !== action.device.id) ?? [],
          },
        }));
      } else if (action.type === 'reset') {
        await resetUserDevice(action.user.id);
        setUserDeviceMap(prev => ({
          ...prev,
          [action.user.id]: { devices: [], loaded: true },
        }));
      } else if (action.type === 'set_limit') {
        await setDeviceLimit(action.user.id, selectedLimit);
        setUsers(prev => prev.map(u => u.id === action.user.id ? { ...u, max_devices: selectedLimit } : u));
      }
      setAction(null);
      setBlockReason('');
    } catch (e: any) { setErrorMsg(e?.message ?? 'Action failed'); }
    setActionLoading(false);
  };

  const filtered = users.filter(u =>
    !query || u.full_name?.toLowerCase().includes(query.toLowerCase()) || u.email?.toLowerCase().includes(query.toLowerCase())
  );

  const renderUserRow = (user: UserRow) => {
    const isExpanded = expandedUser === user.id;
    const deviceData = userDeviceMap[user.id];
    const devices = deviceData?.devices ?? [];

    // Use expanded device list when available (accurate after expand).
    // Fall back to pre-loaded device_count from DB for the collapsed header view —
    // this is what was previously always 0 (the core display bug).
    const activeCount  = deviceData?.loaded
      ? devices.filter(d => d.status !== 'logged_out').length
      : (user.device_count ?? 0);
    const blockedCount = devices.filter(d => d.status === 'blocked').length;
    const onlineCount  = devices.filter(d => d.status === 'active' && isOnline(d.last_active_at)).length;
    const isUnlimited  = user.max_devices === null;
    const limitReached = !isUnlimited && activeCount >= (user.max_devices ?? 1);

    return (
      <NeuCard key={user.id} style={{ marginBottom: 12, padding: 0, overflow: 'hidden' }}>
        {/* User summary row */}
        <Pressable
          onPress={() => toggleExpand(user.id)}
          style={{ flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 }}
        >
          <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: c.primary }}>{user.full_name?.[0]?.toUpperCase() ?? '?'}</Text>
          </View>

          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }} numberOfLines={1}>{user.full_name}</Text>
              <RoleBadge role={user.role} c={c} />
            </View>
            <Text style={{ fontSize: 11, color: c.text, opacity: 0.45, marginTop: 2 }} numberOfLines={1}>{getPublicEmail(user) ?? '—'}</Text>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 5, flexWrap: 'wrap' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                <Smartphone size={11} color={c.primary} />
                <Text style={{ fontSize: 11, color: c.primary, fontWeight: '700' }}>
                  {isUnlimited ? `${activeCount} / ∞ Unlimited` : `${activeCount} / ${user.max_devices ?? 1} devices`}
                </Text>
              </View>
              {onlineCount > 0 && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                  <Wifi size={11} color="#16A34A" />
                  <Text style={{ fontSize: 11, color: '#16A34A', fontWeight: '700' }}>{onlineCount} online</Text>
                </View>
              )}
              {blockedCount > 0 && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                  <Shield size={11} color="#DC2626" />
                  <Text style={{ fontSize: 11, color: '#DC2626', fontWeight: '700' }}>{blockedCount} blocked</Text>
                </View>
              )}
              {limitReached && (
                <View style={{ backgroundColor: '#DC262618', borderRadius: 6, paddingHorizontal: 5, paddingVertical: 2 }}>
                  <Text style={{ fontSize: 9, fontWeight: '800', color: '#DC2626' }}>LIMIT REACHED</Text>
                </View>
              )}
            </View>
          </View>

          {isExpanded ? <ChevronDown size={18} color={`${c.text}66`} /> : <ChevronRight size={18} color={`${c.text}66`} />}
        </Pressable>

        {/* Quick actions row */}
        {isExpanded && (
          <View style={{ borderTopWidth: 1, borderTopColor: `${c.text}0A`, padding: 12 }}>
            {/* Quick action buttons */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Pressable
                  onPress={() => { setSelectedLimit(user.max_devices ?? 1); setAction({ type: 'set_limit', user }); }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: `${c.primary}18`, borderRadius: 10 }}
                >
                  <Settings size={13} color={c.primary} />
                  <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>Set Limit</Text>
                </Pressable>
                <Pressable
                  onPress={() => setAction({ type: 'reset', user })}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#D9770618', borderRadius: 10 }}
                >
                  <RotateCcw size={13} color="#D97706" />
                  <Text style={{ fontSize: 12, fontWeight: '700', color: '#D97706' }}>Reset All</Text>
                </Pressable>
                <Pressable
                  onPress={() => router.push(`/(app)/login-history?user_id=${user.id}&user_name=${encodeURIComponent(user.full_name)}` as RelativePathString)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: `${c.text}0D`, borderRadius: 10 }}
                >
                  <Clock size={13} color={`${c.text}99`} />
                  <Text style={{ fontSize: 12, fontWeight: '700', color: c.text, opacity: 0.6 }}>History</Text>
                </Pressable>
              </View>
            </ScrollView>

            {/* Devices list */}
            {!deviceData?.loaded ? (
              <ActivityIndicator color={c.primary} style={{ padding: 16 }} />
            ) : devices.length === 0 ? (
              <View style={{ alignItems: 'center', paddingVertical: 20 }}>
                <Text style={{ color: c.text, opacity: 0.4, fontSize: 13 }}>No devices registered</Text>
              </View>
            ) : (
              devices.map(device => {
                const online    = device.status === 'active' && isOnline(device.last_active_at);
                const isBlocked = device.status === 'blocked';
                const isOut     = device.status === 'logged_out';
                return (
                  <View key={device.id} style={{ padding: 12, backgroundColor: `${c.text}06`, borderRadius: 12, marginBottom: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                      <View style={{ width: 36, height: 36, borderRadius: 11, backgroundColor: isBlocked ? '#DC262618' : `${c.primary}14`, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <Smartphone size={17} color={isBlocked ? '#DC2626' : c.primary} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                          <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>{device.device_name ?? 'Unknown'}</Text>
                          {isBlocked && <Text style={{ fontSize: 9, fontWeight: '800', color: '#DC2626', backgroundColor: '#DC262618', paddingHorizontal: 5, paddingVertical: 2, borderRadius: 5 }}>BLOCKED</Text>}
                          {isOut && <Text style={{ fontSize: 9, fontWeight: '800', color: '#94A3B8', backgroundColor: '#94A3B818', paddingHorizontal: 5, paddingVertical: 2, borderRadius: 5 }}>LOGGED OUT</Text>}
                        </View>
                        <Text style={{ fontSize: 11, color: c.text, opacity: 0.5, marginTop: 2 }}>
                          {[device.device_model, device.os, device.os_version].filter(Boolean).join(' · ') || device.platform}
                        </Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 }}>
                          {online ? <Wifi size={10} color="#16A34A" /> : <WifiOff size={10} color="#94A3B8" />}
                          <Text style={{ fontSize: 11, color: online ? '#16A34A' : '#94A3B8', fontWeight: '600' }}>
                            {isBlocked ? `Blocked` : isOut ? 'Logged out' : online ? 'Online now' : `Last seen ${timeAgo(device.last_active_at)}`}
                          </Text>
                          {device.ip_address && (
                            <>
                              <Text style={{ fontSize: 11, color: `${c.text}30` }}>·</Text>
                              <Globe size={10} color={`${c.text}55`} />
                              <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{device.ip_address}</Text>
                            </>
                          )}
                        </View>
                        {device.app_version && (
                          <Text style={{ fontSize: 10, color: c.text, opacity: 0.3, marginTop: 2 }}>v{device.app_version}</Text>
                        )}
                        {isBlocked && device.block_reason && (
                          <Text style={{ fontSize: 11, color: '#DC2626', marginTop: 4 }}>⛔ {device.block_reason}</Text>
                        )}
                      </View>

                      {/* Per-device actions */}
                      <View style={{ flexDirection: 'row', gap: 5, flexShrink: 0 }}>
                        {!isBlocked && !isOut && (
                          <Pressable
                            onPress={() => { setBlockReason(''); setAction({ type: 'block', device, userId: user.id }); }}
                            style={{ width: 30, height: 30, borderRadius: 9, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}
                          >
                            <Shield size={13} color="#DC2626" />
                          </Pressable>
                        )}
                        {isBlocked && (
                          <Pressable
                            onPress={() => setAction({ type: 'unblock', device, userId: user.id })}
                            style={{ width: 30, height: 30, borderRadius: 9, backgroundColor: '#16A34A18', alignItems: 'center', justifyContent: 'center' }}
                          >
                            <ShieldOff size={13} color="#16A34A" />
                          </Pressable>
                        )}
                        {!isOut && !isBlocked && (
                          <Pressable
                            onPress={() => setAction({ type: 'logout', device, userId: user.id })}
                            style={{ width: 30, height: 30, borderRadius: 9, backgroundColor: '#D9770618', alignItems: 'center', justifyContent: 'center' }}
                          >
                            <LogOut size={13} color="#D97706" />
                          </Pressable>
                        )}
                        <Pressable
                          onPress={() => setAction({ type: 'delete', device, userId: user.id })}
                          style={{ width: 30, height: 30, borderRadius: 9, backgroundColor: `${c.text}0D`, alignItems: 'center', justifyContent: 'center' }}
                        >
                          <Trash2 size={13} color={`${c.text}99`} />
                        </Pressable>
                      </View>
                    </View>
                  </View>
                );
              })
            )}
          </View>
        )}
      </NeuCard>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
      >
        <View style={{ padding: layout.screenPx, paddingTop: 0 }}>
          {/* Header */}
          <PageHeader
            title="Device Management"
            subtitle={`${users.length} accounts`}
            accentColor={c.primary}
            rightAction={
              <Pressable
                onPress={onRefresh}
                disabled={refreshing}
                style={{
                  width: 40, height: 40, borderRadius: 13,
                  backgroundColor: c.base,
                  alignItems: 'center', justifyContent: 'center',
                  shadowColor: c.shadowDark,
                  shadowOffset: { width: 2, height: 2 },
                  shadowOpacity: 0.55,
                  shadowRadius: 5,
                }}
              >
                {refreshing
                  ? <ActivityIndicator size="small" color={c.primary} />
                  : <RotateCcw size={18} color={c.primary} />}
              </Pressable>
            }
          />

          {/* Search */}
          <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: c.base, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 16, minWidth: 0, ...Platform.select({ ios: { shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.5, shadowRadius: 6 }, android: { elevation: 3 } }) }}>
            <Search size={18} color={c.text} opacity={0.4} style={{ flexShrink: 0 }} />
            <TextInput
              value={query} onChangeText={setQuery}
              placeholder="Search user by name or email…"
              placeholderTextColor={`${c.text}55`}
              style={{ flex: 1, minWidth: 0, marginLeft: 10, fontSize: 15, color: c.text }}
            />
          </View>

          {loading ? (
            <ActivityIndicator color={c.primary} style={{ marginTop: 48 }} />
          ) : filtered.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 64 }}>
              <Smartphone size={56} color={c.primary} opacity={0.15} />
              <Text style={{ color: c.text, opacity: 0.4, fontSize: 16, marginTop: 12 }}>No users found</Text>
            </View>
          ) : (
            filtered.map(user => renderUserRow(user))
          )}
        </View>
      </ScrollView>

      {/* Block device modal */}
      <ResponsiveModal
        visible={action?.type === 'block'}
        onClose={() => setAction(null)}
        title="Block Device"
        footer={
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <NeuButton label="Cancel" onPress={() => setAction(null)} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label="Block" onPress={executeAction} loading={actionLoading} variant="danger" style={{ flex: 1 }} />
          </View>
        }
      >
        <Text style={{ fontSize: 14, color: c.text, opacity: 0.65, marginBottom: 12, lineHeight: 22 }}>
          Block <Text style={{ fontWeight: '700' }}>{action && 'device' in action ? (action.device.device_name ?? 'this device') : ''}</Text>? The device will not be able to log in until unblocked.
        </Text>
        <TextInput
          value={blockReason} onChangeText={setBlockReason}
          placeholder="Block reason (optional)…"
          placeholderTextColor={`${c.text}55`}
          style={{ backgroundColor: `${c.text}0A`, borderRadius: 12, paddingHorizontal: 13, paddingVertical: 13, fontSize: 14, color: c.text, minWidth: 0 }}
        />
        {errorMsg ? <Text style={{ color: '#DC2626', fontSize: 13, marginTop: 8 }}>{errorMsg}</Text> : null}
      </ResponsiveModal>

      {/* Unblock modal */}
      <ResponsiveModal
        visible={action?.type === 'unblock'}
        onClose={() => setAction(null)}
        title="Unblock Device"
        footer={
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <NeuButton label="Cancel" onPress={() => setAction(null)} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label="Unblock" onPress={executeAction} loading={actionLoading} style={{ flex: 1 }} />
          </View>
        }
      >
        <Text style={{ fontSize: 14, color: c.text, opacity: 0.65, lineHeight: 22 }}>
          Unblock <Text style={{ fontWeight: '700' }}>{action && 'device' in action ? (action.device.device_name ?? 'this device') : ''}</Text>? The device will be able to log in again.
        </Text>
        {errorMsg ? <Text style={{ color: '#DC2626', fontSize: 13, marginTop: 8 }}>{errorMsg}</Text> : null}
      </ResponsiveModal>

      {/* Logout device modal */}
      <ResponsiveModal
        visible={action?.type === 'logout'}
        onClose={() => setAction(null)}
        title="Logout Device"
        footer={
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <NeuButton label="Cancel" onPress={() => setAction(null)} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label="Logout" onPress={executeAction} loading={actionLoading} variant="danger" style={{ flex: 1 }} />
          </View>
        }
      >
        <Text style={{ fontSize: 14, color: c.text, opacity: 0.65, lineHeight: 22 }}>
          Force logout <Text style={{ fontWeight: '700' }}>{action && 'device' in action ? (action.device.device_name ?? 'this device') : ''}</Text>? The user will need to sign in again from this device.
        </Text>
        {errorMsg ? <Text style={{ color: '#DC2626', fontSize: 13, marginTop: 8 }}>{errorMsg}</Text> : null}
      </ResponsiveModal>

      {/* Delete device modal */}
      <ResponsiveModal
        visible={action?.type === 'delete'}
        onClose={() => setAction(null)}
        title="Delete Device Record"
        footer={
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <NeuButton label="Cancel" onPress={() => setAction(null)} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label="Delete" onPress={executeAction} loading={actionLoading} variant="danger" style={{ flex: 1 }} />
          </View>
        }
      >
        <View style={{ backgroundColor: '#DC262610', borderRadius: 12, padding: 12, marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={16} color="#DC2626" />
            <Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>Permanent action</Text>
          </View>
          <Text style={{ fontSize: 12, color: '#DC2626', marginTop: 4, lineHeight: 18 }}>
            This will permanently remove the device record. The user will be able to re-register this device on next login.
          </Text>
        </View>
        {errorMsg ? <Text style={{ color: '#DC2626', fontSize: 13 }}>{errorMsg}</Text> : null}
      </ResponsiveModal>

      {/* Reset all devices modal */}
      <ResponsiveModal
        visible={action?.type === 'reset'}
        onClose={() => setAction(null)}
        title="Reset All Devices"
        footer={
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <NeuButton label="Cancel" onPress={() => setAction(null)} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label="Reset All" onPress={executeAction} loading={actionLoading} variant="danger" style={{ flex: 1 }} />
          </View>
        }
      >
        <Text style={{ fontSize: 14, color: c.text, opacity: 0.65, lineHeight: 22 }}>
          Remove all registered devices for{' '}
          <Text style={{ fontWeight: '700' }}>{action?.type === 'reset' ? action.user.full_name : ''}</Text>. They must re-register on next login.
        </Text>
        {errorMsg ? <Text style={{ color: '#DC2626', fontSize: 13, marginTop: 8 }}>{errorMsg}</Text> : null}
      </ResponsiveModal>

      {/* Set device limit modal */}
      <ResponsiveModal
        visible={action?.type === 'set_limit'}
        onClose={() => setAction(null)}
        title="Configure Device Limit"
        footer={
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <NeuButton label="Cancel" onPress={() => setAction(null)} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label="Apply" onPress={executeAction} loading={actionLoading} style={{ flex: 1 }} />
          </View>
        }
      >
        {action?.type === 'set_limit' && (
          <View>
            <Text style={{ fontSize: 13, color: c.text, opacity: 0.6, marginBottom: 14, lineHeight: 20 }}>
              Set max devices for <Text style={{ fontWeight: '700', opacity: 1 }}>{action.user.full_name}</Text>:
            </Text>
            {LIMIT_OPTIONS.map(opt => (
              <Pressable
                key={String(opt.value)}
                onPress={() => setSelectedLimit(opt.value)}
                style={{
                  flexDirection: 'row', alignItems: 'center', padding: 13, borderRadius: 12, marginBottom: 7,
                  backgroundColor: selectedLimit === opt.value ? `${c.primary}18` : `${c.text}08`,
                  borderWidth: 1.5,
                  borderColor: selectedLimit === opt.value ? c.primary : 'transparent',
                }}
              >
                <View style={{ width: 30, height: 30, borderRadius: 9, backgroundColor: opt.value === null ? `${c.primary}20` : `${c.text}12`, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                  {opt.value === null
                    ? <Infinity size={15} color={c.primary} />
                    : <Text style={{ fontSize: 14, fontWeight: '800', color: c.text }}>{opt.value}</Text>
                  }
                </View>
                <Text style={{ flex: 1, fontSize: 14, fontWeight: selectedLimit === opt.value ? '700' : '500', color: selectedLimit === opt.value ? c.primary : c.text }}>
                  {opt.label}
                </Text>
                {selectedLimit === opt.value && <CheckCircle size={18} color={c.primary} />}
              </Pressable>
            ))}
          </View>
        )}
        {errorMsg ? <Text style={{ color: '#DC2626', fontSize: 13, marginTop: 8 }}>{errorMsg}</Text> : null}
      </ResponsiveModal>
    </View>
  );
}

