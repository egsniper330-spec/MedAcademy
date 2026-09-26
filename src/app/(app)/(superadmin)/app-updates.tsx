import { useCallback, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, useColorScheme, RefreshControl,
  ActivityIndicator, TextInput, Pressable, Alert, Linking, Switch,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  CheckCircle2, CloudUpload, History, Package, Rocket, Undo2, Archive,
} from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import {
  getAppReleasesOverview, createAppRelease, updateAppRelease,
  publishAppRelease, rollbackAppRelease, archiveAppRelease,
  getAppUpdateConfig, setAppUpdateConfig,
  type AppRelease, type AppReleasesOverview,
} from '@/lib/api';
import { displayVersion, normalizeSemanticVersion } from '@/lib/semver';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { neuColors, useLayout, safeBottom } from '@/lib/neu';
/**
 * Super Admin → App Updates — production version management (mig028).
 *
 * TWO CONCEPTS, STRICTLY SEPARATED:
 *   CURRENT PRODUCTION  — the published release per platform. Changes ONLY
 *                         through an explicit Publish/Rollback action.
 *   PENDING RELEASES    — drafts being prepared. Saving/editing them never
 *                         touches production. No auto-increment anywhere:
 *                         versions move only when the Super Admin says so.
 *
 * Enforcement integration: publishing promotes the release into the existing
 * update-gate config (app_update_config), so ForceUpdateGate uses the
 * published production record — never a draft.
 */

type Platform = 'android' | 'ios';
const PLATFORMS: Platform[] = ['android', 'ios'];

interface FormState {
  platform: Platform;
  version: string;
  androidBuild: string;
  iosBuild: string;
  androidUrl: string;
  iosUrl: string;
  releaseNotes: string;
}

const EMPTY_FORM: FormState = {
  platform: 'android',
  version: '',
  androidBuild: '',
  iosBuild: '',
  androidUrl: '',
  iosUrl: '',
  releaseNotes: '',
};

interface PolicyState {
  loaded: boolean;
  enabled: boolean;
  updateMode: 'FORCED' | 'OPTIONAL';
  minimumVersionCode: string;
  latestVersionName: string;
  latestVersionCode: string;
  updateUrl: string;
  saving: boolean;
}

const EMPTY_POLICY: PolicyState = {
  loaded: false,
  enabled: false,
  updateMode: 'FORCED',
  minimumVersionCode: '',
  latestVersionName: '',
  latestVersionCode: '',
  updateUrl: '',
  saving: false,
};

