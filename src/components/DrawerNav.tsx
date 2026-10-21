/**
 * DrawerNav — neumorphic side-drawer navigation for all roles.
 * Safe-area aware: drawer header respects status bar + Dynamic Island.
 * Responsive width: 290 on phones, 320 on tablets.
 * Usage: wrap each role layout with <DrawerProvider>, then use
 *        useDrawer().openDrawer() from any screen header.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, Pressable, ScrollView, Animated,
  useColorScheme, Platform, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, usePathname } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import {
  LayoutDashboard, BookOpen, Bell, Settings, LogOut, Users,
  Ticket, Shield, GraduationCap, Activity, Wrench,
  DollarSign, Megaphone, Search, Database, Video, FileText,
  Layers, TrendingUp, AlertTriangle, Hash, UsersRound,
  Lock, User, Smartphone, ChevronLeft, ChevronRight, X, Stethoscope,
  BarChart2, CreditCard, ClipboardList, HeartPulse, Zap, ShieldAlert,
  Upload, UserPlus, Flag, Paintbrush, Globe, Trash2, Eye,
  ShieldCheck, ShieldX, ReceiptText, AlertOctagon,
  MonitorDot, HardDrive, Download, DownloadCloud, SquareCode, HeartHandshake,
  Info, Mail, CloudUpload,
} from 'lucide-react-native';
import { backendClient } from '@/client/backendClient';
import { useProfileStore } from '@/lib/store';
import { useConnectivity } from '@/lib/offlineTransition';
import { neuColors, neuMicroStyle, mutedTextStyle, type NeuPalette } from '@/lib/neu';
import { spacing, radius, typography, iconContainer, safeBottom } from '@/lib/ds';
import { useDrawer } from './DrawerContext';
import { BrandLogo } from '@/components/BrandLogo';
import { getInstallationId } from '@/lib/installationId';
import { unregisterPushToken, cancelPushTokenRetry } from '@/lib/pushTokenService';
import { isFeatureEnabled } from '@/lib/featureFlags';
import { t, useTranslation } from '@/lib/i18n';
import {
  backdropEdgeStyle,
  drawerDirection,
  panelEdgeStyle,
} from '@/lib/ui/drawerDirection';

type NavItemType = {
  icon: React.ElementType;
  label: string;
  path: string;
  badge?: number;
  color?: string;
};

type NavSection = {
  title?: string;
  items: NavItemType[];
};

function getNavSections(
  role: string,
  c: typeof neuColors.light,
  earningsEnabled?: boolean,
  platformEarningsOn?: boolean,
): NavSection[] {
  const commonBottom: NavSection = {
    items: [
      { icon: Bell,       label: t('nav.notifications'), path: '/notifications', color: c.primary },
      { icon: Smartphone, label: t('nav.myDevices'),    path: '/my-devices',    color: '#2DA8FF' },
    ],
  };

  const studentBottom: NavSection = {
    items: [
      { icon: Bell, label: t('nav.notifications'), path: '/notifications', color: c.primary },
    ],
  };

  if (role === 'student') {
    return [
      {
        title: t('role.student'),
        items: [
          { icon: LayoutDashboard, label: t('nav.dashboard'),     path: '/dashboard', color: c.primary  },
          { icon: BookOpen,        label: t('nav.myCourses'),    path: '/my-courses', color: '#7C3AED' },
          { icon: DownloadCloud,   label: t('nav.offlineVideos'), path: '/offline-library', color: '#0EA5E9' },
          { icon: Bell,            label: t('nav.notifications'), path: '/notifications',         color: c.primary },
          { icon: User,            label: t('nav.profile'),       path: '/profile',    color: '#16A34A' },
          { icon: Info,            label: t('nav.aboutUs'),      path: '/info/about',           color: '#2DA8FF' },
          { icon: Mail,            label: t('nav.contactUs'),    path: '/info/contact',         color: '#7C3AED' },
        ],
      },
    ];
  }

  if (role === 'doctor') {
    const doctorItems: NavItemType[] = [
      // Canonical doctor navigation order — do not reorder casually:
      // Dashboard, My Courses, Video Library, Students, Credits,
      // Earnings, Notifications, Profile.
      { icon: LayoutDashboard, label: t('nav.dashboard'),      path: '/dr-overview',   color: c.primary  },
      { icon: BookOpen,        label: t('nav.myCourses'),     path: '/courses',       color: '#7C3AED'  },
      { icon: Video,           label: t('nav.videoLibrary'),  path: '/video-library', color: '#0EA5E9'  },
      { icon: Users,           label: t('nav.students'),       path: '/students',      color: '#D97706'  },
      { icon: Stethoscope,     label: t('nav.credits'),        path: '/credits',       color: '#2DA8FF'  },
      // EARNINGS — shown only while BOTH hold:
      //   • the platform capability is ON (server-authoritative feature flag
      //     doctor_earnings; Super Admin Feature Flags console), AND
      //   • the doctor has the earnings system enabled for themselves.
      // The screen itself also refuses (403 feature_disabled → unavailable
      // state), so a deep link / stale route is still safe.
      ...(platformEarningsOn && earningsEnabled
        ? [{ icon: TrendingUp, label: t('nav.earnings'), path: '/dr-earnings', color: '#16A34A' } as NavItemType]
        : []),
      { icon: Bell,            label: t('nav.notifications'),  path: '/notifications', color: c.primary  },
      { icon: User,            label: t('nav.profile'),        path: '/dr-profile',    color: '#7C3AED'  },
    ];
    return [{ title: t('role.doctor'), items: doctorItems }];
  }

  if (role === 'admin') {
    return [
      {
        title: t('nav.dashboard'),
        items: [
          { icon: LayoutDashboard, label: t('nav.dashboard'), path: '/admin-overview', color: c.primary },
        ],
      },
      {
        title: t('nav.management'),
        items: [
          { icon: Users, label: t('nav.userManagement'), path: '/users', color: c.primary },
          { icon: Smartphone, label: t('nav.deviceManagement'), path: '/devices', color: '#D97706' },
          { icon: GraduationCap, label: t('nav.academicStructure'), path: '/academic', color: '#16A34A' },
          { icon: UserPlus, label: t('nav.enrollmentManager'), path: '/enrollment-manager', color: '#2DA8FF' },
        ],
      },
      {
        title: t('nav.operations'),
        items: [
          { icon: DollarSign, label: t('nav.credits'), path: '/admin-credits', color: '#16A34A' },
          { icon: Database,   label: t('nav.storageMonitor'),path: '/storage',        color: '#2DA8FF' },
        ],
      },
      {
        title: t('nav.ledgerHistory'),
        items: [
          { icon: BarChart2,     label: t('nav.ledgerDashboard'),  path: '/ledger-dashboard',  color: c.primary  },
          { icon: CreditCard,   label: t('nav.creditHistory'),     path: '/credit-history',    color: '#16A34A'  },
          { icon: UsersRound,   label: t('nav.bulkCredits'),       path: '/bulk-credits',      color: '#16A34A'  },
          { icon: Upload,       label: t('nav.bulkImport'),        path: '/bulk-import',       color: '#0EA5E9'  },
        ],
      },
      {
        title: t('nav.analytics'),
        items: [
          { icon: TrendingUp,    label: t('nav.creditAnalytics'),  path: '/credit-analytics',  color: c.primary  },
          { icon: DollarSign,    label: t('nav.revenueAnalytics'), path: '/revenue-analytics', color: '#16A34A'  },
          // Unique student accounts vs actual enrollments — two metrics, one screen.
          { icon: GraduationCap, label: t('nav.enrollmentStats'),  path: '/enrollment-stats',  color: '#7C3AED'  },
          { icon: AlertTriangle, label: t('nav.fraudAlerts'),      path: '/fraud-alerts',   color: '#DC2626'  },
        ],
      },
      {
        title: t('nav.tools'),
        items: [
          { icon: Search, label: t('nav.globalSearch'), path: '/global-search', color: c.primary },
          { icon: Megaphone, label: t('nav.notifications'), path: '/notifications-center', color: '#D97706' },
          { icon: FileText, label: t('nav.cmsPages'), path: '/cms', color: '#16A34A' },
          { icon: Shield, label: t('nav.auditTrail'), path: '/sa-audit', color: '#DC2626' },
          { icon: FileText, label: t('nav.reports'), path: '/reports', color: '#7C3AED' },
        ],
      },
      {
        title: t('nav.settings'),
        items: [
          { icon: Settings, label: t('nav.settings'), path: '/admin-settings', color: '#6B7280' },
          ...commonBottom.items,
        ],
      },
    ];
  }

  // ── super_admin ────────────────────────────────────────────────────────
  // IA (consolidated): the previous drawer listed ~45 flat items across 7
  // sections. Related features now live behind HUB screens; the drawer keeps
  // high-frequency destinations plus the hubs. Every destination remains
  // reachable — routes are unchanged, only the menu structure changed.
  //
  //   Dashboard: Overview, Analytics (top-level, high frequency)
  //   Users & Access hub → /sa-platform (Users & Access section)
  //   Finance & Credits hub → /sa-finance (Revenue + Credits sections)
  //   Content & Media hub → /sa-content (10 content screens)
  //   Monitoring & Health → /health, /sa-audit, reports (video diagnostics consolidated in Video Settings)
  //   Platform & Settings hub → /sa-platform (everything else)
  return [
    {
      title: t('nav.dashboard'),
      items: [
        { icon: LayoutDashboard, label: t('nav.overview'),      path: '/sa-overview',  color: c.primary },
        { icon: Activity,        label: t('nav.analytics'),     path: '/sa-analytics', color: '#16A34A' },
        { icon: Users,           label: t('nav.allUsers'),     path: '/sa-users',     color: c.primary },
      ],
    },
    {
      title: t('nav.operations'),
      items: [
        { icon: DollarSign,    label: t('nav.finance'),  path: '/sa-finance',      color: '#16A34A'  },
        { icon: Ticket,        label: t('nav.redeemCodes'),       path: '/sa-redeem-codes', color: '#7C3AED'  },
        { icon: Video,         label: t('nav.contentMedia'),    path: '/sa-content',      color: '#7C3AED'  },
        { icon: GraduationCap, label: t('nav.academicStructure'), path: '/sa-academic',     color: '#2DA8FF'  },
      ],
    },
    {
      title: t('nav.sectionMonitoring'),
      items: [
        { icon: HeartPulse,   label: t('nav.systemHealth'),      path: '/health',             color: '#DC2626'  },
        { icon: ShieldAlert,  label: t('nav.securityDashboard'), path: '/sec-dashboard',      color: '#EF4444'  },
        { icon: Shield,       label: t('nav.auditTrail'),        path: '/sa-audit',           color: '#DC2626'  },
        { icon: FileText,     label: t('nav.reportsExport'),   path: '/sa-reports',         color: '#7C3AED'  },
      ],
    },
    {
      title: t('nav.sectionPlatform'),
      items: [
        { icon: Settings,     label: t('nav.platformSettings'), path: '/sa-platform',       color: '#6B7280'  },
        { icon: CloudUpload,  label: t('nav.appUpdates'),       path: '/app-updates',       color: '#0EA5E9'  },
        { icon: Search,       label: t('nav.globalSearch'),     path: '/sa-global-search',  color: c.primary  },
        { icon: User,         label: t('nav.editProfile'),      path: '/edit-profile',      color: '#7C3AED'  },
        { icon: Lock,         label: t('nav.mySecurity'),       path: '/security',          color: '#DC2626'  },
      ],
    },
  ];
}

// ── Global connectivity badge (drawer header) ───────────────────────────────
function ConnectivityBadge({ isDark, c }: { isDark: boolean; c: typeof neuColors.light }) {
  const online = useConnectivity();
  const isOnline = online === true;
  const isOffline = online === false;
  const bg = isOffline ? '#FFB0201F' : isOnline ? '#22C55E1F' : isDark ? 'rgba(255,255,255,0.05)' : 'rgba(8,26,53,0.05)';
  const fg = isOffline ? '#FFB020' : isOnline ? '#22C55E' : c.text;
  const label = isOffline ? t('common.offline') : isOnline ? t('common.online') : t('common.checking');
  return (
    <View
      accessibilityLabel={`${t('common.connectionStatus')}: ${label}`}
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row', alignItems: 'center', gap: 6,
        marginHorizontal: spacing.lg - spacing.xs,
        marginTop: 2, marginBottom: spacing.md - spacing.xs,
        paddingHorizontal: 10, paddingVertical: 5,
        borderRadius: radius.full,
        backgroundColor: bg,
      }}
    >
      <View style={{ width: 7, height: 7, borderRadius: radius.full, backgroundColor: fg, opacity: online === null ? 0.4 : 1 }} />
      <Text style={{ fontSize: 11, fontWeight: '800', color: fg, letterSpacing: 0.4, textTransform: 'uppercase' }}>{label}</Text>
    </View>
  );
}

// ── Nav item row ──────────────────────────────────────────────────────────
function NavItem({ item, onPress, c, isDark, active }: { item: NavItemType; onPress: () => void; c: typeof neuColors.light; isDark: boolean; active?: boolean }) {
  const [pressed, setPressed] = useState(false);
  const { isRTL, tCount } = useTranslation();
  // Chevrons are images: they are NOT mirrored by the layout engine, so the
  // "go forward" arrow must be chosen from the direction explicitly.
  const Chevron = isRTL ? ChevronLeft : ChevronRight;
  // Active/inactive separation. In Light both states keep today's exact
  // treatment (opaque text, the 1F tint). In Dark the selected row gets a
  // stronger brand tint AND full-strength label, while unselected rows step
  // down to the readable `textMuted` tier — so "where am I?" is answerable at
  // a glance without dimming anything below legibility.
  const tint = item.color ?? c.primary;
  const labelColor = isDark ? (active ? c.text : c.textMuted) : c.text;
  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      accessibilityLabel={item.label}
      accessibilityRole="button"
      style={{
        flexDirection: 'row', alignItems: 'center', gap: spacing.sm + spacing.xs,
        paddingHorizontal: spacing.lg, paddingVertical: spacing.sm + spacing.xs,
        marginHorizontal: spacing.sm, marginBottom: 1,
        borderRadius: radius.md,
        // Active rows also carry a brand rule on the INLINE-START edge (left in
        // LTR, right in RTL) which survives the low-contrast tint overlay that
        // launchers/theme layers may flatten. `borderStart*` is direction-aware;
        // the old `borderLeft*` stayed on the left in Arabic.
        borderStartWidth: isDark && active ? 2 : 0,
        borderStartColor: isDark && active ? tint : 'transparent',
        backgroundColor: active
          ? `${tint}${isDark ? '2B' : '1F'}`
          : pressed ? `${tint}18` : 'transparent',
      }}
    >
      <View style={{
        ...iconContainer.sm,
        backgroundColor: `${tint}${isDark && active ? '30' : '18'}`,
        alignItems: 'center', justifyContent: 'center',
      }}>
        <item.icon size={iconContainer.xs.width / 2 + 2} color={tint} />
      </View>
      <Text style={{ flex: 1, ...typography.labelSm, color: labelColor, fontWeight: isDark && active ? '700' : typography.labelSm.fontWeight }}>{item.label}</Text>
      {!!item.badge && item.badge > 0 && (
        <View
          accessibilityLabel={tCount('common.items', item.badge)}
          style={{
            minWidth: 20, height: 20, borderRadius: radius.full,
            paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center',
            backgroundColor: `${tint}${isDark ? '33' : '26'}`,
          }}
        >
          <Text style={{ fontSize: 11, fontWeight: '800', color: tint }}>
            {item.badge > 99 ? '99+' : item.badge}
          </Text>
        </View>
      )}
      <Chevron size={iconContainer.xs.width / 2} color={`${c.text}${isDark ? '40' : '33'}`} />
    </Pressable>
  );
}

function LogoutRow({ onPress, c }: { onPress: () => void; c: NeuPalette }) {
  const [pressed, setPressed] = useState(false);
  // `c.danger` is #DC2626 in Light (byte-identical to the old literal) and
  // #F87171 in Dark. The darker light-mode red only reaches 3.4:1 against the
  // dark sidebar surface — below AA for a label — while the dark token is 6.1:1.
  const danger = c.danger;
  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      accessibilityLabel={t('common.signOut')}
      accessibilityRole="button"
      style={{
        flexDirection: 'row', alignItems: 'center', gap: spacing.sm + spacing.xs,
        paddingHorizontal: spacing.lg, paddingVertical: spacing.sm + spacing.xs,
        borderRadius: radius.md,
        backgroundColor: pressed ? `${danger}15` : 'transparent',
      }}
    >
      <View style={{ ...iconContainer.sm, backgroundColor: `${danger}18`, alignItems: 'center', justifyContent: 'center' }}>
        <LogOut size={iconContainer.xs.width / 2 + 2} color={danger} />
      </View>
      <Text style={{ flex: 1, ...typography.labelSm, color: danger }}>{t('common.signOut')}</Text>
    </Pressable>
  );
}

export default function DrawerNav() {
  const { isOpen, closeDrawer } = useDrawer();
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { profile } = useProfileStore();
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();

  // Responsive drawer width: wider on tablets/iPads, standard on phones
  const { width: screenWidth } = useWindowDimensions();
  const isTablet = screenWidth >= 768;
  const DRAWER_WIDTH = isTablet ? 320 : 290;

  // Direction geometry — ONE source of truth for the panel edge, slide offsets,
  // backdrop side, border/shadow direction and chevron orientation. Physical
  // `left`/`-width` values were the RTL bug: React Native never mirrors them.
  const { isRTL } = useTranslation();
  const dir = drawerDirection(isRTL, DRAWER_WIDTH);

  const slideAnim = useRef(new Animated.Value(dir.closedOffset)).current;
  const overlayAnim = useRef(new Animated.Value(0)).current;
  // Track whether the component should remain mounted during close animation.
  // Without this, the component unmounts instantly on close (return null below)
  // and the overlay fade-out is cut short, creating a visual "two layers" effect
  // where the drawer appears to float without its dark backdrop.
  const [shouldRender, setShouldRender] = useState(isOpen);
  const shouldRenderRef = useRef(shouldRender);
  shouldRenderRef.current = shouldRender;

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      overlayAnim.setValue(0);
      slideAnim.setValue(dir.closedOffset);
    }
    Animated.parallel([
      Animated.spring(slideAnim, {
        // Closed offset follows the panel's own edge: negative off-screen to the
        // left in LTR, positive off-screen to the right in RTL.
        toValue: isOpen ? dir.openOffset : dir.closedOffset,
        useNativeDriver: true,
        tension: 68,
        friction: 12,
      }),
      Animated.timing(overlayAnim, {
        toValue: isOpen ? 1 : 0,
        // Match the spring's settling time (~400ms) so overlay and drawer
        // panel close in sync — eliminates the "two layers" visual artifact.
        duration: 400,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      // After the close animation finishes, allow the component to unmount.
      if (finished && !isOpen && shouldRenderRef.current) {
        setShouldRender(false);
      }
    });
  }, [isOpen, slideAnim, overlayAnim, dir.closedOffset, dir.openOffset]);

  const navigate = (path: string) => {
    closeDrawer();
    // Navigate immediately using canonical runtime paths. Delaying navigation
    // leaves the drawer animation and navigator state racing on web.
    router.push(path as RelativePathString);
  };

  const handleLogout = async () => {
    const _t0 = Date.now();
    console.log('[AUTH] logout started');
    closeDrawer();

    // ── Step 1: Cancel any pending push-token retry (synchronous, instant) ──
    cancelPushTokenRetry();
    console.log('[AUTH] push token retry cancelled', `duration=${Date.now() - _t0}ms`);

    // ── Step 2: Wipe local state IMMEDIATELY ─────────────────────────────────
    // clearProfile() here prevents _layout.tsx role-redirect from firing
    // with stale role data while a new session is being established later.
    // This is SYNCHRONOUS — no await, no network, instant state change.
    useProfileStore.getState().clearProfile();
    console.log('[AUTH] profile store cleared', `duration=${Date.now() - _t0}ms`);

    // ── Step 3: Clear local session tokens immediately (scope:'local') ───────
    //
    // ROOT CAUSE OF LOGOUT DELAY:
    // The previous code ran TWO sequential network operations before clearing
    // local state:
    //   1. await unregisterPushToken()  → backendClient.functions.invoke('device-binding')
    //      = a full Edge Function HTTP round-trip (~200–2000ms on cellular)
    //   2. setTimeout(backendClient.auth.signOut, 200)  → scope:'global' (default)
    //      = a POST to the PHP logout route, invalidating the server session
    //        sessions for this user. On slow networks this can take 1–5+ seconds.
    //
    // The user was stuck visually inside the authenticated app for the entire
    // combined duration of these two network calls before any navigation occurred.
    //
    // FIX: Use scope:'local' which:
    //   1. Calls this.admin.signOut(accessToken, 'local') — still sends the
    //      server request to invalidate THIS session's refresh token on the server.
    //   2. Regardless of whether the server call succeeds or fails (404/401/403
    //      are all silently ignored per GoTrueClient._signOut()), it ALWAYS calls
    //      _removeSession() which synchronously wipes the local token from
    //      SecureStore/AsyncStorage and fires the SIGNED_OUT auth state event.
    //   3. The SIGNED_OUT event reaches SessionProvider's onAuthStateChange →
    //      setSession(null) → Stack.Protected guard={!!session} becomes false →
    //      expo-router immediately unmounts  and shows the login screen.
    //
    // The server-side logout (invalidating the current session's refresh token)
    // still happens — it just doesn't BLOCK navigation anymore.
    // The push-token cleanup runs as a parallel fire-and-forget.
    //
    // Other-device sessions are NOT revoked (that is scope:'global' behavior).
    // For this app's security model, logging out one device should not force
    // all other devices offline. Use forceSignOut() in ctx.tsx for that.
    console.log('[AUTH] signOut (scope:local) started', `duration=${Date.now() - _t0}ms`);
    const signOutPromise = backendClient.auth.signOut({ scope: 'local' })
      .then(() => {
        console.log('[AUTH] signOut (scope:local) completed', `duration=${Date.now() - _t0}ms`);
      })
      .catch((e) => {
        console.warn('[AUTH_ERROR] signOut error (non-fatal — local session already cleared):', e?.message);
      });

    // ── Step 4: Push-token server cleanup — fire-and-forget ──────────────────
    // Runs in parallel with the signOut server call. Uses the current session's
    // access token which is still valid until _removeSession() runs inside
    // signOut(). In practice both promises race; if unregister wins it clears
    // the token cleanly; if signOut wins first the EF call will fail with 401
    // which is caught and swallowed — the push token expires naturally anyway.
    getInstallationId()
      .then((installationId) => unregisterPushToken(installationId))
      .then(() => {
        console.log('[AUTH] push token unregistered', `duration=${Date.now() - _t0}ms`);
      })
      .catch(() => { /* non-fatal — server token expires naturally */ });

    // Await signOut so the SIGNED_OUT event fires before this handler returns.
    // Navigation is driven by SessionProvider's onAuthStateChange (which receives
    // the SIGNED_OUT event and sets session→null, triggering Stack.Protected to
    // unmount the app shell). We do NOT call router.replace here — that would
    // create a race between the navigation from this handler and the navigation
    // from the Stack.Protected guard, causing a double-redirect.
    await signOutPromise;
    console.log('[AUTH] logout completed', `total=${Date.now() - _t0}ms`);
  };

  const role = (profile?.role ?? 'student') as import('@/lib/enums').UserRole;
  const earningsEnabled = !!(profile as any)?.earnings_enabled;
  // Platform flag (server-authoritative). Read synchronously from the
  // featureFlags cache; the app shell keeps it fresh on mount + foreground, so
  // a Super Admin toggle is reflected without restart or reinstall.
  const platformEarningsOn = isFeatureEnabled('doctor_earnings');
  const baseSections = getNavSections(role, c, earningsEnabled, platformEarningsOn);

  // Offline Videos drawer item is a PLAIN navigation row (UI decision): no
  // numeric badge. Download counts remain available internally via
  // offlineVideoService for the library/management screens — only the drawer
  // indicator was removed.
  const sections = baseSections;

  const roleBadgeColor: Record<import('@/lib/enums').UserRole, string> = {
    student:     '#7C3AED',
    doctor:      '#16A34A',
    assistant:   '#2DA8FF',
    admin:       '#1E90FF',
    super_admin: '#DC2626',
  };

  // Role labels are translated at render (never a hardcoded English table).
  // The stored role VALUE is untouched — permissions/routing keep using it.
  const roleLabelKey: Record<import('@/lib/enums').UserRole, string> = {
    student:     'role.student',
    doctor:      'role.doctor',
    assistant:   'role.assistant',
    admin:       'role.admin',
    super_admin: 'role.super_admin',
  };

  // Prefer an Arabic name field when the backend provides one; otherwise show
  // the single stored name verbatim (never transliterate a proper name).
  const accountName =
    (profile as any)?.full_name_ar?.trim?.() || profile?.full_name?.trim() || t('common.user');

  // Keep the component mounted during the close animation so the overlay
  // fade-out completes visually before unmounting. Once shouldRender is false
  // (set by the animation start callback above), the component unmounts cleanly.
  if (!shouldRender && Platform.OS !== 'web') return null;

  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999, pointerEvents: isOpen ? 'auto' : 'none' }}>
      {/* Overlay — only covers the area to the RIGHT of the drawer panel.
          This prevents the animated opacity from intercepting pointer events
          on the drawer panel itself (z-index alone is unreliable on web when
          both elements create compositing layers via Animated). */}
      <Animated.View
        style={[
          { position: 'absolute', top: 0, bottom: 0, zIndex: 1, backgroundColor: '#000',
            opacity: overlayAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.5] }) },
          // Backdrop covers the side the panel does NOT occupy: right of a
          // left-hand panel (LTR), left of a right-hand panel (RTL).
          backdropEdgeStyle(dir),
        ]}
      >
        <Pressable style={{ flex: 1 }} onPress={closeDrawer} accessibilityLabel={t('nav.closeMenu')} accessibilityRole="button" />
      </Animated.View>

      {/* Drawer panel — zIndex:2 ensures it always renders above the overlay */}
      <Animated.View
        style={{
          position: 'absolute', top: 0, bottom: 0,
          // Pinned to the direction's own edge (right in RTL) — not `left: 0`.
          ...panelEdgeStyle(dir),
          zIndex: 2,
          width: DRAWER_WIDTH,
          // The sidebar is its own layer of the ladder, not the page colour:
          // painting `base` made the drawer dissolve into the screen behind it.
          backgroundColor: c.navSurface,
          // Inner hairline on the edge facing the content.
          ...(dir.borderEdge === 'left'
            ? { borderLeftWidth: isDark ? 1 : 0, borderLeftColor: c.border }
            : { borderRightWidth: isDark ? 1 : 0, borderRightColor: c.border }),
          transform: [{ translateX: slideAnim }],
          ...Platform.select({
            ios: {
              shadowColor: c.shadowDark,
              shadowOffset: { width: 8 * dir.shadowSign, height: 0 },
              shadowOpacity: 0.7,
              shadowRadius: 20,
            },
            android: { elevation: 20 },
            web: { boxShadow: [{ offsetX: 8 * dir.shadowSign, offsetY: 0, blurRadius: 24, color: c.shadowDark }] },
          }),
        }}
      >
        <ScrollView showsVerticalScrollIndicator={false}>

          {/* ── Drawer Header ──────────────────────────────────────────────
              Three-zone layout (Notion / Linear / GitHub style):
              [A] Brand zone  — logo is the visual hero
              [B] Profile zone — user identity, compact and confident
              [C] Hairline divider — subtle separation before nav items
          ──────────────────────────────────────────────────────────────── */}
          <View>

            {/* Zone A — Brand + close button */}
            <View style={{
              paddingHorizontal: spacing.xl,
              paddingTop: insets.top + spacing.lg,
              paddingBottom: spacing.lg + spacing.xs,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
              <BrandLogo variant="drawer" size={isTablet ? 56 : 48} />

              {/* Close button — neumorphic pill */}
              <Pressable
                onPress={closeDrawer}
                accessibilityLabel={t('nav.closeMenu')}
                accessibilityRole="button"
                style={({ pressed }) => ({
                  ...iconContainer.sm,
                  // Recessed step, so the pill stays visible against the sidebar
                  // (it was the sidebar's own colour before).
                  backgroundColor: c.inputSurface,
                  borderWidth: isDark ? 1 : 0,
                  borderColor: c.borderSoft,
                  alignItems: 'center', justifyContent: 'center',
                  opacity: pressed ? 0.6 : 1,
                  ...Platform.select({
                    ios: {
                      shadowColor: c.shadowDark,
                      shadowOffset: { width: 2, height: 2 },
                      shadowOpacity: 0.55,
                      shadowRadius: 5,
                    },
                    android: { elevation: 3 },
                    web: { boxShadow: [{ offsetX: 2, offsetY: 2, blurRadius: 6, color: c.shadowDark }] },
                  }),
                })}
              >
                <X size={iconContainer.xs.width / 2} color={`${c.text}80`} />
              </Pressable>
            </View>

            {/* Zone B — User identity card */}
            <View style={{
              marginHorizontal: spacing.lg - spacing.xs,
              marginBottom: spacing.lg - spacing.xs,
              borderRadius: radius.lg,
              // The PROFILE section gets its own rung: a real raised card on the
              // sidebar (dark) / today's wash (light). A 4%-white film over a
              // 10%-lightness navy was indistinguishable from the sidebar itself.
              backgroundColor: isDark
                ? c.surface
                : 'rgba(8,26,53,0.04)',
              borderWidth: 1,
              borderColor: isDark
                ? c.border
                : 'rgba(8,26,53,0.06)',
              paddingHorizontal: spacing.lg - spacing.xs,
              paddingVertical: spacing.md,
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.md,
            }}>
              {/* Avatar blob */}
              <View style={{
                ...iconContainer.md,
                backgroundColor: `${roleBadgeColor[role]}18`,
                alignItems: 'center', justifyContent: 'center',
                borderWidth: 1.5,
                borderColor: `${roleBadgeColor[role]}30`,
              }}>
                <Text style={{ fontSize: iconContainer.md.width * 0.48 }}>👤</Text>
              </View>

              {/* Name + role + email — the account menu identity block */}
              <View style={{ flex: 1, gap: 1 }} accessibilityLabel={accountName}>
                <Text
                  style={{ ...typography.label, color: c.text, letterSpacing: -0.2 }}
                  numberOfLines={1}
                >
                  {accountName}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 1 }}>
                  <View style={{
                    width: 6, height: 6, borderRadius: radius.full,
                    backgroundColor: roleBadgeColor[role],
                  }} />
                  <Text style={{
                    ...typography.micro,
                    fontWeight: '700',
                    color: roleBadgeColor[role],
                    letterSpacing: 0.2,
                  }}>
                    {t(roleLabelKey[role])}
                  </Text>
                </View>
                {profile?.email ? (
                  <Text
                    style={[{ ...typography.micro, marginTop: 1 }, mutedTextStyle(c, 0.4)]}
                    numberOfLines={1}
                  >
                    {/* Email is data: never translated, always LTR-friendly. */}
                    {profile.email}
                  </Text>
                ) : null}
              </View>
            </View>

            {/* Zone B2 — Global connectivity indicator: always visible, reactive.
                Online ↔ Offline flips live via NetInfo (no app restart). */}
            <ConnectivityBadge isDark={isDark} c={c} />

            {/* Zone C — Hairline divider */}
            <View style={{
              marginHorizontal: spacing.xl,
              height: 1,
              backgroundColor: isDark ? c.divider : 'rgba(8,26,53,0.07)',
            }} />
          </View>

          {/* Nav sections — bottom pad respects home-indicator safe area */}
          <View style={{ paddingBottom: safeBottom(insets.bottom, spacing.xxl) }}>
            {sections.map((section, si) => (
              <View key={si}>
                {section.title && (
                  <Text style={[{
                    ...typography.micro,
                    fontWeight: '800',
                    paddingHorizontal: spacing.xl,
                    paddingTop: spacing.xl,
                    paddingBottom: spacing.sm,
                    textTransform: 'uppercase',
                    letterSpacing: 1.2,
                  }, mutedTextStyle(c, 0.35)]}>
                    {section.title}
                  </Text>
                )}
                {section.items.map(item => (
                  <NavItem
                    key={item.path}
                    item={item}
                    onPress={() => navigate(item.path)}
                    c={c}
                    isDark={isDark}
                    // Active-route highlight: Offline Videos stays highlighted
                    // on both /offline-library and /offline-course.
                    active={pathname === item.path || (item.path === '/offline-library' && pathname?.startsWith('/offline-'))}
                  />
                ))}
              </View>
            ))}

            {/* Logout */}
            <View style={{ marginHorizontal: spacing.sm + spacing.xs, marginTop: spacing.md, borderTopWidth: 1, borderTopColor: isDark ? c.divider : `${c.text}0D`, paddingTop: spacing.md }}>
              <LogoutRow onPress={handleLogout} c={c} />
            </View>
          </View>
        </ScrollView>
      </Animated.View>
    </View>
  );
}
