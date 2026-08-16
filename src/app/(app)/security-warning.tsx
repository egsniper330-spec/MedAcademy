import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, Linking, Modal, Pressable, useColorScheme, ActivityIndicator,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import {
  ShieldAlert, ShieldCheck, AlertTriangle, Wifi, Globe,
  Bug, Fingerprint, Lock, ArrowRight, Phone, MessageCircle, Send, X,
} from 'lucide-react-native';
import { neuColors, neuFlatStyle, neuPressedStyle, useLayout } from '@/lib/neu';
import { NeuButton } from '@/components/NeuButton';
import { getSupportSettings, type SupportSettings } from '@/lib/api';

// ─── Threat display metadata ──────────────────────────────────────────────────
// Only human-readable labels and icons — no internal method details shown to users.
type ThreatItem = { type: string };

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
};

// ─── Contact chooser helpers ──────────────────────────────────────────────────

function normalizePhone(raw: string): string {
  // Strip everything except digits and leading +
  const cleaned = raw.trim().replace(/[^\d+]/g, '');
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

function normalizeTelegram(raw: string): string {
  // Accept @username, t.me/username, or bare username
  const stripped = raw.trim()
    .replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '')
    .replace(/^@/, '');
  return stripped;
}

function openPhone(phone: string) {
  void Linking.openURL(`tel:${normalizePhone(phone)}`);
}

function openWhatsApp(phone: string) {
  const e164 = normalizePhone(phone).replace(/^\+/, '');
  void Linking.openURL(`https://wa.me/${e164}`);
}

function openTelegram(username: string) {
  const user = normalizeTelegram(username);
  void Linking.openURL(`https://t.me/${user}`);
}

// ─── Contact chooser modal ────────────────────────────────────────────────────
interface ContactMethod {
  key: 'phone' | 'whatsapp' | 'telegram';
  label: string;
  value: string;
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
    setTimeout(() => {
      if (method.key === 'phone')    openPhone(method.value);
      if (method.key === 'whatsapp') openWhatsApp(method.value);
      if (method.key === 'telegram') openTelegram(method.value);
    }, 200);
  };

  const icons: Record<ContactMethod['key'], React.ComponentType<{ size: number; color: string }>> = {
    phone:    Phone,
    whatsapp: MessageCircle,
    telegram: Send,
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
                <X size={layout.bodySize + 2} color={`${c.text}88`} />
              </Pressable>
            </View>
            <Text style={{ fontSize: layout.captionSize, color: `${c.text}77`, lineHeight: layout.captionSize * 1.5 }}>
              Choose how you would like to reach our support team.
            </Text>

            {/* Method buttons */}
            {methods.map(method => {
              const Icon = icons[method.key];
              const isPressed = pressed === method.key;
              const shadowStyle = isPressed ? neuPressedStyle(isDark) : flat;
              return (
                <Pressable
                  key={method.key}
                  onPressIn={() => setPressed(method.key)}
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
                      <Text style={{ fontSize: layout.captionSize, color: `${c.text}66` }} numberOfLines={1}>{method.value}</Text>
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
  const redirect    = params.redirect ?? '/(app)/(student)/dashboard';

  // Support contact state
  const [support, setSupport]             = useState<SupportSettings | null>(null);
  const [supportLoading, setSupportLoading] = useState(true);
  const [chooserVisible, setChooserVisible] = useState(false);

  useEffect(() => {
    getSupportSettings()
      .then(s => setSupport(s))
      .catch(() => setSupport(null))
      .finally(() => setSupportLoading(false));
  }, []);

  // Build enabled contact methods list
  const contactMethods: ContactMethod[] = React.useMemo(() => {
    if (!support) return [];
    const methods: ContactMethod[] = [];
    if (support.whatsapp?.enabled && support.whatsapp.value.trim())
      methods.push({ key: 'whatsapp', label: support.whatsapp.label || 'WhatsApp Support', value: support.whatsapp.value.trim() });
    if (support.telegram?.enabled && support.telegram.value.trim())
      methods.push({ key: 'telegram', label: support.telegram.label || 'Telegram Support', value: support.telegram.value.trim() });
    if (support.phone?.enabled && support.phone.value.trim())
      methods.push({ key: 'phone',    label: support.phone.label    || 'Phone Support',    value: support.phone.value.trim() });
    return methods;
  }, [support]);

  const handleContactSupport = () => {
    if (contactMethods.length === 0) return; // button is disabled
    if (contactMethods.length === 1) {
      // Single method — open directly, no chooser needed
      const m = contactMethods[0];
      if (m.key === 'phone')    openPhone(m.value);
      if (m.key === 'whatsapp') openWhatsApp(m.value);
      if (m.key === 'telegram') openTelegram(m.value);
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
          paddingBottom: layout.scrollBottom(),
          gap: layout.pad.lg,
        }}
      >
        {/* Header */}
        <View style={{ alignItems: 'center', gap: layout.pad.md, paddingTop: layout.pad.lg }}>
          <View style={[flat, {
            width: layout.heroIconSize, height: layout.heroIconSize,
            borderRadius: layout.heroIconRadius,
            alignItems: 'center', justifyContent: 'center',
          }]}>
            <ShieldAlert size={Math.round(layout.heroIconSize * 0.5)} color={blocksLogin ? '#EF4444' : '#F59E0B'} />
          </View>
          <Text style={{ fontSize: layout.titleSize, fontWeight: '700', color: c.text, textAlign: 'center' }}>
            {blocksLogin ? 'Access Blocked' : 'Security Warning'}
          </Text>
          <Text style={{ fontSize: layout.bodySize, color: `${c.text}88`, textAlign: 'center', lineHeight: layout.bodySize * 1.5 }}>
            {blocksLogin
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
          const meta = THREAT_META[t.type] ?? { label: 'Security Issue', description: 'A security issue was detected on your device.', icon: ShieldAlert };
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
        {blocksLogin ? (
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
            ) : (
              <NeuButton
                label={contactLabel}
                icon={
                  contactMethods.length === 1
                    ? contactMethods[0].key === 'whatsapp' ? <MessageCircle size={layout.bodySize} color={c.text} />
                      : contactMethods[0].key === 'telegram' ? <Send size={layout.bodySize} color={c.text} />
                      : <Phone size={layout.bodySize} color={c.text} />
                    : <Phone size={layout.bodySize} color={c.text} />
                }
                onPress={handleContactSupport}
                disabled={contactDisabled}
              />
            )}
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
