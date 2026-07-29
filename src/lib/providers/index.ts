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

// ── Video Provider (existing registry) ───────────────────────────────────────
import { registerProvider as registerVideoLegacy, getProvider, getDefaultProvider } from '../videoProvider';
import { medAcademyProvider } from './medacademy';

// ── Master Registry ───────────────────────────────────────────────────────────
import {
  registerVideoProvider,
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
import { supabaseStorageProvider }     from './implementations/supabaseStorage';
import { expoNotificationProvider }    from './implementations/expoNotifications';
import { supabaseAuthProvider }        from './implementations/supabaseAuth';
import { postgresSearchProvider }      from './implementations/postgresSearch';
import { internalAnalyticsProvider }   from './implementations/internalAnalytics';
import { internalCrashProvider }       from './implementations/internalCrash';
import {
  stubEmailProvider,
  stubSmsProvider,
  stubPaymentProvider,
  stubAiProvider,
} from './implementations/stubProviders';

// ── Registration ──────────────────────────────────────────────────────────────

// Video — dual-register: legacy video registry + master registry
registerVideoLegacy(medAcademyProvider);
registerVideoProvider(medAcademyProvider as any);

// Active providers (current implementations)
registerStorageProvider(supabaseStorageProvider);
registerNotificationProvider(expoNotificationProvider);
registerAuthProvider(supabaseAuthProvider);
registerAnalyticsProvider(internalAnalyticsProvider);
registerCrashProvider(internalCrashProvider);
registerSearchProvider(postgresSearchProvider);

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

export { getProvider, getDefaultProvider };
export { providers, checkAllProviderHealth, listRegisteredProviders } from './registry';
