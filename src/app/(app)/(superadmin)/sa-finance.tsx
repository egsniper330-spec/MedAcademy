/**
 * sa-finance.tsx — Super Admin Finance hub
 * ALL finance sub-pages exposed in logical groups.
 * No hidden functionality — every route directly clickable.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, Pressable,
  ActivityIndicator, RefreshControl, useColorScheme,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import {
  DollarSign, TrendingUp, CreditCard, BarChart2,
  AlertTriangle, Hash, UsersRound, FileText, ChevronRight,
  Coins, Download, Stethoscope, Globe, ClipboardList,
} from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { neuColors, neuFlatStyle, neuPressedStyle } from '@/lib/neu';
import { getRevenueStats } from '@/lib/api';
import { useCurrencyConfig } from '@/lib/currency';
import Bell from '@/components/Bell';

// ── Nav item ───────────────────────────────────────────────────────────────
function NavItem({
  icon: Icon, label, description, color, path, badge, isDark, c,
}: {
  icon: React.ElementType; label: string; description: string;
  color: string; path: string; badge?: string; isDark: boolean; c: typeof neuColors.light;
}) {
  const router = useRouter();
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onPress={() => router.push(path as RelativePathString)}
    >
      <View style={[
        pressed ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
        { borderRadius: 16, marginBottom: 10, padding: 15, flexDirection: 'row', alignItems: 'center' },
      ]}>
        <View style={{ width: 44, height: 44, borderRadius: 13, backgroundColor: `${color}1A`, alignItems: 'center', justifyContent: 'center', marginRight: 13 }}>
          <Icon size={20} color={color} />
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{label}</Text>
            {badge && (
              <View style={{ backgroundColor: `${color}22`, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 }}>
                <Text style={{ fontSize: 10, fontWeight: '800', color }}>{badge}</Text>
              </View>
            )}
          </View>
          <Text style={{ fontSize: 12, color: c.text, opacity: 0.48, marginTop: 2 }}>{description}</Text>
        </View>
        <ChevronRight size={15} color={`${c.text}35`} />
      </View>
    </Pressable>
  );
}

function SectionLabel({ title, c }: { title: string; c: typeof neuColors.light }) {
  return (
    <Text style={{ fontSize: 11, fontWeight: '800', color: c.text, opacity: 0.38, textTransform: 'uppercase', letterSpacing: 1.4, marginBottom: 10, marginTop: 18 }}>
      {title}
    </Text>
  );
}

// ── Component ──────────────────────────────────────────────────────────────
export default function SAFinance() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { fmtLarge } = useCurrencyConfig();

  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async () => {
    try { setStats(await getRevenueStats()); } catch (_) {}
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); loadData(); }, [loadData]));
  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
    >
      <View style={{ padding: 20 }}>

        {/* ── Header ──────────────────────────────────────────────────── */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, marginTop: 8 }}>
          <PageHeader title="Finance" subtitle="Revenue, ledger & analytics" accentColor="#16A34A" rightAction={<Bell />} />
        </View>

        {/* ── KPI strip ───────────────────────────────────────────────── */}
        {loading ? (
          <ActivityIndicator color={c.primary} style={{ marginVertical: 20 }} />
        ) : stats && (
          <View style={[neuFlatStyle(isDark), { borderRadius: 18, padding: 20, marginTop: 14, marginBottom: 4 }]}>
            <Text style={{ fontSize: 11, fontWeight: '800', color: c.text, opacity: 0.4, textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 14 }}>
              Revenue Overview
            </Text>
            <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
              {[
                { label: 'All Time', value: fmtLarge(stats.totalRevenue),  color: '#16A34A' },
                { label: 'Monthly',  value: fmtLarge(stats.monthlyRevenue), color: c.primary },
                { label: 'Yearly',   value: fmtLarge(stats.yearlyRevenue),  color: '#7C3AED' },
              ].map(s => (
                <View key={s.label} style={{ alignItems: 'center' }}>
                  <Text style={{ fontSize: 22, fontWeight: '900', color: s.color }}>{s.value}</Text>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.5, marginTop: 3 }}>{s.label}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* ── Platform Revenue ─────────────────────────────────────────── */}
        <SectionLabel title="Platform Revenue" c={c} />
        <NavItem icon={DollarSign}  label="Revenue Dashboard"   description="All-time earnings, pricing & payouts"     color="#16A34A" path="/(app)/(superadmin)/revenue"           badge="LIVE" isDark={isDark} c={c} />
        <NavItem icon={TrendingUp}  label="Revenue Analytics"   description="Revenue trends and breakdowns"            color="#2DA8FF" path="/(app)/(admin)/revenue-analytics"       isDark={isDark} c={c} />
        <NavItem icon={Globe}       label="Currency Settings"   description="Platform default currency configuration"   color="#D97706" path="/(app)/(superadmin)/currency"           isDark={isDark} c={c} />

        {/* ── Credits ──────────────────────────────────────────────────── */}
        <SectionLabel title="Credits" c={c} />
        <NavItem icon={CreditCard}  label="Credits"             description="Manage, history & analytics in one place"  color="#7C3AED" path="/(app)/(superadmin)/sa-credits"          isDark={isDark} c={c} />
        <NavItem icon={UsersRound}  label="Bulk Credits"        description="Mass credit allocation to doctors"         color="#16A34A" path="/(app)/(admin)/bulk-credits"              isDark={isDark} c={c} />

        {/* ── Activation Codes ─────────────────────────────────────────── */}
        <SectionLabel title="Activation Codes" c={c} />
        <NavItem icon={FileText}    label="Codes Manager"       description="All codes: active, used, expired"          color="#D97706" path="/(app)/(admin)/codes"                    isDark={isDark} c={c} />
        <NavItem icon={Hash}        label="Code History"        description="Activation code usage history"             color="#6B7280" path="/(app)/(admin)/code-history"             isDark={isDark} c={c} />


        {/* ── Operations & Alerts ──────────────────────────────────────── */}
        <SectionLabel title="Operations" c={c} />
        <NavItem icon={AlertTriangle} label="Fraud Alerts"      description="Suspicious transactions & anomalies"       color="#DC2626" path="/(app)/(admin)/fraud-alerts"             isDark={isDark} c={c} />
        <NavItem icon={Download}    label="Export Center"       description="Export financial data as CSV"              color="#6B7280" path="/(app)/(admin)/export-panel"              isDark={isDark} c={c} />

        <View style={{ height: 32 }} />
      </View>
    </ScrollView>
  );
}
