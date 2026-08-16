import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, useColorScheme, Pressable,
  RefreshControl, ActivityIndicator,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import {
  Users, DollarSign, UserCog, GraduationCap, BookOpen,
  Ticket, CreditCard, Stethoscope, Search, BarChart2,
  FileText, ChevronRight, TrendingUp, HardDrive,
  Flag, Shield, Wrench, Megaphone, Coins, Activity,
  AlertOctagon, UserPlus, Paintbrush, Database, ShieldAlert,
  SquareCode, Trash2, Video, MonitorDot, Globe, Settings, Zap,
} from 'lucide-react-native';
import { useProfileStore } from '@/lib/store';
import { getSuperAdminStats } from '@/lib/api';
import { getFirstName } from '@/lib/utils';
import { neuColors, neuFlatStyle, neuPressedStyle, useLayout } from '@/lib/neu';
import { DashboardHeader } from '@/components/DashboardHeader';
import Bell from '@/components/Bell';
import { useNotificationPermission } from '@/hooks/useNotificationPermission';
import { PermissionRationaleModal } from '@/components/PermissionRationaleModal';

// ── KPI Card ─────────────────────────────────────────────────────────────────
function KpiCard({
  label, value, icon: Icon, color, path, c, isDark,
}: {
  label: string; value: string | number; icon: React.ElementType;
  color: string; path?: string; c: typeof neuColors.light; isDark: boolean;
}) {
  const router  = useRouter();
  const layout  = useLayout();
  const iconSz  = Math.round(layout.touchTarget * 0.86);
  const iconInner = Math.round(iconSz * 0.48);
  const [pressed, setPressed] = useState(false);

  const inner = (
    <View style={[
      pressed && path ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
      { borderRadius: layout.cardRadius, padding: layout.cardPx, flex: 1 },
    ]}>
      <View style={{
        width: iconSz, height: iconSz, borderRadius: layout.cardRadius / 1.5,
        backgroundColor: `${color}22`,
        alignItems: 'center', justifyContent: 'center',
        marginBottom: layout.pad.sm,
      }}>
        <Icon size={iconInner} color={color} />
      </View>
      <Text style={{ fontSize: layout.titleSize * 0.9, fontWeight: '900', color: c.text, letterSpacing: -0.5 }}>{value}</Text>
      <Text style={{ fontSize: layout.captionSize, color: c.text, opacity: 0.5, marginTop: 3 }}>{label}</Text>
    </View>
  );

  if (!path) return (
    <View style={{ flex: 1, minWidth: '46%', marginBottom: layout.itemGap, marginRight: layout.itemGap }}>{inner}</View>
  );
  return (
    <Pressable
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onPress={() => router.push(path as RelativePathString)}
      accessibilityLabel={`${label}: ${value}`}
      accessibilityRole="button"
      style={{ flex: 1, minWidth: '46%', marginBottom: layout.itemGap, marginRight: layout.itemGap }}
    >
      {inner}
    </Pressable>
  );
}

// ── Quick Action Button ───────────────────────────────────────────────────────
function QuickActionBtn({
  icon: Icon, label, color, path, c, isDark,
}: {
  icon: React.ElementType; label: string; color: string;
  path: string; c: typeof neuColors.light; isDark: boolean;
}) {
  const router  = useRouter();
  const layout  = useLayout();
  const btnSz   = layout.touchTarget + 10;
  const iconInner = Math.round(btnSz * 0.42);
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onPress={() => router.push(path as RelativePathString)}
      accessibilityLabel={label}
      accessibilityRole="button"
      style={{ width: '22%', alignItems: 'center', marginBottom: layout.pad.md }}
    >
      <View style={[
        pressed ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
        { width: btnSz, height: btnSz, borderRadius: layout.cardRadius, alignItems: 'center', justifyContent: 'center', marginBottom: layout.pad.xs },
      ]}>
        <Icon size={iconInner} color={color} />
      </View>
      <Text style={{ fontSize: layout.captionSize - 1, fontWeight: '700', color: c.text, opacity: 0.65, textAlign: 'center' }} numberOfLines={2}>{label}</Text>
    </Pressable>
  );
}

