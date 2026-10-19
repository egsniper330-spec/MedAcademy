/**
 * SecuritySignalReport.tsx — READ-ONLY device security diagnostic card.
 *
 * Shown on the blocking security surfaces (login-blocked / connection-blocked)
 * so the phone owner can, without a computer and without any privileged access:
 *
 *   1. SEE which device security signal is actually set on THIS device, and
 *   2. COPY a short report (signals + build/API identity + timestamp) to send to
 *      their administrator or support contact.
 *
 * WHY: the engine reports four metrologically different conditions as the same
 * event (`debug_detected`, weight 20) — test-only build, JS debug bundle,
 * emulator-like device, selected mock-location app — so a single "Debug Mode
 * Active" screen cannot tell the operator which detector fired, and the affected
 * phone cannot be attached to a workstation for logcat.
 *
 * ─── SAFETY CONTRACT (do not weaken) ─────────────────────────────────────────
 *   • Read-only: it calls getNativeSecurityFlags() (a plain measurement), and
 *     writes NOTHING — no policy, no risk score, no server-side enforcement, no
 *     security event, no cached verdict.
 *   • It cannot unblock anything: there is no dismiss/continue control, no
 *     navigation, no verify call. The parent's block decision is untouched.
 *   • It never reports an unmeasured signal as "off": a missing value renders
 *     "unknown" and an unreachable native module is labelled explicitly.
 *   • No secrets, no identifiers, no app data — only device security-signal
 *     booleans, coarse build/API identity and a timestamp.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, Platform, Pressable, AppState, useColorScheme } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Device from 'expo-device';
import { ShieldCheck, Copy, RefreshCw, AlertTriangle } from 'lucide-react-native';
import { neuColors, neuFlatStyle, useLayout } from '@/lib/neu';
import { NeuButton } from '@/components/NeuButton';
import { getAppIdentity, getAppPlatform } from '@/lib/appIdentity';
import { getNativeSecurityFlags, wasLastSecurityFlagsCallUnavailable } from '@/lib/nativeSecurity';
import {
  REPORT_SIGNALS,
  buildSecuritySignalReport,
  signalValueLabel,
  type ReportFinding,
  type ReportSignalKey,
  type SecuritySignalSnapshot,
} from '@/lib/securitySignalReport';

interface SecuritySignalReportProps {
  /**
   * Findings exactly as the authoritative evaluation reported them. The caller
   * supplies the user-facing label it already renders, so this card can never
   * disagree with the issue list above it.
   */
  findings: ReportFinding[];
}

