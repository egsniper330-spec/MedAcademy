/**
 * About Us — static info page (hero, mission, CMS copy, pillars, footer).
 *
 * NOTE: no build/debug marker is rendered here — internal build metadata
 * (expo version/versionCode/buildNumber) stays available to update,
 * diagnostics and integrity systems but is never shown to end users.
 */
import { useMemo } from 'react';
import { ScrollView, View, Text, Pressable, Linking, useColorScheme, Animated } from 'react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { useCmsSections } from '@/lib/cmsContent';
import { BrandLogo } from '@/components/BrandLogo';
import { neuColors, useLayout, mutedTextStyle } from '@/lib/neu';
import { useEntranceAnim } from '@/lib/motion';
import { Stethoscope, BookOpen, ShieldCheck, Zap } from 'lucide-react-native';
import {
  contactLinkHref, isSafeContactHref, parseContactLinks, platformIcon, useBranding,
} from '@/lib/branding';
import { PlatformBrandIcon, hasPlatformBrandIcon } from '@/components/PlatformBrandIcon';
import { useTranslation } from '@/lib/i18n';

/**
 * Logo = the platform the DESTINATION belongs to, not the raw stored key.
 * Admin-saved rows have carried a stale `platform` (e.g. three different social
 * links all stored as `facebook`), and a WhatsApp link must never wear the
 * Facebook mark. The stored label and URL are never rewritten.
 */
const PLATFORM_HOSTS: { platform: string; hosts: string[] }[] = [
  { platform: 'whatsapp',  hosts: ['wa.me', 'api.whatsapp.com', 'whatsapp.com'] },
  { platform: 'telegram',  hosts: ['t.me', 'telegram.me', 'telegram.org'] },
  { platform: 'instagram', hosts: ['instagram.com', 'instagr.am'] },
  { platform: 'facebook',  hosts: ['facebook.com', 'fb.com', 'fb.me'] },
  { platform: 'x',         hosts: ['x.com', 'twitter.com'] },
];

function platformForDestination(stored: string, href: string): string {
  let host = '';
  try { host = new URL(href).hostname.toLowerCase(); } catch { return stored; }
  const match = PLATFORM_HOSTS.find((entry) =>
    entry.hosts.some((h) => host === h || host.endsWith(`.${h}`)),
  );
  return match ? match.platform : stored;
}

// Labels/descriptions are translation keys: the page follows the app language
// (this copy used to be hardcoded English inside the JSX).
const PILLARS = [
  { icon: BookOpen,     color: '#7C3AED', titleKey: 'about.pillar1Title', bodyKey: 'about.pillar1Body' },
  { icon: ShieldCheck,  color: '#16A34A', titleKey: 'about.pillar2Title', bodyKey: 'about.pillar2Body' },
  { icon: Stethoscope,  color: '#2DA8FF', titleKey: 'about.pillar3Title', bodyKey: 'about.pillar3Body' },
  { icon: Zap,          color: '#D97706', titleKey: 'about.pillar4Title', bodyKey: 'about.pillar4Body' },
];

