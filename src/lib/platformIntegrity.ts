/**
 * platformIntegrity — the SINGLE source of truth for the ENFORCEMENT STATUS of
 * the platform-integrity check: Google Play Integrity on Android, Apple App
 * Attest (with DeviceCheck fallback) on iOS.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Device integrity is a three-outcome problem, not a boolean:
 *
 *   1. the check RAN and the platform said the device/app is genuine;
 *   2. the check RAN and the platform reported a real integrity FAILURE;
 *   3. the check DID NOT RUN — and there are several distinct reasons why.
 *
 * Before this module the pipeline collapsed everything into one nullable
 * boolean, so "we could not check" and "we checked and it is fine" were
 * indistinguishable at the reporting layer. That is a correctness bug in
 * security reporting: an ATT&CK-relevant control that never executed must never
 * be presented as satisfied.
 *
 * ─── THE STATUS VOCABULARY ──────────────────────────────────────────────────
 *
 *   'not_checked'  — the check has not run yet this session.
 *   'passed'       — the check RAN and produced a positive verdict.
 *                    This is the ONLY status that means "verified".
 *   'failed'       — the check RAN and produced a real negative verdict.
 *                    This is the ONLY status that may block a user.
 *   'deferred'     — enforcement is INTENTIONALLY not active on the server
 *                    (e.g. App Attest verification not configured → HTTP 503).
 *                    A product decision, not a device fault. NOT a pass.
 *   'unavailable'  — the platform cannot perform the check on this device at
 *                    all (no Play Services, iOS simulator, OS too old, no
 *                    hardware key). An environment fact, not a pass.
 *   'error'        — the check was attempted but the result is INCONCLUSIVE
 *                    (network failure, timeout, unexpected server response).
 *                    Retryable; NOT a pass.
 *
 * ─── THE INVARIANTS (enforced by the helpers below, asserted by tests) ──────
 *
 *   • ONLY 'passed' counts as a verified success. `isVerifiedPass()` is the
 *     one predicate any caller may use to claim the control is satisfied.
 *   • ONLY 'failed' may block. Every non-verdict status is non-blocking, so an
 *     intentionally-deferred control cannot lock users out (and equally cannot
 *     be mistaken for coverage).
 *   • A non-verdict status is NEVER silently upgraded to 'passed'.
 *   • 'deferred' is a first-class, reportable state — it must surface in
 *     diagnostics and release-readiness reporting rather than disappearing.
 *
 * This module holds no security policy of its own: it records what happened and
 * answers the two questions above. The risk weights, policies and gate
 * behaviour stay in `src/lib/security.ts` (`WEIGHTS`, `DEFAULT_POLICIES`) and
 * `src/lib/securityStateModel.ts`. Nothing here changes them.
 */

export type PlatformIntegrityPlatform = 'android' | 'ios' | 'web' | 'unknown';

export type PlatformIntegrityStatus =
  | 'not_checked'
  | 'passed'
  | 'failed'
  | 'deferred'
  | 'unavailable'
  | 'error';

export interface PlatformIntegrityRecord {
  status: PlatformIntegrityStatus;
  platform: PlatformIntegrityPlatform;
  /** Human-readable reason, safe to show in a diagnostics screen. */
  detail: string | null;
  /** Epoch ms of the last status write, or null when never checked. */
  updatedAt: number | null;
}

/**
 * Statuses that represent a COMPLETED VERIFICATION — i.e. the platform actually
 * returned a verdict we can act on. Everything else means "we do not know".
 */
export const VERIFIED_STATUSES: readonly PlatformIntegrityStatus[] = ['passed', 'failed'];

/**
 * Statuses that mean the control produced NO verified result and enforcement
 * coverage is therefore absent for this device. Reported explicitly so a
 * deferred/unavailable control is visible in release-readiness reporting instead
 * of vanishing into a neutral null.
 */
export const NON_VERDICT_STATUSES: readonly PlatformIntegrityStatus[] = [
  'not_checked',
  'deferred',
  'unavailable',
  'error',
];

const INITIAL: PlatformIntegrityRecord = {
  status: 'not_checked',
  platform: 'unknown',
  detail: null,
  updatedAt: null,
};

let _record: PlatformIntegrityRecord = { ...INITIAL };

/** Infer the current platform without importing react-native (test-friendly). */
export function platformFromProcessEnv(): PlatformIntegrityPlatform {
  const os = typeof process !== 'undefined' ? process.env?.EXPO_OS : undefined;
  if (os === 'android' || os === 'ios' || os === 'web') return os;
  return 'unknown';
}

