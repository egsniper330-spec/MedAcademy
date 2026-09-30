/**
 * sa-reports.tsx — Super Admin Reports & Logs hub
 * Report/analytics/monitoring surfaces ONLY: reports, exports, analytics,
 * audit views, and security MONITORING. Platform-management/configuration
 * features (impersonation, security policies, trash/delete permissions,
 * bulk import, DB audit, violation management, security dashboard/
 * diagnostics) live canonically in the Platform hub (sa-platform.tsx) —
 * they are deliberately NOT duplicated here.
 */
import { useState } from 'react';
import { View, Text, ScrollView, Pressable, useColorScheme } from 'react-native';
import { useRouter } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import {
  FileText, Shield, BarChart2,
  Download, AlertTriangle, Eye, ChevronRight,
  TrendingUp, Activity,
} from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { neuColors, neuFlatStyle, neuPressedStyle, useLayout, safeBottom } from '@/lib/neu';
import Bell from '@/components/Bell';

// ── Nav item ───────────────────────────────────────────────────────────────
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

export default function SAReports() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }} contentContainerStyle={{ paddingBottom: safeBottom(layout.insets.bottom) }}>
      {/* PageHeader sits OUTSIDE the inner padding view so it can own its own horizontal padding */}
      <PageHeader title="Reports & Logs" subtitle="Audit, security & exports" accentColor="#7C3AED" rightAction={<Bell />} />

      <View style={{ paddingHorizontal: layout.screenPx }}>

        {/* ── Reports & Exports ────────────────────────────────────────── */}
        <SectionLabel title="Reports & Exports" c={c} />
        <NavItem icon={FileText}     label="Reports"              description="Platform activity and usage reports"       color="#7C3AED" path="/reports"                c={c} isDark={isDark} />
        <NavItem icon={Download}     label="Export Center"        description="Export any data as CSV / Excel"            color="#D97706" path="/export-panel"            c={c} isDark={isDark} />

        {/* ── Analytics ────────────────────────────────────────────────── */}
        <SectionLabel title="Analytics" c={c} />
        <NavItem icon={Activity}     label="Platform Analytics"   description="Full metrics & platform trends"            color="#16A34A" path="/sa-analytics"      c={c} isDark={isDark} />
        <NavItem icon={TrendingUp}   label="Credits"               description="Credit management & history"                color={c.primary} path="/sa-credits"    c={c} isDark={isDark} />
        <NavItem icon={BarChart2}    label="Revenue Analytics"    description="Revenue trends and breakdowns"              color="#2DA8FF" path="/revenue-analytics"     c={c} isDark={isDark} />

                {/* ── Audit Logs ────────────────────────────────────────────── */}
        <SectionLabel title="Audit Logs" c={c} />
        <NavItem icon={Shield}       label="Audit Trail"          description="Full admin action audit log"               color="#DC2626" path="/sa-audit"          c={c} isDark={isDark} badge="LIVE" />

        {/* ── Security Monitoring (read-only reporting surfaces) ───── */}
        {/* Configuration surfaces (security dashboard/policies/diag,   */}
        {/* violation management) are canonical in the Platform hub.    */}
        <SectionLabel title="Security Monitoring" c={c} />
        <NavItem icon={Eye}          label="Content Protection"   description="Screenshot & recording prevention"         color="#EF4444" path="/content-protection" c={c} isDark={isDark} />
        <NavItem icon={AlertTriangle} label="Fraud Alerts"        description="Suspicious activity detection"             color="#DC2626" path="/fraud-alerts"            c={c} isDark={isDark} />

<View style={{ height: 32 }} />
      </View>
    </ScrollView>
  );
}
