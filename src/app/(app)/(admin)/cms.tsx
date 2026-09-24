/**
 * CMS Pages — Admin & Super Admin
 * Edit About Us, Contact, Privacy Policy, Terms & Conditions.
 *
 * Contact Us additionally owns a STRUCTURED link list (`contact_links`): the
 * editor below adds/edits/deletes/enables/reorders the links users tap on the
 * public Contact Us screen. Links persist server-side through the existing
 * platform branding endpoint (PUT /platform/branding), which validates every
 * entry — the client never decides what is storeable.
 */
import { useCallback, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import {
  View, Text, ScrollView, TextInput, Switch,
  RefreshControl, useColorScheme, Pressable,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  FileText, Edit3, Check, ChevronRight, ChevronDown,
  Plus, Trash2, ArrowUp, ArrowDown, Link2,
} from 'lucide-react-native';
import { getCMSPages, updateCMSPage, getBranding, updateBranding } from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { LoadingState, ErrorState } from '@/components/ScreenState';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/components/Toast';
import { neuColors, useLayout, safeBottom } from '@/lib/neu';
import { friendlyError } from '@/lib/validation';
import { CONTACT_LINK_PRESETS, parseContactLinks, type ContactLink } from '@/lib/branding';

const PAGE_COLORS: Record<string, string> = {
  about_us: '#1E90FF', contact_us: '#16A34A', privacy_policy: '#7C3AED', terms_conditions: '#D97706',
};

const PLATFORM_COLOR: Record<string, string> = {
  whatsapp: '#16A34A', telegram: '#2DA8FF', facebook: '#1877F2', instagram: '#E1306C',
  twitter: '#0F172A', website: '#6B7280', email: '#DC2626', phone: '#0EA5E9',
};

/**
 * Mirror of PlatformController::sanitizeContactLinks validation, so an invalid
 * entry is caught in the editor instead of failing the whole save round-trip.
 * Returns null when the link is valid.
 */
function linkError(link: ContactLink): string | null {
  const label = link.label.trim();
  const url   = link.url.trim();
  if (!CONTACT_LINK_PRESETS.some(p => p.key === link.platform)) return 'Choose a platform.';
  if (label === '') return 'Add a label.';
  if (label.length > 60) return 'Label is limited to 60 characters.';
  if (url === '') return 'Add a destination.';
  if (url.length > 500) return 'Destination is limited to 500 characters.';
  if (link.platform === 'email') {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url.replace(/^mailto:/i, ''))
      ? null : 'Enter a valid email address.';
  }
  if (link.platform === 'phone') {
    return /^\+?[0-9 ()\-]{6,20}$/.test(url.replace(/^tel:/i, ''))
      ? null : 'Enter a valid phone number.';
  }
  return /^https?:\/\//i.test(url) ? null : 'Must start with http:// or https://';
}

