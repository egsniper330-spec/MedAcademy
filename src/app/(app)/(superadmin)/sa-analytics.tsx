/**
 * sa-analytics.tsx — Super Admin Analytics hub
 * Groups: System Health, Video Health, Video Monitor, Storage Monitor,
 *         Credit Analytics, Revenue Analytics, Fraud Alerts, Activation Codes
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, Pressable,
  ActivityIndicator, RefreshControl, useColorScheme,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import {
  Activity, Video, HeartPulse, Database, TrendingUp,
  DollarSign, AlertTriangle, Zap, ChevronRight,
  GraduationCap, BookOpen, Users, Stethoscope, UserCog,
  CreditCard, Ticket,
} from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { StatCard } from '@/components/StatCard';
import { neuColors, useLayout } from '@/lib/neu';
import { getSuperAdminStats } from '@/lib/api';
import Bell from '@/components/Bell';

function AnalyticsNavItem({
  icon: Icon, label, description, color, path, c,
}: {
  icon: React.ElementType;
  label: string;
  description: string;
  color: string;
  path: string;
  c: typeof neuColors.light;
}) {
  const router = useRouter();
  return (
    <Pressable onPress={() => router.push(path as RelativePathString)}>
      <NeuCard style={{ marginBottom: 10, padding: 16, flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: `${color}18`, alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
          <Icon size={20} color={color} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{label}</Text>
          <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 1 }}>{description}</Text>
        </View>
        <ChevronRight size={16} color={`${c.text}40`} />
      </NeuCard>
    </Pressable>
  );
}

export default function SAAnalytics() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const router = useRouter();

  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async () => {
    try { setStats(await getSuperAdminStats()); } catch (_) {}
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); loadData(); }, [loadData]));
  const onRefresh = async () => { setRefreshing(true); await loadData(); setRefreshing(false); };

  const sections = [
    {
      title: 'System Health',
      items: [
        { icon: Activity,   label: 'System Health',     description: 'Database, auth, storage status',     color: '#16A34A', path: '/(app)/(superadmin)/health' },
        { icon: HeartPulse, label: 'Video Health',      description: 'Video processing pipeline status',   color: '#2DA8FF', path: '/(app)/(superadmin)/sa-video-health' },
        { icon: Video,      label: 'Video Monitor',     description: 'Live video upload and stream stats', color: '#7C3AED', path: '/(app)/(superadmin)/sa-video-monitor' },
        { icon: Database,   label: 'Storage Monitor',   description: 'Bucket usage and file metrics',      color: '#2DA8FF', path: '/(app)/(superadmin)/sa-storage' },
        { icon: Zap,        label: 'Video Settings',    description: 'Encoding and provider config',       color: '#7C3AED', path: '/(app)/(superadmin)/sa-video-settings' },
      ],
    },
    {
      title: 'Financial Analytics',
      items: [
        { icon: TrendingUp,    label: 'Revenue Analytics', description: 'Revenue trends over time',        color: '#16A34A', path: '/(app)/(superadmin)/sa-revenue-analytics' },
        { icon: CreditCard,    label: 'Credits',           description: 'Credit management & history',     color: '#7C3AED', path: '/(app)/(superadmin)/sa-credits' },
        { icon: AlertTriangle, label: 'Fraud Alerts',      description: 'Suspicious activity & anomalies', color: '#DC2626', path: '/(app)/(superadmin)/sa-fraud-alerts' },
      ],
    },
    {
      title: 'Operations',
      items: [
        { icon: Ticket, label: 'Activation Codes', description: 'Active, used, expired codes summary', color: '#D97706', path: '/(app)/(superadmin)/sa-codes' },
      ],
    },
  ];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
    >
      <View style={{ padding: layout.screenPx }}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, marginTop: 8 }}>
          <PageHeader title="Analytics" subtitle="Platform metrics & health" accentColor={c.primary} rightAction={<Bell />} />
        </View>

        {/* Live stats */}
        {loading ? (
          <ActivityIndicator color={c.primary} style={{ marginBottom: 20 }} />
        ) : stats && (
          <>
            <Text style={{ fontSize: 11, fontWeight: '800', color: c.text, opacity: 0.4, textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 10 }}>
              Live Counters
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 4 }}>
              <StatCard label="Students"    value={stats.totalStudents}   icon={<GraduationCap size={16} color="#fff" />} color="#7C3AED" />
              <StatCard label="Doctors"     value={stats.totalDoctors}    icon={<Stethoscope size={16} color="#fff" />}   color="#16A34A" />
              <StatCard label="Courses"     value={stats.totalCourses}    icon={<BookOpen size={16} color="#fff" />}      color={c.primary} />
              <StatCard label="Published"   value={stats.publishedCourses} icon={<BookOpen size={16} color="#fff" />}    color="#2DA8FF" />
              <StatCard label="Total Credits" value={stats.totalCredits}  icon={<CreditCard size={16} color="#fff" />}   color="#16A34A" />
              <StatCard label="Active Codes"  value={stats.activeCodes}   icon={<Ticket size={16} color="#fff" />}       color="#D97706" />
            </View>

            {/* Courses breakdown */}
            <NeuCard style={{ marginBottom: 20, padding: 18 }}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, marginBottom: 14 }}>Courses Breakdown</Text>
              <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
                {[
                  { label: 'Total',     value: stats.totalCourses,     color: c.primary },
                  { label: 'Published', value: stats.publishedCourses, color: '#16A34A' },
                  { label: 'Drafts',    value: stats.draftCourses,     color: '#D97706' },
                ].map(s => (
                  <View key={s.label} style={{ alignItems: 'center' }}>
                    <Text style={{ fontSize: 28, fontWeight: '900', color: s.color }}>{s.value}</Text>
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 2 }}>{s.label}</Text>
                  </View>
                ))}
              </View>
            </NeuCard>
          </>
        )}

        {/* Navigation sections */}
        {sections.map(section => (
          <View key={section.title} style={{ marginBottom: 16 }}>
            <Text style={{ fontSize: 11, fontWeight: '800', color: c.text, opacity: 0.4, textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 10 }}>
              {section.title}
            </Text>
            {section.items.map(item => (
              <AnalyticsNavItem key={item.label} {...item} c={c} />
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
