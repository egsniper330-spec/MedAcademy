import { useCallback, useState } from 'react';
import { View, Text, ScrollView, useColorScheme, Pressable, RefreshControl, ActivityIndicator } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  Users, BookOpen, Ticket, Shield, CreditCard, Bell,
  Stethoscope, Smartphone, Search, Megaphone, Video, Database, FileText, GraduationCap, Archive, Activity, Layers,
} from 'lucide-react-native';
import { useProfileStore } from '@/lib/store';
import { getSuperAdminStats } from '@/lib/api';
import { getFirstName } from '@/lib/utils';
import { NeuCard } from '@/components/NeuCard';
import { StatCard } from '@/components/StatCard';
import { neuColors, neuMicroStyle } from '@/lib/neu';
import HamburgerButton from '@/components/HamburgerButton';
import type { RelativePathString } from 'expo-router';

export default function AdminDashboard() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { profile } = useProfileStore();
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

  const firstName = getFirstName(profile?.full_name);

  const quickActions = [
    { icon: Users,      label: 'Users',        color: c.primary,  path: '/(app)/(admin)/users' },
    { icon: Smartphone, label: 'Devices',       color: '#D97706',  path: '/(app)/(admin)/devices' },
    { icon: Ticket,     label: 'Codes',         color: '#7C3AED',  path: '/(app)/(admin)/codes' },
    { icon: Search,     label: 'Search',        color: '#2DA8FF',  path: '/(app)/(admin)/global-search' },
    { icon: Megaphone,  label: 'Notify',        color: '#D97706',  path: '/(app)/(admin)/notifications-center' },
    { icon: Video,      label: 'Video Monitor',    color: '#7C3AED',  path: '/(app)/(admin)/video-monitor' },
    { icon: Activity,   label: 'Video Health',     color: '#2DA8FF',  path: '/(app)/(admin)/video-health' },
    { icon: Layers,     label: 'System Providers', color: '#059669',  path: '/(app)/(admin)/system-providers' },
    { icon: FileText,   label: 'CMS Pages',      color: '#16A34A',  path: '/(app)/(admin)/cms' },
    { icon: Database,   label: 'Storage',       color: '#2DA8FF',  path: '/(app)/(admin)/storage' },
    { icon: Shield,     label: 'Audit Logs',    color: '#DC2626',  path: '/(app)/(admin)/audit' },
    { icon: BookOpen,   label: 'Reports',       color: '#6B7280',  path: '/(app)/(admin)/reports' },
    { icon: GraduationCap, label: 'Academic',   color: '#D97706',  path: '/(app)/(admin)/academic' },
    { icon: Archive,    label: 'Archived',      color: '#D97706',  path: '/(app)/archived-courses' },
  ];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
    >
      <View style={{ paddingHorizontal: 20, paddingBottom: 32 }}>
        {/* Header — safe area via contentInsetAdjustmentBehavior */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, marginTop: 14 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <HamburgerButton />
            <View>
              <Text style={{ fontSize: 11, color: c.text, opacity: 0.45, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6 }}>Admin Panel</Text>
              <Text style={{ fontSize: 21, fontWeight: '800', color: c.text, lineHeight: 26 }}>
                {firstName ? `${firstName} 👋` : 'Dashboard 👋'}
              </Text>
            </View>
          </View>
          <Pressable
            onPress={() => router.push('/(app)/notifications' as RelativePathString)}
            accessibilityLabel="Notifications"
            accessibilityRole="button"
            style={[{ width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' }, neuMicroStyle(isDark)]}
          >
            <Bell size={19} color={c.primary} />
          </Pressable>
        </View>

        {/* Stats */}
        {loading ? (
          <ActivityIndicator color={c.primary} style={{ marginVertical: 24 }} />
        ) : stats && (
          <>
            <Text style={{ fontSize: 11, fontWeight: '800', color: c.text, opacity: 0.4, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>Platform Overview</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 4, gap: 0 }}>
              <StatCard label="Students"    value={stats.totalStudents}    icon={<Users size={14} color="#fff" />}        color="#7C3AED" />
              <StatCard label="Doctors"     value={stats.totalDoctors}     icon={<Stethoscope size={14} color="#fff" />}  color="#16A34A" />
              <StatCard label="Devices"     value={stats.totalDevices}     icon={<Smartphone size={14} color="#fff" />}   color="#D97706" />
              <StatCard label="Active Codes" value={stats.activeCodes}     icon={<Ticket size={14} color="#fff" />}       color={c.primary} />
              <StatCard label="Credits"     value={stats.totalCredits}     icon={<CreditCard size={14} color="#fff" />}   color="#16A34A" />
              <StatCard label="Consumed"    value={stats.usedCredits}      icon={<CreditCard size={14} color="#fff" />}   color="#D97706" />
              <StatCard label="Courses"     value={stats.totalCourses}     icon={<BookOpen size={14} color="#fff" />}     color="#2DA8FF" />
              <StatCard label="Published"   value={stats.publishedCourses} icon={<BookOpen size={14} color="#fff" />}     color="#16A34A" />
            </View>
          </>
        )}

        {/* Quick Actions */}
        <Text style={{ fontSize: 15, fontWeight: '800', color: c.text, marginBottom: 12, marginTop: 8 }}>Quick Actions</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
          {quickActions.map(({ icon: Icon, label, color, path }) => (
            <NeuCard
              key={label}
              pressable
              onPress={() => router.push(path as RelativePathString)}
              style={{ width: '46%', flexGrow: 1, alignItems: 'center', paddingVertical: 14, paddingHorizontal: 8 }}
            >
              <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: `${color}18`, alignItems: 'center', justifyContent: 'center', marginBottom: 7 }}>
                <Icon size={20} color={color} />
              </View>
              <Text style={{ fontSize: 12, fontWeight: '700', color: c.text, textAlign: 'center', lineHeight: 16 }} numberOfLines={2}>{label}</Text>
            </NeuCard>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}
