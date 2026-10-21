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
  SquareCode, Trash2, Video, MonitorDot, Globe, Settings,
} from 'lucide-react-native';
import { useProfileStore } from '@/lib/store';
import { getSuperAdminStats } from '@/lib/api';
import { getFirstName } from '@/lib/utils';
import { neuColors, neuFlatStyle, neuPressedStyle, useLayout, safeBottom, mutedTextStyle } from '@/lib/neu';
import { DashboardHeader } from '@/components/DashboardHeader';
import Bell from '@/components/Bell';
import { useTranslation } from '@/lib/i18n';
import { markEntryIntent } from '@/lib/navigation/navIntent';
import { useNotificationPermission } from '@/hooks/useNotificationPermission';
import { PermissionRationaleModal } from '@/components/PermissionRationaleModal';
import { QuickActionBtn } from '@/components/QuickActionBtn';

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
      <Text style={{ fontSize: layout.captionSize, ...mutedTextStyle(c, 0.5), marginTop: 3 }}>{label}</Text>
    </View>
  );

  if (!path) return (
    // flexBasis (not flex:1/flexBasis:0) — Yoga on Android collapses wrapped-row
    // line heights when children have flexBasis 0% + percentage minWidth, which
    // made rows overlap and stretch. flexBasis '46%' gives every card a real
    // hypothetical size; flexGrow equalises widths and `gap` on the row handles
    // both axes of spacing.
    <View style={{ flexGrow: 1, flexBasis: '46%' }}>{inner}</View>
  );
  return (
    <Pressable
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onPress={() => {
        // Dashboard → destination is a nested entry (Back), never the drawer's menu.
        markEntryIntent(path, 'nested');
        router.push(path as RelativePathString);
      }}
      accessibilityLabel={`${label}: ${value}`}
      accessibilityRole="button"
      style={{ flexGrow: 1, flexBasis: '46%' }}
    >
      {inner}
    </Pressable>
  );
}

// ── Quick Action Button (shared component — see src/components/QuickActionBtn.tsx) ─

// ── Nav Hub Row ───────────────────────────────────────────────────────────────────
function HubRow({
  icon: Icon, label, description, color, path, badge, c, isDark,
}: {
  icon: React.ElementType; label: string; description: string;
  color: string; path: string; badge?: string; c: typeof neuColors.light; isDark: boolean;
}) {
  const router = useRouter();
  const layout = useLayout();
  const { isRTL } = useTranslation();
  const iconSz = layout.touchTarget;
  const iconInner = Math.round(iconSz * 0.44);
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onPress={() => {
        markEntryIntent(path, 'nested');
        router.push(path as RelativePathString);
      }}
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
          // Logical margin (not marginRight): in Arabic the icon sits on the
          // RIGHT of the row, so the drawer/hub rows must follow the reading
          // direction instead of a hardcoded physical side.
          marginEnd: layout.pad.md,
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
          <Text style={{ fontSize: layout.captionSize, ...mutedTextStyle(c, 0.45), marginTop: 2 }}>{description}</Text>
        </View>
        <ChevronRight
          size={layout.captionSize + 2}
          color={`${c.text}35`}
          // Directional icon: points along the reading direction.
          style={{ transform: [{ scaleX: isRTL ? -1 : 1 }] }}
        />
      </View>
    </Pressable>
  );
}

