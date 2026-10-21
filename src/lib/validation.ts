/**
 * Form validation helpers.
 * Each validator returns null on success or a human-readable error string.
 *
 * The messages are resolved through the i18n registry at CALL time (not import
 * time), so a form that is open while the user switches language re-validates
 * in the newly selected language.
 */

import { t } from '@/lib/i18n';

// ─── Primitives ───────────────────────────────────────────────────────────────

export function validateRequired(
  value: string,
  label = t('validation.thisField'),
): string | null {
  return value.trim() ? null : t('validation.requiredFor', { label });
}

export function validateEmail(value: string): string | null {
  if (!value.trim()) return t('validation.emailRequired');
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(value.trim()) ? null : t('validation.invalidEmail');
}

/** Accepts international E.164 or local formats — must have 7–15 digits after stripping symbols */
export function validatePhone(value: string): string | null {
  if (!value.trim()) return null; // phone is optional in most forms
  const digits = value.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return t('validation.invalidPhone');
  return null;
}

export function validatePassword(value: string, minLength = 8): string | null {
  if (!value) return t('validation.passwordRequired');
  if (value.length < minLength) return t('validation.passwordMin', { min: minLength });
  if (!/[A-Z]/.test(value)) return t('validation.passwordUppercase');
  if (!/[0-9]/.test(value)) return t('validation.passwordNumber');
  return null;
}

export function validatePasswordSimple(value: string): string | null {
  if (!value) return t('validation.passwordRequired');
  if (value.length < 6) return t('validation.passwordMin', { min: 6 });
  return null;
}

export function validateMatch(
  a: string,
  b: string,
  label = t('validation.passwordsLabel'),
): string | null {
  return a === b ? null : t('validation.matchFor', { label });
}

export function validateMinLength(
  value: string,
  min: number,
  label = t('validation.thisField'),
): string | null {
  return value.trim().length >= min ? null : t('validation.minLengthFor', { label, min });
}

// ─── Composite helpers ────────────────────────────────────────────────────────

/** Run multiple validators and return the first error found */
export function firstError(...results: (string | null)[]): string | null {
  return results.find(r => r !== null) ?? null;
}

/** Run multiple validators and return all errors */
export function allErrors(...results: (string | null)[]): string[] {
  return results.filter((r): r is string => r !== null);
}

// ─── Friendly error mapper ────────────────────────────────────────────────────

/**
 * Raw backend/network patterns → translation keys. The key is resolved when the
 * message is produced, so the same map serves both languages.
 */
const ERROR_MAP: Array<[RegExp, string]> = [
  [/duplicate key.*email/i,           'validation.emailExists'],
  [/duplicate key.*phone/i,           'validation.phoneExists'],
  [/duplicate key.*unique/i,          'validation.valueExists'],
  [/invalid.*email/i,                 'validation.invalidEmail'],
  [/password.*short|too.*short/i,     'validation.passwordShort'],
  [/network.*request.*failed|fetch/i, 'validation.networkLost'],
  [/jwt.*expired/i,                   'validation.sessionExpired'],
  [/permission.*denied|not.*authorized/i, 'validation.noPermission'],
  [/foreign.*key.*violation/i,        'validation.recordMissing'],
  [/not.*null.*violation/i,           'validation.fieldsMissing'],
  // MySQL (PHP backend) duplicate-entry phrasing — same friendly mapping as
  // the PG "duplicate key" patterns above.
  [/duplicate entry/i,                'validation.valueExists'],
  // Student-operations business errors (StudentController::mapPdoError + guard
  // clauses). Mapped by exact message so the doctor sees the REAL cause instead
  // of a misleading "check your credit balance" fallback.
  [/insufficient credits/i,           'validation.insufficientCredits'],
  [/already enrolled/i,               'validation.alreadyEnrolled'],
  [/course could not be found/i,      'validation.courseNotFound'],
  [/student account could not be found/i, 'validation.studentNotFound'],
  [/operation could not be completed/i, 'validation.opIncomplete'],
];

/**
 * Maps raw backend/network errors to user-friendly messages.
 * Falls back to a generic message if no pattern matches.
 *
 * NOTE on SQL_KEYWORDS: "delete" and "index" are intentionally excluded.
 * "delete" appears in legitimate business error messages from the deletion
 * pipeline (e.g. "Doctor has 2 active course(s). Archive them first.").
 * "index" is not SQL-exclusive and appears in JS stack traces.
 *
 * The filter only blocks messages that match specific PostgreSQL internal error
 * patterns — those referencing PG error codes (5-digit numbers), or containing
 * canonical PG error phrases like "violates foreign key constraint" or
 * "duplicate key value". Common English words like "from" and "table" are NOT
 * blocked because they frequently appear in legitimate business messages.
 */
export function friendlyError(
  error: unknown,
  fallback = t('validation.genericError'),
): string {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  if (!msg || msg === '[object Object]') return fallback;
  for (const [pattern, key] of ERROR_MAP) {
    if (pattern.test(msg)) return t(key);
  }
  // Block messages that are clearly raw PostgreSQL internals:
  //   - Contain a 5-digit PG error code (e.g. "23503", "42703")
  //   - Contain canonical PG error phrases that are never user-facing
  const PG_CODE    = /\b[0-9]{5}\b/;
  const PG_PHRASE  = /violates (foreign key|unique|check|not-null) constraint|duplicate key value|null value in column|invalid input (syntax|value) for type|relation .+ does not exist|column .+ of relation|operator does not exist|division by zero/i;
  // MySQL/PDO internals (PHP backend) — never surface raw SQL to users.
  // Matches SQLSTATE[42S22], "Unknown column", "Integrity constraint violation",
  // "in 'INSERT INTO'", "in 'field list'" etc. Business messages never contain
  // these; genuine conflicts are mapped earlier (see ERROR_MAP).
  const SQL_INTERNAL = /SQLSTATE\[|Unknown column|Integrity constraint violation|in 'INSERT INTO'|in 'field list'|in 'where clause'|Table .* doesn't exist/i;
  if (PG_CODE.test(msg) || PG_PHRASE.test(msg) || SQL_INTERNAL.test(msg)) return fallback;
  // Surface messages under 400 chars that passed all filters
  if (msg.length < 400) return msg;
  return fallback;
}
