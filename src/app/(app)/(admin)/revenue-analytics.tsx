/**
 * Revenue Analytics — full financial dashboard.
 * Revenue from credits and activation codes, per-day/month/year, per-doctor/admin/course.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, ActivityIndicator, RefreshControl,
  useColorScheme, Pressable,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { PageHeader } from '@/components/PageHeader';
import type { RelativePathString } from 'expo-router';
import {
  DollarSign, TrendingUp, Calendar, Award, BookOpen, ArrowRight,
} from 'lucide-react-native';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, useLayout } from '@/lib/neu';
import { getPricingSettings, getCreditLedger, getActivationLedgerStats } from '@/lib/api';

type PricingSettings = {
  creditPrice: { amount: number; currency: string };
  activationCodePrice: { amount: number; currency: string };
};

export default function RevenueAnalyticsScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const router = useRouter();

  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pricing, setPricing]       = useState<PricingSettings | null>(null);
  const [txRows, setTxRows]         = useState<any[]>([]);
  const [codeStats, setCodeStats]   = useState<any>(null);

  const load = useCallback(async () => {
    try {
      const [p, rows, cs] = await Promise.all([
        getPricingSettings(),
        getCreditLedger(),
        getActivationLedgerStats(),
      ]);
      setPricing(p as PricingSettings);
      setTxRows(rows);
      setCodeStats(cs);
    } catch (_) {}
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // Compute derived revenue metrics
  const metrics = (() => {
    if (!pricing || txRows.length === 0) return null;
    const cPrice = pricing.creditPrice.amount;
    const cur    = pricing.creditPrice.currency;

    const now      = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const monthStr = now.toISOString().slice(0, 7);
    const yearStr  = now.getFullYear().toString();

    const addTypes = ['grant_admin', 'grant_super_admin', 'allocation', 'grant_super_admin'];

    const revRows = txRows.filter(t => addTypes.includes(t.transaction_type));

    const totalRevenue   = revRows.reduce((s, t) => s + t.amount * cPrice, 0);
    const todayRevenue   = revRows.filter(t => t.created_at.startsWith(todayStr)).reduce((s, t) => s + t.amount * cPrice, 0);
    const monthRevenue   = revRows.filter(t => t.created_at.startsWith(monthStr)).reduce((s, t) => s + t.amount * cPrice, 0);
    const yearRevenue    = revRows.filter(t => t.created_at.startsWith(yearStr)).reduce((s, t) => s + t.amount * cPrice, 0);

    // Code revenue
    const codeRev = pricing.activationCodePrice.amount;
    const codeTotal = (codeStats?.total ?? 0) * codeRev;

    // Per doctor
    const byDoctor: Record<string, { name: string; revenue: number }> = {};
    for (const t of revRows) {
      if (!byDoctor[t.doctor_id]) byDoctor[t.doctor_id] = { name: t.doctor_name ?? t.doctor_id, revenue: 0 };
      byDoctor[t.doctor_id].revenue += t.amount * cPrice;
    }
    const topDoctors = Object.values(byDoctor).sort((a, b) => b.revenue - a.revenue).slice(0, 5);

    // Per admin
    const byAdmin: Record<string, { name: string; revenue: number }> = {};
    for (const t of revRows) {
      if (!byAdmin[t.performed_by]) byAdmin[t.performed_by] = { name: t.performed_by_name ?? t.performed_by, revenue: 0 };
      byAdmin[t.performed_by].revenue += t.amount * cPrice;
    }
    const topAdmins = Object.values(byAdmin).sort((a, b) => b.revenue - a.revenue).slice(0, 5);

    // Per course
    const byCourse: Record<string, { title: string; revenue: number }> = {};
    for (const t of revRows.filter(r => r.course_id)) {
      if (!byCourse[t.course_id]) byCourse[t.course_id] = { title: t.course_title ?? t.course_id, revenue: 0 };
      byCourse[t.course_id].revenue += t.amount * cPrice;
    }
    const topCourses = Object.values(byCourse).sort((a, b) => b.revenue - a.revenue).slice(0, 5);

    // Monthly chart (last 6 months)
    const monthlyCounts: Record<string, number> = {};
    for (const t of revRows) {
      const mo = t.created_at.slice(0, 7);
      monthlyCounts[mo] = (monthlyCounts[mo] ?? 0) + t.amount * cPrice;
    }
    const months = Object.keys(monthlyCounts).sort().slice(-6);
    const monthlyVals = months.map(m => monthlyCounts[m]);
    const maxMonthly = Math.max(...monthlyVals, 1);

    return { totalRevenue, todayRevenue, monthRevenue, yearRevenue, codeTotal,
      lifetimeRevenue: totalRevenue + codeTotal, cur,
      topDoctors, topAdmins, topCourses, months, monthlyVals, maxMonthly };
  })();

  const fmt = (n: number, cur = 'EGP') => `${cur} ${n.toLocaleString('en-US')}`;

  const KpiCard = ({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) => (
    <NeuCard style={{ flex: 1, padding: 14, minWidth: 140 }}>
      <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: `${color}15`,
        alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}>
        <DollarSign size={16} color={color} />
      </View>
      <Text style={{ fontSize: 22, fontWeight: '900', color }}>{value}</Text>
      <Text style={{ fontSize: 11, color: c.text, opacity: 0.45, marginTop: 3 }}>{label}</Text>
      {sub && <Text style={{ fontSize: 10, color: c.text, opacity: 0.3, marginTop: 1 }}>{sub}</Text>}
    </NeuCard>
  );

  const RankRow = ({ rank, name, value, color }: { rank: number; name: string; value: string; color: string }) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10,
      borderBottomWidth: 1, borderBottomColor: `${c.text}08`, gap: 12 }}>
      <View style={{ width: 28, height: 28, borderRadius: 9, backgroundColor: `${color}15`,
        alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 11, fontWeight: '800', color }}>{rank}</Text>
      </View>
      <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: c.text }}>{name}</Text>
      <Text style={{ fontSize: 14, fontWeight: '800', color }}>{value}</Text>
    </View>
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
    >
      <PageHeader title="Revenue Analytics" subtitle={pricing ? `Credit: ${pricing.creditPrice.currency} ${pricing.creditPrice.amount} · Code: ${pricing.activationCodePrice.amount}` : 'Financial dashboard'} accentColor="#16A34A" />

      <View style={{ paddingHorizontal: layout.screenPx }}>

        {loading && <ActivityIndicator size="large" color={c.primary} style={{ marginVertical: 40 }} />}

        {metrics && (
          <>
            {/* KPI Cards */}
            <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.4, marginBottom: 10 }}>REVENUE OVERVIEW</Text>
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              <KpiCard label="Lifetime Revenue"   value={fmt(metrics.lifetimeRevenue, metrics.cur)} color="#16A34A" />
              <KpiCard label="Revenue from Credits" value={fmt(metrics.totalRevenue, metrics.cur)} color={c.primary} sub="credits only" />
            </View>
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              <KpiCard label="Revenue from Codes" value={fmt(metrics.codeTotal, metrics.cur)} color="#D97706" />
              <KpiCard label="Today"              value={fmt(metrics.todayRevenue, metrics.cur)} color="#2DA8FF" />
            </View>
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
              <KpiCard label="This Month" value={fmt(metrics.monthRevenue, metrics.cur)} color="#7C3AED" />
              <KpiCard label="This Year"  value={fmt(metrics.yearRevenue, metrics.cur)} color="#DC2626" />
            </View>

            {/* Monthly Revenue Chart */}
            {metrics.months.length > 0 && (
              <>
                <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.4, marginBottom: 10 }}>
                  MONTHLY REVENUE (LAST 6 MONTHS)
                </Text>
                <NeuCard style={{ padding: 16, marginBottom: 24 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 100 }}>
                    {metrics.monthlyVals.map((v, i) => (
                      <View key={metrics.months[i]} style={{ flex: 1, alignItems: 'center' }}>
                        <Text style={{ fontSize: 8, color: c.text, opacity: 0.4, marginBottom: 3 }}>
                          {fmt(v, '').trim()}
                        </Text>
                        <View style={{
                          width: '80%', height: Math.max(6, (v / metrics.maxMonthly) * 80),
                          backgroundColor: '#16A34A', borderRadius: 4, opacity: 0.75,
                        }} />
                      </View>
                    ))}
                  </View>
                  <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
                    {metrics.months.map(m => (
                      <Text key={m} style={{ flex: 1, fontSize: 8, color: c.text, opacity: 0.4, textAlign: 'center' }}>
                        {m.slice(5)}
                      </Text>
                    ))}
                  </View>
                </NeuCard>
              </>
            )}

            {/* Top Doctors by Revenue */}
            {metrics.topDoctors.length > 0 && (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <Award size={16} color="#7C3AED" />
                  <Text style={{ flex: 1, fontSize: 15, fontWeight: '800', color: c.text }}>Top Doctors by Revenue</Text>
                  <Pressable onPress={() => router.push('/(app)/(admin)/admin-credits' as RelativePathString)}>
                    <ArrowRight size={14} color={c.primary} />
                  </Pressable>
                </View>
                <NeuCard style={{ padding: 14, marginBottom: 20 }}>
                  {metrics.topDoctors.map((d, i) => (
                    <RankRow key={i} rank={i + 1} name={d.name} value={fmt(d.revenue, metrics.cur)} color="#7C3AED" />
                  ))}
                </NeuCard>
              </>
            )}

            {/* Top Admins */}
            {metrics.topAdmins.length > 0 && (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <TrendingUp size={16} color="#2DA8FF" />
                  <Text style={{ flex: 1, fontSize: 15, fontWeight: '800', color: c.text }}>Most Active Admins</Text>
                </View>
                <NeuCard style={{ padding: 14, marginBottom: 20 }}>
                  {metrics.topAdmins.map((a, i) => (
                    <RankRow key={i} rank={i + 1} name={a.name} value={fmt(a.revenue, metrics.cur)} color="#2DA8FF" />
                  ))}
                </NeuCard>
              </>
            )}

            {/* Top Courses by Revenue */}
            {metrics.topCourses.length > 0 && (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <BookOpen size={16} color="#D97706" />
                  <Text style={{ flex: 1, fontSize: 15, fontWeight: '800', color: c.text }}>Top Courses by Revenue</Text>
                </View>
                <NeuCard style={{ padding: 14, marginBottom: 20 }}>
                  {metrics.topCourses.map((course, i) => (
                    <RankRow key={i} rank={i + 1} name={course.title} value={fmt(course.revenue, metrics.cur)} color="#D97706" />
                  ))}
                </NeuCard>
              </>
            )}

            {/* Pricing reference */}
            <NeuCard style={{ padding: 14 }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 8 }}>PRICING REFERENCE</Text>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 13, color: c.text }}>Per Credit</Text>
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#16A34A' }}>
                  {metrics.cur} {pricing?.creditPrice.amount}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                <Text style={{ fontSize: 13, color: c.text }}>Per Activation Code</Text>
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#D97706' }}>
                  {metrics.cur} {pricing?.activationCodePrice.amount}
                </Text>
              </View>
              <Pressable onPress={() => router.push('/(app)/(admin)/settings' as RelativePathString)}
                style={{ marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={{ fontSize: 12, color: c.primary }}>Edit Pricing in Platform Settings</Text>
                <ArrowRight size={12} color={c.primary} />
              </Pressable>
            </NeuCard>
          </>
        )}
      </View>
    </ScrollView>
  );
}
