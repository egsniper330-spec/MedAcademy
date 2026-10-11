/**
 * security-gate.tsx — Central non-dismissible security gate (FULL-SCREEN PAGE).
 *
 * STATE-SYNC FIX (this round — see final report):
 *   1. STICKY-NEVER-CLEARS: the previous sticky ref only ever ADDED types and
 *      never cleared, so the first blocking evaluation locked the gate until
 *      process death — even after a COMPLETED evaluation returned a verified
 *      safe state (observed on device as "Risk Score: 0 but the block
 *      remains"). The transition is now the pure, unit-tested
 *      nextStickyTypes() (securityStateModel.ts):
 *        live blocking result      → sticky = live types (refresh)
 *        re-check in flight        → sticky unchanged (fail-closed — no
 *                                    BLOCKED → CHECKING → TEMP-ALLOWED race)
 *        completed non-blocking    → sticky = [] (RECOVER — gate unmounts,
 *                                    no restart required)
 *   2. DIALOG-LOOK: the gate previously rendered a centered rounded card
 *      (maxWidth 420) over a dimmed backdrop — visually a modal dialog. It is
 *      now a true FULL-SCREEN PAGE: opaque full-bleed background occupying
 *      the whole content area, with EVERY live finding listed in one
 *      authoritative list (no queued/separate dialogs).
 *   3. HONEST SENTINEL: the fail-closed "evaluation in progress" state now
 *      carries the dedicated 'security_unverified' event (accurate copy)
 *      instead of the mislabeled 'tamper_detected' that showed "App Integrity
 *      Compromised" on OFFICIAL installs at every cold start.
 *
 * OVERLAY + BACKGROUND/RESUME EXTENSION (latest round):
 *   The gate is now driven by ONE centralized state
 *   (securityStateModel.resolveSecurityGateState) instead of a locally
 *   re-derived boolean, so all four independent inputs share a vocabulary:
 *
 *     BLOCKED_OVERLAY            a live obscured-window signal from the
 *                                Android touch filter. Copy is exactly
 *                                OVERLAY_WARNING_COPY; a recheck control is
 *                                offered but cannot dismiss the block — it
 *                                clears only when the platform reports the
 *                                signal gone AND a fresh evaluation passes.
 *     BLOCKED_BACKGROUND_RESUME  the app left the foreground and has not yet
 *                                completed a post-resume verification, so no
 *                                protected screen or playback is briefly
 *                                revealed on return.
 *     BLOCKED_VPN                a policy block caused by a VPN/proxy.
 *     BLOCKED_SECURITY_VIOLATION any other policy block (root, tamper, ...).
 *     CHECKING / ALLOWED         never a block / nothing blocking.
 *
 * ARCHITECTURE (unchanged — proven non-bypassable):
 *   Rendered by (app)/_layout.tsx ABOVE the entire authenticated Stack as
 *   inline content (not a route, not a Modal): nothing to navigate "around",
 *   the hardware back button cannot reach any app screen, deep links render
 *   the gate too, background/foreground re-checks keep it enforced, and an
 *   app restart re-runs session-start checks before any content is
 *   interactable. Backend logging continues via logThreats in SecurityContext.
 *   Exactly ONE blocking presentation path exists: Security Engine → Security
 *   State → this gate → this full-screen page. The dismissible
 *   /security-warning screen is the warn_only path only (block_login threats
 *   are never routed there — see (app)/_layout.tsx).
 */

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, BackHandler, ActivityIndicator, Pressable, useColorScheme, ScrollView } from 'react-native';
import * as ScreenCaptureLib from '@/lib/screenCaptureGuard';
import { ShieldAlert, WifiOff, Eye } from 'lucide-react-native';
import { neuColors, useLayout } from '@/lib/neu';
import { useSecurity } from '@/lib/SecurityContext';
import {
  nextStickyTypes,
  isGateBlocked,
  isGateRecheckable,
  OVERLAY_WARNING_COPY,
} from '@/lib/securityStateModel';

