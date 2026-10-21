import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, Linking, Modal, Pressable, useColorScheme, ActivityIndicator, Platform,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import {
  ShieldAlert, ShieldCheck, AlertTriangle, Wifi, WifiOff, Globe,
  Bug, Fingerprint, Lock, ArrowRight, Phone, X as XIcon,
  Mail, MessageCircle, Send, Megaphone, AtSign, Link2, Smartphone,
} from 'lucide-react-native';
import { neuColors, neuFlatStyle, neuPressedStyle, useLayout } from '@/lib/neu';
import { NeuButton } from '@/components/NeuButton';
import { t } from '@/lib/i18n';
import { useProfileStore } from '@/lib/store';
import { dashboardPathForRole } from '@/lib/roleRoutes';
import {
  hasConnectionFinding, connectionBlockInstructions, resolveFindingCopyKey,
} from '@/lib/securityStateModel';
import {
  getPublicSupportContacts, type PublicSupportContact,
  SUPPORT_ICONS, type SupportPlatformKey,
  type SupportContactEntry,
} from '@/lib/api';

// ─── Threat display metadata ──────────────────────────────────────────────────
// Only human-readable labels and icons — no internal method details shown to users.
type ThreatItem = { type: string; detectionMethod?: string | null };

const THREAT_META: Record<string, {
  icon: React.ComponentType<{ size: number; color: string }>;
}> = {
  root_detected:             { icon: ShieldAlert },
  jailbreak_detected:        { icon: ShieldAlert },
  vpn_detected:              { icon: Wifi },
  proxy_detected:            { icon: Globe },
  debug_detected:            { icon: Bug },
  // DERIVED FROM `debug_detected` by resolveFindingCopyKey (see
  // src/lib/securityStateModel.ts). The engine reports two metrologically
  // DIFFERENT conditions as this one event type and weight (20): a test-only /
  // debug-detectable build and an emulator-like device. Labelling both "Debug
  // Mode Active / running in a debug environment" is inaccurate for the device-
  // state case and hides the actionable cause (reinstalling the app never
  // clears it). Same event, same weight, same block — only the description
  // becomes truthful. (Mock location used to be a third producer here; the
  // detector was removed — docs/MOCK_LOCATION_REMOVAL.md.)
  virtual_device_detected:   { icon: Smartphone },
  developer_options_enabled: { icon: Bug },
  adb_enabled:               { icon: Bug },
  debugger_attached:         { icon: Bug },
  frida_detected:            { icon: Fingerprint },
  xposed_detected:           { icon: Fingerprint },
  magisk_detected:           { icon: ShieldAlert },
  overlay_detected:          { icon: Lock },
  app_integrity_compromised: { icon: Lock },
  tamper_detected:           { icon: Lock },
  signature_invalid:         { icon: Lock },
  ssl_pinning_failure:       { icon: Lock },
  play_integrity_failed:     { icon: ShieldAlert },
  app_attest_failed:         { icon: ShieldAlert },
  screen_recording_detected: { icon: Bug },
  screenshot_detected:       { icon: Bug },
  security_unverified:       { icon: Bug },
};

/**
 * Display metadata for a reported threat. The COPY KEY is resolved from the
 * engine's own detectionMethod (resolveFindingCopyKey), never from the event
 * type alone: `debug_detected` is one event but four different measured
 * conditions. Unknown types pass through unchanged and keep the generic
 * fallback below.
 */
