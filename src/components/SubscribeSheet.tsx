/**
 * SubscribeSheet — THE single support-contact selection flow.
 *
 * Used by BOTH the Explore course list and the course-details screen (the
 * legacy duplicate `ContactSheet` was removed), so the two entry points can
 * never show different contact options again.
 *
 * Contact source, in order:
 *   1. the resolved doctor/course contacts the caller passes in
 *      (`resolveCourseContact()` in lib/subscribeContact.ts — honours
 *      `use_default_contact`);
 *   2. when that is empty, the Super Admin support contacts from the public
 *      `/support/contact` endpoint (the same list the security screen shows);
 *   3. otherwise an explicit "no contact methods configured" state.
 *
 * Only enabled, non-empty contacts render, in a stable order, each with a
 * destination that `contactUrl()`/`safeSupportUrl()` produced (https/tel/mailto
 * only — a stored value can never inject another scheme into Linking).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, Modal, Pressable, Linking, ActivityIndicator,
  useColorScheme, ScrollView, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, UserCheck, RefreshCw } from 'lucide-react-native';
import { neuColors, mutedTextStyle } from '@/lib/neu';
import { getPublicSupportContacts, SUPPORT_ICONS } from '@/lib/api';
import {
  contactUrl, safeSupportUrl, supportPlatformKey,
  SUBSCRIBE_CONTACT_ORDER,
  type SubscribeContact, type SubscribeContactKey,
} from '@/lib/subscribeContact';
import { useTranslation } from '@/lib/i18n';

/**
 * Localized label for each contact channel.
 *
 * `contactLabel()` in subscribeContact.ts stays the pure English fallback (it is
 * also the accessibility fallback used before the i18n layer is ready). The
 * channel names are UI vocabulary — "Call", "Email" and "Website" are
 * translated, while product names (WhatsApp, Telegram, X, Facebook, Instagram)
 * keep their brand spelling in both languages.
 */
const CONTACT_LABEL_KEYS: Record<SubscribeContactKey, string> = {
  whatsapp:  'contact.whatsapp',
  telegram:  'contact.telegram',
  phone:     'contact.phone',
  email:     'contact.email',
  x:         'contact.twitter',
  website:   'contact.website',
  facebook:  'contact.facebook',
  instagram: 'contact.instagram',
};

/** Kept as an alias so existing callers keep compiling. */
export type SubscribeSheetContact = SubscribeContact;

interface Props {
  visible: boolean;
  courseTitle: string;
  contact: SubscribeSheetContact;
  onClose: () => void;
}

interface SheetEntry {
  key: SubscribeContactKey;
  label: string;
  url: string;
  /** Server-provided ordering for the Super Admin fallback list. */
  order?: number;
}

// Per-channel accent (icon + pill tint). Brand colours where they exist.
const ACCENTS: Record<SubscribeContactKey, string> = {
  whatsapp:  '#25D366',
  telegram:  '#229ED9',
  phone:     '#16A34A',
  email:     '#EA4335',
  x:         '#64748B',
  website:   '#7C3AED',
  facebook:  '#1877F2',
  instagram: '#E1306C',
};

// ── Component ─────────────────────────────────────────────────────────────────

