/**
 * Revenue Dashboard — Super Admin only
 * Revenue from credits & activation codes; pricing settings.
 * Currency is loaded from platform_currency system_config (default: EGP / ج.م).
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TextInput, ActivityIndicator,
  RefreshControl, useColorScheme,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { TrendingUp, Edit2, Check, Coins, RotateCcw, Clock, AlertTriangle } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import {
  getRevenueStats, updatePricingSettings,
  getPlatformEarningsStats, resetPlatformEarnings,
  type PlatformEarningsStats,
} from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { ResponsiveModal } from '@/components/ResponsiveModal';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout } from '@/lib/neu';
import { useCurrencyConfig } from '@/lib/currency';
import { friendlyError } from '@/lib/validation';
import { useProfileStore } from '@/lib/store';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export default function RevenueDashboard() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const { fmtLarge, fmt, config: currencyCfg } = useCurrencyConfig();
  const { showToast } = useToast();
  const { profile } = useProfileStore();

  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pricingModal, setPricingModal] = useState(false);
  const [creditPrice, setCreditPrice] = useState('10');
  const [codePrice, setCodePrice] = useState('25');
  const [saving, setSaving] = useState(false);

  // Platform Earnings Reset state
  const [earningsStats, setEarningsStats] = useState<PlatformEarningsStats | null>(null);
  const [earningsLoading, setEarningsLoading] = useState(true);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await getRevenueStats();
      setStats(data);
      setCreditPrice(String(data.creditPrice));
      setCodePrice(String(data.activationCodePrice));
    } catch (_) {}
    setLoading(false);
  }, []);

  const loadEarnings = useCallback(async () => {
    setEarningsLoading(true);
    try {
      setEarningsStats(await getPlatformEarningsStats());
    } catch (_) {}
    setEarningsLoading(false);
  }, []);

  useFocusEffect(useCallback(() => {
    setLoading(true);
    load();
    loadEarnings();
  }, [load, loadEarnings]));

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([load(), loadEarnings()]);
    setRefreshing(false);
  };

  const handleSavePricing = async () => {
    setSaving(true);
    try {
      await updatePricingSettings(Number(creditPrice), Number(codePrice), currencyCfg.code);
      await load();
      setPricingModal(false);
      showToast({ type: 'success', message: 'Pricing settings saved.' });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to save pricing settings.') });
    }
    setSaving(false);
  };

  const handleConfirmReset = async () => {
    if (!earningsStats || !profile?.email) return;
    setResetting(true);
    try {
      await resetPlatformEarnings(earningsStats.earningsSinceReset, profile.email);
      setResetDialogOpen(false);
      showToast({ type: 'success', message: 'Platform earnings counter has been reset.' });
      await loadEarnings();
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to reset earnings.') });
    }
    setResetting(false);
  };

  const inp = {
    backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.55, shadowRadius: 5,
    fontSize: 15, color: c.text,
  };

  const formatResetDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }} contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}>
      <View style={{ padding: layout.screenPx }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, marginTop: 8 }}>
          <PageHeader title="Revenue Dashboard" subtitle={`Platform earnings · ${currencyCfg.code}`} accentColor="#16A34A" />
          <NeuButton label="Pricing" icon={<Edit2 size={14} color={c.primary} />} onPress={() => setPricingModal(true)} variant="secondary" style={{ paddingHorizontal: 16 }} />
        </View>

        {loading ? <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} /> : stats && (
          <>
            {/* Revenue Overview */}
            <NeuCard style={{ marginBottom: 16, padding: 22 }}>
              <Text style={{ fontSize: 13, color: c.text, opacity: 0.5, marginBottom: 6 }}>Total Revenue</Text>
              <Text style={{ fontSize: 38, fontWeight: '900', color: '#16A34A' }}>{fmtLarge(stats.totalRevenue)}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}>
                <TrendingUp size={16} color="#16A34A" />
                <Text style={{ fontSize: 13, color: '#16A34A', fontWeight: '600' }}>All time</Text>
              </View>
            </NeuCard>

            <View style={{ flexDirection: 'row', gap: 12, marginBottom: 16 }}>
              <NeuCard style={{ flex: 1, padding: 18, alignItems: 'center' }}>
                <Text style={{ fontSize: 11, color: c.text, opacity: 0.5, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.8 }}>Monthly</Text>
                <Text style={{ fontSize: 24, fontWeight: '800', color: c.primary }}>{fmtLarge(stats.monthlyRevenue)}</Text>
              </NeuCard>
              <NeuCard style={{ flex: 1, padding: 18, alignItems: 'center' }}>
                <Text style={{ fontSize: 11, color: c.text, opacity: 0.5, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.8 }}>Yearly</Text>
                <Text style={{ fontSize: 24, fontWeight: '800', color: '#7C3AED' }}>{fmtLarge(stats.yearlyRevenue)}</Text>
              </NeuCard>
            </View>

            {/* Pricing Info */}
            <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 14 }}>Pricing Configuration</Text>
            {[
              { label: 'Credit Price', value: fmt(stats.creditPrice), color: c.primary, desc: 'Per credit allocated to doctors' },
              { label: 'Activation Code Price', value: fmt(stats.activationCodePrice), color: '#7C3AED', desc: 'Per activation code created' },
            ].map(item => (
              <NeuCard key={item.label} style={{ marginBottom: 12, padding: 16, flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: `${item.color}18`, alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
                  <Coins size={20} color={item.color} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{item.label}</Text>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>{item.desc}</Text>
                </View>
                <Text style={{ fontSize: 18, fontWeight: '800', color: item.color }}>{item.value}</Text>
              </NeuCard>
            ))}

            <NeuCard style={{ marginTop: 8, padding: 16 }}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, marginBottom: 8 }}>Revenue Formula</Text>
              <Text style={{ fontSize: 13, color: c.text, opacity: 0.6, lineHeight: 22 }}>
                {'Total Revenue = Credits Sold × '}{fmt(stats.creditPrice)}{'\n\nRevenue is calculated based on credits allocated to doctors and activation codes issued.'}
              </Text>
            </NeuCard>
          </>
        )}

        {/* ── Platform Earnings Management ──────────────────────────────── */}
        <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginTop: 28, marginBottom: 14 }}>
          Platform Earnings Management
        </Text>

        {earningsLoading ? (
          <ActivityIndicator color={c.primary} style={{ marginVertical: 20 }} />
        ) : earningsStats && (
          <>
            {/* Earnings since last reset — the "counter" */}
            <NeuCard style={{ marginBottom: 12, padding: 22 }}>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>
                Earnings Since Last Reset
              </Text>
              <Text style={{ fontSize: 36, fontWeight: '900', color: '#16A34A' }}>
                {fmtLarge(earningsStats.earningsSinceReset)}
              </Text>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginTop: 6 }}>
                This is the current earnings counter value shown on the dashboard.
              </Text>
            </NeuCard>

            {/* All-time total */}
            <NeuCard style={{ marginBottom: 12, padding: 16, flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
                <TrendingUp size={20} color={c.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, textTransform: 'uppercase', letterSpacing: 0.7 }}>Total All-Time Earnings</Text>
                <Text style={{ fontSize: 20, fontWeight: '800', color: c.text, marginTop: 2 }}>
                  {fmtLarge(earningsStats.totalEarningsAllTime)}
                </Text>
              </View>
            </NeuCard>

            {/* Last reset date */}
            <NeuCard style={{ marginBottom: 20, padding: 16, flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: '#D9770618', alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
                <Clock size={20} color="#D97706" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, textTransform: 'uppercase', letterSpacing: 0.7 }}>Last Reset</Text>
                {earningsStats.lastReset ? (
                  <>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, marginTop: 2 }}>
                      {formatResetDate(earningsStats.lastReset.reset_at)}
                    </Text>
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginTop: 2 }}>
                      By {earningsStats.lastReset.reset_by_email} · Earnings before: {fmtLarge(earningsStats.lastReset.earnings_before)}
                    </Text>
                  </>
                ) : (
                  <Text style={{ fontSize: 14, color: c.text, opacity: 0.45, marginTop: 2 }}>Never reset</Text>
                )}
              </View>
            </NeuCard>

            {/* Reset button */}
            <NeuButton
              label="Reset Earnings"
              icon={<RotateCcw size={16} color="#fff" />}
              onPress={() => setResetDialogOpen(true)}
              style={{ backgroundColor: '#DC2626', borderRadius: 14, paddingVertical: 16, marginBottom: 8 }}
              textStyle={{ color: '#fff', fontWeight: '800', fontSize: 15 }}
            />
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.4, textAlign: 'center', marginBottom: 24 }}>
              Resets the earnings counter only. No financial records are deleted.
            </Text>
          </>
        )}
      </View>

      {/* Pricing modal */}
      <ResponsiveModal
        visible={pricingModal}
        onClose={() => setPricingModal(false)}
        title="Update Pricing"
        footer={
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <NeuButton label="Cancel" onPress={() => setPricingModal(false)} variant="secondary" style={{ flex: 1 }} />
            <NeuButton label="Save" icon={<Check size={16} color="#fff" />} onPress={handleSavePricing} loading={saving} style={{ flex: 1 }} />
          </View>
        }
      >
        <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase' }}>
          Credit Price ({currencyCfg.code})
        </Text>
        <TextInput value={creditPrice} onChangeText={setCreditPrice} style={{ ...inp, minWidth: 0, marginBottom: 16 }} keyboardType="decimal-pad" />
        <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase' }}>
          Activation Code Price ({currencyCfg.code})
        </Text>
        <TextInput value={codePrice} onChangeText={setCodePrice} style={{ ...inp, minWidth: 0 }} keyboardType="decimal-pad" />
      </ResponsiveModal>

      {/* Reset confirmation dialog */}
      <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <AlertTriangle size={22} color="#DC2626" />
              <AlertDialogTitle>Reset Platform Earnings?</AlertDialogTitle>
            </View>
            <AlertDialogDescription>
              {`This action will permanently reset the platform earnings counter. This cannot be undone.\n\nCurrent earnings counter: ${fmtLarge(earningsStats?.earningsSinceReset ?? 0)}\n\nAll historical payment, subscription, purchase, and transaction records will be preserved. Only the earnings statistics counter will be reset to zero.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onPress={() => setResetDialogOpen(false)}>
              <Text>Cancel</Text>
            </AlertDialogCancel>
            <AlertDialogAction
              onPress={handleConfirmReset}
              disabled={resetting}
              style={{ backgroundColor: '#DC2626' }}
            >
              <Text style={{ color: '#fff', fontWeight: '700' }}>
                {resetting ? 'Resetting…' : 'Reset Earnings'}
              </Text>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ScrollView>
  );
}
