import React, { useState, useCallback } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  Switch, useColorScheme, TextInput,
} from 'react-native';
import {
  ShieldAlert, ShieldCheck, Wifi, Globe, Bug, Lock,
  Camera, Trash2, Plus, Save,
} from 'lucide-react-native';
import { neuColors, useLayout, neuFlatStyle, safeBottom } from '@/lib/neu';
import { NeuButton } from '@/components/NeuButton';
import { PageHeader } from '@/components/PageHeader';
import { useToast } from '@/components/Toast';
import { supabase } from '@/client/supabase';
import { invalidatePolicyCache } from '@/lib/security';
import { friendlyError } from '@/lib/validation';

type PolicyAction = 'log_only' | 'warn_only' | 'block_video' | 'block_login';
type DetectionType = 'root_jailbreak' | 'vpn' | 'proxy' | 'ssl_pinning' | 'debug' | 'screenshot' | 'screen_recording' | 'app_integrity';

interface Policy {
  id:             string;
  detection_type: DetectionType;
  action:         PolicyAction;
  enabled:        boolean;
  updated_at:     string;
}

interface VpnWhitelist {
  id:          string;
  name:        string;
  description: string | null;
  created_at:  string;
}

const DETECTION_META: Record<DetectionType, {
  label: string;
  desc:  string;
  icon:  React.ComponentType<{ size: number; color: string }>;
}> = {
  root_jailbreak:  { label: 'Root / Jailbreak', desc: 'Detects rooted Android or jailbroken iOS devices', icon: ShieldAlert },
  vpn:             { label: 'VPN',               desc: 'Detects active VPN connections',                  icon: Wifi },
  proxy:           { label: 'Proxy',             desc: 'Detects HTTP/HTTPS/SOCKS proxy settings',         icon: Globe },
  ssl_pinning:     { label: 'SSL Pinning',       desc: 'Terminates session on MITM / certificate mismatch', icon: Lock },
  debug:           { label: 'Debug / Frida',     desc: 'Detects USB debugging, dev mode, Frida, Xposed',  icon: Bug },
  screenshot:      { label: 'Screenshot',        desc: 'Prevents/detects screenshot attempts',            icon: Camera },
  screen_recording:{ label: 'Screen Recording',  desc: 'Detects and blocks screen recording on video',    icon: Camera },
  app_integrity:   { label: 'App Integrity',     desc: 'Verifies release build and bundle integrity',     icon: ShieldAlert },
};

const ACTIONS: { value: PolicyAction; label: string; color: string }[] = [
  { value: 'log_only',    label: 'Log Only',       color: '#6B7280' },
  { value: 'warn_only',   label: 'Warn',           color: '#F59E0B' },
  { value: 'block_video', label: 'Block Video',    color: '#8B5CF6' },
  { value: 'block_login', label: 'Block Login',    color: '#EF4444' },
];

