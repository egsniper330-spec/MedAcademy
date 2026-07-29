/**
 * sa-platform.tsx — Super Admin Platform Management hub
 * ALL platform sub-pages exposed in logical groups with badges.
 * Nothing hidden. Every route is directly clickable from this screen.
 */
import { useState } from 'react';
import { View, Text, ScrollView, Pressable, useColorScheme } from 'react-native';
import { useRouter } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import {
  Flag, Paintbrush, Wrench, Settings, Layers, Video, Coins,
  GraduationCap, Smartphone, UserPlus, ChevronRight,
  Ticket, FileText, Megaphone, ShieldAlert, ShieldCheck,
  ShieldX, AlertOctagon, Trash2, Lock, Eye, HeartPulse,
  MonitorDot, HardDrive, Shield, UserCog, HeartHandshake,
  Upload, Database, SquareCode,
} from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { neuColors, neuFlatStyle, neuPressedStyle } from '@/lib/neu';
import Bell from '@/components/Bell';

// ── Nav item with neumorphic press ─────────────────────────────────────────
function NavItem({
  icon: Icon, label, description, color, path, badge, c, isDark,
}: {
  icon: React.ElementType; label: string; description: string;
  color: string; path: string; badge?: string;
  c: typeof neuColors.light; isDark: boolean;
}) {
  const router = useRouter();
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onPress={() => router.push(path as RelativePathString)}
    >
      <View style={[
        pressed ? neuPressedStyle(isDark) : neuFlatStyle(isDark),
        { borderRadius: 16, marginBottom: 10, padding: 15, flexDirection: 'row', alignItems: 'center' },
      ]}>
        <View style={{ width: 44, height: 44, borderRadius: 13, backgroundColor: `${color}1A`, alignItems: 'center', justifyContent: 'center', marginRight: 13 }}>
          <Icon size={20} color={color} />
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{label}</Text>
            {badge && (
              <View style={{ backgroundColor: `${color}22`, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 }}>
                <Text style={{ fontSize: 10, fontWeight: '800', color }}>{badge}</Text>
              </View>
            )}
          </View>
          <Text style={{ fontSize: 12, color: c.text, opacity: 0.48, marginTop: 2 }}>{description}</Text>
        </View>
        <ChevronRight size={15} color={`${c.text}35`} />
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

export default function SAPlatform() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }} contentInsetAdjustmentBehavior="automatic">
      <View style={{ padding: 20 }}>

        {/* ── Header ──────────────────────────────────────────────────── */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, marginTop: 8 }}>
          <PageHeader title="Platform" subtitle="All settings & integrations" accentColor="#6B7280" rightAction={<Bell />} />
        </View>

        {/* ── Appearance & Content ─────────────────────────────────────── */}
        <SectionLabel title="Appearance & Content" c={c} />
        <NavItem icon={Paintbrush}  label="Branding"           description="Logo, colours, platform identity"          color="#7C3AED" path="/(app)/(superadmin)/branding"           c={c} isDark={isDark} />
        <NavItem icon={FileText}    label="CMS Pages"          description="Static content and landing pages"          color="#16A34A" path="/(app)/(admin)/cms"                    c={c} isDark={isDark} />

        {/* ── Feature Control ──────────────────────────────────────────── */}
        <SectionLabel title="Feature Control" c={c} />
        <NavItem icon={Flag}        label="Feature Flags"      description="Toggle experimental features on/off"       color="#D97706" path="/(app)/(superadmin)/feature-flags"      c={c} isDark={isDark} badge="BETA" />
        <NavItem icon={Wrench}      label="Maintenance Mode"   description="Enable / disable platform maintenance"     color="#DC2626" path="/(app)/(superadmin)/maintenance"         c={c} isDark={isDark} />
        <NavItem icon={Settings}    label="System Config"      description="Global environment configuration"          color="#6B7280" path="/(app)/(superadmin)/config"              c={c} isDark={isDark} />

        {/* ── Integrations ─────────────────────────────────────────────── */}
        <SectionLabel title="Integrations" c={c} />
        <NavItem icon={Layers}      label="System Providers"   description="Payment, storage, email providers"        color="#059669" path="/(app)/(admin)/system-providers"         c={c} isDark={isDark} />
        <NavItem icon={Video}       label="Video Providers"    description="CDN and video platform settings"          color="#7C3AED" path="/(app)/(superadmin)/video-providers"     c={c} isDark={isDark} />
        <NavItem icon={Coins}       label="Currency Settings"  description="Platform default currency"                color="#D97706" path="/(app)/(superadmin)/currency"             c={c} isDark={isDark} />

        {/* ── Content Protection ───────────────────────────────────────── */}
        <SectionLabel title="Content Protection" c={c} />
        <NavItem icon={Eye}         label="Watermark / DRM"    description="Screenshot & recording prevention"        color="#DC2626" path="/(app)/(superadmin)/content-protection"  c={c} isDark={isDark} badge="DRM" />
        <NavItem icon={MonitorDot}  label="Video Monitor"      description="Live video health & delivery status"      color="#2DA8FF" path="/(app)/(admin)/video-monitor"             c={c} isDark={isDark} />
        <NavItem icon={HeartPulse}  label="Video Health"       description="Processing errors & quality checks"       color="#16A34A" path="/(app)/(admin)/video-health"              c={c} isDark={isDark} />
        <NavItem icon={Settings}    label="Video Settings"     description="Player config, quality & encoding"        color="#6B7280" path="/(app)/(admin)/video-settings"            c={c} isDark={isDark} />
        <NavItem icon={HardDrive}   label="Storage"            description="Bucket usage, cleanup & monitoring"       color="#2DA8FF" path="/(app)/(admin)/storage"                  c={c} isDark={isDark} />

        {/* ── Security ─────────────────────────────────────────────────── */}
        <SectionLabel title="Security" c={c} />
        <NavItem icon={ShieldAlert} label="Security Dashboard"  description="Login attempts, threats & alerts"        color="#EF4444" path="/(app)/(superadmin)/sec-dashboard"       c={c} isDark={isDark} />
        <NavItem icon={ShieldCheck} label="Security Policies"   description="Rate limits and access control rules"    color="#DC2626" path="/(app)/(superadmin)/sec-policies"        c={c} isDark={isDark} />
        <NavItem icon={ShieldX}     label="Security Diagnostics" description="Detailed security event logs"          color="#9B1C1C" path="/(app)/(superadmin)/sec-diag"            c={c} isDark={isDark} />
        <NavItem icon={AlertOctagon} label="Violation Management" description="Policy violations and offences"       color="#D97706" path="/(app)/(superadmin)/violation-management" c={c} isDark={isDark} />

        {/* ── User Management ──────────────────────────────────────────── */}
        <SectionLabel title="User Management" c={c} />
        <NavItem icon={UserCog}       label="Admin Management"  description="Super-admin and admin accounts"          color="#EF4444" path="/(app)/(superadmin)/sa-users"              c={c} isDark={isDark} />
        <NavItem icon={HeartHandshake} label="Impersonation"   description="Log in as any user for debugging"        color="#2DA8FF" path="/(app)/(superadmin)/impersonation"       c={c} isDark={isDark} />
        <NavItem icon={Smartphone}    label="Device Management" description="User device limits & revocation"        color="#16A34A" path="/(app)/(admin)/devices"                  c={c} isDark={isDark} />

        {/* ── Academic & Operations ────────────────────────────────────── */}
        <SectionLabel title="Academic & Operations" c={c} />
        <NavItem icon={GraduationCap} label="Academic Structure" description="Universities, faculties, levels"        color="#2DA8FF" path="/(app)/(admin)/academic"                c={c} isDark={isDark} />
        <NavItem icon={UserPlus}      label="Enrollment Manager" description="Manual course enrollments"             color="#0EA5E9" path="/(app)/(admin)/enrollment-manager"       c={c} isDark={isDark} />
        <NavItem icon={Ticket}        label="Activation Codes"   description="Generate & manage course codes"        color="#D97706" path="/(app)/(admin)/codes"                    c={c} isDark={isDark} />
        <NavItem icon={Megaphone}     label="Notifications"      description="Broadcast & send platform messages"    color="#D97706" path="/(app)/(admin)/notifications-center"     c={c} isDark={isDark} />
        <NavItem icon={Upload}        label="Bulk Import"        description="Import users and course data"          color="#16A34A" path="/(app)/(admin)/bulk-import"              c={c} isDark={isDark} />
        <NavItem icon={Database}      label="DB Audit"           description="Low-level database audit trail"        color="#D97706" path="/(app)/(admin)/db-audit"                c={c} isDark={isDark} />

        {/* ── Cleanup ──────────────────────────────────────────────────── */}
        <SectionLabel title="Cleanup & Permissions" c={c} />
        <NavItem icon={Trash2}        label="Trash Bin"          description="Restore or permanently delete items"   color="#DC2626" path="/(app)/(superadmin)/trash-bin"           c={c} isDark={isDark} />
        <NavItem icon={Lock}          label="Delete Permissions" description="Control what data can be deleted"      color="#9B1C1C" path="/(app)/(superadmin)/delete-permissions"   c={c} isDark={isDark} />

        <View style={{ height: 32 }} />
      </View>
    </ScrollView>
  );
}
