import { useCallback, useState } from 'react';
import { View, Text, TextInput, useColorScheme, RefreshControl, ActivityIndicator } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { CreditCard, TrendingUp, TrendingDown, Clock, Ticket } from 'lucide-react-native';
import { useCreditBalance } from '@/lib/useCreditBalance';
import { getCreditHistory, invalidateCreditCache, type CreditTransaction } from '@/lib/creditService';
import { redeemCreditCode } from '@/lib/api';
import { friendlyError } from '@/lib/validation';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout, safeBottom, mutedTextStyle } from '@/lib/neu';
import { PageHeader } from '@/components/PageHeader';
import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScrollView';
import { useTranslation } from '@/lib/i18n';
import { formatLocalizedDate } from '@/lib/i18n/date';

export default function DoctorCredits() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const { showToast } = useToast();
  // Every visible string on this screen goes through the shared dictionaries —
  // it used to be entirely hardcoded English even in Arabic mode.
  const { t, locale } = useTranslation();

  // ── Single source of truth: creditService via hook ──────────────────────────
  const { balance: credits, loading: balLoading, refresh: refreshBalance } = useCreditBalance();
  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const [txLoading, setTxLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // ── Redeem Code ──────────────────────────────────────────────────────────────
  const [redeemModal, setRedeemModal] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [redeeming, setRedeeming] = useState(false);

  const handleRedeem = async () => {
    const code = codeInput.trim();
    if (code === '') {
      showToast({ type: 'error', message: t('credits.enterCodeError') });
      return;
    }
    setRedeeming(true);
    try {
      // Backend is the sole authority: it validates the code, adds the
      // credits to the existing balance atomically and returns the amount.
      const res = await redeemCreditCode(code);
      const amount = Number((res as { amount?: number })?.amount ?? 0);
      showToast({ type: 'success', message: t('credits.addedSuccess', { amount }) });
      setRedeemModal(false);
      setCodeInput('');
      // Refresh authoritative balance + history from the backend (never optimistic).
      invalidateCreditCache();
      await Promise.all([refreshBalance(), loadHistory()]);
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, t('credits.redeemFailed')) });
    }
    setRedeeming(false);
  };

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
    <KeyboardAwareScrollView style={{ flex: 1, backgroundColor: c.base }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />} contentContainerStyle={{ paddingBottom: safeBottom(layout.insets.bottom) }}>
      <PageHeader title={t('credits.title')} subtitle={t('credits.subtitle')} accentColor={c.primary} />

      <View style={{ paddingHorizontal: layout.screenPx }}>

        {/* Redeem Code entry point */}
        <NeuCard
          style={{ marginBottom: 16, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }}
        >
          <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: `${c.primary}15`,
            alignItems: 'center', justifyContent: 'center' }}>
            <Ticket size={18} color={c.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{t('credits.redeemTitle')}</Text>
            <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.5) }}>{t('credits.redeemHint')}</Text>
          </View>
          <NeuButton label={t('credits.enterCode')} onPress={() => setRedeemModal(true)} style={{ minWidth: 110 }} />
        </NeuCard>

        {loading ? <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} /> : (
          <>
            {/* Credit Balance Card */}
            <NeuCard radius={22} style={{ padding: 24, marginBottom: 20, alignItems: 'center' }}>
              <CreditCard size={40} color={c.primary} style={{ marginBottom: 12 }} />
              <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.5), textTransform: 'uppercase', letterSpacing: 0.8 }}>{t('credits.available')}</Text>
              <Text style={{ fontSize: 52, fontWeight: '900', color: c.primary, marginVertical: 4 }}>
                {credits?.remaining ?? 0}
              </Text>
              <View style={{ flexDirection: 'row', gap: 24, marginTop: 8 }}>
                <View style={{ alignItems: 'center' }}>
                  <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.45), textTransform: 'uppercase', letterSpacing: 0.6 }}>{t('credits.totalAllocated')}</Text>
                  <Text style={{ fontSize: 18, fontWeight: '700', color: c.text, marginTop: 2 }}>{credits?.total_allocated ?? 0}</Text>
                </View>
                <View style={{ width: 1, backgroundColor: `${c.text}15` }} />
                <View style={{ alignItems: 'center' }}>
                  <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.45), textTransform: 'uppercase', letterSpacing: 0.6 }}>{t('credits.used')}</Text>
                  <Text style={{ fontSize: 18, fontWeight: '700', color: '#D97706', marginTop: 2 }}>{credits?.used ?? 0}</Text>
                </View>
              </View>
            </NeuCard>

            {/* Transactions */}
            <Text style={{ fontSize: 17, fontWeight: '700', color: c.text, marginBottom: 14 }}>{t('credits.history')}</Text>
            {transactions.length === 0 ? (
              <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                <Text style={{ ...mutedTextStyle(c, 0.35), fontSize: 15 }}>{t('credits.noTransactions')}</Text>
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
                  <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }}>{tx.notes ?? (tx.transaction_type === 'consumption' ? t('credits.creditsUsed') : t('credits.creditsAdded'))}</Text>
                  {tx.course_title && <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.5), marginTop: 1 }}>{t('credits.coursePrefix', { name: tx.course_title })}</Text>}
                  {tx.student_name && <Text style={{ fontSize: 12, ...mutedTextStyle(c, 0.5) }}>{t('credits.studentPrefix', { name: tx.student_name })}</Text>}
                  {tx.balance_before != null && tx.balance_after != null && (
                    <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.4), marginTop: 1 }}>
                      {t('credits.balanceFlow', { before: tx.balance_before, after: tx.balance_after })}
                    </Text>
                  )}
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 3, gap: 3 }}>
                    <Clock size={11} color={c.text} opacity={0.35} />
                    <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.35) }}>{formatLocalizedDate(tx.created_at, locale, { style: 'medium' })}</Text>
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

      {/* Redeem Code modal */}
      <ResponsiveModal
        visible={redeemModal} onClose={() => setRedeemModal(false)}
        title={t('credits.modalTitle')}
        subtitle={t('credits.modalSubtitle')}
        icon={<Ticket size={18} color={c.primary} />}
        footer={
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <NeuButton label={t('common.cancel')} onPress={() => setRedeemModal(false)} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label={t('credits.redeem')} onPress={handleRedeem} loading={redeeming} disabled={redeeming} style={{ flex: 1 }} />
          </View>
        }
      >
        <TextInput
          value={codeInput} onChangeText={setCodeInput}
          placeholder="MED-XXXX-XXXX-XXXX" placeholderTextColor={`${c.text}55`}
          autoCapitalize="characters" autoCorrect={false}
          style={{ backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
            shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.55, shadowRadius: 5,
            fontSize: 16, fontWeight: '700', letterSpacing: 1, color: c.text, textAlign: 'center' }}
        />
        <Text style={{ fontSize: 11, ...mutedTextStyle(c, 0.4), marginTop: 10, textAlign: 'center' }}>
          {t('credits.modalNote')}
        </Text>
      </ResponsiveModal>
    </KeyboardAwareScrollView>
  );
}
