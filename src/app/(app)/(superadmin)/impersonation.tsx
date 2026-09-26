/**
 * Impersonation — Super Admin only.
 * Starts a real impersonation session: the backend issues a session pair for
 * the TARGET user (`{ session, target }`), the client stores the ORIGINAL
 * Super-Admin tokens in the impersonation store, then swaps the active auth
 * session to the target. The persistent ImpersonationBanner restores the
 * original session on exit (server-audited via POST /auth/impersonation/end).
 * Every attempt (start success/failure/end) is recorded in audit_logs.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TextInput, ActivityIndicator,
  useColorScheme, Pressable,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { User, Search, AlertTriangle, LogIn } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { searchUsers, getAuditLogs } from '@/lib/api';
import { startImpersonationSession } from '@/lib/impersonationService';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout, safeBottom } from '@/lib/neu';
import { friendlyError } from '@/lib/validation';
import { useDebounce } from '@/lib/useDebounce';
import { useImpersonationStore } from '@/lib/store';

const ROLE_COLORS: Record<string, string> = {
  student: '#7C3AED', doctor: '#16A34A',
  admin: '#1E90FF', super_admin: '#DC2626',
};

export default function ImpersonationScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const router = useRouter();
  const { showToast } = useToast();
  const { impersonation } = useImpersonationStore();

  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 300);
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [recentLogs, setRecentLogs] = useState<any[]>([]);
  const [logsLoaded, setLogsLoaded] = useState(false);
  const [impersonating, setImpersonating] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try { setResults(await searchUsers(query)); }
    catch (e) { showToast({ type: 'error', message: friendlyError(e, 'Search failed.') }); }
    setSearching(false);
  };

  const loadLogs = useCallback(async () => {
    try {
      const logs = await getAuditLogs(50);
      setRecentLogs(logs.filter((l: any) => l.action?.includes('impersonat')));
      setLogsLoaded(true);
    } catch (_) {}
  }, []);

  useFocusEffect(useCallback(() => { loadLogs(); }, [loadLogs]));

  const handleImpersonate = async (targetUser: any) => {
    if (targetUser.role === 'super_admin') return;
    setImpersonating(targetUser.id);
    setErrorMsg(null);
    try {
      // REAL session swap: backend issues the target's session pair, the
      // service preserves the original Super-Admin tokens and switches the
      // live auth context. Throws a structured error on any failure —
      // success is NEVER faked.
      await startImpersonationSession(targetUser.id, targetUser.full_name, targetUser.role);

      showToast({ type: 'success', message: `Now logged in as ${targetUser.full_name}.` });
      await loadLogs();

      // startImpersonationSession has ALREADY confirmed the target's profile
      // loaded (it resolves only after that). Navigate directly to the
      // target's role dashboard — the generic '/' route relies on the layout's
      // one-shot role redirect, which is consumed by earlier navigations and
      // left the preview stuck on the index spinner.
      const dest = targetUser.role === 'doctor'
        ? '/dr-overview'
        : targetUser.role === 'admin'
          ? '/admin-overview'
          : targetUser.role === 'super_admin'
            ? '/sa-overview'
            : '/dashboard';
      router.replace(dest as never);
    } catch (e: any) {
      // Structured error surfaced verbatim (403/404/422/5xx messages are
      // produced by the backend contract) — no swallowed failures.
      const msg = friendlyError(e, 'Impersonation failed.');
      setErrorMsg(msg);
      showToast({ type: 'error', message: msg });
    }
    setImpersonating(null);
  };

  const inp = {
    backgroundColor: c.base, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 13,
    shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.55, shadowRadius: 6,
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }} contentContainerStyle={{ paddingBottom: safeBottom(layout.insets.bottom) }}>
      <PageHeader title="Impersonation" subtitle="Log in as another user" accentColor="#D97706" showBack backFallback="/sa-platform" />

      <View style={{ paddingHorizontal: layout.screenPx }}>

        {impersonation.active && (
          <NeuCard style={{ marginBottom: 16, padding: 14, flexDirection: 'row', gap: 10 }}>
            <User size={18} color="#1E90FF" />
            <Text style={{ flex: 1, fontSize: 12, color: c.text, fontWeight: '600' }}>
              Currently impersonating {impersonation.targetName}. Use the yellow banner at the top of the app to return to your account.
            </Text>
          </NeuCard>
        )}

        <NeuCard style={{ marginBottom: 20, padding: 14, flexDirection: 'row', gap: 10 }}>
          <AlertTriangle size={18} color="#D97706" />
          <Text style={{ flex: 1, fontSize: 12, color: '#D97706', fontWeight: '600', lineHeight: 18 }}>
            All impersonation sessions are recorded in Audit Logs. You cannot impersonate Super Admins or suspended accounts.
          </Text>
        </NeuCard>

        {/* Search */}
        <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, opacity: 0.6, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 }}>
          Find User
        </Text>
        <View style={{ ...inp, flexDirection: 'row', alignItems: 'center', minWidth: 0, marginBottom: 12 }}>
          <Search size={18} color={`${c.text}55`} style={{ marginRight: 10, flexShrink: 0 }} />
          <TextInput
            value={query} onChangeText={setQuery} onSubmitEditing={handleSearch}
            placeholder="Name, email, phone or user ID..."
            placeholderTextColor={`${c.text}55`}
            accessibilityLabel="Search users to impersonate"
            style={{ flex: 1, minWidth: 0, fontSize: 14, color: c.text }}
          />
          {searching && <ActivityIndicator size="small" color={c.primary} />}
        </View>
        <NeuButton label="Search" onPress={handleSearch} loading={searching} fullWidth style={{ marginBottom: 20 }} />

        {/* Structured error state — the real failure reason, never a fake success */}
        {errorMsg && (
          <NeuCard style={{ marginBottom: 20, padding: 14, flexDirection: 'row', gap: 10, borderWidth: 1, borderColor: '#DC262655' }}>
            <AlertTriangle size={18} color="#DC2626" />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#DC2626' }}>Impersonation failed</Text>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.7, marginTop: 2 }}>{errorMsg}</Text>
            </View>
          </NeuCard>
        )}

        {/* Results */}
        {results.length > 0 && (
          <>
            <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 14 }}>Results ({results.length})</Text>
            {results.map(user => {
              const blocked = user.role === 'super_admin';
              const roleColor = ROLE_COLORS[user.role] ?? c.primary;
              const isLoading = impersonating === user.id;
              return (
                <NeuCard key={user.id} style={{ marginBottom: 12, padding: 16 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: `${roleColor}18`, alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
                      <User size={20} color={roleColor} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>{user.full_name}</Text>
                      <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>{user.email}</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: roleColor }} />
                          <Text style={{ fontSize: 11, fontWeight: '700', color: roleColor }}>{user.role?.replace('_', ' ')}</Text>
                        </View>
                        {!!user.public_user_id && (
                          <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.55, letterSpacing: 0.5 }}>{user.public_user_id}</Text>
                        )}
                      </View>
                    </View>
                    <Pressable
                      onPress={() => !blocked && !impersonating && handleImpersonate(user)}
                      disabled={blocked || !!impersonating}
                      accessibilityRole="button"
                      accessibilityLabel={blocked ? `Cannot impersonate ${user.full_name}` : `Impersonate ${user.full_name}`}
                      style={{ width: 42, height: 42, borderRadius: 13, backgroundColor: blocked ? `${c.text}10` : `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}
                    >
                      {isLoading
                        ? <ActivityIndicator size="small" color={c.primary} />
                        : <LogIn size={18} color={blocked ? `${c.text}33` : c.primary} />}
                    </Pressable>
                  </View>
                  {blocked && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, marginLeft: 58 }}>
                      <AlertTriangle size={12} color="#DC2626" />
                      <Text style={{ fontSize: 11, color: '#DC2626', fontWeight: '600' }}>Cannot impersonate Super Admins</Text>
                    </View>
                  )}
                </NeuCard>
              );
            })}
          </>
        )}

        {/* Recent impersonation logs */}
        <View style={{ marginTop: 20 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 14 }}>Recent Impersonations</Text>
          {logsLoaded && recentLogs.length === 0 && (
            <NeuCard style={{ padding: 24, alignItems: 'center' }}>
              <Text style={{ color: c.text, opacity: 0.4 }}>No impersonation history found</Text>
            </NeuCard>
          )}
          {recentLogs.map(log => (
            <NeuCard key={log.id} style={{ marginBottom: 10, padding: 14 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: log.action === 'impersonation_failed' ? '#DC2626' : c.text }}>
                {log.action?.replace(/_/g, ' ')}
              </Text>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 3 }}>
                {log.details?.target_name ?? log.details?.reason ?? 'Unknown'}{log.details?.target_role ? ` (${log.details.target_role})` : ''} • {new Date(log.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })}
              </Text>
            </NeuCard>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}
