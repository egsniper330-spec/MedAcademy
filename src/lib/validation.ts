/**
 * Form validation helpers.
 * Each validator returns null on success or a human-readable error string.
 */

// ─── Primitives ───────────────────────────────────────────────────────────────

export function validateRequired(value: string, label = 'This field'): string | null {
  return value.trim() ? null : `${label} is required.`;
}

export function validateEmail(value: string): string | null {
  if (!value.trim()) return 'Email is required.';
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(value.trim()) ? null : 'Please enter a valid email address.';
}

/** Accepts international E.164 or local formats — must have 7–15 digits after stripping symbols */
export function validatePhone(value: string): string | null {
  if (!value.trim()) return null; // phone is optional in most forms
  const digits = value.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return 'Please enter a valid phone number.';
  return null;
}

export function validatePassword(value: string, minLength = 8): string | null {
  if (!value) return 'Password is required.';
  if (value.length < minLength) return `Password must be at least ${minLength} characters.`;
  if (!/[A-Z]/.test(value)) return 'Password must contain at least one uppercase letter.';
  if (!/[0-9]/.test(value)) return 'Password must contain at least one number.';
  return null;
}

export function validatePasswordSimple(value: string): string | null {
  if (!value) return 'Password is required.';
  if (value.length < 6) return 'Password must be at least 6 characters.';
  return null;
}

export function validateMatch(a: string, b: string, label = 'Passwords'): string | null {
  return a === b ? null : `${label} do not match.`;
}

export function validateMinLength(value: string, min: number, label = 'This field'): string | null {
  return value.trim().length >= min ? null : `${label} must be at least ${min} characters.`;
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

const ERROR_MAP: Array<[RegExp, string]> = [
  [/duplicate key.*email/i,           'An account with this email already exists.'],
  [/duplicate key.*phone/i,           'This phone number is already registered.'],
  [/duplicate key.*unique/i,          'This value already exists.'],
  [/invalid.*email/i,                 'Please enter a valid email address.'],
  [/password.*short|too.*short/i,     'Password is too short.'],
  [/network.*request.*failed|fetch/i, 'Network connection lost. Please check your internet.'],
  [/jwt.*expired/i,                   'Your session has expired. Please sign in again.'],
  [/permission.*denied|not.*authorized/i, 'You do not have permission to perform this action.'],
  [/foreign.*key.*violation/i,        'Referenced record no longer exists.'],
  [/not.*null.*violation/i,           'One or more required fields are missing.'],
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
export function friendlyError(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  if (!msg || msg === '[object Object]') return fallback;
  for (const [pattern, friendly] of ERROR_MAP) {
    if (pattern.test(msg)) return friendly;
  }
  // Block messages that are clearly raw PostgreSQL internals:
  //   - Contain a 5-digit PG error code (e.g. "23503", "42703")
  //   - Contain canonical PG error phrases that are never user-facing
  const PG_CODE    = /\b[0-9]{5}\b/;
  const PG_PHRASE  = /violates (foreign key|unique|check|not-null) constraint|duplicate key value|null value in column|invalid input (syntax|value) for type|relation .+ does not exist|column .+ of relation|operator does not exist|division by zero/i;
  if (PG_CODE.test(msg) || PG_PHRASE.test(msg)) return fallback;
  // Surface messages under 400 chars that passed all filters
  if (msg.length < 400) return msg;
  return fallback;
}