export default function SuperAdminAppUpdates() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  const [data, setData] = useState<AppReleasesOverview | null>(null);
  const [policy, setPolicy] = useState<Record<Platform, PolicyState>>({
    android: { ...EMPTY_POLICY },
    ios: { ...EMPTY_POLICY },
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formPlatform, setFormPlatform] = useState<Platform>('android');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]): void =>
    setForm((p) => ({ ...p, [k]: v }));

  const load = useCallback(async (): Promise<AppReleasesOverview> => {
    const overview = await getAppReleasesOverview();
    setData(overview);
    // Enforcement policy (existing app_update_config per platform) — the
    // floor/mode knobs live OUTSIDE the release lifecycle.
    for (const p of PLATFORMS) {
      try {
        const cfg = await getAppUpdateConfig(p);
        setPolicy((prev) => ({
          ...prev,
          [p]: {
            loaded: true,
            enabled: cfg.enabled,
            updateMode: cfg.update_mode === 'OPTIONAL' ? 'OPTIONAL' : 'FORCED',
            minimumVersionCode: cfg.minimum_version_code != null ? String(cfg.minimum_version_code) : '',
            latestVersionName: cfg.latest_version_name ?? '',
            latestVersionCode: cfg.latest_version_code != null ? String(cfg.latest_version_code) : '',
            updateUrl: cfg.update_url ?? '',
            saving: false,
          },
        }));
      } catch {
        setPolicy((prev) => ({ ...prev, [p]: { ...prev[p], loaded: true } }));
      }
    }
    return overview;
  }, []);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      load().catch((e) => {
        if (alive) Alert.alert('Load failed', e instanceof Error ? e.message : 'Failed to load releases');
      }).finally(() => { if (alive) setLoading(false); });
      return () => { alive = false; };
    }, [load])
  );

  const onRefresh = async (): Promise<void> => {
    setRefreshing(true);
    try { await load(); } catch { /* surfaced on focus-load */ }
    setRefreshing(false);
  };

  // ── Derived: pending (draft/ready) releases across platforms ────────────
  const pending = useMemo<Array<AppRelease & { _plat: Platform }>>(() => {
    if (!data) return [];
    const rows: Array<AppRelease & { _plat: Platform }> = [];
    for (const p of PLATFORMS) {
      for (const r of data.platforms[p].history) {
        if (r.status === 'draft' || r.status === 'ready') rows.push({ ...r, _plat: p });
      }
    }
    return rows;
  }, [data]);

  // Form validation — version must be semantic; publish needs a URL.
  const formError = useMemo<string | null>(() => {
    const v = normalizeSemanticVersion(form.version);
    if (!v) return form.version.trim() ? 'Version must be semantic (e.g. 1.1.0).' : null;
    if (formPlatform === 'android' && form.androidBuild.trim() && !/^\d+$/.test(form.androidBuild.trim())) {
      return 'Android build (versionCode) must be a positive integer.';
    }
    if (formPlatform === 'ios' && form.iosBuild.trim() && !/^\d+$/.test(form.iosBuild.trim())) {
      return 'iOS build (buildNumber) must be a positive integer.';
    }
    const url = formPlatform === 'android' ? form.androidUrl.trim() : form.iosUrl.trim();
    if (url && !/^https?:\/\//i.test(url)) return 'Download URL must be an absolute http(s) URL.';
    return null;
  }, [form, formPlatform]);

  const showFlash = (msg: string): void => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 3000);
  };

  // ── Actions ─────────────────────────────────────────────────────────────
  const onSaveDraft = async (): Promise<void> => {
    const version = normalizeSemanticVersion(form.version);
    if (!version) { Alert.alert('Invalid version', 'Enter a semantic version like 1.1.0.'); return; }
    setSaving(true);
    try {
      await createAppRelease({
        platform: formPlatform,
        version,
        android_version_code: formPlatform === 'android' && form.androidBuild.trim() ? Number(form.androidBuild.trim()) : null,
        ios_build_number: formPlatform === 'ios' && form.iosBuild.trim() ? Number(form.iosBuild.trim()) : null,
        download_url: (formPlatform === 'android' ? form.androidUrl : form.iosUrl).trim() || undefined,
        release_notes: form.releaseNotes.trim() || undefined,
        status: 'ready',
      });
      setForm(EMPTY_FORM);
      showFlash(`Release v${version} saved — Current Production is unchanged until you publish it.`);
      await load();
    } catch (e) {
      Alert.alert('Save failed', e instanceof Error ? e.message : 'Unknown error');
    }
    setSaving(false);
  };

  const onPublish = (r: AppRelease & { _plat: Platform }): void => {
    if (!r.download_url) {
      Alert.alert('Download URL required', `Set a download URL for v${r.version} before publishing.`);
      return;
    }
    Alert.alert(
      'Publish to production?',
      `Current Production becomes ${displayVersion(r.version)} (${r._plat}). This is the ONLY action that changes production.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Publish',
          style: 'default',
          onPress: async () => {
            setBusyId(r.id);
            try {
              await publishAppRelease(r.id);
              showFlash(`v${r.version} is now the Current Production release for ${r._plat}.`);
              await load();
            } catch (e) {
              Alert.alert('Publish failed', e instanceof Error ? e.message : 'Unknown error');
            }
            setBusyId(null);
          },
        },
      ]
    );
  };

  const onRollback = (r: AppRelease & { _plat: Platform }): void => {
    Alert.alert(
      'Roll back production?',
      `Current Production for ${r._plat} becomes ${displayVersion(r.version)} again. History is preserved.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Roll Back',
          onPress: async () => {
            setBusyId(r.id);
            try {
              await rollbackAppRelease(r.id);
              showFlash(`Production rolled back to v${r.version} for ${r._plat}.`);
              await load();
            } catch (e) {
              Alert.alert('Rollback failed', e instanceof Error ? e.message : 'Unknown error');
            }
            setBusyId(null);
          },
        },
      ]
    );
  };

  const onArchive = (r: AppRelease): void => {
    Alert.alert('Archive release?', `v${r.version} (${r.platform}) will be archived. History is preserved.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Archive',
        onPress: async () => {
          setBusyId(r.id);
          try {
            await archiveAppRelease(r.id);
            await load();
          } catch (e) {
            Alert.alert('Archive failed', e instanceof Error ? e.message : 'Unknown error');
          }
          setBusyId(null);
        },
      },
    ]);
  };

  // ── Enforcement policy (existing gate config) — save per platform ──────
  const savePolicy = async (p: Platform): Promise<void> => {
    const pol = policy[p];
    const min = Number(pol.minimumVersionCode);
    const latest = Number(pol.latestVersionCode);
    if (!Number.isInteger(min) || min < 0) { Alert.alert('Invalid policy', 'Minimum supported version code must be a non-negative integer.'); return; }
    if (!Number.isInteger(latest) || latest <= 0) { Alert.alert('Invalid policy', 'Latest version code must be a positive integer.'); return; }
    if (min > latest) { Alert.alert('Invalid policy', 'Minimum supported code cannot exceed the latest code.'); return; }
    if (pol.enabled && pol.updateUrl && !/^https:\/\//i.test(pol.updateUrl.trim())) { Alert.alert('Invalid policy', 'Update URL must be a valid https:// URL.'); return; }
    setPolicy((prev) => ({ ...prev, [p]: { ...prev[p], saving: true } }));
    const r = await setAppUpdateConfig(p, {
      enabled: pol.enabled,
      latestVersionName: pol.latestVersionName.trim() || `1.0.0`,
      latestVersionCode: latest,
      minimumVersionCode: min,
      updateMode: pol.updateMode,
      updateUrl: pol.updateUrl.trim() || 'https://medacademy.site/app/download',
      releaseNotes: '',
    });
    setPolicy((prev) => ({ ...prev, [p]: { ...prev[p], saving: false } }));
    if (!r.ok) {
      Alert.alert('Save failed', r.error ?? 'Unknown error');
      return;
    }
    showFlash(`${p} enforcement policy saved (mode ${pol.updateMode}, floor ${min}).`);
  };

  const onEditPending = (r: AppRelease & { _plat: Platform }): void => {
    // Load a pending release into the form for editing (drafts are mutable;
    // published rows are immutable server-side).
    setFormPlatform(r._plat);
    setForm({
      platform: r._plat,
      version: r.version,
      androidBuild: r.android_version_code != null ? String(r.android_version_code) : '',
      iosBuild: r.ios_build_number != null ? String(r.ios_build_number) : '',
      androidUrl: r._plat === 'android' ? (r.download_url ?? '') : '',
      iosUrl: r._plat === 'ios' ? (r.download_url ?? '') : '',
      releaseNotes: r.release_notes ?? '',
    });
  };

  const inputStyle = useMemo(() => ({
    backgroundColor: c.base,
    color: c.text,
    borderColor: `${c.text}22`,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  }), [c]);

  const statusColor = (s: AppRelease['status']): string =>
    s === 'published' ? '#16A34A' : s === 'ready' ? '#D97706' : s === 'draft' ? '#3B82F6' : '#9CA3AF';

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: c.base, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color={c.primary} />
      </View>
    );
  }

  const renderProductionCard = (p: Platform): AppRelease | null => data?.platforms[p].current ?? null;

  const renderReleaseMeta = (r: AppRelease): string => {
    const build = r.platform === 'android'
      ? (r.android_version_code != null ? `Build ${r.android_version_code}` : null)
      : (r.ios_build_number != null ? `Build ${r.ios_build_number}` : null);
    return [build, r.published_at ? `Published ${new Date(r.published_at).toLocaleDateString()}` : null]
      .filter(Boolean).join(' · ');
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <PageHeader title="App Updates" subtitle="Production version management" />
      <ScrollView
        contentContainerStyle={{ padding: layout.pad.md, paddingBottom: safeBottom(layout.insets.bottom) + 48 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.text} />}
        keyboardShouldPersistTaps="handled"
      >
        {/* ════════════════ CURRENT PRODUCTION ════════════════ */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <CheckCircle2 size={16} color="#16A34A" />
          <Text style={{ fontSize: 13, fontWeight: '800', color: c.text, textTransform: 'uppercase', letterSpacing: 0.8 }}>
            Current Production
          </Text>
        </View>
        {PLATFORMS.map((p) => {
          const cur = renderProductionCard(p);
          const prev = data?.platforms[p].history.find((h) => h.status === 'archived');
          return (
            <NeuCard key={p} style={{ marginBottom: 10, padding: 14 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 15, fontWeight: '800', color: c.text, textTransform: 'capitalize' }}>{p}</Text>
                <View style={{ backgroundColor: '#16A34A18', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 7 }}>
                  <Text style={{ fontSize: 10, fontWeight: '800', color: '#16A34A' }}>
                    {cur ? 'PUBLISHED' : 'NOT SET'}
                  </Text>
                </View>
              </View>
              {cur ? (
                <>
                  <Text style={{ fontSize: 26, fontWeight: '800', color: c.primary, marginTop: 6 }}>
                    {displayVersion(cur.version)}
                  </Text>
                  <Text style={{ fontSize: 12, color: `${c.text}99`, marginTop: 2 }}>
                    {renderReleaseMeta(cur)}
                  </Text>
                  {!!cur.download_url && (
                    <Pressable onPress={() => Linking.openURL(cur.download_url as string)} accessibilityLabel={`Open current ${p} download URL`}>
                      <Text style={{ fontSize: 11, color: c.primary, marginTop: 6 }} numberOfLines={1}>
                        {cur.download_url}
                      </Text>
                    </Pressable>
                  )}
                  {cur.release_notes ? (
                    <Text style={{ fontSize: 11, color: `${c.text}88`, marginTop: 6 }} numberOfLines={2}>
                      {cur.release_notes}
                    </Text>
                  ) : null}
                  {prev && prev.version !== cur.version ? (
                    <Text style={{ fontSize: 11, color: `${c.text}66`, marginTop: 4 }}>
                      Previous: {displayVersion(prev.version)}
                    </Text>
                  ) : null}
                </>
              ) : (
                <Text style={{ fontSize: 13, color: `${c.text}88`, marginTop: 6 }}>
                  No production release yet. Publish a pending release to set it.
                </Text>
              )}
            </NeuCard>
          );
        })}

        {/* ════════════════ ENFORCEMENT POLICY (existing gate) ════════════════ */}
        {PLATFORMS.map((p) => {
          const pol = policy[p];
          if (!pol.loaded) return null;
          return (
            <NeuCard key={`policy-${p}`} style={{ marginBottom: 10, padding: 14, gap: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={{ color: c.text, fontWeight: '700', fontSize: 14, textTransform: 'capitalize' }}>
                    {p} — Force-update enforcement
                  </Text>
                  <Text style={{ color: `${c.text}99`, fontSize: 11, marginTop: 2 }}>
                    Blocks app versions below the minimum code (server-side, bypass-proof).
                  </Text>
                </View>
                <Switch
                  value={pol.enabled}
                  onValueChange={(v) => setPolicy((prev) => ({ ...prev, [p]: { ...prev[p], enabled: v } }))}
                  trackColor={{ true: c.primary, false: `${c.text}33` }}
                  thumbColor="#fff"
                />
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: `${c.text}99`, fontSize: 11, fontWeight: '700', marginBottom: 4 }}>MIN SUPPORTED CODE</Text>
                  <TextInput
                    style={[inputStyle, { paddingVertical: 8, fontSize: 14 }]}
                    value={pol.minimumVersionCode}
                    onChangeText={(t) => setPolicy((prev) => ({ ...prev, [p]: { ...prev[p], minimumVersionCode: t.replace(/[^0-9]/g, '') } }))}
                    placeholder="221"
                    placeholderTextColor={`${c.text}55`}
                    keyboardType="number-pad"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: `${c.text}99`, fontSize: 11, fontWeight: '700', marginBottom: 4 }}>LATEST CODE</Text>
                  <TextInput
                    style={[inputStyle, { paddingVertical: 8, fontSize: 14 }]}
                    value={pol.latestVersionCode}
                    onChangeText={(t) => setPolicy((prev) => ({ ...prev, [p]: { ...prev[p], latestVersionCode: t.replace(/[^0-9]/g, '') } }))}
                    placeholder="221"
                    placeholderTextColor={`${c.text}55`}
                    keyboardType="number-pad"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: `${c.text}99`, fontSize: 11, fontWeight: '700', marginBottom: 4 }}>MODE</Text>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    {(['FORCED', 'OPTIONAL'] as const).map((m) => (
                      <Pressable
                        key={m}
                        onPress={() => setPolicy((prev) => ({ ...prev, [p]: { ...prev[p], updateMode: m } }))}
                        style={{
                          flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center',
                          borderWidth: 1.5,
                          borderColor: pol.updateMode === m ? c.primary : `${c.text}22`,
                          backgroundColor: pol.updateMode === m ? `${c.primary}18` : 'transparent',
                        }}
                      >
                        <Text style={{ color: pol.updateMode === m ? c.primary : c.text, fontWeight: '700', fontSize: 10 }}>{m}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              </View>
              <View>
                <Text style={{ color: `${c.text}99`, fontSize: 11, fontWeight: '700', marginBottom: 4 }}>UPDATE URL</Text>
                <TextInput
                  style={[inputStyle, { paddingVertical: 8, fontSize: 14 }]}
                  value={pol.updateUrl}
                  onChangeText={(t) => setPolicy((prev) => ({ ...prev, [p]: { ...prev[p], updateUrl: t } }))}
                  placeholder="https://…/app-release.apk"
                  placeholderTextColor={`${c.text}55`}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
              </View>
              <Pressable
                onPress={() => savePolicy(p)}
                disabled={pol.saving}
                accessibilityRole="button"
                accessibilityLabel={`Save ${p} enforcement policy`}
                style={{ paddingVertical: 9, borderRadius: 10, alignItems: 'center', borderWidth: 1.5, borderColor: `${c.primary}55` }}>
                {pol.saving
                  ? <ActivityIndicator size="small" color={c.primary} />
                  : <Text style={{ color: c.primary, fontWeight: '800', fontSize: 13 }}>Save {p} Policy</Text>}
              </Pressable>
            </NeuCard>
          );
        })}

        {/* ════════════════ PREPARE NEW RELEASE ════════════════ */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14, marginBottom: 10 }}>
          <Package size={16} color={c.primary} />
          <Text style={{ fontSize: 13, fontWeight: '800', color: c.text, textTransform: 'uppercase', letterSpacing: 0.8 }}>
            Prepare New Release
          </Text>
        </View>
        <NeuCard style={{ marginBottom: 12, padding: 14, gap: 12 }}>
          {/* Platform selector */}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {PLATFORMS.map((p) => (
              <Pressable
                key={p}
                onPress={() => setFormPlatform(p)}
                accessibilityLabel={`Prepare ${p} release`}
                style={{
                  flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center',
                  borderWidth: 1.5,
                  borderColor: formPlatform === p ? c.primary : `${c.text}22`,
                  backgroundColor: formPlatform === p ? `${c.primary}18` : 'transparent',
                }}
              >
                <Text style={{ color: formPlatform === p ? c.primary : c.text, fontWeight: '700', textTransform: 'capitalize' }}>
                  {p}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: `${c.text}99`, fontSize: 12, fontWeight: '700', marginBottom: 6 }}>VERSION</Text>
              <TextInput
                style={inputStyle}
                value={form.version}
                onChangeText={(t) => set('version', t)}
                placeholder="1.1.0"
                placeholderTextColor={`${c.text}55`}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: `${c.text}99`, fontSize: 12, fontWeight: '700', marginBottom: 6 }}>
                {formPlatform === 'android' ? 'ANDROID BUILD (VERSIONCODE)' : 'iOS BUILD (BUILDNUMBER)'}
              </Text>
              <TextInput
                style={inputStyle}
                value={formPlatform === 'android' ? form.androidBuild : form.iosBuild}
                onChangeText={(t) => set(formPlatform === 'android' ? 'androidBuild' : 'iosBuild', t.replace(/[^0-9]/g, ''))}
                placeholder={formPlatform === 'android' ? 'e.g. 222' : 'e.g. 213'}
                placeholderTextColor={`${c.text}55`}
                keyboardType="number-pad"
              />
            </View>
          </View>

          <View>
            <Text style={{ color: `${c.text}99`, fontSize: 12, fontWeight: '700', marginBottom: 6 }}>
              {formPlatform === 'android' ? 'ANDROID DOWNLOAD URL (APK)' : 'iOS DISTRIBUTION URL'}
            </Text>
            <TextInput
              style={inputStyle}
              value={formPlatform === 'android' ? form.androidUrl : form.iosUrl}
              onChangeText={(t) => set(formPlatform === 'android' ? 'androidUrl' : 'iosUrl', t)}
              placeholder={formPlatform === 'android' ? 'https://…/app-release.apk' : 'https://…/manifest.plist or store URL'}
              placeholderTextColor={`${c.text}55`}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </View>

          <View>
            <Text style={{ color: `${c.text}99`, fontSize: 12, fontWeight: '700', marginBottom: 6 }}>RELEASE NOTES (OPTIONAL)</Text>
            <TextInput
              style={[inputStyle, { minHeight: 64, textAlignVertical: 'top' }]}
              value={form.releaseNotes}
              onChangeText={(t) => set('releaseNotes', t)}
              placeholder="What's new in this release?"
              placeholderTextColor={`${c.text}55`}
              multiline
            />
          </View>

          {formError ? (
            <Text style={{ color: '#EF4444', fontSize: 12, fontWeight: '600' }}>⚠ {formError}</Text>
          ) : null}

          <NeuButton
            label={saving ? 'Saving…' : 'Save Draft'}
            onPress={onSaveDraft}
            disabled={saving || !normalizeSemanticVersion(form.version) || !!formError}
            loading={saving}
          />
          <Text style={{ color: `${c.text}66`, fontSize: 11, textAlign: 'center', lineHeight: 16 }}>
            Saving a draft NEVER changes Current Production.{'\n'}
            Production changes only when you publish below.
          </Text>
        </NeuCard>

        {/* ════════════════ PENDING RELEASES ════════════════ */}
        {pending.length > 0 && (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <Rocket size={16} color="#D97706" />
              <Text style={{ fontSize: 13, fontWeight: '800', color: c.text, textTransform: 'uppercase', letterSpacing: 0.8 }}>
                Pending Releases
              </Text>
            </View>
            {pending.map((r) => (
              <NeuCard key={r.id} style={{ marginBottom: 10, padding: 14 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 17, fontWeight: '800', color: c.text }}>
                    {displayVersion(r.version)}
                  </Text>
                  <View style={{ backgroundColor: `${statusColor(r.status)}18`, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 7 }}>
                    <Text style={{ fontSize: 10, fontWeight: '800', color: statusColor(r.status), textTransform: 'uppercase' }}>
                      {r.status}
                    </Text>
                  </View>
                </View>
                <Text style={{ fontSize: 12, color: `${c.text}99`, marginTop: 2, textTransform: 'capitalize' }}>
                  {r._plat}{r.platform === 'android' && r.android_version_code != null ? ` · Build ${r.android_version_code}` : ''}{r.platform === 'ios' && r.ios_build_number != null ? ` · Build ${r.ios_build_number}` : ''}
                </Text>
                {!!r.download_url && (
                  <Text style={{ fontSize: 11, color: `${c.text}77`, marginTop: 4 }} numberOfLines={1}>{r.download_url}</Text>
                )}
                {!r.download_url && (
                  <Text style={{ fontSize: 11, color: '#D97706', marginTop: 4 }}>
                    ⚠ A download URL is required before this release can be published.
                  </Text>
                )}
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                  <Pressable
                    onPress={() => onPublish(r)}
                    disabled={!r.download_url || busyId === r.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Publish version ${r.version} for ${r._plat}`}
                    style={{
                      flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center',
                      backgroundColor: r.download_url ? c.primary : `${c.text}14`,
                    }}
                  >
                    {busyId === r.id
                      ? <ActivityIndicator size="small" color="#fff" />
                      : <Text style={{ color: r.download_url ? '#fff' : `${c.text}55`, fontWeight: '800', fontSize: 13 }}>
                          Publish {displayVersion(r.version)}
                        </Text>}
                  </Pressable>
                  <Pressable
                    onPress={() => onEditPending(r)}
                    accessibilityLabel={`Edit draft version ${r.version}`}
                    style={{ paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1.5, borderColor: `${c.text}22`, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <CloudUpload size={15} color={`${c.text}88`} />
                  </Pressable>
                  <Pressable
                    onPress={() => onArchive(r)}
                    accessibilityLabel={`Archive draft version ${r.version}`}
                    style={{ paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1.5, borderColor: `${c.text}22`, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Archive size={15} color={`${c.text}88`} />
                  </Pressable>
                </View>
              </NeuCard>
            ))}
          </>
        )}

        {/* ════════════════ RELEASE HISTORY ════════════════ */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14, marginBottom: 10 }}>
          <History size={16} color={`${c.text}88`} />
          <Text style={{ fontSize: 13, fontWeight: '800', color: c.text, textTransform: 'uppercase', letterSpacing: 0.8 }}>
            Release History
          </Text>
        </View>
        {PLATFORMS.map((p) => {
          const history = data?.platforms[p].history ?? [];
          const published = history.filter((h) => h.status === 'published' || h.status === 'archived');
          if (published.length === 0) return null;
          return (
            <View key={p} style={{ marginBottom: 12 }}>
              <Text style={{ fontSize: 12, fontWeight: '800', color: `${c.text}88`, marginBottom: 6, textTransform: 'capitalize' }}>
                {p}
              </Text>
              {published.map((h, idx) => (
                <NeuCard key={h.id} style={{ marginBottom: 8, padding: 12 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 15, fontWeight: '800', color: c.text }}>
                      {displayVersion(h.version)}
                    </Text>
                    <View style={{ backgroundColor: `${statusColor(h.status)}18`, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 7 }}>
                      <Text style={{ fontSize: 10, fontWeight: '800', color: statusColor(h.status), textTransform: 'uppercase' }}>
                        {h.status === 'published' ? 'Current' : 'Previous'}
                      </Text>
                    </View>
                  </View>
                  <Text style={{ fontSize: 11, color: `${c.text}88`, marginTop: 3 }}>
                    {renderReleaseMeta(h)}
                  </Text>
                  {/* Rollback: only for a PREVIOUS release (not the current one) */}
                  {h.status === 'archived' && (
                    <Pressable
                      onPress={() => onRollback({ ...h, _plat: p })}
                      disabled={busyId === h.id}
                      accessibilityRole="button"
                      accessibilityLabel={`Roll back to version ${h.version}`}
                      style={{
                        marginTop: 8, paddingVertical: 8, borderRadius: 9, alignItems: 'center',
                        flexDirection: 'row', justifyContent: 'center', gap: 6,
                        borderWidth: 1.5, borderColor: `${c.text}22`,
                      }}
                    >
                      {busyId === h.id
                        ? <ActivityIndicator size="small" color={c.text} />
                        : <><Undo2 size={13} color={c.text} opacity={0.7} />
                            <Text style={{ color: c.text, fontWeight: '700', fontSize: 12, opacity: 0.8 }}>
                              Activate for Production
                            </Text></>}
                    </Pressable>
                  )}
                  {idx === 0 && h.status === 'published' ? null : null}
                </NeuCard>
              ))}
            </View>
          );
        })}

        {flash ? (
          <NeuCard style={{ padding: 12, borderColor: '#16A34A' }}>
            <Text style={{ color: '#16A34A', fontSize: 12, fontWeight: '700' }}>✓ {flash}</Text>
          </NeuCard>
        ) : null}

        <Text style={{ color: `${c.text}55`, fontSize: 11, marginTop: 12, textAlign: 'center', lineHeight: 16 }}>
          The production version NEVER changes automatically — not by editing{'\n'}
          this screen, building, or changing any other setting. Only an explicit{'\n'}
          Publish / Activate action above moves Current Production forward.
        </Text>
      </ScrollView>
    </View>
  );
}
