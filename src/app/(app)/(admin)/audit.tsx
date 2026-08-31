import { useCallback, useState, useRef } from 'react';
import {
  View, Text, ScrollView, FlatList, Pressable, TextInput,
  useColorScheme, ActivityIndicator, RefreshControl, LayoutAnimation,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Shield, Search, X, Filter, ChevronDown, ChevronUp,
  CheckCircle, XCircle, AlertTriangle,
  User, BookOpen, DollarSign, LogIn, Lock, RefreshCw,
  Users, UserCheck, Code, Settings, Smartphone, ArrowUpDown, Clock,
} from 'lucide-react-native';
import { getAuditTrail, AuditTrailEntry } from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, useLayout, safeBottom } from '@/lib/neu';
import { PageHeader } from '@/components/PageHeader';

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

interface CategoryFilter { key: string; label: string; icon: React.ElementType; color: string }

const CATEGORIES: CategoryFilter[] = [
  { key: '',         label: 'All Events',   icon: Shield,      color: '#6B7280' },
  { key: 'users',    label: 'Users',        icon: User,        color: '#7C3AED' },
  { key: 'roles',    label: 'Role Changes', icon: ArrowUpDown, color: '#9333EA' },
  { key: 'doctor',   label: 'Doctor',       icon: UserCheck,   color: '#2DA8FF' },
  { key: 'student',  label: 'Student',      icon: Users,       color: '#2563EB' },
  { key: 'courses',  label: 'Courses',      icon: BookOpen,    color: '#D97706' },
  { key: 'codes',    label: 'Codes',        icon: Code,        color: '#16A34A' },
  { key: 'auth',     label: 'Auth',         icon: LogIn,       color: '#DC2626' },
  { key: 'finance',  label: 'Finance',      icon: DollarSign,  color: '#065F46' },
  { key: 'platform', label: 'Platform',     icon: Settings,    color: '#0F766E' },
];

