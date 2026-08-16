/**
 * sa-reports.tsx — Super Admin Reports & Logs hub
 * ALL monitoring, security, audit and admin-tool sub-pages exposed.
 * Nothing hidden — every route directly accessible.
 */
import { useState } from 'react';
import { View, Text, ScrollView, Pressable, useColorScheme } from 'react-native';
import { useRouter } from 'expo-router';
import type { RelativePathString } from 'expo-router';
import {
  FileText, Shield, ShieldAlert, ShieldCheck, ShieldX, BarChart2,
  Upload, Download, Search, HeartHandshake, Trash2, Lock,
  AlertOctagon, AlertTriangle, Eye, Database, ChevronRight,
  TrendingUp, ClipboardList, Activity,
} from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { neuColors, neuFlatStyle, neuPressedStyle, useLayout } from '@/lib/neu';
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
    <ScrollView style={{ flex: 1, backgroundColor: c.base }}>
      <View style={{ padding: layout.screenPx }}>

        {/* ── Header ──────────────────────────────────────────────────── */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, marginTop: 8 }}>
          <PageHeader title="Reports & Logs" subtitle="Audit, security & exports" accentColor="#7C3AED" rightAction={<Bell />} />
        </View>

        {/* ── Reports & Exports ────────────────────────────────────────── */}
        <SectionLabel title="Reports & Exports" c={c} />
        <NavItem icon={FileText}     label="Reports"              description="Platform activity and usage reports"       color="#7C3AED" path="/(app)/(admin)/reports"                c={c} isDark={isDark} />
        <NavItem icon={Download}     label="Export Center"        description="Export any data as CSV / Excel"            color="#D97706" path="/(app)/(admin)/export-panel"            c={c} isDark={isDark} />
        <NavItem icon={Upload}       label="Bulk Import"          description="Import users and course data in bulk"      color="#0EA5E9" path="/(app)/(admin)/bulk-import"             c={c} isDark={isDark} />

        {/* ── Analytics ────────────────────────────────────────────────── */}
        <SectionLabel title="Analytics" c={c} />
        <NavItem icon={Activity}     label="Platform Analytics"   description="Full metrics & platform trends"            color="#16A34A" path="/(app)/(superadmin)/sa-analytics"      c={c} isDark={isDark} />
        <NavItem icon={TrendingUp}   label="Credits"               description="Credit management & history"                color={c.primary} path="/(app)/(superadmin)/sa-credits"    c={c} isDark={isDark} />
        <NavItem icon={BarChart2}    label="Revenue Analytics"    description="Revenue trends and breakdowns"              color="#2DA8FF" path="/(app)/(admin)/revenue-analytics"     c={c} isDark={isDark} />

        {/* ── Audit Logs ───────────────────────────────────────────────── */}
        <SectionLabel title="Audit Logs" c={c} />
        <NavItem icon={Shield}       label="Audit Trail"          description="Full admin action audit log"               color="#DC2626" path="/(app)/(superadmin)/sa-audit"          c={c} isDark={isDark} badge="LIVE" />
        <NavItem icon={Database}     label="DB Audit"             description="Low-level database audit trail"            color="#D97706" path="/(app)/(admin)/db-audit"               c={c} isDark={isDark} />
        <NavItem icon={ClipboardList} label="Course Activations"  description="Timeline of course activation events"      color="#7C3AED" path="/(app)/(admin)/course-activation-timeline" c={c} isDark={isDark} />

        {/* ── Security ─────────────────────────────────────────────────── */}
        <SectionLabel title="Security" c={c} />
        <NavItem icon={ShieldAlert}  label="Security Dashboard"   description="Login attempts, threats & active sessions" color="#EF4444" path="/(app)/(superadmin)/sec-dashboard"    c={c} isDark={isDark} />
        <NavItem icon={ShieldCheck}  label="Security Policies"    description="Rate limits, IP rules & access controls"   color="#8B5CF6" path="/(app)/(superadmin)/sec-policies"     c={c} isDark={isDark} />
        <NavItem icon={ShieldX}      label="Security Diagnostics" description="Detailed security event logs"              color="#6B7280" path="/(app)/(superadmin)/sec-diag"         c={c} isDark={isDark} />

        {/* ── Content & Violations ─────────────────────────────────────── */}
        <SectionLabel title="Content & Violations" c={c} />
        <NavItem icon={Eye}          label="Content Protection"   description="Screenshot & recording prevention"         color="#EF4444" path="/(app)/(superadmin)/content-protection" c={c} isDark={isDark} />
        <NavItem icon={AlertOctagon} label="Violation Management" description="Policy violations and offences log"        color="#D97706" path="/(app)/(superadmin)/violation-management" c={c} isDark={isDark} />
        <NavItem icon={AlertTriangle} label="Fraud Alerts"        description="Suspicious activity detection"             color="#DC2626" path="/(app)/(admin)/fraud-alerts"            c={c} isDark={isDark} />

        {/* ── Admin Tools ──────────────────────────────────────────────── */}
        <SectionLabel title="Admin Tools" c={c} />
        <NavItem icon={Search}       label="Global Search"        description="Search users, courses, transactions"       color={c.primary} path="/(app)/(admin)/global-search"        c={c} isDark={isDark} />
        <NavItem icon={HeartHandshake} label="Impersonation"      description="Log in as any user for debugging"          color="#D97706" path="/(app)/(superadmin)/impersonation"     c={c} isDark={isDark} />
        <NavItem icon={Trash2}       label="Trash Bin"            description="Restore or permanently delete items"       color="#EF4444" path="/(app)/(superadmin)/trash-bin"         c={c} isDark={isDark} />
        <NavItem icon={Lock}         label="Delete Permissions"   description="Control which data can be deleted"         color="#7C3AED" path="/(app)/(superadmin)/delete-permissions" c={c} isDark={isDark} />

        <View style={{ height: 32 }} />
      </View>
    </ScrollView>
  );
}
