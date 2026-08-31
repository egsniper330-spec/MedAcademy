/**
 * Bulk Credit Operations — Add or Remove credits to multiple doctors at once.
 * Admin + Super Admin only.
 */
import { useCallback, useState, useMemo } from 'react';
import {
  View, Text, FlatList, TextInput, Pressable,
  ActivityIndicator, RefreshControl, useColorScheme,
  KeyboardAvoidingView, ScrollView,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { PageHeader } from '@/components/PageHeader';
import {
  CreditCard, CheckSquare, Square, Users, TrendingUp, TrendingDown,
  Search, X, AlertCircle,
} from 'lucide-react-native';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout } from '@/lib/neu';
import { getDoctors, invokeEdgeFunction } from '@/lib/api';
import { useDebounce } from '@/lib/useDebounce';
import { getPublicEmail } from '@/lib/api';

export default function BulkCreditsScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const { showToast } = useToast();

  const [doctors, setDoctors]       = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch]         = useState('');
  const dSearch = useDebounce(search, 300);

  const [selected, setSelected]   = useState<Set<string>>(new Set());
  const [opModal, setOpModal]     = useState(false);
  const [opType, setOpType]       = useState<'add' | 'remove'>('add');
  const [amount, setAmount]       = useState('');
  const [notes, setNotes]         = useState('');
  const [reason, setReason]       = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resultModal, setResultModal] = useState(false);
  const [results, setResults]     = useState<any[]>([]);

  const load = useCallback(async () => {
    try { setDoctors(await getDoctors()); } catch (_) {}
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const filtered = useMemo(() => {
    if (!dSearch) return doctors;
    const q = dSearch.toLowerCase();
    return doctors.filter(d =>
      d.full_name?.toLowerCase().includes(q) || d.email?.toLowerCase().includes(q)
    );
  }, [doctors, dSearch]);

  const toggleSelect = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const toggleAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map(d => d.id)));
  };

  const openOp = (type: 'add' | 'remove') => {
    if (selected.size === 0) { showToast({ type: 'error', message: 'Select at least one doctor' }); return; }
    setOpType(type); setAmount(''); setNotes(''); setReason('');
    setOpModal(true);
  };

  const submit = async () => {
    const amt = parseInt(amount, 10);
    if (isNaN(amt) || amt <= 0) { showToast({ type: 'error', message: 'Enter a valid amount' }); return; }
    if (opType === 'remove' && !reason.trim()) { showToast({ type: 'error', message: 'Reason is required for credit removal' }); return; }

    setSubmitting(true);
    try {
      const doctorIds = Array.from(selected);
      let res: any;
      if (opType === 'add') {
        res = await invokeEdgeFunction('credits', {
          action: 'bulk_allocate', doctor_ids: doctorIds, amount: amt, notes,
        });
      } else {
        // Sequential revoke for audit trail
        const revResults = [];
        for (const did of doctorIds) {
          try {
            const r = await invokeEdgeFunction('credits', {
              action: 'revoke', doctor_id: did, amount: amt, reason, notes,
            });
            revResults.push({ doctor_id: did, success: true, data: r });
          } catch (e: any) {
            revResults.push({ doctor_id: did, error: e.message });
          }
        }
        res = { results: revResults };
      }
      setResults(res?.results ?? []);
      setOpModal(false);
      setSelected(new Set());
      setResultModal(true);
      await load();
    } catch (e: any) {
      showToast({ type: 'error', message: e.message ?? 'Operation failed' });
    }
    setSubmitting(false);
  };

  const inp: object = {
    backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11,
    shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.5,
    shadowRadius: 5, fontSize: 13, color: c.text, marginBottom: 12,
  };

  const successCount = results.filter(r => r.success).length;
  const errorCount   = results.filter(r => r.error).length;

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <FlatList
        data={filtered}
        keyExtractor={item => item.id}
        contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
        ListHeaderComponent={
          <>
            <PageHeader title="Bulk Credits" subtitle={`${selected.size} selected of ${filtered.length} doctors`} />

          <View style={{ paddingHorizontal: layout.screenPx, paddingTop: 8 }}>

            {/* Search */}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12, minWidth: 0 }}>
              <Search size={15} color={`${c.text}55`}  />
              <TextInput value={search} onChangeText={setSearch} placeholder="Search doctors..."
                placeholderTextColor={`${c.text}55`}
                style={{ ...(inp as object), flex: 1, minWidth: 0, paddingLeft: 36, marginBottom: 0 }} />
              {search !== '' && (
                <Pressable onPress={() => setSearch('')} >
                  <X size={14} color={`${c.text}55`} />
                </Pressable>
              )}
            </View>

            {/* Select All + Action Buttons */}
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
              <Pressable onPress={toggleAll}
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10,
                  borderRadius: 12, backgroundColor: c.base,
                  shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.4, shadowRadius: 4 }}>
                {selected.size === filtered.length && filtered.length > 0
                  ? <CheckSquare size={16} color={c.primary} />
                  : <Square size={16} color={`${c.text}55`} />}
                <Text style={{ fontSize: 12, fontWeight: '600', color: c.text }}>Select All</Text>
              </Pressable>
              <Pressable onPress={() => openOp('add')} disabled={selected.size === 0}
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                  padding: 10, borderRadius: 12, backgroundColor: selected.size > 0 ? '#16A34A' : `${c.text}10` }}>
                <TrendingUp size={14} color={selected.size > 0 ? '#fff' : `${c.text}40`} />
                <Text style={{ fontSize: 12, fontWeight: '700', color: selected.size > 0 ? '#fff' : `${c.text}40` }}>Add Credits</Text>
              </Pressable>
              <Pressable onPress={() => openOp('remove')} disabled={selected.size === 0}
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                  padding: 10, borderRadius: 12, backgroundColor: selected.size > 0 ? '#DC2626' : `${c.text}10` }}>
                <TrendingDown size={14} color={selected.size > 0 ? '#fff' : `${c.text}40`} />
                <Text style={{ fontSize: 12, fontWeight: '700', color: selected.size > 0 ? '#fff' : `${c.text}40` }}>Remove</Text>
              </Pressable>
            </View>
            {loading && <ActivityIndicator size="large" color={c.primary} style={{ marginTop: 40 }} />}
          </View>
          </>
        }
        renderItem={({ item: doc }) => {
          const isSelected = selected.has(doc.id);
          return (
            <Pressable onPress={() => toggleSelect(doc.id)} style={{ paddingHorizontal: layout.screenPx, marginBottom: 8 }}>
              <NeuCard style={{ padding: 14, borderWidth: isSelected ? 1.5 : 0, borderColor: isSelected ? c.primary : 'transparent' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  {isSelected
                    ? <CheckSquare size={20} color={c.primary} />
                    : <Square size={20} color={`${c.text}30`} />}
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>{doc.full_name}</Text>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>{getPublicEmail(doc) ?? '—'}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ fontSize: 16, fontWeight: '800', color: '#16A34A' }}>
                      {doc.credits?.remaining ?? 0}
                    </Text>
                    <Text style={{ fontSize: 10, color: c.text, opacity: 0.4 }}>balance</Text>
                  </View>
                </View>
              </NeuCard>
            </Pressable>
          );
        }}
        ListEmptyComponent={!loading ? (
          <View style={{ padding: 60, alignItems: 'center' }}>
            <Users size={40} color={c.primary} opacity={0.2} />
            <Text style={{ color: c.text, opacity: 0.4, marginTop: 16 }}>No doctors found</Text>
          </View>
        ) : null}
      />

      {/* Operation Modal */}
      <ResponsiveModal visible={opModal} onClose={() => setOpModal(false)}
        title={opType === 'add' ? `Add Credits to ${selected.size} Doctors` : `Remove Credits from ${selected.size} Doctors`}>
        <KeyboardAvoidingView behavior={process.env.EXPO_OS === 'ios' ? 'padding' : 'height'}>
          <Text style={{ fontSize: 13, color: c.text, opacity: 0.5, marginBottom: 16 }}>
            {opType === 'add'
              ? 'The same amount will be added to all selected doctors.'
              : 'Credits will be revoked via a reverse transaction. History is preserved.'}
          </Text>
          <Text style={{ fontSize: 12, fontWeight: '600', color: c.text, marginBottom: 6 }}>Amount *</Text>
          <TextInput value={amount} onChangeText={setAmount} placeholder="e.g. 50"
            keyboardType="numeric" placeholderTextColor={`${c.text}40`} style={[inp, { minWidth: 0 }]} />
          {opType === 'remove' && (
            <>
              <Text style={{ fontSize: 12, fontWeight: '600', color: c.text, marginBottom: 6 }}>Reason *</Text>
              <TextInput value={reason} onChangeText={setReason} placeholder="Required for removal..."
                placeholderTextColor={`${c.text}40`} style={[inp, { minWidth: 0 }]} />
            </>
          )}
          <Text style={{ fontSize: 12, fontWeight: '600', color: c.text, marginBottom: 6 }}>Notes (optional)</Text>
          <TextInput value={notes} onChangeText={setNotes} placeholder="Internal notes..."
            placeholderTextColor={`${c.text}40`} style={{ ...(inp as object), minWidth: 0, marginBottom: 20 }} />
          <NeuButton
            label={submitting ? 'Processing...' : (opType === 'add' ? 'Add Credits' : 'Remove Credits')}
            onPress={submit}
            disabled={submitting}
            style={{ backgroundColor: opType === 'add' ? '#16A34A' : '#DC2626' }}
          />
          <NeuButton label="Cancel" onPress={() => setOpModal(false)} variant="secondary" style={{ marginTop: 8 }} />
        </KeyboardAvoidingView>
      </ResponsiveModal>

      {/* Results Modal */}
      <ResponsiveModal visible={resultModal} onClose={() => setResultModal(false)} title="Bulk Operation Results">
        <NeuCard style={{ padding: 14, flexDirection: 'row', justifyContent: 'space-around', marginBottom: 16 }}>
          <View style={{ alignItems: 'center' }}>
            <Text style={{ fontSize: 24, fontWeight: '800', color: '#16A34A' }}>{successCount}</Text>
            <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>Succeeded</Text>
          </View>
          <View style={{ alignItems: 'center' }}>
            <Text style={{ fontSize: 24, fontWeight: '800', color: '#DC2626' }}>{errorCount}</Text>
            <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>Failed</Text>
          </View>
        </NeuCard>
        <ScrollView style={{ maxHeight: 300 }}>
          {results.map((r, i) => {
            const doc = doctors.find(d => d.id === r.doctor_id);
            return (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8,
                borderBottomWidth: 1, borderBottomColor: `${c.text}0A`, gap: 10 }}>
                {r.error
                  ? <AlertCircle size={14} color="#DC2626" />
                  : <CheckSquare size={14} color="#16A34A" />}
                <Text style={{ flex: 1, fontSize: 12, color: c.text }}>
                  {doc?.full_name ?? r.doctor_id}
                </Text>
                {r.error && <Text style={{ fontSize: 11, color: '#DC2626' }}>{r.error}</Text>}
              </View>
            );
          })}
        </ScrollView>
        <NeuButton label="Done" onPress={() => setResultModal(false)} style={{ marginTop: 16 }} />
      </ResponsiveModal>
    </View>
  );
}