export function SubscribeSheet({ visible, courseTitle, contact, onClose }: Props) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const insets = useSafeAreaInsets();
  const { height: screenH } = useWindowDimensions();
  // Every application-owned string in this flow is translated (it used to be
  // hardcoded English, which is why Arabic users saw an English sheet). The
  // sheet also declares the APP LOCALE's direction, so rows mirror (icon on
  // the right) even on the launch before the native RTL relaunch lands.
  const { t, isRTL } = useTranslation();
  const txtAlign = isRTL ? 'right' as const : 'left' as const;

  // (1) Contacts supplied by the caller (doctor / course).
  const localEntries = useMemo<SheetEntry[]>(() => {
    const out: SheetEntry[] = [];
    for (const key of SUBSCRIBE_CONTACT_ORDER) {
      const raw = contact?.[key];
      if (!raw || !raw.trim()) continue;         // disabled / empty ⇒ not offered
      const url = contactUrl(key, raw);
      if (url) out.push({ key, label: t(CONTACT_LABEL_KEYS[key] ?? 'contact.title'), url });
    }
    return out;
  }, [contact, t]);

  const needsFallback = localEntries.length === 0;

  // (2) Super Admin support contacts — only fetched when nothing else exists.
  const [fallback, setFallback] = useState<SheetEntry[] | null>(null);
  const [fallbackError, setFallbackError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Every open starts from a fresh read, so a contact the admin just saved shows
  // up immediately instead of being served from a stale cache.
  useEffect(() => {
    if (!visible) {
      setFallback(null);
      setFallbackError(false);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible || !needsFallback || fallback !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await getPublicSupportContacts();
        if (cancelled) return;
        const entries: SheetEntry[] = [];
        for (const item of list ?? []) {
          if (!item || item.enabled === false) continue;
          const key = supportPlatformKey(item.platform);
          const url = safeSupportUrl(item.url);
          if (!key || !url) continue;
          entries.push({
            key,
            // A custom admin label is DATA and is shown verbatim; only the
            // default per-channel label is translated.
            label: (item.label ?? '').trim() || t(CONTACT_LABEL_KEYS[key] ?? 'contact.title'),
            url,
            order: typeof item.order === 'number' ? item.order : 0,
          });
        }
        entries.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        setFallbackError(false);
        setFallback(entries);
      } catch {
        if (!cancelled) {
          setFallbackError(true);
          setFallback([]);   // settle so the effect cannot loop
        }
      }
    })();
    return () => { cancelled = true; };
  }, [visible, needsFallback, fallback, attempt, t]);

  const retry = useCallback(() => {
    setFallbackError(false);
    setFallback(null);
    setAttempt((n) => n + 1);
  }, []);

  const entries = needsFallback ? (fallback ?? []) : localEntries;
  const loading = needsFallback && !fallbackError && fallback === null;
  const showEmpty = !loading && !fallbackError && entries.length === 0;

  const open = (url: string) => {
    Linking.openURL(url).catch(() => {});
    onClose();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      statusBarTranslucent
      onRequestClose={onClose}
    >
      {/* Full-screen backdrop — tapping it dismisses */}
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' }}
        onPress={onClose}
      />

      {/* Sheet — sits after the backdrop in the Modal's layout, anchored to bottom */}
      <Pressable onPress={e => e.stopPropagation()}>
        <View style={{
          // Elevated rung: the sheet must sit visibly ABOVE the page.
          backgroundColor: c.elevated,
          // App-locale direction for the whole sheet: rows, icons and text
          // align from the starting edge (right in Arabic).
          direction: isRTL ? 'rtl' : 'ltr',
          borderTopLeftRadius: 28,
          borderTopRightRadius: 28,
          paddingTop: 12,
          // Home-indicator / Android nav-bar inset + breathing room
          paddingBottom: Math.max(insets.bottom + 8, 20),
          // Cap height so content never overflows in landscape
          maxHeight: screenH * 0.85,
          shadowColor: c.shadowDark,
          shadowOffset: { width: 0, height: -6 },
          shadowOpacity: 0.18,
          shadowRadius: 20,
        }}>
          {/* Drag handle */}
          <View style={{
            width: 40, height: 4, borderRadius: 2,
            backgroundColor: `${c.text}22`,
            alignSelf: 'center', marginBottom: 20,
          }} />

          {/* Header row */}
          <View style={{
            flexDirection: 'row', alignItems: 'center',
            paddingHorizontal: 24, marginBottom: 6,
          }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: c.text, textAlign: txtAlign }}>
                {t('course.subscribeSheetTitle')}
              </Text>
              <Text style={{
                fontSize: 13, ...mutedTextStyle(c, 0.5),
                marginTop: 3, lineHeight: 18, textAlign: txtAlign,
              }} numberOfLines={2}>
                {/* Course title is DATA — shown verbatim in its own script. */}
                {courseTitle}
              </Text>
            </View>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={t('common.close')}
              style={{
                // `marginStart` follows the sheet's direction (left in LTR,
                // right in RTL) so the control stays on the inner edge.
                marginStart: 12,
                width: 34, height: 34, borderRadius: 17,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: c.inputSurface,
                borderWidth: isDark ? 1 : 0,
                borderColor: c.borderSoft,
                shadowColor: c.shadowDark,
                shadowOffset: { width: 2, height: 2 },
                shadowOpacity: 0.5, shadowRadius: 4,
              }}
            >
              <X size={16} color={isDark ? c.textMuted : c.text} opacity={isDark ? 1 : 0.5} />
            </Pressable>
          </View>

          {/* Sub-label */}
          <Text style={{
            fontSize: 13, ...mutedTextStyle(c, 0.45),
            paddingHorizontal: 24, marginBottom: 24, lineHeight: 18, textAlign: txtAlign,
          }}>
            {entries.length > 0 ? t('course.subscribeSheetHint') : undefined}
          </Text>

          {/* Scrollable content — enabled so long content scrolls on small devices */}
          <ScrollView
            contentContainerStyle={{ paddingHorizontal: 20, gap: 12 }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {loading ? (
              <View style={{ alignItems: 'center', paddingVertical: 32, gap: 12 }}>
                <ActivityIndicator color={c.primary} />
                <Text style={{ fontSize: 13, ...mutedTextStyle(c, 0.45) }}>
                  {t('course.subscribeSheetLoading')}
                </Text>
              </View>
            ) : fallbackError ? (
              <View style={{ alignItems: 'center', paddingVertical: 32, gap: 12 }}>
                <Text style={{
                  fontSize: 14, ...mutedTextStyle(c, 0.55),
                  textAlign: 'center', lineHeight: 20,
                }}>
                  {t('course.subscribeSheetError')}{'\n'}{t('course.subscribeSheetErrorHint')}
                </Text>
                <Pressable
                  onPress={retry}
                  accessibilityRole="button"
                  accessibilityLabel={t('common.retry')}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 8,
                    paddingVertical: 10, paddingHorizontal: 16, borderRadius: 14,
                    backgroundColor: `${c.primary}14`,
                  }}
                >
                  <RefreshCw size={15} color={c.primary} />
                  <Text style={{ fontSize: 13, fontWeight: '700', color: c.primary }}>{t('common.tryAgain')}</Text>
                </Pressable>
              </View>
            ) : showEmpty ? (
              <View style={{ alignItems: 'center', paddingVertical: 32, gap: 12 }}>
                <UserCheck size={44} color={c.text} opacity={0.15} />
                <Text style={{
                  fontSize: 14, ...mutedTextStyle(c, 0.4),
                  textAlign: 'center', lineHeight: 20,
                }}>
                  {t('course.subscribeSheetEmpty')}
                </Text>
              </View>
            ) : (
              <>
                {entries.map((entry) => {
                  const Icon = SUPPORT_ICONS[entry.key];
                  return (
                    <ContactButton
                      key={entry.key}
                      label={entry.label}
                      icon={<Icon size={20} color={ACCENTS[entry.key]} />}
                      accentColor={ACCENTS[entry.key]}
                      c={c}
                      onPress={() => open(entry.url)}
                    />
                  );
                })}
              </>
            )}
          </ScrollView>
        </View>
      </Pressable>
    </Modal>
  );
}

