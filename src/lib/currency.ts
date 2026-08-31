/**
 * Platform Currency Utility
 *
 * All monetary display goes through formatCurrency(). The config is loaded
 * once from system_config and cached; Super Admin can update it without
 * any code change.
 *
 * Default: Egyptian Pound (EGP), symbol ج.م, position after, 0 decimals
 * Example: formatCurrency(50)  → "50 ج.م"
 *          formatCurrency(150) → "150 ج.م"
 */

import { useEffect, useState } from 'react';
import { backendClient } from '@/client/backendClient';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CurrencyConfig {
  name: string;       // Egyptian Pound
  code: string;       // EGP
  symbol: string;     // ج.م
  decimals: number;   // 0
  position: 'before' | 'after'; // after → "50 ج.م", before → "ج.م 50"
}

export const DEFAULT_CURRENCY: CurrencyConfig = {
  name: 'Egyptian Pound',
  code: 'EGP',
  symbol: 'ج.م',
  decimals: 0,
  position: 'after',
};

// ── Module-level singleton cache ───────────────────────────────────────────────
// Avoids a DB round-trip on every screen. Cleared when admin saves new config.

let _cached: CurrencyConfig | null = null;

export function invalidateCurrencyCache() {
  _cached = null;
}

// ── DB fetch ──────────────────────────────────────────────────────────────────

export async function fetchCurrencyConfig(): Promise<CurrencyConfig> {
  if (_cached) return _cached;
  try {
    const { data } = await backendClient
      .from('system_config')
      .select('value')
      .eq('key', 'platform_currency')
      .single();
    if (data?.value && typeof data.value === 'object') {
      _cached = { ...DEFAULT_CURRENCY, ...(data.value as Partial<CurrencyConfig>) };
      return _cached;
    }
  } catch (_) {}
  return DEFAULT_CURRENCY;
}

export async function saveCurrencyConfig(config: CurrencyConfig): Promise<void> {
  await backendClient
    .from('system_config')
    .upsert({ key: 'platform_currency', value: config as unknown as Record<string, unknown> });
  _cached = config;
}

// ── Formatting ────────────────────────────────────────────────────────────────

/**
 * Format a numeric amount using the given (or default) currency config.
 *
 * formatCurrency(50)               → "50 ج.م"   (using cached/default config)
 * formatCurrency(50, cfg)          → uses provided cfg
 * formatCurrency(9.99, {decimals:2})→ "9.99 ج.م"
 */
export function formatCurrency(
  amount: number,
  config: CurrencyConfig = _cached ?? DEFAULT_CURRENCY,
): string {
  const fixed = config.decimals > 0
    ? amount.toFixed(config.decimals)
    : String(Math.round(amount));
  return config.position === 'after'
    ? `${fixed} ${config.symbol}`
    : `${config.symbol}${fixed}`;
}

/**
 * Format with thousands separator (for large revenue figures).
 * e.g. formatCurrencyLarge(12500) → "12,500 ج.م"
 * Always uses en-US locale to guarantee English digits (0-9) regardless
 * of the device's regional setting.
 */
export function formatCurrencyLarge(
  amount: number,
  config: CurrencyConfig = _cached ?? DEFAULT_CURRENCY,
): string {
  const formatted = amount.toLocaleString('en-US', {
    minimumFractionDigits: config.decimals,
    maximumFractionDigits: config.decimals,
  });
  return config.position === 'after'
    ? `${formatted} ${config.symbol}`
    : `${config.symbol}${formatted}`;
}

// ── React hook ────────────────────────────────────────────────────────────────

/**
 * Hook that provides the currency config and a ready-to-use formatter.
 * Loads from DB once per session; subsequent calls use the in-memory cache.
 *
 * const { fmt, config } = useCurrencyConfig();
 * fmt(50)  → "50 ج.م"
 */
export function useCurrencyConfig() {
  const [config, setConfig] = useState<CurrencyConfig>(_cached ?? DEFAULT_CURRENCY);

  useEffect(() => {
    if (_cached) { setConfig(_cached); return; }
    (async () => {
      const cfg = await fetchCurrencyConfig();
      setConfig(cfg);
    })();
  }, []);

  return {
    config,
    /** Format a plain monetary amount → "50 ج.م" */
    fmt: (amount: number) => formatCurrency(amount, config),
    /** Format with thousands separator → "12,500 ج.م" */
    fmtLarge: (amount: number) => formatCurrencyLarge(amount, config),
  };
}
