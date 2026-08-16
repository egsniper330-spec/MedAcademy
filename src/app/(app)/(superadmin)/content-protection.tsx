/**
 * Content Protection Policy Configuration — Super Admin
 *
 * Configure screenshot policy, recording policy, strike actions,
 * violation limit, warning message, auto-logout/suspend toggles.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, useColorScheme, Pressable, TextInput,
  Switch, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Shield, Camera, Video, AlertTriangle, RotateCcw, Save,
  ChevronDown, Info,
} from 'lucide-react-native';
import { supabase } from '@/client/supabase';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { neuColors, useLayout, neuFlatStyle, safeBottom } from '@/lib/neu';
import { PageHeader } from '@/components/PageHeader';

type CPAction = 'warn_only' | 'strike_system' | 'auto_logout' | 'auto_suspend';
type StrikeAction = 'warning' | 'logout' | 'suspend' | 'ban';

const CP_ACTION_LABELS: Record<CPAction, string> = {
  warn_only:     'Warn Only',
  strike_system: 'Strike System',
  auto_logout:   'Auto Logout',
  auto_suspend:  'Auto Suspend',
};
const STRIKE_ACTION_LABELS: Record<StrikeAction, string> = {
  warning: 'Warning Only',
  logout:  'Logout',
  suspend: 'Suspend',
  ban:     'Ban',
};
const CP_ACTIONS: CPAction[] = ['warn_only', 'strike_system', 'auto_logout', 'auto_suspend'];
const STRIKE_ACTIONS: StrikeAction[] = ['warning', 'logout', 'suspend', 'ban'];

interface Policy {
  screenshot_policy: CPAction;
  recording_policy:  CPAction;
  violation_limit:   number;
  warning_message:   string;
  auto_logout:       boolean;
  auto_suspend:      boolean;
  suspension_hours:  number;
  strike1_action:    StrikeAction;
  strike2_action:    StrikeAction;
  strike3_action:    StrikeAction;
}

const DEFAULTS: Policy = {
  screenshot_policy: 'strike_system',
  recording_policy:  'strike_system',
  violation_limit:   3,
  warning_message:   'Screenshots of protected educational content are prohibited. Repeated violations may result in temporary account suspension.',
  auto_logout:       true,
  auto_suspend:      true,
  suspension_hours:  24,
  strike1_action:    'warning',
  strike2_action:    'logout',
  strike3_action:    'suspend',
};

function ActionPicker({ label, value, options, optionLabels, onChange, isDark }: {
  label: string;
  value: string;
  options: string[];
  optionLabels: Record<string, string>;
  onChange: (v: string) => void;
  isDark: boolean;
}) {
  const c = isDark ? neuColors.dark : neuColors.light;
  const flat = neuFlatStyle(isDark);
  const [open, setOpen] = useState(false);

  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 13, fontWeight: '600', color: c.text, opacity: 0.7 }}>{label}</Text>
      <Pressable onPress={() => setOpen(!open)} style={[flat, { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
        <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }}>{optionLabels[value] ?? value}</Text>
        <ChevronDown size={16} color={c.text} style={{ opacity: 0.5 }} />
      </Pressable>
      {open && (
        <View style={[flat, { borderRadius: 12, overflow: 'hidden' }]}>
          {options.map((opt) => (
            <Pressable
              key={opt}
              onPress={() => { onChange(opt); setOpen(false); }}
              style={{ paddingHorizontal: 16, paddingVertical: 12, backgroundColor: opt === value ? `${c.primary}18` : 'transparent' }}
            >
              <Text style={{ fontSize: 14, color: opt === value ? c.primary : c.text, fontWeight: opt === value ? '700' : '400' }}>
                {optionLabels[opt]}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

export default function ContentProtectionPolicyScreen() {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const insets = layout.insets;
  const flat = neuFlatStyle(isDark);

  const [policy, setPolicy] = useState<Policy>(DEFAULTS);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [error, setError]       = useState('');

  const loadPolicy = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('content_protection_policies')
      .select('*')
      .eq('id', '00000000-0000-0000-0000-000000000001')
      .maybeSingle();
    if (data) setPolicy(data as Policy);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { loadPolicy(); }, [loadPolicy]));

  const handleSave = async () => {
    setSaving(true); setError(''); setSaved(false);
    const { error: err } = await supabase
      .from('content_protection_policies')
      .update({ ...policy, updated_at: new Date().toISOString() })
      .eq('id', '00000000-0000-0000-0000-000000000001');
    if (err) setError(err.message);
    else setSaved(true);
    setSaving(false);
  };

  const set = <K extends keyof Policy>(key: K, val: Policy[K]) =>
    setPolicy((p) => ({ ...p, [key]: val }));

  const SectionTitle = ({ icon, title }: { icon: React.ReactNode; title: string }) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8, marginBottom: 4 }}>
      {icon}
      <Text style={{ fontSize: 16, fontWeight: '800', color: c.text }}>{title}</Text>
    </View>
  );

  if (loading) return (
    <View style={{ flex: 1, backgroundColor: c.base, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={c.primary} size="large" />
    </View>
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }}>
      <PageHeader title="Content Protection" subtitle="Configure screenshot & recording policies" />

      <View style={{ padding: layout.screenPx, gap: 16 }}>
        {/* ── Detection Policies ── */}
        <SectionTitle icon={<Camera size={18} color={c.primary} />} title="Detection Policies" />
        <NeuCard>
          <View style={{ gap: 18 }}>
            <ActionPicker
              label="Screenshot Policy"
              value={policy.screenshot_policy}
              options={CP_ACTIONS}
              optionLabels={CP_ACTION_LABELS}
              onChange={(v) => set('screenshot_policy', v as CPAction)}
              isDark={isDark}
            />
            <ActionPicker
              label="Screen Recording Policy"
              value={policy.recording_policy}
              options={CP_ACTIONS}
              optionLabels={CP_ACTION_LABELS}
              onChange={(v) => set('recording_policy', v as CPAction)}
              isDark={isDark}
            />
          </View>
        </NeuCard>

        {/* ── Strike System ── */}
        <SectionTitle icon={<AlertTriangle size={18} color="#D97706" />} title="Strike System" />
        <NeuCard>
          <View style={{ gap: 18 }}>
            {([1, 2, 3] as const).map((n) => (
              <ActionPicker
                key={n}
                label={`Strike ${n} Action`}
                value={policy[`strike${n}_action` as keyof Policy] as string}
                options={n === 3 ? STRIKE_ACTIONS : STRIKE_ACTIONS.filter(a => a !== 'ban')}
                optionLabels={STRIKE_ACTION_LABELS}
                onChange={(v) => set(`strike${n}_action` as keyof Policy, v as StrikeAction)}
                isDark={isDark}
              />
            ))}

            <View style={{ gap: 6 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: c.text, opacity: 0.7 }}>Violation Limit</Text>
              <View style={[flat, { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, minWidth: 0 }]}>
                <TextInput
                  value={String(policy.violation_limit)}
                  onChangeText={(t) => set('violation_limit', parseInt(t) || 0)}
                  keyboardType="numeric"
                  style={{ flex: 1, minWidth: 0, fontSize: 14, color: c.text }}
                  placeholderTextColor={`${c.text}55`}
                />
              </View>
            </View>
          </View>
        </NeuCard>

        {/* ── Auto Actions ── */}
        <SectionTitle icon={<Shield size={18} color="#EF4444" />} title="Auto Actions" />
        <NeuCard>
          <View style={{ gap: 18 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }}>Auto Logout</Text>
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>Terminate session on violation</Text>
              </View>
              <Switch
                value={policy.auto_logout}
                onValueChange={(v) => set('auto_logout', v)}
                trackColor={{ true: c.primary }}
              />
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: c.text }}>Auto Suspend</Text>
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>Suspend account on severe violation</Text>
              </View>
              <Switch
                value={policy.auto_suspend}
                onValueChange={(v) => set('auto_suspend', v)}
                trackColor={{ true: c.primary }}
              />
            </View>

            {policy.auto_suspend && (
              <View style={{ gap: 6 }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: c.text, opacity: 0.7 }}>Suspension Duration (hours)</Text>
                <View style={[flat, { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, minWidth: 0 }]}>
                  <TextInput
                    value={String(policy.suspension_hours)}
                    onChangeText={(t) => set('suspension_hours', parseInt(t) || 0)}
                    keyboardType="numeric"
                    style={{ flex: 1, minWidth: 0, fontSize: 14, color: c.text }}
                    placeholderTextColor={`${c.text}55`}
                  />
                </View>
              </View>
            )}
          </View>
        </NeuCard>

        {/* ── Warning Message ── */}
        <SectionTitle icon={<Info size={18} color={c.accent} />} title="Warning Message" />
        <NeuCard>
          <View style={[flat, { borderRadius: 12, padding: 14, minWidth: 0 }]}>
            <TextInput
              value={policy.warning_message}
              onChangeText={(t) => set('warning_message', t)}
              multiline
              numberOfLines={4}
              style={{ flex: 1, minWidth: 0, fontSize: 13, color: c.text, lineHeight: 20, minHeight: 80 }}
              placeholderTextColor={`${c.text}55`}
            />
          </View>
        </NeuCard>

        {/* Feedback */}
        {error !== '' && (
          <View style={{ padding: 12, borderRadius: 12, backgroundColor: '#FEE2E2' }}>
            <Text style={{ fontSize: 13, color: '#DC2626' }}>{error}</Text>
          </View>
        )}
        {saved && (
          <View style={{ padding: 12, borderRadius: 12, backgroundColor: '#DCFCE7' }}>
            <Text style={{ fontSize: 13, color: '#16A34A', fontWeight: '600' }}>Policy saved successfully.</Text>
          </View>
        )}

        {/* Actions */}
        <View style={{ flexDirection: 'row', gap: 12, paddingBottom: layout.scrollBottom() }}>
          <Pressable
            onPress={() => { setPolicy(DEFAULTS); setSaved(false); }}
            style={[flat, { flex: 1, borderRadius: 14, paddingVertical: 14, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }]}
          >
            <RotateCcw size={16} color={c.text} opacity={0.6} />
            <Text style={{ fontSize: 14, fontWeight: '600', color: c.text, opacity: 0.7 }}>Reset</Text>
          </Pressable>
          <View style={{ flex: 2 }}>
            <NeuButton
              label="Save Policy"
              icon={<Save size={16} color="#fff" />}
              onPress={handleSave}
              loading={saving}
              variant="primary"
              fullWidth
            />
          </View>
        </View>
      </View>
    </ScrollView>
  );
}
