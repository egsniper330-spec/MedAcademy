/**
 * Feature Flags — Super Admin only.
 *
 * Organized by category (from the SERVER registry — FeatureFlagService::REGISTRY),
 * each flag showing its name, what it does, its scope line (global state +
 * override count) and a three-state per-user override editor for controlled
 * rollout / per-account kill switches.
 *
 * Every flag is ENFORCED SERVER-SIDE at the endpoint that performs the
 * operation (403 feature_disabled + structured feature key) — this screen is
 * the control surface, never the enforcement.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, Switch, ActivityIndicator,
  RefreshControl, useColorScheme, TextInput, Pressable,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  Flag, RefreshCw, Search, ChevronDown, ChevronUp, User as UserIcon, Users,
} from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { useToast } from '@/components/Toast';
import {
  getFeatureFlags, toggleFeatureFlag, getFeatureFlagsForUser,
  setFeatureFlagOverride, searchUsers,
} from '@/lib/api';
import { refreshFeatureFlags } from '@/lib/featureFlags';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { LoadingState, ErrorState } from '@/components/ScreenState';
import { EmptyState } from '@/components/EmptyState';
import { neuColors, useLayout, safeBottom } from '@/lib/neu';
import { friendlyError } from '@/lib/validation';

type FlagRow = {
  key: string;
  label: string;
  description?: string;
  category: string;
  enabled: boolean;
  is_default?: boolean;
  /** Server-provided count of explicit per-user overrides (global view). */
  overrides?: number;
  /** Present when viewing a specific user (user-targeted view). */
  override?: 'inherit' | 'enabled' | 'disabled';
  user_effective?: boolean;
};

/** Category titles in display order; unknown categories fall back to "Other". */
const CATEGORY_TITLES: Record<string, string> = {
  access: 'Authentication & Access',
  courses: 'Courses & Enrollment',
  finance: 'Credits & Finance',
  admin: 'Administration',
  video: 'Video',
};

const CATEGORY_COLORS: Record<string, string> = {
  access: '#1E90FF',
  courses: '#2DA8FF',
  finance: '#D97706',
  admin: '#7C3AED',
  video: '#16A34A',
};

type OverrideMode = 'inherit' | 'enabled' | 'disabled';

const OVERRIDE_OPTIONS: OverrideMode[] = ['inherit', 'enabled', 'disabled'];
const OVERRIDE_LABELS: Record<OverrideMode, string> = {
  inherit: 'Inherit',
  enabled: 'Enabled',
  disabled: 'Disabled',
};

