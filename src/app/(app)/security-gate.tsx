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

import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, BackHandler, ActivityIndicator, useColorScheme, ScrollView } from 'react-native';
import * as ScreenCaptureLib from 'expo-screen-capture';
import { ShieldAlert, WifiOff } from 'lucide-react-native';
import { neuColors, useLayout } from '@/lib/neu';
import { useSecurity } from '@/lib/SecurityContext';
import { nextStickyTypes } from '@/lib/securityStateModel';

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
  const { threats, riskScore, blocksLogin, checking, onNewBlockingThreat } = useSecurity();
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
    checking,
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

  // Gate condition: EITHER the live result blocks (server-configured policy,
  // client fallback identical) OR a previously-verified blocking state is
  // still being re-validated. Pure warn_only threats (hasWarnings without
  // blocksLogin) do NOT gate — they surface on the security-warning screen.
  const blocking = liveBlocking || stickyTypes.length > 0;
  const types = liveBlocking ? threats.map((t) => t.type) : stickyTypes;
  const revalidating = !liveBlocking && checking;
  const findings = gateFindings(types);

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
          <ShieldAlert size={layout.heroIconSize * 0.5} color="#EF4444" />
        </View>
        <Text
          style={[styles.title, { color: c.text, fontSize: layout.titleSize }]}
          accessibilityRole="header"
        >
          SECURITY BLOCK ACTIVE
        </Text>
        <Text style={[styles.subtitle, { color: `${c.text}CC`, fontSize: layout.bodySize }]}>
          Your device does not currently meet MedAcademy&apos;s security requirements.
        </Text>

        {/* Detected issues — EVERY live finding on ONE page */}
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

        {/* Risk score — informational telemetry from the same authoritative
            result that drives the findings (never an independent decision). */}
        <View style={[styles.pill, { backgroundColor: '#EF444418' }]}>
          <Text style={{ fontSize: layout.captionSize, fontWeight: '700', color: '#EF4444' }}>
            Risk Score: {riskScore}
          </Text>
        </View>

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
            This app is locked for your protection. It unlocks automatically once all security issues are resolved.
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