export function SecuritySignalReport({ findings }: SecuritySignalReportProps) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const flat = neuFlatStyle(isDark);
  const layout = useLayout();

  const [snapshot, setSnapshot] = useState<SecuritySignalSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setCopied(false);
    setCopyFailed(false);
    const identity = getAppIdentity();
    const platform = getAppPlatform();

    let available = false;
    const signals: Partial<Record<ReportSignalKey, unknown>> = {};
    try {
      const flags = await getNativeSecurityFlags();
      // Read AFTER the call: this reflects whether THAT measurement reached the
      // native module (false → the values below are fail-safe defaults).
      available = !wasLastSecurityFlagsCallUnavailable();
      for (const signal of REPORT_SIGNALS) {
        const value = (flags as unknown as Record<string, unknown>)[signal.key];
        if (typeof value === 'boolean') signals[signal.key] = value;
      }
    } catch {
      // A thrown measurement is reported as unavailable — never as "off".
      available = false;
    }

    setSnapshot({
      platform,
      apiLevel: platform === 'android' && typeof Platform.Version === 'number' ? Platform.Version : null,
      deviceManufacturer: Device.manufacturer ?? null,
      deviceModel: Device.modelName ?? null,
      osVersion: Device.osVersion ?? null,
      osBuildFingerprint: Device.osBuildFingerprint ?? null,
      appVersion: identity.versionName || null,
      appBuildNumber: identity.buildNumber || null,
      nativeModuleAvailable: available,
      signals,
      findings,
      generatedAt: Date.now(),
    });
    setLoading(false);
  }, [findings]);

  useEffect(() => { void load(); }, [load]);

  // FRESHNESS: the reason this card exists is a user toggling a setting in
  // Android Settings and coming back — the screen stays mounted for that whole
  // trip, so a snapshot taken on mount would describe the state BEFORE the
  // change. Re-read on every return to the foreground (the native batch call is
  // coalesced/TTL-bounded, so this cannot become a bridge loop).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void load();
    });
    return () => sub.remove();
  }, [load]);

  const reportText = useMemo(
    () => (snapshot ? buildSecuritySignalReport(snapshot) : ''),
    [snapshot],
  );

  const onCopy = () => {
    if (!reportText) return;
    void Clipboard.setStringAsync(reportText)
      .then(() => { setCopied(true); setCopyFailed(false); })
      // A failed copy must be visible: the app holds FLAG_SECURE, so a
      // screenshot is not an alternative export path on a locked build.
      .catch(() => { setCopied(false); setCopyFailed(true); });
  };

  const unmeasured = snapshot !== null && !snapshot.nativeModuleAvailable;

  return (
    <View style={[flat, {
      borderRadius: layout.cardRadius,
      padding: layout.cardPx,
      gap: layout.pad.md,
    }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: layout.pad.sm }}>
        <ShieldCheck size={layout.bodySize + 2} color={`${c.text}99`} />
        <Text style={{ flex: 1, fontSize: layout.headingSize, fontWeight: '700', color: c.text }}>
          Device security report
        </Text>
        <Pressable
          onPress={() => void load()}
          disabled={loading}
          accessibilityRole="button"
          accessibilityLabel="Re-read device security signals"
          style={{ padding: layout.pad.xs }}
        >
          <RefreshCw size={layout.captionSize + 4} color={`${c.text}77`} />
        </Pressable>
      </View>

      <Text style={{ fontSize: layout.captionSize, color: `${c.text}88`, lineHeight: layout.captionSize * 1.5 }}>
        {'These are the security signals actually set on this device right now. This report is read-only \u2014 it does not change your risk score and cannot unlock the app. Copy it and send it to your administrator so they can see exactly which signal caused the block.'}
      </Text>

      {unmeasured && (
        <View style={{
          flexDirection: 'row', alignItems: 'flex-start', gap: layout.pad.sm,
          borderLeftWidth: 4, borderLeftColor: '#F59E0B', paddingLeft: layout.pad.sm,
        }}>
          <AlertTriangle size={layout.bodySize} color="#F59E0B" />
          <Text style={{ flex: 1, fontSize: layout.captionSize, color: c.text, lineHeight: layout.captionSize * 1.5 }}>
            The device security checks could not be measured on this device, so the values below are not a clean result. Send this report to your administrator.
          </Text>
        </View>
      )}

      {loading || !snapshot ? (
        <Text style={{ fontSize: layout.captionSize, color: `${c.text}77` }}>Reading device signals…</Text>
      ) : (
        <View style={{ gap: layout.pad.xs }}>
          {REPORT_SIGNALS.map((signal) => {
            // "unavailable" when the module could not be reached (the values are
            // then fail-safe defaults, NOT measurements) — never "off".
            const value = signalValueLabel(snapshot.signals[signal.key], snapshot.nativeModuleAvailable);
            const tone = value === 'on' ? '#EF4444' : value === 'off' ? '#22C55E' : `${c.text}66`;
            return (
              <View
                key={signal.key}
                style={{ flexDirection: 'row', alignItems: 'center', gap: layout.pad.sm }}
                accessibilityRole="text"
                accessibilityLabel={`${signal.label}: ${value}`}
              >
                <Text style={{ flex: 1, fontSize: layout.captionSize, color: c.text }}>{signal.label}</Text>
                <Text style={{ fontSize: layout.captionSize, fontWeight: '700', color: tone, textTransform: 'uppercase' }}>
                  {value}
                </Text>
              </View>
            );
          })}
          <Text style={{ fontSize: layout.captionSize - 1, color: `${c.text}55`, marginTop: layout.pad.xs }}>
            {`${snapshot.platform} ${snapshot.osVersion ?? ''}`.trim()}
            {snapshot.apiLevel !== null ? ` \u00b7 API ${snapshot.apiLevel}` : ''}
            {snapshot.appVersion ? ` \u00b7 app ${snapshot.appVersion}${snapshot.appBuildNumber ? ` (${snapshot.appBuildNumber})` : ''}` : ''}
          </Text>
        </View>
      )}

      <NeuButton
        label={copied ? 'Report copied' : 'Copy security report'}
        icon={<Copy size={layout.bodySize} color={c.text} />}
        onPress={onCopy}
        disabled={loading || !reportText}
      />
      {copyFailed && (
        <Text style={{ fontSize: layout.captionSize, color: '#F59E0B', lineHeight: layout.captionSize * 1.5 }}>
          {'Copy failed \u2014 the clipboard is unavailable on this device. Read the values above and send them to your administrator.'}
        </Text>
      )}
    </View>
  );
}
