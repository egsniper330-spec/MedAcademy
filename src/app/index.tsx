import { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, useColorScheme } from 'react-native';
import { useRouter } from 'expo-router';
import { ShieldPlus } from 'lucide-react-native';
import { NeuButton } from '@/components/NeuButton';
import { neuColors } from '@/lib/neu';
import { useSession } from '@/ctx';
import { resolveStartupRoute, type StartupRoute } from '@/lib/startupStateModel';
import { useBranding } from '@/lib/branding';
import NetInfo from '@react-native-community/netinfo';

/**
 * Landing screen — routes through the PURE cold-start state machine
 * (startupStateModel.resolveStartupRoute), not through ad-hoc effect logic.
 *
 * THE OFFLINE COLD-START CONTRACT (auth restoration ≠ network availability):
 *
 *   app start → hydrate local session (LOCAL read, no API) → decide:
 *     • no session            → landing (Sign In / Create Account)
 *     • session + OFFLINE     → /offline-library  (direct Offline Mode)
 *     • session + ONLINE      → /(app)            (normal online shell)
 *     • session + UNKNOWN     → spinner (an undetermined connectivity value is
 *                               never evidence for ANY redirect — this is the
 *                               old race that could drop a session-holding
 *                               user toward the unauthenticated landing UI)
 *
 * A network failure can never produce the login route: the machine's login
 * branch is reachable ONLY through hasLocalSession=false, which flips through
 * the real auth pipeline (explicit signOut / definitive revocation clearing
 * the store) — never through a transport error. Session expiration/revocation
 * keeps its existing server-side pipeline (definitive refresh failure →
 * clearSession → SIGNED_OUT → hasLocalSession=false → login on the next
 * evaluation); nothing here invents a new offline auth policy.
 *
 * SecurityGate is an independent layer INSIDE the (app) shell — routing to
 * Offline Mode never bypasses it; all local detectors still run and a genuine
 * violation still blocks (the offline-library screen itself mounts under the
 * gate and re-runs checkBeforeVideo before any playback).
 */
export default function LandingScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const router = useRouter();
  const { session, isLoading } = useSession();
  // Server-managed platform identity (Super Admin → Platform → Branding).
  // Falls back to the built-in defaults on failure — this screen renders
  // identically whether or not the branding API is reachable.
  const { branding } = useBranding();

  // Connectivity tri-state mirroring offlineTransition.useConnectivity exactly
  // (isConnected && isInternetReachable !== false). null = not yet determined.
  const [isOffline, setIsOffline] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const st = await NetInfo.fetch();
        if (alive) setIsOffline(!!st.isConnected && st.isInternetReachable !== false ? false : true);
      } catch {
        if (alive) setIsOffline(null);
      }
    };
    void check();
    const unsub = NetInfo.addEventListener(() => { void check(); });
    return () => { alive = false; unsub(); };
  }, []);

  // THE authoritative routing decision — one pure function of
  // (authHydrated, hasLocalSession, connectivity). No timing hacks: the
  // redirect effect re-evaluates on every relevant state change, and the
  // machine's output for the settled inputs is always the settled route.
  const route: StartupRoute = resolveStartupRoute({
    authHydrated: !isLoading,
    hasLocalSession: !!session,
    connectivity: isOffline === null ? null : !isOffline,
  });

  useEffect(() => {
    if (route !== 'online' && route !== 'offline') return;
    router.replace(route === 'offline' ? '/offline-library' : '/(app)');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  // Spinner while auth hydrates OR while a session-holding user waits for a
  // concrete connectivity value (never flash the landing UI — an unknown is
  // not "unauthenticated").
  if (route === 'spinner' || route === 'online' || route === 'offline') {
    return (
      <View style={{ flex: 1, backgroundColor: c.base, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color="#1E90FF" />
      </View>
    );
  }

  // route === 'login' — genuinely no persisted session (or explicit logout).
  return (
    <View style={{ flex: 1, backgroundColor: c.base, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <View style={{ alignItems: 'center', marginBottom: 48 }}>
        <View style={{
          width: 88, height: 88, borderRadius: 28,
          backgroundColor: c.primary, alignItems: 'center',
          justifyContent: 'center', marginBottom: 20,
        }}>
          <ShieldPlus size={44} color="#fff" />
        </View>
        <Text style={{ fontSize: 34, fontWeight: '800', color: c.text, letterSpacing: -0.5 }}>{branding.app_name}</Text>
        <Text style={{ fontSize: 16, color: c.text, opacity: 0.55, marginTop: 6, textAlign: 'center' }}>
          Best Educational Platform
        </Text>
      </View>
      <NeuButton label="Sign In" onPress={() => router.push('/(auth)/sign-in')} fullWidth style={{ marginBottom: 14 }} />
      <NeuButton label="Create Account" onPress={() => router.push('/(auth)/sign-up')} variant="secondary" fullWidth />
    </View>
  );
}
