/**
 * Feature Flags — Super Admin only
 * Enable/disable platform capabilities without code changes.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, Switch, ActivityIndicator,
  RefreshControl, useColorScheme,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Flag, RefreshCw } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { getFeatureFlags, toggleFeatureFlag } from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { LoadingState, ErrorState } from '@/components/ScreenState';
import { EmptyState } from '@/components/EmptyState';
import { neuColors, useLayout, safeBottom } from '@/lib/neu';

export default function FeatureFlagsScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  const [flags, setFlags] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  // Terminal-state contract: LOADING → (ERROR | EMPTY | CONTENT).
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setFlags(await getFeatureFlags());
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const handleToggle = async (key: string, current: boolean) => {
    setSaving(key);
    const optimistic = flags.map(f => f.key === key ? { ...f, enabled: !current } : f);
    setFlags(optimistic);
    try {
      await toggleFeatureFlag(key, !current);
    } catch {
      setFlags(flags); // revert on error
    }
    setSaving(null);
  };

  const categoryColors: Record<string, string> = {
    registration: '#16A34A', login: '#1E90FF', credits: '#D97706',
    subscriptions: '#6B7280',
    course_creation: '#2DA8FF', notifications: '#D97706',
    maintenance_mode: '#DC2626', video_uploads: '#7C3AED',
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />} contentContainerStyle={{ paddingBottom: safeBottom(layout.insets.bottom) }}>
      <PageHeader title="Feature Flags" subtitle="Toggle platform capabilities" />

      <View style={{ paddingHorizontal: layout.screenPx }}>

        <NeuCard style={{ marginBottom: 20, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <RefreshCw size={16} color={c.primary} />
          <Text style={{ flex: 1, fontSize: 12, color: c.text, opacity: 0.6 }}>
            Changes apply immediately platform-wide. Disabling login will affect all users.
          </Text>
        </NeuCard>

        {loading ? <LoadingState label="Loading feature flags…" /> : error ? (
          <ErrorState error={error} onRetry={load} />
        ) : flags.length === 0 ? (
          <EmptyState
            icon={<Flag size={40} color={c.primary} />}
            title="No feature flags"
            description="The server returned no feature flags."
            action={{ label: 'Refresh', onPress: load }}
          />
        ) : (
          flags.map(flag => {
            const color = categoryColors[flag.key] ?? c.primary;
            return (
              <NeuCard key={flag.id} style={{ marginBottom: 12, padding: 16 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: `${color}18`, alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
                    <Flag size={18} color={color} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>{flag.label}</Text>
                    {flag.description && (
                      <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 3 }}>{flag.description}</Text>
                    )}
                  </View>
                  {saving === flag.key ? (
                    <ActivityIndicator size="small" color={c.primary} />
                  ) : (
                    <Switch
                      value={flag.enabled}
                      onValueChange={() => handleToggle(flag.key, flag.enabled)}
                      trackColor={{ false: `${c.text}22`, true: `${color}55` }}
                      thumbColor={flag.enabled ? color : `${c.text}55`}
                    />
                  )}
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, marginLeft: 54 }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: flag.enabled ? '#16A34A' : '#DC2626', marginRight: 6 }} />
                  <Text style={{ fontSize: 11, fontWeight: '600', color: flag.enabled ? '#16A34A' : '#DC2626' }}>
                    {flag.enabled ? 'Enabled' : 'Disabled'}
                  </Text>
                </View>
              </NeuCard>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}
