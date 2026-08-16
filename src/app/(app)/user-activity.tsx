/**
 * user-activity.tsx — Per-User Audit Log Timeline
 *
 * Shows every audit event related to one specific user:
 *   • Actions performed BY them (login, course creation, video upload…)
 *   • Actions performed ON them (suspend, role change, enrollment…)
 *
 * Route params:
 *   user_id   (required) — UUID of the target user
 *   user_name (display)  — full name shown in the header
 *
 * Only Super Admins can reach this screen (guarded by Stack.Protected in root layout).
 */
import { useCallback, useState, useRef } from 'react';
import {
  View, Text, ScrollView, FlatList, Pressable, TextInput,
  useColorScheme, ActivityIndicator, RefreshControl, Modal,
} from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
  ArrowLeft, Clock, Search, X, User, BookOpen, Video,
  DollarSign, LogIn, Shield, Activity, CheckCircle,
  XCircle, AlertTriangle, RefreshCw, Smartphone, Lock,
  UserCheck, Ban, Settings, Filter, ChevronDown, Calendar,
} from 'lucide-react-native';
import {
  getUserActivity, getUserProfileSummary,
  type UserActivityEntry, type UserProfileSummary,
} from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, useLayout, safeBottom } from '@/lib/neu';

// ─── Constants ───────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

interface CategoryFilter { key: string; label: string; icon: React.ElementType; color: string }
const CATEGORIES: CategoryFilter[] = [
  { key: '',             label: 'All Activities',  icon: Activity,    color: '#6B7280' },
  { key: 'auth',         label: 'Authentication',  icon: LogIn,       color: '#2563EB' },
  { key: 'profile',      label: 'Profile',         icon: User,        color: '#EC4899' },
  { key: 'security',     label: 'Security',        icon: Shield,      color: '#DC2626' },
  { key: 'devices',      label: 'Devices',         icon: Smartphone,  color: '#7C3AED' },
  { key: 'courses',      label: 'Courses',         icon: BookOpen,    color: '#2DA8FF' },
  { key: 'purchases',    label: 'Purchases',       icon: DollarSign,  color: '#16A34A' },
  { key: 'admin_actions', label: 'Admin Actions',  icon: Settings,    color: '#D97706' },
  { key: 'roles',        label: 'Role Changes',    icon: UserCheck,   color: '#2DA8FF' },
  { key: 'blocking',     label: 'Blocking',        icon: Ban,         color: '#DC2626' },
  { key: 'system',       label: 'System',          icon: Lock,        color: '#6B7280' },
];

interface DirectionOption { key: string; label: string }
const DIRECTIONS: DirectionOption[] = [
  { key: '',   label: 'Everything'               },
  { key: 'by', label: 'Actions by this user'     },
  { key: 'on', label: 'Actions on this user'     },
];

interface DatePreset { key: string; label: string }
const DATE_PRESETS: DatePreset[] = [
  { key: '',      label: 'All Time'    },
  { key: 'today', label: 'Today'       },
  { key: '7d',    label: 'Last 7 Days' },
  { key: '30d',   label: 'Last 30 Days'},
];

