/**
 * ImpersonationBanner — persistent top banner shown during Login As sessions.
 * Displays target name/role and "Return to [original role]" button.
 */
import { View, Text, Pressable, useColorScheme } from 'react-native';
import { LogOut, UserCheck } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useImpersonationStore, useProfileStore } from '@/lib/store';
import { backendClient } from '@/client/backendClient';

export function ImpersonationBanner() {
  const { impersonation, endImpersonation } = useImpersonationStore();
  const { clearProfile } = useProfileStore();
  const router = useRouter();
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';

  if (!impersonation.active) return null;

  const handleReturn = async () => {
    if (!impersonation.originalAccessToken || !impersonation.originalRefreshToken) {
      // Fallback: just sign out
      await backendClient.auth.signOut();
      endImpersonation();
      clearProfile();
      return;
    }
    // Restore original session using stored tokens
    const { error } = await backendClient.auth.setSession({
      access_token: impersonation.originalAccessToken,
      refresh_token: impersonation.originalRefreshToken,
    });
    if (error) {
      // If stored token expired, sign out cleanly
      await backendClient.auth.signOut();
    }
    endImpersonation();
    clearProfile();
    // Navigate to the correct dashboard based on original role
    const role = impersonation.originalRole;
    if (role === 'super_admin') router.replace('/sa-overview' as any);
    else if (role === 'admin') router.replace('/(app)/(admin)/admin-overview' as any);
    else router.replace('/(app)/(doctor)/dr-overview' as any);
  };

  return (
    <View style={{
      backgroundColor: '#D97706',
      paddingHorizontal: 16,
      paddingVertical: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    }}>
      <UserCheck size={16} color="#fff" />
      <View style={{ flex: 1 }}>
        <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>
          Impersonating: {impersonation.targetName}
        </Text>
        <Text style={{ color: '#fff', fontSize: 11, opacity: 0.85 }}>
          ({impersonation.targetRole}) · logged in as {impersonation.originalEmail}
        </Text>
      </View>
      <Pressable
        onPress={handleReturn}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6,
          backgroundColor: 'rgba(0,0,0,0.25)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}
      >
        <LogOut size={13} color="#fff" />
        <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>
          Return to {impersonation.originalRole?.replace('_', ' ')}
        </Text>
      </Pressable>
    </View>
  );
}
