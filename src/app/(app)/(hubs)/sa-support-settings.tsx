/**
 * SA Support Settings — Super Admin can configure support contact methods
 * (Phone, WhatsApp, Telegram, Facebook, Instagram, Email, X/Twitter, Website)
 * that appear on the user-facing security/blocked screen.
 * Settings are saved to the PHP `support_settings` table via the audited
 * /admin/support-settings endpoint with Super Admin authorization enforced.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, Switch, TextInput,
  useColorScheme, ActivityIndicator, RefreshControl,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Phone, MessageCircle, Send, Save, Info, CheckCircle,
  Mail, Globe, AtSign, Link2, Megaphone,
} from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import {
  getSupportSettings, upsertSupportSetting,
  type SupportSettings, type SupportContactEntry,
  type SupportPlatformKey, SUPPORT_PLATFORM_ORDER,
  SUPPORT_DEFAULT_LABELS, SUPPORT_ICONS,
} from '@/lib/api';
import { neuColors, neuFlatStyle, useLayout, safeBottom } from '@/lib/neu';

// ─── Per-key metadata ────────────────────────────────────────────────────────
type ContactKey = SupportPlatformKey;

const CONTACT_META: Record<ContactKey, {
  title:            string;
  valuePlaceholder: string;
  labelPlaceholder: string;
  hint:             string;
  keyboardType:     'default' | 'phone-pad' | 'email-address' | 'numeric',
}> = {
  phone: {
    title:            'Phone Support',
    valuePlaceholder: '+1 555 000 0000',
    labelPlaceholder: 'e.g. Phone Support',
    hint:             'International format recommended (e.g. +1 555 000 0000). Tapping opens the phone dialer.',
    keyboardType: 'phone-pad',
  },
  whatsapp: {
    title:            'WhatsApp Support',
    valuePlaceholder: '+1 555 000 0000',
    labelPlaceholder: 'e.g. WhatsApp Support',
    hint:             'Enter the phone number linked to the WhatsApp account. Tapping opens a WhatsApp chat.',
    keyboardType: 'phone-pad',
  },
  telegram: {
    title:            'Telegram Support',
    valuePlaceholder: '@username or t.me/username',
    labelPlaceholder: 'e.g. Telegram Support',
    hint:             'Enter a @username, t.me/username, or full Telegram URL. Tapping opens a Telegram chat.',
    keyboardType: 'default',
  },
  facebook: {
    title:            'Facebook Support',
    valuePlaceholder: '@username or facebook.com/username',
    labelPlaceholder: 'e.g. Facebook Support',
    hint:             'Enter a @username, facebook.com/username, or full Facebook URL. Tapping opens Facebook.',
    keyboardType: 'default',
  },
  instagram: {
    title:            'Instagram Support',
    valuePlaceholder: '@username or instagram.com/username',
    labelPlaceholder: 'e.g. Instagram Support',
    hint:             'Enter a @username, instagram.com/username, or full Instagram URL. Tapping opens Instagram.',
    keyboardType: 'default',
  },
  email: {
    title:            'Email Support',
    valuePlaceholder: 'support@example.com',
    labelPlaceholder: 'e.g. Email Support',
    hint:             'Enter the support email address. Tapping opens the device email client.',
    keyboardType: 'email-address',
  },
  x: {
    title:            'X / Twitter Support',
    valuePlaceholder: '@username or x.com/username',
    labelPlaceholder: 'e.g. X / Twitter Support',
    hint:             'Enter a @username, x.com/username, or full X/Twitter URL. Tapping opens X.',
    keyboardType: 'default',
  },
  website: {
    title:            'Website Support',
    valuePlaceholder: 'https://example.com/support',
    labelPlaceholder: 'e.g. Website Support',
    hint:             'Enter a support website URL. Tapping opens the website in the browser.',
    keyboardType: 'default',
  },
};

// ─── Editable state per contact key ──────────────────────────────────────────
interface ContactDraft {
  value:   string;
  label:   string;
  enabled: boolean;
}

type DraftsState = Record<ContactKey, ContactDraft>;

function defaultDrafts(): DraftsState {
  return SUPPORT_PLATFORM_ORDER.reduce((acc, key) => {
    acc[key] = {
      value:   '',
      label:   SUPPORT_DEFAULT_LABELS[key],
      enabled: false,
    };
    return acc;
  }, {} as DraftsState);
}

function settingsToDrafts(settings: SupportSettings): DraftsState {
  const d = defaultDrafts();
  for (const key of SUPPORT_PLATFORM_ORDER) {
    const entry: SupportContactEntry | undefined = settings[key];
    if (entry) {
      d[key] = {
        value:   entry.value   ?? '',
        label:   entry.label   ?? SUPPORT_DEFAULT_LABELS[key],
        enabled: entry.enabled ?? false,
      };
    }
  }
  return d;
}

// ─── Single contact card ─────────────────────────────────────────────────────
function ContactCard({
  contactKey, draft, isDark,
  onChangeValue, onChangeLabel, onToggleEnabled, onSave, saving, saved,
}: {
  contactKey:      ContactKey;
  draft:           ContactDraft;
  isDark:          boolean;
  onChangeValue:   (k: ContactKey, v: string) => void;
  onChangeLabel:   (k: ContactKey, v: string) => void;
  onToggleEnabled: (k: ContactKey) => void;
  onSave:          (k: ContactKey) => void;
  saving:          boolean;
  saved:           boolean;
}) {
  const c      = isDark ? neuColors.dark : neuColors.light;
  const flat   = neuFlatStyle(isDark);
  const layout = useLayout();
  const meta   = CONTACT_META[contactKey];
  const Icon   = SUPPORT_ICONS[contactKey];

  const inputStyle = {
    backgroundColor: c.base,
    borderRadius: layout.cardRadius / 1.5,
    paddingHorizontal: layout.pad.md,
    paddingVertical: layout.pad.sm + 2,
    fontSize: layout.bodySize,
    color: c.text,
    ...(flat as object),
  };

  return (
    <NeuCard style={{ marginBottom: layout.pad.lg, padding: layout.cardPx, gap: layout.pad.md }}>
      {/* Card header: icon + title + enabled toggle */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: layout.pad.md }}>
        <View style={{
          width: layout.touchTarget, height: layout.touchTarget,
          borderRadius: layout.touchTarget / 2,
          backgroundColor: `${c.primary}18`,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={layout.bodySize + 4} color={draft.enabled ? c.primary : `${c.text}44`} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: layout.headingSize, fontWeight: '700', color: c.text }}>{meta.title}</Text>
          <Text style={{ fontSize: layout.captionSize, color: `${c.text}66` }}>
            {draft.enabled ? 'Visible to users' : 'Hidden from users'}
          </Text>
        </View>
        <Switch
          value={draft.enabled}
          onValueChange={() => onToggleEnabled(contactKey)}
          trackColor={{ false: `${c.text}22`, true: `${c.primary}55` }}
          thumbColor={draft.enabled ? c.primary : `${c.text}66`}
        />
      </View>

      {/* Value input */}
      <View style={{ gap: layout.pad.xs }}>
        <Text style={{ fontSize: layout.captionSize, fontWeight: '600', color: `${c.text}88` }}>
          Contact Value
        </Text>
        <TextInput
          value={draft.value}
          onChangeText={v => onChangeValue(contactKey, v)}
          placeholder={meta.valuePlaceholder}
          placeholderTextColor={`${c.text}44`}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={meta.keyboardType}
          style={inputStyle}
        />
      </View>

      {/* Label input */}
      <View style={{ gap: layout.pad.xs }}>
        <Text style={{ fontSize: layout.captionSize, fontWeight: '600', color: `${c.text}88` }}>
          Display Label
        </Text>
        <TextInput
          value={draft.label}
          onChangeText={v => onChangeLabel(contactKey, v)}
          placeholder={meta.labelPlaceholder}
          placeholderTextColor={`${c.text}44`}
          style={inputStyle}
        />
      </View>

      {/* Hint */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: layout.pad.sm }}>
        <Info size={layout.captionSize} color={`${c.text}55`} style={{ marginTop: 2 }} />
        <Text style={{ flex: 1, fontSize: layout.captionSize, color: `${c.text}66`, lineHeight: layout.captionSize * 1.5 }}>
          {meta.hint}
        </Text>
      </View>

      {/* Save button */}
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: layout.pad.md }}>
        {saved && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <CheckCircle size={layout.captionSize} color="#16A34A" />
            <Text style={{ fontSize: layout.captionSize, color: '#16A34A', fontWeight: '600' }}>Saved!</Text>
          </View>
        )}
        <NeuButton
          label={saving ? 'Saving…' : 'Save'}
          icon={saving ? undefined : <Save size={layout.captionSize + 2} color={c.text} />}
          loading={saving}
          onPress={() => onSave(contactKey)}
          style={{ paddingHorizontal: layout.screenPx, paddingVertical: layout.pad.sm + 2 }}
        />
      </View>
    </NeuCard>
  );
}

