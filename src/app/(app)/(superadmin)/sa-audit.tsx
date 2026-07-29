/**
 * sa-audit.tsx — Complete Administrative Audit Trail (Super Admin only)
 *
 * Expandable cards with human-readable descriptions.
 * Full filters: All Events / User Management / Role Changes / Doctor / Student /
 *               Courses / Codes / Authentication / Platform
 * Time filters: Today / Last 7 Days / Last 30 Days / All Time
 * Search: by actor, by target user, by resource
 */
import { useCallback, useState, useRef } from 'react';
import {
  View, Text, ScrollView, FlatList, Pressable, TextInput,
  useColorScheme, ActivityIndicator, RefreshControl, Modal,
  LayoutAnimation,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Shield, Search, X, ChevronDown, ChevronUp, Filter,
  CheckCircle, XCircle, AlertTriangle, User, BookOpen,
  DollarSign, LogIn, Lock, RefreshCw, Users, UserCheck,
  Code, Settings, Smartphone, ArrowUpDown, Clock,
} from 'lucide-react-native';
import { getAuditTrail, AuditTrailEntry } from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { neuColors } from '@/lib/neu';
import { PageHeader } from '@/components/PageHeader';

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

interface CategoryFilter { key: string; label: string; icon: React.ElementType; color: string }

const CATEGORIES: CategoryFilter[] = [
  { key: '',         label: 'All Events',    icon: Shield,      color: '#6B7280' },
  { key: 'users',    label: 'User Mgmt',     icon: User,        color: '#7C3AED' },
  { key: 'roles',    label: 'Role Changes',  icon: ArrowUpDown, color: '#9333EA' },
  { key: 'doctor',   label: 'Doctor',        icon: UserCheck,   color: '#2DA8FF' },
  { key: 'student',  label: 'Student',       icon: Users,       color: '#2563EB' },
  { key: 'courses',  label: 'Courses',       icon: BookOpen,    color: '#D97706' },
  { key: 'codes',    label: 'Codes',         icon: Code,        color: '#16A34A' },
  { key: 'auth',     label: 'Auth',          icon: LogIn,       color: '#DC2626' },
  { key: 'platform', label: 'Platform',      icon: Settings,    color: '#0F766E' },
  { key: 'finance',  label: 'Finance',       icon: DollarSign,  color: '#065F46' },
  { key: 'security', label: 'Security',      icon: Lock,        color: '#B91C1C' },
];

const TIME_FILTERS = [
  { key: '',      label: 'All Time' },
  { key: 'today', label: 'Today'    },
  { key: '7d',    label: '7 Days'   },
  { key: '30d',   label: '30 Days'  },
];

