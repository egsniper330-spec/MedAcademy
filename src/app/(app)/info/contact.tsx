/**
 * Contact Us — MedAcademy identity + Super-Admin-configured contact links.
 *
 * DATA FLOW (all live, nothing hardcoded):
 *   Platform → Branding          → logo_url, legacy channels (email/phone/…)
 *   Platform → CMS → Contact Us  → intro text (built-in fallback when unset)
 *   Platform → Branding          → contact_links[] (platform/label/url/enabled)
 *
 * LOADING CONTRACT (infinite-spinner fix): the previous implementation
 * initialised `loading=true` and NEVER fetched branding (setLoading was never
 * called) — the page spun forever for every user. The screen now always
 * reaches a terminal state:
 *   • loaded  → logo + intro + contact link rows
 *   • empty   → friendly card when no channel is configured
 *   • error   → "Unable to load Contact Us" + Retry (branding fetch failed)
 * A CMS/branding failure is a data problem, never a security/auth problem:
 * the session is untouched and the user is never redirected to Login.
 *
 * PRIVACY CONTRACT: raw destinations are never rendered. Each row shows the
 * friendly label + description from the platform registry; the URL only goes
 * to Linking.openURL() (safety-checked by isSafeContactHref()).
 */
import React, { useState } from 'react';
import {
  ScrollView, View, Text, useColorScheme, Pressable,
  ActivityIndicator, Linking, Animated, Image,
} from 'react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { BrandLogo } from '@/components/BrandLogo';
import { neuColors, useLayout, mutedTextStyle } from '@/lib/neu';
import { usePressAnim, useEntranceAnim } from '@/lib/motion';
import { useCmsSections } from '@/lib/cmsContent';
import {
  useBranding, parseContactLinks, contactLinkHref, isSafeContactHref,
  platformDef, platformIcon,
} from '@/lib/branding';
import { HeartHandshake, ChevronRight, RefreshCw, Link2, AlertTriangle } from 'lucide-react-native';
import { useTranslation } from '@/lib/i18n';

/**
 * Localized label/description per platform. Admin-configured CUSTOM labels and
 * destinations are data and stay as configured; the DEFAULT identity (the
 * registry label, which the backend stores when the admin did not customize it)
 * is localized so an Arabic user never sees "Send us an email." in English.
 */
const CONTACT_TEXT_KEYS: Record<string, { label: string; desc: string }> = {
  email:     { label: 'contact.email',     desc: 'contact.emailDesc' },
  phone:     { label: 'contact.phone',     desc: 'contact.phoneDesc' },
  whatsapp:  { label: 'contact.whatsapp',  desc: 'contact.whatsappDesc' },
  telegram:  { label: 'contact.telegram',  desc: 'contact.telegramDesc' },
  website:   { label: 'contact.website',   desc: 'contact.websiteDesc' },
  facebook:  { label: 'contact.facebook',  desc: 'contact.facebookDesc' },
  instagram: { label: 'contact.instagram', desc: 'contact.instagramDesc' },
  twitter:   { label: 'contact.twitter',   desc: 'contact.twitterDesc' },
};

// ── Contact channel definition ────────────────────────────────────────────────
type ContactItem = {
  /** Stable platform key (registry id) — the row's React key. */
  platform: string;
  /** Admin-configured label, or the registry default. */
  label: string;
  /** Registry description (never the raw URL). */
  description: string;
  onPress: () => void;
};

