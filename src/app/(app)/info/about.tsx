/**
 * About Us — static info page
 */
import { useEffect, useRef } from 'react';
import { ScrollView, View, Text, useColorScheme, Animated } from 'react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { BrandLogo } from '@/components/BrandLogo';
import { neuColors, useLayout, safeBottom } from '@/lib/neu';
import { useEntranceAnim } from '@/lib/motion';
import { Stethoscope, BookOpen, ShieldCheck, Zap } from 'lucide-react-native';

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
  const insets = layout.insets;

  // Fade-in animation for hero section
  const entrance = useEntranceAnim({ delay: 80, offsetY: 18, duration: 550 });


  // Neumorphic glow ring colours — adapt to light/dark
  const ringOuter = isDark ? 'rgba(4,10,22,0.70)'      : 'rgba(160,185,215,0.75)';
  const ringInner = isDark ? 'rgba(30,60,110,0.38)'    : 'rgba(255,255,255,0.88)';

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: layout.screenPx, paddingBottom: layout.scrollBottom() }}
    >
      <PageHeader title="About Us" showBack />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <Animated.View
        style={{
          alignItems: 'center',
          marginBottom: 32,
          marginTop: 12,
          ...entrance.style,
        }}
      >
        {/* Neumorphic glow ring — no square border, blends with page */}
        <View
          style={{
            width: 140,
            height: 140,
            borderRadius: 70,
            backgroundColor: c.base,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 24,
            // outer shadow (dark side)
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
              width: 120,
              height: 120,
              borderRadius: 60,
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
            {/* Monogram — transparent, no navy square bg */}
            <BrandLogo variant="monogram" size={72} />
          </View>
        </View>

        {/* About Us heading */}
        <Text
          style={{
            fontSize: 28,
            fontWeight: '800',
            color: c.text,
            letterSpacing: -0.4,
            textAlign: 'center',
            marginBottom: 10,
          }}
        >
          About Us
        </Text>

        {/* Accent divider */}
        <View
          style={{
            width: 44,
            height: 3,
            borderRadius: 2,
            backgroundColor: c.primary,
            marginBottom: 14,
            opacity: 0.7,
          }}
        />

        {/* Mission subtitle */}
        <Text
          style={{
            fontSize: 14,
            color: c.text,
            opacity: isDark ? 0.55 : 0.6,
            textAlign: 'center',
            lineHeight: 22,
            paddingHorizontal: 24,
          }}
        >
          Empowering the next generation of medical professionals through world-class digital education.
        </Text>
      </Animated.View>

      {/* Mission */}
      <NeuCard radius={20} style={{ padding: layout.screenPx, marginBottom: 20 }}>
        <Text style={{ fontSize: 13, fontWeight: '800', color: c.primary, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
          Our Mission
        </Text>
        <Text style={{ fontSize: 15, color: c.text, opacity: 0.75, lineHeight: 24 }}>
          MedAcademy was built to bridge the gap between medical theory and real-world clinical practice. We partner with leading doctors and specialists to deliver structured, high-quality, mobile-first courses that fit the demanding schedule of medical students.
        </Text>
      </NeuCard>

      {/* Pillars */}
      <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.4, textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 12 }}>
        What We Stand For
      </Text>
      <View style={{ gap: 12, marginBottom: 20 }}>
        {PILLARS.map((p) => (
          <NeuCard key={p.label} radius={16} style={{ flexDirection: 'row', alignItems: 'center', padding: 16, gap: 14 }}>
            <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: `${p.color}15`, alignItems: 'center', justifyContent: 'center' }}>
              <p.icon size={22} color={p.color} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: c.text, marginBottom: 3 }}>{p.label}</Text>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.55, lineHeight: 18 }}>{p.desc}</Text>
            </View>
          </NeuCard>
        ))}
      </View>

      {/* Footer note */}
      <NeuCard radius={16} style={{ padding: 16, alignItems: 'center' }}>
        <Text style={{ fontSize: 13, color: c.text, opacity: 0.5, textAlign: 'center', lineHeight: 20 }}>
          MedAcademy is continuously evolving.{'\n'}Thank you for being part of our community.
        </Text>
      </NeuCard>
    </ScrollView>
  );
}
