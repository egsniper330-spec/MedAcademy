/**
 * preference.ts — PURE app-language preference model.
 *
 * Kept free of `react-native`, `expo-localization` and storage imports so the
 * precedence rules can be unit tested in plain Node (same rule as ./detect.ts).
 * The device-facing half — reading/writing AsyncStorage and applying the
 * resolved locale — lives in ./index.ts.
 *
 * PRECEDENCE (the whole point of this module):
 *   1. An explicit saved app-language override wins ('ar' / 'en').
 *   2. Otherwise the device's preferred languages decide.
 *   3. An unsupported device language falls back to English.
 *
 * `'system'` (the default) is stored as the ABSENCE of a preference: choosing
 * it removes the key, so "follow the device" cannot drift out of sync with the
 * device language while an override is cleared.
 */

import { resolveLocale, type Locale } from './detect';

export { isRTLLocale } from './detect';

/**
 * The user-facing choices:
 *  - `system` — follow the device language (default; no stored override)
 *  - `ar` / `en` — always use that language, regardless of the device
 */
export type LanguagePreference = 'system' | 'ar' | 'en';

/** Every preference value the UI can offer. */
export const LANGUAGE_PREFERENCES: readonly LanguagePreference[] = ['system', 'ar', 'en'];

/** AsyncStorage key holding the manual override (absent = follow the device). */
export const LANGUAGE_PREFERENCE_STORAGE_KEY = '@medacademy/app_language';

/**
 * Parse anything that came out of storage (or a URL/config) into a preference.
 * Invalid, legacy or corrupted values return `null`, which callers treat as
 * "no override" — a bad value must never crash or lock the app into a language.
 */
export function parsePreference(raw: unknown): LanguagePreference | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value === 'system' || value === 'ar' || value === 'en') return value;
  // Tolerate the explicit "no override" sentinel some builds may have written.
  if (value === '' || value === 'device' || value === 'auto') return 'system';
  return null;
}

/**
 * Resolve the effective locale.
 *
 * @param storedPreference parsed preference (`null` when absent/invalid)
 * @param deviceLanguageTags ordered device language tags (most preferred first)
 */
export function effectiveLocale(
  storedPreference: LanguagePreference | null | undefined,
  deviceLanguageTags: readonly (string | null | undefined)[],
): Locale {
  if (storedPreference === 'ar' || storedPreference === 'en') return storedPreference;
  // No override → device detection, which itself falls back to English.
  return resolveLocale(deviceLanguageTags);
}
