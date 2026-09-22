import { useCallback, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, useColorScheme, RefreshControl,
  ActivityIndicator, TextInput, Pressable, Switch, Alert,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { CloudUpload, Save } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import {
  getAppUpdateConfig, setAppUpdateConfig,
  type AppUpdateConfig,
} from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { neuColors, useLayout, safeBottom } from '@/lib/neu';
/**
 * Super Admin → App Updates
 *
 * Remote control for the forced-update system. Version names are display-only;
 * enforcement is by integer versionCode (authoritative). Every change here
 * takes effect on clients immediately — no app rebuild required.
 */

type Platform = 'android' | 'ios';

interface FormState {
  enabled: boolean;
  latestVersionName: string;
  latestVersionCode: string;
  minimumVersionCode: string;
  updateMode: 'FORCED' | 'OPTIONAL';
  updateUrl: string;
  releaseNotes: string;
}

const DEFAULT_FORM: FormState = {
  enabled: true,
  latestVersionName: '',
  latestVersionCode: '',
  minimumVersionCode: '',
  updateMode: 'FORCED', // production default — see §2 of the update policy
  updateUrl: '',
  releaseNotes: '',
};

const HTTPS_URL_RE = /^https:\/\/\S+$/i;

function validate(f: FormState): string | null {
  if (f.enabled) {
    if (!f.latestVersionName.trim()) return 'Latest version name is required (e.g. 1.0.850).';
    const latest = Number(f.latestVersionCode);
    if (!Number.isInteger(latest) || latest <= 0) return 'Latest version code must be a positive integer (e.g. 230).';
    const min = Number(f.minimumVersionCode);
    if (!Number.isInteger(min) || min < 0) return 'Minimum supported version code must be a non-negative integer.';
    if (min > latest) return 'Minimum supported version code cannot exceed the latest version code.';
    if (!f.updateUrl.trim()) return 'Update URL is required while enforcement is enabled.';
    if (!HTTPS_URL_RE.test(f.updateUrl.trim())) return 'Update URL must be a valid https:// URL.';
    if (f.updateMode !== 'FORCED' && f.updateMode !== 'OPTIONAL') return 'Update mode must be FORCED or OPTIONAL.';
  }
  return null;
}

export default function SuperAdminAppUpdates() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  const [platform, setPlatform] = useState<Platform>('android');
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [meta, setMeta] = useState<{ updated_by_name?: string | null; updated_at?: string | null }>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]): void =>
    setForm((p) => ({ ...p, [k]: v }));

  const loadData = useCallback(async (plat: Platform) => {
    try {
      const cfg: AppUpdateConfig = await getAppUpdateConfig(plat);
      setForm({
        enabled: cfg.enabled,
        latestVersionName: cfg.latest_version_name ?? '',
        latestVersionCode: cfg.latest_version_code != null ? String(cfg.latest_version_code) : '',
        minimumVersionCode: cfg.minimum_version_code != null ? String(cfg.minimum_version_code) : '',
        updateMode: cfg.update_mode === 'OPTIONAL' ? 'OPTIONAL' : 'FORCED',
        updateUrl: cfg.update_url ?? '',
        releaseNotes: cfg.release_notes ?? '',
      });
      setMeta({ updated_by_name: cfg.updated_by_name, updated_at: cfg.updated_at });
    } catch (e) {
      // Endpoint failed (403 for non-SA is expected) — keep defaults, surface msg.
      const msg = e instanceof Error ? e.message : 'Failed to load configuration';
      Alert.alert('Load failed', msg);
      setForm(DEFAULT_FORM);
      setMeta({});
    }
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void loadData(platform);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [platform])
  );

  const onRefresh = async (): Promise<void> => {
    setRefreshing(true);
    await loadData(platform);
    setRefreshing(false);
  };

  const validationError = useMemo(() => validate(form), [form]);

  const onSave = async (): Promise<void> => {
    const err = validate(form);
    if (err) {
      Alert.alert('Invalid configuration', err);
      return;
    }
    setSaving(true);
    const r = await setAppUpdateConfig(platform, {
      enabled: form.enabled,
      latestVersionName: form.latestVersionName.trim(),
      latestVersionCode: Number(form.latestVersionCode),
      minimumVersionCode: Number(form.minimumVersionCode),
      updateMode: form.updateMode,
      updateUrl: form.updateUrl.trim(),
      releaseNotes: form.releaseNotes.trim(),
    });
    setSaving(false);
    if (!r.ok) {
      Alert.alert('Save failed', r.error ?? 'Unknown error');
      return;
    }
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 2500);
    void loadData(platform);
  };

  const onPlatformChange = (p: Platform): void => {
    if (p === platform) return;
    setPlatform(p);
    setLoading(true);
    void loadData(p);
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

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: c.base, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color={c.primary} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <PageHeader title="App Updates" subtitle="Remote version enforcement" />
      <ScrollView
        contentContainerStyle={{ padding: layout.pad.md, paddingBottom: safeBottom(layout.insets.bottom) + 48 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.text} />}
        keyboardShouldPersistTaps="handled"
      >
        {/* Platform selector — iOS-ready without any redesign */}
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
          {(['android', 'ios'] as Platform[]).map((p) => (
            <Pressable
              key={p}
              onPress={() => onPlatformChange(p)}
              style={{
                flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center',
                borderWidth: 1.5,
                borderColor: platform === p ? c.primary : `${c.text}22`,
                backgroundColor: platform === p ? `${c.primary}18` : 'transparent',
              }}
            >
              <Text style={{ color: platform === p ? c.primary : c.text, fontWeight: '700', textTransform: 'capitalize' }}>
                {p}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Enabled */}
        <NeuCard style={{ marginBottom: 12, padding: 14 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={{ color: c.text, fontWeight: '700', fontSize: 15 }}>Enforcement enabled</Text>
              <Text style={{ color: `${c.text}99`, fontSize: 12, marginTop: 2 }}>
                Off = all versions allowed (kill switch)
              </Text>
            </View>
            <Switch
              value={form.enabled}
              onValueChange={(v) => set('enabled', v)}
              trackColor={{ true: c.primary, false: `${c.text}33` }}
              thumbColor="#fff"
            />
          </View>
        </NeuCard>

        {/* Version fields */}
        <NeuCard style={{ marginBottom: 12, padding: 14, gap: 12 }}>
          <View>
            <Text style={{ color: `${c.text}99`, fontSize: 12, fontWeight: '700', marginBottom: 6 }}>
              LATEST VERSION NAME (DISPLAY ONLY)
            </Text>
            <TextInput
              style={inputStyle}
              value={form.latestVersionName}
              onChangeText={(t) => set('latestVersionName', t)}
              placeholder="1.0.850"
              placeholderTextColor={`${c.text}55`}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="default"
            />
          </View>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: `${c.text}99`, fontSize: 12, fontWeight: '700', marginBottom: 6 }}>
                LATEST VERSION CODE
              </Text>
              <TextInput
                style={inputStyle}
                value={form.latestVersionCode}
                onChangeText={(t) => set('latestVersionCode', t.replace(/[^0-9]/g, ''))}
                placeholder="230"
                placeholderTextColor={`${c.text}55`}
                keyboardType="number-pad"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: `${c.text}99`, fontSize: 12, fontWeight: '700', marginBottom: 6 }}>
                MIN SUPPORTED CODE
              </Text>
              <TextInput
                style={inputStyle}
                value={form.minimumVersionCode}
                onChangeText={(t) => set('minimumVersionCode', t.replace(/[^0-9]/g, ''))}
                placeholder="230"
                placeholderTextColor={`${c.text}55`}
                keyboardType="number-pad"
              />
            </View>
          </View>

          {/* Update mode */}
          <View>
            <Text style={{ color: `${c.text}99`, fontSize: 12, fontWeight: '700', marginBottom: 6 }}>
              UPDATE MODE
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {(['FORCED', 'OPTIONAL'] as const).map((m) => (
                <Pressable
                  key={m}
                  onPress={() => set('updateMode', m)}
                  style={{
                    flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center',
                    borderWidth: 1.5,
                    borderColor: form.updateMode === m ? c.primary : `${c.text}22`,
                    backgroundColor: form.updateMode === m ? `${c.primary}18` : 'transparent',
                  }}
                >
                  <Text style={{ color: form.updateMode === m ? c.primary : c.text, fontWeight: '700' }}>{m}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={{ color: `${c.text}66`, fontSize: 11, marginTop: 6 }}>
              {form.updateMode === 'FORCED'
                ? 'Users cannot use the app until they update.'
                : 'Users may dismiss the update notice and continue.'}
            </Text>
          </View>

          {/* Update URL */}
          <View>
            <Text style={{ color: `${c.text}99`, fontSize: 12, fontWeight: '700', marginBottom: 6 }}>
              UPDATE URL (APK FILE, PLAY STORE, OR ANY HTTPS DESTINATION)
            </Text>
            <TextInput
              style={inputStyle}
              value={form.updateUrl}
              onChangeText={(t) => set('updateUrl', t)}
              placeholder="https://example.com/MedAcademy-1.0.850.apk"
              placeholderTextColor={`${c.text}55`}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              multiline={false}
            />
          </View>

          {/* Release notes */}
          <View>
            <Text style={{ color: `${c.text}99`, fontSize: 12, fontWeight: '700', marginBottom: 6 }}>
              RELEASE NOTES (OPTIONAL)
            </Text>
            <TextInput
              style={[inputStyle, { minHeight: 72, textAlignVertical: 'top' }]}
              value={form.releaseNotes}
              onChangeText={(t) => set('releaseNotes', t)}
              placeholder="Security fixes and performance improvements."
              placeholderTextColor={`${c.text}55`}
              multiline
            />
          </View>
        </NeuCard>

        {/* Validation feedback */}
        {validationError ? (
          <NeuCard style={{ marginBottom: 12, padding: 12, borderColor: '#EF4444' }}>
            <Text style={{ color: '#EF4444', fontSize: 13, fontWeight: '600' }}>⚠ {validationError}</Text>
          </NeuCard>
        ) : null}

        {/* Save */}
        <NeuButton
          label={savedFlash ? 'Saved ✓' : 'Save Configuration'}
          onPress={onSave}
          disabled={saving || !!validationError}
          loading={saving}
        />

        <Text style={{ color: `${c.text}55`, fontSize: 11, marginTop: 12, textAlign: 'center', lineHeight: 16 }}>
          Changes apply immediately — no app rebuild needed.{'\n'}
          {meta.updated_at
            ? `Last updated ${new Date(meta.updated_at).toLocaleString()}${meta.updated_by_name ? ` by ${meta.updated_by_name}` : ''}`
            : 'Never configured.'}
        </Text>
      </ScrollView>
    </View>
  );
}