export default function AboutPage() {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  const layout = useLayout();
  const { t } = useTranslation();
  const { branding } = useBranding(); // server-managed display name (fails safe)

  /** Every enabled configured link, as its own row (keyed by destination). */
  const socialLinks = useMemo(() => {
    const parsed = parseContactLinks((branding as { contact_links?: unknown }).contact_links).filter((l) => l.enabled);
    const seen = new Set<string>();
    const rows: { key: string; platform: string; label: string; href: string }[] = [];
    for (const link of parsed) {
      const href = contactLinkHref(link);
      if (!isSafeContactHref(href)) continue; // unusable destination is never shown
      const destination = href.trim().toLowerCase().replace(/\/+$/, '');
      if (seen.has(destination)) continue; // same URL twice = one row
      seen.add(destination);
      const platform = platformForDestination(link.platform, href);
      rows.push({ key: `${platform}:${destination}`, platform, label: link.label, href });
    }
    return rows;
  }, [branding]);

  // Optional server-managed About text (Super Admin → Platform → CMS Pages).
  // Empty body → nothing extra is rendered and the bundled copy stands alone.
  const aboutSections = useCmsSections('about_us', []);

  const entrance = useEntranceAnim({ delay: 80, offsetY: 18, duration: 550 });

  const ringOuter = isDark ? 'rgba(4,10,22,0.70)'   : 'rgba(160,185,215,0.75)';
  const ringInner = isDark ? 'rgba(30,60,110,0.38)' : 'rgba(255,255,255,0.88)';

  // Fluid ring dimensions derived entirely from layout token
  const ringSize  = layout.heroIconSize * 1.6;
  const innerSize = ringSize * 0.86;
  const logoSize  = Math.round(ringSize * 0.52);
  const pillarIconSz = layout.touchTarget;

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <PageHeader title={t('about.title')} showBack />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: layout.screenPx }}
      >

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <Animated.View
        style={{
          alignItems: 'center',
          marginBottom: layout.sectionGap,
          marginTop: layout.pad.sm,
          ...entrance.style,
        }}
      >
        {/* Outer neumorphic ring */}
        <View
          style={{
            width: ringSize,
            height: ringSize,
            borderRadius: ringSize / 2,
            backgroundColor: c.base,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: layout.pad.xl,
            shadowColor: ringOuter,
            shadowOffset: { width: 6, height: 6 },
            shadowOpacity: 1,
            shadowRadius: 18,
            elevation: 8,
          }}
        >
          {/* Inner highlight ring */}
          <View
            style={{
              width: innerSize,
              height: innerSize,
              borderRadius: innerSize / 2,
              backgroundColor: c.base,
              alignItems: 'center',
              justifyContent: 'center',
              shadowColor: ringInner,
              shadowOffset: { width: -5, height: -5 },
              shadowOpacity: 1,
              shadowRadius: 14,
              elevation: 0,
            }}
          >
            <BrandLogo variant="monogram" size={logoSize} />
          </View>
        </View>

        <Text
          style={{
            fontSize: layout.titleSize,
            fontWeight: '800',
            color: c.text,
            letterSpacing: -0.4,
            textAlign: 'center',
            marginBottom: layout.pad.sm,
          }}
        >
          {t('about.title')}
        </Text>

        {/* Accent divider */}
        <View
          style={{
            width: layout.pad.xxl,
            height: 3,
            borderRadius: 2,
            backgroundColor: c.primary,
            marginBottom: layout.pad.md,
            opacity: 0.7,
          }}
        />

        <Text
          style={{
            fontSize: layout.bodySize,
            color: c.text,
            opacity: isDark ? 0.55 : 0.6,
            textAlign: 'center',
            lineHeight: layout.bodySize * 1.6,
            paddingHorizontal: layout.screenPx,
          }}
        >
          {t('about.tagline')}
        </Text>
      </Animated.View>

      {/* Mission */}
      <NeuCard radius={layout.cardRadius} style={{ padding: layout.cardPx, marginBottom: layout.sectionGap }}>
        <Text style={{ fontSize: layout.captionSize, fontWeight: '800', color: c.primary, marginBottom: layout.pad.sm, textTransform: 'uppercase', letterSpacing: 1 }}>
          {t('about.missionTitle')}
        </Text>
        <Text style={{ fontSize: layout.bodySize + 1, color: c.text, opacity: 0.75, lineHeight: (layout.bodySize + 1) * 1.6 }}>
          {t('about.missionBody', { app: branding.app_name })}
        </Text>
      </NeuCard>

      {/* Server-managed About text — rendered only when a body exists, so the
          screen never depends on CMS availability. Plain text only. */}
      {aboutSections.length > 0 && (
        <NeuCard radius={layout.cardRadius} style={{ padding: layout.cardPx, marginBottom: layout.sectionGap }}>
          {aboutSections.map((section, i) => (
            <View key={i} style={{ marginBottom: i === aboutSections.length - 1 ? 0 : layout.pad.md }}>
              {section.heading !== '' && (
                <Text style={{ fontSize: layout.captionSize, fontWeight: '800', color: c.primary, marginBottom: layout.pad.sm, textTransform: 'uppercase', letterSpacing: 1 }}>
                  {section.heading}
                </Text>
              )}
              {section.body !== '' && (
                <Text style={{ fontSize: layout.bodySize, color: c.text, opacity: 0.7, lineHeight: layout.bodySize * 1.6 }}>
                  {section.body}
                </Text>
              )}
            </View>
          ))}
        </NeuCard>
      )}

      {/* Pillars */}
      <Text style={{ fontSize: layout.captionSize, fontWeight: '700', ...mutedTextStyle(c, 0.4), textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: layout.pad.md }}>
        {t('about.standFor')}
      </Text>
      <View style={{ gap: layout.itemGap, marginBottom: layout.sectionGap }}>
        {PILLARS.map((p) => (
          <NeuCard key={p.titleKey} radius={layout.cardRadius} style={{ flexDirection: 'row', alignItems: 'center', padding: layout.cardPx, gap: layout.pad.md }}>
            <View style={{
              width: pillarIconSz, height: pillarIconSz,
              borderRadius: layout.heroIconRadius / 2,
              backgroundColor: `${p.color}15`,
              alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <p.icon size={Math.round(pillarIconSz * 0.5)} color={p.color} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: layout.bodySize, fontWeight: '700', color: c.text, marginBottom: 3 }}>{t(p.titleKey)}</Text>
              <Text style={{ fontSize: layout.captionSize, ...mutedTextStyle(c, 0.55), lineHeight: layout.captionSize * 1.5 }}>{t(p.bodyKey)}</Text>
            </View>
          </NeuCard>
        ))}
      </View>

      {/* Configured social / contact links — one INDEPENDENT row per destination, read
          from app_branding.contact_links (the single source of truth). Nothing is
          hardcoded, merged, renamed or hidden, and duplicate detection is by URL, not by
          platform: two different platforms must never collapse into one row. */}
      {socialLinks.length > 0 && (
        <>
          <Text style={{ fontSize: layout.captionSize, fontWeight: '700', ...mutedTextStyle(c, 0.4), textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: layout.pad.md }}>
            {t('about.connect')}
          </Text>
          <View style={{ gap: layout.itemGap, marginBottom: layout.sectionGap }}>
            {socialLinks.map((item) => (
              <Pressable
                key={item.key}
                accessibilityRole="link"
                accessibilityLabel={item.label}
                onPress={() => { void Linking.openURL(item.href).catch(() => {}); }}
                style={({ pressed }) => ({
                  flexDirection: 'row', alignItems: 'center', gap: layout.pad.md,
                  paddingVertical: layout.pad.md, paddingHorizontal: layout.cardPx,
                  borderRadius: layout.cardRadius, backgroundColor: `${c.text}08`,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <View style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {hasPlatformBrandIcon(item.platform)
                    ? <PlatformBrandIcon platform={item.platform} size={22} accessibilityLabel={item.label} />
                    : (() => { const Icon = platformIcon(item.platform); return <Icon size={20} color={c.text} />; })()}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: layout.bodySize, fontWeight: '700', color: c.text }}>{item.label}</Text>
                  <Text style={{ fontSize: layout.captionSize, ...mutedTextStyle(c, 0.5) }} numberOfLines={1}>{item.href}</Text>
                </View>
              </Pressable>
            ))}
          </View>
        </>
      )}

      {/* Footer note */}
      <NeuCard radius={layout.cardRadius} style={{ padding: layout.cardPx, alignItems: 'center' }}>
        <Text style={{ fontSize: layout.captionSize + 1, ...mutedTextStyle(c, 0.5), textAlign: 'center', lineHeight: (layout.captionSize + 1) * 1.6 }}>
          {t('about.footer', { app: branding.app_name })}
        </Text>
      </NeuCard>
    </ScrollView>
    </View>
  );
}