const ROLE_COLOR: Record<string, string> = {
  student: '#7C3AED', doctor: '#16A34A',
  admin: '#1E90FF', super_admin: '#DC2626',
};
const STATUS_COLOR: Record<string, string> = {
  active: '#16A34A', suspended: '#DC2626', blocked: '#DC2626',
  inactive: '#6B7280', banned: '#DC2626', pending: '#D97706',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function actionLabel(a: string) {
  return a.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function actionColor(action: string, status: string): string {
  if (status === 'failed')  return '#DC2626';
  if (status === 'warning') return '#D97706';
  const a = action.toLowerCase();
  if (a.includes('delete') || a.includes('suspend') || a.includes('revoke') || a.includes('reject') || a.includes('block')) return '#DC2626';
  if (a.includes('create') || a.includes('grant') || a.includes('activate') || a.includes('approve') || a.includes('publish') || a.includes('enroll') || a.includes('redeem') || a.includes('unblock')) return '#16A34A';
  if (a.includes('update') || a.includes('edit') || a.includes('change') || a.includes('reset') || a.includes('replace')) return '#D97706';
  if (a.includes('login') || a.includes('logout') || a.includes('auth') || a.includes('impersonat')) return '#2563EB';
  if (a.includes('video') || a.includes('upload') || a.includes('pdf')) return '#D97706';
  if (a.includes('credit') || a.includes('earning') || a.includes('payment') || a.includes('code')) return '#16A34A';
  if (a.includes('device')) return '#7C3AED';
  if (a.includes('role') || a.includes('doctor') || a.includes('admin')) return '#2DA8FF';
  return '#7C3AED';
}

function formatTs(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' })
    + '  '
    + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function formatTsShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' })
    + '  '
    + new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

/** Convert a date preset key to { dateFrom, dateTo } ISO strings */
function presetToDateRange(preset: string): { dateFrom?: string; dateTo?: string } {
  if (!preset) return {};
  const now = new Date();
  if (preset === 'today') {
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    return { dateFrom: start.toISOString(), dateTo: now.toISOString() };
  }
  const days = preset === '7d' ? 7 : 30;
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { dateFrom: from.toISOString(), dateTo: now.toISOString() };
}

// ─── Profile Header ───────────────────────────────────────────────────────────

function ProfileHeader({ profile, c }: { profile: UserProfileSummary; c: typeof neuColors.light }) {
  const layout = useLayout();
  const roleColor   = ROLE_COLOR[profile.role]   ?? '#6B7280';
  const statusColor = STATUS_COLOR[profile.status] ?? '#6B7280';
  const displayEmail = profile.profile_email ?? profile.email ?? '—';
  const initials = (profile.full_name ?? 'U').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  const avatarSize = Math.round(layout.touchTarget * 1.25);

  return (
    <NeuCard style={{ marginBottom: layout.itemGap, padding: layout.cardPx }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: layout.pad.md }}>
        <View style={{
          width: avatarSize, height: avatarSize, borderRadius: layout.cardRadius,
          backgroundColor: `${roleColor}20`, alignItems: 'center', justifyContent: 'center',
          marginRight: layout.pad.md,
        }}>
          <Text style={{ fontSize: layout.titleSize, fontWeight: '800', color: roleColor }}>{initials}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: layout.bodySize + 4, fontWeight: '800', color: c.text }}>{profile.full_name}</Text>
          <Text style={{ fontSize: layout.captionSize + 1, color: c.text, opacity: 0.5, marginTop: 2 }}>{displayEmail}</Text>
          {profile.phone && (
            <Text style={{ fontSize: layout.captionSize, color: c.text, opacity: 0.4, marginTop: 1 }}>{profile.phone}</Text>
          )}
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: layout.pad.sm, flexWrap: 'wrap', marginBottom: layout.pad.md }}>
        <View style={{ backgroundColor: `${roleColor}18`, borderRadius: layout.cardRadius / 1.5, paddingHorizontal: layout.pad.md, paddingVertical: layout.pad.xs + 1 }}>
          <Text style={{ fontSize: layout.captionSize + 1, fontWeight: '700', color: roleColor, textTransform: 'capitalize' }}>
            {profile.role.replace(/_/g, ' ')}
          </Text>
        </View>
        <View style={{ backgroundColor: `${statusColor}18`, borderRadius: layout.cardRadius / 1.5, paddingHorizontal: layout.pad.md, paddingVertical: layout.pad.xs + 1 }}>
          <Text style={{ fontSize: layout.captionSize + 1, fontWeight: '700', color: statusColor, textTransform: 'capitalize' }}>
            {profile.status}
          </Text>
        </View>
      </View>

      <View style={{ gap: layout.pad.sm }}>
        {([
          ['Account Created', profile.created_at],
          ['Last Login',      profile.last_login],
          ['Last Logout',     profile.last_logout],
          ['Last Active',     profile.last_active],
        ] as [string, string | null | undefined][]).map(([label, val]) => (
          <View key={label} style={{ flexDirection: 'row' }}>
            <Text style={{ fontSize: layout.captionSize, color: c.text, opacity: 0.45, minWidth: 100, flexShrink: 0 }}>{label}</Text>
            <Text style={{ fontSize: layout.captionSize, color: c.text, flex: 1 }}>{formatTsShort(val)}</Text>
          </View>
        ))}
      </View>
    </NeuCard>
  );
}

// ─── Timeline Entry Row ───────────────────────────────────────────────────────

