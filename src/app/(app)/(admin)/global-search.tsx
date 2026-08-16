/**
 * Global Search — Admin & Super Admin
 * Searching any account opens a right-side Quick Profile Drawer.
 * Never redirects. All management happens inline via 10 tabs.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, ScrollView, TextInput, ActivityIndicator,
  useColorScheme, Pressable, Animated,
  Dimensions, KeyboardAvoidingView, Platform, Clipboard,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  Search, User, Stethoscope, UserCog, GraduationCap, BookOpen,
  Building2, Layers, X, Ban, KeyRound, Trash2, CreditCard,
  Smartphone, TrendingUp, LogIn, ShieldCheck, Wifi, WifiOff, Clock,
  Plus, Minus, Activity, Bell, LayoutDashboard, FileText, ChevronRight,
  AlertTriangle, Fingerprint, Copy, CheckCircle as CopyCheck, DollarSign,
} from 'lucide-react-native';
import {
  searchUsers, searchCourses, searchUniversities, searchFaculties, searchAcademicLevels,
  updateUserStatus, resetUserPassword, promoteToDoctor,
  getAdminUserDevices, allocateCredits, refundCredits,
  getPublicEmail,
} from '@/lib/api';
import { DeleteAccountModal } from '@/components/DeleteAccountModal';
import { displayPhoneNational } from '@/lib/phone';
import { NeuCard } from '@/components/NeuCard';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout, animation, zIndex } from '@/lib/neu';
import { useDebounce } from '@/lib/useDebounce';
import { friendlyError } from '@/lib/validation';
import { PageHeader } from '@/components/PageHeader';
import { useImpersonationStore } from '@/lib/store';
import { supabase } from '@/client/supabase';
import { CourseThumbnail } from '@/components/CourseThumbnail';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const DRAWER_WIDTH = Math.min(SCREEN_WIDTH * 0.92, 440);

// ─── Types ────────────────────────────────────────────────────────────────────
type ResultCategory = 'users' | 'courses' | 'universities' | 'faculties' | 'levels';
type DrawerTab = 'overview' | 'profile' | 'devices' | 'credits' | 'courses' | 'timeline' | 'audit' | 'notifications' | 'security' | 'actions';

const DRAWER_TABS: ({ key: DrawerTab; label: string; icon: React.ElementType })[] = [
  { key: 'overview',      label: 'Overview',      icon: LayoutDashboard },
  { key: 'profile',       label: 'Profile',        icon: User },
  { key: 'devices',       label: 'Devices',        icon: Smartphone },
  { key: 'credits',       label: 'Credits',        icon: CreditCard },
  { key: 'courses',       label: 'Courses',        icon: BookOpen },
  { key: 'timeline',      label: 'Timeline',       icon: Clock },
  { key: 'audit',         label: 'Activity',       icon: FileText },
  { key: 'notifications', label: 'Notifications',  icon: Bell },
  { key: 'security',      label: 'Security',       icon: ShieldCheck },
  { key: 'actions',       label: 'Quick Actions',  icon: Activity },
];

const ROLE_COLORS: Record<string, string> = {
  student: '#7C3AED', doctor: '#16A34A',
  admin: '#1E90FF', super_admin: '#DC2626',
};
const ROLE_ICONS: Record<string, React.ElementType> = {
  student: GraduationCap, doctor: Stethoscope,
  admin: UserCog, super_admin: UserCog,
};

// ─── ID Badge (admin / doctor inline) ────────────────────────────────────────
function WatermarkBadge({ watermarkId, c }: { watermarkId: string; c: typeof neuColors.light }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    Clipboard.setString(watermarkId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 10,
      backgroundColor: `${c.primary}0D`, borderRadius: 14,
      paddingHorizontal: 14, paddingVertical: 12, marginBottom: 4,
    }}>
      <Fingerprint size={16} color={c.primary} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 10, fontWeight: '700', color: c.primary, opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.8 }}>ID</Text>
        <Text style={{ fontSize: 15, fontWeight: '800', color: c.primary, letterSpacing: 1.4, fontVariant: ['tabular-nums'] }}>{watermarkId}</Text>
      </View>
      <Pressable onPress={handleCopy}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, paddingVertical: 6, borderRadius: 8, backgroundColor: copied ? '#16A34A18' : `${c.primary}15` }}>
        {copied ? <CopyCheck size={13} color="#16A34A" /> : <Copy size={13} color={c.primary} />}
        <Text style={{ fontSize: 11, fontWeight: '700', color: copied ? '#16A34A' : c.primary }}>{copied ? 'Copied' : 'Copy'}</Text>
      </Pressable>
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function GlobalSearchScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const { showToast } = useToast();
  const { startImpersonation } = useImpersonationStore();
  const router = useRouter();

  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 300);
  const [category, setCategory] = useState<ResultCategory>('users');
  const [userResults, setUserResults] = useState<any[]>([]);
  const [courseResults, setCourseResults] = useState<any[]>([]);
  const [uniResults, setUniResults] = useState<any[]>([]);
  const [facResults, setFacResults] = useState<any[]>([]);
  const [levelResults, setLevelResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [filterRole, setFilterRole] = useState<string | null>(null);

  // Drawer state
  const [drawerUser, setDrawerUser] = useState<any>(null);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('overview');
  const drawerAnim = useRef(new Animated.Value(DRAWER_WIDTH)).current;

  // Drawer data
  const [drawerDevices, setDrawerDevices] = useState<any[]>([]);
  const [drawerDevicesLoading, setDrawerDevicesLoading] = useState(false);
  const [drawerAuditLogs, setDrawerAuditLogs] = useState<any[]>([]);
  const [drawerAuditLoading, setDrawerAuditLoading] = useState(false);
  const [drawerActStats, setDrawerActStats] = useState<any>(null);
  const [creditAmount, setCreditAmount] = useState('');
  const [creditNotes, setCreditNotes] = useState('');
  const [creditLoading, setCreditLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // Delete modal
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);

  const openDrawer = async (user: any) => {
    setDrawerUser(user);
    setDrawerTab('overview');
    setDrawerActStats(null);
    setCreditAmount(''); setCreditNotes(''); setDeleteModalVisible(false);
    Animated.spring(drawerAnim, { toValue: 0, useNativeDriver: true, tension: 65, friction: 11 }).start();
    // Pre-load devices
    setDrawerDevicesLoading(true);
    try {
      const res = await getAdminUserDevices(user.id);
      setDrawerDevices(res?.devices ?? []);
    } catch { setDrawerDevices([]); }
    setDrawerDevicesLoading(false);
    // Pre-load audit/activity — use user-scoped RPC
    setDrawerAuditLoading(true);
    try {
      const { getUserActivity } = await import('@/lib/api');
      const { entries } = await getUserActivity({ userId: user.id, limit: 50 });
      setDrawerAuditLogs(entries);
    } catch { setDrawerAuditLogs([]); }
    setDrawerAuditLoading(false);
    // Pre-load doctor activity stats (only for doctors)
    if (user.role === 'doctor') {
      try {
        const { getDoctorActivityStats } = await import('@/lib/api');
        const stats = await getDoctorActivityStats(user.id);
        setDrawerActStats(stats);
      } catch { setDrawerActStats(null); }
    }
  };

  const closeDrawer = () => {
    Animated.timing(drawerAnim, { toValue: DRAWER_WIDTH, duration: animation.fast, useNativeDriver: true }).start(() => {
      setDrawerUser(null);
    });
  };

  const handleSearch = useCallback(async (overrideQuery?: string) => {
    const q = (overrideQuery ?? query).trim().replace(/\s+/g, ' ');
    if (!q) return;
    setLoading(true); setSearched(false); setFilterRole(null);
    try {
      const [users, courses, unis, facs, levels] = await Promise.allSettled([
        searchUsers(q),
        searchCourses(q),
        searchUniversities(q),
        searchFaculties(q),
        searchAcademicLevels(q),
      ]);
      setUserResults(users.status === 'fulfilled' ? users.value : []);
      setCourseResults(courses.status === 'fulfilled' ? courses.value : []);
      setUniResults(unis.status === 'fulfilled' ? unis.value : []);
      setFacResults(facs.status === 'fulfilled' ? facs.value : []);
      setLevelResults(levels.status === 'fulfilled' ? levels.value : []);
    } catch {}
    setLoading(false); setSearched(true);
  }, [query]);

  // Auto-search whenever debounced query changes (min 2 chars)
  useEffect(() => {
    const q = debouncedQuery.trim();
    if (q.length >= 2) {
      handleSearch(q);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery]);

  // ── Quick Actions ──────────────────────────────────────────────────────────
  const handleAction = async (key: string) => {
    if (!drawerUser) return;
    const user = drawerUser;
    setActionLoading(true);
    try {
      switch (key) {
        case 'suspend': {
          const next = user.status === 'suspended' ? 'active' : 'suspended';
          await updateUserStatus(user.id, next);
          setDrawerUser({ ...user, status: next });
          setUserResults(prev => prev.map(u => u.id === user.id ? { ...u, status: next } : u));
          showToast({ type: 'success', message: `User ${next === 'active' ? 'unsuspended' : 'suspended'}.` });
          break;
        }
        case 'pwd':
          await resetUserPassword(user.id);
          showToast({ type: 'success', message: 'Password reset email sent.' });
          break;
        case 'promote':
          await promoteToDoctor(user.id);
          setDrawerUser({ ...user, role: 'doctor' });
          setUserResults(prev => prev.map(u => u.id === user.id ? { ...u, role: 'doctor' } : u));
          showToast({ type: 'success', message: `${user.full_name} promoted to Doctor.` });
          break;
        case 'unlimited_devices':
          await supabase.from('profiles').update({ max_devices: null }).eq('id', user.id);
          setDrawerUser({ ...user, max_devices: null });
          showToast({ type: 'success', message: 'Unlimited devices granted.' });
          break;
        case 'limit_devices':
          await supabase.from('profiles').update({ max_devices: 2 }).eq('id', user.id);
          setDrawerUser({ ...user, max_devices: 2 });
          showToast({ type: 'success', message: 'Device limit set to 2.' });
          break;
        case 'delete':
          setDeleteModalVisible(true);
          break;
        case 'impersonate': {
          const { data: { session } } = await supabase.auth.getSession();
          if (!session) break;
          startImpersonation(
            session.access_token,
            session.refresh_token,
            session.user.email ?? '',
            (session.user.user_metadata?.role ?? 'admin') as import('@/lib/store').UserRole,
            user.full_name ?? '',
            user.role as import('@/lib/store').UserRole,
          );
          showToast({ type: 'success', message: `Now logged in as ${user.full_name}` });
          closeDrawer();
          break;
        }
      }
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, 'Action failed.') }); }
    setActionLoading(false);
  };

  // ── Allocate / Refund Credits ───────────────────────────────────────────────
  const handleCredits = async (type: 'add' | 'remove') => {
    if (!drawerUser || !creditAmount) return;
    setCreditLoading(true);
    try {
      const amt = parseInt(creditAmount, 10);
      if (isNaN(amt) || amt <= 0) throw new Error('Enter a valid amount.');
      if (type === 'add') {
        await allocateCredits(drawerUser.id, amt, creditNotes || 'Admin allocation');
        showToast({ type: 'success', message: `${amt} credits added.` });
      } else {
        await refundCredits(drawerUser.id, amt, creditNotes || 'Admin removal');
        showToast({ type: 'success', message: `${amt} credits removed.` });
      }
      setCreditAmount(''); setCreditNotes('');
    } catch (e) { showToast({ type: 'error', message: friendlyError(e, 'Credits action failed.') }); }
    setCreditLoading(false);
  };

  // ── Render helpers ─────────────────────────────────────────────────────────
  const renderUserRow = (item: any) => {
    const RoleIcon = ROLE_ICONS[item.role] ?? User;
    const roleColor = ROLE_COLORS[item.role] ?? c.primary;
    const isSuspended = item.status === 'suspended';
    return (
      <Pressable key={item.id} onPress={() => openDrawer(item)}>
        <NeuCard style={{ marginBottom: 8, padding: 14 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ width: 42, height: 42, borderRadius: 13, backgroundColor: `${roleColor}18`, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
              <RoleIcon size={20} color={roleColor} />
            </View>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }} numberOfLines={1}>{item.full_name}</Text>
                {isSuspended && (
                  <View style={{ backgroundColor: '#D9780618', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: '#D97706' }}>SUSPENDED</Text>
                  </View>
                )}
              </View>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }} numberOfLines={1}>{getPublicEmail(item) ?? '—'}</Text>
              {item.phone && <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{displayPhoneNational(item.phone)}</Text>}
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              <View style={{ backgroundColor: `${roleColor}18`, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 }}>
                <Text style={{ fontSize: 10, fontWeight: '700', color: roleColor, textTransform: 'uppercase' }}>{item.role?.replace('_', ' ')}</Text>
              </View>
              <ChevronRight size={14} color={c.text} opacity={0.3} />
            </View>
          </View>
        </NeuCard>
      </Pressable>
    );
  };

  const renderCategoryResults = () => {
    const filteredUsers = filterRole ? userResults.filter(u => u.role === filterRole) : userResults;
    switch (category) {
      case 'users':
        return (
          <View>
            {/* Role filter chips */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {[null, 'student', 'doctor', 'admin', 'super_admin'].map(r => (
                  <Pressable key={String(r)} onPress={() => setFilterRole(r)}
                    style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 10, backgroundColor: filterRole === r ? c.primary : `${c.text}10` }}>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: filterRole === r ? '#fff' : c.text }}>{r ? r.replace('_', ' ') : 'All'}</Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
            {filteredUsers.length === 0
              ? <Text style={{ textAlign: 'center', color: c.text, opacity: 0.4, paddingVertical: 30 }}>No users found</Text>
              : filteredUsers.map(renderUserRow)}
          </View>
        );
      case 'courses':
        return courseResults.length === 0
          ? <Text style={{ textAlign: 'center', color: c.text, opacity: 0.4, paddingVertical: 30 }}>No courses found</Text>
          : courseResults.map(item => (
            <NeuCard key={item.id} style={{ marginBottom: 8, padding: 14 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <CourseThumbnail
                  imageUrl={item.image_url ?? item.thumbnail_url ?? item.cover_url}
                  width={44}
                  height={44}
                  borderRadius={10}
                />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }}>{item.title}</Text>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>{item.doctor?.full_name} • {item.status}</Text>
                </View>
              </View>
            </NeuCard>
          ));
      case 'universities':
        return uniResults.length === 0
          ? <Text style={{ textAlign: 'center', color: c.text, opacity: 0.4, paddingVertical: 30 }}>No universities found</Text>
          : uniResults.map(item => (
            <NeuCard key={item.id} style={{ marginBottom: 8, padding: 14 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Building2 size={18} color="#D97706" style={{ marginRight: 12 }} />
                <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }}>{item.name}</Text>
              </View>
            </NeuCard>
          ));
      case 'faculties':
        return facResults.length === 0
          ? <Text style={{ textAlign: 'center', color: c.text, opacity: 0.4, paddingVertical: 30 }}>No faculties found</Text>
          : facResults.map(item => (
            <NeuCard key={item.id} style={{ marginBottom: 8, padding: 14 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <GraduationCap size={18} color="#7C3AED" style={{ marginRight: 12 }} />
                <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }}>{item.name}</Text>
                {item.university?.name && <Text style={{ fontSize: 12, color: c.text, opacity: 0.4, marginLeft: 6 }}>· {item.university.name}</Text>}
              </View>
            </NeuCard>
          ));
      case 'levels':
        return levelResults.length === 0
          ? <Text style={{ textAlign: 'center', color: c.text, opacity: 0.4, paddingVertical: 30 }}>No levels found</Text>
          : levelResults.map(item => (
            <NeuCard key={item.id} style={{ marginBottom: 8, padding: 14 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Layers size={18} color="#2DA8FF" style={{ marginRight: 12 }} />
                <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }}>{item.name}</Text>
              </View>
            </NeuCard>
          ));
    }
  };

  // ── Drawer tab content ─────────────────────────────────────────────────────
  const renderDrawerContent = () => {
    const user = drawerUser;
    if (!user) return null;
    const roleColor = ROLE_COLORS[user.role] ?? c.primary;
    const RoleIcon = ROLE_ICONS[user.role] ?? User;

    switch (drawerTab) {
      case 'overview':
        return (
          <View style={{ gap: 12 }}>
            {/* User card */}
            <NeuCard pressed radius={16} style={{ padding: 18 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                <View style={{ width: 56, height: 56, borderRadius: 18, backgroundColor: `${roleColor}20`, alignItems: 'center', justifyContent: 'center' }}>
                  <RoleIcon size={26} color={roleColor} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 18, fontWeight: '800', color: c.text }}>{user.full_name}</Text>
                  <Text style={{ fontSize: 13, color: c.text, opacity: 0.5 }}>{getPublicEmail(user) ?? '—'}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
                    <View style={{ backgroundColor: `${roleColor}18`, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 }}>
                      <Text style={{ fontSize: 11, fontWeight: '700', color: roleColor, textTransform: 'uppercase' }}>{user.role?.replace('_', ' ')}</Text>
                    </View>
                    {user.status === 'suspended' && (
                      <View style={{ backgroundColor: '#D9780618', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 }}>
                        <Text style={{ fontSize: 11, fontWeight: '700', color: '#D97706' }}>SUSPENDED</Text>
                      </View>
                    )}
                  </View>
                </View>
              </View>
            </NeuCard>
            {/* Quick stat tiles */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              {[
                { label: 'Devices', value: drawerDevicesLoading ? '…' : String(drawerDevices.length), color: '#2DA8FF' },
                { label: 'Audit Events', value: drawerAuditLoading ? '…' : String(drawerAuditLogs.length), color: '#7C3AED' },
                { label: 'Status', value: user.status === 'suspended' ? 'Suspended' : 'Active', color: user.status === 'suspended' ? '#D97706' : '#16A34A' },
                { label: 'Max Devices', value: user.max_devices == null ? '∞' : String(user.max_devices), color: c.primary },
              ].map(tile => (
                <NeuCard key={tile.label} pressed radius={12} style={{ flexBasis: '47%', padding: 14, alignItems: 'center' }}>
                  <Text style={{ fontSize: 22, fontWeight: '800', color: tile.color }}>{tile.value}</Text>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.5, marginTop: 2 }}>{tile.label}</Text>
                </NeuCard>
              ))}
            </View>
            {/* ID — shown for student accounts */}
            {user.watermark_id && user.role === 'student' && (
              <WatermarkBadge watermarkId={user.watermark_id} c={c} />
            )}
            {/* Recent audit */}
            <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, opacity: 0.5, textTransform: 'uppercase', letterSpacing: 0.5 }}>Recent Activity</Text>
            {drawerAuditLogs.slice(0, 3).map((log: any) => (
              <NeuCard key={log.id} pressed radius={12} style={{ padding: 12 }}>
                <Text style={{ fontSize: 12, fontWeight: '600', color: c.text }}>{log.action}</Text>
                <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{new Date(log.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })}</Text>
              </NeuCard>
            ))}
            {drawerAuditLogs.length === 0 && !drawerAuditLoading && (
              <Text style={{ fontSize: 13, color: c.text, opacity: 0.3, textAlign: 'center', paddingVertical: 10 }}>No recent activity</Text>
            )}
          </View>
        );

      case 'profile':
        return (
          <View style={{ gap: 8 }}>
            {/* ID — highlighted at top for admin use */}
            {user.watermark_id && (
              <WatermarkBadge watermarkId={user.watermark_id} c={c} />
            )}
            {[
              { label: 'Full Name', value: user.full_name },
              { label: 'Email', value: getPublicEmail(user) ?? '—' },
              { label: 'Phone', value: displayPhoneNational(user.phone) || '—' },
              { label: 'Role', value: user.role?.replace('_', ' ') },
              { label: 'Status', value: user.status ?? 'active' },
              { label: 'University', value: user.university?.name ?? '—' },
              { label: 'Faculty', value: user.faculty?.name ?? '—' },
              { label: 'Level', value: user.academic_level?.name ?? '—' },
              { label: 'User ID', value: user.id },
              { label: 'Created', value: user.created_at ? new Date(user.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—' },
            ].map(row => (
              <View key={row.label} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
                <Text style={{ fontSize: 13, color: c.text, opacity: 0.5, minWidth: 80, flexShrink: 0 }}>{row.label}</Text>
                <Text style={{ fontSize: 13, fontWeight: '600', color: c.text, flex: 1, textAlign: 'right' }} numberOfLines={2}>{row.value}</Text>
              </View>
            ))}
          </View>
        );

      case 'devices':
        return drawerDevicesLoading ? (
          <ActivityIndicator color={c.primary} style={{ marginTop: 30 }} />
        ) : drawerDevices.length === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 40 }}>
            <Smartphone size={40} color={c.text} opacity={0.2} style={{ marginBottom: 10 }} />
            <Text style={{ color: c.text, opacity: 0.4 }}>No devices registered</Text>
          </View>
        ) : (
          <View style={{ gap: 10 }}>
            {drawerDevices.map((d: any) => (
              <NeuCard key={d.id} pressed radius={14} style={{ padding: 14 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  {d.is_active ? <Wifi size={20} color="#16A34A" /> : <WifiOff size={20} color="#DC2626" />}
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{d.device_name ?? d.device_id ?? 'Unknown Device'}</Text>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{d.platform ?? '—'} · {d.last_seen ? new Date(d.last_seen).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</Text>
                  </View>
                  <View style={{ backgroundColor: d.is_active ? '#16A34A18' : '#DC262618', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 7 }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: d.is_active ? '#16A34A' : '#DC2626' }}>{d.is_active ? 'Active' : 'Inactive'}</Text>
                  </View>
                </View>
              </NeuCard>
            ))}
          </View>
        );

      case 'credits':
        return (
          <View style={{ gap: 12 }}>
            <NeuCard pressed radius={14} style={{ padding: 18 }}>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginBottom: 4 }}>CREDIT MANAGEMENT</Text>
              <Text style={{ fontSize: 13, color: c.text, opacity: 0.7, marginBottom: 12 }}>{"Add or remove credits for this doctor's account."}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 10, minWidth: 0, shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.4, shadowRadius: 5 }}>
                <CreditCard size={16} color={c.text} opacity={0.5} style={{ flexShrink: 0 }} />
                <TextInput value={creditAmount} onChangeText={setCreditAmount} placeholder="Amount" keyboardType="numeric" placeholderTextColor={`${c.text}44`} style={{ flex: 1, minWidth: 0, fontSize: 15, color: c.text, paddingVertical: 0 }} />
              </View>
              <View style={{ backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 14, minWidth: 0, shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.4, shadowRadius: 5 }}>
                <TextInput value={creditNotes} onChangeText={setCreditNotes} placeholder="Notes (optional)" placeholderTextColor={`${c.text}44`} style={{ flex: 1, minWidth: 0, fontSize: 14, color: c.text, paddingVertical: 0 }} />
              </View>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Pressable onPress={() => handleCredits('add')} disabled={creditLoading}
                  style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#16A34A18', paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: '#16A34A30' }}>
                  {creditLoading ? <ActivityIndicator size="small" color="#16A34A" /> : <Plus size={16} color="#16A34A" />}
                  <Text style={{ fontSize: 13, fontWeight: '700', color: '#16A34A' }}>Add Credits</Text>
                </Pressable>
                <Pressable onPress={() => handleCredits('remove')} disabled={creditLoading}
                  style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#DC262618', paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: '#DC262630' }}>
                  {creditLoading ? <ActivityIndicator size="small" color="#DC2626" /> : <Minus size={16} color="#DC2626" />}
                  <Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>Remove</Text>
                </Pressable>
              </View>
            </NeuCard>
          </View>
        );

      case 'courses':
        return (
          <View style={{ alignItems: 'center', paddingVertical: 40 }}>
            <BookOpen size={40} color={c.primary} opacity={0.3} style={{ marginBottom: 10 }} />
            <Text style={{ color: c.text, opacity: 0.5, fontSize: 14 }}>Course list for this user</Text>
            <Text style={{ color: c.text, opacity: 0.3, fontSize: 12, marginTop: 4 }}>Available via Doctor or Student management pages</Text>
          </View>
        );

      case 'timeline':
        // Timeline is doctor-only — other roles should never see this tab
        if (drawerUser?.role !== 'doctor') {
          return (
            <View style={{ alignItems: 'center', paddingVertical: 60 }}>
              <Clock size={44} color={c.text} opacity={0.15} style={{ marginBottom: 12 }} />
              <Text style={{ color: c.text, opacity: 0.35, fontSize: 14, fontWeight: '600' }}>Doctor Only</Text>
              <Text style={{ color: c.text, opacity: 0.25, fontSize: 12, marginTop: 4 }}>Activity Timeline is only available for Doctor accounts.</Text>
            </View>
          );
        }
        return (
          <View style={{ gap: 10 }}>
            {/* Open full timeline page */}
            <Pressable
              onPress={() => {
                closeDrawer();
                router.push(`/(app)/(admin)/doctor-credit-timeline?doctor_id=${drawerUser?.id}&doctor_name=${encodeURIComponent(drawerUser?.full_name ?? '')}` as any);
              }}
              style={{
                flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                backgroundColor: `${c.primary}12`, borderRadius: 14,
                paddingHorizontal: 16, paddingVertical: 12, marginBottom: 4,
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: '700', color: c.primary }}>Open Full Activity Timeline</Text>
              <ChevronRight size={16} color={c.primary} />
            </Pressable>

            {drawerActStats ? (
              <>
                {/* Credit Selling Price */}
                <NeuCard style={{ padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: '#7C3AED18', alignItems: 'center', justifyContent: 'center' }}>
                    <DollarSign size={18} color="#7C3AED" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>Credit Selling Price</Text>
                    <Text style={{ fontSize: 20, fontWeight: '900', color: '#7C3AED' }}>
                      EGP {drawerActStats.credit_selling_price}
                    </Text>
                  </View>
                </NeuCard>

                {/* Stats grid */}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {[
                    { label: 'Allocated',  value: drawerActStats.total_allocated,   color: c.primary  },
                    { label: 'Used',        value: drawerActStats.total_used,        color: '#DC2626'  },
                    { label: 'Remaining',   value: drawerActStats.remaining_credits, color: '#16A34A'  },
                    { label: 'Courses Sold',value: drawerActStats.courses_sold,      color: '#2DA8FF'  },
                    { label: 'Students',    value: drawerActStats.students_enrolled, color: '#7C3AED'  },
                    { label: 'Videos',      value: drawerActStats.videos_uploaded,   color: '#D97706'  },
                  ].map(kpi => (
                    <NeuCard key={kpi.label} style={{ flexBasis: '47%', padding: 12, alignItems: 'center' }}>
                      <Text style={{ fontSize: 20, fontWeight: '900', color: kpi.color }}>{kpi.value}</Text>
                      <Text style={{ fontSize: 10, color: c.text, opacity: 0.45, textAlign: 'center', marginTop: 2 }}>{kpi.label}</Text>
                    </NeuCard>
                  ))}
                </View>

                {/* Total Earnings */}
                <NeuCard style={{ padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: '#16A34A18', alignItems: 'center', justifyContent: 'center' }}>
                    <TrendingUp size={18} color="#16A34A" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>Total Earnings</Text>
                    <Text style={{ fontSize: 20, fontWeight: '900', color: '#16A34A' }}>
                      EGP {drawerActStats.total_earnings.toLocaleString('en-US')}
                    </Text>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.35 }}>
                      {drawerActStats.total_used} credits × EGP {drawerActStats.credit_selling_price}
                    </Text>
                  </View>
                </NeuCard>

                {/* Last login / activity */}
                <NeuCard style={{ padding: 14, gap: 8 }}>
                  {[
                    { label: 'Last Login',    value: drawerActStats.last_login  },
                    { label: 'Last Activity', value: drawerActStats.last_active },
                  ].map(row => (
                    <View key={row.label} style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Clock size={13} color={c.text} opacity={0.4} style={{ marginRight: 8 }} />
                      <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, width: 90 }}>{row.label}</Text>
                      <Text style={{ fontSize: 12, color: c.text, flex: 1 }}>
                        {row.value
                          ? new Date(row.value).toLocaleString('en-US', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
                          : '—'}
                      </Text>
                    </View>
                  ))}
                </NeuCard>
              </>
            ) : (
              <View style={{ alignItems: 'center', paddingVertical: 30 }}>
                <ActivityIndicator color={c.primary} />
              </View>
            )}
          </View>
        );

      case 'audit':
        return (
          <View style={{ gap: 8 }}>
            {/* Open full-page activity history */}
            <Pressable
              onPress={() => {
                closeDrawer();
                router.push(`/(app)/user-activity?user_id=${drawerUser?.id}&user_name=${encodeURIComponent(drawerUser?.full_name ?? 'User')}` as any);
              }}
              style={{
                flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                backgroundColor: `${c.primary}12`, borderRadius: 14,
                paddingHorizontal: 16, paddingVertical: 12, marginBottom: 4,
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: '700', color: c.primary }}>Open Full Activity History</Text>
              <ChevronRight size={16} color={c.primary} />
            </Pressable>

            {drawerAuditLoading ? <ActivityIndicator color={c.primary} /> : drawerAuditLogs.length === 0 ? (
              <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                <FileText size={40} color={c.text} opacity={0.2} style={{ marginBottom: 10 }} />
                <Text style={{ color: c.text, opacity: 0.4 }}>No recent activity</Text>
              </View>
            ) : (drawerAuditLogs as any[]).slice(0, 20).map((log: any) => {
              const aColor = (() => {
                const s = log.log_status ?? 'success';
                if (s === 'failed')  return '#DC2626';
                if (s === 'warning') return '#D97706';
                const a = (log.action ?? '').toLowerCase();
                if (a.includes('delete') || a.includes('suspend') || a.includes('reject')) return '#DC2626';
                if (a.includes('create') || a.includes('activate') || a.includes('approve') || a.includes('enroll')) return '#16A34A';
                if (a.includes('update') || a.includes('change') || a.includes('reset')) return '#D97706';
                if (a.includes('login') || a.includes('logout')) return '#2563EB';
                return '#7C3AED';
              })();
              return (
                <NeuCard key={log.id} pressed radius={12} style={{ padding: 14 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                    <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: `${aColor}18`, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Activity size={14} color={aColor} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
                        <View style={{ backgroundColor: `${aColor}18`, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 }}>
                          <Text style={{ fontSize: 10, fontWeight: '700', color: aColor, textTransform: 'uppercase', letterSpacing: 0.3 }}>
                            {(log.action ?? '').replace(/_/g, ' ')}
                          </Text>
                        </View>
                        <Text style={{ fontSize: 10, color: c.text, opacity: 0.3 }}>
                          {new Date(log.created_at).toLocaleDateString('en-US', { day: '2-digit', month: 'short' })}
                        </Text>
                      </View>
                      {log.description
                        ? <Text style={{ fontSize: 12, color: c.text, opacity: 0.75, lineHeight: 17 }} numberOfLines={2}>{log.description}</Text>
                        : log.target_name
                        ? <Text style={{ fontSize: 12, color: c.text, opacity: 0.6 }} numberOfLines={1}>{log.target_name}</Text>
                        : null
                      }
                      {log.actor_name && (
                        <Text style={{ fontSize: 11, color: c.text, opacity: 0.4, marginTop: 3 }}>
                          By: {log.actor_name}
                        </Text>
                      )}
                    </View>
                  </View>
                </NeuCard>
              );
            })}
          </View>
        );

      case 'notifications':
        return (
          <View style={{ alignItems: 'center', paddingVertical: 40 }}>
            <Bell size={40} color={c.primary} opacity={0.3} style={{ marginBottom: 10 }} />
            <Text style={{ color: c.text, opacity: 0.5, fontSize: 14 }}>Send a notification to this user</Text>
            <Text style={{ color: c.text, opacity: 0.3, fontSize: 12, marginTop: 4 }}>Use Notifications Center for targeted broadcasts</Text>
          </View>
        );

      case 'security':
        return (
          <View style={{ gap: 10 }}>
            {drawerAuditLogs
              .filter((l: any) => ['login','logout','suspend','revoke','device','auth','password','delete'].some(k => l.action?.toLowerCase().includes(k)))
              .map((log: any) => (
                <NeuCard key={log.id} pressed radius={12} style={{ padding: 14 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <AlertTriangle size={16} color="#D97706" />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: c.text }}>{log.action}</Text>
                      <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>{new Date(log.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })}</Text>
                    </View>
                  </View>
                </NeuCard>
              ))}
            {drawerAuditLogs.filter((l: any) => ['login','logout','suspend','revoke','device','auth','password','delete'].some(k => l.action?.toLowerCase().includes(k))).length === 0 && (
              <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                <ShieldCheck size={40} color="#16A34A" opacity={0.4} style={{ marginBottom: 10 }} />
                <Text style={{ color: '#16A34A', opacity: 0.7, fontSize: 14, fontWeight: '600' }}>No security events</Text>
              </View>
            )}
          </View>
        );

      case 'actions': {
        const isSuspended = drawerUser.status === 'suspended';
        const isDoctor = drawerUser.role === 'doctor';
        const isStudent = drawerUser.role === 'student';
        const ACTIONS = [
          { key: 'suspend',          label: isSuspended ? 'Unsuspend' : 'Suspend',    icon: Ban,               color: isSuspended ? '#16A34A' : '#D97706' },
          { key: 'pwd',              label: 'Reset Password',                          icon: KeyRound,          color: '#7C3AED' },
          isStudent && { key: 'promote',        label: 'Promote to Doctor',            icon: TrendingUp,        color: '#16A34A' },
          isDoctor  && { key: 'unlimited_devices', label: 'Unlimited Devices',         icon: Smartphone,        color: '#2DA8FF' },
          isDoctor  && { key: 'limit_devices',  label: 'Set Device Limit (2)',         icon: Smartphone,        color: '#6B7280' },
          drawerUser.role !== 'super_admin' && { key: 'impersonate', label: 'Login As', icon: LogIn,            color: '#D97706' },
          { key: 'delete', label: 'Delete Account', icon: Trash2, color: '#DC2626' },
        ].filter(Boolean) as ({ key: string; label: string; icon: React.ElementType; color: string })[];

        return (
          <View style={{ gap: 10 }}>
            {ACTIONS.map(action => {
              const Icon = action.icon;
              return (
                <Pressable key={action.key} onPress={() => handleAction(action.key)} disabled={actionLoading}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: 14, backgroundColor: `${action.color}10`, borderWidth: 1, borderColor: `${action.color}25` }}>
                  {actionLoading ? <ActivityIndicator size="small" color={action.color} /> : <Icon size={20} color={action.color} />}
                  <Text style={{ fontSize: 15, fontWeight: '600', color: action.color }}>{action.label}</Text>
                </Pressable>
              );
            })}
          </View>
        );
      }
    }
  };

  const categoryTabs: ({ key: ResultCategory; label: string; count: number })[] = [
    { key: 'users',        label: 'Users',        count: userResults.length },
    { key: 'courses',      label: 'Courses',      count: courseResults.length },
    { key: 'universities', label: 'Universities', count: uniResults.length },
    { key: 'faculties',    label: 'Faculties',    count: facResults.length },
    { key: 'levels',       label: 'Levels',       count: levelResults.length },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}>
        <View style={{ padding: layout.screenPx }}>
          <PageHeader title="Global Search" subtitle="Search users, courses, academic entities" accentColor={c.primary} />

          {/* Search bar */}
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: c.base, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 13, shadowColor: c.shadowDark, shadowOffset: { width: 3, height: 3 }, shadowOpacity: 0.6, shadowRadius: 8, minWidth: 0 }}>
                <Search size={18} color={c.text} opacity={0.45} style={{ marginRight: 10, flexShrink: 0 }} />
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  onSubmitEditing={() => handleSearch()}
                  returnKeyType="search"
                  placeholder="Search name, email, phone…"
                  placeholderTextColor={`${c.text}55`}
                  style={{ flex: 1, minWidth: 0, fontSize: 15, color: c.text, paddingVertical: 0 }}
                />
                {query.length > 0 && (
                  <Pressable onPress={() => { setQuery(''); setSearched(false); }} style={{ marginLeft: 6, flexShrink: 0 }}>
                    <X size={16} color={c.text} opacity={0.4} />
                  </Pressable>
                )}
              </View>
              <Pressable onPress={() => handleSearch()} style={{ backgroundColor: c.primary, width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', shadowColor: c.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8 }}>
                {loading ? <ActivityIndicator color="#fff" size="small" /> : <Search size={20} color="#fff" />}
              </Pressable>
            </View>
          </KeyboardAvoidingView>

          {/* Category tabs */}
          {searched && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {categoryTabs.map(tab => (
                  <Pressable key={tab.key} onPress={() => setCategory(tab.key)}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 12, backgroundColor: category === tab.key ? c.primary : `${c.text}10` }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: category === tab.key ? '#fff' : c.text }}>{tab.label}</Text>
                    {tab.count > 0 && (
                      <View style={{ backgroundColor: category === tab.key ? 'rgba(255,255,255,0.25)' : `${c.primary}20`, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 }}>
                        <Text style={{ fontSize: 10, fontWeight: '800', color: category === tab.key ? '#fff' : c.primary }}>{tab.count}</Text>
                      </View>
                    )}
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          )}

          {/* Results */}
          {!searched && !loading && (
            <View style={{ alignItems: 'center', paddingVertical: 60 }}>
              <Search size={52} color={c.primary} opacity={0.15} style={{ marginBottom: 14 }} />
              <Text style={{ fontSize: 16, fontWeight: '600', color: c.text, opacity: 0.4 }}>Search anything</Text>
              <Text style={{ fontSize: 13, color: c.text, opacity: 0.3, marginTop: 4 }}>Tap a result to open the Profile Drawer</Text>
            </View>
          )}
          {searched && renderCategoryResults()}
        </View>
      </ScrollView>

      {/* ── Right-side Profile Drawer ─────────────────────────────────────────── */}
      {drawerUser !== null && (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: zIndex.overlay, pointerEvents: 'box-none' }}>
          {/* Overlay */}
          <Pressable style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' }} onPress={closeDrawer} />

          {/* Drawer panel */}
          <Animated.View style={{
            position: 'absolute', top: 0, right: 0, bottom: 0, width: DRAWER_WIDTH,
            backgroundColor: c.base, transform: [{ translateX: drawerAnim }],
            shadowColor: '#000', shadowOffset: { width: -4, height: 0 }, shadowOpacity: 0.25, shadowRadius: 20,
          }}>
            {/* Drawer header */}
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: 0, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: `${c.text}10` }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 16, fontWeight: '800', color: c.text }} numberOfLines={1}>{drawerUser.full_name}</Text>
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }} numberOfLines={1}>{getPublicEmail(drawerUser) ?? '—'}</Text>
              </View>
              <Pressable onPress={closeDrawer} style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: `${c.text}10`, alignItems: 'center', justifyContent: 'center' }}>
                <X size={18} color={c.text} />
              </Pressable>
            </View>

            {/* Tab strip — Timeline only shown for doctors */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 48, borderBottomWidth: 1, borderBottomColor: `${c.text}10` }}>
              <View style={{ flexDirection: 'row', paddingHorizontal: 12, alignItems: 'center', height: 48 }}>
                {DRAWER_TABS.filter(tab =>
                  tab.key !== 'timeline' || drawerUser?.role === 'doctor'
                ).map(tab => {
                  const Icon = tab.icon;
                  const active = drawerTab === tab.key;
                  return (
                    <Pressable key={tab.key} onPress={() => setDrawerTab(tab.key)}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 8, marginRight: 4, borderRadius: 10, backgroundColor: active ? `${c.primary}18` : 'transparent' }}>
                      <Icon size={14} color={active ? c.primary : `${c.text}60`} />
                      <Text style={{ fontSize: 12, fontWeight: active ? '700' : '400', color: active ? c.primary : `${c.text}70` }}>{tab.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>

            {/* Tab body */}
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 18, paddingBottom: layout.scrollBottom() }}>
              {renderDrawerContent()}
            </ScrollView>
          </Animated.View>
        </View>
      )}

      {/* ── Delete Account Modal ── */}
      <DeleteAccountModal
        userId={drawerUser?.id ?? null}
        visible={deleteModalVisible}
        onClose={() => setDeleteModalVisible(false)}
        onDeleted={(deletedId) => {
          setUserResults(prev => prev.filter(u => u.id !== deletedId));
          setDeleteModalVisible(false);
          closeDrawer();
          showToast({ type: 'success', message: 'Account permanently deleted.' });
        }}
      />
    </View>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────
