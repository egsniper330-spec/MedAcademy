/**
 * System Diagnostics (formerly "System Providers") — Super Admin only.
 *
 * Scans the backend's real service dependencies (database, VdoCipher, SMTP,
 * storage, JWT, update policy, PHP runtime) via GET /admin/system/diagnostics
 * and renders safe, sanitized results. Secrets NEVER reach this screen — the
 * backend only sends presence metadata ("configured": true) and classified
 * error codes. See backend/src/Services/SystemDiagnosticsService.php.
 *
 * Layout contract: PageHeader owns the safe-area top inset; Scan All lives
 * INSIDE the content area (never overlays the header); summary chips wrap;
 * every card uses flex so it fits phones and tablets without fixed widths.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, ActivityIndicator, RefreshControl, useColorScheme, Pressable,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  RefreshCw, Database, Video, Mail, HardDrive, ShieldCheck,
  Smartphone, Server, Layers, AlertTriangle,
} from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { runSystemDiagnostics, runSystemDiagnosticOne } from '@/lib/api';
import type { ServiceDiagnostic, SystemDiagnosticsReport, SystemServiceStatus } from '@/lib/api';
import { LoadingState, ErrorState } from '@/components/ScreenState';
import { EmptyState } from '@/components/EmptyState';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { neuColors, useLayout, safeBottom } from '@/lib/neu';

const STATUS_COLORS: Record<SystemServiceStatus, string> = {
  healthy: '#16A34A',
  warning: '#D97706',
  timeout: '#D97706',
  unavailable: '#DC2626',
  authentication_failed: '#DC2626',
  misconfigured: '#B45309',
  unknown: '#6B7280',
};

const STATUS_LABELS: Record<SystemServiceStatus, string> = {
  healthy: 'Healthy',
  warning: 'Warning',
  timeout: 'Timeout',
  unavailable: 'Offline',
  authentication_failed: 'Authentication Failed',
  misconfigured: 'Misconfigured',
  unknown: 'Unknown',
};

const CATEGORY_ICONS: Record<string, React.ElementType> = {
  Infrastructure: Database,
  'Video / DRM': Video,
  Notifications: Mail,
  Security: ShieldCheck,
  Platform: Smartphone,
};

const CHECK_COLORS: Record<string, string> = {
  passed: '#16A34A',
  configured: '#16A34A',
  failed: '#DC2626',
  warning: '#D97706',
  'not tested': '#9CA3AF',
  'not configured': '#D97706',
  'n/a': '#9CA3AF',
};

/**
 * Shared by the Admin shell and the Super Admin shell.
 * `backTo` renders the explicit platform back arrow when opened from the
 * Super Admin → Platform hub (the SA shell has no stack to pop).
 */
export default function SystemDiagnosticsScreen({ backTo }: { backTo?: string } = {}) {
  const router = useRouter();
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  const [report, setReport] = useState<SystemDiagnosticsReport | null>(null);
  const [phase, setPhase] = useState<'loading' | 'error' | 'success'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [scanning, setScanning] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      setReport(await runSystemDiagnostics());
      setPhase('success');
    } catch (e) {
      setError(e);
      setPhase('error');
    }
    setScanning(false);
  }, []);

  // Initial scan on first focus; pull-to-refresh and Scan All re-use it.
  useFocusEffect(useCallback(() => { void scan(); }, [scan]));

  const onRefresh = async () => { setRefreshing(true); await scan(); setRefreshing(false); };

  /** Individual service re-check — splices the fresh result into the report. */
  const checkOne = async (id: string) => {
    setCheckingId(id);
    try {
      const fresh = await runSystemDiagnosticOne(id);
      setReport(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          generatedAt: fresh.lastChecked,
          results: prev.results.map(r => (r.id === id ? fresh : r)),
        };
      });
    } catch {
      // Per-service failure keeps the previous result visible — the card is
      // refreshed by a full re-scan if needed. Silent-by-design would hide the
      // error, so surface it via a status nudge instead:
      setReport(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          results: prev.results.map(r => (
            r.id === id
              ? { ...r, message: 'Re-check failed — the request could not be completed. Run Scan All.', status: 'unknown' as SystemServiceStatus }
              : r
          )),
        };
      });
    }
    setCheckingId(null);
  };

  const fmtTime = (iso?: string) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  };

  const results = report?.results ?? [];
  const summary = report?.summary ?? {};

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
      contentContainerStyle={{ paddingBottom: safeBottom(layout.insets.bottom) }}
    >
      <PageHeader
        title="System Diagnostics"
        subtitle="API, database & service health"
        accentColor="#059669"
        showBack={!!backTo}
        onBack={backTo ? () => router.push(backTo as never) : undefined}
      />

      <View style={{ paddingHorizontal: layout.screenPx }}>

        {phase === 'loading' ? (
          <LoadingState label="Scanning backend services…" />
        ) : phase === 'error' ? (
          <ErrorState error={error} onRetry={scan} />
        ) : results.length === 0 ? (
          <EmptyState
            icon={<Layers size={40} color={c.primary} />}
            title="No services registered"
            description="The backend did not report any diagnostic services."
            action={{ label: 'Scan Again', onPress: scan }}
          />
        ) : (
          <>
            {/* Scan All — inside the content area, never over the header */}
            <View style={{ marginTop: 14, marginBottom: 10 }}>
              <NeuButton
                label={scanning ? 'Scanning…' : 'Scan All Services'}
                onPress={scan}
                loading={scanning}
                icon={<RefreshCw size={16} color="#fff" />}
                fullWidth
              />
            </View>

            <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginBottom: 14 }}>
              Last checked: {fmtTime(report?.generatedAt)}
            </Text>

            {/* Summary chips — wrap naturally on small screens */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
              {Object.entries(summary).filter(([, n]) => n > 0).map(([status, n]) => {
                const color = STATUS_COLORS[status as SystemServiceStatus] ?? '#6B7280';
                return (
                  <View
                    key={status}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: `${color}14`, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 7 }}
                  >
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
                    <Text style={{ fontSize: 12, fontWeight: '700', color }}>
                      {n} {STATUS_LABELS[status as SystemServiceStatus] ?? status}
                    </Text>
                  </View>
                );
              })}
            </View>

            {/* Service cards */}
            {results.map(service => (
              <ServiceCard
                key={service.id}
                service={service}
                c={c}
                checking={checkingId === service.id}
                onCheckAgain={() => checkOne(service.id)}
              />
            ))}
          </>
        )}

        <View style={{ height: 24 }} />
      </View>
    </ScrollView>
  );
}

