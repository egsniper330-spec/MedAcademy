import { useEffect, useRef } from 'react';
import { Stack, useRouter, usePathname } from 'expo-router';
import { AppState, View } from 'react-native';
// Fix: import JS wrapper module directly (not requireOptionalNativeModule).
// requireOptionalNativeModule returns the raw native proxy which only has
// .preventScreenCapture() / .allowScreenCapture() (no key arg, no async wrapper).
// The keyed public API preventScreenCaptureAsync(key) / allowScreenCaptureAsync(key)
// are JS-level functions in ScreenCapture.js — undefined on the proxy →
// TypeError: undefined is not a function → fatal Android crash.
import * as ScreenCaptureLib from 'expo-screen-capture';
import { useSession } from '@/ctx';
import { useProfileStore } from '@/lib/store';
import { getProfile } from '@/lib/api';
import { refreshAccountState, handleRefreshOutcome } from '@/lib/accountRefresh';
import { isExpectedMaintenanceError } from '@/lib/maintenanceStateModel';
import { maintenanceEpoch } from '@/components/MaintenanceGate';
import { UploadFAB } from '@/components/VideoUploadQueue';
import { useSecurity } from '@/lib/SecurityContext';
import { SecurityGate } from '@/app/(app)/security-gate';
import type { RelativePathString } from 'expo-router';
// Roles that can upload videos and need the floating upload queue FAB.
const UPLOAD_ROLES = new Set(['doctor', 'admin', 'super_admin']);

// FLAG_SECURE key for the authenticated app shell.
// Applied at layout level so every screen inside (app)/ is protected,
// not just lesson/[id].tsx. The lesson screen adds its own keyed lock
// ('lesson') for the violation-reporting layer on top of this one.
// Root _layout.tsx also holds 'root-shell' which covers auth screens.
const APP_SC_KEY = 'app-shell';