function TimelineRow({ entry, isLast, c }: { entry: UserActivityEntry; isLast: boolean; c: typeof neuColors.light }) {
  const layout = useLayout();
  const aColor = actionColor(entry.action, entry.log_status);
  const iconTrackSize = Math.round(layout.touchTarget * 0.88);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'stretch' }}>
      {/* Vertical track */}
      <View style={{ width: iconTrackSize + layout.pad.sm, alignItems: 'center' }}>
        <View style={{ width: iconTrackSize, height: iconTrackSize, borderRadius: layout.cardRadius / 1.3, backgroundColor: `${aColor}18`, alignItems: 'center', justifyContent: 'center' }}>
          <Clock size={Math.round(iconTrackSize * 0.44)} color={aColor} />
        </View>
        {!isLast && (
          <View style={{ width: 2, flex: 1, backgroundColor: `${c.text}0C`, marginTop: 4, marginBottom: -4, minHeight: 20 }} />
        )}
      </View>

      {/* Card */}
      <View style={{ flex: 1, marginLeft: layout.pad.md, paddingBottom: isLast ? 0 : layout.itemGap }}>
        <NeuCard style={{ padding: layout.cardPx }}>
          {/* Action badge + status */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: layout.pad.sm }}>
            <View style={{ backgroundColor: `${aColor}18`, borderRadius: layout.cardRadius / 2, paddingHorizontal: layout.pad.sm, paddingVertical: layout.pad.xs, flexShrink: 1 }}>
              <Text style={{ fontSize: layout.captionSize, fontWeight: '700', color: aColor, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                {actionLabel(entry.action)}
              </Text>
            </View>
            {entry.log_status === 'failed'
              ? <XCircle size={layout.captionSize + 2} color="#DC2626" />
              : entry.log_status === 'warning'
              ? <AlertTriangle size={layout.captionSize + 2} color="#D97706" />
              : <CheckCircle size={layout.captionSize + 2} color="#16A34A" />
            }
          </View>

          {entry.description ? (
            <Text style={{ fontSize: layout.bodySize, color: c.text, lineHeight: layout.bodySize * 1.5, marginBottom: layout.pad.sm }}>
              {entry.description}
            </Text>
          ) : entry.target_name ? (
            <Text style={{ fontSize: layout.bodySize, color: c.text, marginBottom: layout.pad.sm }}>
              <Text style={{ fontWeight: '600' }}>{entry.target_name}</Text>
              {entry.resource_type
                ? <Text style={{ color: c.text, opacity: 0.45 }}> · {entry.resource_type.replace(/_/g, ' ')}</Text>
                : null}
            </Text>
          ) : null}

          {entry.actor_name && (
            <Text style={{ fontSize: layout.captionSize, color: c.text, opacity: 0.5, marginBottom: layout.pad.xs }}>
              {`By: ${entry.actor_name}${entry.actor_role ? ` (${entry.actor_role.replace(/_/g, ' ')})` : ''}`}
            </Text>
          )}

          <Text style={{ fontSize: layout.captionSize, color: c.text, opacity: 0.35 }}>{formatTs(entry.created_at)}</Text>
        </NeuCard>
      </View>
    </View>
  );
}

// ─── Filter Pill (reusable) ───────────────────────────────────────────────────

function FilterPill({
  label, active, color, onPress, icon: Icon, c,
}: {
  label: string; active: boolean; color: string;
  onPress: () => void; icon?: React.ElementType; c: typeof neuColors.light;
}) {
  const layout = useLayout();
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityRole="button"
      style={{
        flexDirection: 'row', alignItems: 'center', gap: layout.pad.xs,
        paddingHorizontal: layout.pad.md, paddingVertical: layout.pad.sm, borderRadius: 20,
        backgroundColor: active ? color : `${c.text}0C`,
        shadowColor: active ? color : 'transparent',
        shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 5,
      }}
    >
      {Icon && <Icon size={layout.captionSize} color={active ? '#fff' : c.text} opacity={active ? 1 : 0.55} />}
      <Text style={{ fontSize: layout.captionSize, fontWeight: '600', color: active ? '#fff' : c.text, opacity: active ? 1 : 0.65 }}>
        {label}
      </Text>
    </Pressable>
  );
}

// ─── Direction Dropdown ───────────────────────────────────────────────────────

