import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, Linking, Modal, Pressable, useColorScheme, ActivityIndicator, Platform,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import {
  ShieldAlert, ShieldCheck, AlertTriangle, Wifi, WifiOff, Globe,
  Bug, Fingerprint, Lock, ArrowRight, Phone, X as XIcon,
  Mail, MessageCircle, Send, Megaphone, AtSign, Link2, MapPin, Smartphone,
} from 'lucide-react-native';
import { neuColors, neuFlatStyle, neuPressedStyle, useLayout } from '@/lib/neu';
import { NeuButton } from '@/components/NeuButton';
import { useProfileStore } from '@/lib/store';
import { dashboardPathForRole } from '@/lib/roleRoutes';
import {
  hasConnectionFinding, connectionBlockInstructions, resolveFindingCopyKey, VPN_WARNING_COPY,
} from '@/lib/securityStateModel';
import { SecuritySignalReport } from '@/components/SecuritySignalReport';
import {
  getPublicSupportContacts, type PublicSupportContact,
  SUPPORT_ICONS, type SupportPlatformKey,
  type SupportContactEntry,
} from '@/lib/api';

// ─── Threat display metadata ──────────────────────────────────────────────────
// Only human-readable labels and icons — no internal method details shown to users.
type ThreatItem = { type: string; detectionMethod?: string | null };

const THREAT_META: Record<string, {
  label: string;
  description: string;
  icon: React.ComponentType<{ size: number; color: string }>;
}> = {
  root_detected:             { label: 'Root Access Detected',         description: 'Your device has been modified to gain elevated system access.',           icon: ShieldAlert },
  jailbreak_detected:        { label: 'Jailbreak Detected',           description: 'Your device has been modified to bypass platform security restrictions.', icon: ShieldAlert },
  vpn_detected:              { label: 'VPN Connection Detected',      description: 'A VPN or tunnel connection is active on your device.',                   icon: Wifi },
  proxy_detected:            { label: 'Proxy Connection Detected',    description: 'Network traffic is being routed through a proxy.',                       icon: Globe },
  debug_detected:            { label: 'Debug Mode Active',            description: 'Your device or app is running in a debug environment.',                  icon: Bug },
  // DERIVED FROM `debug_detected` by resolveFindingCopyKey (see
  // src/lib/securityStateModel.ts). The engine reports four metrologically
  // DIFFERENT conditions as this one event type and weight (20): a test-only /
  // debug-detectable build, a selected mock-location app, and an emulator-like
  // device. Labelling all of them "Debug Mode Active / running in a debug
  // environment" is inaccurate for the two device-state cases and hides the
  // actionable cause (reinstalling the app never clears either). Same event,
  // same weight, same block — only the description becomes truthful.
  mock_location_detected:    { label: 'Mock Location Detected',       description: 'Mock location is enabled. Turn it off: Settings \u2192 Developer options \u2192 Select mock location app \u2192 None, then reopen the app.', icon: MapPin },
  virtual_device_detected:   { label: 'Unsupported Device Detected', description: 'This app cannot run on an emulator or virtual device. Install it on a physical Android device.', icon: Smartphone },
  developer_options_enabled: { label: 'Developer Options Enabled',    description: 'Developer settings are active on your device.',                          icon: Bug },
  adb_enabled:               { label: 'USB Debugging Enabled',        description: 'USB debugging is enabled on your device.',                               icon: Bug },
  debugger_attached:         { label: 'Debugger Attached',            description: 'A debugger is currently connected to the app.',                          icon: Bug },
  frida_detected:            { label: 'Instrumentation Detected',     description: 'An instrumentation or hooking framework is active.',                     icon: Fingerprint },
  xposed_detected:           { label: 'Xposed Framework Detected',    description: 'A system-level hooking framework is installed on your device.',          icon: Fingerprint },
  magisk_detected:           { label: 'Root Management Detected',     description: 'A root management tool is installed on your device.',                    icon: ShieldAlert },
  overlay_detected:          { label: 'Screen Overlay Detected',      description: 'An app is displaying an overlay over this screen.',                      icon: Lock },
  app_integrity_compromised: { label: 'App Integrity Compromised',    description: 'The app may have been modified or tampered with.',                       icon: Lock },
  tamper_detected:           { label: 'App Integrity Compromised',    description: 'The app may have been modified or tampered with.',                       icon: Lock },
  signature_invalid:         { label: 'Invalid App Signature',        description: 'The app signature does not match the expected certificate.',              icon: Lock },
  ssl_pinning_failure:       { label: 'Connection Security Issue',    description: 'A secure connection to the server could not be verified.',               icon: Lock },
  play_integrity_failed:     { label: 'Device Integrity Check Failed',description: 'Your device failed a security integrity check.',                         icon: ShieldAlert },
  app_attest_failed:         { label: 'Device Integrity Check Failed',description: 'Your device failed a security integrity check.',                         icon: ShieldAlert },
  screen_recording_detected: { label: 'Screen Recording Active',      description: 'Your screen is currently being recorded or mirrored.',                   icon: Bug },
  screenshot_detected:       { label: 'Screenshot Taken',             description: 'A screenshot was captured while the app was active.',                    icon: Bug },
  security_unverified:       { label: 'Security Check Incomplete',    description: 'The security evaluation could not complete. The app will re-verify automatically.', icon: Bug },
};