// ─── Main screen ─────────────────────────────────────────────────────────────
export default function SaSupportSettings() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c      = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  const [drafts,     setDrafts]     = useState<DraftsState>(defaultDrafts());
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving,     setSaving]     = useState<ContactKey | null>(null);
  const [saved,      setSaved]      = useState<ContactKey | null>(null);
  const [error,      setError]      = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setError(null);
    try {
      const settings = await getSupportSettings();
      setDrafts(settingsToDrafts(settings));
    } catch {
      setError('Failed to load support settings. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    setLoading(true);
    void loadData();
  }, [loadData]));

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  const handleChangeValue   = (k: ContactKey, v: string) => setDrafts(d => ({ ...d, [k]: { ...d[k], value: v } }));
  const handleChangeLabel   = (k: ContactKey, v: string) => setDrafts(d => ({ ...d, [k]: { ...d[k], label: v } }));
  const handleToggleEnabled = (k: ContactKey)             => setDrafts(d => ({ ...d, [k]: { ...d[k], enabled: !d[k].enabled } }));

  const handleSave = async (k: ContactKey) => {
    setSaving(k);
    setError(null);
    try {
      await upsertSupportSetting(k, {
        value:   drafts[k].value.trim(),
        label:   drafts[k].label.trim() || CONTACT_META[k].title,
        enabled: drafts[k].enabled,
      });
      setSaved(k);
      setTimeout(() => setSaved(prev => (prev === k ? null : prev)), 2500);
    } catch {
      setError(`Failed to save ${CONTACT_META[k].title}. Please try again.`);
    } finally {
      setSaving(null);
    }
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />} contentContainerStyle={{ paddingBottom: safeBottom(layout.insets.bottom) }}
    >
      <PageHeader
        title="Support Settings"
        subtitle="Configure contact methods shown to users on the security/blocked screen"
      />

      <View style={{ paddingHorizontal: layout.screenPx + layout.pad.xl }}>

        {error && (
          <View style={{
            backgroundColor: '#FEF2F2', borderRadius: layout.cardRadius / 2,
            padding: layout.pad.md, marginBottom: layout.pad.lg,
            borderLeftWidth: 4, borderLeftColor: '#EF4444',
          }}>
            <Text style={{ fontSize: layout.captionSize, color: '#DC2626', lineHeight: layout.captionSize * 1.5 }}>
              {error}
            </Text>
          </View>
        )}

        {loading ? (
          <ActivityIndicator color={c.primary} style={{ marginTop: 60 }} size="large" />
        ) : (
          <>
            {/* Info banner */}
            <NeuCard style={{ marginBottom: layout.pad.xl, padding: layout.cardPx, flexDirection: 'row', gap: layout.pad.md }}>
              <Info size={layout.bodySize + 4} color={c.primary} style={{ marginTop: 2 }} />
              <Text style={{ flex: 1, fontSize: layout.captionSize, color: `${c.text}88`, lineHeight: layout.captionSize * 1.6 }}>
                Enabled contact methods will appear on the security warning screen when a user is blocked from logging in.
                If only one method is enabled, it will open directly. If multiple are enabled, the user will see a chooser.
                If none are enabled, users will see a &quot;Support not configured&quot; message.
              </Text>
            </NeuCard>

            {(Object.keys(CONTACT_META) as ContactKey[]).map(k => (
              <ContactCard
                key={k}
                contactKey={k}
                draft={drafts[k]}
                isDark={isDark}
                onChangeValue={handleChangeValue}
                onChangeLabel={handleChangeLabel}
                onToggleEnabled={handleToggleEnabled}
                onSave={handleSave}
                saving={saving === k}
                saved={saved === k}
              />
            ))}
          </>
        )}
      </View>
    </ScrollView>
  );
}
