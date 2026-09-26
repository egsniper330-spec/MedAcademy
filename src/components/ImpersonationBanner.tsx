/**
 * ImpersonationBanner — persistent top banner shown during Login As sessions.
 * Displays target name/role and "Return to [original role]" button.
 *
 * SAFE-AREA CONTRACT (mobile bug fix): the banner previously rendered flush
 * at y=0, hiding it underneath the Android/iOS status bar (clock/battery/
 * notch). It now offsets by the REAL top safe-area inset from
 * react-native-safe-area-context (provided at the app root by
 * SafeAreaProvider) — correct on every device, no magic constants — and
 * sits at a z-index above all app content. Layout: [status bar] → [banner]
 * → [app content].
 */
import { View, Text, Pressable, useColorScheme, Platform } from 'react-native';
import { LogOut, UserCheck } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useImpersonationStore } from '@/lib/store';
import { endImpersonationSession } from '@/lib/impersonationService';

export function ImpersonationBanner() {
  const { impersonation } = useImpersonationStore();
  const router = useRouter();
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  // REAL device inset (status bar / notch / Dynamic Island). On web this is
  // 0, so the banner sits at the very top of the viewport as intended.
  const insets = useSafeAreaInsets();

  if (!impersonation.active) return null;

  const handleReturn = async () => {
    // Server-audited end + real session restore (original Super-Admin tokens
    // → setSession) + profile cache clear + restore confirmation, all inside
    // the service. (The service also resets the impersonation store and
    // clears the profile — the extra calls here were redundant double-writes
    // that could race the layout's re-bootstrap.)
    await endImpersonationSession();
    // Navigate to the correct dashboard based on original role. The layout's
    // identity-change effect has already reset the one-shot role guard, so
    // the redirect re-arms — this explicit replace just skips the index
    // spinner hop.
    const role = impersonation.originalRole;
    if (role === 'super_admin') router.replace('/sa-overview' as never);
    else if (role === 'admin') router.replace('/admin-overview' as never);
    else router.replace('/dr-overview' as never);
  };

  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel={`Impersonating ${impersonation.targetName}. Return to ${impersonation.originalRole?.replace('_', ' ') ?? 'your account'}.`}
      style={{
        backgroundColor: '#D97706',
        // Never render under the status bar / notch / Dynamic Island.
        paddingTop: Platform.OS === 'web' ? 0 : insets.top,
        paddingHorizontal: 16,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        zIndex: 1000,
        elevation: 1000,
        // A subtle shadow keeps it readable over any light content below.
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
      }}
    >
      <UserCheck size={16} color="#fff" />
      <View style={{ flex: 1 }}>
        <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }} numberOfLines={1}>
          Impersonating: {impersonation.targetName}
        </Text>
        <Text style={{ color: '#fff', fontSize: 11, opacity: 0.85 }} numberOfLines={1}>
          ({impersonation.targetRole}) · logged in as {impersonation.originalEmail}
        </Text>
      </View>
      <Pressable
        onPress={handleReturn}
        accessibilityRole="button"
        accessibilityLabel="Exit impersonation and return to your Super Admin account"
        hitSlop={8}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6,
          backgroundColor: 'rgba(0,0,0,0.25)', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9 }}
      >
        <LogOut size={13} color="#fff" />
        <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>
          Return to {impersonation.originalRole?.replace('_', ' ')}
        </Text>
      </Pressable>
    </View>
  );
}