/**
 * Display metadata for a reported threat. The COPY KEY is resolved from the
 * engine's own detectionMethod (resolveFindingCopyKey), never from the event
 * type alone: `debug_detected` is one event but four different measured
 * conditions. Unknown types pass through unchanged and keep the generic
 * fallback below.
 */
function threatMeta(t: ThreatItem) {
  return THREAT_META[resolveFindingCopyKey(t.type, t.detectionMethod)] ?? {
    label: 'Security Issue',
    description: 'A security issue was detected on your device.',
    icon: ShieldAlert,
  };
}

// ─── Contact chooser helpers ──────────────────────────────────────────────────

/** Open a support contact URL. The URL is already built by the backend public endpoint. */
export function openSupportUrl(url: string): void {
  void Linking.openURL(url);
}

// ─── Contact chooser modal ────────────────────────────────────────────────────
interface ContactMethod {
  platform: SupportPlatformKey;
  label: string;
  url: string;
}

function ContactChooserModal({
  visible, methods, onClose, isDark,
}: {
  visible: boolean;
  methods: ContactMethod[];
  onClose: () => void;
  isDark: boolean;
}) {
  const c = isDark ? neuColors.dark : neuColors.light;
  const flat = neuFlatStyle(isDark);
  const layout = useLayout();
  const [pressed, setPressed] = useState<string | null>(null);

  const handleContact = (method: ContactMethod) => {
    onClose();
    setTimeout(() => openSupportUrl(method.url), 200);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: layout.screenPx }}
        onPress={onClose}
      >
        <Pressable onPress={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 360 }}>
          <View style={[flat, { borderRadius: layout.cardRadius, padding: layout.cardPx, gap: layout.pad.md, backgroundColor: c.base }]}>
            {/* Header */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ fontSize: layout.headingSize, fontWeight: '700', color: c.text }}>Contact Support</Text>
              <Pressable onPress={onClose} style={{ padding: layout.pad.xs }}>
                <XIcon size={layout.bodySize + 2} color={`${c.text}88`} />
              </Pressable>
            </View>
            <Text style={{ fontSize: layout.captionSize, color: `${c.text}77`, lineHeight: layout.captionSize * 1.5 }}>
              Choose how you would like to reach our support team.
            </Text>

            {/* Method buttons */}
            {methods.map(method => {
              const Icon = (SUPPORT_ICONS[method.platform] ?? Mail);
              const isPressed = pressed === method.platform;
              const shadowStyle = isPressed ? neuPressedStyle(isDark) : flat;
              return (
                <Pressable
                  key={method.platform}
                  onPressIn={() => setPressed(method.platform)}
                  onPressOut={() => setPressed(null)}
                  onPress={() => handleContact(method)}
                >
                  <View style={[shadowStyle, {
                    borderRadius: layout.cardRadius,
                    padding: layout.cardPx,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: layout.pad.md,
                    backgroundColor: c.base,
                  }]}>
                    <View style={{
                      width: layout.touchTarget, height: layout.touchTarget,
                      borderRadius: layout.touchTarget / 2,
                      backgroundColor: `${c.primary}18`,
                      alignItems: 'center', justifyContent: 'center',
                    }}>
                      <Icon size={layout.bodySize + 4} color={c.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: layout.bodySize, fontWeight: '700', color: c.text }}>{method.label}</Text>
                      <Text style={{ fontSize: layout.captionSize, color: `${c.text}66` }} numberOfLines={1}>{method.url}</Text>
                    </View>
                    <ArrowRight size={layout.captionSize + 2} color={`${c.text}44`} />
                  </View>
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ─── Main screen ─────────────────────────────────────────────────────────────
export default function SecurityWarningScreen() {
  const router = useRouter();
  const scheme = useColorScheme();
  const layout = useLayout();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const flat = neuFlatStyle(isDark);

  const params = useLocalSearchParams<{
    threats:     string;
    riskScore:   string;
    blocksLogin: string;
    redirect:    string;
  }>();

  const threats: ThreatItem[] = React.useMemo(() => {
    try { return JSON.parse(params.threats ?? '[]'); } catch { return []; }
  }, [params.threats]);

  const riskScore   = parseInt(params.riskScore ?? '0', 10);
  const blocksLogin = params.blocksLogin === 'true';
  // READ-ONLY DIAGNOSTIC PAYLOAD (device security report below). Labels are the
  // SAME resolved metadata the issue list renders, so report and list cannot
  // disagree about which condition was measured.
  const reportFindings = React.useMemo(
    () => threats.map((t) => ({
      label: threatMeta(t).label,
      type: t.type,
      detectionMethod: t.detectionMethod ?? null,
    })),
    [threats],
  );

  // ── MANDATORY CONNECTION BLOCK (pre-login) ─────────────────────────────────
  // Same rule as the authenticated screen, enforced one screen earlier: a VPN/
  // proxy finding closes the dismissible path. This is derived from the FINDING
  // TYPES rather than from `blocksLogin`, so signing in with an active VPN no
  // longer shows "Continue Anyway", and a crafted deep link
  // (`?blocksLogin=false&threats=[{"type":"vpn_detected"}]`) cannot re-open it
  // either — the finding itself is what suppresses the button.
  // NOTE: this file deliberately does NOT read the authoritative context
  // (no session exists yet); the server-computed outcome arrives as route
  // params, which is the recorded pre-login exemption in
  // scripts/check-security-param-authority.js. It must stay presentation-only.
  const connectionBlocked = hasConnectionFinding(threats);
  const connectionSteps = connectionBlocked
    ? connectionBlockInstructions(Platform.OS)
    : [];
  // The ONLY forward action: return to sign-in, which re-runs the authoritative
  // security check before any session or protected content is created.
  const onRecheck = () => {
    router.replace('/(auth)/sign-in' as RelativePathString);
  };
  // Backend-verified role — the authoritative source for where to continue to.
  const { profile } = useProfileStore();
  // DESTINATION POLICY — do not trust the redirect param as authoritative.
  // It is a client-suppliable route string. Prefer it only when it is a real
  // value; otherwise resolve from the backend-verified profile role so a
  // non-student can never be dropped on the student tabs by this default.
  const warningRedirect = params.redirect;
  const redirect =
    (warningRedirect && warningRedirect.length > 0 ? warningRedirect : null) ??
    (dashboardPathForRole(profile?.role) ?? '/');

  // Support contact state
  const [support, setSupport]             = useState<PublicSupportContact[] | null>(null);
  const [supportLoading, setSupportLoading] = useState(true);
  //  Distinguishes a TRANSPORT failure from a real "no contacts configured"
  //  result. Previously any error fell through to an empty list, so a failed
  //  fetch rendered the misleading "Support contact is not configured" copy.
  const [supportError, setSupportError] = useState(false);
  const [chooserVisible, setChooserVisible] = useState(false);

  const loadSupportContacts = React.useCallback(() => {
    setSupportError(false);
    setSupportLoading(true);
    // Fetch from the PUBLIC endpoint — no auth required (blocked users can't
    // sign in). It stays reachable WHILE the security lock is active (the
    // transport gate exempts /support/contact), because this screen is exactly
    // where a locked user learns how to reach support.
    return getPublicSupportContacts()
      .then(s => { setSupport(s); setSupportLoading(false); setSupportError(false); })
      .catch(() => {
        setSupport(prev => prev ?? []);
        setSupportLoading(false);
        setSupportError(true);
      });
  }, []);

  useEffect(() => { void loadSupportContacts(); }, [loadSupportContacts]);

  // Build enabled contact methods list
  // Build enabled contact methods list from the PUBLIC endpoint (no auth needed).
  const contactMethods: ContactMethod[] = React.useMemo(() => {
    if (!support || support.length === 0) return [];
    return support.map(c => ({
      platform: c.platform as SupportPlatformKey,
      label:    c.label,
      url:      c.url,
    }));
  }, [support]);

  const handleContactSupport = () => {
    if (contactMethods.length === 0) return; // button is disabled
    if (contactMethods.length === 1) {
      // Single method — open directly, no chooser needed
      openSupportUrl(contactMethods[0].url);
    } else {
      setChooserVisible(true);
    }
  };

  const riskColor =
    riskScore >= 60 ? '#EF4444' :
    riskScore >= 30 ? '#F59E0B' : '#22C55E';

  const handleContinue = () => {
    router.replace(redirect as RelativePathString);
  };

  // Contact button label and disabled state
  const contactDisabled = supportLoading || contactMethods.length === 0;
  const contactLabel = supportLoading
    ? 'Loading…'
    : contactMethods.length === 0
      ? 'Support Not Configured'
      : contactMethods.length === 1
        ? `Contact via ${contactMethods[0].label}`
        : 'Contact Support';

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: layout.screenPx,
          paddingTop: layout.pad.xxl,
          gap: layout.pad.lg,
        }}
        contentInsetAdjustmentBehavior="automatic"
      >
        {/* Header */}
        <View style={{ alignItems: 'center', gap: layout.pad.md, paddingTop: layout.pad.lg }}>
          <View style={[flat, {
            width: layout.heroIconSize, height: layout.heroIconSize,
            borderRadius: layout.heroIconRadius,
            alignItems: 'center', justifyContent: 'center',
          }]}>
            {connectionBlocked
              ? <WifiOff size={Math.round(layout.heroIconSize * 0.5)} color="#EF4444" />
              : <ShieldAlert size={Math.round(layout.heroIconSize * 0.5)} color={blocksLogin ? '#EF4444' : '#F59E0B'} />}
          </View>
          <Text style={{ fontSize: layout.titleSize, fontWeight: '700', color: c.text, textAlign: 'center' }}>
            {connectionBlocked
              ? VPN_WARNING_COPY.title
              : blocksLogin ? 'Access Blocked' : 'Security Warning'}
          </Text>
          <Text style={{ fontSize: layout.bodySize, color: `${c.text}88`, textAlign: 'center', lineHeight: layout.bodySize * 1.5 }}>
            {connectionBlocked
              ? VPN_WARNING_COPY.message
              : blocksLogin
              ? 'Your device does not meet security requirements. Login has been blocked by your administrator.'
              : 'Security issues were detected on your device. Proceed with caution — some features may be restricted.'}
          </Text>
        </View>

        {/* Risk Score */}
        <View style={[flat, { borderRadius: layout.cardRadius, padding: layout.cardPx, alignItems: 'center', gap: layout.pad.sm }]}>
          <Text style={{ fontSize: layout.captionSize, fontWeight: '600', color: `${c.text}77`, letterSpacing: 1, textTransform: 'uppercase' }}>
            Device Risk Score
          </Text>
          <Text style={{ fontSize: Math.round(layout.heroIconSize * 0.55), fontWeight: '800', color: riskColor }}>{riskScore}</Text>
          <View style={{ width: '100%', height: layout.pad.xs + 2, backgroundColor: `${c.text}18`, borderRadius: layout.pad.xs }}>
            <View style={{ width: `${riskScore}%`, height: layout.pad.xs + 2, borderRadius: layout.pad.xs, backgroundColor: riskColor }} />
          </View>
          <Text style={{ fontSize: layout.captionSize, color: `${c.text}66` }}>
            {riskScore < 30 ? 'Low Risk' : riskScore < 60 ? 'Medium Risk' : 'High Risk'}
          </Text>
        </View>

        {/* Detected Threats — user-friendly labels and descriptions only */}
        <Text style={{ fontSize: layout.headingSize, fontWeight: '700', color: c.text }}>
          Detected Issues ({threats.length})
        </Text>
        {threats.map((t, i) => {
          const meta = threatMeta(t);
          const Icon = meta.icon;
          return (
            <View key={i} style={[flat, {
              borderRadius: layout.cardRadius, padding: layout.cardPx,
              flexDirection: 'row', alignItems: 'flex-start', gap: layout.pad.lg,
            }]}>
              <View style={{
                width: layout.touchTarget, height: layout.touchTarget,
                borderRadius: layout.cardRadius / 2,
                backgroundColor: `${riskColor}18`,
                alignItems: 'center', justifyContent: 'center',
              }}>
                <Icon size={layout.bodySize + 4} color={riskColor} />
              </View>
              <View style={{ flex: 1, gap: layout.pad.xs }}>
                <Text style={{ fontSize: layout.bodySize, fontWeight: '700', color: c.text }}>{meta.label}</Text>
                <Text style={{ fontSize: layout.captionSize, color: `${c.text}77`, lineHeight: layout.captionSize * 1.5 }}>
                  {meta.description}
                </Text>
              </View>
            </View>
          );
        })}

        {/* Actions */}
        {connectionBlocked ? (
          <View style={{ gap: layout.pad.md }}>
            {/* MANDATORY CONNECTION BLOCK — no Continue/dismiss control exists on
                this branch, and signing in again is the only forward action
                (sign-in re-runs the authoritative check first). */}
            <View style={[flat, {
              borderRadius: layout.cardRadius, padding: layout.cardPx,
              flexDirection: 'row', alignItems: 'center', gap: layout.pad.md,
              borderLeftWidth: 4, borderLeftColor: '#EF4444',
            }]}>
              <WifiOff size={layout.bodySize + 4} color="#EF4444" />
              <Text style={{ flex: 1, fontSize: layout.captionSize, color: c.text, lineHeight: layout.captionSize * 1.5 }}>
                {'Sign-in is blocked while a VPN or proxy is active. Turn it off, then try again \u2014 this cannot be dismissed to continue.'}
              </Text>
            </View>

            <Text style={{ fontSize: layout.headingSize, fontWeight: '700', color: c.text }}>
              How to turn it off
            </Text>
            {connectionSteps.map((step, i) => (
              <View key={step} style={[flat, {
                borderRadius: layout.cardRadius, padding: layout.cardPx,
                flexDirection: 'row', alignItems: 'flex-start', gap: layout.pad.lg,
              }]}>
                <View style={{
                  width: layout.touchTarget, height: layout.touchTarget,
                  borderRadius: layout.cardRadius / 2,
                  backgroundColor: '#EF444418',
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <Text style={{ color: '#EF4444', fontWeight: '800' }}>{i + 1}</Text>
                </View>
                <Text style={{ flex: 1, fontSize: layout.captionSize, color: c.text, lineHeight: layout.captionSize * 1.5 }}>
                  {step}
                </Text>
              </View>
            ))}

            <NeuButton
              label="I turned it off — try again"
              icon={<ArrowRight size={layout.bodySize} color="#fff" />}
              onPress={onRecheck}
              variant="primary"
            />

            {/* READ-ONLY diagnostic — offers no way past this block. */}
            <SecuritySignalReport findings={reportFindings} />
          </View>
        ) : blocksLogin ? (
          <View style={{ gap: layout.pad.md }}>
            <View style={[flat, {
              borderRadius: layout.cardRadius, padding: layout.cardPx,
              flexDirection: 'row', alignItems: 'center', gap: layout.pad.md,
              borderLeftWidth: 4, borderLeftColor: '#EF4444',
            }]}>
              <ShieldAlert size={layout.bodySize + 4} color="#EF4444" />
              <Text style={{ flex: 1, fontSize: layout.captionSize, color: c.text, lineHeight: layout.captionSize * 1.5 }}>
                {"Login is blocked by your organization's security policy. Please contact support for assistance."}
              </Text>
            </View>

            {/* Contact Support button — dynamic based on configured methods */}
            {supportLoading ? (
              <View style={[flat, {
                borderRadius: layout.cardRadius, padding: layout.cardPx,
                alignItems: 'center', justifyContent: 'center', minHeight: layout.touchTarget + 16,
              }]}>
                <ActivityIndicator color={c.primary} size="small" />
              </View>
            ) : contactMethods.length === 0 ? (
              supportError ? (
                <View style={[flat, {
                  borderRadius: layout.cardRadius, padding: layout.cardPx,
                  flexDirection: 'row', alignItems: 'center', gap: layout.pad.md,
                  borderLeftWidth: 4, borderLeftColor: '#F59E0B',
                }]}>
                  <AlertTriangle size={layout.bodySize + 4} color="#F59E0B" />
                  <View style={{ flex: 1, gap: layout.pad.xs }}>
                    <Text style={{ fontSize: layout.captionSize, color: c.text, lineHeight: layout.captionSize * 1.5 }}>
                      Could not load support contacts. Check your connection and try again.
                    </Text>
                    <Pressable onPress={() => void loadSupportContacts()} style={{ alignSelf: 'flex-start' }}>
                      <Text style={{ fontSize: layout.captionSize, fontWeight: '700', color: c.primary }}>Retry</Text>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <View style={[flat, {
                  borderRadius: layout.cardRadius, padding: layout.cardPx,
                  flexDirection: 'row', alignItems: 'center', gap: layout.pad.md,
                  borderLeftWidth: 4, borderLeftColor: `${c.text}33`,
                }]}>
                  <Phone size={layout.bodySize + 4} color={`${c.text}55`} />
                  <Text style={{ flex: 1, fontSize: layout.captionSize, color: `${c.text}66`, lineHeight: layout.captionSize * 1.5 }}>
                    Support contact is not configured. Please reach out to your administrator directly.
                  </Text>
                </View>
              )
            ) : (
              <NeuButton
                label={contactLabel}
                icon={
                  contactMethods.length === 1
                    ? (() => {
                        const p = contactMethods[0].platform;
                        if (p === 'whatsapp') return <MessageCircle size={layout.bodySize} color={c.text} />;
                        if (p === 'telegram') return <Send size={layout.bodySize} color={c.text} />;
                        return <Phone size={layout.bodySize} color={c.text} />;
                      })()
                    : <Phone size={layout.bodySize} color={c.text} />
                }
                onPress={handleContactSupport}
                disabled={contactDisabled}
              />
            )}

            {/* READ-ONLY diagnostic: lets the phone owner establish WHICH signal
                blocked them and send the report on, without a computer. It offers
                no way past this block. */}
            <SecuritySignalReport findings={reportFindings} />
          </View>
        ) : (
          <View style={{ gap: layout.pad.md }}>
            <View style={[flat, {
              borderRadius: layout.cardRadius, padding: layout.cardPx,
              flexDirection: 'row', alignItems: 'center', gap: layout.pad.md,
              borderLeftWidth: 4, borderLeftColor: '#F59E0B',
            }]}>
              <AlertTriangle size={layout.bodySize + 4} color="#F59E0B" />
              <Text style={{ flex: 1, fontSize: layout.captionSize, color: c.text, lineHeight: layout.captionSize * 1.5 }}>
                Continuing on a compromised device may expose your learning data to security risks.
              </Text>
            </View>
            <NeuButton label="Continue Anyway" icon={<ArrowRight size={layout.bodySize} color="#fff" />} onPress={handleContinue} variant="primary" />
          </View>
        )}

        {/* Footer */}
        <View style={{ alignItems: 'center', gap: layout.pad.xs, paddingTop: layout.pad.sm }}>
          <ShieldCheck size={layout.captionSize + 4} color={`${c.text}44`} />
          <Text style={{ fontSize: layout.captionSize - 1, color: `${c.text}55`, textAlign: 'center' }}>
            MedAcademy Enterprise Security{'\n'}All security events are logged and monitored.
          </Text>
        </View>
      </ScrollView>

      {/* Contact chooser modal (multi-method only) */}
      <ContactChooserModal
        visible={chooserVisible}
        methods={contactMethods}
        onClose={() => setChooserVisible(false)}
        isDark={isDark}
      />
    </View>
  );
}
