/**
 * VideoProvidersScreen — Super Admin Video Provider Control Center.
 *
 * Structure (per the control-center spec):
 *   VIDEO PROVIDERS — Global availability
 *     Plyr        [ON/OFF]     ← the YouTube/Plyr path
 *     VdoCipher   [ON/OFF]     ← the VdoCipher DRM path
 *   DOCTOR OVERRIDES
 *     search + expandable doctor cards, each provider row showing
 *     Global: ON/OFF and a three-state picker: Inherit / Enabled / Disabled
 *
 * Effective rule (single source: src/lib/videoProviderPolicy.ts):
 *   override enabled → allowed; override disabled → blocked; inherit → global.
 * The backend re-enforces the SAME rule on every VdoCipher authorization and
 * lesson video_type write — this UI is a mirror, never the enforcement.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, Switch, ActivityIndicator,
  RefreshControl, useColorScheme, TextInput, Pressable,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Video, Users, Globe, Lock, AlertTriangle, Search, ChevronDown, ChevronUp } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout, safeBottom } from '@/lib/neu';
import {
  getVideoProviders, setGlobalProviderEnabled,
  getTeacherProviderPermissionsById, setTeacherProviderOverride,
  type VideoProvider, type TeacherProviderPermission,
} from '@/lib/api';

interface DoctorRow {
  id: string;
  full_name: string;
  email: string;
  permissions: TeacherProviderPermission[] | null; // null = not loaded yet
  expanded: boolean;
  loading: boolean;
}

type OverrideMode = 'inherit' | 'enabled' | 'disabled';

const PROVIDER_COLORS: Record<string, string> = {
  plyr: '#1E90FF',
  vdocipher: '#7C3AED',
};
const PROVIDER_ICONS: Record<string, any> = {
  plyr: Video,
  vdocipher: Lock,
};
const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  plyr: 'YouTube / Plyr video playback',
  vdocipher: 'Secure video playback',
};
const OVERRIDE_LABELS: Record<OverrideMode, string> = {
  inherit: 'Inherit',
  enabled: 'Enabled',
  disabled: 'Disabled',
};
const OVERRIDE_OPTIONS: OverrideMode[] = ['inherit', 'enabled', 'disabled'];

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [savingGlobal, setSavingGlobal] = useState<string | null>(null);
  const [savingTeacher, setSavingTeacher] = useState<string | null>(null); // "doctorId:providerKey"

  const load = useCallback(async (opts?: { keepState?: boolean }) => {
    if (!opts?.keepState) setLoadError(null);
    try {
      const { providers: provs, doctors: docs } = await getVideoProviders();
      setProviders(provs);
      setDoctors(prev => {
        // Preserve already-expanded cards' loaded permissions across refresh.
        const known = new Map(prev.map(d => [d.id, d]));
        return docs.map(d => {
          const old = known.get(d.id);
          return old
            ? { ...old, full_name: d.full_name, email: d.email }
            : { ...d, permissions: null, expanded: false, loading: false };
        });
      });
    } catch (e: any) {
      setLoadError(e?.message ?? 'Failed to load providers');
    }
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load({ keepState: true }); setRefreshing(false); };

  // Toggle global provider (optimistic + revert on failure)
  const handleGlobalToggle = async (providerKey: string, current: boolean) => {
    setSavingGlobal(providerKey);
    setProviders(prev => prev.map(p =>
      p.provider_key === providerKey ? { ...p, is_globally_enabled: !current } : p,
    ));
    try {
      await setGlobalProviderEnabled(providerKey, !current);
      showToast({ type: 'success', message: `${PROVIDER_LABEL(providerKey)} ${!current ? 'enabled' : 'disabled'} globally` });
      // Refresh expanded doctor cards so their Global: labels stay truthful.
      void load({ keepState: true });
    } catch (e: any) {
      setProviders(prev => prev.map(p =>
        p.provider_key === providerKey ? { ...p, is_globally_enabled: current } : p,
      ));
      showToast({ type: 'error', message: e?.message ?? 'Failed to update provider' });
    }
    setSavingGlobal(null);
  };

  // Expand/collapse a doctor row and lazy-load its effective permissions
  const handleToggleDoctor = async (docId: string) => {
    const doc = doctors.find(d => d.id === docId);
    if (!doc) return;
    if (doc.permissions) {
      setDoctors(prev => prev.map(d => d.id === docId ? { ...d, expanded: !d.expanded } : d));
      return;
    }
    setDoctors(prev => prev.map(d => d.id === docId ? { ...d, loading: true, expanded: true } : d));
    try {
      const perms = await getTeacherProviderPermissionsById(docId);
      setDoctors(prev => prev.map(d => d.id === docId ? { ...d, permissions: perms, loading: false } : d));
    } catch (e: any) {
      showToast({ type: 'error', message: e?.message ?? 'Failed to load permissions' });
      setDoctors(prev => prev.map(d => d.id === docId ? { ...d, loading: false, expanded: false } : d));
    }
  };

  // Three-state override write (optimistic + revert on failure)
  const handleOverride = async (docId: string, providerKey: string, mode: OverrideMode) => {
    const key = `${docId}:${providerKey}`;
    const before = doctors.find(d => d.id === docId)?.permissions ?? null;
    if (!before) return;
    const prevMode = before.find(p => p.provider_key === providerKey)?.override ?? 'inherit';
    if (prevMode === mode) return;

    const apply = (perms: TeacherProviderPermission[], m: OverrideMode) =>
      perms.map(p => {
        if (p.provider_key !== providerKey) return p;
        const teacherOn = m === 'enabled' ? true : m === 'disabled' ? false : p.global_enabled;
        return { ...p, override: m, teacher_enabled: teacherOn, final_enabled: teacherOn };
      });
    setSavingTeacher(key);
    setDoctors(prev => prev.map(d => d.id === docId ? { ...d, permissions: apply(d.permissions ?? [], mode) } : d));
    try {
      await setTeacherProviderOverride(docId, providerKey, mode);
      showToast({ type: 'success', message: `${PROVIDER_LABEL(providerKey)}: ${OVERRIDE_LABELS[mode]}` });
    } catch (e: any) {
      setDoctors(prev => prev.map(d => d.id === docId ? { ...d, permissions: apply(d.permissions ?? [], prevMode) } : d));
      showToast({ type: 'error', message: e?.message ?? 'Failed to update override' });
    }
    setSavingTeacher(null);
  };

  const filteredDoctors = doctors.filter(d =>
    d.full_name.toLowerCase().includes(search.toLowerCase()) ||
    d.email.toLowerCase().includes(search.toLowerCase()),
  );

  const renderProviderRow = (provider: VideoProvider) => {
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
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 2 }}>
              {PROVIDER_DESCRIPTIONS[provider.provider_key] ?? 'Video provider'}
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
  };

  const renderDoctorCard = (doc: DoctorRow) => (
    <NeuCard key={doc.id} style={{ padding: 0, overflow: 'hidden' }}>
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

      {doc.expanded && doc.permissions && (
        <View style={{ borderTopWidth: 1, borderTopColor: `${c.shadowDark}30`, paddingHorizontal: 16, paddingBottom: 12 }}>
          {doc.permissions.map(perm => {
            const color = PROVIDER_COLORS[perm.provider_key] ?? c.primary;
            const IconComp = PROVIDER_ICONS[perm.provider_key] ?? Video;
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
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 }}>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>
                      Global: <Text style={{ fontWeight: '700', color: perm.global_enabled ? '#16A34A' : '#D97706' }}>
                        {perm.global_enabled ? 'ON' : 'OFF'}
                      </Text>
                    </Text>
                    {/* Effective verdict pill — the outcome of the rule */}
                    <View style={{
                      paddingHorizontal: 7, paddingVertical: 2, borderRadius: 20,
                      backgroundColor: perm.final_enabled ? '#16A34A18' : '#DC262618',
                    }}>
                      <Text style={{ fontSize: 10, fontWeight: '700', color: perm.final_enabled ? '#16A34A' : '#DC2626' }}>
                        {perm.final_enabled ? '✓ ACTIVE' : '✗ BLOCKED'}
                      </Text>
                    </View>
                  </View>
                </View>
                {/* Three-state picker: Inherit / Enabled / Disabled */}
                {isSaving
                  ? <ActivityIndicator size="small" color={c.primary} />
                  : (
                    <View style={{ flexDirection: 'row', backgroundColor: `${c.shadowDark}20`, borderRadius: 10, padding: 2, gap: 2 }}>
                      {OVERRIDE_OPTIONS.map(mode => {
                        const selected = perm.override === mode;
                        return (
                          <Pressable
                            key={mode}
                            onPress={() => handleOverride(doc.id, perm.provider_key, mode)}
                            style={{
                              paddingHorizontal: 9, paddingVertical: 6, borderRadius: 8,
                              backgroundColor: selected ? c.primary : 'transparent',
                            }}
                          >
                            <Text style={{
                              fontSize: 11, fontWeight: '700',
                              color: selected ? '#FFFFFF' : `${c.text}99`,
                            }}>
                              {OVERRIDE_LABELS[mode]}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  )}
              </View>
            );
          })}
        </View>
      )}
    </NeuCard>
  );

  const allDisabled = providers.length > 0 && providers.every(p => !p.is_globally_enabled);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />} contentContainerStyle={{ paddingBottom: safeBottom(layout.insets.bottom) }}
    >
      <PageHeader
        title="Video Providers"
        subtitle="Player availability globally and per doctor"
        showBack
        backFallback="/sa-platform"
      />

      <View style={{ paddingHorizontal: layout.screenPx, gap: 20 }}>

        {/* Warning banner when all providers off */}
        {allDisabled && (
          <NeuCard style={{ padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#FEF3C7' }}>
            <AlertTriangle size={18} color="#D97706" />
            <Text style={{ flex: 1, fontSize: 13, color: '#92400E', fontWeight: '600' }}>
              All video players are currently disabled for doctors.
            </Text>
          </NeuCard>
        )}

        {/* ── Global availability ───────────────────────────────── */}
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Globe size={16} color={c.primary} />
            <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, opacity: 0.6, letterSpacing: 1, textTransform: 'uppercase' }}>
              Video Providers
            </Text>
          </View>
          <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginTop: -2 }}>
            Default availability for every doctor. Individual doctors can be
            overridden below without changing this default.
          </Text>

          {loading ? (
            <ActivityIndicator color={c.primary} style={{ marginTop: 12 }} />
          ) : loadError ? (
            <NeuCard style={{ padding: 20, alignItems: 'center', gap: 10 }}>
              <AlertTriangle size={20} color="#D97706" />
              <Text style={{ fontSize: 13, color: c.text, opacity: 0.6, textAlign: 'center' }}>{loadError}</Text>
              <Pressable
                onPress={() => { setLoading(true); load(); }}
                style={{ paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10, backgroundColor: `${c.primary}18` }}
              >
                <Text style={{ fontSize: 13, fontWeight: '700', color: c.primary }}>Retry</Text>
              </Pressable>
            </NeuCard>
          ) : (
            providers.map(renderProviderRow)
          )}
        </View>

        {/* ── Doctor overrides ───────────────────────────────────── */}
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Users size={16} color={c.primary} />
            <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, opacity: 0.6, letterSpacing: 1, textTransform: 'uppercase' }}>
              Doctor Overrides ({doctors.length})
            </Text>
          </View>
          <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginTop: -2 }}>
            Inherit follows the global default. Enabled/Disabled applies to that
            doctor regardless of the global setting.
          </Text>

          {/* Search */}
          <NeuCard style={{ padding: 0, overflow: 'hidden' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, gap: 10, minWidth: 0 }}>
              <Search size={16} color={`${c.text}60`} style={{ flexShrink: 0 }} />
              <TextInput
                style={{ flex: 1, minWidth: 0, fontSize: 14, color: c.text }}
                placeholder="Search doctors…"
                placeholderTextColor={`${c.text}50`}
                value={search}
                onChangeText={setSearch}
              />
            </View>
          </NeuCard>

          {loading ? (
            <ActivityIndicator color={c.primary} style={{ marginTop: 20 }} />
          ) : loadError ? null : filteredDoctors.length === 0 ? (
            <NeuCard style={{ padding: 24, alignItems: 'center' }}>
              <Text style={{ color: c.text, opacity: 0.5, fontSize: 14 }}>No doctors found.</Text>
            </NeuCard>
          ) : (
            filteredDoctors.map(renderDoctorCard)
          )}
        </View>

        <View style={{ height: 40 }} />
      </View>
    </ScrollView>
  );
}

function PROVIDER_LABEL(key: string): string {
  return key === 'plyr' ? 'Plyr' : key === 'vdocipher' ? 'VdoCipher' : key;
}