/**
 * User-facing copy per blocking event. ROOT-CAUSE FIX (event-accurate gate
 * copy, preserved): each event has its own accurate title/instruction so a
 * device with USB debugging on never displays "Developer Options Detected",
 * and so multiple simultaneous findings can be enumerated on ONE page.
 */
const GATE_EVENT_COPY: Record<string, { title: string; instruction: string }> = {
  vpn_detected:               { title: 'VPN Connection Detected',     instruction: 'Turn off your VPN or proxy connection.' },
  developer_options_enabled:  { title: 'Developer Options Enabled',   instruction: 'Open Settings → Developer options and turn Developer options off.' },
  adb_enabled:                { title: 'USB Debugging Enabled',       instruction: 'Open Settings → Developer options and turn USB debugging off.' },
  debugger_attached:          { title: 'Debugger Detected',           instruction: 'Detach the debugger connected to this app.' },
  debug_detected:             { title: 'Insecure Build Detected',     instruction: 'Install the official production release of the app.' },
  root_detected:              { title: 'Root Access Detected',        instruction: 'Root access was detected on this device. Contact support for assistance.' },
  jailbreak_detected:         { title: 'Jailbreak Detected',          instruction: 'Jailbreak access was detected on this device. Contact support for assistance.' },
  frida_detected:             { title: 'Tampering Framework Detected', instruction: 'Remove the code-injection framework from this device.' },
  xposed_detected:            { title: 'Tampering Framework Detected', instruction: 'Remove the hooking framework from this device.' },
  magisk_detected:            { title: 'Root Management Detected',    instruction: 'Remove the root management tool from this device.' },
  tamper_detected:            { title: 'App Integrity Compromised',   instruction: 'This installation failed integrity verification. Install the official release.' },
  signature_invalid:          { title: 'App Integrity Compromised',   instruction: 'This installation failed integrity verification. Install the official release.' },
  ssl_pinning_failure:        { title: 'Connection Security Issue',   instruction: 'A secure connection to the server could not be verified. Reconnect and try again.' },
  play_integrity_failed:      { title: 'Device Integrity Check Failed', instruction: 'This device failed the integrity check required to run the app.' },
  app_attest_failed:          { title: 'Device Integrity Check Failed', instruction: 'This device failed the integrity check required to run the app.' },
  overlay_detected:           { title: 'Screen Overlay Detected',     instruction: 'Turn off screen overlays (e.g. screen filters, chat heads) for this app.' },
  screen_recording_detected:  { title: 'Screen Recording Detected',   instruction: 'Stop screen recording or mirroring to continue.' },
  // Fail-closed sentinel (NOT a device finding): shown only while an
  // evaluation is running or could not complete. Honest copy — it resolves
  // automatically when the real evaluation lands; it never claims the
  // installation is tampered with.
  security_unverified:        { title: 'Security Check Incomplete',   instruction: 'The security evaluation could not complete. The app is re-verifying automatically and will unlock if no issue is found.' },
};

interface GateFinding {
  type: string;
  title: string;
  instruction: string;
  icon: 'vpn' | 'shield';
}

/**
 * Builds the finding list rendered on the page. EVERY live blocking event is
 * listed (BUG #3C — multiple issues on ONE page, no queued dialogs); unknown
 * event types get an explicit generic row instead of vanishing.
 */
function gateFindings(types: string[]): GateFinding[] {
  const matched = types
    .map((type) => {
      const copy = GATE_EVENT_COPY[type];
      if (!copy) return null;
      return { type, ...copy, icon: (type === 'vpn_detected' ? 'vpn' : 'shield') as GateFinding['icon'] };
    })
    .filter((f): f is GateFinding => f !== null);

  if (matched.length > 0) return matched;

  // No known copy (e.g. a future server-side event type): still show ONE
  // authoritative row rather than an empty or ambiguous screen.
  return [{
    type: '__unknown__',
    title: 'Security Requirement Not Satisfied',
    instruction: 'A security policy is not satisfied on this device. Resolve the issue to continue.',
    icon: 'shield',
  }];
}

