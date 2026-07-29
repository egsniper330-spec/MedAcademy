/**
 * CMS Pages — Admin & Super Admin
 * Edit About Us, Contact, Privacy Policy, Terms & Conditions.
 */
import { useCallback, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import {
  View, Text, ScrollView, TextInput, ActivityIndicator,
  RefreshControl, useColorScheme, Pressable,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { FileText, Edit3, Check, ChevronRight, ChevronDown } from 'lucide-react-native';
import { getCMSPages, updateCMSPage } from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { neuColors } from '@/lib/neu';

const PAGE_COLORS: Record<string, string> = {
  about_us: '#1E90FF', contact_us: '#16A34A', privacy_policy: '#7C3AED', terms_conditions: '#D97706',
};

export default function CMSPagesScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  const [pages, setPages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, { title: string; content: string }>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await getCMSPages();
      setPages(data);
      const ed: Record<string, { title: string; content: string }> = {};
      data.forEach((p: any) => { ed[p.key] = { title: p.title, content: p.content }; });
      setEditing(ed);
    } catch (_) {}
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const handleSave = async (key: string) => {
    const payload = editing[key];
    if (!payload) return;
    setSaving(key);
    try {
      await updateCMSPage(key, payload);
      setSaved(key);
      setTimeout(() => setSaved(null), 2500);
    } catch (_) {}
    setSaving(null);
  };

  const inp = { backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.45, shadowRadius: 5 };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }} contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}>
      <View style={{ padding: 20 }}>
        <PageHeader title="CMS Pages" subtitle="Edit platform content pages" accentColor="#16A34A" />

        {loading ? <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} /> : (
          pages.map(page => {
            const color = PAGE_COLORS[page.key] ?? c.primary;
            const isOpen = expanded === page.key;
            const draft = editing[page.key];
            return (
              <NeuCard key={page.key} style={{ marginBottom: 14 }}>
                <Pressable
                  onPress={() => setExpanded(isOpen ? null : page.key)}
                  style={{ flexDirection: 'row', alignItems: 'center', padding: 16 }}>
                  <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: `${color}18`, alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
                    <Edit3 size={20} color={color} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>{page.title}</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: page.published ? '#16A34A' : '#DC2626' }} />
                      <Text style={{ fontSize: 11, fontWeight: '600', color: page.published ? '#16A34A' : '#DC2626' }}>
                        {page.published ? 'Published' : 'Draft'}
                      </Text>
                    </View>
                  </View>
                  {saved === page.key ? (
                    <Check size={18} color="#16A34A" />
                  ) : isOpen ? (
                    <ChevronDown size={18} color={`${c.text}55`} />
                  ) : (
                    <ChevronRight size={18} color={`${c.text}55`} />
                  )}
                </Pressable>

                {isOpen && draft && (
                  <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase' }}>Page Title</Text>
                    <TextInput
                      value={draft.title}
                      onChangeText={v => setEditing(prev => ({ ...prev, [page.key]: { ...prev[page.key], title: v } }))}
                      style={{ ...inp, minWidth: 0, marginBottom: 14 }}
                    />
                    <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase' }}>Content (Markdown supported)</Text>
                    <View style={{ ...inp, minWidth: 0, marginBottom: 16 }}>
                      <TextInput
                        value={draft.content}
                        onChangeText={v => setEditing(prev => ({ ...prev, [page.key]: { ...prev[page.key], content: v } }))}
                        multiline
                        numberOfLines={10}
                        style={{ fontSize: 13, color: c.text, minWidth: 0, minHeight: 220, textAlignVertical: 'top' }}
                      />
                    </View>
                    {saved === page.key && (
                      <Text style={{ color: '#16A34A', fontWeight: '700', fontSize: 13, marginBottom: 10 }}>✅ Saved successfully</Text>
                    )}
                    <NeuButton
                      label="Save Changes"
                      icon={<Check size={16} color="#fff" />}
                      onPress={() => handleSave(page.key)}
                      loading={saving === page.key}
                      fullWidth
                    />
                  </View>
                )}
              </NeuCard>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}