const TIME_FILTERS = [
  { key: '',      label: 'All Time' },
  { key: 'today', label: 'Today'    },
  { key: '7d',    label: '7 Days'   },
  { key: '30d',   label: '30 Days'  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function actionLabel(action: string): string {
  return action.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function actionColor(action: string, status: string): string {
  if (status === 'failed')  return '#DC2626';
  if (status === 'warning') return '#D97706';
  const a = action.toLowerCase();
  if (a.includes('delete') || a.includes('suspend') || a.includes('revoke') || a.includes('reject') || a.includes('remove') || a.includes('demot') || a.includes('block') || a.includes('failed')) return '#DC2626';
  if (a.includes('create') || a.includes('grant')   || a.includes('activat') || a.includes('approv') || a.includes('publish') || a.includes('restor') || a.includes('added') || a.includes('promot')) return '#16A34A';
  if (a.includes('update') || a.includes('edit')    || a.includes('change')  || a.includes('reset')  || a.includes('changed') || a.includes('updated')) return '#D97706';
  if (a.includes('login')  || a.includes('logout')  || a.includes('auth')    || a.includes('password') || a.includes('session')) return '#2563EB';
  if (a.includes('credit') || a.includes('earning') || a.includes('payment') || a.includes('enroll')) return '#065F46';
  if (a.includes('device'))  return '#7C3AED';
  if (a.includes('course'))  return '#D97706';
  return '#6B7280';
}

function actionIcon(action: string, color: string, size = 17) {
  const a = action.toLowerCase();
  if (a.includes('role') || a.includes('promot') || a.includes('demot')) return <ArrowUpDown size={size} color={color} />;
  if (a.includes('device')) return <Smartphone size={size} color={color} />;
  if (a.includes('course') || a.includes('lesson')) return <BookOpen size={size} color={color} />;
  if (a.includes('credit') || a.includes('earn') || a.includes('payment')) return <DollarSign size={size} color={color} />;
  if (a.includes('login') || a.includes('logout') || a.includes('auth') || a.includes('session')) return <LogIn size={size} color={color} />;
  if (a.includes('code')) return <Code size={size} color={color} />;
  if (a.includes('setting') || a.includes('platform') || a.includes('config')) return <Settings size={size} color={color} />;
  if (a.includes('security') || a.includes('lock') || a.includes('password')) return <Lock size={size} color={color} />;
  return <User size={size} color={color} />;
}

function statusIcon(status: string, size = 12) {
  if (status === 'failed')  return <XCircle      size={size} color="#DC2626" />;
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
  return new Date(iso).toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fullTimestamp(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' })}  ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}`;
}

function timeRangeFromKey(key: string): { dateFrom?: string; dateTo?: string } {
  if (!key) return {};
  const now = new Date();
  const to  = now.toISOString();
  if (key === 'today') return { dateFrom: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(), dateTo: to };
  if (key === '7d')    return { dateFrom: new Date(Date.now() - 7  * 86400000).toISOString(), dateTo: to };
  if (key === '30d')   return { dateFrom: new Date(Date.now() - 30 * 86400000).toISOString(), dateTo: to };
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
      <Text style={{ fontSize: 10, fontWeight: '700', color: c.text, opacity: 0.4, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Changes</Text>
      {allKeys.map(key => {
        const oldVal = oldValues?.[key];
        const newVal = newValues?.[key];
        const changed = JSON.stringify(oldVal) !== JSON.stringify(newVal);
        return (
          <View key={key} style={{ marginBottom: 8 }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 3, textTransform: 'capitalize' }}>{key.replace(/_/g, ' ')}</Text>
            {oldVal !== undefined && (
              <View style={{ backgroundColor: '#DC262614', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, marginBottom: 3 }}>
                <Text style={{ fontSize: 12, color: '#DC2626' }}>Before: {String(typeof oldVal === 'object' ? JSON.stringify(oldVal) : oldVal)}</Text>
              </View>
            )}
            {newVal !== undefined && changed && (
              <View style={{ backgroundColor: '#16A34A14', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 }}>
                <Text style={{ fontSize: 12, color: '#16A34A' }}>After: {String(typeof newVal === 'object' ? JSON.stringify(newVal) : newVal)}</Text>
              </View>
            )}
          </View>
        );
      })}
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
      {/* Collapsed */}
      <Pressable onPress={toggle} style={{ padding: 14, flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ width: 40, height: 40, borderRadius: 13, flexShrink: 0, backgroundColor: `${aColor}15`, alignItems: 'center', justifyContent: 'center' }}>
          {actionIcon(entry.action, aColor)}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, lineHeight: 18, marginBottom: 4 }} numberOfLines={expanded ? undefined : 2}>
            {entry.description ?? actionLabel(entry.action)}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
            {entry.actor_name && (
              <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>{entry.actor_name}</Text>
            )}
            {entry.target_name && entry.target_name !== entry.actor_name && (
              <>
                <Text style={{ fontSize: 11, color: c.text, opacity: 0.3 }}>→</Text>
                <Text style={{ fontSize: 11, color: c.text, opacity: 0.6, fontWeight: '600' }}>{entry.target_name}</Text>
              </>
            )}
            <Text style={{ fontSize: 11, color: c.text, opacity: 0.25 }}>·</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <Clock size={10} color={c.text} opacity={0.3} />
              <Text style={{ fontSize: 11, color: c.text, opacity: 0.3 }}>{relativeTime(entry.created_at)}</Text>
            </View>
            <View style={{ marginLeft: 'auto' }}>{statusIcon(entry.log_status)}</View>
          </View>
        </View>
        <View style={{ marginTop: 2, flexShrink: 0 }}>
          {expanded ? <ChevronUp size={15} color={c.text} opacity={0.3} /> : <ChevronDown size={15} color={c.text} opacity={0.3} />}
        </View>
      </Pressable>

      {/* Expanded */}
      {expanded && (
        <View style={{ paddingHorizontal: 14, paddingBottom: 14, borderTopWidth: 1, borderTopColor: `${c.text}08` }}>
          <View style={{ paddingTop: 12, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ backgroundColor: `${aColor}18`, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: aColor, textTransform: 'uppercase', letterSpacing: 0.5 }}>{actionLabel(entry.action)}</Text>
            </View>
            {statusIcon(entry.log_status, 13)}
          </View>
          {/* Actor */}
          <View style={{ backgroundColor: `${c.text}05`, borderRadius: 10, padding: 10, marginBottom: 8 }}>
            <Text style={{ fontSize: 10, fontWeight: '700', color: c.text, opacity: 0.4, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Actor</Text>
            <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>{entry.actor_name ?? '—'}</Text>
            {entry.actor_email && <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>{entry.actor_email}</Text>}
            {entry.actor_role  && <Text style={{ fontSize: 11, color: aColor, fontWeight: '600', textTransform: 'capitalize', marginTop: 2 }}>{entry.actor_role.replace(/_/g,' ')}</Text>}
          </View>
          {/* Target */}
          {(entry.target_name || entry.resource_type) && (
            <View style={{ backgroundColor: `${c.text}05`, borderRadius: 10, padding: 10, marginBottom: 8 }}>
              <Text style={{ fontSize: 10, fontWeight: '700', color: c.text, opacity: 0.4, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Target</Text>
              {entry.target_name   && <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>{entry.target_name}</Text>}
              {entry.resource_type && <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, textTransform: 'capitalize' }}>{entry.resource_type.replace(/_/g,' ')}</Text>}
              {entry.resource_id   && <Text style={{ fontSize: 10, color: c.text, opacity: 0.3, fontFamily: 'monospace', marginTop: 2 }}>ID: {entry.resource_id}</Text>}
            </View>
          )}
          {/* Old/New values */}
          {(entry.old_values || entry.new_values) && (
            <View style={{ backgroundColor: `${c.text}05`, borderRadius: 10, padding: 10, marginBottom: 8 }}>
              <OldNewDiff oldValues={entry.old_values} newValues={entry.new_values} c={c} />
            </View>
          )}
          {/* Extra details */}
          {extraDetails.length > 0 && (
            <View style={{ backgroundColor: `${c.text}05`, borderRadius: 10, padding: 10, marginBottom: 8 }}>
              <Text style={{ fontSize: 10, fontWeight: '700', color: c.text, opacity: 0.4, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Additional Info</Text>
              {extraDetails.map(([k, v]) => (
                <View key={k} style={{ flexDirection: 'row', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: `${c.text}06` }}>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, minWidth: 80, flexShrink: 0 }}>{k.replace(/_/g,' ')}</Text>
                  <Text style={{ fontSize: 12, color: c.text, flex: 1 }} numberOfLines={3}>
                    {typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}
                  </Text>
                </View>
              ))}
            </View>
          )}
          {/* Metadata */}
          <View style={{ backgroundColor: `${c.text}05`, borderRadius: 10, padding: 10 }}>
            <View style={{ flexDirection: 'row', paddingVertical: 4 }}>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, width: 80 }}>Timestamp</Text>
              <Text style={{ fontSize: 12, color: c.text }}>{fullTimestamp(entry.created_at)}</Text>
            </View>
            {entry.ip_address && (
              <View style={{ flexDirection: 'row', paddingVertical: 4 }}>
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, width: 80 }}>IP</Text>
                <Text style={{ fontSize: 12, color: c.text, fontFamily: 'monospace' }}>{entry.ip_address}</Text>
              </View>
            )}
          </View>
        </View>
      )}
    </NeuCard>
  );
}

