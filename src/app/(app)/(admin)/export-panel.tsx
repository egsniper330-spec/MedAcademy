/**
 * export-panel.tsx  — v68
 * CSV / JSON export for Health, Credits, Audit, and Security reports.
 * (PDF/Excel via native share on device; inline CSV generation for web.)
 */
import { useState } from 'react';
import {
  View, Text, ScrollView, useColorScheme,
  Share, Platform,
} from 'react-native';
import {
  Download, FileText, CreditCard, Shield, Activity,
  CheckCircle, AlertTriangle,
} from 'lucide-react-native';
import { supabase } from '@/client/supabase';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { neuColors, useLayout } from '@/lib/neu';
import { PageHeader } from '@/components/PageHeader';

// ─── CSV helpers ──────────────────────────────────────────────────────────────
function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(','),
    ...rows.map(r =>
      headers.map(h => {
        const v = r[h];
        const str = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
        return `"${str.replace(/"/g, '""')}"`;
      }).join(',')
    ),
  ];
  return lines.join('\n');
}

async function shareText(content: string, filename: string, mimeType = 'text/plain') {
  if (Platform.OS === 'web') {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    return;
  }
  await Share.share({ message: content, title: filename });
}

// ─── Export configs ───────────────────────────────────────────────────────────
interface ExportConfig {
  id:          string;
  label:       string;
  description: string;
  icon:        typeof FileText;
  color:       string;
  fetchRows:   () => Promise<Record<string, unknown>[]>;
}

type ExportStatus = 'idle' | 'loading' | 'done' | 'error';