const STATUS_FILTERS = [
  { key: '',        label: 'Any',     color: '#6B7280' },
  { key: 'success', label: 'Success', color: '#16A34A' },
  { key: 'failed',  label: 'Failed',  color: '#DC2626' },
  { key: 'warning', label: 'Warning', color: '#D97706' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function actionLabel(action: string): string {
  return action.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function actionColor(action: string, status: string): string {
  if (status === 'failed')  return '#DC2626';
  if (status === 'warning') return '#D97706';
  const a = action.toLowerCase();
  if (a.includes('delete') || a.includes('suspend') || a.includes('revoke') || a.includes('reject') || a.includes('remove') || a.includes('demot') || a.includes('block') || a.includes('disabled') || a.includes('failed')) return '#DC2626';
  if (a.includes('create') || a.includes('grant')   || a.includes('activat') || a.includes('approv') || a.includes('publish') || a.includes('restor') || a.includes('added')  || a.includes('enabl') || a.includes('promot')) return '#16A34A';
  if (a.includes('update') || a.includes('edit')    || a.includes('change')  || a.includes('reset')  || a.includes('changed') || a.includes('updated') || a.includes('transfer')) return '#D97706';
  if (a.includes('login')  || a.includes('logout')  || a.includes('auth')    || a.includes('session') || a.includes('password') || a.includes('register')) return '#2563EB';
  if (a.includes('credit') || a.includes('earning') || a.includes('payment') || a.includes('enroll')) return '#065F46';
  if (a.includes('security') || a.includes('detect') || a.includes('jailbreak') || a.includes('vpn')) return '#B91C1C';
  if (a.includes('device'))  return '#7C3AED';
  if (a.includes('role'))    return '#9333EA';
  if (a.includes('course'))  return '#D97706';
  return '#6B7280';
}

function actionIcon(action: string, color: string, size = 18) {
  const a = action.toLowerCase();
  if (a.includes('role') || a.includes('promot') || a.includes('demot')) return <ArrowUpDown size={size} color={color} />;
  if (a.includes('device')) return <Smartphone size={size} color={color} />;
  if (a.includes('course') || a.includes('lesson')) return <BookOpen size={size} color={color} />;
  if (a.includes('credit') || a.includes('earn') || a.includes('payment')) return <DollarSign size={size} color={color} />;
  if (a.includes('login') || a.includes('logout') || a.includes('auth') || a.includes('session')) return <LogIn size={size} color={color} />;
  if (a.includes('code')) return <Code size={size} color={color} />;
  if (a.includes('setting') || a.includes('platform') || a.includes('config')) return <Settings size={size} color={color} />;
  if (a.includes('security') || a.includes('lock') || a.includes('detect')) return <Lock size={size} color={color} />;
  if (a.includes('password') || a.includes('reset')) return <Lock size={size} color={color} />;
  return <User size={size} color={color} />;
}

function statusIcon(status: string, size = 13) {
  if (status === 'failed')  return <XCircle size={size} color="#DC2626" />;
  if (status === 'warning') return <AlertTriangle size={size} color="#D97706" />;
  return <CheckCircle size={size} color="#16A34A" />;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  < 1)  return 'just now';
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days  < 7)  return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fullTimestamp(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}  ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}`;
}

function timeRangeFromKey(key: string): { dateFrom?: string; dateTo?: string } {
  if (!key) return {};
  const now = new Date();
  const to  = now.toISOString();
  if (key === 'today') {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    return { dateFrom: from, dateTo: to };
  }
  if (key === '7d') {
    const from = new Date(Date.now() - 7 * 86400000).toISOString();
    return { dateFrom: from, dateTo: to };
  }
  if (key === '30d') {
    const from = new Date(Date.now() - 30 * 86400000).toISOString();
    return { dateFrom: from, dateTo: to };
  }
  return {};
}

// ─── OldNewDiff ───────────────────────────────────────────────────────────────

function OldNewDiff({ oldValues, newValues, c }: {
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  c: typeof neuColors.light;
}) {
  const allKeys = Array.from(new Set([...Object.keys(oldValues ?? {}), ...Object.keys(newValues ?? {})]));
  if (allKeys.length === 0) return null;
  return (
    <View style={{ marginTop: 4 }}>
      <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.45, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Changes</Text>
      {allKeys.map(key => {
        const oldVal = oldValues?.[key];
        const newVal = newValues?.[key];
        const changed = JSON.stringify(oldVal) !== JSON.stringify(newVal);
        return (
          <View key={key} style={{ marginBottom: 10 }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 4, textTransform: 'capitalize' }}>
              {key.replace(/_/g, ' ')}
            </Text>
            {oldVal !== undefined && (
              <View style={{ backgroundColor: '#DC262614', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, marginBottom: 3 }}>
                <Text style={{ fontSize: 12, color: '#DC2626' }}>
                  Before: {String(typeof oldVal === 'object' ? JSON.stringify(oldVal) : oldVal)}
                </Text>
              </View>
            )}
            {newVal !== undefined && changed && (
              <View style={{ backgroundColor: '#16A34A14', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}>
                <Text style={{ fontSize: 12, color: '#16A34A' }}>
                  After: {String(typeof newVal === 'object' ? JSON.stringify(newVal) : newVal)}
                </Text>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

// ─── DetailRow helper ─────────────────────────────────────────────────────────

function DetailRow({ label, value, c, mono = false }: {
  label: string; value: string; c: typeof neuColors.light; mono?: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
      <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, width: 100, flexShrink: 0 }}>{label}</Text>
      <Text style={{ fontSize: 12, color: c.text, flex: 1, fontFamily: mono ? 'monospace' : undefined }} numberOfLines={3}>{value}</Text>
    </View>
  );
}

// ─── ExpandableLogCard ────────────────────────────────────────────────────────

function ExpandableLogCard({ entry, c }: { entry: AuditTrailEntry; c: typeof neuColors.light }) {
  const [expanded, setExpanded] = useState(false);
  const aColor = actionColor(entry.action, entry.log_status);

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded(v => !v);
  };

  const extraDetails = entry.details
    ? Object.entries(entry.details).filter(([k]) =>
        !['actor_name','actor_email','actor_role','target_name','description'].includes(k))
    : [];

  return (
    <NeuCard style={{ marginBottom: 10, overflow: 'hidden' }}>
      {/* ── Collapsed row ── */}
      <Pressable onPress={toggle} style={{ padding: 14, flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        {/* Event icon */}
        <View style={{
          width: 42, height: 42, borderRadius: 14, flexShrink: 0,
          backgroundColor: `${aColor}15`, alignItems: 'center', justifyContent: 'center',
        }}>
          {actionIcon(entry.action, aColor, 18)}
        </View>

        <View style={{ flex: 1 }}>
          {/* Human-readable title from description, fallback to action label */}
          <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, lineHeight: 18, marginBottom: 3 }} numberOfLines={expanded ? undefined : 2}>
            {entry.description ?? actionLabel(entry.action)}
          </Text>

          {/* Actor · Target · Time row */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
            {entry.actor_name && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: `${aColor}20`, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ fontSize: 8, fontWeight: '800', color: aColor }}>{entry.actor_name[0]?.toUpperCase()}</Text>
                </View>
                <Text style={{ fontSize: 11, color: c.text, opacity: 0.55 }}>{entry.actor_name}</Text>
              </View>
            )}
            {entry.target_name && entry.target_name !== entry.actor_name && (
              <>
                <Text style={{ fontSize: 11, color: c.text, opacity: 0.3 }}>→</Text>
                <Text style={{ fontSize: 11, color: c.text, opacity: 0.55, fontWeight: '600' }}>{entry.target_name}</Text>
              </>
            )}
            <Text style={{ fontSize: 11, color: c.text, opacity: 0.3 }}>·</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <Clock size={10} color={c.text} opacity={0.35} />
              <Text style={{ fontSize: 11, color: c.text, opacity: 0.35 }}>{relativeTime(entry.created_at)}</Text>
            </View>
            <View style={{ marginLeft: 'auto' }}>
              {statusIcon(entry.log_status, 12)}
            </View>
          </View>
        </View>

        {/* Expand chevron */}
        <View style={{ marginTop: 2, flexShrink: 0 }}>
          {expanded
            ? <ChevronUp   size={16} color={c.text} opacity={0.3} />
            : <ChevronDown size={16} color={c.text} opacity={0.3} />}
        </View>
      </Pressable>

      {/* ── Expanded detail ── */}
      {expanded && (
        <View style={{ paddingHorizontal: 14, paddingBottom: 16, borderTopWidth: 1, borderTopColor: `${c.text}08` }}>
          {/* Action badge */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 12, marginBottom: 12 }}>
            <View style={{ backgroundColor: `${aColor}18`, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: aColor, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {actionLabel(entry.action)}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              {statusIcon(entry.log_status, 13)}
              <Text style={{ fontSize: 11, fontWeight: '600', color: entry.log_status === 'failed' ? '#DC2626' : entry.log_status === 'warning' ? '#D97706' : '#16A34A', textTransform: 'capitalize' }}>
                {entry.log_status}
              </Text>
            </View>
          </View>

          {/* Actor block */}
          <View style={{ backgroundColor: `${c.text}05`, borderRadius: 12, padding: 12, marginBottom: 10 }}>
            <Text style={{ fontSize: 10, fontWeight: '700', color: c.text, opacity: 0.4, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 }}>Actor (Performed By)</Text>
            <DetailRow label="Name"  value={entry.actor_name  ?? '—'} c={c} />
            {entry.actor_email && <DetailRow label="Email" value={entry.actor_email}  c={c} />}
            {entry.actor_role  && <DetailRow label="Role"  value={entry.actor_role.replace(/_/g, ' ')} c={c} />}
            {entry.actor_id    && <DetailRow label="ID"    value={entry.actor_id}     c={c} mono />}
          </View>

          {/* Target block */}
          {(entry.target_name || entry.resource_type || entry.resource_id) && (
            <View style={{ backgroundColor: `${c.text}05`, borderRadius: 12, padding: 12, marginBottom: 10 }}>
              <Text style={{ fontSize: 10, fontWeight: '700', color: c.text, opacity: 0.4, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 }}>Target</Text>
              {entry.target_name   && <DetailRow label="Name"     value={entry.target_name}  c={c} />}
              {entry.resource_type && <DetailRow label="Resource" value={entry.resource_type.replace(/_/g, ' ')} c={c} />}
              {entry.resource_id   && <DetailRow label="ID"       value={entry.resource_id}  c={c} mono />}
            </View>
          )}

          {/* Old / New values */}
          {(entry.old_values || entry.new_values) && (
            <View style={{ backgroundColor: `${c.text}05`, borderRadius: 12, padding: 12, marginBottom: 10 }}>
              <OldNewDiff oldValues={entry.old_values} newValues={entry.new_values} c={c} />
            </View>
          )}

          {/* Extra details */}
          {extraDetails.length > 0 && (
            <View style={{ backgroundColor: `${c.text}05`, borderRadius: 12, padding: 12, marginBottom: 10 }}>
              <Text style={{ fontSize: 10, fontWeight: '700', color: c.text, opacity: 0.4, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 }}>Additional Info</Text>
              {extraDetails.map(([k, v]) => (
                <DetailRow
                  key={k}
                  label={k.replace(/_/g, ' ')}
                  value={typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}
                  c={c}
                />
              ))}
            </View>
          )}

          {/* Timestamp / IP block */}
          <View style={{ backgroundColor: `${c.text}05`, borderRadius: 12, padding: 12 }}>
            <Text style={{ fontSize: 10, fontWeight: '700', color: c.text, opacity: 0.4, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 }}>Metadata</Text>
            <DetailRow label="Timestamp" value={fullTimestamp(entry.created_at)} c={c} />
            {entry.ip_address && <DetailRow label="IP Address" value={entry.ip_address} c={c} mono />}
          </View>
        </View>
      )}
    </NeuCard>
  );
}

// ─── SearchField ──────────────────────────────────────────────────────────────

function SearchField({ placeholder, value, onChange, c }: {
  placeholder: string; value: string; onChange: (t: string) => void; c: typeof neuColors.light;
}) {
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', flex: 1,
      backgroundColor: c.base, borderRadius: 12,
      paddingHorizontal: 10, paddingVertical: 8,
      shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 },
      shadowOpacity: 0.4, shadowRadius: 4,
    }}>
      <Search size={14} color={c.text} opacity={0.35} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={`${c.text}45`}
        style={{ flex: 1, minWidth: 0, marginLeft: 7, fontSize: 12, color: c.text }}
      />
      {value.length > 0 && (
        <Pressable onPress={() => onChange('')}>
          <X size={13} color={c.text} opacity={0.4} />
        </Pressable>
      )}
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function SAaudit() {
  const scheme = useColorScheme();
  const c = scheme === 'dark' ? neuColors.dark : neuColors.light;

  const [entries,     setEntries]    = useState<AuditTrailEntry[]>([]);
  const [totalCount,  setTotalCount] = useState(0);
  const [loading,     setLoading]    = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing,  setRefreshing] = useState(false);

  // Category + time + status filters
  const [category,    setCategory]   = useState('');
  const [timeFilter,  setTimeFilter] = useState('');
  const [logStatus,   setLogStatus]  = useState('');
  const [showFilters, setShowFilters] = useState(false);

  // Separate search fields
  const [actorSearch,    setActorSearch]    = useState('');
  const [targetSearch,   setTargetSearch]   = useState('');
  const [resourceSearch, setResourceSearch] = useState('');

  const offset = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeActor    = useRef('');
  const activeTarget   = useRef('');
  const activeResource = useRef('');

  // Build combined search: any of the three search fields concatenated with space
  const buildCombinedSearch = () => {
    const parts = [activeActor.current, activeTarget.current, activeResource.current].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : undefined;
  };

  const fetchLogs = useCallback(async (reset = false) => {
    const page = reset ? 0 : offset.current;
    const { dateFrom, dateTo } = timeRangeFromKey(timeFilter);
    try {
      const { entries: rows, totalCount: count } = await getAuditTrail({
        search:    buildCombinedSearch(),
        category:  category  || undefined,
        logStatus: logStatus || undefined,
        dateFrom,
        dateTo,
        limit:  PAGE_SIZE,
        offset: page,
      });
      if (reset) { setEntries(rows); offset.current = rows.length; }
      else       { setEntries(prev => [...prev, ...rows]); offset.current += rows.length; }
      setTotalCount(count);
    } catch (_) {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, logStatus, timeFilter]);

  const reload = useCallback(async () => {
    setLoading(true);
    offset.current = 0;
    await fetchLogs(true);
    setLoading(false);
  }, [fetchLogs]);

  useFocusEffect(useCallback(() => { reload(); }, [reload]));

  const onRefresh = async () => {
    setRefreshing(true);
    offset.current = 0;
    await fetchLogs(true);
    setRefreshing(false);
  };

  const loadMore = async () => {
    if (loadingMore || entries.length >= totalCount) return;
    setLoadingMore(true);
    await fetchLogs(false);
    setLoadingMore(false);
  };

  // Debounced search handler (shared for all three fields)
  const scheduleSearch = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      offset.current = 0;
      reload();
    }, 400);
  };

  const onActorChange = (t: string) => {
    setActorSearch(t);
    activeActor.current = t;
    scheduleSearch();
  };
  const onTargetChange = (t: string) => {
    setTargetSearch(t);
    activeTarget.current = t;
    scheduleSearch();
  };
  const onResourceChange = (t: string) => {
    setResourceSearch(t);
    activeResource.current = t;
    scheduleSearch();
  };

  const hasMore = entries.length < totalCount;

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <View style={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8 }}>
        <PageHeader
          title="Audit Trail"
          subtitle="Complete administrative activity log"
          accentColor="#DC2626"
          rightAction={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {totalCount > 0 && (
                <View style={{ backgroundColor: `${c.primary}15`, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>{totalCount.toLocaleString()} entries</Text>
                </View>
              )}
              <Pressable
                onPress={() => setShowFilters(v => !v)}
                style={{ padding: 8, backgroundColor: showFilters ? `${c.primary}18` : 'transparent', borderRadius: 10 }}
              >
                <Filter size={18} color={showFilters ? c.primary : c.text} opacity={showFilters ? 1 : 0.5} />
              </Pressable>
            </View>
          }
        />

        {/* ── Category chips ─────────────────────────────────────────── */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
          <View style={{ flexDirection: 'row', gap: 7, paddingRight: 8 }}>
            {CATEGORIES.map(cat => {
              const active = category === cat.key;
              const Icon = cat.icon;
              return (
                <Pressable
                  key={cat.key}
                  onPress={() => { setCategory(cat.key); offset.current = 0; }}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 5,
                    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20,
                    backgroundColor: active ? cat.color : `${c.text}0C`,
                    shadowColor: active ? cat.color : 'transparent',
                    shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.35, shadowRadius: 4,
                  }}
                >
                  <Icon size={13} color={active ? '#fff' : c.text} opacity={active ? 1 : 0.55} />
                  <Text style={{ fontSize: 12, fontWeight: '600', color: active ? '#fff' : c.text, opacity: active ? 1 : 0.65 }}>
                    {cat.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>

        {/* ── Time quick-filters ─────────────────────────────────────── */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
          <View style={{ flexDirection: 'row', gap: 7, paddingRight: 8 }}>
            {TIME_FILTERS.map(tf => {
              const active = timeFilter === tf.key;
              return (
                <Pressable
                  key={tf.key}
                  onPress={() => { setTimeFilter(tf.key); offset.current = 0; }}
                  style={{
                    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20,
                    backgroundColor: active ? c.primary : `${c.text}0C`,
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: '600', color: active ? '#fff' : c.text, opacity: active ? 1 : 0.6 }}>
                    {tf.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>

        {/* ── Expanded filters (status + search fields) ───────────────── */}
        {showFilters && (
          <View style={{ gap: 10, marginBottom: 4 }}>
            {/* Status row */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, width: 48 }}>Status:</Text>
              {STATUS_FILTERS.map(sf => {
                const active = logStatus === sf.key;
                return (
                  <Pressable
                    key={sf.key}
                    onPress={() => { setLogStatus(sf.key); offset.current = 0; }}
                    style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: active ? sf.color : `${c.text}0C` }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: '600', color: active ? '#fff' : c.text, opacity: active ? 1 : 0.6 }}>{sf.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Three search fields */}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <SearchField placeholder="Search actor…"    value={actorSearch}    onChange={onActorChange}    c={c} />
              <SearchField placeholder="Search target…"   value={targetSearch}   onChange={onTargetChange}   c={c} />
              <SearchField placeholder="Search resource…" value={resourceSearch} onChange={onResourceChange} c={c} />
            </View>
          </View>
        )}
      </View>

      {/* ── List ───────────────────────────────────────────────────────── */}
      {loading ? (
        <ActivityIndicator color={c.primary} style={{ marginTop: 60 }} />
      ) : (
        <FlatList
          data={entries}
          keyExtractor={item => item.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 48 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
          onEndReached={loadMore}
          onEndReachedThreshold={0.3}
          contentInsetAdjustmentBehavior="automatic"
          ListEmptyComponent={
            <View style={{ alignItems: 'center', paddingVertical: 80 }}>
              <Shield size={52} color={c.primary} opacity={0.15} style={{ marginBottom: 14 }} />
              <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, opacity: 0.3 }}>No audit logs found</Text>
              <Text style={{ fontSize: 13, color: c.text, opacity: 0.2, marginTop: 6, textAlign: 'center' }}>
                Try a different category, time range, or search term
              </Text>
            </View>
          }
          ListFooterComponent={
            loadingMore ? (
              <View style={{ paddingVertical: 20, alignItems: 'center' }}>
                <RefreshCw size={20} color={c.primary} opacity={0.5} />
              </View>
            ) : hasMore ? (
              <Pressable onPress={loadMore} style={{ paddingVertical: 16, alignItems: 'center' }}>
                <Text style={{ fontSize: 13, color: c.primary, fontWeight: '600' }}>Load more</Text>
              </Pressable>
            ) : entries.length > 0 ? (
              <Text style={{ textAlign: 'center', fontSize: 12, color: c.text, opacity: 0.25, paddingVertical: 16 }}>
                All {totalCount.toLocaleString()} entries shown
              </Text>
            ) : null
          }
          renderItem={({ item }) => <ExpandableLogCard entry={item} c={c} />}
        />
      )}
    </View>
  );
}