// ── Nav Hub Row ───────────────────────────────────────────────────────────────
function HubRow({
  icon: Icon, label, description, color, path, badge, c, isDark,
}: {
  icon: React.ElementType; label: string; description: string;
  color: string; path: string; badge?: string; c: typeof neuColors.light; isDark: boolean;
}) {
  const router = useRouter();
  const layout = useLayout();
  const iconSz = layout.touchTarget;
  const iconInner = Math.round(iconSz * 0.44);
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onPress={() => router.push(path as RelativePathString)}
      accessibilityLabel={label}
      accessibilityRole="button"
    >
      <View style={[
        pressed ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
        { borderRadius: layout.cardRadius, marginBottom: layout.itemGap, padding: layout.cardPx, flexDirection: 'row', alignItems: 'center' },
      ]}>
        <View style={{
          width: iconSz, height: iconSz,
          borderRadius: layout.cardRadius / 1.5,
          backgroundColor: `${color}1A`,
          alignItems: 'center', justifyContent: 'center',
          marginRight: layout.pad.md,
          flexShrink: 0,
        }}>
          <Icon size={iconInner} color={color} />
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: layout.pad.sm }}>
            <Text style={{ fontSize: layout.bodySize, fontWeight: '700', color: c.text }}>{label}</Text>
            {badge && (
              <View style={{ backgroundColor: `${color}22`, borderRadius: layout.cardRadius / 2, paddingHorizontal: layout.pad.xs + 2, paddingVertical: 2 }}>
                <Text style={{ fontSize: layout.captionSize - 1, fontWeight: '700', color }}>{badge}</Text>
              </View>
            )}
          </View>
          <Text style={{ fontSize: layout.captionSize, color: c.text, opacity: 0.45, marginTop: 2 }}>{description}</Text>
        </View>
        <ChevronRight size={layout.captionSize + 2} color={`${c.text}35`} />
      </View>
    </Pressable>
  );
}