export default function FeatureFlagsScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const router = useRouter();
  const { showToast } = useToast();

  const [flags, setFlags] = useState<FlagRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  // ── Per-user override editor state ──────────────────────────────────────
  const [userQuery, setUserQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [targetUser, setTargetUser] = useState<{ id: string; full_name: string; email?: string } | null>(null);
  const [userFlags, setUserFlags] = useState<FlagRow[]>([]);
  const [userLoading, setUserLoading] = useState(false);

  // Terminal-state contract: LOADING → (ERROR | EMPTY | CONTENT).
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setFlags(await getFeatureFlags());
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const handleToggle = async (key: string, current: boolean) => {
    setSaving(key);
    const optimistic = flags.map(f => f.key === key ? { ...f, enabled: !current } : f);
    setFlags(optimistic);
    try {
      await toggleFeatureFlag(key, !current);
      // Apply the new state app-wide immediately (the app-wide cache is
      // invalidated by the API call; this re-reads it). No restart, no relogin.
      await refreshFeatureFlags(true);
    } catch (e) {
      setFlags(flags); // revert on error
      showToast({ type: 'error', message: friendlyError(e, 'Failed to update the flag.') });
    }
    setSaving(null);
  };

  // ── Override editor ─────────────────────────────────────────────────────
  const resolveUser = async () => {
    if (!userQuery.trim()) return;
    setSearching(true);
    try {
      const users = await searchUsers(userQuery.trim());
      const user = users[0];
      if (!user?.id) {
        showToast({ type: 'error', message: 'No matching user found.' });
        return;
      }
      const picked = { id: user.id as string, full_name: (user.full_name as string) ?? 'User', email: user.email as string | undefined };
      setTargetUser(picked);
      setUserLoading(true);
      setUserFlags(await getFeatureFlagsForUser(picked.id));
      setUserLoading(false);
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'User lookup failed.') });
    }
    setSearching(false);
  };

  const handleOverride = async (key: string, mode: OverrideMode) => {
    if (!targetUser) return;
    setUserLoading(true);
    try {
      setUserFlags(await setFeatureFlagOverride(targetUser.id, key, mode));
      showToast({ type: 'success', message: `${key}: ${OVERRIDE_LABELS[mode]} for ${targetUser.full_name}` });
      // Refresh the global list (override counts may have changed).
      void load();
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to update the override.') });
    }
    setUserLoading(false);
  };

  const clearUser = () => {
    setTargetUser(null);
    setUserFlags([]);
    setUserQuery('');
  };

  // Group the flags by category (server registry order + title fallback).
  const grouped = useMemo(() => {
    const map = new Map<string, FlagRow[]>();
    for (const f of flags) {
      const list = map.get(f.category) ?? [];
      list.push(f);
      map.set(f.category, list);
    }
    return [...map.entries()].map(([category, list]) => ({
      category,
      title: CATEGORY_TITLES[category] ?? category,
      color: CATEGORY_COLORS[category] ?? c.primary,
      list,
    }));
  }, [flags, c.primary]);

  const totalOverrides = flags.reduce((n, f) => n + (f.overrides ?? 0), 0);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />} contentContainerStyle={{ paddingBottom: safeBottom(layout.insets.bottom) }}>
      <PageHeader
        title="Feature Flags"
        subtitle="Server-enforced platform capability control"
        showBack
        onBack={() => router.push('/sa-platform')}
      />

      <View style={{ paddingHorizontal: layout.screenPx }}>

        <NeuCard style={{ marginBottom: 20, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <RefreshCw size={16} color={c.primary} />
          <Text style={{ flex: 1, fontSize: 12, color: c.text, opacity: 0.6 }}>
            Enforced on the server — every flag below is checked by the endpoint that performs the
            action, not just by this screen. Super Admin is never locked out: sign-in stays available
            to Super Admin while the login flag is off so it can always be switched back on.
            {totalOverrides > 0 ? ` ${totalOverrides} per-user override${totalOverrides === 1 ? '' : 's'} active.` : ''}
          </Text>
        </NeuCard>

        {loading ? <LoadingState label="Loading feature flags…" /> : error ? (
          <ErrorState error={error} onRetry={load} />
        ) : flags.length === 0 ? (
          <EmptyState
            icon={<Flag size={40} color={c.primary} />}
            title="No feature flags"
            description="The server returned no feature flags."
            action={{ label: 'Refresh', onPress: load }}
          />
        ) : (
          grouped.map(group => (
            <View key={group.category} style={{ marginBottom: 22 }}>
              {/* Category header */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <View style={{ width: 4, height: 16, borderRadius: 2, backgroundColor: group.color }} />
                <Text style={{ fontSize: 13, fontWeight: '800', color: c.text, opacity: 0.65, letterSpacing: 1, textTransform: 'uppercase' }}>
                  {group.title}
                </Text>
              </View>

              {group.list.map(flag => {
                const savingThis = saving === flag.key;
                return (
                  <NeuCard key={flag.key} style={{ marginBottom: 12, padding: 16 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: `${group.color}18`, alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
                        <Flag size={18} color={group.color} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>{flag.label}</Text>
                        {flag.description && (
                          <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 3 }}>{flag.description}</Text>
                        )}
                      </View>
                      {savingThis ? (
                        <ActivityIndicator size="small" color={c.primary} />
                      ) : (
                        <Switch
                          value={flag.enabled}
                          onValueChange={() => handleToggle(flag.key, flag.enabled)}
                          trackColor={{ false: `${c.text}22`, true: `${group.color}55` }}
                          thumbColor={flag.enabled ? group.color : `${c.text}55`}
                        />
                      )}
                    </View>
                    {/* Scope line: state + per-user override count */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, marginLeft: 54, gap: 8 }}>
                      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: flag.enabled ? '#16A34A' : '#DC2626' }} />
                      <Text style={{ fontSize: 11, fontWeight: '600', color: flag.enabled ? '#16A34A' : '#DC2626' }}>
                        {flag.enabled ? 'Enabled globally' : 'Disabled globally'}
                      </Text>
                      {!!flag.overrides && (
                        <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>
                          · {flag.overrides} per-user override{flag.overrides === 1 ? '' : 's'}
                        </Text>
                      )}
                    </View>
                  </NeuCard>
                );
              })}
            </View>
          ))
        )}

        {/* ── Per-user overrides ─────────────────────────────────────────── */}
        <View style={{ marginBottom: 22 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <View style={{ width: 4, height: 16, borderRadius: 2, backgroundColor: '#7C3AED' }} />
            <Text style={{ fontSize: 13, fontWeight: '800', color: c.text, opacity: 0.65, letterSpacing: 1, textTransform: 'uppercase' }}>
              Per-User Overrides
            </Text>
          </View>
          <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginBottom: 10 }}>
            Look up an account to give it explicit access to a disabled feature, or block it
            individually while the feature stays on globally. Inherit removes any override.
          </Text>

          <NeuCard style={{ padding: 0, overflow: 'hidden', marginBottom: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, gap: 10, minWidth: 0 }}>
              <Search size={16} color={`${c.text}60`} style={{ flexShrink: 0 }} />
              <TextInput
                style={{ flex: 1, minWidth: 0, fontSize: 14, color: c.text }}
                placeholder="Find a user by email or phone…"
                placeholderTextColor={`${c.text}50`}
                value={userQuery}
                onChangeText={setUserQuery}
                autoCapitalize="none"
                autoCorrect={false}
                onSubmitEditing={resolveUser}
              />
              <Pressable onPress={resolveUser} disabled={searching || !userQuery.trim()}>
                {searching
                  ? <ActivityIndicator size="small" color={c.primary} />
                  : <Text style={{ fontSize: 13, fontWeight: '700', color: c.primary }}>Find</Text>}
              </Pressable>
            </View>
          </NeuCard>

          {targetUser && (
            <NeuCard style={{ padding: 16, marginBottom: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <View style={{ width: 36, height: 36, borderRadius: 11, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
                  <UserIcon size={17} color={c.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }} numberOfLines={1}>
                    {targetUser.full_name}
                  </Text>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }} numberOfLines={1}>
                    {targetUser.email ?? targetUser.id}
                  </Text>
                </View>
                <Pressable onPress={clearUser}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: '#DC2626' }}>Clear</Text>
                </Pressable>
              </View>

              {userLoading ? (
                <ActivityIndicator color={c.primary} style={{ marginVertical: 10 }} />
              ) : (
                userFlags.map(flag => {
                  const current: OverrideMode = flag.override ?? 'inherit';
                  const effective = flag.user_effective ?? flag.enabled;
                  return (
                    <View key={flag.key} style={{ paddingVertical: 9, borderTopWidth: 1, borderTopColor: `${c.shadowDark}22` }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: c.text }} numberOfLines={1}>
                          {flag.label}
                        </Text>
                        <View style={{
                          paddingHorizontal: 7, paddingVertical: 2, borderRadius: 20,
                          backgroundColor: effective ? '#16A34A18' : '#DC262618',
                        }}>
                          <Text style={{ fontSize: 10, fontWeight: '700', color: effective ? '#16A34A' : '#DC2626' }}>
                            {effective ? '✓ ACTIVE' : '✗ BLOCKED'}
                          </Text>
                        </View>
                      </View>
                      <View style={{ flexDirection: 'row', backgroundColor: `${c.shadowDark}20`, borderRadius: 10, padding: 2, gap: 2, marginTop: 7, alignSelf: 'flex-end' }}>
                        {OVERRIDE_OPTIONS.map(mode => {
                          const selected = current === mode;
                          return (
                            <Pressable
                              key={mode}
                              onPress={() => handleOverride(flag.key, mode)}
                              style={{
                                paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8,
                                backgroundColor: selected ? c.primary : 'transparent',
                              }}
                            >
                              <Text style={{ fontSize: 11, fontWeight: '700', color: selected ? '#FFFFFF' : `${c.text}99` }}>
                                {OVERRIDE_LABELS[mode]}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    </View>
                  );
                })
              )}
            </NeuCard>
          )}
        </View>

        <View style={{ height: 30 }} />
      </View>
    </ScrollView>
  );
}
