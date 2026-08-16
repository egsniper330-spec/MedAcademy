/**
 * Maintenance Mode — Super Admin only
 * Enable/disable maintenance; manage whitelist.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, Switch, TextInput, ActivityIndicator,
  RefreshControl, useColorScheme, Pressable,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Wrench, Plus, Trash2, UserCheck, AlertTriangle } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import {
  getMaintenanceConfig, setMaintenanceMode,
  getMaintenanceWhitelist, addToMaintenanceWhitelist, removeFromMaintenanceWhitelist,
  searchUsers,
} from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout } from '@/lib/neu';
import { useDebounce } from '@/lib/useDebounce';
import { friendlyError } from '@/lib/validation';

export default function MaintenanceModeScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const { showToast } = useToast();

  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState('');
  const [whitelist, setWhitelist] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Add to whitelist modal
  const [addModal, setAddModal] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const debouncedSearch = useDebounce(searchQ, 400);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const [cfg, wl] = await Promise.all([getMaintenanceConfig(), getMaintenanceWhitelist()]);
      setEnabled(cfg.enabled);
      setMessage(cfg.message);
      setWhitelist(wl);
    } catch (_) {}
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const handleSave = async () => {
    setSaving(true);
    try {
      await setMaintenanceMode(enabled, message);
      showToast({ type: 'success', message: `Maintenance mode ${enabled ? 'enabled' : 'disabled'}.` });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to save maintenance settings.') });
    }
    setSaving(false);
  };

  const handleSearch = async () => {
    if (!debouncedSearch.trim()) return;
    setSearching(true);
    try { setSearchResults(await searchUsers(debouncedSearch)); } catch (_) {}
    setSearching(false);
  };

  const handleAddUser = async (userId: string) => {
    setAdding(true);
    try {
      await addToMaintenanceWhitelist(userId);
      await load();
      setAddModal(false);
      setSearchQ(''); setSearchResults([]);
      showToast({ type: 'success', message: 'User added to whitelist.' });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to add user.') });
    }
    setAdding(false);
  };

  const handleRemove = async (userId: string) => {
    try {
      await removeFromMaintenanceWhitelist(userId);
      setWhitelist(prev => prev.filter(w => w.user_id !== userId));
    } catch (_) {}
  };

  const inp = { backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.55, shadowRadius: 5 };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }}
          contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}>
      <View style={{ padding: layout.screenPx }}>
        <PageHeader title="Maintenance Mode" subtitle="Control platform availability" accentColor="#DC2626" />

        {loading ? <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} /> : (
          <>
            {/* Status toggle */}
            <NeuCard style={{ marginBottom: 16, padding: 18 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 16, fontWeight: '700', color: c.text }}>Maintenance Mode</Text>
                  <Text style={{ fontSize: 12, color: enabled ? '#DC2626' : '#16A34A', fontWeight: '600', marginTop: 4 }}>
                    {enabled ? '⚠️ Currently Active — users are blocked' : '✅ Platform is Live'}
                  </Text>
                </View>
                <Switch
                  value={enabled}
                  onValueChange={setEnabled}
                  trackColor={{ false: `${c.text}22`, true: '#DC262655' }}
                  thumbColor={enabled ? '#DC2626' : `${c.text}55`}
                />
              </View>
            </NeuCard>

            {enabled && (
              <NeuCard style={{ marginBottom: 16, padding: 14, flexDirection: 'row', gap: 10 }}>
                <AlertTriangle size={18} color="#D97706" style={{ marginTop: 2 }} />
                <Text style={{ flex: 1, fontSize: 13, color: '#D97706', fontWeight: '600' }}>
                  Maintenance mode is active. Only whitelisted users can access the platform.
                </Text>
              </NeuCard>
            )}

            {/* Message */}
            <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, opacity: 0.6, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 }}>
              Maintenance Message
            </Text>
            <View style={{ ...inp, minWidth: 0, marginBottom: 20 }}>
              <TextInput
                value={message}
                onChangeText={setMessage}
                multiline
                numberOfLines={3}
                placeholder="Message shown to non-whitelisted users..."
                placeholderTextColor={`${c.text}55`}
                style={{ fontSize: 14, color: c.text, minWidth: 0, minHeight: 72 }}
              />
            </View>

            <NeuButton label="Save Settings" onPress={handleSave} loading={saving} fullWidth style={{ marginBottom: 28 }} />

            {/* Whitelist */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: c.text }}>Whitelist ({whitelist.length})</Text>
              <Pressable onPress={() => setAddModal(true)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.primary, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8 }}>
                <Plus size={15} color="#fff" />
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>Add User</Text>
              </Pressable>
            </View>

            {whitelist.length === 0 ? (
              <NeuCard style={{ padding: 24, alignItems: 'center' }}>
                <UserCheck size={32} color={c.primary} opacity={0.3} />
                <Text style={{ color: c.text, opacity: 0.4, marginTop: 12 }}>No whitelisted users</Text>
              </NeuCard>
            ) : whitelist.map(item => (
              <NeuCard key={item.id} style={{ marginBottom: 10, padding: 14 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                    <UserCheck size={18} color={c.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{item.profile?.full_name ?? 'Unknown'}</Text>
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>{item.profile?.email ?? ''}</Text>
                  </View>
                  <View style={{ backgroundColor: `${c.primary}18`, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, marginRight: 10 }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: c.primary }}>{item.profile?.role ?? ''}</Text>
                  </View>
                  <Pressable onPress={() => handleRemove(item.user_id)}
                    hitSlop={6} style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}>
                    <Trash2 size={15} color="#DC2626" />
                  </Pressable>
                </View>
              </NeuCard>
            ))}
          </>
        )}
      </View>

      <ResponsiveModal
        visible={addModal}
        onClose={() => { setAddModal(false); setSearchQ(''); setSearchResults([]); }}
        title="Add to Whitelist"
        footer={
          <NeuButton
            label="Cancel"
            onPress={() => { setAddModal(false); setSearchQ(''); setSearchResults([]); }}
            variant="secondary"
            fullWidth
          />
        }
      >
        <View style={{ ...inp, flexDirection: 'row', alignItems: 'center', minWidth: 0, marginBottom: 12 }}>
          <TextInput
            value={searchQ}
            onChangeText={setSearchQ}
            onSubmitEditing={handleSearch}
            placeholder="Search by name, email or phone..."
            placeholderTextColor={`${c.text}55`}
            style={{ flex: 1, minWidth: 0, fontSize: 14, color: c.text }}
          />
          {searching && <ActivityIndicator size="small" color={c.primary} />}
        </View>
        <NeuButton label="Search" onPress={handleSearch} loading={searching} fullWidth style={{ marginBottom: 12 }} />
        {searchResults.map(u => (
          <Pressable key={u.id} onPress={() => handleAddUser(u.id)}
            style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }}>{u.full_name}</Text>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>{u.email} • {u.role}</Text>
            </View>
            <Plus size={16} color={c.primary} />
          </Pressable>
        ))}
        {adding && <ActivityIndicator color={c.primary} style={{ marginTop: 8 }} />}
      </ResponsiveModal>
    </ScrollView>
  );
}
