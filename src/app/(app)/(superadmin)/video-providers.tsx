/**
 * VideoProvidersScreen — Super Admin only
 * Manage global video provider availability and per-teacher overrides.
 * FinalPermission = GlobalEnabled AND TeacherEnabled
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, Switch, ActivityIndicator,
  RefreshControl, useColorScheme, TextInput, Pressable,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Video, Users, Globe, Lock, Unlock, AlertTriangle, Search, ChevronDown, ChevronUp } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout } from '@/lib/neu';
import {
  getVideoProviders, setGlobalProviderEnabled,
  getDoctorsForProviderMgmt, getTeacherProviderPermissionsById,
  setTeacherProviderPermission,
  type VideoProvider, type TeacherProviderPermission,
} from '@/lib/api';

interface DoctorRow {
  id: string;
  full_name: string;
  email: string;
  permissions: TeacherProviderPermission[];
  expanded: boolean;
  loading: boolean;
}

const PROVIDER_COLORS: Record<string, string> = {
  plyr: '#1E90FF',
  vdocipher: '#7C3AED',
};
const PROVIDER_ICONS: Record<string, any> = {
  plyr: Video,
  vdocipher: Lock,
};

export default function VideoProvidersScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const { showToast } = useToast();

  const [providers, setProviders] = useState<VideoProvider[]>([]);
  const [doctors, setDoctors] = useState<DoctorRow[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingGlobal, setSavingGlobal] = useState<string | null>(null);
  const [savingTeacher, setSavingTeacher] = useState<string | null>(null); // "doctorId:providerKey"

  const load = useCallback(async () => {
    try {
      const [provs, docs] = await Promise.all([
        getVideoProviders(),
        getDoctorsForProviderMgmt(),
      ]);
      setProviders(provs);
      setDoctors(docs.map(d => ({ ...d, permissions: [], expanded: false, loading: false })));
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message ?? 'Failed to load providers' });
    }
    setLoading(false);
  }, [showToast]);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // Toggle global provider
  const handleGlobalToggle = async (providerKey: string, current: boolean) => {
    setSavingGlobal(providerKey);
    // optimistic update
    setProviders(prev => prev.map(p =>
      p.provider_key === providerKey ? { ...p, is_globally_enabled: !current } : p,
    ));
    try {
      await setGlobalProviderEnabled(providerKey, !current);
      showToast({ type: 'success', message: `${providerKey} ${!current ? 'enabled' : 'disabled'} globally` });
    } catch (e: any) {
      // revert
      setProviders(prev => prev.map(p =>
        p.provider_key === providerKey ? { ...p, is_globally_enabled: current } : p,
      ));
      showToast({ type: 'error', message: e?.message ?? 'Failed to update provider' });
    }
    setSavingGlobal(null);
  };

  // Expand/collapse doctor row and lazy-load permissions
  const handleToggleDoctor = async (docId: string) => {
    const doc = doctors.find(d => d.id === docId);
    if (!doc) return;
    if (doc.permissions.length > 0) {
      setDoctors(prev => prev.map(d => d.id === docId ? { ...d, expanded: !d.expanded } : d));
      return;
    }
    // Load permissions
    setDoctors(prev => prev.map(d => d.id === docId ? { ...d, loading: true, expanded: true } : d));
    try {
      const perms = await getTeacherProviderPermissionsById(docId);
      setDoctors(prev => prev.map(d => d.id === docId ? { ...d, permissions: perms, loading: false } : d));
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message ?? 'Failed to load permissions' });
      setDoctors(prev => prev.map(d => d.id === docId ? { ...d, loading: false, expanded: false } : d));
    }
  };

  // Toggle teacher provider permission
  const handleTeacherToggle = async (
    docId: string,
    providerKey: string,
    currentTeacherEnabled: boolean,
  ) => {
    const key = `${docId}:${providerKey}`;
    setSavingTeacher(key);
    // optimistic update
    setDoctors(prev => prev.map(d => {
      if (d.id !== docId) return d;
      return {
        ...d,
        permissions: d.permissions.map(p => {
          if (p.provider_key !== providerKey) return p;
          const newTeacher = !currentTeacherEnabled;
          const globalOn = providers.find(g => g.provider_key === providerKey)?.is_globally_enabled ?? true;
          return { ...p, teacher_enabled: newTeacher, final_enabled: globalOn && newTeacher };
        }),
      };
    }));
    try {
      await setTeacherProviderPermission(docId, providerKey, !currentTeacherEnabled);
    } catch (e: any) {
      // revert
      setDoctors(prev => prev.map(d => {
        if (d.id !== docId) return d;
        return {
          ...d,
          permissions: d.permissions.map(p => {
            if (p.provider_key !== providerKey) return p;
            const globalOn = providers.find(g => g.provider_key === providerKey)?.is_globally_enabled ?? true;
            return { ...p, teacher_enabled: currentTeacherEnabled, final_enabled: globalOn && currentTeacherEnabled };
          }),
        };
      }));
      showToast({ type: 'error', message: e?.message ?? 'Failed to update permission' });
    }
    setSavingTeacher(null);
  };

  const allDisabled = providers.length > 0 && providers.every(p => !p.is_globally_enabled);

  const filteredDoctors = doctors.filter(d =>
    d.full_name.toLowerCase().includes(search.toLowerCase()) ||
    d.email.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
    >
      <View style={{ padding: layout.screenPx, gap: 20 }}>
        <PageHeader title="Video Providers" subtitle="Control upload providers globally and per teacher" />

        {/* Warning banner when all providers off */}
        {allDisabled && (
          <NeuCard style={{ padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#FEF3C7' }}>
            <AlertTriangle size={18} color="#D97706" />
            <Text style={{ flex: 1, fontSize: 13, color: '#92400E', fontWeight: '600' }}>
              Video uploads are currently disabled for all teachers.
            </Text>
          </NeuCard>
        )}

        {/* ── Global Providers ─────────────────────────────────────── */}
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Globe size={16} color={c.primary} />
            <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, opacity: 0.6, letterSpacing: 1, textTransform: 'uppercase' }}>
              Global Providers
            </Text>
          </View>

          {loading ? (
            <ActivityIndicator color={c.primary} />
          ) : (
            providers.map(provider => {
              const color = PROVIDER_COLORS[provider.provider_key] ?? c.primary;
              const IconComp = PROVIDER_ICONS[provider.provider_key] ?? Video;
              const isSaving = savingGlobal === provider.provider_key;
              return (
                <NeuCard key={provider.id} style={{ padding: 16 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <View style={{
                      width: 44, height: 44, borderRadius: 14,
                      backgroundColor: `${color}18`,
                      alignItems: 'center', justifyContent: 'center',
                    }}>
                      <IconComp size={20} color={color} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 16, fontWeight: '700', color: c.text }}>
                        {provider.display_name}
                      </Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
                        <View style={{
                          width: 7, height: 7, borderRadius: 4,
                          backgroundColor: provider.is_globally_enabled ? '#16A34A' : '#9CA3AF',
                        }} />
                        <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>
                          {provider.is_globally_enabled ? 'Globally enabled' : 'Globally disabled'}
                        </Text>
                      </View>
                    </View>
                    {isSaving
                      ? <ActivityIndicator size="small" color={c.primary} />
                      : (
                        <Switch
                          value={provider.is_globally_enabled}
                          onValueChange={() => handleGlobalToggle(provider.provider_key, provider.is_globally_enabled)}
                          trackColor={{ false: `${c.shadowDark}80`, true: `${c.primary}60` }}
                          thumbColor={provider.is_globally_enabled ? c.primary : c.text}
                        />
                      )}
                  </View>
                </NeuCard>
              );
            })
          )}
        </View>

        {/* ── Per-Teacher Overrides ─────────────────────────────────── */}
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Users size={16} color={c.primary} />
            <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, opacity: 0.6, letterSpacing: 1, textTransform: 'uppercase' }}>
              Teachers ({doctors.length})
            </Text>
          </View>

          {/* Search */}
          <NeuCard style={{ padding: 0, overflow: 'hidden' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, gap: 10, minWidth: 0 }}>
              <Search size={16} color={`${c.text}60`} style={{ flexShrink: 0 }} />
              <TextInput
                style={{ flex: 1, minWidth: 0, fontSize: 14, color: c.text }}
                placeholder="Search teachers…"
                placeholderTextColor={`${c.text}50`}
                value={search}
                onChangeText={setSearch}
              />
            </View>
          </NeuCard>

          {loading ? (
            <ActivityIndicator color={c.primary} style={{ marginTop: 20 }} />
          ) : filteredDoctors.length === 0 ? (
            <NeuCard style={{ padding: 24, alignItems: 'center' }}>
              <Text style={{ color: c.text, opacity: 0.5, fontSize: 14 }}>No teachers found.</Text>
            </NeuCard>
          ) : (
            filteredDoctors.map(doc => (
              <NeuCard key={doc.id} style={{ padding: 0, overflow: 'hidden' }}>
                {/* Header row */}
                <Pressable
                  onPress={() => handleToggleDoctor(doc.id)}
                  style={{ flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12 }}
                >
                  <View style={{
                    width: 40, height: 40, borderRadius: 12,
                    backgroundColor: `${c.primary}18`,
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Text style={{ fontSize: 16, fontWeight: '700', color: c.primary }}>
                      {doc.full_name.charAt(0).toUpperCase()}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>{doc.full_name}</Text>
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }} numberOfLines={1}>{doc.email}</Text>
                  </View>
                  {doc.loading
                    ? <ActivityIndicator size="small" color={c.primary} />
                    : doc.expanded
                      ? <ChevronUp size={18} color={`${c.text}60`} />
                      : <ChevronDown size={18} color={`${c.text}60`} />
                  }
                </Pressable>

                {/* Provider toggles */}
                {doc.expanded && doc.permissions.length > 0 && (
                  <View style={{ borderTopWidth: 1, borderTopColor: `${c.shadowDark}30`, paddingHorizontal: 16, paddingBottom: 12 }}>
                    {doc.permissions.map(perm => {
                      const color = PROVIDER_COLORS[perm.provider_key] ?? c.primary;
                      const IconComp = PROVIDER_ICONS[perm.provider_key] ?? Video;
                      const globalOff = !perm.global_enabled;
                      const saveKey = `${doc.id}:${perm.provider_key}`;
                      const isSaving = savingTeacher === saveKey;
                      return (
                        <View key={perm.provider_key} style={{
                          flexDirection: 'row', alignItems: 'center',
                          paddingVertical: 12, gap: 12,
                        }}>
                          <View style={{
                            width: 34, height: 34, borderRadius: 10,
                            backgroundColor: `${color}15`,
                            alignItems: 'center', justifyContent: 'center',
                          }}>
                            <IconComp size={16} color={color} />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }}>
                              {perm.display_name}
                            </Text>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 }}>
                              {/* Final permission pill */}
                              <View style={{
                                paddingHorizontal: 7, paddingVertical: 2, borderRadius: 20,
                                backgroundColor: perm.final_enabled ? '#16A34A18' : '#DC262618',
                              }}>
                                <Text style={{ fontSize: 10, fontWeight: '700', color: perm.final_enabled ? '#16A34A' : '#DC2626' }}>
                                  {perm.final_enabled ? '✓ ACTIVE' : '✗ BLOCKED'}
                                </Text>
                              </View>
                              {globalOff && (
                                <Text style={{ fontSize: 10, color: '#D97706', fontWeight: '600' }}>
                                  Global off
                                </Text>
                              )}
                            </View>
                          </View>
                          {isSaving
                            ? <ActivityIndicator size="small" color={c.primary} />
                            : (
                              <Switch
                                value={perm.teacher_enabled}
                                disabled={globalOff}
                                onValueChange={() => handleTeacherToggle(doc.id, perm.provider_key, perm.teacher_enabled)}
                                trackColor={{ false: `${c.shadowDark}80`, true: `${c.primary}60` }}
                                thumbColor={perm.teacher_enabled ? c.primary : c.text}
                              />
                            )}
                        </View>
                      );
                    })}
                  </View>
                )}
              </NeuCard>
            ))
          )}
        </View>

        <View style={{ height: 40 }} />
      </View>
    </ScrollView>
  );
}
