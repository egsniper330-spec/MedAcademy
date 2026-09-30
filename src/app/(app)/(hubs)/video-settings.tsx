/**
 * video-settings.tsx
 * Video Settings — the AUTHORITATIVE VdoCipher status page (Super Admin).
 *
 * DATA CONTRACT (all live, nothing counted from local tables):
 *   GET /video/vdocipher-status  → live VdoCipher listing (real count with
 *   pagination), the labeled listing size, and the webhook contract.
 *   GET /storage/buckets         → provider metadata only.
 *
 * Sections:
 *   A. VdoCipher Connection — live API status, HTTP code, error class
 *   B. Video Library        — authoritative video count + count source
 *   C. Storage / Usage      — labeled "size of videos returned by VdoCipher"
 *                             (NOT account storage usage)
 *   D. Webhook              — canonical endpoint + verification honesty
 *   E. Diagnostics          — refresh + last checked
 *
 * FAILURE CONTRACT: a failed VdoCipher call renders "Unavailable + reason"
 * with the error class (auth/upstream 4xx/5xx/rate limit/malformed/config) —
 * it is NEVER displayed as "0 videos".
 */
import { useCallback, useState } from 'react';
import {
  ActivityIndicator, Pressable, RefreshControl,
  ScrollView, Text, useColorScheme, View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Activity, AlertTriangle, CheckCircle, Clock, Film,
  RefreshCw, ShieldCheck, WifiOff,
} from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, useLayout, neuFlatStyle, safeBottom } from '@/lib/neu';
import { formatBytes } from '@/lib/videoUploadEngine';
import { getVdoCipherStatus, type VdoCipherStatus } from '@/lib/api';

const ERROR_REASONS: Record<string, string> = {
  not_configured: 'VdoCipher API secret is not configured on the server.',
  rate_limited: 'VdoCipher rate limit reached — try again shortly.',
  malformed_response: 'VdoCipher returned a response the server could not parse.',
  timeout: 'The VdoCipher API request timed out.',
};

function apiErrorReason(err: string | null, http: number): string {
  if (!err) return 'VdoCipher API request failed.';
  if (ERROR_REASONS[err]) return ERROR_REASONS[err];
  if (err.startsWith('upstream_')) {
    const code = err.replace('upstream_', '');
    return `VdoCipher API returned HTTP ${code}.`;
  }
  return `VdoCipher API error: ${err}.`;
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  const isDark = useColorScheme() === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12,
      paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: `${c.text}08` }}>
      <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>{label}</Text>
      <Text style={{ fontSize: 12, fontWeight: '600', color: warn ? '#D97706' : c.text, flexShrink: 1, textAlign: 'right' }}>
        {value}
      </Text>
    </View>
  );
}

