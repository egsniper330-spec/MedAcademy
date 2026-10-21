/**
 * detect.ts — PURE locale resolution + translation primitives.
 *
 * Kept free of `react-native` / `expo-localization` imports so it can be unit
 * tested in plain Node (the project's test suites compile TS to CJS and require
 * it) and so the fallback rules cannot depend on device runtime state.
 *
 * The device-facing half (getLocales(), I18nManager RTL, React provider) lives
 * in ./index.ts and re-exports everything here.
 */

import {
  DEFAULT_LOCALE,
  RESOURCES,
  en,
  type Locale,
} from './resources';

export { LOCALES, DEFAULT_LOCALE, RESOURCES, en, ar, type Locale } from './resources';

export type TranslationParams = Record<string, string | number>;

/**
 * Decide the app language from an ordered list of BCP-47 language tags
 * (most-preferred first), exactly as `getLocales()` returns them.
 *
 * Rules:
 *  1. THE FIRST SUPPORTED language in preference order wins.
 *  2. `ar` matches every Arabic variant (`ar`, `ar-EG`, `ar-SA`,
 *     `ar-EG-u-nu-latn`) — only the base language subtag is compared, so this
 *     is not an exact-string match.
 *  3. `en` and any other unsupported language fall back to English.
 */
export function resolveLocale(languageTags: readonly (string | null | undefined)[]): Locale {
  const normalized = languageTags
    .filter((tag): tag is string => typeof tag === 'string' && tag.length > 0)
    .map((tag) => tag.trim().toLowerCase());

  for (const tag of normalized) {
    const base = tag.split(/[-_]/)[0];
    if (base === 'ar') return 'ar';
    if (base === 'en') return 'en';
  }

  return DEFAULT_LOCALE;
}

/** Arabic script detection for locales whose language code is ambiguous. */
export function isArabicTag(languageTag: string | null | undefined): boolean {
  if (!languageTag) return false;
  const tag = languageTag.trim().toLowerCase();
  if (!tag) return false;
  const base = tag.split(/[-_]/)[0];
  if (base === 'ar') return true;
  // Script subtag (e.g. "arab") as a fallback signal.
  return /(^|[-_])arab(ic)?([-_]|$)/.test(tag);
}

/** True when `locale` is laid out right-to-left. */
export function isRTLLocale(locale: Locale): boolean {
  return locale === 'ar';
}

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * CLDR plural categories. Arabic uses all six; English uses `one`/`other`.
 * Rendered as suffixes on the base key: `home.lessonsCount.few`.
 */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/**
 * Pick the plural category for `count` in `locale` (CLDR integer rules).
 *
 * Arabic distinguishes 0 / 1 / 2 / 3–10 / 11–99 / 100+, which is exactly why
 * a single "{count} items" string cannot be correct: "2 ملفات" and "3 ملف" are
 * both wrong Arabic. Call sites use `tCount()`, which resolves the category.
 */
export function pluralCategory(locale: Locale, count: number): PluralCategory {
  const n = Math.abs(Math.trunc(count));
  if (locale !== 'ar') return n === 1 ? 'one' : 'other';
  if (n === 0) return 'zero';
  if (n === 1) return 'one';
  if (n === 2) return 'two';
  if (n % 100 >= 3 && n % 100 <= 10) return 'few';
  if (n % 100 >= 11 && n % 100 <= 99) return 'many';
  return 'other';
}

/**
 * Substitute `{name}` placeholders. Missing params leave the placeholder intact
 * (visible in dev) rather than rendering "undefined".
 */
export function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/**
 * Translate `key` in `locale`. Fallback chain: locale → English → key.
 *
 * Never throws. A key missing from a non-English locale silently uses English;
 * a key missing everywhere returns the key, which the completeness test flags
 * before it can ship.
 */
export function translate(locale: Locale, key: string, params?: TranslationParams): string {
  const primary = RESOURCES[locale]?.[key];
  if (primary !== undefined) return interpolate(primary, params);
  const fallback = en[key];
  if (fallback !== undefined) return interpolate(fallback, params);
  return key;
}

/**
 * Translate a count-bearing string through the plural categories.
 *
 * Chain: `<key>.<category>` (locale → English) → `<key>` (locale → English) →
 * key. The base-key fallback keeps older/partial dictionaries working instead
 * of rendering a raw `home.lessonsCount.few`.
 */
export function translateCount(
  locale: Locale,
  key: string,
  count: number,
  params?: TranslationParams,
): string {
  const category = pluralCategory(locale, count);
  const withCount: TranslationParams = { ...(params ?? {}), count };
  const candidate = `${key}.${category}`;

  const primary = RESOURCES[locale]?.[candidate];
  if (primary !== undefined) return interpolate(primary, withCount);
  const fallback = en[candidate];
  if (fallback !== undefined) return interpolate(fallback, withCount);
  return translate(locale, key, withCount);
}

/** English keys that Arabic is allowed to leave without Arabic script. */
export const NON_TRANSLATABLE_KEYS = new Set<string>([
  'auth.passwordPlaceholder', // bullet mask, identical in both languages
  'auth.emailOrPhonePlaceholder', // an example address/number, data-like
  'signUp.emailPlaceholder',
  'signUp.phonePlaceholder',
  'language.optionEnglish', // language endonyms are shown in their own language
  'language.optionArabic', // «العربية» is also the English-UI label
]);
