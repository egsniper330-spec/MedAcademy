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
import { useRouter } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import {
  LayoutDashboard, BookOpen, Bell, Settings, LogOut, Users,
  Ticket, Shield, GraduationCap, Activity, Wrench,
  DollarSign, Megaphone, Search, Database, Video, FileText,
  Layers, TrendingUp, AlertTriangle, Hash, UsersRound,
  Lock, User, Smartphone, ChevronRight, X, Stethoscope,
  BarChart2, CreditCard, ClipboardList, HeartPulse, Zap, ShieldAlert,
  Upload, UserPlus, Flag, Paintbrush, Globe, Trash2, Eye,
  ShieldCheck, ShieldX, ReceiptText, AlertOctagon,
  MonitorDot, HardDrive, Download, SquareCode, HeartHandshake,
  Info, Mail,
} from 'lucide-react-native';
import { supabase } from '@/client/supabase';
import { useProfileStore } from '@/lib/store';
import { neuColors, neuMicroStyle } from '@/lib/neu';
import { spacing, radius, typography, iconContainer, safeBottom } from '@/lib/ds';
import { useDrawer } from './DrawerContext';
import { BrandLogo } from '@/components/BrandLogo';
import { getInstallationId } from '@/lib/installationId';
import { unregisterPushToken, cancelPushTokenRetry } from '@/lib/pushTokenService';

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

