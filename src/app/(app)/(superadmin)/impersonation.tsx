/**
 * Impersonation — Super Admin only
 * Log in as another user via a server-generated magic link.
 * Every impersonation is recorded in audit_logs.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TextInput, ActivityIndicator,
  useColorScheme, Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { User, Search, AlertTriangle, LogIn } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { useFocusEffect } from 'expo-router';
import { searchUsers, getAuditLogs } from '@/lib/api';
import { supabase } from '@/client/supabase';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { useToast } from '@/components/Toast';
import { neuColors } from '@/lib/neu';
import { friendlyError } from '@/lib/validation';
import { useDebounce } from '@/lib/useDebounce';
import { useImpersonationStore, useProfileStore, type UserRole } from '@/lib/store';

const ROLE_COLORS: Record<string, string> = {
  student: '#7C3AED', doctor: '#16A34A',
  admin: '#1E90FF', super_admin: '#DC2626',
};

export default function ImpersonationScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const router = useRouter();
  const { showToast } = useToast();
  const { startImpersonation } = useImpersonationStore();
  const { clearProfile } = useProfileStore();

  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 300);
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [recentLogs, setRecentLogs] = useState<any[]>([]);
  const [logsLoaded, setLogsLoaded] = useState(false);
  const [impersonating, setImpersonating] = useState<string | null>(null);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try { setResults(await searchUsers(query)); } catch (_) {}
    setSearching(false);
  };

  const loadLogs = useCallback(async () => {
    try {
      const logs = await getAuditLogs(20);
      setRecentLogs(logs.filter((l: any) => l.action?.includes('impersonat')));
      setLogsLoaded(true);
    } catch (_) {}
  }, []);

  useFocusEffect(useCallback(() => { loadLogs(); }, [loadLogs]));

  const handleImpersonate = async (targetUser: any) => {
    if (targetUser.role === 'super_admin') return;
    setImpersonating(targetUser.id);
    try {
      // Save current session tokens BEFORE switching
      const { data: { session: currentSession } } = await supabase.auth.getSession();
      if (!currentSession) throw new Error('No active session to save.');

      const originalAccessToken  = currentSession.access_token;
      const originalRefreshToken = currentSession.refresh_token;
      const { data: { user: currentUser } } = await supabase.auth.getUser();
      const originalEmail = currentUser?.email ?? null;

      // Get current admin profile role
      const { data: profile } = await supabase.from('profiles').select('role').eq('id', currentUser!.id).single();
      const originalRole = (profile?.role ?? 'admin') as UserRole;

      // Call the impersonate Edge Function
      const { data, error } = await supabase.functions.invoke('impersonate', {
        body: { target_user_id: targetUser.id },
      });

      if (error) {
        const msg = await error?.context?.text?.().catch(() => error.message);
        throw new Error(msg || error.message);
      }

      if (!data?.email_otp || !data?.email) throw new Error('No impersonation token returned from server.');

      // Exchange OTP for a real session
      const { data: sessionData, error: verifyErr } = await supabase.auth.verifyOtp({
        email: data.email,
        token: data.email_otp,
        type: 'magiclink',
      });

      if (verifyErr || !sessionData?.session) {
        throw new Error(verifyErr?.message ?? 'Could not exchange token for session.');
      }

      // Store original session in impersonation store + clear cached profile
      startImpersonation(
        originalAccessToken,
        originalRefreshToken,
        originalEmail ?? '',
        originalRole,
        targetUser.full_name,
        targetUser.role as UserRole,
      );
      clearProfile();

      showToast({ type: 'success', message: `Now logged in as ${targetUser.full_name}.` });
      await loadLogs();

      // Navigate to app root — layout will redirect to correct dashboard
      router.replace('/' as any);
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Impersonation failed.') });
    }
    setImpersonating(null);
  };

  const inp = {
    backgroundColor: c.base, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 13,
    shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.55, shadowRadius: 6,
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }} contentInsetAdjustmentBehavior="automatic">
      <View style={{ padding: 20 }}>
        <PageHeader title="Impersonation" subtitle="Log in as another user" accentColor="#D97706" />

        <NeuCard style={{ marginBottom: 20, padding: 14, flexDirection: 'row', gap: 10 }}>
          <AlertTriangle size={18} color="#D97706" />
          <Text style={{ flex: 1, fontSize: 12, color: '#D97706', fontWeight: '600', lineHeight: 18 }}>
            All impersonation sessions are recorded in Audit Logs. You cannot impersonate other Super Admins.
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
            style={{ flex: 1, minWidth: 0, fontSize: 14, color: c.text }}
          />
          {searching && <ActivityIndicator size="small" color={c.primary} />}
        </View>
        <NeuButton label="Search" onPress={handleSearch} loading={searching} fullWidth style={{ marginBottom: 20 }} />

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
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: roleColor }} />
                        <Text style={{ fontSize: 11, fontWeight: '700', color: roleColor }}>{user.role?.replace('_', ' ')}</Text>
                      </View>
                    </View>
                    <Pressable
                      onPress={() => !blocked && !impersonating && handleImpersonate(user)}
                      style={{ width: 42, height: 42, borderRadius: 13, backgroundColor: blocked ? `${c.text}10` : `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
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
              <Text style={{ fontSize: 13, fontWeight: '700', color: c.text }}>{log.action?.replace(/_/g, ' ')}</Text>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 3 }}>
                {log.details?.target_name ?? 'Unknown'} ({log.details?.target_role ?? ''}) • {new Date(log.created_at).toLocaleString()}
              </Text>
            </NeuCard>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}
