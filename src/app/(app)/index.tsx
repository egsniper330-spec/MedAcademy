/**
 * (app) index — role-neutral entry screen.
 *
 * The app-shell's role-based redirect in _layout.tsx (AppLayoutNav) is the
 * authoritative router: it waits for the backend-verified profile, then
 * replaces the route with the correct role dashboard (student / doctor /
 * admin / super_admin, or force-password-change).
 *
 * This screen exists so that navigating INTO the app shell (root index
 * redirect, deep link to the app root, Stack.Protected fallback) resolves to
 * a deterministic, role-neutral route instead of the first registered group
 * screen. Previously the shell resolved to the Super Admin dashboard, so a
 * restored Doctor/Admin/Super-Admin session briefly mounted /sa-overview —
 * firing Super-Admin-only API calls (403 noise in every non-SA session) and
 * flashing the wrong dashboard before the role redirect corrected it.
 *
 * It never renders in practice: the redirect effect fires as soon as the
 * profile resolves (usually before first paint completes). The spinner is a
 * safe visual for the profile-fetch window.
 */
import { View, ActivityIndicator, useColorScheme } from 'react-native';
import { neuColors } from '@/lib/neu';

export default function AppShellEntry() {
  const scheme = useColorScheme();
  const c = scheme === 'dark' ? neuColors.dark : neuColors.light;

  return (
    <View style={{ flex: 1, backgroundColor: c.base, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator size="large" color={c.primary} />
    </View>
  );
}
