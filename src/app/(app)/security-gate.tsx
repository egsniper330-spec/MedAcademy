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
 *     BLOCKED_MULTI_WINDOW       the platform reports THIS app in a prohibited
 *                                window mode (split-screen / other multi-window
 *                                mode, or our own picture-in-picture). Copy is
 *                                windowModeBlockCopy() for the mode actually
 *                                reported, with the recovery steps from
 *                                windowModeBlockSteps(). There is deliberately
 *                                NO recheck/dismiss control: returning the app
 *                                to full screen is the only way out, and the
 *                                native signal then clears it automatically.
 *     BLOCKED_BACKGROUND_RESUME  the app left the foreground and has not yet
 *                                completed a post-resume verification. This
 *                                state renders NO PAGE (rendersBlockScreen):
 *                                the shell is restored immediately and
 *                                protected operations/media stay locked by the
 *                                central lock until the verdict lands. It also
 *                                ranks BELOW the policy states, so a violation
 *                                confirmed during a resume is routed to its own
 *                                screen at once instead of being masked by an
 *                                interim state that displays nothing.
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
import { View, Text, StyleSheet, BackHandler, ActivityIndicator, Pressable, useColorScheme, ScrollView, Platform } from 'react-native';
import * as ScreenCaptureLib from '@/lib/screenCaptureGuard';
import { ShieldAlert, WifiOff, Smartphone } from 'lucide-react-native';
import { neuColors, useLayout } from '@/lib/neu';
import { useSecurity } from '@/lib/SecurityContext';
import { SecuritySignalReport } from '@/components/SecuritySignalReport';
import {
  nextStickyTypes,
  isGateBlocked,
  isGateRecheckable,
  resolveFindingCopyKey,
  isConnectionFinding,
  connectionBlockInstructions,
  rendersBlockScreen,
  windowModeBlockCopy,
  windowModeBlockSteps,
  VPN_WARNING_COPY,
  OVERLAY_WARNING_COPY,
} from '@/lib/securityStateModel';

/**
 * User-facing copy per blocking event. ROOT-CAUSE FIX (event-accurate gate
 * copy, preserved): each event has its own accurate title/instruction so a
 * device with USB debugging on never displays "Developer Options Detected",
 * and so multiple simultaneous findings can be enumerated on ONE page.
 */
