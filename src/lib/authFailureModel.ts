/**
 * Canonical auth-failure classification — ONE vocabulary for every decision
 * that can terminate a session (refresh interceptor, foreground refresh,
 * revocation poll, security/maintenance gates).
 *
 * INVARIANT (pinned by tests/authFailureModel.test.cjs):
 *   Only DEFINITIVE_* kinds may clear the stored session.
 *   NETWORK_ERROR / TIMEOUT / SERVER_5XX / OFFLINE / SECURITY_UNKNOWN /
 *   MAINTENANCE / UPDATE_REQUIRED are TRANSIENT — they must preserve the
 *   session so a temporary outage can never log the user out.
 *
 * Historical root cause this model prevents: a foreground refresh that hit a
 * network error (or a 5xx) was treated as an auth failure and cleared a
 * perfectly valid session ("logged out after a short period" bug).
 */

export type AuthFailureKind =
  // Definitive — the server has spoken about THIS credential and refused it.
  | 'AUTH_INVALID' // 401 with no recoverable credential (bad token, expired & unrefreshable)
  | 'AUTH_REVOKED' // server explicitly revoked the session/device trust
  | 'ACCOUNT_BLOCKED' // 403 from an auth endpoint (suspended/banned)
  | 'SESSION_EXPIRED' // 401 on the refresh endpoint itself (refresh token dead)
  // Transient — the outcome of the auth check is simply UNKNOWN.
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'OFFLINE'
  | 'SERVER_5XX'
  | 'SECURITY_UNKNOWN' // security check could not complete
  | 'SECURITY_BLOCKED' // security gate actively denied (handled by its own gate, not session clearing)
  | 'MAINTENANCE' // maintenance gate: expected control flow, session stays
  | 'UPDATE_REQUIRED'; // update gate: blocks UI, never the session

export type AuthFailureScope = 'definitive' | 'transient';

const DEFINITIVE: ReadonlySet<AuthFailureKind> = new Set<AuthFailureKind>([
  'AUTH_INVALID',
  'AUTH_REVOKED',
  'ACCOUNT_BLOCKED',
  'SESSION_EXPIRED',
]);

export function isDefinitiveAuthFailure(kind: AuthFailureKind): boolean {
  return DEFINITIVE.has(kind);
}

export function authFailureScope(kind: AuthFailureKind): AuthFailureScope {
  return isDefinitiveAuthFailure(kind) ? 'definitive' : 'transient';
}

/**
 * Map an HTTP status from an AUTH endpoint (login/refresh/verify — i.e. a
 * response about the credential itself) to its failure kind.
 * Any non-definitive status (network → undefined, 5xx, 429 …) is transient.
 */
export function classifyAuthHttpStatus(status: number | undefined | null): AuthFailureKind {
  if (status === 401) return 'SESSION_EXPIRED';
  if (status === 403) return 'ACCOUNT_BLOCKED';
  if (status === 400 || status === 422) return 'AUTH_INVALID';
  if (status != null && status >= 500) return 'SERVER_5XX';
  if (status === 429) return 'SERVER_5XX'; // rate limit — retryable, never logout
  return 'NETWORK_ERROR'; // undefined status = request never completed
}

/**
 * Should this failure clear the stored session?
 * The single gate every session-terminating call site must consult.
 */
export function shouldClearSession(kind: AuthFailureKind): boolean {
  return isDefinitiveAuthFailure(kind);
}
