/**
 * Currency Settings — Super Admin only
 * Configure the platform default currency (name, code, symbol, position, decimals).
 * Changes take effect immediately across all revenue/price displays.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TextInput, ActivityIndicator,
  RefreshControl, useColorScheme, Pressable,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Coins, Save, RefreshCw } from 'lucide-react-native';
import { PageHeader } from '@/components/PageHeader';
import { NeuCard } from '@/components/NeuCard';
import { NeuButton } from '@/components/NeuButton';
import { neuColors, useLayout } from '@/lib/neu';
import {
  fetchCurrencyConfig, saveCurrencyConfig, invalidateCurrencyCache,
  formatCurrency, DEFAULT_CURRENCY, type CurrencyConfig,
} from '@/lib/currency';

export default function CurrencySettings() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const layout = useLayout();

  const [config, setConfig] = useState<CurrencyConfig>(DEFAULT_CURRENCY);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      invalidateCurrencyCache();
      const cfg = await fetchCurrencyConfig();
      setConfig(cfg);
    } catch (_) {}
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const update = (key: keyof CurrencyConfig, value: string | number) =>
    setConfig(prev => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    setError('');
    if (!config.name.trim() || !config.code.trim() || !config.symbol.trim()) {
      setError('Name, code, and symbol are required.');
      return;
    }
    setSaving(true);
    try {
      await saveCurrencyConfig(config);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to save currency settings.');
    }
    setSaving(false);
  };

  const inp = {
    backgroundColor: c.base,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    shadowColor: c.shadowDark,
    shadowOffset: { width: 2, height: 2 },
    shadowOpacity: 0.55,
    shadowRadius: 5,
    fontSize: 15,
    color: c.text,
  };

  const preview = formatCurrency(50, config);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.base }}
      contentContainerStyle={{ paddingBottom: layout.scrollBottom() }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />}
    >
      <View style={{ padding: layout.screenPx }}>
        {/* Header */}
        <PageHeader title="Platform Currency" subtitle="Configure how prices are displayed" accentColor="#D97706" />

        {loading ? (
          <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} />
        ) : (
          <>
            {/* Live Preview */}
            <NeuCard style={{ marginBottom: 24, padding: 20, alignItems: 'center' }}>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>Live Preview</Text>
              <Text style={{ fontSize: 42, fontWeight: '900', color: c.primary }}>{preview}</Text>
              <Text style={{ fontSize: 13, color: c.text, opacity: 0.45, marginTop: 6 }}>
                Code: {config.code} · {config.decimals === 0 ? 'No decimals' : `${config.decimals} decimal${config.decimals > 1 ? 's' : ''}`}
              </Text>
            </NeuCard>

            {/* Fields */}
            <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>Currency Name</Text>
            <TextInput
              value={config.name}
              onChangeText={v => update('name', v)}
              placeholder="Egyptian Pound"
              placeholderTextColor={`${c.text}55`}
              style={{ ...inp, minWidth: 0, marginBottom: 16 }}
            />

            <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>Currency Code</Text>
            <TextInput
              value={config.code}
              onChangeText={v => update('code', v.toUpperCase())}
              placeholder="EGP"
              placeholderTextColor={`${c.text}55`}
              autoCapitalize="characters"
              maxLength={5}
              style={{ ...inp, minWidth: 0, marginBottom: 16 }}
            />

            <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>Currency Symbol</Text>
            <TextInput
              value={config.symbol}
              onChangeText={v => update('symbol', v)}
              placeholder="ج.م"
              placeholderTextColor={`${c.text}55`}
              style={{ ...inp, minWidth: 0, marginBottom: 16 }}
            />

            <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>Decimal Places</Text>
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
              {[0, 1, 2].map(d => (
                <Pressable
                  key={d}
                  onPress={() => update('decimals', d)}
                  style={{
                    flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center',
                    backgroundColor: config.decimals === d ? `${c.primary}22` : c.base,
                    shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 },
                    shadowOpacity: config.decimals === d ? 0 : 0.45, shadowRadius: 5,
                    borderWidth: config.decimals === d ? 1.5 : 0,
                    borderColor: config.decimals === d ? c.primary : 'transparent',
                  }}
                >
                  <Text style={{ fontSize: 15, fontWeight: '700', color: config.decimals === d ? c.primary : c.text }}>
                    {d}
                  </Text>
                  <Text style={{ fontSize: 11, color: c.text, opacity: 0.5, marginTop: 2 }}>
                    {d === 0 ? 'None' : d === 1 ? '0.0' : '0.00'}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, opacity: 0.5, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>Symbol Position</Text>
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 24 }}>
              {(['after', 'before'] as const).map(pos => {
                const label = pos === 'after' ? 'After Amount' : 'Before Amount';
                const example = pos === 'after' ? `50 ${config.symbol}` : `${config.symbol}50`;
                return (
                  <Pressable
                    key={pos}
                    onPress={() => update('position', pos)}
                    style={{
                      flex: 1, paddingVertical: 14, borderRadius: 12, alignItems: 'center',
                      backgroundColor: config.position === pos ? `${c.primary}22` : c.base,
                      shadowColor: c.shadowDark, shadowOffset: { width: 2, height: 2 },
                      shadowOpacity: config.position === pos ? 0 : 0.45, shadowRadius: 5,
                      borderWidth: config.position === pos ? 1.5 : 0,
                      borderColor: config.position === pos ? c.primary : 'transparent',
                    }}
                  >
                    <Text style={{ fontSize: 14, fontWeight: '800', color: config.position === pos ? c.primary : c.text }}>{example}</Text>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.5, marginTop: 3 }}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Error */}
            {!!error && (
              <Text style={{ color: '#DC2626', fontSize: 13, marginBottom: 14, textAlign: 'center' }}>{error}</Text>
            )}

            {/* Save */}
            <NeuButton
              label={saved ? '✓ Saved!' : 'Save Currency Settings'}
              icon={saved ? <RefreshCw size={16} color="#fff" /> : <Save size={16} color="#fff" />}
              onPress={handleSave}
              loading={saving}
              style={{ marginBottom: 8, backgroundColor: saved ? '#16A34A' : undefined }}
            />

            {/* Info box */}
            <NeuCard style={{ marginTop: 16, padding: 16 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: c.text, marginBottom: 6 }}>How it works</Text>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.55, lineHeight: 20 }}>
                {'Monetary values are stored as plain numbers in the database. The currency symbol is only appended in the UI using this configuration.\n\nChanges apply immediately to Revenue, Pricing, Doctor Stats, and all Admin screens.'}
              </Text>
            </NeuCard>
          </>
        )}
      </View>
    </ScrollView>
  );
}