/** Record the outcome of one integrity attempt. Last write wins. */
export function recordPlatformIntegrity(input: {
  status: PlatformIntegrityStatus;
  platform?: PlatformIntegrityPlatform;
  detail?: string | null;
  now?: number;
}): PlatformIntegrityRecord {
  _record = {
    status: input.status,
    platform: input.platform ?? platformFromProcessEnv(),
    detail: input.detail ?? null,
    updatedAt: input.now ?? Date.now(),
  };
  return _record;
}

export function getPlatformIntegrity(): PlatformIntegrityRecord {
  return { ..._record };
}

export function resetPlatformIntegrity(): void {
  _record = { ...INITIAL };
}

/**
 * TRUE only when the platform performed the check and returned a positive
 * verdict. This is the single predicate that may be used to claim the control
 * is satisfied — 'deferred' / 'unavailable' / 'error' / 'not_checked' are NOT
 * progress and must never be treated as a pass.
 */
export function isVerifiedPass(record: PlatformIntegrityRecord = _record): boolean {
  return record.status === 'passed';
}

/**
 * TRUE only for a REAL verification failure. Only this may drive a blocking
 * finding — a deferred or failed-to-run check is never a reason to block (and
 * is never a reason to trust the device either).
 */
export function isVerifiedFailure(record: PlatformIntegrityRecord = _record): boolean {
  return record.status === 'failed';
}

/** TRUE when the check must be represented as NOT VERIFIED in reporting. */
export function isUnverified(record: PlatformIntegrityRecord = _record): boolean {
  return (NON_VERDICT_STATUSES as readonly string[]).includes(record.status);
}

export function isDeferred(record: PlatformIntegrityRecord = _record): boolean {
  return record.status === 'deferred';
}

/**
 * Classify a client-side integrity error into a reportable status.
 *
 * The important rule: an HTTP 503 from the App Attest verification endpoint
 * means the server deliberately has enforcement OFF ('not configured'). That is
 * a PRODUCT DECISION, so it is recorded as 'deferred' — explicitly distinct
 * from both a pass and a device failure — and is non-blocking.
 *
 * A 503 that is actually the server-wide maintenance gate is NOT a deferral
 * decision, so it stays 'error' (inconclusive, retryable).
 */
export function classifyIntegrityError(
  error: unknown,
  platform: PlatformIntegrityPlatform = platformFromProcessEnv(),
): { status: PlatformIntegrityStatus; detail: string } {
  const err = (error ?? {}) as { status?: number; code?: string; message?: string };
  const status = typeof err.status === 'number' ? err.status : undefined;
  const code = typeof err.code === 'string' ? err.code : undefined;
  const message = typeof err.message === 'string' ? err.message : '';

  const isMaintenance =
    code === 'maintenance_mode' || /maintenance/i.test(code ?? '') || /maintenance/i.test(message);

  if (!isMaintenance && (status === 501 || status === 503)) {
    return {
      status: 'deferred',
      detail: `Server verification not configured (HTTP ${status}) — enforcement intentionally inactive, NOT a pass`,
    };
  }

  if (status !== undefined) {
    return {
      status: 'error',
      detail: `Verification could not complete (HTTP ${status}) — inconclusive, NOT a pass`,
    };
  }

  return {
    status: 'error',
    detail: `Verification could not complete (network/timeout) on ${platform} — inconclusive, NOT a pass`,
  };
}

/** Short human label for diagnostics and reports. */
export function platformIntegrityLabel(status: PlatformIntegrityStatus): string {
  switch (status) {
    case 'passed':      return 'PASS';
    case 'failed':      return 'FAIL';
    case 'deferred':    return 'DEFERRED / NOT VERIFIED';
    case 'unavailable': return 'UNAVAILABLE / NOT VERIFIED';
    case 'error':       return 'INCONCLUSIVE / NOT VERIFIED';
    case 'not_checked': return 'NOT CHECKED';
  }
}

/**
 * One-line, report-ready description. Deliberately PHRASED as
 * "NOT VERIFIED" — never as a bare "OK" — for every non-verdict status so a
 * release-readiness report cannot misread a deferred control as coverage.
 */
export function describePlatformIntegrity(record: PlatformIntegrityRecord = _record): string {
  const label = platformIntegrityLabel(record.status);
  const where = record.platform === 'unknown' ? '' : ` (${record.platform})`;
  const reason = record.detail ? ` — ${record.detail}` : '';
  return `${label}${where}${reason}`;
}
