/**
 * FEATURE FLAGS — client side of the Super Admin feature control.
 *
 * ─── The contract (mirrors backend/src/Services/FeatureFlagService.php) ──────
 * The SERVER owns the key space and the enforcement. A flag is never UI-only:
 * every key here is also enforced on the endpoint that performs the operation
 * (403 { error: { code: 'feature_disabled', feature: '<key>' } }).
 *
 * The client's job is only to reflect the state so the user sees a coherent UI
 * (hide/disable an action that the server would refuse anyway).
 *
 * ─── Failure behaviour (deliberate) ─────────────────────────────────────────
 *   • Every flag DEFAULTS TO ENABLED. A network failure, a timeout, a malformed
 *     payload or an unknown key resolves to the default — configuration can
 *     never accidentally disable a capability for a user.
 *   • Reads are cached with a short TTL; a failure keeps serving the last known
 *     good state (or the defaults) instead of flashing an error.
 *   • Flags NEVER override a stronger policy. Maintenance, forced update,
 *     account-suspended/revoked, security gates and authorization all run
 *     BEFORE any flag, on the server, and their verdicts stand.
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '@/client/backendClient';

/** Registry mirror — keep in sync with FeatureFlagService::REGISTRY. */
export const FEATURE_FLAG_DEFAULTS: Record<string, boolean> = {
  user_registration: true,
  user_login: true,
  course_creation: true,
  doctor_course_publishing: true,
  course_enrollment: true,
  doctor_earnings: true,
  // Second-pass registry (see the platform audit report for the skipped list).
  password_reset: true,
  redeem_codes: true,
  doctor_credit_refunds: true,
  user_management: true,
  student_enrollment_credits: true,
  // Third-pass registry — video kill switches + administration surfaces.
  course_editing: true,
  video_playback: true,
  video_offline_downloads: true,
  impersonation: true,
  device_management: true,
  db_audit: true,
  trash_cleanup: true,
  violation_management: true,
  video_monitoring: true,
};

export type FeatureFlag = {
  key: string;
  label: string;
  description: string;
  category: string;
  enabled: boolean;
};

const TTL_MS = 60_000;

let cache: Record<string, boolean> | null = null;
let cacheAt = 0;
let inflight: Promise<Record<string, boolean>> | null = null;

/** Last known state, defaulted for every registered key. Used synchronously. */
export function cachedFeatureFlags(): Record<string, boolean> {
  return { ...FEATURE_FLAG_DEFAULTS, ...(cache ?? {}) };
}

/**
 * Resolve one flag SYNCHRONOUSLY from cache/defaults. Safe to call during
 * render: it never throws and never returns undefined (unknown key → true).
 */
export function isFeatureEnabled(key: string): boolean {
  const state = cachedFeatureFlags();
  return state[key] ?? true;
}

/**
 * Refresh the flag state. NEVER throws: any failure (offline, timeout,
 * malformed body, missing endpoint) keeps the previous state/defaults.
 */
export async function refreshFeatureFlags(force = false): Promise<Record<string, boolean>> {
  const fresh = cache !== null && (Date.now() - cacheAt) < TTL_MS;
  if (fresh && !force) return cachedFeatureFlags();
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const { data, error } = await apiFetch<{ flags: FeatureFlag[] }>('/platform/feature-flags');
      const list = error ? null : data?.flags;
      if (Array.isArray(list)) {
        const next: Record<string, boolean> = {};
        for (const flag of list) {
          if (!flag || typeof flag.key !== 'string') continue;
          // A non-boolean `enabled` is rejected in favour of the default.
          next[flag.key] = typeof flag.enabled === 'boolean' ? flag.enabled : true;
        }
        cache = next;
        cacheAt = Date.now();
      }
    } catch {
      // keep serving the previous state — availability first
    } finally {
      inflight = null;
    }
    return cachedFeatureFlags();
  })();

  return inflight;
}

/** Drop the cache (after a Super Admin toggle, or on account switch). */
export function invalidateFeatureFlags(): void {
  cache = null;
  cacheAt = 0;
}

/**
 * React hook — resolves the flags on mount (and on demand) without ever
 * throwing, so a config outage cannot break a screen.
 */
export function useFeatureFlags(): {
  flags: Record<string, boolean>;
  isEnabled: (key: string) => boolean;
  refresh: (force?: boolean) => Promise<Record<string, boolean>>;
} {
  const [flags, setFlags] = useState<Record<string, boolean>>(cachedFeatureFlags);

  useEffect(() => {
    let alive = true;
    void refreshFeatureFlags().then((next) => { if (alive) setFlags(next); });
    return () => { alive = false; };
  }, []);

  return {
    flags,
    isEnabled: (key: string) => flags[key] ?? true,
    refresh: async (force?: boolean) => {
      const next = await refreshFeatureFlags(force ?? true);
      setFlags(next);
      return next;
    },
  };
}

/**
 * Recognise a server refusal caused by a disabled flag:
 *   HTTP 403 { error: { code: 'feature_disabled', feature: '<key>' } }
 * Distinct from a permission error, a maintenance window or a network failure —
 * callers can render "temporarily unavailable" instead of "not allowed".
 */
export function isFeatureDisabledError(err: unknown): string | null {
  const e = err as { code?: string; status?: number; feature?: string; message?: string } | null;
  if (!e) return null;
  const code = typeof e.code === 'string' ? e.code : '';
  if (code === 'feature_disabled') return e.feature ?? 'unknown';
  // Some paths surface the code inside the message body only.
  if (e.status === 403 && typeof e.message === 'string' && e.message.includes('feature_disabled')) {
    return e.feature ?? 'unknown';
  }
  return null;
}
