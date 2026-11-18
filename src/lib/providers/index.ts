/**
 * src/lib/providers/index.ts
 * Master provider registry initializer.
 *
 * Import this ONCE at app startup (src/app/_layout.tsx).
 * After this runs, every module can call providers.<category>() safely.
 *
 * To swap a provider:
 *   1. Implement the interface in implementations/<newProvider>.ts
 *   2. Replace the register call below — zero other changes needed.
 */

// ── Video providers ───────────────────────────────────────────────────────────
// No video provider is registered: playback is YouTube/Plyr-only since the
// VdoCipher retirement (commit 269c806). `src/lib/videoProvider.ts` is kept as a
// types-only contract; nothing may register a provider that calls a VdoCipher
// endpoint again.

// ── Master Registry ───────────────────────────────────────────────────────────
import {
  registerStorageProvider,
  registerNotificationProvider,
  registerEmailProvider,
  registerSmsProvider,
  registerPaymentProvider,
  registerAuthProvider,
  registerAnalyticsProvider,
  registerCrashProvider,
  registerSearchProvider,
  registerAiProvider,
} from './registry';

// ── Implementations ───────────────────────────────────────────────────────────
import { backendStorageProvider }      from './implementations/phpStorage';
import { expoNotificationProvider }    from './implementations/expoNotifications';
import { backendAuthProvider }         from './implementations/phpAuth';
import { phpSearchProvider }           from './implementations/phpSearch';
import { internalAnalyticsProvider }   from './implementations/internalAnalytics';
import { internalCrashProvider }       from './implementations/internalCrash';
import {
  stubEmailProvider,
  stubSmsProvider,
  stubPaymentProvider,
  stubAiProvider,
} from './implementations/stubProviders';

// ── Registration ──────────────────────────────────────────────────────────────

// Active providers (current implementations)
registerStorageProvider(backendStorageProvider);
registerNotificationProvider(expoNotificationProvider);
registerAuthProvider(backendAuthProvider);
registerAnalyticsProvider(internalAnalyticsProvider);
registerCrashProvider(internalCrashProvider);
registerSearchProvider(phpSearchProvider);

// Stub providers (future — configure credentials to activate)
registerEmailProvider(stubEmailProvider);
registerSmsProvider(stubSmsProvider);
registerPaymentProvider(stubPaymentProvider);
registerAiProvider(stubAiProvider);

// ── Future providers — swap by replacing one line above ───────────────────────
// registerStorageProvider(awsS3Provider);
// registerNotificationProvider(firebaseFcmProvider);
// registerEmailProvider(resendProvider);
// registerSmsProvider(twilioProvider);
// registerPaymentProvider(paymobProvider);
// registerAiProvider(openAiProvider);

export { providers, checkAllProviderHealth, listRegisteredProviders } from './registry';
