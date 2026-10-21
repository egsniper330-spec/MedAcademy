/**
 * UpdateAuthGate — the authentication checkpoint for the app-update policy.
 *
 * Wraps the (auth) route group so every authentication surface (sign-in,
 * sign-up, forgot-password, security warning, suspended account) obeys the same
 * rule as the protected shell:
 *
 *   • a CONFIRMED mandatory update covers the screen with the existing
 *     full-screen update page, so no credentials can create a session on a
 *     build the server refuses;
 *   • an UNRESOLVED check never hides anything — the sign-in screen renders
 *     normally while the version request runs in the background.
 *
 * WHY AN OVERLAY (not a replacement of <Stack>): expo-router needs its
 * navigator mounted at all times — conditionally returning a non-navigator
 * leaves the route table empty and can produce "Unmatched Route" when the
 * block clears. The child navigator therefore stays mounted underneath, and
 * the update page is an inline, non-dismissible overlay (the same technique as
 * SecurityGate): there is no route to navigate away from it, and it renders
 * above every auth screen.
 *
 * On mount it also makes sure the background check is running (joining an
 * existing request), so reaching an authentication screen is itself a
 * checkpoint: if the user lands on sign-in while the check is still in flight
 * from app initialization, no second request is fired; if the check failed or
 * was never started, exactly one is.
 */

import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { ensureUpdateCheck } from '@/lib/updateConfigService';
import { useUpdate } from '@/lib/useForceUpdate';
import ForceUpdateScreen from '@/components/ForceUpdateScreen';

export function UpdateAuthGate({ children }: { children: React.ReactNode }) {
  const update = useUpdate();

  useEffect(() => {
    // Idempotent: joins the in-flight request, or starts one when this session
    // has no verdict yet. Never awaited — the screen renders immediately.
    ensureUpdateCheck();
  }, []);

  return (
    <View style={{ flex: 1 }}>
      {children}
      {update.gateBlocks && (
        <View
          style={[StyleSheet.absoluteFill, styles.cover]}
          // Opaque from the first frame (matches ForceUpdateScreen's own
          // background) so the auth form is never visible through it.
          accessibilityViewIsModal
        >
          <ForceUpdateScreen />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { backgroundColor: '#0B1120' },
});

export default UpdateAuthGate;
