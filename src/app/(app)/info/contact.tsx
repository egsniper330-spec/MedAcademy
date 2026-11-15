/**
 * Contact Us — MedAcademy identity + Super-Admin-configured contact links.
 * ENGLISH-ONLY BY PRODUCT DECISION: this page must read in English for every
 * app language (an Arabic user still sees English here), so no string on this
 * screen goes through the i18n catalog. Every other screen is untouched.
 *
 * DATA FLOW (all live, nothing hardcoded):
 *   Platform → Branding          → logo_url, legacy channels (email/phone/…)
 *   Platform → CMS → Contact Us  → intro text (built-in fallback when unset)
 *   Platform → Branding          → contact_links[] (platform/label/url/enabled)
 *
 * ROOT CAUSE of “every method is called WhatsApp, and logos are missing”:
 * the admin editor stores a LABEL per row, and that label is sticky — a row
 * whose URL was changed from WhatsApp to Telegram kept `label:'Whatsapp'`, so
 * three different destinations all rendered as “WhatsApp”. The label was
 * trusted as display text. It is no longer: the displayed NAME comes from the
 * platform registry for the row's effective platform, and the stored label is
 * only used as data (never as the heading). The effective platform — and with
 * it the logo — is resolved from the destination host (wa.me → WhatsApp,
 * t.me → Telegram, …), because the stored `platform` is equally stale (the live
 * rows save several destinations as `platform:'facebook'`).
 *
 * ORDER is fixed by product request and independent of storage order:
 *   1 WhatsApp · 2 Telegram · 3 Facebook · 4 Website · 5 Email
 * Rows for other platforms (Instagram, X, Phone…) follow, then anything unknown.
 *
 * PRIVACY CONTRACT: raw destinations are never rendered. Each row shows the
 * registry label + description; the URL only goes to Linking.openURL()
 * (safety-checked by isSafeContactHref()).
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
import { HeartHandshake, ChevronRight, RefreshCw, AlertTriangle } from 'lucide-react-native';
import { PlatformBrandIcon, brandIconTint, hasPlatformBrandIcon } from '@/components/PlatformBrandIcon';

/** Fixed presentation order. Anything not listed here follows, alphabetically. */
const PLATFORM_ORDER = ['whatsapp', 'telegram', 'facebook', 'website', 'email'];

/** English-only copy for this page (deliberately outside the i18n catalog). */
const COPY = {
  title: 'Contact Us',
  introFallback: 'We are here to help. Use any channel below to reach the MedAcademy team.',
  open: 'Open',
  emptyTitle: 'No contact methods configured yet',
  emptyBody: 'The administrator has not published any contact channel. Please try again later.',
  errorTitle: 'Unable to load Contact Us',
  errorBody: 'We could not load the contact methods. Check your connection and try again.',
  retry: 'Retry',
  retryA11y: 'Retry loading contact methods',
  unknownDesc: 'Contact us through this channel.',
};

/**
 * Which platform a stored row actually points at.
 *
 * The destination is ground truth for BOTH the name and the logo: the live
 * `contact_links` rows carry `platform:'facebook'` for WhatsApp and Telegram
 * destinations, which is why the page previously showed one name three times.
 */
const PLATFORM_HOSTS: { platform: string; hosts: string[] }[] = [
  { platform: 'whatsapp',  hosts: ['wa.me', 'api.whatsapp.com', 'whatsapp.com'] },
  { platform: 'telegram',  hosts: ['t.me', 'telegram.me', 'telegram.org'] },
  { platform: 'instagram', hosts: ['instagram.com', 'instagr.am'] },
  { platform: 'facebook',  hosts: ['facebook.com', 'fb.com', 'fb.me'] },
  { platform: 'x',         hosts: ['x.com', 'twitter.com'] },
];

function effectivePlatform(storedPlatform: string, href: string): string {
  // mailto:/tel: always win — a host parse on those returns nothing useful.
  if (/^mailto:/i.test(href)) return 'email';
  if (/^tel:/i.test(href)) return 'phone';
  let host = '';
  try { host = new URL(href).hostname.toLowerCase(); } catch { return storedPlatform; }
  const match = PLATFORM_HOSTS.find((entry) =>
    entry.hosts.some((h) => host === h || host.endsWith(`.${h}`)),
  );
  return match ? match.platform : storedPlatform;
}

/** sort index for the fixed order (unknown platforms after the known ones). */
function orderIndex(platform: string): number {
  const i = PLATFORM_ORDER.indexOf(platform);
  return i === -1 ? PLATFORM_ORDER.length : i;
}

