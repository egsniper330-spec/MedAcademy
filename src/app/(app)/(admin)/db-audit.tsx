/**
 * db-audit.tsx — Database Integrity Audit (v70)
 *
 * DISTINCT FROM System Diagnostics: System Diagnostics = live health of
 * configured services (DB connectivity, SMTP, VdoCipher, JWT...). THIS panel
 * = one-shot DATA-INTEGRITY audit of the database CONTENT: orphan rows,
 * negative credit balances and per-table row counts. It runs the real
 * POST /analytics/db-audit (admin/super_admin, feature-flag gated).
 *
 * CONTRACT (AnalyticsController::dbAudit):
 *   { audit: {
 *       orphan_profiles, orphan_enrollments, orphan_credits, orphan_courses,
 *       negative_balances,
 *       row_counts: { profiles, users, courses, enrollments, credits,
 *                     devices, lessons, audit_logs } } }
 * The previous UI rendered fields the backend never returns
 * (duplicate_enrollments, duplicate_devices, duplicate_transactions,
 * broken_fks, database.*) — all permanently zero. Fixed by rendering the
 * REAL contract only.
 */
import { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, useColorScheme,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Database, AlertTriangle, CheckCircle, RefreshCw,
  Trash2, UserX, CreditCard, BookOpen,
} from 'lucide-react-native';
import { backendClient } from '@/client/backendClient';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { neuColors, useLayout, safeBottom } from '@/lib/neu';
import { PageHeader } from '@/components/PageHeader';

interface DbAuditResult {
  orphan_profiles: number;
  orphan_enrollments: number;
  orphan_credits: number;
  orphan_courses: number;
  negative_balances: number;
  row_counts: Record<string, number>;
}

const ROW_COUNT_TABLES = ['profiles', 'users', 'courses', 'enrollments', 'credits', 'devices', 'lessons', 'audit_logs'];

const ISSUE_CFG = [
  { key: 'orphan_profiles',     label: 'Profiles without a user record', icon: UserX,      risk: 'high'   },
  { key: 'orphan_enrollments',  label: 'Enrollments without a student',  icon: Trash2,     risk: 'high'   },
  { key: 'orphan_credits',      label: 'Credit rows without an owner',   icon: CreditCard, risk: 'medium' },
  { key: 'orphan_courses',      label: 'Courses without an instructor',  icon: BookOpen,   risk: 'medium' },
  { key: 'negative_balances',   label: 'Negative credit balances',       icon: AlertTriangle, risk: 'high' },
] as const;

const RISK_COLOR: Record<string, string> = {
  high:   '#DC2626',
  medium: '#D97706',
  low:    '#16A34A',
};

type LoadState = 'loading' | 'ready' | 'error';