function DirectionDropdown({
  value, onChange, c,
}: {
  value: string; onChange: (v: string) => void; c: typeof neuColors.light;
}) {
  const [open, setOpen] = useState(false);
  const layout = useLayout();
  const selected = DIRECTIONS.find(d => d.key === value) ?? DIRECTIONS[0];

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityLabel={`Filter by direction: ${selected.label}`}
        accessibilityRole="button"
        style={{
          flexDirection: 'row', alignItems: 'center', gap: layout.pad.xs,
          backgroundColor: value ? c.primary : `${c.text}0C`,
          borderRadius: 20, paddingHorizontal: layout.pad.md, paddingVertical: layout.pad.sm,
          shadowColor: value ? c.primary : 'transparent',
          shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 5,
        }}
      >
        <Filter size={layout.captionSize} color={value ? '#fff' : c.text} opacity={value ? 1 : 0.55} />
        <Text style={{ fontSize: layout.captionSize, fontWeight: '600', color: value ? '#fff' : c.text, opacity: value ? 1 : 0.65 }}>
          {selected.label}
        </Text>
        <ChevronDown size={layout.captionSize - 1} color={value ? '#fff' : c.text} opacity={value ? 0.8 : 0.4} />
      </Pressable>

      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' }} onPress={() => setOpen(false)} accessibilityLabel="Close" accessibilityRole="button">
          <View style={{
            position: 'absolute', top: 180, left: layout.pad.lg, right: layout.pad.lg,
            backgroundColor: c.base, borderRadius: layout.cardRadius,
            shadowColor: c.shadowDark, shadowOffset: { width: 0, height: 8 },
            shadowOpacity: 0.5, shadowRadius: 20, overflow: 'hidden',
          }}>
            {DIRECTIONS.map((d, i) => (
              <Pressable
                key={d.key}
                onPress={() => { onChange(d.key); setOpen(false); }}
                accessibilityLabel={d.label}
                accessibilityRole="button"
                style={{
                  paddingHorizontal: layout.screenPx, paddingVertical: layout.pad.md,
                  borderBottomWidth: i < DIRECTIONS.length - 1 ? 1 : 0,
                  borderBottomColor: `${c.text}0C`,
                  backgroundColor: value === d.key ? `${c.primary}10` : 'transparent',
                }}
              >
                <Text style={{
                  fontSize: layout.bodySize, fontWeight: value === d.key ? '700' : '500',
                  color: value === d.key ? c.primary : c.text,
                }}>
                  {d.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function UserAuditLogs() {
  const scheme = useColorScheme();
  const layout = useLayout();
  const insets = layout.insets;
  const isDark  = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const router  = useRouter();

  const params   = useLocalSearchParams<{ user_id?: string; user_name?: string }>();
  const userId   = params.user_id   ?? '';
  const userName = params.user_name ?? 'User';

  const [profile,     setProfile]     = useState<UserProfileSummary | null>(null);
  const [entries,     setEntries]     = useState<UserActivityEntry[]>([]);
  const [totalCount,  setTotalCount]  = useState(0);
  const [loading,     setLoading]     = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing,  setRefreshing]  = useState(false);

  // Filters
  const [search,     setSearch]     = useState('');
  const [category,   setCategory]   = useState('');
  const [direction,  setDirection]  = useState('');   // '' | 'by' | 'on'
  const [datePreset, setDatePreset] = useState('');   // '' | 'today' | '7d' | '30d'

  const offset        = useRef(0);
  const activeSearch  = useRef('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Memoize active filter deps as primitives for useCallback
  const activeCategory  = useRef(category);
  const activeDirection = useRef(direction);
  const activeDatePreset = useRef(datePreset);

  const fetchActivity = useCallback(async (reset = false) => {
    if (!userId) return;
    const page = reset ? 0 : offset.current;
    const { dateFrom, dateTo } = presetToDateRange(activeDatePreset.current);
    try {
      const { entries: rows, totalCount: count } = await getUserActivity({
        userId,
        category:  activeCategory.current  || undefined,
        direction: activeDirection.current || undefined,
        search:    activeSearch.current    || undefined,
        dateFrom,
        dateTo,
        limit:  PAGE_SIZE,
        offset: page,
      });
      if (reset) {
        setEntries(rows);
        offset.current = rows.length;
      } else {
        setEntries(prev => [...prev, ...rows]);
        offset.current += rows.length;
      }
      setTotalCount(count);
    } catch (_) {}
  }, [userId]);

  const reload = useCallback(async () => {
    setLoading(true);
    await Promise.all([
      getUserProfileSummary(userId).then(p => setProfile(p)).catch(() => {}),
      fetchActivity(true),
    ]);
    setLoading(false);
  }, [userId, fetchActivity]);

  useFocusEffect(useCallback(() => {
    offset.current = 0;
    reload();
  }, [reload]));

  // Generic filter change handler
  const applyFilter = (updates: {
    category?: string; direction?: string; datePreset?: string;
  }) => {
    if (updates.category  !== undefined) { activeCategory.current  = updates.category;  setCategory(updates.category); }
    if (updates.direction !== undefined) { activeDirection.current = updates.direction; setDirection(updates.direction); }
    if (updates.datePreset !== undefined) { activeDatePreset.current = updates.datePreset; setDatePreset(updates.datePreset); }
    offset.current = 0;
    setLoading(true);
    fetchActivity(true).then(() => setLoading(false));
  };

  const onRefresh = async () => {
    setRefreshing(true);
    offset.current = 0;
    await reload();
    setRefreshing(false);
  };

  const loadMore = async () => {
    if (loadingMore || entries.length >= totalCount) return;
    setLoadingMore(true);
    await fetchActivity(false);
    setLoadingMore(false);
  };

  const onSearchChange = (text: string) => {
    setSearch(text);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      activeSearch.current = text;
      offset.current = 0;
      setLoading(true);
      fetchActivity(true).then(() => setLoading(false));
    }, 380);
  };

  const clearSearch = () => {
    setSearch('');
    activeSearch.current = '';
    offset.current = 0;
    setLoading(true);
    fetchActivity(true).then(() => setLoading(false));
  };

  const activeFiltersCount = [category, direction, datePreset].filter(Boolean).length;

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <View style={{
        paddingHorizontal: layout.screenPx, paddingTop: 0, paddingBottom: layout.pad.md,
        backgroundColor: c.base,
        shadowColor: c.shadowDark, shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.12, shadowRadius: 8,
      }}>
        {/* Back row + title */}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: layout.pad.md }}>
          <Pressable
            onPress={() => router.back()}
            accessibilityLabel="Go back"
            accessibilityRole="button"
            style={{
              marginRight: layout.pad.md, padding: layout.pad.sm,
              backgroundColor: `${c.text}0A`, borderRadius: layout.cardRadius / 1.5,
              shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 },
              shadowOpacity: 0.4, shadowRadius: 4,
            }}
          >
            <ArrowLeft size={layout.bodySize + 4} color={c.text} opacity={0.7} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: layout.captionSize, fontWeight: '600', color: c.text, opacity: 0.4, textTransform: 'uppercase', letterSpacing: 0.8 }}>
              Audit Logs
            </Text>
            <Text style={{ fontSize: layout.titleSize, fontWeight: '800', color: c.text, marginTop: 1 }} numberOfLines={1}>
              {userName}
            </Text>
          </View>
          {totalCount > 0 && (
            <NeuCard style={{ paddingHorizontal: layout.pad.md, paddingVertical: layout.pad.sm }}>
              <Text style={{ fontSize: layout.bodySize + 1, fontWeight: '700', color: c.primary }}>
                {totalCount.toLocaleString('en-US')}
              </Text>
            </NeuCard>
          )}
        </View>

        {/* Search bar */}
        <View style={{
          flexDirection: 'row', alignItems: 'center',
          backgroundColor: c.base, borderRadius: layout.cardRadius,
          paddingHorizontal: layout.cardPx, paddingVertical: layout.pad.md, marginBottom: layout.pad.md,
          shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 },
          shadowOpacity: 0.45, shadowRadius: 6,
        }}>
          <Search size={layout.captionSize + 2} color={c.text} opacity={0.35} />
          <TextInput
            value={search}
            onChangeText={onSearchChange}
            placeholder={`Search ${userName}'s logs…`}
            placeholderTextColor={`${c.text}45`}
            style={{ flex: 1, marginLeft: layout.pad.sm, fontSize: layout.bodySize, color: c.text }}
          />
          {search.length > 0 && (
            <Pressable onPress={clearSearch} hitSlop={8} accessibilityLabel="Clear search" accessibilityRole="button">
              <X size={layout.captionSize + 1} color={c.text} opacity={0.4} />
            </Pressable>
          )}
        </View>

        {/* Date preset row */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: layout.pad.sm }}>
          <View style={{ flexDirection: 'row', gap: layout.pad.sm, paddingRight: layout.pad.sm }}>
            {DATE_PRESETS.map(p => (
              <FilterPill
                key={p.key}
                label={p.label}
                active={datePreset === p.key}
                color="#6B7280"
                icon={Calendar}
                onPress={() => applyFilter({ datePreset: p.key })}
                c={c}
              />
            ))}
            {/* Direction dropdown — inline in same row */}
            <DirectionDropdown
              value={direction}
              onChange={v => applyFilter({ direction: v })}
              c={c}
            />
          </View>
        </ScrollView>

        {/* Activity type chips */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: 'row', gap: layout.pad.sm, paddingRight: layout.pad.sm }}>
            {CATEGORIES.map(cat => {
              const Icon = cat.icon;
              return (
                <FilterPill
                  key={cat.key}
                  label={cat.label}
                  active={category === cat.key}
                  color={cat.color}
                  icon={Icon}
                  onPress={() => applyFilter({ category: cat.key })}
                  c={c}
                />
              );
            })}
          </View>
        </ScrollView>
      </View>

      {/* Active filter summary badge */}
      {activeFiltersCount > 0 && (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: layout.screenPx, paddingTop: layout.pad.sm }}>
          <View style={{ backgroundColor: `${c.primary}12`, borderRadius: layout.cardRadius / 2, paddingHorizontal: layout.pad.md, paddingVertical: layout.pad.xs + 1 }}>
            <Text style={{ fontSize: layout.captionSize, color: c.primary, fontWeight: '600' }}>
              {activeFiltersCount} filter{activeFiltersCount > 1 ? 's' : ''} active
            </Text>
          </View>
          <Pressable
            onPress={() => applyFilter({ category: '', direction: '', datePreset: '' })}
            style={{ marginLeft: layout.pad.sm, paddingHorizontal: layout.pad.md, paddingVertical: layout.pad.xs + 1 }}
          >
            <Text style={{ fontSize: layout.captionSize, color: c.text, opacity: 0.45, fontWeight: '600' }}>Clear all</Text>
          </Pressable>
        </View>
      )}

      {/* ── Content ──────────────────────────────────────────────────── */}
      {loading ? (
        <ActivityIndicator color={c.primary} size="large" style={{ marginTop: layout.sectionGap * 2 }} />
      ) : (
        <FlatList
          data={entries}
          keyExtractor={item => item.id}
          contentContainerStyle={{ paddingHorizontal: layout.screenPx, paddingTop: layout.pad.md, paddingBottom: layout.scrollBottom() }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
          onEndReached={loadMore}
          onEndReachedThreshold={0.3}
          ListHeaderComponent={profile ? <ProfileHeader profile={profile} c={c} /> : null}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', paddingVertical: layout.sectionGap * 3 }}>
              <Clock size={Math.round(layout.touchTarget * 1.1)} color={c.primary} opacity={0.15} style={{ marginBottom: layout.pad.md }} />
              <Text style={{ fontSize: layout.bodySize + 2, fontWeight: '700', color: c.text, opacity: 0.35 }}>
                No logs found
              </Text>
              <Text style={{ fontSize: layout.bodySize, color: c.text, opacity: 0.25, marginTop: layout.pad.sm, textAlign: 'center' }}>
                {activeFiltersCount > 0
                  ? 'Try clearing some filters'
                  : `No audit events recorded for ${userName}`}
              </Text>
            </View>
          }
          ListFooterComponent={
            loadingMore ? (
              <View style={{ paddingVertical: layout.pad.lg, alignItems: 'center' }}>
                <RefreshCw size={layout.bodySize + 4} color={c.primary} opacity={0.5} />
              </View>
            ) : entries.length > 0 && entries.length < totalCount ? (
              <Pressable onPress={loadMore} style={{ paddingVertical: layout.pad.lg, alignItems: 'center' }}>
                <Text style={{ fontSize: layout.bodySize, color: c.primary, fontWeight: '600' }}>Load more</Text>
              </Pressable>
            ) : entries.length > 0 ? (
              <Text style={{ textAlign: 'center', fontSize: layout.captionSize, color: c.text, opacity: 0.3, paddingVertical: layout.pad.lg }}>
                All {totalCount.toLocaleString('en-US')} events shown
              </Text>
            ) : null
          }
          renderItem={({ item, index }) => (
            <TimelineRow entry={item} isLast={index === entries.length - 1} c={c} />
          )}
        />
      )}
    </View>
  );
}
