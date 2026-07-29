/**
 * system-providers.tsx
 * Super Admin — System Providers screen
 * Displays all registered providers with health status, last check, capabilities.
 * Allows on-demand health check per provider or all at once.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, RefreshControl,
  ActivityIndicator, useColorScheme, TextInput,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  RefreshCw, CheckCircle, AlertTriangle, WifiOff,
  Wrench, HelpCircle, Video, HardDrive, Bell, Mail,
  MessageSquare, CreditCard, Lock, BarChart2, Bug,
  Search, Sparkles, ChevronDown, ChevronUp, Zap,
  Eye, EyeOff,
} from 'lucide-react-native';
import { neuColors, neuFlatStyle } from '@/lib/neu';
import { supabase } from '@/client/supabase';

// ── Types ─────────────────────────────────────────────────────────────────────
interface ProviderRow {
  id: string;
  category: string;
  provider_key: string;
  display_name: string;
  is_active: boolean;
  is_default: boolean;
  status: 'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown';
  status_message?: string;
  last_health_check?: string;
  version?: string;
  capabilities: string[];
  config: Record<string, unknown>;
}

// ── Category metadata ─────────────────────────────────────────────────────────
const CATEGORY_META: Record<string, { label: string; icon: any; color: string }> = {
  video:        { label: 'Video',         icon: Video,        color: '#7C3AED' },
  storage:      { label: 'Storage',       icon: HardDrive,    color: '#2DA8FF' },
  notification: { label: 'Notifications', icon: Bell,         color: '#D97706' },
  email:        { label: 'Email',         icon: Mail,         color: '#059669' },
  sms:          { label: 'SMS',           icon: MessageSquare,color: '#DC2626' },
  payment:      { label: 'Payment',       icon: CreditCard,   color: '#7C3AED' },
  auth:         { label: 'Auth',          icon: Lock,         color: '#1E90FF' },
  analytics:    { label: 'Analytics',     icon: BarChart2,    color: '#2DA8FF' },
  crash:        { label: 'Crash Reports', icon: Bug,          color: '#DC2626' },
  search:       { label: 'Search',        icon: Search,       color: '#059669' },
  ai:           { label: 'AI',            icon: Sparkles,     color: '#D97706' },
};

const STATUS_META: Record<string, { label: string; icon: any; color: string }> = {
  healthy:     { label: 'Healthy',     icon: CheckCircle,   color: '#059669' },
  warning:     { label: 'Warning',     icon: AlertTriangle, color: '#D97706' },
  offline:     { label: 'Offline',     icon: WifiOff,       color: '#DC2626' },
  maintenance: { label: 'Maintenance', icon: Wrench,        color: '#7C3AED' },
  unknown:     { label: 'Unknown',     icon: HelpCircle,    color: '#6B7280' },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function timeAgo(iso?: string): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Components ────────────────────────────────────────────────────────────────
function StatusBadge({ status, isDark }: { status: string; isDark: boolean }) {
  const meta = STATUS_META[status] ?? STATUS_META.unknown;
  const Icon = meta.icon;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3,
      backgroundColor: `${meta.color}18`, borderRadius: 20, borderWidth: 1, borderColor: `${meta.color}30` }}>
      <Icon size={11} color={meta.color} />
      <Text style={{ fontSize: 11, fontWeight: '700', color: meta.color }}>{meta.label}</Text>
    </View>
  );
}

function ProviderCard({
  provider, isDark, onCheck, checking, onToggleActive,
}: {
  provider: ProviderRow;
  isDark: boolean;
  onCheck: (key: string) => void;
  checking: boolean;
  onToggleActive: (key: string, current: boolean) => Promise<void>;
}) {
  const c = isDark ? neuColors.dark : neuColors.light;
  const [expanded, setExpanded] = useState(false);
  const [configMode, setConfigMode] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [webhook, setWebhook] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [configMsg, setConfigMsg] = useState('');
  const catMeta = CATEGORY_META[provider.category];

  const handleToggleActive = async () => {
    setToggling(true); setConfigMsg('');
    await onToggleActive(provider.provider_key, provider.is_active);
    setToggling(false);
  };

  const handleSaveConfig = async () => {
    setSaving(true); setConfigMsg('');
    try {
      const { error } = await supabase.functions.invoke('provider-health', {
        body: {
          action: 'update_config',
          provider_key: provider.provider_key,
          api_key: apiKey || undefined,
          webhook: webhook || undefined,
        },
      });
      if (error) throw error;
      setConfigMsg('✅ Config saved.');
    } catch {
      setConfigMsg('❌ Save failed.');
    }
    setSaving(false);
  };

  const handleTestConnection = async () => {
    setTesting(true); setConfigMsg('');
    try {
      const { data, error } = await supabase.functions.invoke('provider-health', {
        body: { action: 'check_one', provider_key: provider.provider_key },
      });
      if (error) throw error;
      setConfigMsg(data?.status === 'healthy' ? '✅ Connection healthy.' : `⚠️ Status: ${data?.status ?? 'unknown'}`);
    } catch {
      setConfigMsg('❌ Connection test failed.');
    }
    setTesting(false);
  };

  const handleRotateSecret = async () => {
    setRotating(true); setConfigMsg('');
    try {
      const { error } = await supabase.functions.invoke('provider-health', {
        body: { action: 'rotate_secret', provider_key: provider.provider_key },
      });
      if (error) throw error;
      setApiKey('');
      setConfigMsg('✅ Secret rotated. Enter new API key.');
    } catch {
      setConfigMsg('❌ Rotate failed.');
    }
    setRotating(false);
  };

  const inp = {
    backgroundColor: isDark ? '#1a1a2e' : '#f0f0f5',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13 as const,
    color: c.text,
  };

  return (
    <View style={[neuFlatStyle(isDark), {
      borderRadius: 14, marginBottom: 10,
      borderLeftWidth: 3,
      borderLeftColor: provider.is_active ? (catMeta?.color ?? c.primary) : `${c.text}33`,
      opacity: provider.is_active ? 1 : 0.6,
    }]}>
      {/* Header row */}
      <Pressable
        onPress={() => setExpanded((e) => !e)}
        style={{ flexDirection: 'row', alignItems: 'center', padding: 14, gap: 10 }}
      >
        <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: `${catMeta?.color ?? c.primary}18`,
          alignItems: 'center', justifyContent: 'center' }}>
          {catMeta && <catMeta.icon size={17} color={catMeta.color} />}
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{provider.display_name}</Text>
            {provider.is_default && (
              <View style={{ paddingHorizontal: 6, paddingVertical: 1, backgroundColor: `${c.primary}18`,
                borderRadius: 8, borderWidth: 1, borderColor: `${c.primary}30` }}>
                <Text style={{ fontSize: 9, fontWeight: '800', color: c.primary, textTransform: 'uppercase' }}>DEFAULT</Text>
              </View>
            )}
          </View>
          <Text style={{ fontSize: 11, color: `${c.text}70`, marginTop: 1 }}>
            Last checked: {timeAgo(provider.last_health_check)}
          </Text>
        </View>
        <StatusBadge status={provider.status} isDark={isDark} />
        {expanded ? <ChevronUp size={16} color={`${c.text}60`} /> : <ChevronDown size={16} color={`${c.text}60`} />}
      </Pressable>

      {/* Expanded details */}
      {expanded && (
        <View style={{ paddingHorizontal: 14, paddingBottom: 14, gap: 10 }}>
          {/* Status message */}
          {provider.status_message && (
            <View style={{ padding: 8, backgroundColor: `${c.text}08`, borderRadius: 8 }}>
              <Text style={{ fontSize: 12, color: `${c.text}80` }}>{provider.status_message}</Text>
            </View>
          )}

          {/* Capabilities */}
          {provider.capabilities?.length > 0 && (
            <View>
              <Text style={{ fontSize: 11, fontWeight: '700', color: `${c.text}70`, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                Capabilities
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
                {provider.capabilities.map((cap) => (
                  <View key={cap} style={{ paddingHorizontal: 7, paddingVertical: 2,
                    backgroundColor: `${c.primary}12`, borderRadius: 6, borderWidth: 1, borderColor: `${c.primary}20` }}>
                    <Text style={{ fontSize: 10, fontWeight: '600', color: c.primary }}>{cap}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* Action row: Check + Configure */}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable
              onPress={() => onCheck(provider.provider_key)}
              disabled={checking}
              style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
                paddingVertical: 8, backgroundColor: `${c.primary}15`, borderRadius: 10,
                borderWidth: 1, borderColor: `${c.primary}25`, opacity: checking ? 0.5 : 1 }}
            >
              {checking ? <ActivityIndicator size={12} color={c.primary} /> : <RefreshCw size={12} color={c.primary} />}
              <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>Check Now</Text>
            </Pressable>
            <Pressable
              onPress={() => { setConfigMode(m => !m); setConfigMsg(''); }}
              style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
                paddingVertical: 8, backgroundColor: configMode ? `#D9770618` : `${c.text}0A`,
                borderRadius: 10, borderWidth: 1, borderColor: configMode ? '#D97706' : `${c.text}18` }}
            >
              <Wrench size={12} color={configMode ? '#D97706' : `${c.text}80`} />
              <Text style={{ fontSize: 12, fontWeight: '700', color: configMode ? '#D97706' : `${c.text}80` }}>
                {configMode ? 'Close Config' : 'Configure'}
              </Text>
            </Pressable>
          </View>

          {/* Config panel */}
          {configMode && (
            <View style={{ backgroundColor: `${c.text}06`, borderRadius: 12, padding: 14, gap: 10, borderWidth: 1, borderColor: `${c.text}12` }}>
              <Text style={{ fontSize: 12, fontWeight: '800', color: c.text, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.7 }}>
                Configuration · {provider.display_name}
              </Text>

              {/* API Key */}
              <View>
                <Text style={{ fontSize: 11, fontWeight: '700', color: `${c.text}60`, marginBottom: 5 }}>API Key / Secret</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <TextInput
                    value={apiKey}
                    onChangeText={setApiKey}
                    secureTextEntry={!showKey}
                    placeholder="Enter API key (leave blank to keep existing)…"
                    placeholderTextColor={`${c.text}40`}
                    style={{ ...inp, flex: 1, minWidth: 0 }}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <Pressable onPress={() => setShowKey(s => !s)}
                    style={{ width: 36, height: 36, borderRadius: 9, backgroundColor: `${c.text}0F`, alignItems: 'center', justifyContent: 'center' }}>
                    {showKey
                      ? <EyeOff size={15} color={`${c.text}70`} />
                      : <Eye size={15} color={`${c.text}70`} />}
                  </Pressable>
                </View>
              </View>

              {/* Webhook */}
              <View>
                <Text style={{ fontSize: 11, fontWeight: '700', color: `${c.text}60`, marginBottom: 5 }}>Webhook URL (optional)</Text>
                <TextInput
                  value={webhook}
                  onChangeText={setWebhook}
                  placeholder="https://…"
                  placeholderTextColor={`${c.text}40`}
                  style={{ ...inp, minWidth: 0 }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
              </View>

              {/* Activation toggle */}
              <Pressable
                onPress={handleToggleActive}
                disabled={toggling}
                style={{
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                  paddingVertical: 10, paddingHorizontal: 12,
                  backgroundColor: provider.is_active ? '#16A34A10' : '#DC262610',
                  borderRadius: 10, borderWidth: 1,
                  borderColor: provider.is_active ? '#16A34A30' : '#DC262630',
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  {toggling
                    ? <ActivityIndicator size={14} color={provider.is_active ? '#16A34A' : '#DC2626'} />
                    : <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: provider.is_active ? '#16A34A' : '#DC2626' }} />}
                  <Text style={{ fontSize: 13, fontWeight: '700', color: provider.is_active ? '#16A34A' : '#DC2626' }}>
                    {provider.is_active ? '🟢 Enabled' : '🔴 Disabled'}
                  </Text>
                </View>
                <View style={{
                  width: 44, height: 24, borderRadius: 12, justifyContent: 'center', paddingHorizontal: 2,
                  backgroundColor: provider.is_active ? '#16A34A' : `${c.text}30`,
                }}>
                  <View style={{
                    width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff',
                    alignSelf: provider.is_active ? 'flex-end' : 'flex-start',
                  }} />
                </View>
              </Pressable>

              {/* Action buttons */}
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <Pressable onPress={handleSaveConfig} disabled={saving}
                  style={{ flex: 1, minWidth: 90, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 9, backgroundColor: '#16A34A18', borderRadius: 10, borderWidth: 1, borderColor: '#16A34A30' }}>
                  {saving ? <ActivityIndicator size={12} color="#16A34A" /> : <CheckCircle size={13} color="#16A34A" />}
                  <Text style={{ fontSize: 12, fontWeight: '700', color: '#16A34A' }}>Save</Text>
                </Pressable>
                <Pressable onPress={handleTestConnection} disabled={testing}
                  style={{ flex: 1, minWidth: 90, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 9, backgroundColor: `${c.primary}15`, borderRadius: 10, borderWidth: 1, borderColor: `${c.primary}25` }}>
                  {testing ? <ActivityIndicator size={12} color={c.primary} /> : <Zap size={13} color={c.primary} />}
                  <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary }}>Test</Text>
                </Pressable>
                <Pressable onPress={handleRotateSecret} disabled={rotating}
                  style={{ flex: 1, minWidth: 90, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 9, backgroundColor: '#D9770618', borderRadius: 10, borderWidth: 1, borderColor: '#D9770630' }}>
                  {rotating ? <ActivityIndicator size={12} color="#D97706" /> : <RefreshCw size={13} color="#D97706" />}
                  <Text style={{ fontSize: 12, fontWeight: '700', color: '#D97706' }}>Rotate</Text>
                </Pressable>
              </View>

              {/* Feedback message */}
              {configMsg ? <Text style={{ fontSize: 12, fontWeight: '600', color: configMsg.startsWith('✅') ? '#16A34A' : '#DC2626' }}>{configMsg}</Text> : null}

              {/* Provider key (read-only) */}
              <Text style={{ fontSize: 10, color: `${c.text}40`, fontFamily: 'monospace' }}>key: {provider.provider_key}</Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

// ── Summary stats ─────────────────────────────────────────────────────────────
function SummaryBar({ providers, isDark }: { providers: ProviderRow[]; isDark: boolean }) {
  const c = isDark ? neuColors.dark : neuColors.light;
  const healthy  = providers.filter((p) => p.is_active && p.status === 'healthy').length;
  const warning  = providers.filter((p) => p.is_active && p.status === 'warning').length;
  const offline  = providers.filter((p) => p.is_active && p.status === 'offline').length;
  const unknown  = providers.filter((p) => p.is_active && p.status === 'unknown').length;
  const total    = providers.filter((p) => p.is_active).length;

  const tiles = [
    { label: 'Active',   value: total,   color: c.primary },
    { label: 'Healthy',  value: healthy,  color: '#059669' },
    { label: 'Warning',  value: warning,  color: '#D97706' },
    { label: 'Offline',  value: offline,  color: '#DC2626' },
    { label: 'Unknown',  value: unknown,  color: '#6B7280' },
  ];

  return (
    <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
      {tiles.map(({ label, value, color }) => (
        <View key={label} style={[neuFlatStyle(isDark), {
          flex: 1, borderRadius: 12, paddingVertical: 10, alignItems: 'center',
        }]}>
          <Text style={{ fontSize: 20, fontWeight: '800', color }}>{value}</Text>
          <Text style={{ fontSize: 10, color: `${c.text}70`, marginTop: 1, fontWeight: '600' }}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────
export default function SystemProvidersScreen() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;

  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scanningAll, setScanningAll] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [lastScan, setLastScan] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase.functions.invoke('provider-health', {
      body: { action: 'list' },
    });
    if (data?.providers) {
      // parse capabilities from JSON strings if needed
      const rows = data.providers.map((p: any) => ({
        ...p,
        capabilities: Array.isArray(p.capabilities)
          ? p.capabilities
          : (typeof p.capabilities === 'string' ? JSON.parse(p.capabilities) : []),
      }));
      setProviders(rows);
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const handleScanAll = async () => {
    setScanningAll(true);
    await supabase.functions.invoke('provider-health', { body: { action: 'check_all' } });
    setLastScan(new Date().toISOString());
    await load();
    setScanningAll(false);
  };

  const handleCheckOne = async (providerKey: string) => {
    setChecking(providerKey);
    await supabase.functions.invoke('provider-health', {
      body: { action: 'check_one', provider_key: providerKey },
    });
    await load();
    setChecking(null);
  };

  const handleToggleActive = async (providerKey: string, currentlyActive: boolean) => {
    // Optimistic UI update
    setProviders((prev) =>
      prev.map((p) => p.provider_key === providerKey ? { ...p, is_active: !currentlyActive } : p)
    );
    const { error } = await supabase
      .from('video_provider_config')
      .update({ is_active: !currentlyActive })
      .eq('provider_key', providerKey);
    if (error) {
      // Revert on failure
      setProviders((prev) =>
        prev.map((p) => p.provider_key === providerKey ? { ...p, is_active: currentlyActive } : p)
      );
    }
  };

  const categories = ['all', ...Array.from(new Set(providers.map((p) => p.category))).sort()];
  const filtered = activeCategory === 'all'
    ? providers
    : providers.filter((p) => p.category === activeCategory);

  // Group by category
  const grouped: Record<string, ProviderRow[]> = {};
  for (const p of filtered) {
    if (!grouped[p.category]) grouped[p.category] = [];
    grouped[p.category].push(p);
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.base }}>
      {/* Header */}
      <View style={{ paddingTop: 0, paddingHorizontal: 20, paddingBottom: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Zap size={22} color={c.primary} />
            <Text style={{ fontSize: 22, fontWeight: '800', color: c.text }}>System Providers</Text>
          </View>
          <Pressable
            onPress={handleScanAll}
            disabled={scanningAll}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8,
              backgroundColor: c.primary, borderRadius: 10, opacity: scanningAll ? 0.7 : 1 }}
          >
            {scanningAll
              ? <ActivityIndicator size={14} color="#fff" />
              : <RefreshCw size={14} color="#fff" />}
            <Text style={{ fontSize: 12, fontWeight: '700', color: '#fff' }}>
              {scanningAll ? 'Scanning…' : 'Scan All'}
            </Text>
          </Pressable>
        </View>
        <Text style={{ fontSize: 13, color: `${c.text}70` }}>
          {`Provider Abstraction Layer · ${providers.length} providers registered${lastScan ? ` · Last scan ${timeAgo(lastScan)}` : ''}`}
        </Text>
      </View>

      {/* Category filter tabs */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 20, gap: 8, paddingBottom: 12 }}>
        {categories.map((cat) => {
          const meta = CATEGORY_META[cat];
          const isActive = activeCategory === cat;
          return (
            <Pressable
              key={cat}
              onPress={() => setActiveCategory(cat)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 5,
                paddingHorizontal: 12, paddingVertical: 6,
                backgroundColor: isActive ? c.primary : `${c.text}10`,
                borderRadius: 20, borderWidth: 1,
                borderColor: isActive ? c.primary : `${c.text}20` }}
            >
              {meta && <meta.icon size={12} color={isActive ? '#fff' : `${c.text}80`} />}
              <Text style={{ fontSize: 12, fontWeight: '700',
                color: isActive ? '#fff' : `${c.text}80`,
                textTransform: 'capitalize' }}>{cat}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={c.primary} />
          <Text style={{ marginTop: 12, color: `${c.text}70`, fontSize: 14 }}>Loading providers…</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
          contentInsetAdjustmentBehavior="automatic"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={c.primary} />
          }
        >
          <SummaryBar providers={providers} isDark={isDark} />

          {Object.entries(grouped).map(([category, rows]) => {
            const meta = CATEGORY_META[category];
            return (
              <View key={category} style={{ marginBottom: 20 }}>
                {/* Category header */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  {meta && (
                    <View style={{ width: 28, height: 28, borderRadius: 8,
                      backgroundColor: `${meta.color}18`, alignItems: 'center', justifyContent: 'center' }}>
                      <meta.icon size={14} color={meta.color} />
                    </View>
                  )}
                  <Text style={{ fontSize: 13, fontWeight: '800', color: c.text, textTransform: 'uppercase', letterSpacing: 0.8 }}>
                    {meta?.label ?? category}
                  </Text>
                  <View style={{ flex: 1, height: 1, backgroundColor: `${c.text}15` }} />
                  <Text style={{ fontSize: 11, color: `${c.text}50` }}>{rows.length}</Text>
                </View>

                {rows.map((p) => (
                  <ProviderCard
                    key={p.id}
                    provider={p}
                    isDark={isDark}
                    onCheck={handleCheckOne}
                    checking={checking === p.provider_key}
                    onToggleActive={handleToggleActive}
                  />
                ))}
              </View>
            );
          })}

          {/* Architecture note */}
          <View style={[neuFlatStyle(isDark), { borderRadius: 14, padding: 16, gap: 6 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Zap size={16} color={c.accent} />
              <Text style={{ fontSize: 13, fontWeight: '800', color: c.text }}>Provider Abstraction Layer</Text>
            </View>
            <Text style={{ fontSize: 12, color: `${c.text}70`, lineHeight: 18 }}>
              All platform services communicate through internal provider interfaces. Switching providers
              requires only a single registration change — no database, UI, or business logic changes needed.
            </Text>
            <Text style={{ fontSize: 11, color: `${c.text}50`, marginTop: 4 }}>
              Secrets are stored server-side only. No credentials are exposed to the client.
            </Text>
          </View>
        </ScrollView>
      )}
    </View>
  );
}