export default function DbAuditPanel({ backTo }: { backTo?: string } = {}) {
  const scheme = useColorScheme();
  const isDark  = scheme === 'dark';
  const c       = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  const [audit,       setAudit]       = useState<DbAuditResult | null>(null);
  const [state,       setState]       = useState<LoadState>('loading');
  const [refreshing,  setRefreshing]  = useState(false);
  const [running,     setRunning]     = useState(false);
  const [repairLog,   setRepairLog]   = useState<string[]>([]);
  const [repairing,   setRepairing]   = useState(false);

  const loadAudit = useCallback(async (): Promise<DbAuditResult | null> => {
    const { data, error } = await backendClient.rpc('run_db_audit');
    if (error || !data) { setState('error'); return null; }
    // The backend nests the result under `audit`.
    const result = (data as { audit?: DbAuditResult }).audit ?? null;
    if (!result) { setState('error'); return null; }
    setAudit(result);
    setState('ready');
    return result;
  }, []);

  useFocusEffect(useCallback(() => {
    setState('loading');
    (async () => { await loadAudit(); })();
  }, [loadAudit]));

  const onRefresh = async () => {
    setRefreshing(true);
    await loadAudit();
    setRefreshing(false);
  };

  const runFullAudit = async () => {
    setRunning(true);
    await loadAudit();
    setRunning(false);
  };

  // Re-check: a REAL second audit run compared against the first. The previous
  // "Auto-Repair" only re-ran the audit and logged fabricated success lines —
  // now it reports honest before/after issue totals (this audit is read-only;
  // repairs of found issues are a manual DBA workflow, stated plainly).
  const runRecheck = async () => {
    setRepairing(true);
    const log: string[] = [];
    try {
      const before = audit
        ? audit.orphan_profiles + audit.orphan_enrollments + audit.orphan_credits
          + audit.orphan_courses + audit.negative_balances
        : null;
      log.push('• Running integrity audit…');
      const after = await loadAudit();
      const afterTotal = after
        ? after.orphan_profiles + after.orphan_enrollments + after.orphan_credits
          + after.orphan_courses + after.negative_balances
        : null;
      if (afterTotal === null) {
        log.push('✗ Re-check failed — audit could not complete.');
      } else if (before !== null && afterTotal > before) {
        log.push(`✗ Issue count INCREASED: ${before} → ${afterTotal}. Investigate recent changes.`);
      } else if (before !== null && afterTotal < before) {
        log.push(`✓ Issue count decreased: ${before} → ${afterTotal}.`);
      } else if (before !== null && afterTotal === before) {
        log.push(`✓ Re-check complete — issue count unchanged (${afterTotal}).`);
      } else {
        log.push(afterTotal === 0 ? '✓ Re-check complete — no integrity issues found.' : `• Re-check complete — ${afterTotal} issue(s) present.`);
      }
      log.push('ℹ This audit is read-only. Repairing orphaned/negative rows is a manual database-administration task.');
    } catch (e) {
      log.push(`✗ Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRepairLog(log);
      setRepairing(false);
    }
  };

  const totalIssues = audit
    ? audit.orphan_profiles + audit.orphan_enrollments + audit.orphan_credits
      + audit.orphan_courses + audit.negative_balances
    : 0;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />} contentContainerStyle={{ paddingBottom: safeBottom(layout.insets.bottom) }}
    >
      <PageHeader
        title="Database Integrity"
        subtitle="Orphan rows, negative balances & table sizes"
        accentColor="#7C3AED"
        showBack
        backFallback={backTo ?? '/admin-overview'}
      />

      <View style={{ paddingHorizontal: layout.screenPx }}>

        {/* ── Action Buttons ─────────────────────────────────────────────── */}
        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 20 }}>
          <View style={{ flex: 1 }}>
            <NeuButton
              label={running ? 'Scanning…' : '▶  Run Audit'}
              onPress={runFullAudit}
              loading={running}
              variant="primary"
              fullWidth
            />
          </View>
          <View style={{ flex: 1 }}>
            <NeuButton
              label={repairing ? 'Re-checking…' : '⟳  Re-check'}
              onPress={runRecheck}
              loading={repairing}
              variant="secondary"
              fullWidth
            />
          </View>
        </View>

        {state === 'loading' ? (
          <ActivityIndicator color={c.primary} size="large" style={{ marginTop: 40 }} />
        ) : state === 'error' ? (
          <NeuCard style={{ padding: 30, alignItems: 'center' }}>
            <AlertTriangle size={40} color="#DC2626" />
            <Text style={{ fontSize: 14, fontWeight: '600', color: c.text, marginTop: 12 }}>Unable to run the integrity audit</Text>
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 6, textAlign: 'center' }}>
              The audit endpoint returned an error. Pull to refresh or tap "Run Audit" to retry.
            </Text>
          </NeuCard>
        ) : audit ? (
          <>
            {/* ── Issue Summary Banner ──────────────────────────────────────── */}
            <NeuCard style={{ padding: layout.screenPx, marginBottom: 20, flexDirection: 'row', alignItems: 'center', gap: 16 }}>
              <View style={{
                width: 56, height: 56, borderRadius: 18,
                backgroundColor: totalIssues === 0 ? '#16A34A18' : '#DC262618',
                alignItems: 'center', justifyContent: 'center',
              }}>
                {totalIssues === 0
                  ? <CheckCircle size={28} color="#16A34A" />
                  : <AlertTriangle size={28} color="#DC2626" />
                }
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 18, fontWeight: '800', color: totalIssues === 0 ? '#16A34A' : '#DC2626' }}>
                  {totalIssues === 0 ? 'Database is Clean' : `${totalIssues} Issue${totalIssues > 1 ? 's' : ''} Detected`}
                </Text>
                <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginTop: 3 }}>
                  Data-integrity audit — for live service health use System Diagnostics
                </Text>
              </View>
            </NeuCard>

            {/* ── Issue Checklist ───────────────────────────────────────────── */}
            <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 12 }}>Issue Checklist</Text>
            {ISSUE_CFG.map(({ key, label, icon: Icon, risk }) => {
              const count = audit[key] ?? 0;
              const color = count > 0 ? RISK_COLOR[risk] : '#16A34A';
              return (
                <NeuCard key={key} style={{ marginBottom: 8, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View style={{
                    width: 38, height: 38, borderRadius: 12,
                    backgroundColor: `${color}18`, alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Icon size={18} color={color} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{label}</Text>
                    {count > 0 && (
                      <Text style={{ fontSize: 11, color: RISK_COLOR[risk], marginTop: 2 }}>
                        {count} found — {risk} risk
                      </Text>
                    )}
                  </View>
                  <View style={{
                    backgroundColor: `${color}18`, borderRadius: 10,
                    paddingHorizontal: 10, paddingVertical: 4,
                  }}>
                    <Text style={{ fontSize: 13, fontWeight: '800', color }}>
                      {count === 0 ? '✓' : count}
                    </Text>
                  </View>
                </NeuCard>
              );
            })}

            {/* ── Table Row Counts ──────────────────────────────────────────── */}
            <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginTop: 8, marginBottom: 12 }}>
              Table Row Counts
            </Text>
            <NeuCard style={{ padding: 16, marginBottom: 20 }}>
              {ROW_COUNT_TABLES.map((t, i) => (
                <View key={t} style={{
                  flexDirection: 'row', justifyContent: 'space-between',
                  paddingVertical: 8,
                  borderBottomWidth: i < ROW_COUNT_TABLES.length - 1 ? 1 : 0,
                  borderBottomColor: `${c.text}08`,
                }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{t}</Text>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: c.primary }}>
                    {(audit.row_counts?.[t] ?? 0).toLocaleString('en-US')}
                  </Text>
                </View>
              ))}
            </NeuCard>

            {/* ── Re-check Log ──────────────────────────────────────────────── */}
            {repairLog.length > 0 && (
              <>
                <Text style={{ fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 12 }}>
                  Re-check Log
                </Text>
                <NeuCard style={{ padding: 16, marginBottom: 20 }}>
                  {repairLog.map((line, i) => (
                    <Text key={`${i}-${line.slice(0, 12)}`} style={{ fontSize: 13, color: line.startsWith('✗') ? '#DC2626' : line.startsWith('ℹ') ? c.primary : '#16A34A', marginBottom: 6 }}>
                      {line}
                    </Text>
                  ))}
                </NeuCard>
              </>
            )}
          </>
        ) : null}
      </View>
    </ScrollView>
  );
}
