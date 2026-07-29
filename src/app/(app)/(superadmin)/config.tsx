import { useCallback, useState } from 'react';
import { View, Text, ScrollView, useColorScheme, RefreshControl, ActivityIndicator, TextInput, Pressable } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Settings, Save } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { getSystemConfig, upsertSystemConfig } from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { neuColors } from '@/lib/neu';

export default function SuperAdminConfig() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  const [configs, setConfigs] = useState<any[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const data = await getSystemConfig();
      setConfigs(data);
      const initialEdits: Record<string, string> = {};
      data.forEach((cfg: any) => { initialEdits[cfg.key] = typeof cfg.value === 'object' ? JSON.stringify(cfg.value) : String(cfg.value ?? ''); });
      setEdits(initialEdits);
    } catch (_) {}
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); loadData(); }, [loadData]));
  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

  const handleSave = async (key: string) => {
    setSaving(key);
    try {
      let value: unknown = edits[key];
      try { value = JSON.parse(edits[key]); } catch (_) {}
      await upsertSystemConfig(key, value);
      setSavedKey(key);
      setTimeout(() => setSavedKey(null), 2000);
    } catch (_) {}
    setSaving(null);
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }} contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}>
      <View style={{ padding: 20 }}>
        <PageHeader title="System Configuration" subtitle="Manage platform-wide settings" />

        {loading ? <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} /> : (
          configs.length === 0 ? (
            <NeuCard style={{ alignItems: 'center', padding: 40 }}>
              <Settings size={48} color={c.primary} opacity={0.3} style={{ marginBottom: 12 }} />
              <Text style={{ color: c.text, opacity: 0.4 }}>No configurations found</Text>
            </NeuCard>
          ) : configs.map(cfg => (
            <NeuCard key={cfg.key} style={{ marginBottom: 14, padding: 16 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                <Settings size={16} color={c.primary} style={{ marginRight: 8 }} />
                <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, flex: 1, fontFamily: 'monospace' }}>{cfg.key}</Text>
                {savedKey === cfg.key && (
                  <View style={{ backgroundColor: '#16A34A20', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: '#16A34A' }}>Saved!</Text>
                  </View>
                )}
              </View>
              <View style={{ backgroundColor: c.base, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 10, minWidth: 0, shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.5, shadowRadius: 4 }}>
                <TextInput
                  value={edits[cfg.key] ?? ''}
                  onChangeText={v => setEdits(prev => ({ ...prev, [cfg.key]: v }))}
                  multiline
                  style={{ flex: 1, minWidth: 0, fontSize: 13, color: c.text, minHeight: 40, fontFamily: 'monospace' }}
                  placeholderTextColor={`${c.text}55`}
                />
              </View>
              <NeuButton label={saving === cfg.key ? 'Saving…' : 'Save'} onPress={() => handleSave(cfg.key)} loading={saving === cfg.key} style={{ alignSelf: 'flex-end', paddingHorizontal: 20, paddingVertical: 10 }} />
            </NeuCard>
          ))
        )}
      </View>
    </ScrollView>
  );
}
