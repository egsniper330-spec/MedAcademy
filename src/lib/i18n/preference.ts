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
 * Staff console roles.
 *
 * REQUIREMENT: the Super Admin (and Admin) console is presented in ENGLISH,
 * regardless of the signed-in user's app language or device language. The
 * previous implementation left these consoles on the shared locale, so an
 * Arabic device (or an Arabic preference saved earlier) rendered the whole
 * console in Arabic — every screen, because every SA/Admin screen translates
 * through the same dictionary. There are no hardcoded Arabic UI strings in
 * those screens (verified by scan); the language simply followed the device.
 *
 * The lock is a VIEW of the language layer, not a change to the stored
 * preference: a doctor who switches to the Admin console sees English, and
 * still gets their chosen language back in the Student/Doctor UI.
 */
export const STAFF_CONSOLE_ROLES = ['super_admin', 'admin'] as const;

export type StaffConsoleRole = (typeof STAFF_CONSOLE_ROLES)[number];

/** True for the roles whose console is English-only. */
export function isStaffConsoleRole(role: string | null | undefined): role is StaffConsoleRole {
  if (!role) return false;
  return (STAFF_CONSOLE_ROLES as readonly string[]).includes(role);
}

/** The locale forced for a staff console (English). */
export const STAFF_CONSOLE_LOCALE = 'en' as const;

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
