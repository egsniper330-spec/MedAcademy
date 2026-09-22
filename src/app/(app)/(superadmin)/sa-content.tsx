/**
 * sa-content.tsx — Super Admin Content & Media hub.
 *
 * Groups every content/media destination behind ONE landing page:
 * Courses, Video Library, Watermark/DRM, Providers, Monitor, Health,
 * Video Settings, Storage, CMS, Branding. Each card navigates to the
 * EXISTING screen — no feature is re-implemented or duplicated here.
 */
import { useState } from 'react';
import { ScrollView, View, Text, Pressable, useColorScheme } from 'react-native';
import { useRouter } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import {
  BookOpen, Video, Eye, Layers, MonitorDot, HeartPulse,
  Settings, HardDrive, FileText, Paintbrush, ChevronRight,
} from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { neuColors, neuFlatStyle, neuPressedStyle, useLayout, safeBottom } from '@/lib/neu';
import Bell from '@/components/Bell';

function NavItem({
  icon: Icon, label, description, color, path, isDark, c,
}: {
  icon: React.ElementType; label: string; description: string;
  color: string; path: string; isDark: boolean; c: typeof neuColors.light;
}) {
  const router = useRouter();
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onPress={() => router.push(path as RelativePathString)}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={[
        pressed ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
        { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, marginBottom: 10 },
      ]}>
        <View style={{
          width: 42, height: 42, borderRadius: 13, backgroundColor: `${color}18`,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={20} color={color} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: 15, fontWeight: '800', color: c.text }} numberOfLines={1}>{label}</Text>
          <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 2 }} numberOfLines={2}>{description}</Text>
        </View>
        <ChevronRight size={18} color={`${c.text}33`} />
      </View>
    </Pressable>
  );
}

function SectionLabel({ title, c }: { title: string; c: typeof neuColors.light }) {
  return (
    <Text style={{ fontSize: 11, fontWeight: '800', color: c.text, opacity: 0.38, textTransform: 'uppercase', letterSpacing: 1.4, marginBottom: 10, marginTop: 18 }}>
      {title}
    </Text>
  );
}

export default function SAContentHub() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }} contentContainerStyle={{ paddingBottom: safeBottom(layout.insets.bottom) }}>
      <PageHeader title="Content & Media" subtitle="Courses, videos, DRM & storage" accentColor="#7C3AED" rightAction={<Bell />} />

      <View style={{ paddingHorizontal: layout.screenPx, paddingBottom: 32 }}>
        <SectionLabel title="Courses & Content" c={c} />
        <NavItem icon={BookOpen}  label="Courses"           description="All courses, status & search"            color="#7C3AED" path="/sa-courses"        c={c} isDark={isDark} />
        <NavItem icon={FileText}  label="CMS Pages"         description="Static content and landing pages"        color="#16A34A" path="/sa-cms"            c={c} isDark={isDark} />
        <NavItem icon={Paintbrush} label="Branding"         description="Logo, colours, platform identity"        color="#7C3AED" path="/branding"          c={c} isDark={isDark} />

        <SectionLabel title="Video Library & Delivery" c={c} />
        <NavItem icon={Video}     label="Video Library"     description="Manage uploaded videos"                  color="#7C3AED" path="/sa-video-library"  c={c} isDark={isDark} />
        <NavItem icon={Layers}    label="Video Providers"   description="CDN and video platform settings"         color="#2DA8FF" path="/video-providers"   c={c} isDark={isDark} />
        <NavItem icon={Settings}  label="Video Settings"    description="Player config, quality & encoding"       color="#6B7280" path="/sa-video-settings" c={c} isDark={isDark} />

        <SectionLabel title="Health & Protection" c={c} />
        <NavItem icon={MonitorDot} label="Video Monitor"    description="Live video health & delivery status"     color="#2DA8FF" path="/sa-video-monitor"  c={c} isDark={isDark} />
        <NavItem icon={HeartPulse} label="Video Health"     description="Processing errors & quality checks"      color="#16A34A" path="/sa-video-health"   c={c} isDark={isDark} />
        <NavItem icon={Eye}        label="Watermark / DRM"  description="Screenshot & recording prevention"       color="#DC2626" path="/content-protection" c={c} isDark={isDark} />
        <NavItem icon={HardDrive}  label="Storage"          description="Bucket usage, cleanup & monitoring"      color="#2DA8FF" path="/sa-storage"        c={c} isDark={isDark} />
      </View>
    </ScrollView>
  );
}
