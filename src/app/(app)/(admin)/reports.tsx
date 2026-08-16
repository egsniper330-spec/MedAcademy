/**
 * Reports — Admin & Super Admin
 * Export platform data as CSV.
 */
import { useState } from 'react';
import {
  View, Text, ScrollView, ActivityIndicator,
  useColorScheme, Pressable, Share, Platform,
} from 'react-native';
import { FileText, Download, Calendar, Users, Ticket, CreditCard, Archive } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { getReportData, getArchiveAnalytics, getCourseLifecycleLogs, formatStudyTime } from '@/lib/api';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { neuColors, useLayout } from '@/lib/neu';

const REPORT_TYPES = [
  { key: 'users',      label: 'User Report',            icon: Users,      color: '#1E90FF', desc: 'All registered users with roles and universities' },
  { key: 'credits',    label: 'Credit Transactions',    icon: CreditCard, color: '#16A34A', desc: 'Doctor credit allocations and consumption' },
  { key: 'activation', label: 'Activation Code Report', icon: Ticket,     color: '#D97706', desc: 'All codes with usage, creators and redeemers' },
  { key: 'archive',    label: 'Archive Analytics',      icon: Archive,    color: '#7C3AED', desc: 'Archived, restored and deleted course events' },
];

function toCSV(rows: any[]): string {
  if (!rows.length) return '';
  const flatten = (obj: any, prefix = ''): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        Object.assign(result, flatten(val, fullKey));
      } else {
        result[fullKey] = String(val ?? '');
      }
    }
    return result;
  };
  const flat = rows.map(r => flatten(r));
  const headers = [...new Set(flat.flatMap(r => Object.keys(r)))];
  const escapeCell = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = headers.map(escapeCell).join(',');
  const dataRows = flat.map(r => headers.map(h => escapeCell(r[h] ?? '')).join(','));
  return [header, ...dataRows].join('\n');
}