export function SecurityGate() {
  const {
    threats, riskScore, blocksLogin, checking, evaluating, hasVerdict,
    gateState, verifySecurity, onNewBlockingThreat,
  } = useSecurity();
  const [verifying, setVerifying] = useState(false);
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  // ── Sticky block state (pure transition — see nextStickyTypes doc) ─────────
  // Fail-closed DURING evaluation, recoverable AFTER it. The ref persists the
  // last verified blocking set; the render derives the next state from the
  // live result + checking flag, so a COMPLETED safe evaluation clears it and
  // the app unlocks without a restart, while an in-flight re-check never
  // flashes a temporary all-clear.
  const gateTypesRef = useRef<string[]>([]);
  const liveBlocking = blocksLogin && threats.length > 0;
  const stickyTypes = nextStickyTypes(gateTypesRef.current, {
    checking:        checking || evaluating,
    liveBlocking,
    liveThreatTypes: threats.map((t) => t.type),
  });
  gateTypesRef.current = stickyTypes;

  // Keep the sticky set authoritative against asynchronous blocking detections
  // (native VPN callback → runPeriodicCheck → onNewBlockingThreat fires with
  // the full result even when this component is mid-transition). Recovery is
  // handled by the render-time transition above, not here.
  useEffect(() => {
    if (!onNewBlockingThreat) return;
    const unsub = onNewBlockingThreat((result) => {
      if (result.blocksLogin && result.threats.length > 0) {
        gateTypesRef.current = result.threats.map((t) => t.type);
      }
    });
    return () => unsub?.();
  }, [onNewBlockingThreat]);

  // ── GATE CONDITION ──────────────────────────────────────────────────────
  // Driven by the CENTRALIZED gate state (securityStateModel.resolveSecurityGateState,
  // computed once in SecurityContext), not by a locally re-derived boolean.
  // Every cause of a block is one named state:
  //
  //   BLOCKED_OVERLAY            live obscured-window signal (native touch filter)
  //   BLOCKED_BACKGROUND_RESUME  left the foreground, not yet re-verified
  //   BLOCKED_VPN                policy block caused by a VPN/proxy
  //   BLOCKED_SECURITY_VIOLATION any other policy block
  //   CHECKING                   no completed verdict, or a check running
  //   ALLOWED                    completed verdict, nothing blocking
  //
  // CHECKING is NEVER a block: with no completed verdict the gate does not
  // mount (startup-flash contract). Pure warn_only threats (hasWarnings without
  // blocksLogin) do not gate — they surface on the security-warning screen.
  const blocking = isGateBlocked(gateState);
  const overlayBlocked = gateState === 'BLOCKED_OVERLAY';
  const resumeBlocked = gateState === 'BLOCKED_BACKGROUND_RESUME';
  // Only the two user-actionable causes offer a recheck control.
  const recheckable = isGateRecheckable(gateState);
  const types = liveBlocking ? threats.map((t) => t.type) : stickyTypes;
  // Overlay / resume states carry their own dedicated copy — listing policy
  // findings would be misleading when the cause is not a policy finding.
  const findings = overlayBlocked || resumeBlocked ? [] : gateFindings(types);
  const revalidating = !liveBlocking && !overlayBlocked && !resumeBlocked && (checking || evaluating);

  const onVerify = () => {
    if (verifying) return;
    setVerifying(true);
    void verifySecurity().finally(() => setVerifying(false));
  };

  // Defensive belt-and-suspenders: while the gate is shown, block the Android
  // hardware back button entirely — there is no route to pop to, but an
  // explicit handler guarantees no navigator transition can dismiss the gate.
  useEffect(() => {
    if (!blocking) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true); // consume
    return () => sub.remove();
  }, [blocking]);

  // ── FLAG_SECURE while gated (defense in depth, preserved) ─────────────────
  // The gate is a block_screen: whatever is underneath it (or captured while
  // it is displayed) must never be photographable — including during the
  // re-validating window. Keyed 'security-gate' so it stacks with the
  // app-shell and lesson locks without racing them; released on unblock.
  useEffect(() => {
    if (process.env.EXPO_OS === 'web') return;
    if (!blocking) return;
    let active = true;
    ScreenCaptureLib.preventScreenCaptureAsync('security-gate').catch(() => {});
    return () => {
      active = false;
      // Re-allowing is ALWAYS safe: expo-screen-capture ref-counts keyed locks
      // in JS (activeTags set) — the OS flag only drops when the last key is
      // released, so removing ours never lifts the app-shell/lesson locks.
      ScreenCaptureLib.allowScreenCaptureAsync('security-gate').catch(() => {});
    };
  }, [blocking]);

  if (!blocking) return null;

  return (
    <View style={[styles.page, { backgroundColor: c.base }]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.inner}
        bounces={false}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={[styles.iconWrap, { backgroundColor: '#EF444418' }]}>
          {resumeBlocked
            ? <Eye size={layout.heroIconSize * 0.5} color="#EF4444" />
            : <ShieldAlert size={layout.heroIconSize * 0.5} color="#EF4444" />}
        </View>
        <Text
          style={[styles.title, { color: c.text, fontSize: layout.titleSize }]}
          accessibilityRole="header"
        >
          {overlayBlocked
            ? OVERLAY_WARNING_COPY.title.toUpperCase()
            : resumeBlocked
              ? 'VERIFYING YOUR SESSION'
              : 'SECURITY BLOCK ACTIVE'}
        </Text>
        <Text style={[styles.subtitle, { color: `${c.text}CC`, fontSize: layout.bodySize }]}>
          {overlayBlocked
            ? OVERLAY_WARNING_COPY.message
            : resumeBlocked
              ? 'MedAcademy was in the background. Security is being re-verified before protected content is shown again.'
              : 'Your device does not currently meet MedAcademy\u2019s security requirements.'}
        </Text>

        {/* Detected issues — EVERY live finding on ONE page. Rendered only for
            the policy-driven states; the overlay / resume states explain
            themselves above and would be misleading with a findings list. */}
        {findings.length > 0 && (
          <>
            <Text
              style={[styles.sectionLabel, { color: `${c.text}80`, fontSize: layout.captionSize }]}
              accessibilityRole="header"
            >
              DETECTED ISSUES
            </Text>
            <View style={styles.findingsList}>
              {findings.map((finding) => {
                const RowIcon = finding.icon === 'vpn' ? WifiOff : ShieldAlert;
                return (
                  <View
                    key={finding.type}
                    style={[styles.findingRow, { borderColor: `${c.text}1F` }]}
                    accessibilityRole="text"
                  >
                    <View style={[styles.findingIcon, { backgroundColor: '#EF444414' }]}>
                      <RowIcon size={18} color="#EF4444" />
                    </View>
                    <View style={styles.findingText}>
                      <Text style={{ color: c.text, fontSize: Math.max(14, layout.bodySize), fontWeight: '700' }}>
                        {finding.title}
                      </Text>
                      <Text style={{ color: `${c.text}B3`, fontSize: layout.captionSize + 1, lineHeight: (layout.captionSize + 1) * 1.45, marginTop: 2 }}>
                        {finding.instruction}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>
          </>
        )}

        {/* SAFE RECHECK — offered only for the user-actionable causes (an
            overlay to close, a backgrounded session to re-verify). It REQUESTs
            a recheck; it cannot force the gate open: the state clears only when
            the platform reports the obscured signal gone AND a fresh security
            evaluation passes (canClearOverlayBlock). Policy blocks (VPN /
            violation) deliberately have no button — retrying cannot change a
            device condition that has not changed. */}
        {recheckable && (
          <Pressable
            onPress={onVerify}
            disabled={verifying}
            accessibilityRole="button"
            accessibilityLabel="Verify security and continue"
            accessibilityState={{ disabled: verifying, busy: verifying }}
            style={({ pressed }) => ([
              styles.verifyBtn,
              { backgroundColor: pressed || verifying ? '#DC2626' : '#EF4444' },
            ])}
          >
            {verifying
              ? <ActivityIndicator size="small" color="#FFFFFF" />
              : <ShieldAlert size={18} color="#FFFFFF" />}
            <Text style={styles.verifyBtnText}>
              {verifying ? 'Verifying\u2026' : 'Verify security and continue'}
            </Text>
          </Pressable>
        )}

        {/* Risk score — informational telemetry from the same authoritative
            result that drives the findings (never an independent decision).
            Rendered ONLY from a completed verdict (hasVerdict): the
            fail-closed sentinel's weight can no longer surface here as a
            fake "Risk Score: 10" — pending states never mount this page. */}
        {hasVerdict && !overlayBlocked && !resumeBlocked && (
          <View style={[styles.pill, { backgroundColor: '#EF444418' }]}>
            <Text style={{ fontSize: layout.captionSize, fontWeight: '700', color: '#EF4444' }}>
              Risk Score: {riskScore}
            </Text>
          </View>
        )}

        {/* Fail-closed visibility: while a re-check re-validates a previously
            verified block (or the sentinel is live), say so — the user is
            never shown an ambiguous unlock mid-check, never a silent gap. */}
        {revalidating && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <ActivityIndicator size="small" color="#EF4444" />
            <Text style={{ fontSize: layout.captionSize, color: `${c.text}99` }}>
              Re-validating security state…
            </Text>
          </View>
        )}

        {/* Locked footer — the page is non-dismissible and self-recovering. */}
        <View style={[styles.statusRow, { backgroundColor: `${c.text}0A` }]}>
          <ShieldAlert size={Math.max(18, layout.captionSize + 4)} color={`${c.text}99`} />
          <Text
            style={{
              fontSize: Math.max(13, layout.captionSize + 1),
              color: `${c.text}CC`,
              flex: 1,
              lineHeight: Math.max(18, (layout.captionSize + 1) * 1.45),
            }}
            accessibilityRole="text"
          >
            {overlayBlocked
              ? 'Protected content stays hidden while an overlay or another app may be interfering. Closing the interfering app and verifying security restores access.'
              : resumeBlocked
                ? 'Access stays held for your protection until the post-resume security check finishes. It unlocks automatically when the check passes.'
                : 'This app is locked for your protection. It unlocks automatically once all security issues are resolved.'}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  // FULL-SCREEN PAGE — opaque, full-bleed, occupies the whole content area.
  // NOT a centered card over a dimmed backdrop (that presentation read as a
  // dialog on the physical device).
  page: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
    elevation: 100,
  },
  scroll: {
    flex: 1,
  },
  inner: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 14,
  },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontWeight: '800',
    textAlign: 'center',
    letterSpacing: 0.5,
  },
  subtitle: {
    textAlign: 'center',
    opacity: 0.8,
    maxWidth: 480,
  },
  sectionLabel: {
    fontWeight: '800',
    letterSpacing: 1,
    marginTop: 6,
  },
  findingsList: {
    width: '100%',
    maxWidth: 520,
    gap: 10,
  },
  findingRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 14,
  },
  findingIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  findingText: {
    flex: 1,
  },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  verifyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    minHeight: 52,
    paddingHorizontal: 26,
    borderRadius: 14,
    marginTop: 6,
  },
  verifyBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    maxWidth: 520,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    marginTop: 4,
  },
});
