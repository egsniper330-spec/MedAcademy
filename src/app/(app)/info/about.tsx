/**
 * About Us — static info page + build verification marker
 */
import { useEffect, useRef } from 'react';
import { ScrollView, View, Text, useColorScheme, Animated } from 'react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { BrandLogo } from '@/components/BrandLogo';
import { neuColors, useLayout, safeBottom } from '@/lib/neu';
import { useEntranceAnim } from '@/lib/motion';
import { Stethoscope, BookOpen, ShieldCheck, Zap, FlaskConical } from 'lucide-react-native';
import { BUILD_ID, BUILD_VERSION_NAME, BUILD_VERSION_CODE, BUILD_APP_NAME, BUILD_TIMESTAMP } from '@/lib/buildMarker';

const PILLARS = [
  { icon: BookOpen,     color: '#7C3AED', label: 'Expert-Led Content',     desc: 'Courses crafted by verified medical professionals with real clinical experience.' },
  { icon: ShieldCheck,  color: '#16A34A', label: 'Secure Learning',        desc: 'Forensic watermarking and device enforcement protect every student and instructor.' },
  { icon: Stethoscope,  color: '#2DA8FF', label: 'Clinical Focus',         desc: 'Curated for medical students — from anatomy to clinical rotations and beyond.' },
  { icon: Zap,          color: '#D97706', label: 'Always Accessible',      desc: 'Mobile-first design so you can study anywhere — on the ward, at home, or on the go.' },
];

export default function AboutPage() {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  const entrance = useEntranceAnim({ delay: 80, offsetY: 18, duration: 550 });

  const ringOuter = isDark ? 'rgba(4,10,22,0.70)'   : 'rgba(160,185,215,0.75)';
  const ringInner = isDark ? 'rgba(30,60,110,0.38)' : 'rgba(255,255,255,0.88)';

  // Fluid ring dimensions derived entirely from layout token
  const ringSize  = layout.heroIconSize * 1.6;
  const innerSize = ringSize * 0.86;
  const logoSize  = Math.round(ringSize * 0.52);
  const pillarIconSz = layout.touchTarget;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      contentContainerStyle={{ padding: layout.screenPx, paddingBottom: layout.scrollBottom() }}
    >
      <PageHeader title="About Us" showBack />

      {/* ── Build Verification Banner ──────────────────────────────────────── */}
      <NeuCard
        radius={layout.cardRadius}
        style={{
          padding: layout.cardPx,
          marginBottom: layout.sectionGap,
          borderWidth: 1.5,
          borderColor: '#D97706',
          backgroundColor: isDark ? 'rgba(217,119,6,0.10)' : 'rgba(255,237,213,0.85)',
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: layout.pad.sm, marginBottom: layout.pad.md }}>
          <FlaskConical size={layout.bodySize + 2} color="#D97706" />
          <Text style={{ fontSize: layout.captionSize, fontWeight: '800', color: '#D97706', textTransform: 'uppercase', letterSpacing: 1.2 }}>
            Build Verification Marker
          </Text>
        </View>
        {[
          ['BUILD_ID',      BUILD_ID],
          ['Version Name',  BUILD_VERSION_NAME],
          ['Version Code',  String(BUILD_VERSION_CODE)],
          ['App Name',      BUILD_APP_NAME],
          ['Build Date',    BUILD_TIMESTAMP],
        ].map(([label, value]) => (
          <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
            <Text style={{ fontSize: layout.captionSize, color: c.text, opacity: 0.55, fontWeight: '600', flex: 1 }}>{label}</Text>
            <Text style={{ fontSize: layout.captionSize, color: '#D97706', fontWeight: '700', flex: 2, textAlign: 'right' }} selectable>
              {value}
            </Text>
          </View>
        ))}
        <Text style={{ fontSize: layout.captionSize - 1, color: c.text, opacity: 0.4, marginTop: layout.pad.sm, textAlign: 'center' }}>
          If this panel is absent from the APK, packaging used a stale snapshot.
        </Text>
      </NeuCard>

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
          About Us
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
          Empowering the next generation of medical professionals through world-class digital education.
        </Text>
      </Animated.View>

      {/* Mission */}
      <NeuCard radius={layout.cardRadius} style={{ padding: layout.cardPx, marginBottom: layout.sectionGap }}>
        <Text style={{ fontSize: layout.captionSize, fontWeight: '800', color: c.primary, marginBottom: layout.pad.sm, textTransform: 'uppercase', letterSpacing: 1 }}>
          Our Mission
        </Text>
        <Text style={{ fontSize: layout.bodySize + 1, color: c.text, opacity: 0.75, lineHeight: (layout.bodySize + 1) * 1.6 }}>
          MedAcademy was built to bridge the gap between medical theory and real-world clinical practice. We partner with leading doctors and specialists to deliver structured, high-quality, mobile-first courses that fit the demanding schedule of medical students.
        </Text>
      </NeuCard>

      {/* Pillars */}
      <Text style={{ fontSize: layout.captionSize, fontWeight: '700', color: c.text, opacity: 0.4, textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: layout.pad.md }}>
        What We Stand For
      </Text>
      <View style={{ gap: layout.itemGap, marginBottom: layout.sectionGap }}>
        {PILLARS.map((p) => (
          <NeuCard key={p.label} radius={layout.cardRadius} style={{ flexDirection: 'row', alignItems: 'center', padding: layout.cardPx, gap: layout.pad.md }}>
            <View style={{
              width: pillarIconSz, height: pillarIconSz,
              borderRadius: layout.heroIconRadius / 2,
              backgroundColor: `${p.color}15`,
              alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <p.icon size={Math.round(pillarIconSz * 0.5)} color={p.color} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: layout.bodySize, fontWeight: '700', color: c.text, marginBottom: 3 }}>{p.label}</Text>
              <Text style={{ fontSize: layout.captionSize, color: c.text, opacity: 0.55, lineHeight: layout.captionSize * 1.5 }}>{p.desc}</Text>
            </View>
          </NeuCard>
        ))}
      </View>

      {/* Footer note */}
      <NeuCard radius={layout.cardRadius} style={{ padding: layout.cardPx, alignItems: 'center' }}>
        <Text style={{ fontSize: layout.captionSize + 1, color: c.text, opacity: 0.5, textAlign: 'center', lineHeight: (layout.captionSize + 1) * 1.6 }}>
          MedAcademy is continuously evolving.{'\n'}Thank you for being part of our community.
        </Text>
      </NeuCard>
    </ScrollView>
  );
}