export default function ReportsScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<any[]>([]);
  const [csvContent, setCsvContent] = useState('');
  const [generated, setGenerated] = useState(false);
  const [archiveStats, setArchiveStats] = useState<any>(null);
  const [archiveLogs, setArchiveLogs] = useState<any[]>([]);
  const [loadingArchive, setLoadingArchive] = useState(false);

  const handleGenerate = async () => {
    if (!selectedType) return;
    setLoading(true); setGenerated(false);
    try {
      if (selectedType === 'archive') {
        setLoadingArchive(true);
        const [stats, logs] = await Promise.all([
          getArchiveAnalytics(),
          getCourseLifecycleLogs(50),
        ]);
        setArchiveStats(stats);
        setArchiveLogs(logs);
        const csv = toCSV(logs);
        setCsvContent(csv);
        setGenerated(true);
        setLoadingArchive(false);
      } else {
        const data = await getReportData(selectedType);
        setPreview(data.slice(0, 5));
        const csv = toCSV(data);
        setCsvContent(csv);
        setGenerated(true);
      }
    } catch (_) {}
    setLoading(false);
  };

  const handleExport = async () => {
    if (!csvContent) return;
    const filename = `${selectedType}_report_${new Date().toISOString().slice(0, 10)}.csv`;
    if (Platform.OS === 'web') {
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } else {
      await Share.share({ title: filename, message: csvContent });
    }
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }}
          contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}>
      <View style={{ padding: layout.screenPx }}>
        <PageHeader title="Reports" subtitle="Export platform data as CSV" accentColor="#7C3AED" />

        {/* Report Type Selection */}
        <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, opacity: 0.6, marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.8 }}>
          Select Report Type
        </Text>
        {REPORT_TYPES.map(rt => {
          const active = selectedType === rt.key;
          return (
            <Pressable key={rt.key} onPress={() => { setSelectedType(rt.key); setGenerated(false); }}>
              <NeuCard style={{ marginBottom: 12, padding: 16, borderWidth: active ? 1.5 : 0, borderColor: active ? rt.color : 'transparent' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: `${rt.color}18`, alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
                    <rt.icon size={20} color={rt.color} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>{rt.label}</Text>
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 2 }}>{rt.desc}</Text>
                  </View>
                  {active && (
                    <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: rt.color, alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>✓</Text>
                    </View>
                  )}
                </View>
              </NeuCard>
            </Pressable>
          );
        })}

        <View style={{ marginTop: 8, marginBottom: 20 }}>
          <NeuButton
            label="Generate Report"
            icon={<Calendar size={16} color="#fff" />}
            onPress={handleGenerate}
            loading={loading}
            fullWidth
            disabled={!selectedType}
          />
        </View>

        {/* Archive Analytics Panel */}
        {generated && selectedType === 'archive' && archiveStats && (
          <>
            <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 12 }}>
              Archive Analytics
            </Text>
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
              {[
                { label: 'Archived', value: archiveStats.total_archived, color: '#D97706' },
                { label: 'Restored', value: archiveStats.total_restored, color: '#16A34A' },
                { label: 'Deleted',  value: archiveStats.total_deleted,  color: '#DC2626' },
              ].map(stat => (
                <NeuCard key={stat.label} style={{ flex: 1, alignItems: 'center', padding: 14, gap: 4 }}>
                  <Text style={{ fontSize: 22, fontWeight: '800', color: stat.color }}>{stat.value}</Text>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.5 }}>{stat.label}</Text>
                </NeuCard>
              ))}
            </View>

            {archiveLogs.slice(0, 8).map((log, i) => (
              <NeuCard key={log.id ?? i} style={{ marginBottom: 10, padding: 14 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10,
                    backgroundColor: log.action === 'archived' ? '#D9770620'
                      : log.action === 'restored' ? '#16A34A20' : '#DC262620' }}>
                    <Text style={{ fontSize: 11, fontWeight: '700',
                      color: log.action === 'archived' ? '#D97706'
                        : log.action === 'restored' ? '#16A34A' : '#DC2626',
                      textTransform: 'capitalize' }}>
                      {log.action}
                    </Text>
                  </View>
                  <Text style={{ flex: 1, fontSize: 13, fontWeight: '700', color: c.text }} numberOfLines={1}>
                    {log.course_title}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 14 }}>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>
                    {log.actor_role ?? '—'} · {new Date(log.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </Text>
                  {log.reason ? (
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }} numberOfLines={1}>
                      {log.reason}
                    </Text>
                  ) : null}
                </View>
              </NeuCard>
            ))}

            <NeuButton
              label="Export Archive CSV"
              icon={<Download size={16} color="#fff" />}
              onPress={handleExport}
              fullWidth
              style={{ marginTop: 8 }}
            />
          </>
        )}

        {/* Preview */}
        {generated && selectedType !== 'archive' && preview.length > 0 && (
          <>
            <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 14 }}>
              Preview (first {preview.length} rows)
            </Text>
            {preview.map((row, i) => (
              <NeuCard key={i} style={{ marginBottom: 10, padding: 14 }}>
                {Object.entries(row).slice(0, 4).map(([key, val]) => (
                  <View key={key} style={{ flexDirection: 'row', marginBottom: 4 }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: c.text, opacity: 0.5, minWidth: 90, flexShrink: 0 }}>{key}</Text>
                    <Text style={{ fontSize: 11, color: c.text, flex: 1 }} numberOfLines={1}>{String(val ?? '')}</Text>
                  </View>
                ))}
              </NeuCard>
            ))}

            <NeuButton
              label="Export CSV"
              icon={<Download size={16} color="#fff" />}
              onPress={handleExport}
              fullWidth
              style={{ marginTop: 8 }}
            />
          </>
        )}

        {generated && selectedType !== 'archive' && preview.length === 0 && (
          <NeuCard style={{ padding: 40, alignItems: 'center' }}>
            <FileText size={36} color={c.primary} opacity={0.25} />
            <Text style={{ color: c.text, opacity: 0.4, marginTop: 16 }}>No data found for this report</Text>
          </NeuCard>
        )}
      </View>
    </ScrollView>
  );
}