function getNavSections(role: string, c: typeof neuColors.light, earningsEnabled?: boolean): NavSection[] {
  const commonBottom: NavSection = {
    items: [
      { icon: Bell,       label: 'Notifications', path: '/(app)/notifications', color: c.primary },
      { icon: Smartphone, label: 'My Devices',    path: '/(app)/my-devices',    color: '#2DA8FF' },
    ],
  };

  const doctorBottom: NavSection = {
    items: [
      { icon: Bell, label: 'Notifications', path: '/(app)/notifications', color: c.primary },
    ],
  };

  const studentBottom: NavSection = {
    items: [
      { icon: Bell, label: 'Notifications', path: '/(app)/notifications', color: c.primary },
    ],
  };

  if (role === 'student') {
    return [
      {
        title: 'Student',
        items: [
          { icon: LayoutDashboard, label: 'Dashboard',     path: '/(app)/(student)/dashboard', color: c.primary  },
          { icon: BookOpen,        label: 'My Courses',    path: '/(app)/(student)/my-courses', color: '#7C3AED' },
          { icon: Ticket,          label: 'Activate Code', path: '/(app)/(student)/activate',   color: '#D97706' },
          { icon: Bell,            label: 'Notifications', path: '/(app)/notifications',         color: c.primary },
          { icon: User,            label: 'Profile',       path: '/(app)/(student)/profile',    color: '#16A34A' },
          { icon: Info,            label: 'About Us',      path: '/(app)/info/about',           color: '#2DA8FF' },
          { icon: Mail,            label: 'Contact Us',    path: '/(app)/info/contact',         color: '#7C3AED' },
        ],
      },
    ];
  }

  if (role === 'doctor') {
    return [
      {
        title: 'Doctor',
        items: [
          { icon: LayoutDashboard, label: 'Dashboard',  path: '/(app)/(doctor)/dr-overview',  color: c.primary  },
          { icon: BookOpen,        label: 'My Courses', path: '/(app)/(doctor)/courses',       color: '#7C3AED'  },
          { icon: Users,           label: 'Students',   path: '/(app)/(doctor)/students',      color: '#D97706'  },
          { icon: TrendingUp,      label: 'Earnings',   path: '/(app)/(doctor)/dr-earnings',   color: '#16A34A'  },
          { icon: Stethoscope,     label: 'Credits',    path: '/(app)/(doctor)/credits',       color: '#2DA8FF'  },
          { icon: User,            label: 'Profile',    path: '/(app)/(doctor)/dr-profile',    color: '#7C3AED'  },
        ],
      },
      doctorBottom,
    ];
  }

  if (role === 'admin') {
    return [
      {
        title: 'Dashboard',
        items: [
          { icon: LayoutDashboard, label: 'Dashboard', path: '/(app)/(admin)/admin-overview', color: c.primary },
        ],
      },
      {
        title: 'Management',
        items: [
          { icon: Users, label: 'User Management', path: '/(app)/(admin)/users', color: c.primary },
          { icon: Smartphone, label: 'Device Management', path: '/(app)/(admin)/devices', color: '#D97706' },
          { icon: GraduationCap, label: 'Academic Structure', path: '/(app)/(admin)/academic', color: '#16A34A' },
          { icon: UserPlus, label: 'Enrollment Manager', path: '/(app)/(admin)/enrollment-manager', color: '#2DA8FF' },
        ],
      },
      {
        title: 'Operations',
        items: [
          { icon: Ticket, label: 'Activation Codes', path: '/(app)/(admin)/codes', color: '#D97706' },
          { icon: DollarSign, label: 'Credits', path: '/(app)/(admin)/admin-credits', color: '#16A34A' },
          { icon: Video,      label: 'Video Monitor',  path: '/(app)/(admin)/video-monitor',  color: '#7C3AED' },
          { icon: HeartPulse, label: 'Video Health',   path: '/(app)/(admin)/video-health',   color: '#2DA8FF' },
          { icon: Database,   label: 'Storage Monitor',path: '/(app)/(admin)/storage',        color: '#2DA8FF' },
        ],
      },
      {
        title: 'Ledger & History',
        items: [
          { icon: BarChart2,     label: 'Ledger Dashboard',  path: '/(app)/(admin)/ledger-dashboard',  color: c.primary  },
          { icon: CreditCard,   label: 'Credit History',     path: '/(app)/(admin)/credit-history',    color: '#16A34A'  },
          { icon: ClipboardList,label: 'Code History',       path: '/(app)/(admin)/code-history',      color: '#D97706'  },
          { icon: UsersRound,   label: 'Bulk Credits',       path: '/(app)/(admin)/bulk-credits',      color: '#16A34A'  },
          { icon: Upload,       label: 'Bulk Import',        path: '/(app)/(admin)/bulk-import',       color: '#0EA5E9'  },
        ],
      },
      {
        title: 'Analytics',
        items: [
          { icon: TrendingUp,    label: 'Credit Analytics',  path: '/(app)/(admin)/credit-analytics',  color: c.primary  },
          { icon: DollarSign,    label: 'Revenue Analytics', path: '/(app)/(admin)/revenue-analytics', color: '#16A34A'  },
          { icon: AlertTriangle, label: 'Fraud Alerts',      path: '/(app)/(admin)/fraud-alerts',   color: '#DC2626'  },
        ],
      },
      {
        title: 'Tools',
        items: [
          { icon: Search, label: 'Global Search', path: '/(app)/(admin)/global-search', color: c.primary },
          { icon: Megaphone, label: 'Notifications', path: '/(app)/(admin)/notifications-center', color: '#D97706' },
          { icon: FileText, label: 'CMS Pages', path: '/(app)/(admin)/cms', color: '#16A34A' },
          { icon: Shield, label: 'Audit Trail', path: '/(app)/(superadmin)/sa-audit', color: '#DC2626' },
          { icon: FileText, label: 'Reports', path: '/(app)/(admin)/reports', color: '#7C3AED' },
        ],
      },
      {
        title: 'Settings',
        items: [
          { icon: Settings, label: 'Settings', path: '/(app)/(admin)/admin-settings', color: '#6B7280' },
          ...commonBottom.items,
        ],
      },
    ];
  }

  // ── super_admin ────────────────────────────────────────────────────────────
  return [
    {
      title: 'Dashboard',
      items: [
        { icon: LayoutDashboard, label: 'Overview',          path: '/(app)/(superadmin)/sa-overview',  color: c.primary },
        { icon: Activity,        label: 'Analytics',         path: '/(app)/(superadmin)/sa-analytics', color: '#16A34A' },
        { icon: HeartPulse,      label: 'System Health',     path: '/(app)/(superadmin)/health',       color: '#DC2626' },
      ],
    },
    {
      title: 'Management',
      items: [
        { icon: Users,         label: 'All Users',            path: '/(app)/(superadmin)/sa-users',           color: c.primary   },
        { icon: GraduationCap, label: 'Academic Structure',   path: '/(app)/(superadmin)/sa-academic',           color: '#2DA8FF'   },
        { icon: BookOpen,      label: 'Courses',              path: '/(app)/(superadmin)/sa-courses',            color: '#7C3AED'   },
        { icon: UserPlus,      label: 'Enrollment Manager',   path: '/(app)/(superadmin)/sa-enrollment-manager', color: '#0EA5E9'   },
        { icon: Smartphone,    label: 'Device Management',    path: '/(app)/(superadmin)/sa-devices',            color: '#D97706'   },
        { icon: HeartHandshake,label: 'Impersonation',        path: '/(app)/(superadmin)/impersonation',         color: '#2DA8FF'   },
      ],
    },
    {
      title: 'Revenue',
      items: [
        { icon: DollarSign,   label: 'Platform Revenue',    path: '/(app)/(superadmin)/revenue',                   color: '#16A34A'  },
        { icon: TrendingUp,   label: 'Revenue Analytics',  path: '/(app)/(superadmin)/sa-revenue-analytics',      color: '#2DA8FF'  },
        { icon: Globe,        label: 'Currency Settings',  path: '/(app)/(superadmin)/currency',                  color: '#2DA8FF'  },
        { icon: AlertTriangle,label: 'Fraud Alerts',       path: '/(app)/(superadmin)/sa-fraud-alerts',           color: '#DC2626'  },
        { icon: ReceiptText,  label: 'SA Finance Hub',     path: '/(app)/(superadmin)/sa-finance',                color: '#6B7280'  },
      ],
    },
    {
      title: 'Credits',
      items: [
        { icon: CreditCard,   label: 'Credits',            path: '/(app)/(superadmin)/sa-credits',                color: '#7C3AED'  },
        { icon: UsersRound,   label: 'Bulk Credits',       path: '/(app)/(superadmin)/sa-bulk-credits',           color: '#16A34A'  },
        { icon: Hash,         label: 'Activation Codes',   path: '/(app)/(superadmin)/sa-codes',                  color: '#D97706'  },
        { icon: ClipboardList,label: 'Code History',       path: '/(app)/(superadmin)/sa-code-history',           color: '#6B7280'  },
      ],
    },
    {
      title: 'Content',
      items: [
        { icon: Video,    label: 'Video Library',      path: '/(app)/(superadmin)/sa-video-library',      color: '#7C3AED'  },
        { icon: Eye,      label: 'Watermark / DRM',    path: '/(app)/(superadmin)/content-protection',    color: '#DC2626'  },
        { icon: Layers,   label: 'Video Providers',    path: '/(app)/(superadmin)/video-providers',       color: '#2DA8FF'  },
        { icon: MonitorDot,label: 'Video Monitor',     path: '/(app)/(superadmin)/sa-video-monitor',      color: '#7C3AED'  },
        { icon: HeartPulse,label: 'Video Health',      path: '/(app)/(superadmin)/sa-video-health',       color: '#16A34A'  },
        { icon: Settings, label: 'Video Settings',     path: '/(app)/(superadmin)/sa-video-settings',     color: '#6B7280'  },
        { icon: HardDrive, label: 'Storage',           path: '/(app)/(superadmin)/sa-storage',            color: '#2DA8FF'  },
        { icon: FileText, label: 'CMS Pages',          path: '/(app)/(superadmin)/sa-cms',                color: '#16A34A'  },
        { icon: Paintbrush,label: 'Branding',          path: '/(app)/(superadmin)/branding',              color: '#7C3AED'  },
      ],
    },
    {
      title: 'Monitoring',
      items: [
        { icon: BarChart2,    label: 'Analytics Hub',         path: '/(app)/(superadmin)/sa-analytics',              color: '#16A34A'  },
        { icon: FileText,     label: 'Reports',               path: '/(app)/(superadmin)/sa-reports',                color: '#7C3AED'  },
        { icon: Shield,       label: 'Audit Trail',           path: '/(app)/(superadmin)/sa-audit',                  color: '#DC2626'  },
        { icon: Database,     label: 'DB Audit',              path: '/(app)/(superadmin)/sa-db-audit',               color: '#D97706'  },
        { icon: Download,     label: 'Export Panel',          path: '/(app)/(superadmin)/sa-export-panel',           color: '#6B7280'  },
      ],
    },
    {
      title: 'Platform',
      items: [
        { icon: Megaphone,  label: 'Notifications',        path: '/(app)/(superadmin)/sa-notifications-center',  color: '#D97706'  },
        { icon: ShieldAlert,label: 'Security Dashboard',   path: '/(app)/(superadmin)/sec-dashboard',             color: '#EF4444'  },
        { icon: ShieldCheck,label: 'Security Policies',    path: '/(app)/(superadmin)/sec-policies',              color: '#DC2626'  },
        { icon: ShieldX,    label: 'Security Logs',        path: '/(app)/(superadmin)/sec-diag',                  color: '#9B1C1C'  },
        { icon: AlertOctagon,label: 'Violation Management',path: '/(app)/(superadmin)/violation-management',      color: '#D97706'  },
        { icon: Settings,   label: 'Platform Settings',    path: '/(app)/(superadmin)/sa-platform',               color: '#6B7280'  },
        { icon: Zap,        label: 'System Config',        path: '/(app)/(superadmin)/config',                    color: '#2DA8FF'  },
        { icon: HeartHandshake, label: 'Support Settings', path: '/(app)/(superadmin)/sa-support-settings',       color: '#22C55E'  },
        { icon: Flag,       label: 'Feature Flags',        path: '/(app)/(superadmin)/feature-flags',             color: '#7C3AED'  },
        { icon: Wrench,     label: 'Maintenance',          path: '/(app)/(superadmin)/maintenance',               color: '#D97706'  },
        { icon: SquareCode, label: 'System Providers',     path: '/(app)/(superadmin)/sa-system-providers',       color: '#2DA8FF'  },
        { icon: Upload,     label: 'Bulk Import',          path: '/(app)/(superadmin)/sa-bulk-import',            color: '#16A34A'  },
        { icon: Trash2,     label: 'Trash Bin',            path: '/(app)/(superadmin)/trash-bin',                 color: '#DC2626'  },
        { icon: Lock,       label: 'Delete Permissions',   path: '/(app)/(superadmin)/delete-permissions',        color: '#9B1C1C'  },
        { icon: Search,     label: 'Global Search',        path: '/(app)/(superadmin)/sa-global-search',          color: c.primary  },
        { icon: Bell,       label: 'Notifications',        path: '/(app)/notifications',                          color: c.primary  },
        { icon: User,       label: 'Edit Profile',         path: '/(app)/edit-profile',                           color: '#7C3AED'  },
        { icon: Lock,       label: 'My Security',          path: '/(app)/security',                               color: '#DC2626'  },
      ],
    },
  ];
}