// ── Section Label ─────────────────────────────────────────────────────────────
function SectionLabel({ label, c }: { label: string; c: typeof neuColors.light }) {
  const layout = useLayout();
  return (
    <Text style={{ fontSize: layout.captionSize, fontWeight: '800', color: c.text, opacity: 0.4, textTransform: 'uppercase', letterSpacing: 1.4, marginBottom: layout.pad.md, marginTop: layout.sectionGap }}>
      {label}
    </Text>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
export default function SuperAdminDashboard() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const { profile } = useProfileStore();
  const router = useRouter();

  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async () => {
    try {
      setStats(await getSuperAdminStats());
    } catch (_) {}
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
    { icon: UserPlus,     label: 'Add Doctor',     color: '#16A34A', path: '/(app)/(superadmin)/sa-users' },
    { icon: BookOpen,     label: 'New Course',     color: '#7C3AED', path: '/(app)/(superadmin)/sa-global-search' },
    { icon: Megaphone,    label: 'Broadcast',      color: '#D97706', path: '/(app)/(superadmin)/sa-notifications-center' },
    { icon: CreditCard,   label: 'Credits',        color: '#7C3AED', path: '/(app)/(superadmin)/sa-credits' },
    { icon: Shield,       label: 'Audit Logs',     color: '#DC2626', path: '/(app)/(superadmin)/sa-audit' },
    { icon: Wrench,       label: 'Maintenance',    color: '#6B7280', path: '/(app)/(superadmin)/maintenance' },
    { icon: Flag,         label: 'Feat. Flags',    color: '#7C3AED', path: '/(app)/(superadmin)/feature-flags' },
    { icon: Database,     label: 'DB Audit',       color: '#D97706', path: '/(app)/(superadmin)/sa-db-audit' },
  ];

  const navSections = [
    {
      title: 'Management',
      items: [
        { icon: Users,      label: 'All Users',        description: 'Students, doctors & admins',     color: c.primary,  path: '/(app)/(superadmin)/sa-users' },
        { icon: BookOpen,   label: 'Courses',           description: 'All courses, status & search',   color: '#7C3AED',  path: '/(app)/(superadmin)/sa-global-search' },
        { icon: GraduationCap,label:'Academic',         description: 'Universities, faculties, levels',color: '#2DA8FF',  path: '/(app)/(superadmin)/sa-academic' },
      ],
    },
    {
      title: 'Revenue',
      items: [
        { icon: DollarSign, label: 'Platform Revenue', description: 'Total earnings & payouts',        color: '#16A34A',  path: '/(app)/(superadmin)/revenue', badge: 'Live' },
        { icon: BarChart2,  label: 'Ledger',           description: 'Transaction ledger & history',    color: c.primary,  path: '/(app)/(superadmin)/sa-ledger-dashboard' },
      ],
    },
    {
      title: 'Credits',
      items: [
        { icon: CreditCard, label: 'Credits',          description: 'Manage credits & view history',   color: '#7C3AED',  path: '/(app)/(superadmin)/sa-credits' },
      ],
    },
    {
      title: 'Content & Media',
      items: [
        { icon: Video,       label: 'Video Library',    description: 'Manage uploaded videos',          color: '#7C3AED',  path: '/(app)/(superadmin)/sa-video-library' },
        { icon: MonitorDot,  label: 'Video Monitor',    description: 'Live video health & status',      color: '#2DA8FF',  path: '/(app)/(superadmin)/sa-video-monitor' },
        { icon: AlertOctagon,label: 'Watermark / DRM',  description: 'Content protection & forensics',  color: '#DC2626',  path: '/(app)/(superadmin)/content-protection' },
        { icon: HardDrive,   label: 'Storage',          description: 'Bucket usage & cleanup',          color: '#6B7280',  path: '/(app)/(superadmin)/sa-storage' },
      ],
    },
    {
      title: 'Monitoring',
      items: [
        { icon: Activity,   label: 'Analytics',        description: 'Platform metrics & trends',       color: '#16A34A',  path: '/(app)/(superadmin)/sa-analytics' },
        { icon: FileText,   label: 'Reports',          description: 'Detailed platform reports',       color: '#7C3AED',  path: '/(app)/(superadmin)/sa-reports' },
        { icon: Shield,     label: 'Audit Trail',      description: 'Full platform audit log',         color: '#DC2626',  path: '/(app)/(superadmin)/sa-audit' },
        { icon: SquareCode, label: 'Credit Analytics', description: 'Credit flow & analytics',         color: c.primary,  path: '/(app)/(superadmin)/sa-credit-analytics' },
      ],
    },
    {
      title: 'Platform & Settings',
      items: [
        { icon: ShieldAlert, label: 'Security',         description: 'Dashboard, policies & logs',      color: '#EF4444',  path: '/(app)/(superadmin)/sec-dashboard' },
        { icon: Shield,      label: 'Security Diag.',   description: 'Native module diagnostics',       color: '#DC2626',  path: '/(app)/security-diagnostics' },
        { icon: Flag,        label: 'Feature Flags',    description: 'Toggle platform features',        color: '#7C3AED',  path: '/(app)/(superadmin)/feature-flags' },
        { icon: Paintbrush,  label: 'Branding',         description: 'Logo, colours & identity',        color: '#D97706',  path: '/(app)/(superadmin)/branding' },
        { icon: Wrench,      label: 'Maintenance',      description: 'Mode & system operations',        color: '#6B7280',  path: '/(app)/(superadmin)/maintenance' },
        { icon: Zap,         label: 'System Config',    description: 'Environment & platform config',   color: '#2DA8FF',  path: '/(app)/(superadmin)/config' },
        { icon: Globe,       label: 'Currency',         description: 'Global currency settings',        color: '#16A34A',  path: '/(app)/(superadmin)/currency' },
        { icon: Trash2,      label: 'Trash Bin',        description: 'Deleted item recovery',           color: '#DC2626',  path: '/(app)/(superadmin)/trash-bin' },
      ],
    },
  ];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
    >
      <DashboardHeader
        roleLabel="Super Admin"
        greeting={firstName ? `Hi, ${firstName} 👋` : 'Dashboard 👋'}
        rightActions={<Bell />}
      />
      <View style={{ padding: layout.screenPx, paddingTop: 0 }}>

        {/* ── Global search ───────────────────────────────────────────── */}
        <Pressable
          onPress={() => router.push('/(app)/(superadmin)/sa-global-search' as RelativePathString)}
          accessibilityLabel="Global search"
          accessibilityRole="search"
          style={[
            neuFlatStyle(isDark),
            { flexDirection: 'row', alignItems: 'center', borderRadius: layout.cardRadius, paddingHorizontal: layout.cardPx, paddingVertical: layout.pad.md, marginBottom: layout.sectionGap, gap: layout.pad.sm },
          ]}
        >
          <Search size={layout.bodySize + 2} color={`${c.text}50`} />
          <Text style={{ flex: 1, fontSize: layout.bodySize + 1, color: `${c.text}50` }}>
            Search doctors, students, courses, transactions…
          </Text>
          <View style={{ backgroundColor: `${c.primary}18`, borderRadius: layout.cardRadius / 2, paddingHorizontal: layout.pad.sm, paddingVertical: layout.pad.xs }}>
            <Text style={{ fontSize: layout.captionSize - 1, fontWeight: '700', color: c.primary }}>SEARCH</Text>
          </View>
        </Pressable>

        {/* ── KPI rows ────────────────────────────────────────────────── */}
        {loading ? (
          <ActivityIndicator color={c.primary} style={{ marginVertical: layout.sectionGap }} />
        ) : stats && (
          <>
            <SectionLabel label="Users & Platform" c={c} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginRight: -layout.itemGap }}>
              <KpiCard label="Total Doctors"   value={stats.totalDoctors}   icon={Stethoscope}    color="#16A34A" path="/(app)/(superadmin)/sa-users"       c={c} isDark={isDark} />
              <KpiCard label="Total Students"  value={stats.totalStudents}  icon={GraduationCap}  color="#7C3AED" path="/(app)/(superadmin)/sa-users"       c={c} isDark={isDark} />
              <KpiCard label="Total Courses"   value={stats.totalCourses}   icon={BookOpen}       color="#2DA8FF" path="/(app)/(admin)/global-search"       c={c} isDark={isDark} />
              <KpiCard label="Active Codes"    value={stats.activeCodes}    icon={Ticket}         color="#D97706" path="/(app)/(admin)/codes"               c={c} isDark={isDark} />
            </View>

            <SectionLabel label="Revenue & Operations" c={c} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginRight: -layout.itemGap }}>
              <KpiCard label="Total Credits"    value={stats.totalCredits.toLocaleString('en-US')}  icon={CreditCard}  color="#16A34A" path="/(app)/(superadmin)/sa-credits"    c={c} isDark={isDark} />
              <KpiCard label="Used Credits"     value={stats.usedCredits.toLocaleString('en-US')}   icon={Coins}       color="#D97706" path="/(app)/(superadmin)/sa-credits"      c={c} isDark={isDark} />
              <KpiCard label="Published"        value={stats.publishedCourses}               icon={BookOpen}    color="#2DA8FF" path="/(app)/(admin)/global-search"       c={c} isDark={isDark} />
              <KpiCard label="Draft Courses"    value={stats.draftCourses}                   icon={FileText}    color="#6B7280" path="/(app)/(admin)/global-search"       c={c} isDark={isDark} />
            </View>

            <SectionLabel label="System Snapshot" c={c} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginRight: -layout.itemGap }}>
              <KpiCard label="Universities"    value={stats.totalUniversities}  icon={GraduationCap}  color="#2DA8FF" path="/(app)/(admin)/academic"     c={c} isDark={isDark} />
              <KpiCard label="Faculties"       value={stats.totalFaculties}     icon={BookOpen}       color="#7C3AED" path="/(app)/(admin)/academic"     c={c} isDark={isDark} />
              <KpiCard label="Admin Staff"     value={stats.totalAdmins}        icon={UserCog}        color="#EF4444" path="/(app)/(superadmin)/sa-users"  c={c} isDark={isDark} />
              <KpiCard label="Total Users"     value={stats.totalUsers}         icon={Users}          color={c.primary} path="/(app)/(superadmin)/sa-users" c={c} isDark={isDark} />
            </View>

            {/* ── Codes breakdown ────────────────────────────────────────── */}
            <View style={[neuFlatStyle(isDark), { borderRadius: layout.cardRadius, padding: layout.cardPx, marginTop: layout.pad.xs, marginBottom: layout.itemGap }]}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: layout.pad.md }}>
                <Text style={{ fontSize: layout.bodySize, fontWeight: '800', color: c.text }}>Activation Codes</Text>
                <Pressable
                  onPress={() => router.push('/(app)/(superadmin)/sa-codes' as RelativePathString)}
                  accessibilityLabel="View all activation codes"
                  accessibilityRole="button"
                >
                  <Text style={{ fontSize: layout.captionSize + 1, color: c.primary, fontWeight: '700' }}>View all</Text>
                </Pressable>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
                {[
                  { label: 'Active',   value: stats.activeCodes,   color: '#16A34A' },
                  { label: 'Used',     value: stats.usedCodes,     color: c.primary },
                  { label: 'Disabled', value: stats.disabledCodes, color: '#DC2626' },
                  { label: 'Expired',  value: stats.expiredCodes,  color: '#D97706' },
                ].map(s => (
                  <View key={s.label} style={{ alignItems: 'center' }}>
                    <Text style={{ fontSize: layout.titleSize, fontWeight: '900', color: s.color }}>{s.value}</Text>
                    <Text style={{ fontSize: layout.captionSize, color: c.text, opacity: 0.5, marginTop: 2 }}>{s.label}</Text>
                  </View>
                ))}
              </View>
            </View>
          </>
        )}

        {/* ── Quick Actions ────────────────────────────────────────────── */}
        <SectionLabel label="Quick Actions" c={c} />
        <View style={[neuFlatStyle(isDark), { borderRadius: layout.cardRadius, padding: layout.cardPx, marginBottom: layout.itemGap }]}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
            {quickActions.map(a => (
              <QuickActionBtn key={a.label} icon={a.icon} label={a.label} color={a.color} path={a.path} c={c} isDark={isDark} />
            ))}
          </View>
        </View>

        {/* ── Navigation hub sections ─────────────────────────────────── */}
        {navSections.map(section => (
          <View key={section.title}>
            <SectionLabel label={section.title} c={c} />
            {section.items.map(item => (
              <HubRow key={item.label} {...item} c={c} isDark={isDark} />
            ))}
          </View>
        ))}

        {/* ── Platform status ──────────────────────────────────────────── */}
        <SectionLabel label="Platform Status" c={c} />
        <View style={[neuFlatStyle(isDark), { borderRadius: layout.cardRadius, padding: layout.cardPx, marginBottom: layout.scrollBottom() }]}>
          {[
            { label: 'Database',       status: 'Operational', color: '#16A34A' },
            { label: 'Authentication', status: 'Active',      color: '#16A34A' },
            { label: 'Storage',        status: 'Healthy',     color: '#16A34A' },
            { label: 'Edge Functions', status: 'Running',     color: '#16A34A' },
          ].map(({ label, status, color }, i, arr) => (
            <View key={label} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: layout.pad.md, borderBottomWidth: i < arr.length - 1 ? 1 : 0, borderBottomColor: `${c.text}08` }}>
              <Text style={{ fontSize: layout.bodySize, color: c.text, opacity: 0.7, fontWeight: '500' }}>{label}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: layout.pad.sm }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
                <Text style={{ fontSize: layout.captionSize + 1, fontWeight: '700', color }}>{status}</Text>
              </View>
            </View>
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