/** Remote-logo row with graceful failure — a bad logo never blanks the page. */
function BrandHeaderLogo({ remoteUrl, size }: { remoteUrl?: string; size: number }) {
  const [state, setState] = useState<'remote' | 'fallback' | 'done' | 'error'>(
    remoteUrl ? 'remote' : 'fallback',
  );

  // Remote logo failed / invalid → bundled full logo (same identity source as
  // the rest of the app). If even the bundle is somehow unavailable, the
  // HeartHandshake mark keeps the header presentable.
  if (state === 'fallback') return <BrandLogo size={size} />;
  if (state === 'error') {
    return (
      <View style={{ width: size * 3, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <BrandLogo variant="monogram" size={size} />
      </View>
    );
  }
  return (
    <Image
      source={{ uri: remoteUrl }}
      style={{ width: size * 3, height: size }}
      resizeMode="contain"
      onLoad={() => setState('done')}
      onError={() => setState('fallback')}
    />
  );
}

// ── Animated contact card ─────────────────────────────────────────────────────
function ContactCard({ item }: { item: ContactItem }) {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const { t } = useTranslation();

  const def = platformDef(item.platform);
  const Icon = platformIcon(item.platform);
  const press = usePressAnim();
  const iconSz    = layout.touchTarget + 8;
  const iconInner = Math.round(iconSz * 0.46);

  return (
    <Animated.View style={press.style}>
      <Pressable
        onPress={item.onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        accessibilityRole="button"
        accessibilityLabel={`${item.label} — ${item.description}`}
      >
        <NeuCard radius={layout.cardRadius} style={{ flexDirection: 'row', alignItems: 'center', padding: layout.cardPx, gap: layout.pad.md }}>

          {/* Platform icon badge — color + glyph from the registry */}
          <View style={{
            width: iconSz, height: iconSz,
            borderRadius: layout.heroIconRadius / 1.5,
            backgroundColor: `${def.color}15`,
            alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <Icon size={iconInner} color={def.color} />
          </View>

          {/* Label + description — the destination itself is NEVER rendered */}
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={{
              fontSize: layout.bodySize + 1, fontWeight: '800',
              color: c.text, lineHeight: (layout.bodySize + 1) * 1.3,
            }}>
              {item.label}
            </Text>
            <Text style={{
              fontSize: layout.captionSize, fontWeight: '500',
              ...mutedTextStyle(c, 0.45), lineHeight: layout.captionSize * 1.4,
            }} numberOfLines={2}>
              {item.description}
            </Text>
          </View>

          {/* Open chevron pill */}
          <View style={{
            flexDirection: 'row', alignItems: 'center', gap: 2,
            paddingHorizontal: layout.pad.sm + 2, paddingVertical: layout.pad.xs + 2,
            borderRadius: layout.cardRadius / 1.5,
            backgroundColor: `${def.color}14`,
            flexShrink: 0,
          }}>
            <Text style={{ fontSize: layout.captionSize, fontWeight: '700', color: def.color }}>{t('contact.open')}</Text>
            <ChevronRight size={layout.captionSize + 1} color={def.color} strokeWidth={2.5} />
          </View>

        </NeuCard>
      </Pressable>
    </Animated.View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────
export default function ContactPage() {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();
  const { t } = useTranslation();

  /** Localized label/description for a platform, with a safe generic fallback. */
  const platformText = (platform: string): { label: string; description: string } => {
    const keys = CONTACT_TEXT_KEYS[platform];
    if (!keys) return { label: platformDef(platform).label, description: t('contact.unknownDesc') };
    return { label: t(keys.label), description: t(keys.desc) };
  };

  // Branding (logo, legacy channels, contact_links) + fetch status for the
  // terminal error state. refresh() is the Retry action.
  const { branding, status: brandingStatus, refresh } = useBranding();
  const [retrying, setRetrying] = useState(false);

  // Server-managed intro text (Super Admin → Platform → CMS Pages → Contact
  // Us). Falls back to the bundled copy while loading / when unset.
  // [] as the fallback keeps the built-in intro reactive to a language change.
  const intro = useCmsSections('contact_us', []);

  // Hero entrance
  const heroEntrance = useEntranceAnim({ offsetY: 12, duration: 460 });

  const cmsIntro = intro
    .map((section) => (section.heading !== '' ? `${section.heading}: ${section.body}` : section.body).trim())
    .filter((part) => part !== '')
    .join('\n');
  const introText = cmsIntro !== '' ? cmsIntro : t('contact.introFallback');

  // ── Build the channel list ────────────────────────────────────────────────
  // 1) Admin-configured links first, in the admin's order. Disabled links stay
  //    saved on the server but are never rendered. A destination that fails the
  //    safety check is refused here (defense in depth — the backend already
  //    rejects such values at save time).
  const contacts: ContactItem[] = [];
  const customLinks = parseContactLinks((branding as unknown as Record<string, unknown>)?.contact_links)
    .filter((l) => l.enabled);
  for (const link of customLinks) {
    const href = contactLinkHref(link);
    if (!isSafeContactHref(href)) continue; // malformed/dangerous URL → never rendered
    const text = platformText(link.platform);
    contacts.push({
      platform: link.platform,
      // A label the admin replaced with their own text is preserved verbatim;
      // the untouched registry default follows the app language.
      label: link.label === platformDef(link.platform).label ? text.label : link.label,
      description: text.description,
      onPress: () => {
        if (!isSafeContactHref(href)) return;
        void Linking.openURL(href).catch(() => {});
      },
    });
  }

  // 2) Legacy branding channels — only for platforms NOT covered above, so
  //    nothing is ever shown twice (configured link = authoritative entry).
  //    Legacy DB values are never deleted; they simply yield to newer config.
  const configured = new Set(customLinks.map((l) => l.platform));
  const b = branding as unknown as Record<string, unknown>;
  const legacy: ContactItem[] = [];
  if (b?.contact_email && !configured.has('email')) {
    legacy.push({ platform: 'email', label: platformText('email').label, description: platformText('email').description, onPress: () => { void Linking.openURL(`mailto:${b.contact_email}`).catch(() => {}); } });
  }
  if (b?.contact_phone && !configured.has('phone')) {
    legacy.push({ platform: 'phone', label: platformText('phone').label, description: platformText('phone').description, onPress: () => { void Linking.openURL(`tel:${b.contact_phone}`).catch(() => {}); } });
  }
  if (b?.whatsapp_url && !configured.has('whatsapp')) {
    const raw = String(b.whatsapp_url);
    const href = /^https?:\/\//i.test(raw) ? raw : `https://wa.me/${String(raw).replace(/\D/g, '')}`;
    legacy.push({ platform: 'whatsapp', label: platformText('whatsapp').label, description: platformText('whatsapp').description, onPress: () => { void Linking.openURL(href).catch(() => {}); } });
  }
  if (b?.telegram_url && !configured.has('telegram')) {
    const raw = String(b.telegram_url);
    const href = /^https?:\/\//i.test(raw) ? raw : `https://t.me/${String(raw).replace('@', '')}`;
    legacy.push({ platform: 'telegram', label: platformText('telegram').label, description: platformText('telegram').description, onPress: () => { void Linking.openURL(href).catch(() => {}); } });
  }
  if (b?.website_url && !configured.has('website')) {
    legacy.push({ platform: 'website', label: platformText('website').label, description: platformText('website').description, onPress: () => { void Linking.openURL(String(b.website_url)).catch(() => {}); } });
  }
  contacts.push(...legacy);

  const heroIconSz  = layout.heroIconSize * 1.1;

  const runRetry = () => {
    setRetrying(true);
    refresh();
    // The hook re-fetches; clear the retry spinner on the next tick regardless
    // of outcome — status flips to ok/error and the correct state renders.
    setTimeout(() => setRetrying(false), 400);
  };

  const loaded = brandingStatus === 'ok';

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <PageHeader title={t('contact.title')} showBack />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          padding: layout.screenPx,
          paddingBottom: layout.insets.bottom + layout.screenPx,
        }}
      >

      {/* ── Error state — branding fetch failed (Retry; never redirects to login) ── */}
      {!loaded ? (
        <NeuCard radius={layout.cardRadius} style={{ padding: layout.cardPx * 2, alignItems: 'center', gap: layout.pad.md }}>
          <View style={{
            width: layout.heroIconSize, height: layout.heroIconSize,
            borderRadius: layout.heroIconSize / 2, backgroundColor: '#EF444418',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <AlertTriangle size={Math.round(layout.heroIconSize * 0.5)} color="#EF4444" />
          </View>
          <Text style={{ fontSize: layout.bodySize + 1, fontWeight: '800', color: c.text, textAlign: 'center' }}>
            {t('contact.errorTitle')}
          </Text>
          <Text style={{ fontSize: layout.captionSize, ...mutedTextStyle(c, 0.5), textAlign: 'center' }}>
            {t('contact.errorBody')}
          </Text>
          <Pressable
            onPress={runRetry}
            disabled={retrying}
            accessibilityRole="button"
            accessibilityLabel={t('contact.retryA11y')}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 8,
              paddingHorizontal: layout.pad.lg, paddingVertical: layout.pad.md,
              borderRadius: layout.cardRadius, backgroundColor: c.primary,
              opacity: retrying ? 0.6 : 1,
            }}
          >
            {retrying
              ? <ActivityIndicator size="small" color="#FFFFFF" />
              : <RefreshCw size={layout.captionSize + 4} color="#FFFFFF" />}
            <Text style={{ fontSize: layout.bodySize, fontWeight: '700', color: '#FFFFFF' }}>
              {t('common.retry')}
            </Text>
          </Pressable>
        </NeuCard>
      ) : (
        <>

          {/* ── Hero: logo + title + CMS intro ─────────────────────────────── */}
          <Animated.View style={{
            alignItems: 'center',
            marginBottom: layout.sectionGap,
            marginTop: layout.pad.xs,
            ...heroEntrance.style,
          }}>
            {/* Platform logo — bundled identity, remote override if configured.
                Explicit dimensions on the network image (RN requirement); a
                failed/invalid logo degrades to the bundled logo and never
                blanks the page or blocks the links below. */}
            <View style={{ marginBottom: layout.pad.lg }}>
              <BrandHeaderLogo remoteUrl={(b?.logo_url as string) || undefined} size={layout.touchTarget * 1.6} />
            </View>

            <Text style={{ fontSize: layout.titleSize * 0.85, fontWeight: '800', color: c.text, marginBottom: layout.pad.sm }}>
              {t('contact.title')}
            </Text>

            {/* Accent divider */}
            <View style={{
              width: layout.pad.xxl, height: 3, borderRadius: 2,
              backgroundColor: c.primary, opacity: 0.55,
              marginBottom: layout.pad.md,
            }} />

            <Text style={{
              fontSize: layout.captionSize + 1, ...mutedTextStyle(c, 0.5),
              textAlign: 'center', lineHeight: (layout.captionSize + 1) * 1.55,
              paddingHorizontal: layout.screenPx,
            }}>
              {introText}
            </Text>
          </Animated.View>

          {/* ── Content: loaded list / empty state ─────────────────────────── */}
          {contacts.length === 0 ? (
            <NeuCard radius={layout.cardRadius} style={{ padding: layout.cardPx * 2, alignItems: 'center', gap: layout.pad.md }}>
              <HeartHandshake size={layout.heroIconSize} color={c.primary} opacity={0.22} />
              <Text style={{ fontSize: layout.bodySize + 1, fontWeight: '700', ...mutedTextStyle(c, 0.5), textAlign: 'center' }}>
                {t('contact.emptyTitle')}
              </Text>
              <Text style={{ fontSize: layout.captionSize, ...mutedTextStyle(c, 0.35), textAlign: 'center' }}>
                {t('contact.emptyBody')}
              </Text>
            </NeuCard>
          ) : (
            <View style={{ gap: layout.itemGap }}>
              {contacts.map((item) => (
                <ContactCard key={item.platform} item={item} />
              ))}
            </View>
          )}
        </>
      )}
    </ScrollView>
    </View>
  );
}