// ── Section Label ─────────────────────────────────────────────────────────────
function SectionLabel({ label, c }: { label: string; c: typeof neuColors.light }) {
  const layout = useLayout();
  return (
    <Text style={{ fontSize: layout.captionSize, fontWeight: '800', ...mutedTextStyle(c, 0.4), textTransform: 'uppercase', letterSpacing: 1.4, marginBottom: layout.pad.md, marginTop: layout.sectionGap, textAlign: 'left' }}>
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
  const { t } = useTranslation();
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
    { icon: UserPlus,     label: t('saOverview.action.addDoctor'),    color: '#16A34A', path: '/sa-users' },
    { icon: BookOpen,     label: t('saOverview.action.newCourse'),    color: '#7C3AED', path: '/sa-global-search' },
    { icon: Megaphone,    label: t('saOverview.action.broadcast'),    color: '#D97706', path: '/sa-notifications-center' },
    { icon: CreditCard,   label: t('nav.credits'),                    color: '#7C3AED', path: '/sa-credits' },
    { icon: Shield,       label: t('saOverview.action.auditLogs'),    color: '#DC2626', path: '/sa-audit' },
    { icon: Wrench,       label: t('saOverview.nav.maintenance'),     color: '#6B7280', path: '/maintenance' },
    { icon: Flag,         label: t('saOverview.nav.featureFlags'),    color: '#7C3AED', path: '/feature-flags' },
    { icon: Database,     label: t('saOverview.action.dbAudit'),      color: '#D97706', path: '/sa-db-audit' },
  ];

  const navSections = [
    {
      title: t('nav.management'),
      items: [
        { icon: Users,      label: t('nav.allUsers'),            description: t('saOverview.nav.allUsersDesc'),      color: c.primary,  path: '/sa-users' },
        { icon: BookOpen,   label: t('saOverview.nav.courses'),   description: t('saOverview.nav.coursesDesc'),       color: '#7C3AED',  path: '/sa-global-search' },
        { icon: GraduationCap,label:t('nav.academicStructure'),   description: t('saOverview.nav.academicDesc'),      color: '#2DA8FF',  path: '/sa-academic' },
      ],
    },
    {
      title: t('saOverview.section.revenue'),
      items: [
        { icon: DollarSign, label: t('saOverview.nav.platformRevenue'), description: t('saOverview.nav.platformRevenueDesc'), color: '#16A34A', path: '/revenue', badge: t('saOverview.badge.live') },
        { icon: BarChart2,  label: t('saOverview.nav.ledger'),          description: t('saOverview.nav.ledgerDesc'),          color: c.primary, path: '/sa-ledger-dashboard' },
      ],
    },
    {
      title: t('nav.credits'),
      items: [
        { icon: CreditCard, label: t('nav.credits'), description: t('saOverview.nav.creditsDesc'), color: '#7C3AED', path: '/sa-credits' },
      ],
    },
    {
      title: t('nav.contentMedia'),
      items: [
        { icon: Video,        label: t('nav.videoLibrary'),            description: t('saOverview.nav.videoLibraryDesc'), color: '#7C3AED',  path: '/sa-video-library' },
        { icon: AlertOctagon, label: t('saOverview.nav.watermark'),     description: t('saOverview.nav.watermarkDesc'),    color: '#DC2626',  path: '/content-protection' },
        { icon: HardDrive,    label: t('saOverview.nav.storage'),       description: t('saOverview.nav.storageDesc'),      color: '#6B7280',  path: '/sa-storage' },
      ],
    },
    {
      title: t('nav.sectionMonitoring'),
      items: [
        { icon: Activity,    label: t('nav.analytics'),          description: t('saOverview.nav.analyticsDesc'),      color: '#16A34A',  path: '/sa-analytics' },
        { icon: FileText,    label: t('nav.reports'),            description: t('saOverview.nav.reportsDesc'),        color: '#7C3AED',  path: '/sa-reports' },
        { icon: Shield,      label: t('nav.auditTrail'),         description: t('saOverview.nav.auditTrailDesc'),     color: '#DC2626',  path: '/sa-audit' },
        { icon: SquareCode,  label: t('nav.creditAnalytics'),    description: t('saOverview.nav.creditAnalyticsDesc'), color: c.primary, path: '/sa-credit-analytics' },
        { icon: GraduationCap, label: t('nav.enrollmentStats'),  description: t('saOverview.nav.enrollmentStatsDesc'), color: '#7C3AED', path: '/sa-enrollment-stats' },
      ],
    },
    {
      title: t('nav.platformSettings'),
      items: [
        { icon: ShieldAlert, label: t('saOverview.nav.security'),      description: t('saOverview.nav.securityDesc'),      color: '#EF4444',  path: '/sec-dashboard' },
        { icon: Shield,      label: t('saOverview.nav.securityDiag'),  description: t('saOverview.nav.securityDiagDesc'),  color: '#DC2626',  path: '/security-diagnostics' },
        { icon: Flag,        label: t('saOverview.nav.featureFlags'),  description: t('saOverview.nav.featureFlagsDesc'),  color: '#7C3AED',  path: '/feature-flags' },
        { icon: Paintbrush,  label: t('saOverview.nav.branding'),      description: t('saOverview.nav.brandingDesc'),      color: '#D97706',  path: '/branding' },
        { icon: Wrench,      label: t('saOverview.nav.maintenance'),   description: t('saOverview.nav.maintenanceDesc'),   color: '#6B7280',  path: '/maintenance' },
        { icon: Globe,       label: t('saOverview.nav.currency'),      description: t('saOverview.nav.currencyDesc'),      color: '#16A34A',  path: '/currency' },
        { icon: Trash2,      label: t('saOverview.nav.trashBin'),      description: t('saOverview.nav.trashBinDesc'),      color: '#DC2626',  path: '/trash-bin' },
        // Language access for the Super Admin role (parity with Student/Doctor).
        { icon: Settings,    label: t('nav.settings'),                 description: t('saOverview.nav.settingsDesc'),      color: '#6B7280',  path: '/admin-settings' },
      ],
    },
  ];

  const platformStatus = [
    { label: t('saOverview.status.database'),       status: t('saOverview.status.operational'), color: '#16A34A' },
    { label: t('saOverview.status.authentication'), status: t('saOverview.status.active'),      color: '#16A34A' },
    { label: t('saOverview.status.storage'),        status: t('saOverview.status.healthy'),     color: '#16A34A' },
    { label: t('saOverview.status.edgeFunctions'),  status: t('saOverview.status.running'),     color: '#16A34A' },
  ];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />} contentContainerStyle={{ paddingBottom: safeBottom(layout.insets.bottom) }}
    >
      <DashboardHeader
        roleLabel={t('role.superAdmin')}
        greeting={firstName ? t('saOverview.greeting', { name: firstName }) : t('saOverview.greetingFallback')}
        rightActions={<Bell />}
      />
      <View style={{ padding: layout.screenPx, paddingTop: 0 }}>

        {/* ── Global search ───────────────────────────────────────────── */}
        <Pressable
          onPress={() => {
            markEntryIntent('/sa-global-search', 'nested');
            router.push('/sa-global-search' as RelativePathString);
          }}
          accessibilityLabel={t('nav.globalSearch')}
          accessibilityRole="search"
          style={[
            neuFlatStyle(isDark),
            { flexDirection: 'row', alignItems: 'center', borderRadius: layout.cardRadius, paddingHorizontal: layout.cardPx, paddingVertical: layout.pad.md, marginBottom: layout.sectionGap, gap: layout.pad.sm },
          ]}
        >
          <Search size={layout.bodySize + 2} color={`${c.text}50`} />
          <Text style={{ flex: 1, fontSize: layout.bodySize + 1, color: `${c.text}50`, textAlign: 'left' }}>
            {t('saOverview.searchPlaceholder')}
          </Text>
          <View style={{ backgroundColor: `${c.primary}18`, borderRadius: layout.cardRadius / 2, paddingHorizontal: layout.pad.sm, paddingVertical: layout.pad.xs }}>
            <Text style={{ fontSize: layout.captionSize - 1, fontWeight: '700', color: c.primary }}>{t('saOverview.searchChip')}</Text>
          </View>
        </Pressable>

        {/* ── KPI rows ────────────────────────────────────────────────── */}
        {loading ? (
          <ActivityIndicator color={c.primary} style={{ marginVertical: layout.sectionGap }} />
        ) : stats && (
          <>
            <SectionLabel label={t('saOverview.section.usersPlatform')} c={c} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: layout.itemGap }}>
              <KpiCard label={t('saOverview.kpi.totalDoctors')} value={stats.totalDoctors}   icon={Stethoscope}    color="#16A34A" path="/sa-users"       c={c} isDark={isDark} />
              <KpiCard label={t('saOverview.kpi.totalStudents')} value={stats.totalStudents}  icon={GraduationCap}  color="#7C3AED" path="/sa-users"       c={c} isDark={isDark} />
              <KpiCard label={t('saOverview.kpi.totalCourses')} value={stats.totalCourses}   icon={BookOpen}       color="#2DA8FF" path="/global-search"       c={c} isDark={isDark} />
              <KpiCard label={t('saOverview.kpi.totalDevices')} value={stats.totalDevices}   icon={UserCog}        color="#D97706" path="/sa-devices"       c={c} isDark={isDark} />
            </View>

            <SectionLabel label={t('saOverview.section.revenueOps')} c={c} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: layout.itemGap }}>
              <KpiCard label={t('saOverview.kpi.totalCredits')} value={stats.totalCredits.toLocaleString('en-US')}  icon={CreditCard}  color="#16A34A" path="/sa-credits"    c={c} isDark={isDark} />
              <KpiCard label={t('saOverview.kpi.usedCredits')} value={stats.usedCredits.toLocaleString('en-US')}   icon={Coins}       color="#D97706" path="/sa-credits"      c={c} isDark={isDark} />
              <KpiCard label={t('saOverview.kpi.published')} value={stats.publishedCourses}               icon={BookOpen}    color="#2DA8FF" path="/global-search"       c={c} isDark={isDark} />
              <KpiCard label={t('saOverview.kpi.draftCourses')} value={stats.draftCourses}                   icon={FileText}    color="#6B7280" path="/global-search"       c={c} isDark={isDark} />
            </View>

            <SectionLabel label={t('saOverview.section.snapshot')} c={c} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: layout.itemGap }}>
              <KpiCard label={t('saOverview.kpi.universities')} value={stats.totalUniversities}  icon={GraduationCap}  color="#2DA8FF" path="/sa-academic"     c={c} isDark={isDark} />
              <KpiCard label={t('saOverview.kpi.faculties')} value={stats.totalFaculties}     icon={BookOpen}       color="#7C3AED" path="/sa-academic"     c={c} isDark={isDark} />
              <KpiCard label={t('saOverview.kpi.adminStaff')} value={stats.totalAdmins}        icon={UserCog}        color="#EF4444" path="/sa-users"  c={c} isDark={isDark} />
              <KpiCard label={t('saOverview.kpi.totalUsers')} value={stats.totalUsers}         icon={Users}          color={c.primary} path="/sa-users" c={c} isDark={isDark} />
            </View>

          </>
        )}

        {/* ── Quick Actions ────────────────────────────────────────────── */}
        <SectionLabel label={t('saOverview.section.quickActions')} c={c} />
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
        <SectionLabel label={t('saOverview.section.platformStatus')} c={c} />
        <View style={[neuFlatStyle(isDark), { borderRadius: layout.cardRadius, padding: layout.cardPx,  }]}>
          {platformStatus.map(({ label, status, color }, i, arr) => (
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
