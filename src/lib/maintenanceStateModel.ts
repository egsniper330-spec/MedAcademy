/**
 * MAINTENANCE MODE state model — PURE, dependency-free (unit-testable).
 *
 * Distinguishes the four states the app must never conflate:
 *   OFFLINE      — device has no connectivity (NetInfo false/unknown). The
 *                  existing Offline Mode owns this. A 503 can NEVER mean
 *                  offline: the server REACHED us to say maintenance is on.
 *   MAINTENANCE  — server said HTTP 503 maintenance_mode, or the /maintenance
 *                  probe says enabled=true. Server-authoritative; no client
 *                  state can synthesize or bypass it.
 *   AUTH_EXPIRED — 401 after refresh failed. Existing auth policy owns this.
 *   NORMAL       — everything else.
 */

export type MaintenanceVerdict =
  | { state: 'NORMAL' }
  | { state: 'MAINTENANCE'; message: string; retryAfter: number };

/** The 503 error body contract (error.code === 'maintenance_mode'). */
export interface Maintenance503Body {
  message?: string;
  code?: string;
  maintenance?: { enabled?: boolean; message?: string; retryAfter?: number };
}

export const DEFAULT_MAINTENANCE_MESSAGE =
  'MedAcademy is temporarily unavailable while we perform maintenance.';
export const DEFAULT_RETRY_AFTER = 300;

/**
 * Is this HTTP status + parsed body the server's MAINTENANCE verdict?
 * Matches the code verbatim OR the structured maintenance meta (a proxy that
 * strips the code but keeps the meta still counts; a bare 503 with neither
 * does NOT — plain gateway 503s must not flip the whole app).
 */
export function isMaintenance503(status: number, body: Maintenance503Body | null): boolean {
  if (status !== 503) return false;
  if (body?.code === 'maintenance_mode') return true;
  return body?.maintenance?.enabled === true;
}

/** Build the verdict from a confirmed maintenance 503 body. */
export function verdictFrom503(body: Maintenance503Body | null): MaintenanceVerdict {
  const meta = body?.maintenance ?? {};
  const message =
    (typeof body?.message === 'string' && body.message.trim()) ||
    (typeof meta.message === 'string' && meta.message.trim()) ||
    DEFAULT_MAINTENANCE_MESSAGE;
  const retryAfter =
    typeof meta.retryAfter === 'number' && meta.retryAfter > 0 ? meta.retryAfter : DEFAULT_RETRY_AFTER;
  return { state: 'MAINTENANCE', message, retryAfter };
}

/** Build the verdict from the GET /maintenance status payload. */
export function verdictFromStatus(payload: { enabled?: boolean; message?: string; retryAfter?: number } | null | undefined): MaintenanceVerdict {
  if (payload?.enabled === true) {
    return {
      state: 'MAINTENANCE',
      message:
        (typeof payload.message === 'string' && payload.message.trim()) || DEFAULT_MAINTENANCE_MESSAGE,
      retryAfter:
        typeof payload.retryAfter === 'number' && payload.retryAfter > 0
          ? payload.retryAfter
          : DEFAULT_RETRY_AFTER,
    };
  }
  return { state: 'NORMAL' };
}

/**
 * Probe-scheduling policy (pure): when should the app poll GET /maintenance
 * while the maintenance screen is up? Poll every `retryAfter` (bounded to
 * [15s, 300s]) so recovery is automatic WITHOUT hammering the API.
 */
export function maintenancePollIntervalMs(retryAfter: number): number {
  return Math.min(300_000, Math.max(15_000, retryAfter * 1000));
}

/**
 * Should a probe/poll transition MAINTENANCE → NORMAL?
 * The server's explicit enabled=false is the ONLY way out (never a probe
 * failure — during maintenance the probe itself may fail transiently and that
 * must not end the maintenance state; the poll simply retries).
 */
export function nextVerdictAfterProbe(
  current: MaintenanceVerdict,
  probeOk: boolean,
  payload: { enabled?: boolean; message?: string; retryAfter?: number } | null,
): MaintenanceVerdict {
  if (!probeOk) return current;
  return verdictFromStatus(payload);
}
