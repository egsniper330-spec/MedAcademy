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
import { neuColors, useLayout, neuMicroStyle, safeBottom } from '@/lib/neu';
import { DashboardHeader } from '@/components/DashboardHeader';
import type { RelativePathString } from 'expo-router';
import { useNotificationPermission } from '@/hooks/useNotificationPermission';
import { PermissionRationaleModal } from '@/components/PermissionRationaleModal';

export default function AdminDashboard() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const insets = layout.insets;
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

  const {
    triggerNotificationPermission,
    showRationale: showNotifRationale,
    setShowRationale: setShowNotifRationale,
    isBlocked: notifBlocked,
    confirmRequest: confirmNotifRequest,
  } = useNotificationPermission();

  useFocusEffect(useCallback(() => {
    (async () => { await triggerNotificationPermission(); })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []));

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
      <DashboardHeader
        roleLabel="Admin Panel"
        greeting={firstName ? `${firstName} 👋` : 'Dashboard 👋'}
        rightActions={
          <Pressable
            onPress={() => router.push('/(app)/notifications' as RelativePathString)}
            accessibilityLabel="Notifications"
            accessibilityRole="button"
            style={[{ width: layout.touchTarget, height: layout.touchTarget, borderRadius: layout.cardRadius, alignItems: 'center', justifyContent: 'center' }, neuMicroStyle(isDark)]}
          >
            <Bell size={Math.round(layout.touchTarget * 0.44)} color={c.primary} />
          </Pressable>
        }
      />
      <View style={{ paddingHorizontal: layout.screenPx, paddingBottom: layout.scrollBottom() }}>

        {/* Stats */}
        {loading ? (
          <ActivityIndicator color={c.primary} style={{ marginVertical: layout.sectionGap }} />
        ) : stats && (
          <>
            <Text style={{ fontSize: layout.captionSize, fontWeight: '800', color: c.text, opacity: 0.4, marginBottom: layout.pad.sm, textTransform: 'uppercase', letterSpacing: 1 }}>Platform Overview</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: layout.pad.xs }}>
              <StatCard label="Students"    value={stats.totalStudents}    icon={<Users size={layout.captionSize + 2} color="#fff" />}        color="#7C3AED" />
              <StatCard label="Doctors"     value={stats.totalDoctors}     icon={<Stethoscope size={layout.captionSize + 2} color="#fff" />}  color="#16A34A" />
              <StatCard label="Devices"     value={stats.totalDevices}     icon={<Smartphone size={layout.captionSize + 2} color="#fff" />}   color="#D97706" />
              <StatCard label="Active Codes" value={stats.activeCodes}     icon={<Ticket size={layout.captionSize + 2} color="#fff" />}       color={c.primary} />
              <StatCard label="Credits"     value={stats.totalCredits}     icon={<CreditCard size={layout.captionSize + 2} color="#fff" />}   color="#16A34A" />
              <StatCard label="Consumed"    value={stats.usedCredits}      icon={<CreditCard size={layout.captionSize + 2} color="#fff" />}   color="#D97706" />
              <StatCard label="Courses"     value={stats.totalCourses}     icon={<BookOpen size={layout.captionSize + 2} color="#fff" />}     color="#2DA8FF" />
              <StatCard label="Published"   value={stats.publishedCourses} icon={<BookOpen size={layout.captionSize + 2} color="#fff" />}     color="#16A34A" />
            </View>
          </>
        )}

        {/* Quick Actions */}
        <Text style={{ fontSize: layout.bodySize + 1, fontWeight: '800', color: c.text, marginBottom: layout.pad.md, marginTop: layout.pad.sm }}>Quick Actions</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: layout.itemGap, marginBottom: layout.pad.md }}>
          {quickActions.map(({ icon: Icon, label, color, path }) => (
            <NeuCard
              key={label}
              pressable
              onPress={() => router.push(path as RelativePathString)}
              style={{ width: '46%', flexGrow: 1, alignItems: 'center', paddingVertical: layout.pad.md, paddingHorizontal: layout.pad.sm }}
            >
              <View style={{ width: layout.touchTarget, height: layout.touchTarget, borderRadius: layout.cardRadius, backgroundColor: `${color}18`, alignItems: 'center', justifyContent: 'center', marginBottom: layout.pad.sm }}>
                <Icon size={Math.round(layout.touchTarget * 0.46)} color={color} />
              </View>
              <Text style={{ fontSize: layout.captionSize + 1, fontWeight: '700', color: c.text, textAlign: 'center', lineHeight: layout.captionSize * 1.4 }} numberOfLines={2}>{label}</Text>
            </NeuCard>
          ))}
        </View>
      </View>
      <PermissionRationaleModal
        type="notifications"
        visible={showNotifRationale}
        isBlocked={notifBlocked}
        onConfirm={confirmNotifRequest}
        onDismiss={() => setShowNotifRationale(false)}
      />
    </ScrollView>
  );
}
