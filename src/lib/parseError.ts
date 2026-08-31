/**
 * parseError — production-safe error extractor.
 * Converts ANY thrown value (Error, backend error envelope, plain string,
 * unknown object) into a human-readable string.
 * Never returns "[object Object]".
 */
import { friendlyError } from '@/lib/validation';

export function parseError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (err == null) return fallback;

  // Standard Error object
  if (err instanceof Error) return friendlyError(err, fallback);

  // Backend/API errors may arrive as { message, details, hint, code }
  if (typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const msg =
      (typeof e.message === 'string' && e.message) ||
      (typeof e.details === 'string' && e.details) ||
      (typeof e.hint   === 'string' && e.hint)   ||
      (typeof e.error  === 'string' && e.error);
    if (msg) return friendlyError(new Error(msg), fallback);

    // Last resort — JSON stringify but never show raw [object Object]
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}') return friendlyError(new Error(json), fallback);
    } catch (_) {}
    return fallback;
  }

  // Primitive string
  if (typeof err === 'string') {
    const trimmed = err.trim();
    if (trimmed && trimmed !== '[object Object]') return friendlyError(new Error(trimmed), fallback);
  }

  return fallback;
}

/** Console-log the raw error for internal debugging, return friendly string */
export function logAndParse(err: unknown, context = 'error', fallback?: string): string {
  console.error(`[${context}]`, err);
  return parseError(err, fallback);
}
