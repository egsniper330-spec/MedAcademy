/**
 * semver.ts — the ONE centralized semantic-version helper.
 *
 * Versions are COMPARED NUMERICALLY, per part. String comparison is a bug:
 * "1.10.0" < "1.9.0" lexicographically, but 1.10.0 > 1.9.0 semantically.
 *
 * Canonical storage form has NO leading "v" (display adds it):
 *   "V1.1.0" / "v1.1.0" / "1.1.0"  →  "1.1.0"
 *
 * Pure module (no react/expo imports) so node tests execute it directly.
 */

export const SEMVER_RE = /^\d{1,3}(?:\.\d{1,3}){2,3}$/;

/**
 * Normalize a user-entered version to canonical storage form.
 * Returns null for anything invalid — callers must treat null as a
 * validation error, never silently coerce (e.g. "1.10.0" stays "1.10.0").
 */
export function normalizeSemanticVersion(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/^v/i, '');
  if (!SEMVER_RE.test(cleaned)) return null;
  // Reject leading-zero noise like "01.2.3" — canonical numeric form only.
  const parts = cleaned.split('.');
  if (parts.some((p) => p.length > 1 && p.startsWith('0'))) return null;
  return parts.join('.');
}

/** True when the string is a valid canonical semver for this platform. */
export function isValidSemanticVersion(raw: string | null | undefined): boolean {
  return normalizeSemanticVersion(raw) !== null;
}

/**
 * Numeric per-part comparison. Never compares as strings.
 * @returns negative when a < b, 0 when equal, positive when a > b.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10));
  const pb = b.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** Display form: canonical storage + "v" prefix ("1.1.0" → "v1.1.0"). */
export function displayVersion(canonical: string): string {
  return `v${canonical.replace(/^v/i, '')}`;
}