// ── ContactButton ─────────────────────────────────────────────────────────────

interface ButtonProps {
  label: string;
  icon: React.ReactNode;
  accentColor: string;
  c: typeof neuColors.light;
  onPress: () => void;
}

function ContactButton({ label, icon, accentColor, c, onPress }: ButtonProps) {
  const [pressed, setPressed] = React.useState(false);
  const { isRTL } = useTranslation();
  return (
    <Pressable
      cssInterop={false}
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        paddingVertical: 15,
        paddingHorizontal: 20,
        borderRadius: 18,
        // A selectable row INSIDE the sheet: the recessed step, so it reads as a
        // distinct tappable well on the elevated sheet rather than a hole.
        backgroundColor: c.inputSurface,
        shadowColor: c.shadowDark,
        shadowOffset: pressed ? { width: 1, height: 1 } : { width: 4, height: 4 },
        shadowOpacity: pressed ? 0.35 : 0.55,
        shadowRadius: pressed ? 3 : 8,
        opacity: pressed ? 0.88 : 1,
        borderWidth: 1,
        borderColor: `${accentColor}18`,
      }}
    >
      {/* Icon pill */}
      <View style={{
        width: 40, height: 40, borderRadius: 12,
        backgroundColor: `${accentColor}14`,
        alignItems: 'center', justifyContent: 'center',
      }}>
        {icon}
      </View>

      <Text style={{
        flex: 1,
        fontSize: 15,
        fontWeight: '700',
        color: c.text,
        textAlign: isRTL ? 'right' : 'left',
      }}>
        {label}
      </Text>

      {/* Chevron hint */}
      <View style={{
        width: 28, height: 28, borderRadius: 8,
        backgroundColor: `${accentColor}12`,
        alignItems: 'center', justifyContent: 'center',
      }}>
        {/* Directional affordance: points along the reading direction. */}
        <Text style={{ fontSize: 14, color: accentColor, fontWeight: '800' }}>
          {isRTL ? '‹' : '›'}
        </Text>
      </View>
    </Pressable>
  );
}