// ── One service card ─────────────────────────────────────────────────────────

function ServiceCard({
  service, c, checking, onCheckAgain,
}: {
  service: ServiceDiagnostic;
  c: typeof neuColors.light;
  checking: boolean;
  onCheckAgain: () => void;
}) {
  const statusColor = STATUS_COLORS[service.status] ?? '#6B7280';
  const Icon = CATEGORY_ICONS[service.category] ?? Layers;
  const checkEntries = Object.entries(service.checks ?? {});

  return (
    <NeuCard style={{ marginBottom: 14, padding: 16 }}>
      {/* Title row */}
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ width: 42, height: 42, borderRadius: 13, backgroundColor: `${statusColor}16`, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
          <Icon size={20} color={statusColor} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: c.text }} numberOfLines={2}>
            {service.name}
          </Text>
          <Text style={{ fontSize: 11, color: c.text, opacity: 0.45, marginTop: 1 }}>{service.category}</Text>
        </View>
        {/* Status pill — never overlaps the name (own row on narrow cards) */}
        <View style={{ backgroundColor: `${statusColor}18`, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5, marginLeft: 8 }}>
          <Text style={{ fontSize: 11, fontWeight: '800', color: statusColor }} numberOfLines={1}>
            ● {STATUS_LABELS[service.status] ?? service.status}
          </Text>
        </View>
      </View>

      {/* Checks grid — wraps to multiple rows on small screens */}
      {checkEntries.length > 0 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
          {checkEntries.map(([name, verdict]) => {
            const color = CHECK_COLORS[verdict] ?? '#6B7280';
            return (
              <View
                key={name}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: `${c.text}08`, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 6 }}
              >
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
                <Text style={{ fontSize: 11, fontWeight: '600', color: c.text, opacity: 0.75 }}>{name}</Text>
                <Text style={{ fontSize: 11, fontWeight: '800', color }}>{verdict}</Text>
              </View>
            );
          })}
        </View>
      )}

      {/* Message */}
      {service.message !== '' && (
        <Text style={{ fontSize: 12.5, color: c.text, opacity: 0.65, marginTop: 12, lineHeight: 18 }}>
          {service.message}
        </Text>
      )}

      {/* Classification + metadata — wraps, never overflows */}
      {(service.errorCode || service.httpStatus != null || service.latencyMs != null) && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
          {service.errorCode ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#DC262612', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 }}>
              <AlertTriangle size={11} color="#DC2626" />
              <Text style={{ fontSize: 10.5, fontWeight: '800', color: '#DC2626' }}>{service.errorCode}</Text>
            </View>
          ) : null}
          {service.httpStatus != null && (
            <View style={{ backgroundColor: `${c.text}0A`, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 }}>
              <Text style={{ fontSize: 10.5, fontWeight: '700', color: c.text, opacity: 0.6 }}>HTTP {service.httpStatus}</Text>
            </View>
          )}
          {service.latencyMs != null && (
            <View style={{ backgroundColor: `${c.text}0A`, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 }}>
              <Text style={{ fontSize: 10.5, fontWeight: '700', color: c.text, opacity: 0.6 }}>{service.latencyMs} ms</Text>
            </View>
          )}
        </View>
      )}

      {/* Recommended action */}
      {service.recommendedAction ? (
        <View style={{ marginTop: 10, backgroundColor: `${c.primary}0C`, borderRadius: 10, padding: 10 }}>
          <Text style={{ fontSize: 12, color: c.primary, fontWeight: '600', lineHeight: 17 }}>
            {service.recommendedAction}
          </Text>
        </View>
      ) : null}

      {/* Footer: timestamp + per-service re-check */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: `${c.text}0C` }}>
        <Text style={{ fontSize: 10.5, color: c.text, opacity: 0.4, flex: 1, minWidth: 0 }} numberOfLines={1}>
          {fmtChecked(service.lastChecked)}
        </Text>
        {checking ? (
          <ActivityIndicator size="small" color={c.primary} />
        ) : (
          <Pressable hitSlop={6} onPress={onCheckAgain} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>Check Again</Text>
          </Pressable>
        )}
      </View>
    </NeuCard>
  );
}

function fmtChecked(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `Checked ${d.toLocaleTimeString()}`;
}
