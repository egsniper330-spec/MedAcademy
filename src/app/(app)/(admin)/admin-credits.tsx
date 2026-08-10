/**
 * Admin Credits — Allocate / refund credits to doctors.
 * Accessible to admins and super admins via the drawer menu.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TextInput, ActivityIndicator,
  RefreshControl, useColorScheme, KeyboardAvoidingView,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { CreditCard, TrendingUp, TrendingDown, RefreshCw } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import {
  getDoctors, allocateCredits, refundCredits, getCreditTransactions,
} from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout } from '@/lib/neu';
import { validateRequired, friendlyError } from '@/lib/validation';
import { useDebounce } from '@/lib/useDebounce';
import { getPublicEmail } from '@/lib/api';

export default function AdminCreditsScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const { showToast } = useToast();

  const [doctors, setDoctors] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);

  // Allocate modal
  const [allocModal, setAllocModal] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<any>(null);
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  // Separate loading states per button
  const [allocatingType, setAllocatingType] = useState<'allocate' | 'refund' | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  // Transaction history modal
  const [txModal, setTxModal] = useState(false);
  const [txDoctor, setTxDoctor] = useState<any>(null);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [txLoading, setTxLoading] = useState(false);

  const load = useCallback(async () => {
    try { setDoctors(await getDoctors()); } catch (_) {}
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const openAllocate = (doc: any) => {
    setSelectedDoc(doc); setAmount(''); setNotes('');
    setIsDirty(false); setAllocModal(true);
  };
  const closeAllocate = () => { setAllocModal(false); setIsDirty(false); };

  const handleAllocate = async (type: 'allocate' | 'refund') => {
    const err = validateRequired(amount, 'Amount');
    if (err || isNaN(Number(amount)) || Number(amount) <= 0) {
      showToast({ type: 'error', message: 'Enter a valid positive amount.' }); return;
    }
    setAllocatingType(type);
    try {
      if (type === 'allocate') {
        await allocateCredits(selectedDoc.id, Number(amount), notes.trim() || '');
        showToast({ type: 'success', message: `${amount} credits added to ${selectedDoc.full_name}.` });
      } else {
        await refundCredits(selectedDoc.id, Number(amount), notes.trim() || '');
        showToast({ type: 'success', message: `${amount} credits refunded from ${selectedDoc.full_name}.` });
      }
      setIsDirty(false);
      closeAllocate();
      await load();
      if (txModal && txDoctor?.id === selectedDoc.id) {
        setTxLoading(true);
        try { setTransactions(await getCreditTransactions(selectedDoc.id)); } catch (_) { }
        setTxLoading(false);
      }
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Operation failed.') });
    }
    setAllocatingType(null);
  };

  const openTransactions = async (doc: any) => {
    setTxDoctor(doc); setTxModal(true); setTxLoading(true);
    try { setTransactions(await getCreditTransactions(doc.id)); } catch (_) { setTransactions([]); }
    setTxLoading(false);
  };

  const filtered = doctors.filter(d =>
    d.full_name?.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
    d.email?.toLowerCase().includes(debouncedSearch.toLowerCase())
  );

  const inp = {
    backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.55, shadowRadius: 5,
    fontSize: 14, color: c.text, marginBottom: 14,
  };

  return (
    <KeyboardAvoidingView behavior={process.env.EXPO_OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}>
        <View style={{ padding: layout.screenPx }}>
          <PageHeader title="Credit Management" subtitle="Add & remove doctor credits" accentColor="#7C3AED" />

          {/* Search */}
          <TextInput
            value={search} onChangeText={setSearch}
            placeholder="Search doctors..."
            placeholderTextColor={`${c.text}55`}
            style={{ ...inp, minWidth: 0 }}
          />

          {/* Loading */}
          {loading && <ActivityIndicator size="large" color={c.primary} style={{ marginTop: 40 }} />}

          {/* Doctor list */}
          {filtered.map(doc => (
            <NeuCard key={doc.id} style={{ marginBottom: 12, padding: 16 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
                <View style={{ width: 42, height: 42, borderRadius: 13, backgroundColor: '#16A34A18', alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
                  <CreditCard size={18} color="#16A34A" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>{doc.full_name}</Text>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>{getPublicEmail(doc) ?? '—'}</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={{ fontSize: 20, fontWeight: '800', color: '#16A34A' }}>{doc.credits_balance ?? 0}</Text>
                  <Text style={{ fontSize: 10, color: c.text, opacity: 0.4 }}>credits</Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: 10 }}>
              <NeuButton label="Add Credits" onPress={() => openAllocate(doc)} style={{ flex: 1 }} />
                <NeuButton label="History" onPress={() => openTransactions(doc)} variant="secondary" style={{ flex: 1 }} />
              </View>
            </NeuCard>
          ))}

          {!loading && filtered.length === 0 && (
            <NeuCard style={{ padding: 40, alignItems: 'center' }}>
              <CreditCard size={36} color={c.primary} opacity={0.25} />
              <Text style={{ color: c.text, opacity: 0.4, marginTop: 16 }}>No doctors found</Text>
            </NeuCard>
          )}
        </View>
      </ScrollView>

      {/* ── Allocate / Refund Modal ── */}
      <ResponsiveModal
        visible={allocModal} onClose={closeAllocate} isDirty={isDirty}
        title={`Credits — ${selectedDoc?.full_name ?? ''}`}
        footer={
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <NeuButton label="Cancel" onPress={closeAllocate} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label="Refund" onPress={() => handleAllocate('refund')} loading={allocatingType === 'refund'} disabled={allocatingType !== null} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label="Add Credits" onPress={() => handleAllocate('allocate')} loading={allocatingType === 'allocate'} disabled={allocatingType !== null} style={{ flex: 1 }} />
          </View>
        }
      >
        <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>Amount</Text>
        <TextInput
          value={amount} onChangeText={v => { setAmount(v); setIsDirty(true); }}
          placeholder="e.g. 100" placeholderTextColor={`${c.text}55`}
          keyboardType="numeric" style={{ ...inp, minWidth: 0 }}
        />
        <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>Notes (optional)</Text>
        <TextInput
          value={notes} onChangeText={v => { setNotes(v); setIsDirty(true); }}
          placeholder="Reason for allocation..." placeholderTextColor={`${c.text}55`}
          multiline style={{ ...inp, minWidth: 0, minHeight: 80, textAlignVertical: 'top' }}
        />
      </ResponsiveModal>

      {/* ── Transaction History Modal ── */}
      <ResponsiveModal
        visible={txModal} onClose={() => setTxModal(false)}
        title={`History — ${txDoctor?.full_name ?? ''}`}
      >
        {txLoading && <ActivityIndicator size="large" color={c.primary} style={{ marginVertical: 40 }} />}
        {!txLoading && transactions.length === 0 && (
          <View style={{ padding: 40, alignItems: 'center' }}>
            <Text style={{ color: c.text, opacity: 0.4 }}>No transactions found</Text>
          </View>
        )}
        {transactions.map((tx, i) => {
          // Determine sign from actual balance change; fall back to type classification
          const delta =
            tx.balance_before != null && tx.balance_after != null
              ? tx.balance_after - tx.balance_before
              : null;
          const POSITIVE_TYPES = ['allocation', 'grant_admin', 'grant_super_admin', 'restoration', 'adjustment', 'transfer'];
          const isAlloc = delta != null ? delta >= 0 : POSITIVE_TYPES.includes(tx.transaction_type);
          const TxIcon  = isAlloc ? TrendingUp : TrendingDown;
          const txCol   = isAlloc ? '#16A34A' : '#DC2626';
          return (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: `${c.text}0A` }}>
              <View style={{ width: 36, height: 36, borderRadius: 11, backgroundColor: `${txCol}18`, alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
                <TxIcon size={16} color={txCol} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, textTransform: 'capitalize' }}>{tx.transaction_type}</Text>
                {tx.notes && <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>{tx.notes}</Text>}
                <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{new Date(tx.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })}</Text>
              </View>
              <Text style={{ fontSize: 16, fontWeight: '800', color: txCol }}>
                {isAlloc ? '+' : '-'}{Math.abs(tx.amount)}
              </Text>
            </View>
          );
        })}
      </ResponsiveModal>
    </KeyboardAvoidingView>
  );
}
