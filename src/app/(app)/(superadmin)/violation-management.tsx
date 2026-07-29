/**
 * Violation Management Screen — Admin / Super Admin
 *
 * View all content protection violations with filtering.
 * Per-row actions: Remove Suspension, Reset Violations, Clear Strikes, Restore Account.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, useColorScheme, Pressable,
  ActivityIndicator, TextInput, FlatList,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  ShieldOff, RotateCcw, UserCheck, AlertTriangle,
  Camera, Video, Filter, Search, ChevronDown,
} from 'lucide-react-native';
import { supabase } from '@/client/supabase';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, neuFlatStyle } from '@/lib/neu';
import { PageHeader } from '@/components/PageHeader';

interface Violation {
  id: string;
  user_id: string;
  violation_type: 'screenshot_detected' | 'screen_recording_detected';
  strike_count: number;
  action_taken: string;
  platform: string | null;
  installation_id: string | null;
  created_at: string;
  profiles: {
    full_name: string;
    email: string;
    role: string;
    violation_count: number;
    strike_count: number;
    is_suspended: boolean;
  } | null;
}

const TYPE_LABELS: Record<string, string> = {
  screenshot_detected:         'Screenshot',
  screen_recording_detected:   'Screen Recording',
};

const ACTION_COLORS: Record<string, string> = {
  warning: '#D97706',
  logout:  '#7C3AED',
  suspend: '#EF4444',
  ban:     '#991B1B',
};

export default function ViolationManagementScreen() {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const flat = neuFlatStyle(isDark);

  const [violations, setViolations]   = useState<Violation[]>([]);
  const [loading, setLoading]         = useState(true);
  const [search, setSearch]           = useState('');
  const [filter, setFilter]           = useState<'all' | 'suspended' | 'screenshot' | 'recording'>('all');
  const [acting, setActing]           = useState<string | null>(null);
  const [actionMsg, setActionMsg]     = useState('');

  const loadViolations = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('content_protection_violations')
      .select(`
        id, user_id, violation_type, strike_count, action_taken,
        platform, installation_id, created_at,
        profiles!user_id (
          full_name, email, role,
          violation_count, strike_count, is_suspended
        )
      `)
      .order('created_at', { ascending: false })
      .limit(200);
    setViolations(Array.isArray(data) ? data as unknown as Violation[] : []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { loadViolations(); }, [loadViolations]));

  const filtered = violations.filter((v) => {
    const prof = v.profiles;
    const matchSearch = !search || (
      prof?.full_name?.toLowerCase().includes(search.toLowerCase()) ||
      prof?.email?.toLowerCase().includes(search.toLowerCase())
    );
    const matchFilter =
      filter === 'all'        ? true :
      filter === 'suspended'  ? prof?.is_suspended :
      filter === 'screenshot' ? v.violation_type === 'screenshot_detected' :
      filter === 'recording'  ? v.violation_type === 'screen_recording_detected' :
      true;
    return matchSearch && matchFilter;
  });

  const doAction = async (
    userId: string,
    action: 'remove_suspension' | 'reset_violations' | 'clear_strikes' | 'restore_all',
  ) => {
    setActing(userId + action); setActionMsg('');
    try {
      if (action === 'remove_suspension' || action === 'restore_all') {
        const { error } = await supabase.functions.invoke('restore-account', {
          body: { target_user_id: userId, reset_violations: action === 'restore_all' },
        });
        if (error) throw new Error(await error?.context?.text?.() ?? error.message);
      } else if (action === 'reset_violations') {
        const { error } = await supabase.rpc('admin_reset_violations', { target_user_id: userId });
        if (error) throw error;
      } else if (action === 'clear_strikes') {
        const { error } = await supabase
          .from('profiles')
          .update({ strike_count: 0, updated_at: new Date().toISOString() })
          .eq('id', userId);
        if (error) throw error;
      }
      setActionMsg('Done');
      loadViolations();
    } catch (err: any) {
      setActionMsg(err?.message ?? 'Action failed');
    }
    setActing(null);
  };

  const FilterBtn = ({ val, label }: { val: typeof filter; label: string }) => (
    <Pressable
      onPress={() => setFilter(val)}
      style={[
        flat, {
          borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7,
          backgroundColor: filter === val ? c.primary : c.base,
        },
      ]}
    >
      <Text style={{ fontSize: 13, fontWeight: '600', color: filter === val ? '#fff' : c.text, opacity: filter === val ? 1 : 0.6 }}>
        {label}
      </Text>
    </Pressable>
  );

  const renderItem = ({ item: v }: { item: Violation }) => {
    const prof = v.profiles;
    const isSuspended = prof?.is_suspended;
    const isActing = acting?.startsWith(v.user_id);

    return (
      <NeuCard style={{ gap: 12 }}>
        {/* Header row */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
          <View style={{
            width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
            backgroundColor: v.violation_type === 'screenshot_detected' ? '#FEF3C7' : '#FEE2E2',
          }}>
            {v.violation_type === 'screenshot_detected'
              ? <Camera size={18} color="#D97706" />
              : <Video size={18} color="#EF4444" />}
          </View>

          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }} numberOfLines={1}>
              {prof?.full_name ?? 'Unknown'}
            </Text>
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }} numberOfLines={1}>
              {prof?.email} · {prof?.role}
            </Text>
          </View>

          {isSuspended && (
            <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, backgroundColor: '#FEE2E2' }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: '#DC2626' }}>SUSPENDED</Text>
            </View>
          )}
        </View>

        {/* Stats row */}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: `${c.primary}15` }}>
            <Text style={{ fontSize: 12, fontWeight: '600', color: c.primary }}>
              {TYPE_LABELS[v.violation_type]}
            </Text>
          </View>
          <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: `${ACTION_COLORS[v.action_taken] ?? c.primary}18` }}>
            <Text style={{ fontSize: 12, fontWeight: '600', color: ACTION_COLORS[v.action_taken] ?? c.primary }}>
              {v.action_taken}
            </Text>
          </View>
          <Text style={{ fontSize: 12, color: c.text, opacity: 0.4, paddingVertical: 4 }}>
            Strikes: {prof?.strike_count ?? 0} · Violations: {prof?.violation_count ?? 0}
          </Text>
        </View>

        <Text style={{ fontSize: 11, color: c.text, opacity: 0.35 }}>
          {new Date(v.created_at).toLocaleString()} · {v.platform ?? 'unknown'} · {v.installation_id?.slice(0, 8) ?? '—'}
        </Text>

        {/* Action buttons */}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {isSuspended && (
            <Pressable
              onPress={() => doAction(v.user_id, 'remove_suspension')}
              disabled={!!isActing}
              style={[flat, { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', gap: 6, alignItems: 'center', opacity: isActing ? 0.5 : 1 }]}
            >
              {isActing && acting === v.user_id + 'remove_suspension'
                ? <ActivityIndicator size="small" color={c.primary} />
                : <ShieldOff size={14} color="#16A34A" />}
              <Text style={{ fontSize: 12, fontWeight: '600', color: '#16A34A' }}>Unsuspend</Text>
            </Pressable>
          )}

          <Pressable
            onPress={() => doAction(v.user_id, 'reset_violations')}
            disabled={!!isActing}
            style={[flat, { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', gap: 6, alignItems: 'center', opacity: isActing ? 0.5 : 1 }]}
          >
            <RotateCcw size={14} color={c.primary} />
            <Text style={{ fontSize: 12, fontWeight: '600', color: c.primary }}>Reset</Text>
          </Pressable>

          <Pressable
            onPress={() => doAction(v.user_id, 'restore_all')}
            disabled={!!isActing}
            style={[flat, { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', gap: 6, alignItems: 'center', opacity: isActing ? 0.5 : 1 }]}
          >
            {isActing && acting === v.user_id + 'restore_all'
              ? <ActivityIndicator size="small" color="#7C3AED" />
              : <UserCheck size={14} color="#7C3AED" />}
            <Text style={{ fontSize: 12, fontWeight: '600', color: '#7C3AED' }}>Restore All</Text>
          </Pressable>
        </View>
      </NeuCard>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <PageHeader title="Violations" subtitle="Content protection violation logs" />

      {/* Search + filters */}
      <View style={{ paddingHorizontal: 16, paddingBottom: 8, gap: 10 }}>
        <View style={[flat, { borderRadius: 14, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, gap: 10, minWidth: 0 }]}>
          <Search size={16} color={c.text} opacity={0.4} style={{ flexShrink: 0 }} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search by name or email…"
            placeholderTextColor={`${c.text}55`}
            style={{ flex: 1, minWidth: 0, fontSize: 14, color: c.text }}
          />
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          <FilterBtn val="all"        label="All" />
          <FilterBtn val="suspended"  label="Suspended" />
          <FilterBtn val="screenshot" label="Screenshot" />
          <FilterBtn val="recording"  label="Recording" />
        </ScrollView>
      </View>

      {actionMsg !== '' && (
        <View style={{ marginHorizontal: 16, marginBottom: 8, padding: 10, borderRadius: 10, backgroundColor: actionMsg === 'Done' ? '#DCFCE7' : '#FEE2E2' }}>
          <Text style={{ fontSize: 13, color: actionMsg === 'Done' ? '#16A34A' : '#DC2626' }}>{actionMsg}</Text>
        </View>
      )}

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={c.primary} size="large" />
        </View>
      ) : filtered.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          <AlertTriangle size={40} color={c.text} opacity={0.2} />
          <Text style={{ fontSize: 15, color: c.text, opacity: 0.4 }}>No violations found</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}
          contentInsetAdjustmentBehavior="automatic"
        />
      )}
    </View>
  );
}
