/**
 * Delete Permissions — Super Admin
 * Configure per-admin deletion permission matrix.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, useColorScheme, Pressable,
  RefreshControl, ActivityIndicator, FlatList,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Shield, ChevronDown, ChevronUp, Save, UserCog, RefreshCw } from 'lucide-react-native';
import {
  getDeletePermissions, saveDeletePermissions,
  type DeletePermissions,
} from '@/lib/api';
import { supabase } from '@/client/supabase';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { useToast } from '@/components/Toast';
import { neuColors, neuFlatStyle, useLayout } from '@/lib/neu'
import { logAndParse } from '@/lib/parseError';

const PERM_LABELS: Array<{ key: keyof DeletePermissions; label: string; desc: string; danger?: boolean }> = [
  { key: 'can_delete_students',   label: 'Delete Students',      desc: 'Move student accounts to trash' },
  { key: 'can_delete_doctors',    label: 'Delete Doctors',       desc: 'Move doctor accounts to trash', danger: true },
  { key: 'can_delete_admins',     label: 'Delete Admins',        desc: 'Move admin accounts to trash',  danger: true },
  { key: 'can_restore',           label: 'Restore Accounts',     desc: 'Restore trashed accounts' },
  { key: 'can_permanent_delete',  label: 'Permanent Delete',     desc: 'Bypass trash — delete forever', danger: true },
  { key: 'can_empty_trash',       label: 'Empty Trash',          desc: 'Permanently delete all trash',  danger: true },
];

interface AdminProfile {
  id: string;
  full_name: string;
  email: string;
  role: string;
}

export default function DeletePermissionsScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c    = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const flat = neuFlatStyle(isDark);
  const { showToast } = useToast();

  const [admins,    setAdmins]    = useState<AdminProfile[]>([]);
  const [permsMap,  setPermsMap]  = useState<Record<string, DeletePermissions>>({});
  const [expanded,  setExpanded]  = useState<string | null>(null);
  const [saving,    setSaving]    = useState<string | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [refreshing,setRefreshing]= useState(false);

  const loadAdmins = useCallback(async () => {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, email, role, delete_permissions')
      .eq('role', 'admin')
      .eq('status', 'active')
      .order('full_name');
    if (error) { setLoading(false); return; }
    const list = (data ?? []) as (AdminProfile & { delete_permissions?: any })[];
    setAdmins(list);
    // Seed permsMap with defaults merged with stored
    const defaults: DeletePermissions = {
      can_delete_students: true, can_delete_doctors: false, can_delete_admins: false,
      can_permanent_delete: false, can_restore: true, can_empty_trash: false,
    };
    const map: Record<string, DeletePermissions> = {};
    for (const a of list) {
      map[a.id] = { ...defaults, ...(a.delete_permissions ?? {}) };
    }
    setPermsMap(map);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); loadAdmins(); }, [loadAdmins]));
  const onRefresh = async () => { setRefreshing(true); await loadAdmins(); setRefreshing(false); };

  const toggle = (adminId: string, key: keyof DeletePermissions) => {
    setPermsMap(prev => ({
      ...prev,
      [adminId]: { ...prev[adminId], [key]: !prev[adminId][key] },
    }));
  };

  const handleSave = async (adminId: string, name: string) => {
    setSaving(adminId);
    try {
      await saveDeletePermissions(adminId, permsMap[adminId]);
      showToast({ type: 'success', message: `Permissions saved for ${name}.` });
    } catch (e) {
      showToast({ type: 'error', message: logAndParse(e, 'delete_permissions.save') });
    } finally {
      setSaving(null);
    }
  };

  const renderAdmin = ({ item }: { item: AdminProfile }) => {
    const isExpanded = expanded === item.id;
    const perms = permsMap[item.id];
    if (!perms) return null;

    return (
      <NeuCard style={{ marginBottom: 10 }}>
        <Pressable
          onPress={() => setExpanded(isExpanded ? null : item.id)}
          style={{ flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 }}
        >
          <View style={[flat, { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }]}>
            <UserCog size={20} color={c.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{item.full_name}</Text>
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 1 }}>{item.email}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 5 }}>
              {PERM_LABELS.filter(p => perms[p.key]).map(p => (
                <View key={p.key} style={{ backgroundColor: `${c.primary}15`, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 }}>
                  <Text style={{ fontSize: 9, fontWeight: '700', color: c.primary }}>{p.label}</Text>
                </View>
              ))}
            </View>
          </View>
          {isExpanded
            ? <ChevronUp size={16} color={`${c.text}50`} />
            : <ChevronDown size={16} color={`${c.text}50`} />
          }
        </Pressable>

        {isExpanded && (
          <View style={{ paddingHorizontal: 14, paddingBottom: 14, gap: 8 }}>
            <View style={{ height: 1, backgroundColor: `${c.text}10`, marginBottom: 6 }} />
            {PERM_LABELS.map(p => {
              const enabled = perms[p.key];
              const accentColor = p.danger ? '#EF4444' : '#16A34A';
              return (
                <Pressable key={p.key} onPress={() => toggle(item.id, p.key)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingHorizontal: 10,
                    borderRadius: 10, backgroundColor: enabled ? `${accentColor}0C` : `${c.text}06` }}>
                  {/* Toggle pill */}
                  <View style={{ width: 38, height: 22, borderRadius: 11,
                    backgroundColor: enabled ? accentColor : `${c.text}20`,
                    justifyContent: 'center', paddingHorizontal: 2 }}>
                    <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: '#fff',
                      alignSelf: enabled ? 'flex-end' : 'flex-start' }} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: enabled ? accentColor : c.text }}>{p.label}</Text>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.45, marginTop: 1 }}>{p.desc}</Text>
                  </View>
                </Pressable>
              );
            })}
            <NeuButton
              label={saving === item.id ? 'Saving…' : 'Save Permissions'}
              onPress={() => handleSave(item.id, item.full_name)}
              loading={saving === item.id}
              fullWidth
              style={{ marginTop: 6 }}
              icon={<Save size={14} color="#fff" />}
            />
          </View>
        )}
      </NeuCard>
    );
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }} contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}>
      <View style={{ padding: layout.screenPx }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4, marginTop: 8 }}>
          <Shield size={22} color={c.primary} />
          <Text style={{ fontSize: 24, fontWeight: '800', color: c.text }}>Delete Permissions</Text>
        </View>
        <Text style={{ fontSize: 13, color: c.text, opacity: 0.5, marginBottom: 20 }}>
          Configure which admins can delete, restore, and manage trash.
        </Text>

        {loading ? (
          <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} />
        ) : admins.length === 0 ? (
          <NeuCard style={{ padding: 32, alignItems: 'center' }}>
            <UserCog size={28} color={`${c.text}30`} />
            <Text style={{ fontSize: 13, color: c.text, opacity: 0.4, marginTop: 10 }}>No active admins found.</Text>
          </NeuCard>
        ) : (
          <FlatList
            data={admins}
            keyExtractor={a => a.id}
            renderItem={renderAdmin}
            scrollEnabled={false}
            contentInsetAdjustmentBehavior="automatic"
          />
        )}
      </View>
    </ScrollView>
  );
}
