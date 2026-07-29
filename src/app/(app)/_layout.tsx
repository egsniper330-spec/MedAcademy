import { useEffect, useRef, useCallback } from 'react';
import { Stack, useRouter } from 'expo-router';
import { ActivityIndicator, AppState, View } from 'react-native';
import * as ScreenCapture from 'expo-screen-capture';
import { useSession } from '@/ctx';
import { useProfileStore } from '@/lib/store';
import { getProfile } from '@/lib/api';
import { UploadFAB } from '@/components/VideoUploadQueue';
import { useSecurity } from '@/lib/SecurityContext';
import type { RelativePathString } from 'expo-router';

// Roles that can upload videos and need the floating upload queue FAB.
const UPLOAD_ROLES = new Set(['doctor', 'admin', 'super_admin']);

// FLAG_SECURE key for the authenticated app shell.
// Applied at layout level so every screen inside (app)/ is protected,
// not just lesson/[id].tsx. The lesson screen adds its own keyed lock
// ('lesson') for the violation-reporting layer on top of this one.
const APP_SC_KEY = 'app-shell';

function AppLayoutNav() {
  const { session } = useSession();
  const { profile, isProfileLoading, setProfile, setProfileLoading, clearProfile } = useProfileStore();
  const router = useRouter();
  const hasNavigated = useRef(false);
  // Guard: role-based redirect must only fire ONCE after login.
  // Any later store update (e.g. profile refresh from the Profile screen)
  // must NOT re-trigger the redirect or the user gets kicked back to dashboard.

  const { check, reset, onNewBlockingThreat } = useSecurity();

  // ── App-shell FLAG_SECURE ──────────────────────────────────────────────────
  // Activates Android FLAG_SECURE for ALL screens inside (app)/, blocking
  // screenshots and screen recording across the entire authenticated session.
  // The lesson screen adds a second keyed lock ('lesson') for its
  // violation-reporting overlay — both locks must be released before the OS
  // permits capture again, so the lesson lock acts as belt-and-suspenders.
  useEffect(() => {
    if (process.env.EXPO_OS === 'web') return;
    ScreenCapture.preventScreenCaptureAsync(APP_SC_KEY).catch(() => {});
    return () => { ScreenCapture.allowScreenCaptureAsync(APP_SC_KEY).catch(() => {}); };
  }, []);

  // ── Background → foreground re-check ──────────────────────────────────────
  // Re-run all security checks when the app returns from background so that
  // newly-enabled Developer Options / ADB / VPN are caught immediately.
  // Uses AppState (not useFocusEffect) because this layout is never unmounted.
  const appStateRef = useRef(AppState.currentState);
  useEffect(() => {
    if (process.env.EXPO_OS === 'web') return;
    const sub = AppState.addEventListener('change', (nextState) => {
      const wasBackground =
        appStateRef.current === 'background' || appStateRef.current === 'inactive';
      const isForeground = nextState === 'active';
      appStateRef.current = nextState;
      if (!wasBackground || !isForeground) return;
      // Invalidate cache so checks run fresh, then re-evaluate.
      reset();
      void check().then((result) => {
        if (result.blocksLogin) {
          router.replace('/(auth)/security-warning' as RelativePathString);
        }
      });
    });
    return () => sub.remove();
  }, [check, reset, router]);

  // ── Continuous monitoring → forced redirect ────────────────────────────────
  // Subscribe to SecurityContext's periodic-check callback so that VPN / Developer
  // Options detected WHILE THE APP IS OPEN (not just on foreground resume) trigger
  // an immediate redirect to the security-warning screen.
  useEffect(() => {
    if (process.env.EXPO_OS === 'web') return;
    if (!onNewBlockingThreat) return;
    const unsub = onNewBlockingThreat((result) => {
      if (result.blocksLogin) {
        router.replace('/(auth)/security-warning' as RelativePathString);
      }
    });
    return unsub;
  }, [onNewBlockingThreat, router]);

  useEffect(() => {
    if (!session?.user) {
      clearProfile();
      hasNavigated.current = false;
      return;
    }
    (async () => {
      setProfileLoading(true);
      try {
        const p = await getProfile(session.user.id);
        setProfile(p as any);
      } catch (err) {
        // Profile load failure is intentionally non-fatal — the session is still
        // valid. Log the error so it appears in the timeline but do NOT sign out.
        console.error('[AppLayout] getProfile FAILED (non-fatal, keeping session):', err);
      } finally {
        setProfileLoading(false);
      }
    })();
  }, [session?.user?.id]);

  useEffect(() => {
    // Skip if still loading, no profile, or already redirected this session
    if (isProfileLoading || !profile || hasNavigated.current) return;
    hasNavigated.current = true;
    const role = profile.role;
    // If student was created by doctor → force password change first
    if ((profile as any).force_password_change) {
      router.replace('/(auth)/force-password-change' as RelativePathString);
      return;
    }
    if (role === 'student') router.replace('/(app)/(student)/dashboard' as RelativePathString);
    else if (role === 'doctor') router.replace('/(app)/(doctor)/dr-overview' as RelativePathString);
    else if (role === 'admin') router.replace('/(app)/(admin)/admin-overview' as RelativePathString);
    else if (role === 'super_admin') router.replace('/(app)/(superadmin)/sa-overview' as RelativePathString);
  }, [profile, isProfileLoading]);

  if (isProfileLoading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EAEEf5' }}>
        <ActivityIndicator size="large" color="#1E90FF" />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(student)" />
      <Stack.Screen name="(doctor)" />
      <Stack.Screen name="(admin)" />
      <Stack.Screen name="(superadmin)" />
      <Stack.Screen name="course/[id]" />
      <Stack.Screen name="lesson/[id]" />
      <Stack.Screen name="course-builder" />
      <Stack.Screen name="lesson-editor" />
      <Stack.Screen name="edit-profile" />
      <Stack.Screen name="notifications" />
      <Stack.Screen name="security" />
      <Stack.Screen name="my-devices" />
      <Stack.Screen name="login-history" />
      <Stack.Screen name="user-activity" />
      <Stack.Screen name="archived-courses" />
    </Stack>
  );
}

export default function AppLayout() {
  const { profile } = useProfileStore();
  const canUpload = !!profile && UPLOAD_ROLES.has(profile.role);

  return (
    <View style={{ flex: 1 }}>
      <AppLayoutNav />
      {/* Upload queue FAB — only mounted for roles that can upload videos.
          Lives here (not root layout) so it never appears on auth/login screens,
          and persists across course-builder & lesson-editor Stack pushes. */}
      {canUpload && <UploadFAB />}
    </View>
  );
}
