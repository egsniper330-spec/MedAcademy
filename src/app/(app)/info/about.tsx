/**
 * About Us — static info page
 */
import { ScrollView, View, Text, useColorScheme } from 'react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { BrandLogo } from '@/components/BrandLogo';
import { neuColors } from '@/lib/neu';
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

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 20, paddingBottom: 48 }}
    >
      <PageHeader title="About Us" showBack />

      {/* Hero */}
      <View style={{ alignItems: 'center', marginBottom: 28, marginTop: 4 }}>
          <BrandLogo variant="icon" size={100} />
        <Text style={{ fontSize: 13, color: c.text, opacity: 0.5, textAlign: 'center', marginTop: 8, lineHeight: 20, paddingHorizontal: 16 }}>
          Empowering the next generation of medical professionals through world-class digital education.
        </Text>
      </View>

      {/* Mission */}
      <NeuCard radius={20} style={{ padding: 20, marginBottom: 20 }}>
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