export default function ExportPanel() {
  const scheme  = useColorScheme();
  const isDark  = scheme === 'dark';
  const c       = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  const [status, setStatus] = useState<Record<string, ExportStatus>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const EXPORTS: ExportConfig[] = [
    {
      id: 'health',
      label: 'Health Report',
      description: 'System health snapshot: all subsystems, latency, version',
      icon: Activity,
      color: '#16A34A',
      fetchRows: async () => {
        const { data } = await supabase.functions.invoke('system-health', { method: 'GET' });
        if (!data) return [];
        const d = data as Record<string, unknown>;
        const subs = d.subsystems as Record<string, Record<string, unknown>> ?? {};
        return Object.entries(subs).map(([key, v]) => ({
          subsystem: key,
          status:    v.status,
          latencyMs: v.latencyMs ?? '',
          error:     v.error ?? '',
          ...Object.fromEntries(
            Object.entries(v).filter(([k]) => !['name','status','latencyMs','error'].includes(k))
          ),
          exported_at: new Date().toISOString(),
        }));
      },
    },
    {
      id: 'credits',
      label: 'Credits Ledger',
      description: 'All credit transactions with actor, reason, balance',
      icon: CreditCard,
      color: '#D97706',
      fetchRows: async () => {
        const { data, error } = await supabase
          .from('credit_transactions')
          .select(`
            id, transaction_id, doctor_id, transaction_type,
            amount, balance_before, balance_after, reason,
            course_id, student_id, performed_by, created_at
          `)
          .order('created_at', { ascending: false })
          .limit(2000);
        if (error) throw new Error(error.message);
        return (data ?? []) as Record<string, unknown>[];
      },
    },
    {
      id: 'audit',
      label: 'Audit Logs',
      description: 'Actor, target, old/new values, reason, timestamp',
      icon: FileText,
      color: '#6366F1',
      fetchRows: async () => {
        const { data, error } = await supabase
          .from('audit_logs')
          .select(`
            id, transaction_id, actor_id, user_id,
            action, resource_type, resource_id,
            old_values, new_values, reason, success,
            ip_address, created_at
          `)
          .order('created_at', { ascending: false })
          .limit(2000);
        if (error) throw new Error(error.message);
        return (data ?? []).map((r: Record<string, unknown>) => {
          const row = r;
          return {
            ...row,
            old_values: row.old_values ? JSON.stringify(row.old_values) : '',
            new_values: row.new_values ? JSON.stringify(row.new_values) : '',
          };
        });
      },
    },
    {
      id: 'security',
      label: 'Security Report',
      description: 'Security events, blocked devices, suspended accounts',
      icon: Shield,
      color: '#DC2626',
      fetchRows: async () => {
        const [eventsRes, devicesRes, profilesRes] = await Promise.all([
          supabase.from('security_events')
            .select('id, user_id, event_type, risk_score, device_id, ip_address, created_at')
            .order('created_at', { ascending: false }).limit(1000),
          supabase.from('devices')
            .select('id, user_id, installation_id, platform, status, block_reason, blocked_at')
            .eq('status', 'blocked').limit(500),
          supabase.from('profiles')
            .select('id, email, role, status, created_at')
            .eq('status', 'suspended').limit(500),
        ]);
        const events  = (eventsRes.data  ?? []).map((r: Record<string, unknown>) => ({ ...r, _type: 'security_event' }));
        const devices = (devicesRes.data ?? []).map((r: Record<string, unknown>) => ({ ...r, _type: 'blocked_device' }));
        const accts   = (profilesRes.data ?? []).map((r: Record<string, unknown>) => ({ ...r, _type: 'suspended_account' }));
        return [...events, ...devices, ...accts];
      },
    },
    {
      id: 'db_audit',
      label: 'DB Audit Report',
      description: 'Duplicate checks, orphan rows, broken FKs, DB size',
      icon: Download,
      color: '#7C3AED',
      fetchRows: async () => {
        const { data, error } = await supabase.rpc('run_db_audit');
        if (error) throw new Error(error.message);
        const d = data as Record<string, unknown>;
        const db = d.database as Record<string, unknown> ?? {};
        const rows: Record<string, unknown>[] = [
          { metric: 'duplicate_enrollments',   value: d.duplicate_enrollments,  risk: 'high'  },
          { metric: 'duplicate_devices',        value: d.duplicate_devices,       risk: 'high'  },
          { metric: 'negative_balances',        value: d.negative_balances,       risk: 'high'  },
          { metric: 'orphan_enrollments',       value: d.orphan_enrollments,      risk: 'medium'},
          { metric: 'orphan_lessons',           value: d.orphan_lessons,          risk: 'medium'},
          { metric: 'duplicate_codes',          value: d.duplicate_codes,         risk: 'medium'},
          { metric: 'duplicate_transactions',   value: d.duplicate_transactions,  risk: 'high'  },
          { metric: 'broken_fks',               value: d.broken_fks,              risk: 'high'  },
          { metric: 'total_issues',             value: d.total_issues,            risk: ''      },
          { metric: 'db_total_tables',          value: db.total_tables,           risk: ''      },
          { metric: 'db_total_indexes',         value: db.total_indexes,          risk: ''      },
          { metric: 'db_size',                  value: db.size_pretty,            risk: ''      },
        ];
        // largest tables
        const largest = (db.largest_tables as Array<{ table_name: string; size_pretty: string; row_count: number }> ?? []);
        largest.forEach(t => rows.push({
          metric: `table_${t.table_name}_size`, value: t.size_pretty, risk: '', rows: t.row_count,
        }));
        return rows;
      },
    },
  ];

  const doExport = async (cfg: ExportConfig) => {
    setStatus(prev => ({ ...prev, [cfg.id]: 'loading' }));
    setErrors(prev => ({ ...prev, [cfg.id]: '' }));
    try {
      const rows = await cfg.fetchRows();
      if (rows.length === 0) throw new Error('No data to export');
      const csv = toCsv(rows);
      const filename = `${cfg.id}_${new Date().toISOString().slice(0,10)}.csv`;
      await shareText(csv, filename, 'text/csv');
      setStatus(prev => ({ ...prev, [cfg.id]: 'done' }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrors(prev => ({ ...prev, [cfg.id]: msg }));
      setStatus(prev => ({ ...prev, [cfg.id]: 'error' }));
    }
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.base }}
          contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}>
      <View style={{ padding: layout.screenPx }}>
        <PageHeader title="Export Center" subtitle="Download CSV reports for any subsystem" accentColor="#D97706" />

        <NeuCard style={{ padding: 14, marginBottom: 20, flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <Download size={18} color={c.primary} />
          <Text style={{ fontSize: 13, color: c.text, opacity: 0.65, flex: 1 }}>
            Exports generate CSV files. On mobile, use Share to save or forward.
            On Web, the file downloads directly.
          </Text>
        </NeuCard>

        {EXPORTS.map((cfg) => {
          const s    = status[cfg.id] ?? 'idle';
          const err  = errors[cfg.id];
          const Icon = cfg.icon;
          return (
            <NeuCard key={cfg.id} style={{ marginBottom: 14, padding: 18 }}>
              {/* Header */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <View style={{
                  width: 44, height: 44, borderRadius: 14,
                  backgroundColor: `${cfg.color}18`,
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <Icon size={20} color={cfg.color} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }}>{cfg.label}</Text>
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginTop: 2 }}>
                    {cfg.description}
                  </Text>
                </View>
                {s === 'done' && <CheckCircle size={20} color="#16A34A" />}
                {s === 'error' && <AlertTriangle size={20} color="#DC2626" />}
              </View>

              {err && (
                <Text style={{ fontSize: 12, color: '#DC2626', marginBottom: 10 }}>⚠ {err}</Text>
              )}

              {s === 'done' && (
                <Text style={{ fontSize: 12, color: '#16A34A', marginBottom: 10 }}>
                  ✓ Export ready — check your downloads / share sheet
                </Text>
              )}

              {/* Export buttons */}
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <NeuButton
                    label={s === 'loading' ? 'Exporting…' : 'CSV'}
                    onPress={() => doExport(cfg)}
                    loading={s === 'loading'}
                    variant="secondary"
                    fullWidth
                    icon={<Download size={14} color={c.text} />}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <NeuButton
                    label="JSON"
                    onPress={async () => {
                      setStatus(prev => ({ ...prev, [cfg.id]: 'loading' }));
                      try {
                        const rows = await cfg.fetchRows();
                        const content = JSON.stringify(rows, null, 2);
                        await shareText(content, `${cfg.id}_${new Date().toISOString().slice(0,10)}.json`, 'application/json');
                        setStatus(prev => ({ ...prev, [cfg.id]: 'done' }));
                      } catch (e) {
                        const msg = e instanceof Error ? e.message : String(e);
                        setErrors(prev => ({ ...prev, [cfg.id]: msg }));
                        setStatus(prev => ({ ...prev, [cfg.id]: 'error' }));
                      }
                    }}
                    loading={s === 'loading'}
                    variant="secondary"
                    fullWidth
                    icon={<FileText size={14} color={c.text} />}
                  />
                </View>
              </View>
            </NeuCard>
          );
        })}
      </View>
    </ScrollView>
  );
}
