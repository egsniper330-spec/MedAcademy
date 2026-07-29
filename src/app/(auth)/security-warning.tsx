import React from 'react';
import {
  View, Text, ScrollView, Pressable, useColorScheme,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import {
  ShieldAlert, ShieldCheck, AlertTriangle, Wifi, Globe,
  Bug, Fingerprint, Lock, ArrowRight, Phone,
} from 'lucide-react-native';
import { neuColors, neuFlatStyle } from '@/lib/neu';
import { NeuButton } from '@/components/NeuButton';

type ThreatItem = {
  type: string;
  detectionMethod: string;
};

const THREAT_META: Record<string, { label: string; icon: React.ComponentType<{ size: number; color: string }> }> = {
  root_detected:             { label: 'Root Detected',              icon: ShieldAlert },
  jailbreak_detected:        { label: 'Jailbreak Detected',         icon: ShieldAlert },
  vpn_detected:              { label: 'VPN Connection',             icon: Wifi },
  proxy_detected:            { label: 'Proxy Detected',             icon: Globe },
  debug_detected:            { label: 'Debug Mode Active',          icon: Bug },
  frida_detected:            { label: 'Instrumentation Detected',   icon: Fingerprint },
  xposed_detected:           { label: 'Xposed Framework Detected',  icon: Fingerprint },
  app_integrity_compromised: { label: 'App Integrity Compromised',  icon: Lock },
  ssl_pinning_failure:       { label: 'SSL Pinning Failure',        icon: Lock },
};

export default function SecurityWarningScreen() {
  const router = useRouter();
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const flat = neuFlatStyle(isDark);

  const params = useLocalSearchParams<{
    threats:    string;
    riskScore:  string;
    blocksLogin: string;
    redirect:   string;
  }>();

  const threats: ThreatItem[] = React.useMemo(() => {
    try { return JSON.parse(params.threats ?? '[]'); } catch { return []; }
  }, [params.threats]);

  const riskScore  = parseInt(params.riskScore ?? '0', 10);
  const blocksLogin = params.blocksLogin === 'true';
  const redirect   = params.redirect ?? '/(app)/(student)/dashboard';

  const riskColor =
    riskScore >= 60 ? '#EF4444' :
    riskScore >= 30 ? '#F59E0B' : '#22C55E';

  const handleContinue = () => {
    router.replace(redirect as RelativePathString);
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView
        contentContainerStyle={{ padding: 24, gap: 20, paddingBottom: 48 }}
        contentInsetAdjustmentBehavior="automatic"
      >
        {/* Header */}
        <View style={{ alignItems: 'center', gap: 12, paddingTop: 24 }}>
          <View style={[flat, {
            width: 88, height: 88, borderRadius: 28,
            alignItems: 'center', justifyContent: 'center',
          }]}>
            <ShieldAlert size={44} color={blocksLogin ? '#EF4444' : '#F59E0B'} />
          </View>
          <Text style={{ fontSize: 22, fontWeight: '700', color: c.text, textAlign: 'center' }}>
            {blocksLogin ? 'Access Blocked' : 'Security Warning'}
          </Text>
          <Text style={{ fontSize: 14, color: `${c.text}88`, textAlign: 'center', lineHeight: 20 }}>
            {blocksLogin
              ? 'Your device does not meet security requirements. Login has been blocked by your administrator.'
              : 'Security threats were detected on your device. Proceed with caution — some features may be restricted.'}
          </Text>
        </View>

        {/* Risk Score */}
        <View style={[flat, { borderRadius: 20, padding: 20, alignItems: 'center', gap: 8 }]}>
          <Text style={{ fontSize: 12, fontWeight: '600', color: `${c.text}77`, letterSpacing: 1, textTransform: 'uppercase' }}>
            Device Risk Score
          </Text>
          <Text style={{ fontSize: 48, fontWeight: '800', color: riskColor }}>{riskScore}</Text>
          <View style={{ width: '100%', height: 8, backgroundColor: `${c.text}18`, borderRadius: 4 }}>
            <View style={{
              width: `${riskScore}%`, height: 8, borderRadius: 4,
              backgroundColor: riskColor,
            }} />
          </View>
          <Text style={{ fontSize: 12, color: `${c.text}66` }}>
            {riskScore < 30 ? 'Low Risk' : riskScore < 60 ? 'Medium Risk' : 'High Risk'}
          </Text>
        </View>

        {/* Detected Threats */}
        <Text style={{ fontSize: 16, fontWeight: '700', color: c.text }}>
          Detected Threats ({threats.length})
        </Text>
        {threats.map((t, i) => {
          const meta = THREAT_META[t.type] ?? { label: t.type, icon: ShieldAlert };
          const Icon = meta.icon;
          return (
            <View key={i} style={[flat, {
              borderRadius: 16, padding: 16, flexDirection: 'row',
              alignItems: 'flex-start', gap: 14,
            }]}>
              <View style={{
                width: 40, height: 40, borderRadius: 12,
                backgroundColor: `${riskColor}18`,
                alignItems: 'center', justifyContent: 'center',
              }}>
                <Icon size={20} color={riskColor} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{meta.label}</Text>
                <Text style={{ fontSize: 12, color: `${c.text}77` }}>
                  Detection: {t.detectionMethod}
                </Text>
              </View>
            </View>
          );
        })}

        {/* Actions */}
        {blocksLogin ? (
          <View style={{ gap: 12 }}>
            <View style={[flat, {
              borderRadius: 16, padding: 16, flexDirection: 'row',
              alignItems: 'center', gap: 12,
              borderLeftWidth: 4, borderLeftColor: '#EF4444',
            }]}>
              <ShieldAlert size={20} color="#EF4444" />
              <Text style={{ flex: 1, fontSize: 13, color: c.text, lineHeight: 18 }}>
                {"Login is blocked by your organization's security policy. Contact your administrator for assistance."}
              </Text>
            </View>
            <NeuButton
              label="Contact Support"
              icon={<Phone size={18} color={c.text} />}
              onPress={() => {}}
            />
          </View>
        ) : (
          <View style={{ gap: 12 }}>
            <View style={[flat, {
              borderRadius: 16, padding: 16, flexDirection: 'row',
              alignItems: 'center', gap: 12,
              borderLeftWidth: 4, borderLeftColor: '#F59E0B',
            }]}>
              <AlertTriangle size={20} color="#F59E0B" />
              <Text style={{ flex: 1, fontSize: 13, color: c.text, lineHeight: 18 }}>
                Continuing on a compromised device may expose your learning data to security risks.
              </Text>
            </View>
            <NeuButton
              label="Continue Anyway"
              icon={<ArrowRight size={18} color="#fff" />}
              onPress={handleContinue}
              variant="primary"
            />
          </View>
        )}

        {/* Footer */}
        <View style={{ alignItems: 'center', gap: 4, paddingTop: 8 }}>
          <ShieldCheck size={16} color={`${c.text}44`} />
          <Text style={{ fontSize: 11, color: `${c.text}55`, textAlign: 'center' }}>
            MedAcademy Enterprise Security{'\n'}All security events are logged and monitored.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}