const GATE_EVENT_COPY: Record<string, { title: string; instruction: string }> = {
  vpn_detected:               { title: 'VPN Connection Detected',     instruction: 'Turn off your VPN connection, then tap Verify.' },
  // MANDATORY CONNECTION BLOCK (see applyMandatoryConnectionFloor): proxy is
  // now a blocking detection bucket too, so it needs its own accurate copy —
  // without it the gate fell back to the generic "Security Requirement Not
  // Satisfied" row (accurate but unactionable).
  proxy_detected:             { title: 'Proxy Connection Detected',   instruction: 'Turn off the proxy configured for your connection, then tap Verify.' },
  developer_options_enabled:  { title: 'Developer Options Enabled',   instruction: 'Open Settings → Developer options and turn Developer options off.' },
  adb_enabled:                { title: 'USB Debugging Enabled',       instruction: 'Open Settings → Developer options and turn USB debugging off.' },
  debugger_attached:          { title: 'Debugger Detected',           instruction: 'Detach the debugger connected to this app.' },
  debug_detected:             { title: 'Insecure Build Detected',     instruction: 'Install the official production release of the app.' },
  // ── Derived from `debug_detected` by resolveFindingCopyKey ────────────────
  // SAME event type, SAME risk weight (20) and SAME block decision — but the
  // detected condition is a DEVICE STATE, not an insecure installation. These
  // two keys exist because the shared copy above asserted "Insecure Build
  // Detected / Install the official production release of the app." for them,
  // which contradicts what the engine measured and cannot be acted on (a
  // reinstall never clears a mock-location setting or an emulator). See
  // resolveFindingCopyKey in src/lib/securityStateModel.ts.
  mock_location_detected:     { title: 'Mock Location Detected',      instruction: 'Turn off mock location: Developer options \u2192 Select mock location app \u2192 None, then reopen the app.' },
  virtual_device_detected:    { title: 'Unsupported Device Detected', instruction: 'This app cannot run on an emulator or virtual device. Install it on a physical Android device.' },
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
 *
 * `keys` are COPY KEYS (resolveFindingCopyKey), not raw event types — the same
 * event type can describe different conditions (see GATE_EVENT_COPY).
 */
function gateFindings(keys: string[]): GateFinding[] {
  const matched = keys
    .map((type) => {
      const copy = GATE_EVENT_COPY[type];
      if (!copy) return null;
      return { type, ...copy, icon: (isConnectionFinding(type) ? 'vpn' : 'shield') as GateFinding['icon'] };
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
    // windowMode = the mode the multi-window block is ABOUT (the platform's
    // reported mode at engage time), so the copy cannot drift to "you are fine"
    // while the fresh post-full-screen verdict is still pending.
    windowMode,
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
  // Findings travel as COPY KEYS, not raw event types: three unrelated
  // conditions share `debug_detected` (see resolveFindingCopyKey), so the label
  // must come from the engine's own detectionMethod. The block, the policy and
  // the risk weight are unchanged — only the rendered description is corrected.
  const liveCopyKeys = threats.map((t) => resolveFindingCopyKey(t.type, t.detectionMethod));
  const stickyTypes = nextStickyTypes(gateTypesRef.current, {
    checking:        checking || evaluating,
    liveBlocking,
    liveThreatTypes: liveCopyKeys,
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
        gateTypesRef.current = result.threats.map((t) => resolveFindingCopyKey(t.type, t.detectionMethod));
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
  //   BLOCKED_MULTI_WINDOW       this app is in a prohibited window mode
  //   BLOCKED_VPN                policy block caused by a VPN/proxy
  //   BLOCKED_SECURITY_VIOLATION any other policy block
  //   BLOCKED_BACKGROUND_RESUME  left the foreground, not yet re-verified
  //   CHECKING                   no completed verdict, or a check running
  //   ALLOWED                    completed verdict, nothing blocking
  //
  // TWO different questions, two different predicates:
  //   isGateBlocked(state)       — must protected content/operations be withheld?
  //                                (true for every BLOCKED_* state; this is what
  //                                 the transport gate and the lock enforce)
  //   rendersBlockScreen(state)  — does this state take over the whole screen?
  //
  // BLOCKED_BACKGROUND_RESUME is BLOCKED but renders NO page: an ordinary resume
  // restores the app shell immediately (protected operations stay refused and
  // protected playback stays stopped until a clean post-resume verdict lands).
  // The previous full-screen VERIFYING page was the reported defect — a visible
  // verification interruption on a clean device, with a Continue control that
  // could not even clear the hold when an evaluation was already running.
  //
  // CHECKING is NEVER a block: with no completed verdict the gate does not
  // mount (startup-flash contract). Pure warn_only threats (hasWarnings without
  // blocksLogin) do not gate — they surface on the security-warning screen.
  const blocking = isGateBlocked(gateState);
  const blockScreen = rendersBlockScreen(gateState);
  const overlayBlocked = gateState === 'BLOCKED_OVERLAY';
  // The multi-window restriction. Copy comes from the pure model, selected by
  // the mode the platform ACTUALLY reported (a split screen and a floating
  // picture-in-picture window are different conditions with different recovery
  // actions — and neither is ever worded as an overlay).
  const windowModeBlockedState = gateState === 'BLOCKED_MULTI_WINDOW';
  const multiWindowCopy = windowModeBlockCopy(windowMode);
  // A VPN/proxy block renders the MANDATORY connection page: it states the
  // policy, tells the user exactly where to switch the VPN/proxy off (the app
  // cannot do it for them — iOS exposes no API to stop another app's tunnel),
  // and offers a re-verify control that can only clear the gate when a FRESH
  // authoritative evaluation finds no connection finding. There is deliberately
  // no dismiss, no "Continue Anyway" and no route around it (the gate is
  // inline content above the whole authenticated Stack).
  const vpnBlocked = gateState === 'BLOCKED_VPN';
  // ONE step list for both actionable window/connection causes (same markup, one
  // source per cause in the pure model): returning to full screen for the
  // multi-window restriction, switching the VPN/proxy off for a connection block.
  const stepsLabel = windowModeBlockedState ? 'HOW TO RETURN TO FULL SCREEN' : 'HOW TO TURN IT OFF';
  const steps = windowModeBlockedState
    ? windowModeBlockSteps(windowMode)
    : (vpnBlocked ? connectionBlockInstructions(Platform.OS) : []);
  // Only the two user-actionable causes offer a recheck control.
  const recheckable = isGateRecheckable(gateState);
  const types = liveBlocking ? liveCopyKeys : stickyTypes;
  // Overlay / resume states carry their own dedicated copy — listing policy
  // findings would be misleading when the cause is not a policy finding.
  const findings = overlayBlocked || windowModeBlockedState ? [] : gateFindings(types);
  // READ-ONLY device diagnostic for the POLICY block pages (the ones a
  // `debug_detected` false positive produces). It is the in-app counterpart of
  // the card on the pre-login Access Blocked screen: policy blocking findings
  // are NEVER routed to /security-warning (see (app)/_layout), so without this
  // the gate was the one block screen with no way to read the six raw signals.
  // Same component, same read-only contract — it cannot dismiss the gate.
  const reportFindings = liveBlocking
    ? threats.map((t) => ({
        label: GATE_EVENT_COPY[resolveFindingCopyKey(t.type, t.detectionMethod)]?.title ?? 'Security Issue',
        type: t.type,
        detectionMethod: t.detectionMethod ?? null,
      }))
    : [];
  const revalidating = !liveBlocking && !overlayBlocked
    && !windowModeBlockedState && (checking || evaluating);

  const onVerify = () => {
    if (verifying) return;
    setVerifying(true);
    void verifySecurity().finally(() => setVerifying(false));
  };

  // Defensive belt-and-suspenders: while the gate is shown, block the Android
  // hardware back button entirely — there is no route to pop to, but an
  // explicit handler guarantees no navigator transition can dismiss the gate.
  useEffect(() => {
    // Keyed on the PAGE, not on containment: during a resume verification there is
    // no page, so the back button must behave normally (the restriction is
    // enforced at the operation layer, not by trapping navigation).
    if (!blockScreen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true); // consume
    return () => sub.remove();
  }, [blockScreen]);

  // ── FLAG_SECURE while gated (defense in depth, preserved) ─────────────────
  // The gate is a block_screen: whatever is underneath it (or captured while
  // it is displayed) must never be photographable — including during the
  // re-validating window. Keyed 'security-gate' so it stacks with the
  // app-shell and lesson locks without racing them; released on unblock.
  useEffect(() => {
    if (process.env.EXPO_OS === 'web') return;
    if (!blockScreen) return;
    let active = true;
    ScreenCaptureLib.preventScreenCaptureAsync('security-gate').catch(() => {});
    return () => {
      active = false;
      // Re-allowing is ALWAYS safe: expo-screen-capture ref-counts keyed locks
      // in JS (activeTags set) — the OS flag only drops when the last key is
      // released, so removing ours never lifts the app-shell/lesson locks.
      ScreenCaptureLib.allowScreenCaptureAsync('security-gate').catch(() => {});
    };
  }, [blockScreen]);

  // No page for the interim resume state (and none for CHECKING/ALLOWED): the app
  // shell stays, containment stays.
  if (!blocking || !blockScreen) return null;

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
          {vpnBlocked
            ? <WifiOff size={layout.heroIconSize * 0.5} color="#EF4444" />
            : windowModeBlockedState
              ? <Smartphone size={layout.heroIconSize * 0.5} color="#EF4444" />
              : <ShieldAlert size={layout.heroIconSize * 0.5} color="#EF4444" />}
        </View>
        <Text
          style={[styles.title, { color: c.text, fontSize: layout.titleSize }]}
          accessibilityRole="header"
        >
          {overlayBlocked
            ? OVERLAY_WARNING_COPY.title.toUpperCase()
            : windowModeBlockedState
              ? multiWindowCopy.title.toUpperCase()
              : vpnBlocked
                ? VPN_WARNING_COPY.title.toUpperCase()
                : 'SECURITY BLOCK ACTIVE'}
        </Text>
        <Text style={[styles.subtitle, { color: `${c.text}CC`, fontSize: layout.bodySize }]}>
          {overlayBlocked
            ? OVERLAY_WARNING_COPY.message
            : windowModeBlockedState
              ? multiWindowCopy.message
              : vpnBlocked
                ? VPN_WARNING_COPY.message
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

        {/* HOW TO TURN IT OFF — platform-specific, honest, actionable steps for
            a VPN/proxy block. Required because the app CANNOT disable a
            third-party VPN: iOS gives an app no API to stop a Network Extension
            another app owns, so the instruction must be "do it yourself, then
            return". */}
        {steps.length > 0 && (
          <>
            <Text
              style={[styles.sectionLabel, { color: `${c.text}80`, fontSize: layout.captionSize }]}
              accessibilityRole="header"
            >
              {stepsLabel}
            </Text>
            <View style={styles.findingsList}>
              {steps.map((step, i) => (
                <View key={step} style={[styles.findingRow, { borderColor: `${c.text}1F` }]}>
                  <View style={[styles.findingIcon, { backgroundColor: '#EF444414' }]}>
                    <Text style={{ color: '#EF4444', fontWeight: '800' }}>{i + 1}</Text>
                  </View>
                  <Text
                    style={{
                      flex: 1,
                      color: `${c.text}CC`,
                      fontSize: layout.captionSize + 1,
                      lineHeight: (layout.captionSize + 1) * 1.45,
                    }}
                  >
                    {step}
                  </Text>
                </View>
              ))}
            </View>
          </>
        )}

        {/* SAFE RECHECK — offered for the causes the USER can actually remove: an
            overlay to close, a backgrounded session to re-verify, or a VPN/proxy
            to switch off. It only REQUESTs a recheck; it cannot force the gate
            open — the state clears when a FRESH authoritative evaluation finds
            no blocking finding (the native vpnStateChanged signal and every
            foreground return also trigger that re-check automatically). A
            generic integrity violation (root/tamper) still has no control:
            retrying cannot change a device condition that has not changed. */}
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
        {hasVerdict && !overlayBlocked && !windowModeBlockedState && (
          <View style={[styles.pill, { backgroundColor: '#EF444418' }]}>
            <Text style={{ fontSize: layout.captionSize, fontWeight: '700', color: '#EF4444' }}>
              Risk Score: {riskScore}
            </Text>
          </View>
        )}

        {/* READ-ONLY diagnostic — shows which raw signal is actually set and
            lets the user copy it, on the block page itself (no computer, no
            login, no privileged access). It cannot dismiss the gate. */}
        {!overlayBlocked && !windowModeBlockedState && (
          <View style={{ width: '100%', marginTop: 4 }}>
            <SecuritySignalReport findings={reportFindings} />
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
              : windowModeBlockedState
                ? 'MedAcademy only runs full-screen. Protected content stays closed while the app is in split-screen or another multi-window mode, and access returns automatically as soon as it is full-screen again.'
                : vpnBlocked
                  ? 'MedAcademy cannot run while a VPN or proxy is active \u2014 protected content and playback stay closed. Access is restored automatically once the connection is clear and a fresh security check passes.'
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
