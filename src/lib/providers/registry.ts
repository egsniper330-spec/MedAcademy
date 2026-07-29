/**
 * registry.ts
 * Master Provider Registry
 *
 * The single source of truth for ALL platform providers.
 * Every module requests a provider through this registry —
 * never instantiate provider implementations directly.
 *
 * Usage:
 *   import { providers } from '@/lib/providers/registry';
 *   await providers.storage().upload('bucket', 'path', blob);
 *   await providers.notification().sendToUser(token, payload);
 *
 * Adding a new provider:
 *   1. Implement the interface in implementations/<name>.ts
 *   2. Register it via register<Category>Provider()
 *   3. No other code changes needed
 */

import type { VideoProvider }        from '../videoProvider';
import type { StorageProvider }      from './storageProvider';
import type { NotificationProvider } from './notificationProvider';
import type { EmailProvider }        from './emailProvider';
import type { SmsProvider }          from './smsProvider';
import type { PaymentProvider }      from './paymentProvider';
import type { AuthProvider }         from './authProvider';
import type { AnalyticsProvider }    from './analyticsProvider';
import type { CrashProvider }        from './crashProvider';
import type { SearchProvider }       from './searchProvider';
import type { AiProvider }           from './aiProvider';

// ─── Registry State ───────────────────────────────────────────────────────────

const _registry: {
  video?:        VideoProvider;
  storage?:      StorageProvider;
  notification?: NotificationProvider;
  email?:        EmailProvider;
  sms?:          SmsProvider;
  payment?:      PaymentProvider;
  auth?:         AuthProvider;
  analytics?:    AnalyticsProvider;
  crash?:        CrashProvider;
  search?:       SearchProvider;
  ai?:           AiProvider;
} = {};

// ─── Registration Functions ───────────────────────────────────────────────────

export function registerVideoProvider(p: VideoProvider)               { _registry.video        = p; }
export function registerStorageProvider(p: StorageProvider)           { _registry.storage      = p; }
export function registerNotificationProvider(p: NotificationProvider) { _registry.notification = p; }
export function registerEmailProvider(p: EmailProvider)               { _registry.email        = p; }
export function registerSmsProvider(p: SmsProvider)                   { _registry.sms          = p; }
export function registerPaymentProvider(p: PaymentProvider)           { _registry.payment      = p; }
export function registerAuthProvider(p: AuthProvider)                 { _registry.auth         = p; }
export function registerAnalyticsProvider(p: AnalyticsProvider)       { _registry.analytics    = p; }
export function registerCrashProvider(p: CrashProvider)               { _registry.crash        = p; }
export function registerSearchProvider(p: SearchProvider)             { _registry.search       = p; }
export function registerAiProvider(p: AiProvider)                     { _registry.ai           = p; }

// ─── Accessor Functions ───────────────────────────────────────────────────────

function getRequired<T>(key: keyof typeof _registry, name: string): T {
  const p = _registry[key];
  if (!p) throw new Error(`[ProviderRegistry] "${name}" provider not registered. Call register${name}Provider() at startup.`);
  return p as T;
}

/**
 * providers — typed accessors for all platform providers.
 * Call at module level or inside functions; never store the result long-term
 * (allows hot-swap without restarting).
 */
export const providers = {
  video:        (): VideoProvider        => getRequired('video',        'Video'),
  storage:      (): StorageProvider      => getRequired('storage',      'Storage'),
  notification: (): NotificationProvider => getRequired('notification', 'Notification'),
  email:        (): EmailProvider        => getRequired('email',        'Email'),
  sms:          (): SmsProvider          => getRequired('sms',          'Sms'),
  payment:      (): PaymentProvider      => getRequired('payment',      'Payment'),
  auth:         (): AuthProvider         => getRequired('auth',         'Auth'),
  analytics:    (): AnalyticsProvider    => getRequired('analytics',    'Analytics'),
  crash:        (): CrashProvider        => getRequired('crash',        'Crash'),
  search:       (): SearchProvider       => getRequired('search',       'Search'),
  ai:           (): AiProvider           => getRequired('ai',           'Ai'),
};

// ─── Health Check ─────────────────────────────────────────────────────────────

export type ProviderHealthMap = Record<string, {
  category: string;
  displayName: string;
  status: 'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown';
}>;

export async function checkAllProviderHealth(): Promise<ProviderHealthMap> {
  const entries = Object.entries(_registry) as [string, any][];
  const results: ProviderHealthMap = {};
  await Promise.allSettled(
    entries.map(async ([category, provider]) => {
      if (!provider) return;
      try {
        const status = await provider.checkHealth();
        results[provider.providerKey] = { category, displayName: provider.displayName, status };
      } catch {
        results[provider.providerKey ?? category] = {
          category, displayName: provider.displayName ?? category, status: 'offline',
        };
      }
    }),
  );
  return results;
}

// ─── List all registered providers ───────────────────────────────────────────

export function listRegisteredProviders() {
  return Object.entries(_registry)
    .filter(([, p]) => !!p)
    .map(([category, p]: [string, any]) => ({
      category,
      providerKey: p.providerKey,
      displayName: p.displayName,
    }));
}
