/**
 * Localized, timezone-correct date formatting for the i18n layer.
 *
 * TWO PROBLEMS THIS SOLVES
 * ────────────────────────
 * 1. UTC/LOCAL SHIFT — the PHP backend pins MySQL to UTC
 *    (backend/src/bootstrap.php, Database::instance()) and serializes
 *    DATETIME columns as `YYYY-MM-DD HH:MM:SS` with NO zone marker. V8 parses
 *    that form as LOCAL time, so every timestamp was silently shifted by the
 *    device's UTC offset (a 10:00 UTC enrollment displayed as 10:00 in Cairo,
 *    i.e. 3 hours late). `parseServerDate` treats bare server timestamps as
 *    UTC — the documented contract — while leaving explicit offsets (`Z`,
 *    `+02:00`) and date-only values untouched.
 *
 * 2. LOCALE — dates must follow the SELECTED app language, not the device
 *    locale. `ar-EG` gives Arabic month names; the `-u-nu-latn` extension keeps
 *    Latin digits, matching the app-wide "English digits only" rule in
 *    lib/utils.ts (Arabic-Indic digits are unreadable in tables and IDs).
 */
import type { Locale } from './detect';

/** Locale tags used for date rendering (Latin digits in both languages). */
export const DATE_LOCALE_TAGS: Record<Locale, string> = {
  ar: 'ar-EG-u-nu-latn',
  en: 'en-US',
};

const BARE_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parse a server timestamp without introducing a UTC→local shift.
 *
 * Accepts ISO strings with an explicit zone, server DATETIME strings without
 * one (treated as UTC), date-only strings (treated as that local calendar day,
 * which is what a birthday/schedule date means), epoch millis and Date objects.
 * Returns null for anything unparseable so a bad row renders an em dash instead
 * of "Invalid Date".
 */
export function parseServerDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());

  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const raw = String(value).trim();
  if (raw === '') return null;

  // Date-only → local calendar day (no zone math; avoids "yesterday" in
  // negative UTC offsets).
  const dateOnly = DATE_ONLY.exec(raw);
  if (dateOnly) {
    const d = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Server DATETIME without a zone marker → UTC (backend contract).
  const bare = BARE_DATETIME.exec(raw);
  let iso = raw;
  if (bare) iso = `${bare[1]}T${bare[2]}Z`;
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) && !HAS_ZONE.test(raw)) iso = `${raw}Z`;

  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface LocalizedDateOptions {
  /** 'medium' → "21 Oct 2026" (default), 'short' → "21 Oct", 'long' → full. */
  style?: 'short' | 'medium' | 'long';
  /** Include the time of day (default false). */
  withTime?: boolean;
}

/** Placeholder rendered when a value cannot be parsed. */
export const DATE_PLACEHOLDER = '—';

/** Format a server timestamp for display in the active app language. */
export function formatLocalizedDate(
  value: unknown,
  locale: Locale,
  options: LocalizedDateOptions = {},
): string {
  const date = parseServerDate(value);
  if (!date) return DATE_PLACEHOLDER;

  const tag = DATE_LOCALE_TAGS[locale] ?? DATE_LOCALE_TAGS.en;
  const style = options.style ?? 'medium';

  const dateOptions: Intl.DateTimeFormatOptions =
    style === 'short'
      ? { day: 'numeric', month: 'short' }
      : style === 'long'
        ? { day: 'numeric', month: 'long', year: 'numeric' }
        : { day: 'numeric', month: 'short', year: 'numeric' };

  if (options.withTime) {
    return date.toLocaleString(tag, { ...dateOptions, hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString(tag, dateOptions);
}