export default function SecurityPoliciesScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const insets = layout.insets;
  const flat = neuFlatStyle(isDark);
  const router = useRouter();
  const { showToast } = useToast();

  const [policies, setPolicies]       = useState<Policy[]>([]);
  const [whitelist, setWhitelist]     = useState<VpnWhitelist[]>([]);
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState(false);
  const [newVpnName, setNewVpnName]   = useState('');
  const [addingVpn, setAddingVpn]     = useState(false);

  const load = useCallback(async () => {
    const [polRes, wlRes] = await Promise.all([
      supabase.from('security_policies').select('*').order('detection_type'),
      supabase.from('security_vpn_whitelist').select('*').order('created_at'),
    ]);
    if (polRes.data) setPolicies(polRes.data as Policy[]);
    if (wlRes.data)  setWhitelist(wlRes.data as VpnWhitelist[]);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const updateLocalPolicy = (id: string, field: 'action' | 'enabled', val: PolicyAction | boolean) => {
    setPolicies((prev) => prev.map((p) => p.id === id ? { ...p, [field]: val } : p));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const updates = policies.map((p) => ({
        id: p.id, action: p.action, enabled: p.enabled, updated_at: new Date().toISOString(),
      }));
      for (const u of updates) {
        const { error } = await supabase.from('security_policies').update({
          action: u.action, enabled: u.enabled, updated_at: u.updated_at,
        }).eq('id', u.id);
        if (error) throw error;
      }
      invalidatePolicyCache();
      showToast({ type: 'success', message: 'Security policies saved.' });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to save policies.') });
    } finally {
      setSaving(false);
    }
  };

  const handleAddVpn = async () => {
    if (!newVpnName.trim()) return;
    setAddingVpn(true);
    try {
      const { data, error } = await supabase.from('security_vpn_whitelist')
        .insert({ name: newVpnName.trim() }).select().maybeSingle();
      if (error) throw error;
      if (data) setWhitelist((prev) => [...prev, data as VpnWhitelist]);
      setNewVpnName('');
      invalidatePolicyCache();
      showToast({ type: 'success', message: 'VPN added to whitelist.' });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to add VPN.') });
    } finally {
      setAddingVpn(false);
    }
  };

  const handleRemoveVpn = async (id: string) => {
    try {
      const { error } = await supabase.from('security_vpn_whitelist').delete().eq('id', id);
      if (error) throw error;
      setWhitelist((prev) => prev.filter((v) => v.id !== id));
      invalidatePolicyCache();
      showToast({ type: 'success', message: 'VPN removed from whitelist.' });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to remove VPN.') });
    }
  };

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: c.base, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color={c.primary} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <PageHeader title="Security Policies" />
      <ScrollView
        contentContainerStyle={{ padding: layout.screenPx, gap: layout.sectionGap, paddingBottom: layout.scrollBottom() }}
      >
        {/* Intro */}
        <View style={[flat, {
          borderRadius: layout.cardRadius, padding: layout.cardPx, flexDirection: 'row', gap: layout.pad.md, alignItems: 'flex-start',
          borderLeftWidth: 4, borderLeftColor: c.primary,
        }]}>
          <ShieldCheck size={layout.bodySize + 4} color={c.primary} />
          <Text style={{ flex: 1, fontSize: layout.bodySize, color: c.text, lineHeight: layout.bodySize * 1.5 }}>
            Configure how the platform responds to each security threat. Changes apply to all users immediately.
          </Text>
        </View>

        {/* Policy rows */}
        {policies.map((policy) => {
          const meta = DETECTION_META[policy.detection_type];
          if (!meta) return null;
          const Icon = meta.icon;
          return (
            <View key={policy.id} style={[flat, { borderRadius: layout.cardRadius, padding: layout.cardPx, gap: layout.pad.md }]}>
              {/* Header */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: layout.pad.md }}>
                <View style={{
                  width: layout.touchTarget, height: layout.touchTarget, borderRadius: layout.cardRadius,
                  backgroundColor: `${c.primary}18`,
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <Icon size={Math.round(layout.touchTarget * 0.46)} color={c.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: layout.bodySize + 1, fontWeight: '700', color: c.text }}>{meta.label}</Text>
                  <Text style={{ fontSize: layout.captionSize, color: `${c.text}77` }}>{meta.desc}</Text>
                </View>
                <Switch
                  value={policy.enabled}
                  onValueChange={(v) => updateLocalPolicy(policy.id, 'enabled', v)}
                  trackColor={{ false: `${c.text}22`, true: `${c.primary}55` }}
                  thumbColor={policy.enabled ? c.primary : `${c.text}55`}
                />
              </View>
              {/* Action selector */}
              {policy.enabled && (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: layout.pad.sm }}>
                  {ACTIONS.map((act) => {
                    const selected = policy.action === act.value;
                    return (
                      <Pressable key={act.value}
                        onPress={() => updateLocalPolicy(policy.id, 'action', act.value)}
                        style={[flat, {
                          paddingHorizontal: layout.pad.md, paddingVertical: layout.pad.sm, borderRadius: 20,
                          backgroundColor: selected ? act.color : undefined,
                          borderWidth: selected ? 0 : 1,
                          borderColor: `${act.color}55`,
                        }]}>
                        <Text style={{
                          fontSize: layout.captionSize, fontWeight: '700',
                          color: selected ? '#fff' : act.color,
                        }}>
                          {act.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
              {!policy.enabled && (
                <Text style={{ fontSize: layout.captionSize, color: `${c.text}55`, fontStyle: 'italic' }}>
                  Detection disabled — no action taken, no events logged.
                </Text>
              )}
            </View>
          );
        })}

        {/* Save */}
        <NeuButton
          label={saving ? 'Saving...' : 'Save Policies'}
          icon={<Save size={layout.bodySize + 2} color="#fff" />}
          onPress={() => { void handleSave(); }}
          variant="primary"
          loading={saving}
        />

        {/* VPN Whitelist */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: layout.pad.sm }}>
          <Wifi size={layout.bodySize + 2} color={c.primary} />
          <Text style={{ fontSize: layout.bodySize + 2, fontWeight: '700', color: c.text }}>VPN Whitelist</Text>
        </View>
        <Text style={{ fontSize: layout.bodySize, color: `${c.text}77` }}>
          Whitelisted VPNs bypass the VPN detection policy. Add trusted corporate VPN names.
        </Text>

        {/* Add VPN */}
        <View style={{ flexDirection: 'row', gap: layout.pad.sm, alignItems: 'center' }}>
          <View style={[flat, { flex: 1, minWidth: 0, borderRadius: layout.cardRadius }]}>
            <TextInput
              value={newVpnName}
              onChangeText={setNewVpnName}
              placeholder="VPN name (e.g. Corporate VPN)"
              placeholderTextColor={`${c.text}55`}
              style={{ paddingHorizontal: layout.cardPx, paddingVertical: layout.pad.md, fontSize: layout.bodySize, color: c.text, minWidth: 0 }}
            />
          </View>
          <Pressable
            onPress={() => void handleAddVpn()}
            disabled={addingVpn || !newVpnName.trim()}
            style={[flat, {
              width: layout.touchTarget + 2, height: layout.touchTarget + 2, borderRadius: layout.cardRadius,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: newVpnName.trim() ? c.primary : undefined,
              opacity: newVpnName.trim() ? 1 : 0.5,
            }]}>
            {addingVpn ? <ActivityIndicator size="small" color="#fff" /> : <Plus size={layout.bodySize + 4} color={newVpnName.trim() ? '#fff' : c.text} />}
          </Pressable>
        </View>

        {/* Whitelist items */}
        {whitelist.length === 0 ? (
          <View style={[flat, { borderRadius: layout.cardRadius, padding: layout.cardPx * 1.25, alignItems: 'center' }]}>
            <Text style={{ fontSize: layout.bodySize, color: `${c.text}66` }}>No whitelisted VPNs</Text>
          </View>
        ) : (
          whitelist.map((vpn) => (
            <View key={vpn.id} style={[flat, {
              borderRadius: layout.cardRadius, padding: layout.cardPx, flexDirection: 'row',
              alignItems: 'center', gap: layout.pad.md,
            }]}>
              <Wifi size={layout.bodySize + 2} color={c.primary} />
              <Text style={{ flex: 1, fontSize: layout.bodySize, fontWeight: '600', color: c.text }}>{vpn.name}</Text>
              <Pressable onPress={() => void handleRemoveVpn(vpn.id)}>
                <Trash2 size={layout.bodySize + 2} color="#EF4444" />
              </Pressable>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}