// ─── SearchBar ────────────────────────────────────────────────────────────────

function SearchBar({ placeholder, value, onChange, c }: {
  placeholder: string; value: string; onChange: (t: string) => void; c: typeof neuColors.light;
}) {
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center',
      backgroundColor: c.base, borderRadius: 13,
      paddingHorizontal: 12, paddingVertical: 9,
      flex: 1,
      shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 },
      shadowOpacity: 0.45, shadowRadius: 4,
    }}>
      <Search size={14} color={c.text} opacity={0.35} />
      <TextInput
        value={value} onChangeText={onChange}
        placeholder={placeholder} placeholderTextColor={`${c.text}45`}
        style={{ flex: 1, minWidth: 0, marginLeft: 7, fontSize: 13, color: c.text }}
      />
      {value.length > 0 && (
        <Pressable onPress={() => onChange('')}><X size={13} color={c.text} opacity={0.4} /></Pressable>
      )}
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function AdminAudit() {
  const scheme = useColorScheme();
  const layout = useLayout();
  const insets = layout.insets;
  const c = scheme === 'dark' ? neuColors.dark : neuColors.light;

  const [entries,     setEntries]    = useState<AuditTrailEntry[]>([]);
  const [totalCount,  setTotalCount] = useState(0);
  const [loading,     setLoading]    = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing,  setRefreshing] = useState(false);

  const [category,   setCategory]   = useState('');
  const [timeFilter, setTimeFilter] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const [actorSearch,    setActorSearch]    = useState('');
  const [targetSearch,   setTargetSearch]   = useState('');
  const [resourceSearch, setResourceSearch] = useState('');

  const offset     = useRef(0);
  const debRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeActor    = useRef('');
  const activeTarget   = useRef('');
  const activeResource = useRef('');

  const buildSearch = () => {
    const parts = [activeActor.current, activeTarget.current, activeResource.current].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : undefined;
  };

  const fetchLogs = useCallback(async (reset = false) => {
    const { dateFrom, dateTo } = timeRangeFromKey(timeFilter);
    const page = reset ? 0 : offset.current;
    try {
      const { entries: rows, totalCount: count } = await getAuditTrail({
        search: buildSearch(), category: category || undefined,
        dateFrom, dateTo, limit: PAGE_SIZE, offset: page,
      });
      if (reset) { setEntries(rows); offset.current = rows.length; }
      else       { setEntries(prev => [...prev, ...rows]); offset.current += rows.length; }
      setTotalCount(count);
    } catch (_) {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, timeFilter]);

  const reload = useCallback(async () => {
    setLoading(true); offset.current = 0;
    await fetchLogs(true);
    setLoading(false);
  }, [fetchLogs]);

  useFocusEffect(useCallback(() => { reload(); }, [reload]));

  const onRefresh = async () => {
    setRefreshing(true); offset.current = 0;
    await fetchLogs(true);
    setRefreshing(false);
  };

  const loadMore = async () => {
    if (loadingMore || entries.length >= totalCount) return;
    setLoadingMore(true); await fetchLogs(false); setLoadingMore(false);
  };

  const scheduleSearch = () => {
    if (debRef.current) clearTimeout(debRef.current);
    debRef.current = setTimeout(() => { offset.current = 0; reload(); }, 400);
  };

  const onActorChange    = (t: string) => { setActorSearch(t);    activeActor.current    = t; scheduleSearch(); };
  const onTargetChange   = (t: string) => { setTargetSearch(t);   activeTarget.current   = t; scheduleSearch(); };
  const onResourceChange = (t: string) => { setResourceSearch(t); activeResource.current = t; scheduleSearch(); };

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      {/* PageHeader sits OUTSIDE the inner padding view so it can own its own horizontal padding */}
      <PageHeader title="Audit Logs" subtitle="Security & activity trail" accentColor="#DC2626" />

      <View style={{ paddingHorizontal: layout.screenPx, paddingTop: 8, paddingBottom: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <View />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {totalCount > 0 && (
              <View style={{ backgroundColor: `${c.primary}15`, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 }}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>{totalCount.toLocaleString('en-US')} entries</Text>
              </View>
            )}
            <Pressable onPress={() => setShowFilters(v => !v)}
              style={{ padding: 8, backgroundColor: showFilters ? `${c.primary}18` : 'transparent', borderRadius: 10 }}>
              <Filter size={18} color={showFilters ? c.primary : c.text} opacity={showFilters ? 1 : 0.5} />
            </Pressable>
          </View>
        </View>

        {/* Category chips */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
          <View style={{ flexDirection: 'row', gap: 7, paddingRight: 8 }}>
            {CATEGORIES.map(cat => {
              const active = category === cat.key;
              const Icon = cat.icon;
              return (
                <Pressable key={cat.key} onPress={() => { setCategory(cat.key); offset.current = 0; }}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 5,
                    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20,
                    backgroundColor: active ? cat.color : `${c.text}0C`,
                  }}>
                  <Icon size={13} color={active ? '#fff' : c.text} opacity={active ? 1 : 0.55} />
                  <Text style={{ fontSize: 12, fontWeight: '600', color: active ? '#fff' : c.text, opacity: active ? 1 : 0.65 }}>{cat.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>

        {/* Time filters */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
          <View style={{ flexDirection: 'row', gap: 7, paddingRight: 8 }}>
            {TIME_FILTERS.map(tf => {
              const active = timeFilter === tf.key;
              return (
                <Pressable key={tf.key} onPress={() => { setTimeFilter(tf.key); offset.current = 0; }}
                  style={{ paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, backgroundColor: active ? c.primary : `${c.text}0C` }}>
                  <Text style={{ fontSize: 12, fontWeight: '600', color: active ? '#fff' : c.text, opacity: active ? 1 : 0.6 }}>{tf.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>

        {/* Expanded search fields */}
        {showFilters && (
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 4 }}>
            <SearchBar placeholder="Actor…"    value={actorSearch}    onChange={onActorChange}    c={c} />
            <SearchBar placeholder="Target…"   value={targetSearch}   onChange={onTargetChange}   c={c} />
            <SearchBar placeholder="Resource…" value={resourceSearch} onChange={onResourceChange} c={c} />
          </View>
        )}
      </View>

      {/* List */}
      {loading ? (
        <ActivityIndicator color={c.primary} style={{ marginTop: 60 }} />
      ) : (
        <FlatList
          data={entries}
          keyExtractor={item => item.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: layout.scrollBottom() }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
          onEndReached={loadMore}
          onEndReachedThreshold={0.3}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', paddingVertical: 80 }}>
              <Shield size={48} color={c.primary} opacity={0.15} style={{ marginBottom: 12 }} />
              <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, opacity: 0.3 }}>No audit logs found</Text>
              <Text style={{ fontSize: 13, color: c.text, opacity: 0.2, marginTop: 6 }}>Try a different filter or search term</Text>
            </View>
          }
          ListFooterComponent={
            loadingMore ? (
              <View style={{ paddingVertical: 20, alignItems: 'center' }}>
                <RefreshCw size={20} color={c.primary} opacity={0.5} />
              </View>
            ) : entries.length > 0 && entries.length >= totalCount ? (
              <Text style={{ textAlign: 'center', fontSize: 12, color: c.text, opacity: 0.25, paddingVertical: 16 }}>
                All {totalCount.toLocaleString('en-US')} entries shown
              </Text>
            ) : null
          }
          renderItem={({ item }) => <ExpandableLogCard entry={item} c={c} />}
        />
      )}
    </View>
  );
}