// ── Nav item row ──────────────────────────────────────────────────────────────
function NavItem({ item, onPress, c }: { item: NavItemType; onPress: () => void; c: typeof neuColors.light }) {
  const [pressed, setPressed] = useState(false);
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
        backgroundColor: pressed ? `${item.color ?? c.primary}18` : 'transparent',
      }}
    >
      <View style={{
        ...iconContainer.sm,
        backgroundColor: `${item.color ?? c.primary}18`,
        alignItems: 'center', justifyContent: 'center',
      }}>
        <item.icon size={iconContainer.xs.width / 2 + 2} color={item.color ?? c.primary} />
      </View>
      <Text style={{ flex: 1, ...typography.labelSm, color: c.text }}>{item.label}</Text>
      <ChevronRight size={iconContainer.xs.width / 2} color={`${c.text}33`} />
    </Pressable>
  );
}

function LogoutRow({ onPress }: { onPress: () => void }) {
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      accessibilityLabel="Sign out"
      accessibilityRole="button"
      style={{
        flexDirection: 'row', alignItems: 'center', gap: spacing.sm + spacing.xs,
        paddingHorizontal: spacing.lg, paddingVertical: spacing.sm + spacing.xs,
        borderRadius: radius.md,
        backgroundColor: pressed ? '#DC262615' : 'transparent',
      }}
    >
      <View style={{ ...iconContainer.sm, backgroundColor: '#DC262618', alignItems: 'center', justifyContent: 'center' }}>
        <LogOut size={iconContainer.xs.width / 2 + 2} color="#DC2626" />
      </View>
      <Text style={{ flex: 1, ...typography.labelSm, color: '#DC2626' }}>Sign Out</Text>
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
  const insets = useSafeAreaInsets();

  // Responsive drawer width: wider on tablets/iPads, standard on phones
  const { width: screenWidth } = useWindowDimensions();
  const isTablet = screenWidth >= 768;
  const DRAWER_WIDTH = isTablet ? 320 : 290;

  const slideAnim = useRef(new Animated.Value(-DRAWER_WIDTH)).current;
  const overlayAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(slideAnim, {
        toValue: isOpen ? 0 : -DRAWER_WIDTH,
        useNativeDriver: true,
        tension: 68,
        friction: 12,
      }),
      Animated.timing(overlayAnim, {
        toValue: isOpen ? 1 : 0,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start();
  }, [isOpen, slideAnim, overlayAnim]);

  const navigate = (path: string) => {
    closeDrawer();
    setTimeout(() => router.push(path as RelativePathString), 50);
  };

  const handleLogout = async () => {
    const _t0 = Date.now();
    console.log('[AUTH] logout started');
    closeDrawer();

    // ── Step 1: Cancel any pending push-token retry (synchronous, instant) ──
    cancelPushTokenRetry();
    console.log('[AUTH] push token retry cancelled', `duration=${Date.now() - _t0}ms`);

    // ── Step 2: Wipe local state IMMEDIATELY ─────────────────────────────────
    // clearProfile() here prevents (app)/_layout.tsx role-redirect from firing
    // with stale role data while a new session is being established later.
    // This is SYNCHRONOUS — no await, no network, instant state change.
    useProfileStore.getState().clearProfile();
    console.log('[AUTH] profile store cleared', `duration=${Date.now() - _t0}ms`);

    // ── Step 3: Clear local session tokens immediately (scope:'local') ───────
    //
    // ROOT CAUSE OF LOGOUT DELAY:
    // The previous code ran TWO sequential network operations before clearing
    // local state:
    //   1. await unregisterPushToken()  → supabase.functions.invoke('device-binding')
    //      = a full Edge Function HTTP round-trip (~200–2000ms on cellular)
    //   2. setTimeout(supabase.auth.signOut, 200)  → scope:'global' (default)
    //      = a POST to /auth/v1/logout on the Supabase server, invalidating ALL
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
    //      expo-router immediately unmounts (app)/ and shows the login screen.
    //
    // The server-side logout (invalidating the current session's refresh token)
    // still happens — it just doesn't BLOCK navigation anymore.
    // The push-token cleanup runs as a parallel fire-and-forget.
    //
    // Other-device sessions are NOT revoked (that is scope:'global' behavior).
    // For this app's security model, logging out one device should not force
    // all other devices offline. Use forceSignOut() in ctx.tsx for that.
    console.log('[AUTH] signOut (scope:local) started', `duration=${Date.now() - _t0}ms`);
    const signOutPromise = supabase.auth.signOut({ scope: 'local' })
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
  const sections = getNavSections(role, c, earningsEnabled);

  const roleBadgeColor: Record<import('@/lib/enums').UserRole, string> = {
    student:     '#7C3AED',
    doctor:      '#16A34A',
    assistant:   '#2DA8FF',
    admin:       '#1E90FF',
    super_admin: '#DC2626',
  };

  const roleLabel: Record<import('@/lib/enums').UserRole, string> = {
    student:     'Student',
    doctor:      'Doctor',
    assistant:   'Assistant',
    admin:       'Admin',
    super_admin: 'Super Admin',
  };

  if (!isOpen && Platform.OS !== 'web') return null;

  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999, pointerEvents: isOpen ? 'auto' : 'none' }}>
      {/* Overlay */}
      <Animated.View
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000', opacity: overlayAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.5] }) }}
      >
        <Pressable style={{ flex: 1 }} onPress={closeDrawer} accessibilityLabel="Close menu" accessibilityRole="button" />
      </Animated.View>

      {/* Drawer panel */}
      <Animated.View
        style={{
          position: 'absolute', top: 0, left: 0, bottom: 0,
          width: DRAWER_WIDTH,
          backgroundColor: c.base,
          transform: [{ translateX: slideAnim }],
          ...Platform.select({
            ios: { shadowColor: c.shadowDark, shadowOffset: { width: 8, height: 0 }, shadowOpacity: 0.7, shadowRadius: 20 },
            android: { elevation: 20 },
            web: { boxShadow: [{ offsetX: 8, offsetY: 0, blurRadius: 24, color: c.shadowDark }] },
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
                accessibilityLabel="Close menu"
                accessibilityRole="button"
                style={({ pressed }) => ({
                  ...iconContainer.sm,
                  backgroundColor: c.base,
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
              backgroundColor: isDark
                ? 'rgba(255,255,255,0.04)'
                : 'rgba(8,26,53,0.04)',
              borderWidth: 1,
              borderColor: isDark
                ? 'rgba(255,255,255,0.07)'
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

              {/* Name + role + email */}
              <View style={{ flex: 1, gap: 1 }}>
                <Text
                  style={{ ...typography.label, color: c.text, letterSpacing: -0.2 }}
                  numberOfLines={1}
                >
                  {profile?.full_name?.split(' ')[0] ?? 'User'}
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
                    {roleLabel[role]}
                  </Text>
                </View>
                {profile?.email ? (
                  <Text
                    style={{ ...typography.micro, color: c.text, opacity: 0.4, marginTop: 1 }}
                    numberOfLines={1}
                  >
                    {profile.email}
                  </Text>
                ) : null}
              </View>
            </View>

            {/* Zone C — Hairline divider */}
            <View style={{
              marginHorizontal: spacing.xl,
              height: 1,
              backgroundColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(8,26,53,0.07)',
            }} />
          </View>

          {/* Nav sections — bottom pad respects home-indicator safe area */}
          <View style={{ paddingBottom: safeBottom(insets.bottom, spacing.xxl) }}>
            {sections.map((section, si) => (
              <View key={si}>
                {section.title && (
                  <Text style={{
                    ...typography.micro,
                    fontWeight: '800',
                    color: c.text,
                    opacity: 0.35,
                    paddingHorizontal: spacing.xl,
                    paddingTop: spacing.xl,
                    paddingBottom: spacing.sm,
                    textTransform: 'uppercase',
                    letterSpacing: 1.2,
                  }}>
                    {section.title}
                  </Text>
                )}
                {section.items.map(item => (
                  <NavItem key={item.path} item={item} onPress={() => navigate(item.path)} c={c} />
                ))}
              </View>
            ))}

            {/* Logout */}
            <View style={{ marginHorizontal: spacing.sm + spacing.xs, marginTop: spacing.md, borderTopWidth: 1, borderTopColor: `${c.text}0D`, paddingTop: spacing.md }}>
              <LogoutRow onPress={handleLogout} />
            </View>
          </View>
        </ScrollView>
      </Animated.View>
    </View>
  );
}