function AppLayoutNav() {
  const { session } = useSession();
  const { profile, isProfileLoading, setProfile, setProfileLoading, clearProfile } = useProfileStore();
  const router = useRouter();
  const hasNavigated = useRef(false);
  // Guard: role-based redirect must only fire ONCE after login.
  // Any later store update (e.g. profile refresh from the Profile screen)
  // must NOT re-trigger the redirect or the user gets kicked back to dashboard.
  //
  // SESSION ISOLATION CONTRACT
  // ─────────────────────────────────────────────────────────────────────────
  // When session?.user is null (signed-out):
  //   • clearProfile() resets profile→null AND isProfileLoading→true
  //   • hasNavigated.current is reset to false
  //   • The Stack.Protected guard={!!session} in the root layout unmounts
  //     the entire (app) route group, wiping all navigator state.
  // When a NEW session arrives (different user):
  //   • getProfile() is called with the new user's ID
  //   • setProfile() fires → isProfileLoading:false + profile set
  //   • The redirect effect sees hasNavigated.current=false and fires once
  //     with the correct new role → correct dashboard is pushed
  // ─────────────────────────────────────────────────────────────────────────

  // reset() no longer called on foreground: nulling the verdict during the
  // re-check created the BLOCKED→UNKNOWN→ALLOWED window (see AppState handler
  // below). check() alone re-validates with native-state reads — policies use
  // a short 5-min TTL cache by design; VPN/native flags are read fresh every
  // call, so stale-cached "safe" results cannot persist here.
  const { check, onNewBlockingThreat, isSuperAdmin } = useSecurity();

  // ── App-shell FLAG_SECURE ──────────────────────────────────────────────────
  // Activates Android FLAG_SECURE for ALL screens inside (app)/, blocking
  // screenshots and screen recording across the entire authenticated session.
  // Super Admin bypass: release this lock so SA can screenshot in their
  // administrative capacity. The root 'root-shell' lock is separately managed.
  // The lesson screen adds a second keyed lock ('lesson') for its
  // violation-reporting overlay — both locks must be released before the OS
  // permits capture again, so the lesson lock acts as belt-and-suspenders.
  //
  // iOS TIMING FIX — setTimeout(0) async tick:
  // On iOS with New Architecture (Fabric/JSI), useEffects fire synchronously
  // within the same React commit that mounts (app)/_layout. This commit is
  // triggered by the same state update that sets isLoading=false in SessionProvider.
  // Both events land in the same main-thread run-loop cycle, meaning
  // preventScreenCapture() runs before the first CATransaction.flush()
  // has presented the initial frame to the display compositor.
  //
  // When preventScreenshots() runs at that moment, it calls
  // keyWindow.layer.removeFromSuperlayer() and then reparents keyWindow.layer
  // into UITextField's private off-screen CALayer. The iOS display compositor
  // never receives the first frame → black screen.
  //
  // A single setTimeout(0) defers the call to the NEXT main-thread run-loop
  // iteration, by which point the initial CATransaction has already flushed and
  // the window layer is properly registered with the compositor. The reparenting
  // then works correctly and content stays visible.
  //
  // Android: FLAG_SECURE sets a SurfaceView flag — it never reparents the window
  // layer and is unaffected by this timing issue. The Android path is unchanged.
  useEffect(() => {
    if (process.env.EXPO_OS === 'web') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      if (isSuperAdmin) {
        ScreenCaptureLib.allowScreenCaptureAsync(APP_SC_KEY).catch(() => {});
      } else {
        ScreenCaptureLib.preventScreenCaptureAsync(APP_SC_KEY).catch(() => {});
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      ScreenCaptureLib.allowScreenCaptureAsync(APP_SC_KEY).catch(() => {});
    };
  }, [isSuperAdmin]);

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
      // RACE-CONDITION FIX: do NOT reset() the verdict here. The previous
      // reset() nulled the authoritative result for the entire duration of the
      // fresh check — consumers fell back to an all-clear default, the gate
      // unmounted, and the app was briefly fully usable under an ACTIVE
      // security condition (Home → reopen → 2–3s unprotected window).
      // Fail-closed instead: the LAST VERDICT stays mounted while check()
      // re-runs with cached-state invalidation inside runSecurityChecks()
      // (detectors re-read native state every call). The gate now renders
      // BLOCKED → CHECKING/BLOCKED → SAFE-or-BLOCKED — never BLOCKED → ALLOWED.
      void check().then((result) => {
        // ALL blocking threats are enforced by the central SecurityGate overlay
        // (non-dismissible, auto-unlocking). Do NOT navigate to security-warning
        // for them — without the blocksLogin param that screen rendered in
        // warn-mode WITH "Continue Anyway", a bypass of a block_login policy.
        // Non-blocking warnings (hasWarnings only) still route there.
        if (result.hasWarnings && !result.blocksLogin) {
          router.replace('/security-warning' as RelativePathString);
        }
      });
    });
    return () => sub.remove();
  }, [check, router]);

  // ── Continuous monitoring → forced redirect ────────────────────────────────
  // Subscribe to SecurityContext's periodic-check callback so that VPN / Developer
  // Options detected WHILE THE APP IS OPEN (not just on foreground resume) trigger
  // an immediate redirect to the security-warning screen.
  useEffect(() => {
    if (process.env.EXPO_OS === 'web') return;
    if (!onNewBlockingThreat) return;
    const unsub = onNewBlockingThreat((result) => {
      // ALL blocking threats are enforced by the central SecurityGate overlay
      // (non-dismissible, auto-unlocking) — never routed to the dismissible
      // security-warning screen.
      if (result.hasWarnings && !result.blocksLogin) {
        router.replace('/security-warning' as any);
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
        // Defensive: a profile row missing both role AND status cannot drive
        // any role decision — treat as an error, not as "loaded with no role".
        if (p && !p.role && !p.status) {
          throw new Error('profile row incomplete (no role/status)');
        }
        setProfile(p as any);
        // SERVER-AUTHORITATIVE ROLE/STATUS SYNC: immediately after the
        // cold-start load, refresh against the server (single-flight,
        // offline-skipped). Catches USER→ADMIN / ADMIN→USER changes that
        // happened while this session was signed in, and ACTIVE→BLOCKED that
        // happened between sessions.
        void refreshAccountState(session.user.id, { reason: 'shell_cold_start' }).then((outcome) => {
          void handleRefreshOutcome(outcome, { userId: session.user.id });
        });
      } catch (err) {
        // ── BLOCKED ACCOUNT — terminal state, never a spinner ────────────
        // AuthMiddleware rejects EVERY authenticated call from a
        // suspended/blocked account with HTTP 403 code 'account_suspended';
        // getProfile surfaces that by THROWING { message, code, status }.
        // The previous code swallowed it as "non-fatal" with profile=null →
        // the role-redirect guard blocked on !profile → the (app)/index
        // spinner ran FOREVER on a blocked cold start (device-proven).
        // Match the server's blocked verdict VERBATIM — a network failure
        // (no status), a 5xx, or a timeout is NEVER a block.
        const e = err as { code?: string; status?: number; message?: string } | null;
        if (
          e && typeof e === 'object' &&
          (e.code === 'account_suspended' ||
            (e.status === 403 && /suspended|blocked/i.test(String(e.message ?? ''))))
        ) {
          setProfileLoading(false);
          // Session is PRESERVED — the account-suspended screen's Logout
          // performs the real sign-out; a BLOCKED→ACTIVE unblock then
          // refreshes back to normal without re-login.
          router.replace('/account-suspended' as RelativePathString);
          return;
        }
        // ── MAINTENANCE (expected control flow, NOT an application failure) ──
        // While the server-side gate is up, getProfile legitimately receives
        // 503 maintenance_mode. The single typed classifier decides — the
        // session is untouched, no navigation, NO red console error, no toast.
        // The MaintenanceGate overlay owns the UI and its silent recovery
        // re-runs this bootstrap when maintenance ends.
        if (isExpectedMaintenanceError(err as { status?: number; code?: string; message?: string })) {
          if (__DEV__) {
            console.log('[AppLayout] getProfile deferred — maintenance gate active (expected)');
          }
          return;
        }
        // All other failures are intentionally non-fatal — the session is
        // still valid. Network failures must NOT sign the user out (offline
        // startup contract); the profile simply stays as-is (null on true
        // cold start with no cache — recovered by the authoritative refresh
        // once connectivity returns, or by the foreground trigger).
        console.error('[AppLayout] getProfile FAILED (non-fatal, keeping session):', err);
      } finally {
        setProfileLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id]);

  const pathname = usePathname();

  // ── Role-based redirect ────────────────────────────────────────────────────
  useEffect(() => {
    // Skip if still loading, no profile, or already redirected this session
    if (isProfileLoading || !profile || hasNavigated.current) return;
    hasNavigated.current = true;
    // OFFLINE COLD LAUNCH: the root router may land directly on the Offline
    // Library (offline + valid session + security SAFE). That route is a
    // legitimate destination INSIDE this shell — the role redirect must not
    // evict it to the dashboard the moment the profile resolves (which
    // un-did the offline cold launch on real devices and web deep links).
    if (pathname?.startsWith('/offline-')) return;
    const role = profile.role;
    // If student was created by doctor → force password change first
    if ((profile as any).force_password_change) {
      router.replace('/force-password-change' as RelativePathString);
      return;
    }
    if (role === 'student') router.replace('/dashboard' as RelativePathString);
    else if (role === 'doctor') router.replace('/dr-overview' as RelativePathString);
    else if (role === 'admin') router.replace('/admin-overview' as RelativePathString);
    else if (role === 'super_admin') router.replace('/sa-overview' as RelativePathString);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, isProfileLoading]);

  // ── MAINTENANCE RECOVERY RE-BOOTSTRAP (epoch-driven, silent) ──────────────
  // When MaintenanceGate recovers (server says maintenance OFF), the epoch
  // bumps and this effect re-runs the NORMAL server-authoritative bootstrap
  // (getProfile + refreshAccountState). This is what makes whitelist
  // add/remove effective immediately — the next request re-evaluates the
  // server gate — and it restores the app WITHOUT restart or re-login. When
  // the user has no session, the root Stack.Protected guards handle routing.
  const epoch = maintenanceEpoch();
  useEffect(() => {
    if (epoch === 0) return; // no recovery has happened yet
    const uid = session?.user?.id;
    if (!uid) return;
    (async () => {
      try {
        const p = await getProfile(uid);
        if (p && (p.role || p.status)) setProfile(p as any);
      } catch {
        // Non-fatal: the foreground/connectivity lifecycle retries quietly.
      }
      void refreshAccountState(uid, { reason: 'maintenance_recovered' }).then((outcome) => {
        void handleRefreshOutcome(outcome, { userId: uid });
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch]);

  // CRITICAL: Stack MUST always render unconditionally — same principle as root _layout.tsx.
  // Returning a spinner here unmounts the Stack navigator on every profile-load cycle,
  // destroying all navigation state and causing blank screens / Unmatched Route errors.
  // The index.tsx spinner covers the visual loading gap instead.
  return (
    <Stack screenOptions={{ headerShown: false }}>
      {/* Role-neutral entry — AppLayoutNav's role redirect replaces it with the
          correct dashboard as soon as the backend-verified profile resolves. */}
      <Stack.Screen name="index" />
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
      <Stack.Screen name="security-diagnostics" />
      <Stack.Screen name="my-devices" />
      <Stack.Screen name="login-history" />
      <Stack.Screen name="user-activity" />
      <Stack.Screen name="archived-courses" />
      <Stack.Screen name="offline-library" />
      <Stack.Screen name="offline-course" />
      <Stack.Screen name="force-password-change" />
      <Stack.Screen name="security-warning" />
      <Stack.Screen name="account-suspended" />
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
      {/* ── Central security gate (ALL mandatory blocks) ────────────────────
          Rendered ABOVE the entire authenticated Stack + FAB whenever a
          blocking threat is live: VPN, Developer Options, ADB, attached
          debugger, root, Frida/Xposed/Magisk, tamper, etc. Inline overlay
          (not a route): the hardware back button, deep links, and route
          navigation cannot go "around" it; it disappears automatically when
          the underlying condition clears and SecurityContext re-evaluates.
          See security-gate.tsx. */}
      <SecurityGate />
    </View>
  );
}
