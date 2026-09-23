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

/**
 * THE single typed classifier for a php.ts error shape.
 *
 * A maintenance 503 is an EXPECTED CONTROL-FLOW STATE — never an application
 * error. Callers (php.ts interceptor, getProfile, resolveEmailFromIdentifier,
 * checkRevocation, accountRefresh) use this instead of scattering ad-hoc
 * `code === 'maintenance_mode'` string checks. Classification is EXACT:
 *   • a bare 503 without the code/meta is a real server error (NOT maintenance)
 *   • a 503 with the code or the structured meta IS maintenance
 *   • everything else keeps its own path (suspension, auth, network, 4xx/5xx)
 */
export function isMaintenanceError(
  err: { status?: number; code?: string; message?: string } | null | undefined
): boolean {
  if (!err) return false;
  if (err.code === 'maintenance_mode') return true;
  // Transport-level errors carry no status — never maintenance.
  if (err.status !== 503) return false;
  return /maintenance/i.test(String(err.message ?? ''));
}

// ─── Expected-control-flow flag (canary) ─────────────────────────────────────
// Lives in this PURE module (no imports) so the transport layer (php.ts) can
// arm it SYNCHRONOUSLY the moment it detects a maintenance 503 — before the
// caller's catch block logs the error. A canary in the runtime service would
// arm asynchronously (dynamic import) and race the caller's console.error.
// Armed on every server maintenance signal; cleared when the server reports
// maintenance OFF. Suppression requires BOTH the flag and a maintenance-
// classified error — genuine failures keep their normal handling.
let maintenanceControlFlowActive = false;

export function setMaintenanceControlFlowActive(active: boolean): void {
  maintenanceControlFlowActive = active;
}

export function isMaintenanceControlFlowActive(): boolean {
  return maintenanceControlFlowActive;
}

/**
 * Should this error be treated as EXPECTED maintenance control flow
 * (silent — no red console error, no toast, no state change)?
 * True only while the server is sending maintenance signals AND the error
 * classifies as maintenance. This is THE predicate call sites use.
 */
export function isExpectedMaintenanceError(
  err: { status?: number; code?: string; message?: string } | null | undefined
): boolean {
  return maintenanceControlFlowActive && isMaintenanceError(err);
}

/**
 * BOUNDED BACKOFF — silent retry policy for the background availability
 * probe while the maintenance screen is up (pure; unit-tested).
 *
 * Fixed intervals would re-notify every poll tick; the model instead derives
 * the next wait from the attempt count, capped at MAINT_PROBE_MAX_MS. The UI
 * NEVER reflects this — it is invisible by contract.
 */
export const MAINT_PROBE_MIN_MS = 15_000;
export const MAINT_PROBE_MAX_MS = 120_000;

export function nextProbeDelayMs(attempt: number): number {
  const base = MAINT_PROBE_MIN_MS * Math.pow(2, Math.max(0, Math.min(3, attempt)));
  return Math.min(MAINT_PROBE_MAX_MS, base);
}

/**
 * SHA-256 RE-BOOTSTRAP RULE (pure decision).
 *
 * When a probe reports maintenance OFF and the session is still present, the
 * client re-runs its normal server-authoritative bootstrap (profile refresh,
 * revocation poll) instead of trusting the cached profile. That re-bootstrap
 * is what makes WHITELIST CHANGES EFFECTIVE IMMEDIATELY: a user added to the
 * whitelist passes the gate again on their next server-verified request, and
 * a removed user flips back into maintenance on theirs — no restart, no
 * logout/login. (The gate itself re-evaluates per REQUEST on the server.)
 */
export function shouldRebootstrapAfterRecovery(
  maintenanceOff: boolean,
  hasSession: boolean
): boolean {
  return maintenanceOff === true && hasSession === true;
}

/**
 * SA EXEMPTION EVIDENCE RULE (pure decision).
 *
 * The client asks GET /maintenance/whoami ONLY to decide whether to keep the
 * authenticated shell mounted behind the maintenance overlay for a session
 * that was ALREADY live when maintenance was switched on. The answer is
 * computed SERVER-SIDE from the verified profile row (role/whitelist) — the
 * client cannot forge it and never uses it to SKIP the overlay. A super_admin
 * is always server-exempt; a whitelisted user is exempt; anyone else stays on
 * the static screen. hasSession must come from the real auth pipeline.
 */
export function shouldKeepShellMountedBehindGate(
  hasSession: boolean,
  serverSaysExempt: boolean | null
): boolean {
  return hasSession === true && serverSaysExempt === true;
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

/**
 * Is a maintenance-state change worth notifying UI subscribers about?
 * The recovery poll runs in the background by contract — re-rendering the
 * (static) MaintenanceGate on every identical verdict would be churn without
 * information. Only real transitions pass through.
 */
export function shouldNotifyVerdictChange(prev: MaintenanceVerdict, next: MaintenanceVerdict): boolean {
  if (prev.state !== next.state) return true;
  if (next.state !== 'MAINTENANCE') return false;
  const p = prev as { message?: string };
  const n = next as { message?: string };
  return (p.message ?? '') !== (n.message ?? '');
}
