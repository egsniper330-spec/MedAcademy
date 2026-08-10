import { useCallback, useState } from 'react';
import { View, Text, ScrollView, useColorScheme, RefreshControl, ActivityIndicator } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { CreditCard, TrendingUp, TrendingDown, Clock } from 'lucide-react-native';
import { useCreditBalance } from '@/lib/useCreditBalance';
import { getCreditHistory, type CreditTransaction } from '@/lib/creditService';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, useLayout } from '@/lib/neu';
import { PageHeader } from '@/components/PageHeader';

export default function DoctorCredits() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  // ── Single source of truth: creditService via hook ──────────────────────────
  const { balance: credits, loading: balLoading, refresh: refreshBalance } = useCreditBalance();
  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const [txLoading, setTxLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadHistory = useCallback(async () => {
    setTxLoading(true);
    try {
      const tx = await getCreditHistory(200);
      setTransactions(tx);
    } catch { /* keep last known */ }
    setTxLoading(false);
  }, []);

  // useCreditBalance already calls useFocusEffect internally; mirror for history
  useFocusEffect(useCallback(() => { loadHistory(); }, [loadHistory]));

  const loading = balLoading || txLoading;

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refreshBalance(), loadHistory()]);
    setRefreshing(false);
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }} contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}>
      <View style={{ padding: layout.screenPx }}>
        <PageHeader title="My Credits" subtitle="Credit balance & history" accentColor={c.primary} />

        {loading ? <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} /> : (
          <>
            {/* Credit Balance Card */}
            <NeuCard radius={22} style={{ padding: 24, marginBottom: 20, alignItems: 'center' }}>
              <CreditCard size={40} color={c.primary} style={{ marginBottom: 12 }} />
              <Text style={{ fontSize: 13, color: c.text, opacity: 0.5, textTransform: 'uppercase', letterSpacing: 0.8 }}>Available Credits</Text>
              <Text style={{ fontSize: 52, fontWeight: '900', color: c.primary, marginVertical: 4 }}>
                {credits?.remaining ?? 0}
              </Text>
              <View style={{ flexDirection: 'row', gap: 24, marginTop: 8 }}>
                <View style={{ alignItems: 'center' }}>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.45, textTransform: 'uppercase', letterSpacing: 0.6 }}>Total Allocated</Text>
                  <Text style={{ fontSize: 18, fontWeight: '700', color: c.text, marginTop: 2 }}>{credits?.total_allocated ?? 0}</Text>
                </View>
                <View style={{ width: 1, backgroundColor: `${c.text}15` }} />
                <View style={{ alignItems: 'center' }}>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.45, textTransform: 'uppercase', letterSpacing: 0.6 }}>Used</Text>
                  <Text style={{ fontSize: 18, fontWeight: '700', color: '#D97706', marginTop: 2 }}>{credits?.used ?? 0}</Text>
                </View>
              </View>
            </NeuCard>

            {/* Transactions */}
            <Text style={{ fontSize: 17, fontWeight: '700', color: c.text, marginBottom: 14 }}>Transaction History</Text>
            {transactions.length === 0 ? (
              <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                <Text style={{ color: c.text, opacity: 0.35, fontSize: 15 }}>No transactions yet</Text>
              </View>
            ) : transactions.map((tx) => {
              // Determine sign from actual balance change; fall back to transaction_type
              const delta =
                tx.balance_before != null && tx.balance_after != null
                  ? tx.balance_after - tx.balance_before
                  : tx.transaction_type === 'consumption' ? -tx.amount : tx.amount;
              const isCredit = delta >= 0;
              const txColor = isCredit ? '#16A34A' : '#DC2626';
              const sign    = isCredit ? '+' : '-';
              const TxIcon  = isCredit ? TrendingUp : TrendingDown;
              return (
              <NeuCard key={tx.id} style={{ marginBottom: 10, padding: 14, flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: `${txColor}20`, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                  <TxIcon size={18} color={txColor} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }}>{tx.notes ?? (tx.transaction_type === 'consumption' ? 'Credits Used' : 'Credits Added')}</Text>
                  {tx.course_title && <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 1 }}>Course: {tx.course_title}</Text>}
                  {tx.student_name && <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>Student: {tx.student_name}</Text>}
                  {tx.balance_before != null && tx.balance_after != null && (
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, marginTop: 1 }}>
                      Balance: {tx.balance_before} → {tx.balance_after}
                    </Text>
                  )}
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 3 }}>
                    <Clock size={11} color={c.text} opacity={0.35} />
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.35, marginLeft: 3 }}>{new Date(tx.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</Text>
                  </View>
                </View>
                <Text style={{ fontSize: 18, fontWeight: '800', color: txColor }}>
                  {sign}{Math.abs(tx.amount)}
                </Text>
              </NeuCard>
            );
            })}
          </>
        )}
      </View>
    </ScrollView>
  );
}