function threatMeta(item: ThreatItem) {
  const key = resolveFindingCopyKey(item.type, item.detectionMethod);
  const base = THREAT_META[key];
  const copyKey = base ? key : 'unknown';
  return {
    ...(base ?? { icon: ShieldAlert }),
    // Localized at RENDER time; both dictionaries carry every threat key, and
    // an unknown event type falls back to the shared generic copy key.
    label: t(`security.threat.${copyKey}.label`),
    description: t(`security.threat.${copyKey}.desc`),
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
              <Text style={{ fontSize: layout.headingSize, fontWeight: '700', color: c.text }}>{t('support.title')}</Text>
              <Pressable onPress={onClose} style={{ padding: layout.pad.xs }}>
                <XIcon size={layout.bodySize + 2} color={`${c.text}88`} />
              </Pressable>
            </View>
            <Text style={{ fontSize: layout.captionSize, color: `${c.text}77`, lineHeight: layout.captionSize * 1.5 }}>
              {t('security.supportChooserHint')}
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
  // Instructions are localized per platform: the pure helper still decides
  // WHICH platforms have steps and in what order; the strings come from the
  // dictionaries (no English copy is rendered here).
  const connectionOs: 'ios' | 'android' | 'other' =
    Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'other';
  const connectionSteps = connectionBlocked
    ? connectionBlockInstructions(Platform.OS).map((_, i) =>
        t(`security.vpn.${connectionOs}.step${i + 1}`),
      )
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
    ? t('common.loading')
    : contactMethods.length === 0
      ? t('security.supportNotConfigured')
      : contactMethods.length === 1
        ? t('security.contactVia', { method: contactMethods[0].label })
        : t('support.title');

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
              ? t('security.vpn.title')
              : blocksLogin ? t('security.blocked') : t('security.warning')}
          </Text>
          <Text style={{ fontSize: layout.bodySize, color: `${c.text}88`, textAlign: 'center', lineHeight: layout.bodySize * 1.5 }}>
            {connectionBlocked
              ? t('security.vpn.message')
              : blocksLogin
              ? t('security.loginBlockedBody')
              : t('security.warningBody')}
          </Text>
        </View>

        {/* Risk Score */}
        <View style={[flat, { borderRadius: layout.cardRadius, padding: layout.cardPx, alignItems: 'center', gap: layout.pad.sm }]}>
          <Text style={{ fontSize: layout.captionSize, fontWeight: '600', color: `${c.text}77`, letterSpacing: 1, textTransform: 'uppercase' }}>
            {t('security.riskScoreLabel')}
          </Text>
          <Text style={{ fontSize: Math.round(layout.heroIconSize * 0.55), fontWeight: '800', color: riskColor }}>{riskScore}</Text>
          <View style={{ width: '100%', height: layout.pad.xs + 2, backgroundColor: `${c.text}18`, borderRadius: layout.pad.xs }}>
            <View style={{ width: `${riskScore}%`, height: layout.pad.xs + 2, borderRadius: layout.pad.xs, backgroundColor: riskColor }} />
          </View>
          <Text style={{ fontSize: layout.captionSize, color: `${c.text}66` }}>
            {riskScore < 30 ? t('security.riskLow') : riskScore < 60 ? t('security.riskMedium') : t('security.riskHigh')}
          </Text>
        </View>

        {/* Detected Threats — user-friendly labels and descriptions only */}
        <Text style={{ fontSize: layout.headingSize, fontWeight: '700', color: c.text }}>
          {t('security.detectedCount', { count: threats.length })}
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
                {t('security.connectionBlockedAuth')}
              </Text>
            </View>

            <Text style={{ fontSize: layout.headingSize, fontWeight: '700', color: c.text }}>
              {t('security.howToTurnOff')}
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
              label={t('security.triedIt')}
              icon={<ArrowRight size={layout.bodySize} color="#fff" />}
              onPress={onRecheck}
              variant="primary"
            />

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
                      {t('security.supportLoadFailed')}
                    </Text>
                    <Pressable onPress={() => void loadSupportContacts()} style={{ alignSelf: 'flex-start' }}>
                      <Text style={{ fontSize: layout.captionSize, fontWeight: '700', color: c.primary }}>{t('common.retry')}</Text>
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
                    {t('security.supportNotConfiguredBody')}
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
                {t('security.compromisedWarning')}
              </Text>
            </View>
            <NeuButton label={t('security.continueAnyway')} icon={<ArrowRight size={layout.bodySize} color="#fff" />} onPress={handleContinue} variant="primary" />
          </View>
        )}

        {/* Footer */}
        <View style={{ alignItems: 'center', gap: layout.pad.xs, paddingTop: layout.pad.sm }}>
          <ShieldCheck size={layout.captionSize + 4} color={`${c.text}44`} />
          <Text style={{ fontSize: layout.captionSize - 1, color: `${c.text}55`, textAlign: 'center' }}>
            {t('security.footerTitle')}{'\n'}{t('security.footerMonitoring')}
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