// ── Contact channel definition ────────────────────────────────────────────────
type ContactItem = {
  /** Stable platform key (registry id) — selects the label/logo registry. */
  platform: string;
  /** Unique identity of THIS row (platform + destination) — the React key. */
  key: string;
  /** Registry label (English), never the stale stored label. */
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

  const def = platformDef(item.platform);
  const Icon = platformIcon(item.platform);
  const hasBrand = hasPlatformBrandIcon(item.platform);
  const iconTint = hasBrand ? brandIconTint(item.platform, isDark, c.text) : def.color;
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

          {/* Platform icon badge — brand mark when one exists, line icon otherwise */}
          <View style={{
            width: iconSz, height: iconSz,
            borderRadius: layout.heroIconRadius / 1.5,
            backgroundColor: `${iconTint}15`,
            alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            {hasBrand
              ? <PlatformBrandIcon platform={item.platform} size={iconInner} tint={iconTint} />
              : <Icon size={iconInner} color={def.color} />}
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
            <Text style={{ fontSize: layout.captionSize, fontWeight: '700', color: def.color }}>{COPY.open}</Text>
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

  const { branding, status: brandingStatus, refresh } = useBranding();
  const [retrying, setRetrying] = useState(false);

  const intro = useCmsSections('contact_us', []);
  const heroEntrance = useEntranceAnim({ offsetY: 12, duration: 460 });

  // The CMS intro is admin-authored content; it is shown as configured, with the
  // built-in English fallback when the admin left it empty.
  const cmsIntro = intro
    .map((section) => (section.heading !== '' ? `${section.heading}: ${section.body}` : section.body).trim())
    .filter((part) => part !== '')
    .join('\n');
  const introText = cmsIntro !== '' ? cmsIntro : COPY.introFallback;

  /**
   * Build the channel list.
   *
   * One row per PLATFORM (the product asks for exactly one entry per method):
   * the first enabled, safe destination for a platform wins, so a repeated
   * Facebook row cannot appear twice. Name and logo both come from the
   * effective platform, which is resolved from the destination.
   */
  const byPlatform = new Map<string, ContactItem>();
  const b = branding as unknown as Record<string, unknown>;

  const addRow = (storedPlatform: string, href: string) => {
    if (!isSafeContactHref(href)) return false; // malformed/dangerous URL → never rendered
    const platform = effectivePlatform(storedPlatform, href);
    if (byPlatform.has(platform)) return true;  // already configured — first one wins
    const def = platformDef(platform);
    byPlatform.set(platform, {
      platform,
      key: platform,
      label: def.label,
      description: def.description || COPY.unknownDesc,
      onPress: () => {
        const safe = contactLinkHref({ platform: storedPlatform, label: '', url: href, enabled: true });
        if (!isSafeContactHref(safe)) return;
        void Linking.openURL(safe).catch(() => {});
      },
    });
    return true;
  };

  // 1) Admin-configured links (order is imposed later, not taken from storage).
  for (const link of parseContactLinks(b?.contact_links).filter((l) => l.enabled)) {
    addRow(link.platform, contactLinkHref(link));
  }

  // 2) Legacy branding channels — only for platforms not already configured, so
  //    nothing is shown twice. Legacy DB values are never deleted.
  if (typeof b?.contact_email === 'string' && b.contact_email !== '') {
    addRow('email', `mailto:${String(b.contact_email)}`);
  }
  if (typeof b?.contact_phone === 'string' && b.contact_phone !== '') {
    addRow('phone', `tel:${String(b.contact_phone)}`);
  }
  if (typeof b?.whatsapp_url === 'string' && b.whatsapp_url !== '') {
    const raw = String(b.whatsapp_url);
    addRow('whatsapp', /^https?:\/\//i.test(raw) ? raw : `https://wa.me/${raw.replace(/\D/g, '')}`);
  }
  if (typeof b?.telegram_url === 'string' && b.telegram_url !== '') {
    const raw = String(b.telegram_url);
    addRow('telegram', /^https?:\/\//i.test(raw) ? raw : `https://t.me/${raw.replace('@', '')}`);
  }
  if (typeof b?.website_url === 'string' && b.website_url !== '') {
    addRow('website', String(b.website_url));
  }

  // Fixed presentation order: WhatsApp, Telegram, Facebook, Website, Email, then
  // any other configured platform (Instagram, X, Phone …).
  const contacts = Array.from(byPlatform.values()).sort((a, z) => {
    const d = orderIndex(a.platform) - orderIndex(z.platform);
    return d !== 0 ? d : a.platform.localeCompare(z.platform);
  });

  const heroIconSz = layout.heroIconSize * 1.1;

  const runRetry = () => {
    setRetrying(true);
    refresh();
    setTimeout(() => setRetrying(false), 400);
  };

  const loaded = brandingStatus === 'ok';

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <PageHeader title={COPY.title} showBack />
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
            {COPY.errorTitle}
          </Text>
          <Text style={{ fontSize: layout.captionSize, ...mutedTextStyle(c, 0.5), textAlign: 'center' }}>
            {COPY.errorBody}
          </Text>
          <Pressable
            onPress={runRetry}
            disabled={retrying}
            accessibilityRole="button"
            accessibilityLabel={COPY.retryA11y}
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
              {COPY.retry}
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
            <View style={{ marginBottom: layout.pad.lg }}>
              <BrandHeaderLogo remoteUrl={(b?.logo_url as string) || undefined} size={layout.touchTarget * 1.6} />
            </View>

            <Text style={{ fontSize: layout.titleSize * 0.85, fontWeight: '800', color: c.text, marginBottom: layout.pad.sm }}>
              {COPY.title}
            </Text>

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
              <HeartHandshake size={heroIconSz} color={c.primary} opacity={0.22} />
              <Text style={{ fontSize: layout.bodySize + 1, fontWeight: '700', ...mutedTextStyle(c, 0.5), textAlign: 'center' }}>
                {COPY.emptyTitle}
              </Text>
              <Text style={{ fontSize: layout.captionSize, ...mutedTextStyle(c, 0.35), textAlign: 'center' }}>
                {COPY.emptyBody}
              </Text>
            </NeuCard>
          ) : (
            <View style={{ gap: layout.itemGap }}>
              {contacts.map((item) => (
                <ContactCard key={item.key} item={item} />
              ))}
            </View>
          )}
        </>
      )}
    </ScrollView>
    </View>
  );
}