/** Structured Contact Us link editor (add · edit · delete · enable · reorder). */
function ContactLinksEditor({
  links, setLinks, onSave, saving, c, layout,
}: {
  links: ContactLink[];
  setLinks: (next: ContactLink[]) => void;
  onSave: () => void;
  saving: boolean;
  c: any;
  layout: any;
}) {
  const inp = {
    backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10,
    shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.45, shadowRadius: 5,
  };

  const update = (index: number, patch: Partial<ContactLink>) =>
    setLinks(links.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= links.length) return;
    const next = [...links];
    [next[index], next[target]] = [next[target], next[index]];
    setLinks(next);
  };

  const errors = links.map(linkError);
  const invalid = errors.some(e => e !== null);

  return (
    <View style={{ marginTop: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <Link2 size={15} color={c.primary} />
        <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, textTransform: 'uppercase' }}>
          Contact Links
        </Text>
      </View>
      <Text style={{ fontSize: 11, color: c.text, opacity: 0.45, marginBottom: 12, lineHeight: 16 }}>
        Shown on the public Contact Us screen in this order. Users see the label and tapping opens the
        destination. Email/phone are entered as a plain address/number; other platforms need a full
        https:// link. Disabled links stay saved but stay hidden.
      </Text>

      {links.length === 0 && (
        <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginBottom: 12 }}>
          No custom links yet — the built-in contact channels are still shown.
        </Text>
      )}

      {links.map((link, index) => {
        const tone = PLATFORM_COLOR[link.platform] ?? c.primary;
        return (
          <View key={`${link.platform}-${index}`} style={{
            borderRadius: 14, padding: 12, marginBottom: 10,
            backgroundColor: `${c.text}08`, borderWidth: 1,
            borderColor: errors[index] ? '#DC262655' : `${c.text}14`,
          }}>
            {/* Row 1 — platform preset + move/delete/visibility */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: tone }} />
              <Text style={{ flex: 1, fontSize: 12, fontWeight: '800', color: c.text }} numberOfLines={1}>
                {link.label.trim() || 'New link'}
              </Text>
              <Pressable
                onPress={() => move(index, -1)}
                disabled={index === 0}
                accessibilityLabel={`Move ${link.label} up`}
                accessibilityRole="button"
                style={{ padding: 6, opacity: index === 0 ? 0.25 : 1 }}
              >
                <ArrowUp size={15} color={c.text} />
              </Pressable>
              <Pressable
                onPress={() => move(index, 1)}
                disabled={index === links.length - 1}
                accessibilityLabel={`Move ${link.label} down`}
                accessibilityRole="button"
                style={{ padding: 6, opacity: index === links.length - 1 ? 0.25 : 1 }}
              >
                <ArrowDown size={15} color={c.text} />
              </Pressable>
              <Pressable
                onPress={() => setLinks(links.filter((_, i) => i !== index))}
                accessibilityLabel={`Remove ${link.label}`}
                accessibilityRole="button"
                style={{ padding: 6 }}
              >
                <Trash2 size={15} color="#DC2626" />
              </Pressable>
            </View>

            {/* Row 2 — presets */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {CONTACT_LINK_PRESETS.map(p => {
                  const on = p.key === link.platform;
                  return (
                    <Pressable
                      key={p.key}
                      onPress={() => update(index, { platform: p.key })}
                      accessibilityLabel={`Set platform ${p.label}`}
                      accessibilityRole="button"
                      style={{
                        paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10,
                        backgroundColor: on ? `${tone}22` : `${c.text}08`,
                        borderWidth: 1.5, borderColor: on ? tone : 'transparent',
                      }}
                    >
                      <Text style={{ fontSize: 11, fontWeight: '700', color: on ? tone : `${c.text}90` }}>
                        {p.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>

            {/* Row 3 — label + destination */}
            <Text style={{ fontSize: 10, fontWeight: '700', color: c.text, opacity: 0.45, marginBottom: 4 }}>
              LABEL
            </Text>
            <TextInput
              value={link.label}
              onChangeText={v => update(index, { label: v })}
              placeholder="WhatsApp"
              placeholderTextColor={`${c.text}40`}
              style={{ ...inp, minWidth: 0, marginBottom: 10, fontSize: 13, color: c.text }}
            />
            <Text style={{ fontSize: 10, fontWeight: '700', color: c.text, opacity: 0.45, marginBottom: 4 }}>
              {link.platform === 'email' ? 'EMAIL ADDRESS'
                : link.platform === 'phone' ? 'PHONE NUMBER'
                  : 'DESTINATION (https://…)'}
            </Text>
            <TextInput
              value={link.url}
              onChangeText={v => update(index, { url: v })}
              placeholder={link.platform === 'email' ? 'support@example.com'
                : link.platform === 'phone' ? '+20 100 000 0000'
                  : 'https://example.com'}
              placeholderTextColor={`${c.text}40`}
              autoCapitalize="none"
              autoCorrect={false}
              style={{ ...inp, minWidth: 0, fontSize: 13, color: c.text }}
            />

            {/* Row 4 — enabled */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: c.text }}>
                {link.enabled ? 'Enabled — visible to users' : 'Disabled — saved but hidden'}
              </Text>
              <Switch
                value={link.enabled}
                onValueChange={v => update(index, { enabled: v })}
                trackColor={{ false: `${c.shadowDark}80`, true: `${c.primary}60` }}
                thumbColor={link.enabled ? c.primary : c.text}
              />
            </View>

            {!!errors[index] && (
              <Text style={{ fontSize: 11, fontWeight: '700', color: '#DC2626', marginTop: 8 }}>
                {errors[index]}
              </Text>
            )}
          </View>
        );
      })}

      <Pressable
        onPress={() => setLinks([...links, { platform: 'website', label: 'Website', url: '', enabled: true }])}
        accessibilityLabel="Add contact link"
        accessibilityRole="button"
        style={{
          flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
          paddingVertical: 10, borderRadius: 12, borderWidth: 1.5,
          borderStyle: 'dashed', borderColor: `${c.primary}66`, marginBottom: 10,
        }}
      >
        <Plus size={15} color={c.primary} />
        <Text style={{ fontSize: 12, fontWeight: '800', color: c.primary }}>Add Link</Text>
      </Pressable>

      {invalid && (
        <Text style={{ fontSize: 11, fontWeight: '700', color: '#DC2626', marginBottom: 8 }}>
          Fix the highlighted links before saving.
        </Text>
      )}

      <NeuButton
        label="Save Contact Links"
        icon={<Check size={16} color="#fff" />}
        onPress={onSave}
        loading={saving}
        disabled={invalid}
        fullWidth
      />
    </View>
  );
}

/**
 * Shared by the Admin shell and the Super Admin shell.
 *
 * `backTo` is the header back arrow's terminal fallback: the SA shell renders
 * screens as TABS, so there is nothing to pop when the page was opened straight
 * from the drawer. Normal hub entry pops back to the hub that pushed it.
 */
export default function CMSPagesScreen({ backTo }: { backTo?: string } = {}) {
  const router = useRouter();
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const { showToast } = useToast();

  const [pages, setPages] = useState<any[]>([]);
  const [links, setLinks] = useState<ContactLink[]>([]);
  const [savingLinks, setSavingLinks] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, { title: string; content: string }>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // Terminal-state contract: LOADING → (ERROR | EMPTY | CONTENT).
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getCMSPages();
      setPages(data);
      const ed: Record<string, { title: string; content: string }> = {};
      data.forEach((p: any) => { ed[p.key] = { title: p.title, content: p.content }; });
      setEditing(ed);
      // Contact links live on the branding record; a failure here never blocks
      // the page list (the editor simply starts from the last known list).
      try {
        const branding = await getBranding();
        setLinks(parseContactLinks((branding as any)?.contact_links));
      } catch { /* keep whatever we already have */ }
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // The save endpoint returns the full page list, so the row state (including
  // the "Built-in default" badge) updates without a full reload flash.
  const applyPages = (next: unknown) => {
    if (!Array.isArray(next) || next.length === 0) return;
    setPages(next as any[]);
    const ed: Record<string, { title: string; content: string }> = {};
    (next as any[]).forEach((p: any) => { ed[p.key] = { title: p.title, content: p.content ?? '' }; });
    setEditing(ed);
  };

  const handleSave = async (key: string) => {
    const payload = editing[key];
    if (!payload) return;
    setSaving(key);
    try {
      applyPages(await updateCMSPage(key, payload));
      setSaved(key);
      setTimeout(() => setSaved(null), 2500);
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to save page.') });
    }
    setSaving(null);
  };

  // Restore the app's built-in text for a page: an EMPTY body means "render the
  // bundled copy", so this never leaves a page blank and never loses the legal
  // text the app ships with.
  const handleRestoreDefault = async (key: string) => {
    setSaving(key);
    try {
      applyPages(await updateCMSPage(key, { content: '' }));
      showToast({ type: 'success', message: 'Built-in text restored.' });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to restore the built-in text.') });
    }
    setSaving(null);
  };

  const handleSaveLinks = async () => {
    setSavingLinks(true);
    try {
      const updated = await updateBranding({ contact_links: links });
      setLinks(parseContactLinks((updated as any)?.contact_links ?? links));
      showToast({ type: 'success', message: 'Contact links saved.' });
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Failed to save contact links.') });
    }
    setSavingLinks(false);
  };

  const inp = { backgroundColor: c.base, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 }, shadowOpacity: 0.45, shadowRadius: 5 };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />} contentContainerStyle={{ paddingBottom: safeBottom(layout.insets.bottom) }}>
      <PageHeader
        title="CMS Pages"
        subtitle="Edit platform content pages"
        accentColor="#16A34A"
        showBack
        backFallback={backTo ?? '/admin-overview'}
      />

      <View style={{ paddingHorizontal: layout.screenPx }}>

        {loading ? (
          <LoadingState label="Loading CMS pages…" />
        ) : error ? (
          <ErrorState error={error} onRetry={load} />
        ) : pages.length === 0 ? (
          <EmptyState
            icon={<FileText size={40} color={c.primary} />}
            title="No CMS pages"
            description="The server returned no CMS page content."
            action={{ label: 'Refresh', onPress: load }}
          />
        ) : (
          pages.map(page => {
            const color = PAGE_COLORS[page.key] ?? c.primary;
            const isOpen = expanded === page.key;
            const draft = editing[page.key];
            return (
              <NeuCard key={page.key} style={{ marginBottom: 14 }}>
                <Pressable
                  onPress={() => setExpanded(isOpen ? null : page.key)}
                  accessibilityLabel={`${isOpen ? 'Collapse' : 'Expand'} ${page.title}`}
                  accessibilityRole="button"
                  style={{ flexDirection: 'row', alignItems: 'center', padding: 16 }}>
                  <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: `${color}18`, alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
                    <Edit3 size={20} color={color} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>{page.title}</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: page.published ? '#16A34A' : '#DC2626' }} />
                      <Text style={{ fontSize: 11, fontWeight: '600', color: page.published ? '#16A34A' : '#DC2626' }}>
                        {page.published ? 'Published' : 'Draft'}
                      </Text>
                      {page.using_builtin && (
                        <View style={{ backgroundColor: `${c.text}14`, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 }}>
                          <Text style={{ fontSize: 10, fontWeight: '800', color: c.text, opacity: 0.6 }}>BUILT-IN TEXT</Text>
                        </View>
                      )}
                    </View>
                  </View>
                  {saved === page.key ? (
                    <Check size={18} color="#16A34A" />
                  ) : isOpen ? (
                    <ChevronDown size={18} color={`${c.text}55`} />
                  ) : (
                    <ChevronRight size={18} color={`${c.text}55`} />
                  )}
                </Pressable>

                {isOpen && draft && (
                  <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase' }}>Page Title</Text>
                    <TextInput
                      value={draft.title}
                      onChangeText={v => setEditing(prev => ({ ...prev, [page.key]: { ...prev[page.key], title: v } }))}
                      style={{ ...inp, minWidth: 0, marginBottom: 14 }}
                    />
                    <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase' }}>Content</Text>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.45, marginBottom: 8, lineHeight: 16 }}>
                      Plain text — no HTML. Lines starting with ## become section headings. Leave empty to keep the app's built-in text.
                    </Text>
                    <View style={{ ...inp, minWidth: 0, marginBottom: 16 }}>
                      <TextInput
                        value={draft.content}
                        onChangeText={v => setEditing(prev => ({ ...prev, [page.key]: { ...prev[page.key], content: v } }))}
                        multiline
                        numberOfLines={10}
                        style={{ fontSize: 13, color: c.text, minWidth: 0, minHeight: 220, textAlignVertical: 'top' }}
                      />
                    </View>
                    {saved === page.key && (
                      <Text style={{ color: '#16A34A', fontWeight: '700', fontSize: 13, marginBottom: 10 }}>✅ Saved successfully</Text>
                    )}
                    <NeuButton
                      label="Save Changes"
                      icon={<Check size={16} color="#fff" />}
                      onPress={() => handleSave(page.key)}
                      loading={saving === page.key}
                      fullWidth
                    />

                    {/* Contact Us owns the structured link list users tap. */}
                    {page.key === 'contact_us' && (
                      <View style={{ marginTop: 18, paddingTop: 16, borderTopWidth: 1, borderTopColor: `${c.text}14` }}>
                        <ContactLinksEditor
                          links={links}
                          setLinks={setLinks}
                          onSave={handleSaveLinks}
                          saving={savingLinks}
                          c={c}
                          layout={layout}
                        />
                      </View>
                    )}

                    {!page.using_builtin && (
                      <Pressable
                        onPress={() => handleRestoreDefault(page.key)}
                        disabled={saving === page.key}
                        style={{ marginTop: 10, paddingVertical: 10, alignItems: 'center' }}
                      >
                        <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>
                          Restore built-in text
                        </Text>
                      </Pressable>
                    )}
                  </View>
                )}
              </NeuCard>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}
