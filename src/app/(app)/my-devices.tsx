/**
 * My Devices — user self-service device management (all roles).
 * Users can: view all their devices, rename current device, logout current device.
 * Unlimited accounts see total / online / offline counts.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, useColorScheme, Pressable,
  RefreshControl, TextInput, ActivityIndicator, Platform,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  Smartphone, Wifi, WifiOff, Clock, Globe,
  RotateCcw, Pencil, History, ChevronRight, Info, Infinity,
} from 'lucide-react-native';
import { getMyDevices, logoutDevice, renameDevice, DeviceRecord } from '@/lib/api';
import { neuColors, useLayout, neuFlatStyle, neuMicroStyle } from '@/lib/neu';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { PageHeader } from '@/components/PageHeader';
import type { RelativePathString } from 'expo-router';

type ModalState =
  | { type: 'rename'; device: DeviceRecord }
  | { type: 'logout'; device: DeviceRecord }
  | { type: 'info'; device: DeviceRecord }
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
  return Date.now() - new Date(lastActive).getTime() < 5 * 60 * 1000; // 5 min window
}

function DeviceBadge({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <View style={{ backgroundColor: bg, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
      <Text style={{ fontSize: 10, fontWeight: '700', color }}>{label}</Text>
    </View>
  );
}

export default function MyDevices() {
  const scheme = useColorScheme();
  const layout = useLayout();
  const insets = layout.insets;
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const router = useRouter();

  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [maxDevices, setMaxDevices] = useState<number | null>(1);
  const [currentFingerprint, setCurrentFingerprint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modal, setModal] = useState<ModalState>(null);
  const [renameText, setRenameText] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const loadData = useCallback(async () => {
    try {
      const res = await getMyDevices();
      setDevices(res.devices);
      setMaxDevices(res.max_devices);
      // Try to identify current device by stored fingerprint
      if (typeof window !== 'undefined' && window.localStorage) {
        setCurrentFingerprint(window.localStorage.getItem('device_fp'));
      }
    } catch (_) {}
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); loadData(); }, [loadData]));
  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

  const activeDevices  = devices.filter(d => d.status !== 'logged_out');
  const onlineDevices  = activeDevices.filter(d => isOnline(d.last_active_at));
  const offlineDevices = activeDevices.filter(d => !isOnline(d.last_active_at));
  const isUnlimited    = maxDevices === null;

  const handleRename = async () => {
    if (!modal || modal.type !== 'rename' || !renameText.trim()) return;
    setActionLoading(true);
    setErrorMsg('');
    try {
      await renameDevice(modal.device.id, renameText.trim());
      setDevices(prev => prev.map(d => d.id === modal.device.id ? { ...d, device_name: renameText.trim() } : d));
      setModal(null);
    } catch (e: any) { setErrorMsg(e?.message ?? 'Rename failed'); }
    setActionLoading(false);
  };

  const handleLogout = async () => {
    if (!modal || modal.type !== 'logout') return;
    setActionLoading(true);
    setErrorMsg('');
    try {
      await logoutDevice(modal.device.id);
      setDevices(prev => prev.map(d => d.id === modal.device.id ? { ...d, status: 'logged_out' } : d));
      setModal(null);
    } catch (e: any) { setErrorMsg(e?.message ?? 'Logout failed'); }
    setActionLoading(false);
  };

  const isCurrent = (d: DeviceRecord) =>
    currentFingerprint ? d.device_fingerprint === currentFingerprint : false;

  const statusColor = (d: DeviceRecord) =>
    d.status === 'blocked' ? '#DC2626' : isOnline(d.last_active_at) ? '#16A34A' : '#94A3B8';

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
      >
        <View style={{ padding: layout.screenPx, paddingTop: 12 }}>
          {/* Back navigation header */}
          <PageHeader title="My Devices" subtitle="Manage your registered devices" showBack />

          {/* Device icon + history button row */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
            <View style={[{ width: 48, height: 48, borderRadius: 16, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center', marginRight: 12 }, Platform.select({ ios: { shadowColor: c.shadowDark, shadowOffset: { width: 3, height: 3 }, shadowOpacity: 0.5, shadowRadius: 6 }, android: { elevation: 3 } }) ?? {}]}>
              <Smartphone size={24} color={c.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>
                {isUnlimited ? 'Unlimited access' : `${activeDevices.length} of ${maxDevices} devices used`}
              </Text>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginTop: 1 }}>
                {`${devices.length} total \u00b7 ${onlineDevices.length} online`}
              </Text>
            </View>
            <Pressable
              onPress={() => router.push('/(app)/login-history' as RelativePathString)}
              style={[{ width: 40, height: 40, borderRadius: 13, backgroundColor: c.base, alignItems: 'center', justifyContent: 'center' }, Platform.select({ ios: { shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.5, shadowRadius: 5 }, android: { elevation: 3 } }) ?? {}]}
            >
              <History size={18} color={c.primary} />
            </Pressable>
          </View>

          {/* Device limit info card — always shown */}
          <NeuCard style={{ marginBottom: 20, padding: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              {isUnlimited
                ? <Infinity size={16} color={c.primary} />
                : <Smartphone size={16} color={c.primary} />}
              <Text style={{ fontSize: 14, fontWeight: '800', color: c.text }}>
                {isUnlimited ? 'Unlimited Devices' : 'Device Limit'}
              </Text>
            </View>

            {isUnlimited ? (
              // Unlimited account — show stats row
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {[
                  { label: 'Allowed', value: '∞', color: c.primary },
                  { label: 'Active', value: String(activeDevices.length), color: '#16A34A' },
                  { label: 'Online', value: String(onlineDevices.length), color: '#3B82F6' },
                  { label: 'Registered', value: String(devices.length), color: c.text },
                ].map(stat => (
                  <View key={stat.label} style={{ flex: 1, alignItems: 'center', padding: 10, backgroundColor: `${stat.color}0D`, borderRadius: 12 }}>
                    <Text style={{ fontSize: 18, fontWeight: '800', color: stat.color }}>{stat.value}</Text>
                    <Text style={{ fontSize: 10, color: c.text, opacity: 0.5, marginTop: 2, textAlign: 'center' }}>{stat.label}</Text>
                  </View>
                ))}
              </View>
            ) : (
              // Limited account — show bar + rows
              <>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                  {[
                    { label: 'Allowed', value: String(maxDevices ?? 1), color: c.primary },
                    { label: 'Active', value: String(activeDevices.length), color: activeDevices.length >= (maxDevices ?? 1) ? '#DC2626' : '#16A34A' },
                    { label: 'Registered', value: String(devices.length), color: c.text },
                  ].map(stat => (
                    <View key={stat.label} style={{ flex: 1, alignItems: 'center', padding: 10, backgroundColor: `${stat.color}0D`, borderRadius: 12 }}>
                      <Text style={{ fontSize: 20, fontWeight: '800', color: stat.color }}>{stat.value}</Text>
                      <Text style={{ fontSize: 10, color: c.text, opacity: 0.5, marginTop: 2, textAlign: 'center' }}>{stat.label}</Text>
                    </View>
                  ))}
                </View>
                <View style={{ height: 6, backgroundColor: `${c.text}15`, borderRadius: 3, overflow: 'hidden' }}>
                  <View style={{ height: 6, borderRadius: 3, width: `${Math.min((activeDevices.length / (maxDevices ?? 1)) * 100, 100)}%`, backgroundColor: activeDevices.length >= (maxDevices ?? 1) ? '#DC2626' : c.primary }} />
                </View>
                {activeDevices.length >= (maxDevices ?? 1) && (
                  <Text style={{ fontSize: 11, color: '#DC2626', marginTop: 6, fontWeight: '600' }}>
                    ⚠ Device limit reached — contact your admin to increase.
                  </Text>
                )}
              </>
            )}
          </NeuCard>

          {/* Device list */}
          {loading ? (
            <ActivityIndicator color={c.primary} style={{ marginTop: 48 }} />
          ) : devices.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 64 }}>
              <Smartphone size={56} color={c.primary} opacity={0.15} />
              <Text style={{ color: c.text, opacity: 0.4, fontSize: 16, marginTop: 12 }}>No devices registered</Text>
            </View>
          ) : (
            devices.map(device => {
              const current    = isCurrent(device);
              const online     = isOnline(device.last_active_at);
              const isBlocked  = device.status === 'blocked';
              const isLoggedOut = device.status === 'logged_out';

              return (
                <NeuCard key={device.id} style={{ marginBottom: 12, padding: 16, opacity: isLoggedOut ? 0.55 : 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                    {/* Device icon */}
                    <View style={{
                      width: 46, height: 46, borderRadius: 14,
                      backgroundColor: isBlocked ? '#DC262618' : `${c.primary}18`,
                      alignItems: 'center', justifyContent: 'center',
                    }}>
                      <Smartphone size={22} color={isBlocked ? '#DC2626' : c.primary} />
                    </View>

                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>
                          {device.device_name ?? 'Unknown Device'}
                        </Text>
                        {current && <DeviceBadge label="THIS DEVICE" color="#16A34A" bg="#16A34A18" />}
                        {isBlocked && <DeviceBadge label="BLOCKED" color="#DC2626" bg="#DC262618" />}
                        {isLoggedOut && <DeviceBadge label="LOGGED OUT" color="#94A3B8" bg="#94A3B818" />}
                      </View>

                      <Text style={{ fontSize: 12, color: c.text, opacity: 0.55, marginTop: 2 }}>
                        {[device.device_model, device.os, device.os_version].filter(Boolean).join(' · ') || device.platform}
                      </Text>

                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 }}>
                        {online ? <Wifi size={11} color="#16A34A" /> : <WifiOff size={11} color="#94A3B8" />}
                        <Text style={{ fontSize: 11, color: statusColor(device), fontWeight: '600' }}>
                          {isBlocked ? 'Blocked' : isLoggedOut ? 'Logged out' : online ? 'Online' : `Last seen ${timeAgo(device.last_active_at)}`}
                        </Text>
                        {device.ip_address && (
                          <>
                            <Text style={{ fontSize: 11, color: c.text, opacity: 0.3 }}>·</Text>
                            <Globe size={11} color={`${c.text}66`} />
                            <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>{device.ip_address}</Text>
                          </>
                        )}
                      </View>

                      {device.app_version && (
                        <Text style={{ fontSize: 10, color: c.text, opacity: 0.35, marginTop: 3 }}>
                          App v{device.app_version}
                        </Text>
                      )}

                      {isBlocked && device.block_reason && (
                        <View style={{ marginTop: 6, backgroundColor: '#DC262610', borderRadius: 8, padding: 8 }}>
                          <Text style={{ fontSize: 11, color: '#DC2626', fontWeight: '600' }}>
                            Reason: {device.block_reason}
                          </Text>
                        </View>
                      )}
                    </View>

                    {/* Action buttons — only for current, non-blocked, non-logged-out */}
                    {!isBlocked && !isLoggedOut && (
                      <View style={{ gap: 6 }}>
                        <Pressable
                          onPress={() => { setRenameText(device.device_name ?? ''); setModal({ type: 'rename', device }); }}
                          hitSlop={6} style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}
                        >
                          <Pencil size={14} color={c.primary} />
                        </Pressable>
                        {current && (
                          <Pressable
                            onPress={() => setModal({ type: 'logout', device })}
                            hitSlop={6} style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}
                          >
                            <RotateCcw size={14} color="#DC2626" />
                          </Pressable>
                        )}
                        <Pressable
                          onPress={() => setModal({ type: 'info', device })}
                          hitSlop={6} style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: `${c.text}0D`, alignItems: 'center', justifyContent: 'center' }}
                        >
                          <Info size={14} color={`${c.text}99`} />
                        </Pressable>
                      </View>
                    )}
                  </View>
                </NeuCard>
              );
            })
          )}

          {/* Login History link */}
          <Pressable
            onPress={() => router.push('/(app)/login-history' as RelativePathString)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8, padding: 16, borderRadius: 16, backgroundColor: `${c.primary}0D` }}
          >
            <Clock size={18} color={c.primary} />
            <Text style={{ flex: 1, fontSize: 14, fontWeight: '600', color: c.primary }}>View Login History</Text>
            <ChevronRight size={16} color={c.primary} opacity={0.6} />
          </Pressable>
        </View>
      </ScrollView>

      {/* Rename modal */}
      <ResponsiveModal
        visible={modal?.type === 'rename'}
        onClose={() => setModal(null)}
        title="Rename Device"
        footer={
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <NeuButton label="Cancel" onPress={() => setModal(null)} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label="Save" onPress={handleRename} loading={actionLoading} style={{ flex: 1 }} />
          </View>
        }
      >
        <TextInput
          value={renameText}
          onChangeText={setRenameText}
          placeholder="Device name…"
          placeholderTextColor={`${c.text}55`}
          style={{ backgroundColor: `${c.text}0A`, borderRadius: 12, padding: 14, fontSize: 15, color: c.text, marginBottom: 4 }}
        />
        {errorMsg ? <Text style={{ color: '#DC2626', fontSize: 13, marginTop: 6 }}>{errorMsg}</Text> : null}
      </ResponsiveModal>

      {/* Logout modal */}
      <ResponsiveModal
        visible={modal?.type === 'logout'}
        onClose={() => setModal(null)}
        title="Logout This Device"
        footer={
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <NeuButton label="Cancel" onPress={() => setModal(null)} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label="Logout" onPress={handleLogout} loading={actionLoading} variant="danger" style={{ flex: 1 }} />
          </View>
        }
      >
        <Text style={{ fontSize: 14, color: c.text, opacity: 0.65, lineHeight: 22 }}>
          This will log out your current device. You will need to sign in again on this device.
        </Text>
        {errorMsg ? <Text style={{ color: '#DC2626', fontSize: 13, marginTop: 8 }}>{errorMsg}</Text> : null}
      </ResponsiveModal>

      {/* Device info modal */}
      {modal?.type === 'info' && (
        <ResponsiveModal
          visible
          onClose={() => setModal(null)}
          title="Device Details"
          footer={<NeuButton label="Close" onPress={() => setModal(null)} variant="secondary" fullWidth />}
        >
          {[
            ['Device Name', modal.device.device_name],
            ['Model', modal.device.device_model],
            ['Platform', modal.device.platform],
            ['OS', modal.device.os],
            ['OS Version', modal.device.os_version],
            ['App Version', modal.device.app_version],
            ['Manufacturer', modal.device.manufacturer],
            ['IP Address', modal.device.ip_address],
            ['Registered', modal.device.registered_at ? new Date(modal.device.registered_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) : null],
            ['Last Active', modal.device.last_active_at ? new Date(modal.device.last_active_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) : null],
          ].filter(([, v]) => v).map(([k, v]) => (
            <View key={k as string} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: `${c.text}0A` }}>
              <Text style={{ fontSize: 13, color: c.text, opacity: 0.5, fontWeight: '600' }}>{k}</Text>
              <Text style={{ fontSize: 13, color: c.text, fontWeight: '600', maxWidth: '60%', textAlign: 'right' }}>{v}</Text>
            </View>
          ))}
        </ResponsiveModal>
      )}
    </View>
  );
}