export default function VideoSettingsScreen({ backTo }: { backTo?: string } = {}) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  const [status, setStatus] = useState<VdoCipherStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setStatus(await getVdoCipherStatus());
      setLastChecked(new Date());
    } catch (e: any) {
      setLoadError(e?.message ?? 'VdoCipher status could not be loaded.');
    }
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const api = status?.api;
  const webhook = status?.webhook;
  const apiOk = api?.status === 'ok';

  const connCfg = apiOk
    ? { label: 'Online', color: '#16A34A', Icon: CheckCircle }
    : api
      ? { label: 'Unavailable', color: '#DC2626', Icon: WifiOff }
      : { label: 'Unknown', color: '#6B7280', Icon: Clock };

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
        contentContainerStyle={{ padding: layout.screenPx, paddingBottom: safeBottom(layout.insets.bottom), gap: 16 }}>

        <View style={{ marginTop: 8 }}>
          <PageHeader
            title="Video Settings"
            subtitle="Authoritative VdoCipher status"
            accentColor="#7C3AED"
            showBack
            backFallback={backTo ?? '/admin-overview'}
            rightAction={
              <Pressable onPress={onRefresh} disabled={refreshing || loading}
                style={[neuFlatStyle(isDark), { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' }]}>
                {refreshing ? <ActivityIndicator size={15} color={c.primary} /> : <RefreshCw size={16} color={c.primary} />}
              </Pressable>
            }
          />
        </View>

        {loading ? (
          <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} />
        ) : loadError ? (
          <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 24, alignItems: 'center', gap: 12 }]}>
            <AlertTriangle size={28} color="#DC2626" />
            <Text style={{ fontSize: 14, fontWeight: '800', color: c.text }}>Unable to load VdoCipher status</Text>
            <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, textAlign: 'center' }}>{loadError}</Text>
            <Pressable onPress={load}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, backgroundColor: c.primary }}>
              <RefreshCw size={14} color="#fff" />
              <Text style={{ fontSize: 13, fontWeight: '800', color: '#fff' }}>Retry</Text>
            </Pressable>
          </NeuCard>
        ) : status && (
          <View style={{ gap: 14 }}>

            {/* ── A. VdoCipher Connection ─────────────────────────────── */}
            <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 18, padding: 18, gap: 14 }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ width: 46, height: 46, borderRadius: 14, backgroundColor: `${connCfg.color}18`,
                  alignItems: 'center', justifyContent: 'center' }}>
                  <connCfg.Icon size={22} color={connCfg.color} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '800', color: c.text }}>VdoCipher API</Text>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.45 }}>Live connection status</Text>
                </View>
                <View style={{ backgroundColor: `${connCfg.color}18`, borderRadius: 10,
                  paddingHorizontal: 10, paddingVertical: 5 }}>
                  <Text style={{ fontSize: 11, fontWeight: '800', color: connCfg.color }}>{connCfg.label}</Text>
                </View>
              </View>
              <View>
                <Row label="Listing request" value={apiOk ? `OK (HTTP ${api?.http_status})` : `Failed (HTTP ${api?.http_status || 'n/a'})`} warn={!apiOk} />
                <Row label="Last successful check" value={api?.checked_at ? new Date(api.checked_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) : 'Never (last request failed)'} warn={!apiOk} />
                {!apiOk && <Row label="Reason" value={apiErrorReason(api?.error ?? null, api?.http_status ?? 0)} warn />}
              </View>
            </NeuCard>

            {/* ── B. Video Library (authoritative count) ──────────────── */}
            <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 16, gap: 8 }]}>
              <Text style={{ fontSize: 13, fontWeight: '800', color: c.text }}>Video Library</Text>
              {apiOk && api?.video_count !== null && api?.video_count !== undefined ? (
                <>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <Film size={18} color="#2DA8FF" />
                    <Text style={{ fontSize: 30, fontWeight: '900', color: '#2DA8FF' }}>{api.video_count}</Text>
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.5 }}>videos in the VdoCipher library</Text>
                  </View>
                  <Row label="Count source" value={api.count_source === 'vdocipher_reported_total' ? 'VdoCipher-reported total' : 'Fully paginated listing'} />
                  <Row label="Pages fetched" value={String(api.pages_fetched)} />
                  <Row label="Deleted VdoCipher assets" value="Excluded (live listing)" />
                </>
              ) : (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }}>
                  <AlertTriangle size={14} color="#D97706" />
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.55, flex: 1 }}>
                    Video count unavailable — {apiErrorReason(api?.error ?? null, api?.http_status ?? 0)}
                  </Text>
                </View>
              )}
            </NeuCard>

            {/* ── C. Storage / Usage (only real, clearly labeled metrics) ── */}
            <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 16, gap: 8 }]}>
              <Text style={{ fontSize: 13, fontWeight: '800', color: c.text }}>Storage / Usage</Text>
              {apiOk && api?.listed_videos_size_bytes !== null && api?.listed_videos_size_bytes !== undefined ? (
                <>
                  <Row label="Total size of videos returned by VdoCipher" value={formatBytes(api.listed_videos_size_bytes)} />
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>
                    {api.listed_videos_size_note}
                  </Text>
                  <Row label="Account storage usage" value="Not available from VdoCipher API" warn />
                </>
              ) : (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }}>
                  <AlertTriangle size={14} color="#D97706" />
                  <Text style={{ fontSize: 12, color: c.text, opacity: 0.55, flex: 1 }}>
                    Video size data unavailable — {apiErrorReason(api?.error ?? null, api?.http_status ?? 0)}
                  </Text>
                </View>
              )}
            </NeuCard>

            {/* ── D. Webhook ──────────────────────────────────────────── */}
            <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 16, gap: 8 }]}>
              <Text style={{ fontSize: 13, fontWeight: '800', color: c.text }}>Webhook</Text>
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center',
                backgroundColor: '#2DA8FF18', padding: 10, borderRadius: 10 }}>
                <ShieldCheck size={14} color="#2DA8FF" />
                <Text style={{ fontSize: 12, color: '#2DA8FF', flex: 1 }} selectable>
                  {webhook?.endpoint_url ?? '—'}
                </Text>
              </View>
              <Row label="Method" value={webhook?.method ?? 'POST'} />
              <Row label="Signature verification" value={`${webhook?.signature_header ?? 'X-VdoCipher-Signature'} (HMAC)`} />
              <Row label="Webhook secret configured on server" value={webhook?.secret_configured ? 'Yes' : 'No — events are rejected (501)'} warn={!webhook?.secret_configured} />
              {webhook?.handled_events.map((e) => (
                <Row key={e.event} label={e.event} value={e.action} />
              ))}
              <Row label="Unknown events" value={webhook?.unknown_events ?? 'Acknowledged and ignored'} />
              <Text style={{ fontSize: 11, color: '#D97706', opacity: 0.85 }}>
                {webhook?.dashboard_verification}
              </Text>
            </NeuCard>

            {/* ── E. Diagnostics footer ───────────────────────────────── */}
            <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 14, padding: 14, flexDirection: 'row', gap: 10, alignItems: 'center' }]}>
              <Activity size={15} color={c.primary} />
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.55, flex: 1 }}>
                All values are fetched live from the VdoCipher API at refresh — pull down or tap the refresh icon to re-check.
              </Text>
              {lastChecked && (
                <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>
                  Last checked: {lastChecked.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                </Text>
              )}
            </NeuCard>

          </View>
        )}
      </ScrollView>
    </View>
  );
}
