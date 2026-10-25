/**
 * courseLoadError.ts — PURE classification of a failed course load.
 *
 * ── THE DEFECT THIS CLOSES ─────────────────────────────────────────────────
 * The course screen loaded its payload inside `try { … } catch {}` and rendered
 * `course === null` as "Course not found". Every failure mode therefore claimed
 * the course did not exist:
 *
 *   • a 30 s request timeout on a weak connection,
 *   • a request DEFERRED (queued) by the security lock while the device was
 *     being re-verified after a resume, refused when the deferral bound expired
 *     (`SECURITY_LOCK`),
 *   • a request aborted by containment when the app was backgrounded,
 *   • an auth-token refresh race (401 that the client recovers from),
 *   • a 5xx / 502 from the PHP backend.
 *
 * In all of those the student's enrollment was intact and the course existed.
 * Showing "Course not found" was a false statement about the account.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 * NOT-FOUND is only ever a positive statement from the server:
 *   • HTTP 404, or the adapter's no-row verdict (`PGRST116` / `not_found`),
 *   • a message that literally says the row does not exist.
 * Everything else is TRANSIENT. Of those, `retryable: false` is reserved for
 * authoritative refusals (401/403, suspended account, failed authentication):
 * retrying a policy decision automatically would be a retry storm against the
 * server, so those require an explicit user action instead.
 *
 * Dependency-free so it can be compiled and executed in plain Node
 * (tests/courseLoadFailure.test.cjs) rather than asserted from JSX text.
 */

export type CourseLoadError =
  | { kind: 'notFound' }
  | { kind: 'transient'; code?: string; status?: number; retryable: boolean };

/** Auto-retry budget for transient course-load failures (never a storm). */
export const COURSE_LOAD_AUTO_RETRIES = 2;

/** First backoff step; each subsequent attempt doubles it. */
export const COURSE_LOAD_RETRY_BASE_MS = 800;

/**
 * Classify a thrown course-load failure.
 *
 * Total: any thrown value (including `undefined`) produces a state.
 */
export function classifyCourseLoadError(e: unknown): CourseLoadError {
  const err = (e ?? {}) as { status?: unknown; code?: unknown; message?: unknown };
  const status = typeof err.status === 'number' ? err.status : undefined;
  const code = typeof err.code === 'string' ? err.code : undefined;
  const message = String(err.message ?? '');

  if (
    status === 404 ||
    code === 'not_found' ||
    code === 'PGRST116' ||
    /\b(no rows|0 rows)\b/i.test(message) ||
    /course not found/i.test(message)
  ) {
    return { kind: 'notFound' };
  }

  const authoritative =
    status === 401 ||
    status === 403 ||
    code === 'account_suspended' ||
    code === 'authentication_failed';

  return { kind: 'transient', code, status, retryable: !authoritative };
}

/**
 * True when the screen should schedule an automatic retry.
 *
 * `attempt` is the number of auto-retries ALREADY spent for this visit.
 * Content on screen, a not-found verdict, an authoritative refusal and an
 * exhausted budget all resolve to `false` — the screen then waits for the user.
 */
export function shouldAutoRetry(
  error: CourseLoadError | null,
  options: { hasContent: boolean; attempt: number },
): boolean {
  if (options.hasContent) return false; // stale-while-revalidate owns refreshes
  if (!error || error.kind !== 'transient') return false;
  if (!error.retryable) return false;
  return options.attempt < COURSE_LOAD_AUTO_RETRIES;
}

/** Backoff for the given (0-based) attempt: 800 ms, 1600 ms, … */
export function nextRetryDelayMs(attempt: number): number {
  const safe = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return COURSE_LOAD_RETRY_BASE_MS * Math.pow(2, safe);
}

/**
 * Safe diagnostics extract: HTTP status, error CODE and a SHORT message.
 *
 * The PHP client's messages are status/code text, never response bodies; the
 * length cap is a second guarantee. No token, no user id, no payload.
 */
export function sanitizeLoadError(e: unknown): { status?: number; code?: string; message: string } {
  const err = (e ?? {}) as { status?: unknown; code?: unknown; message?: unknown };
  const message = String(err.message ?? (e instanceof Error ? e.message : e) ?? 'unknown');
  return {
    status: typeof err.status === 'number' ? err.status : undefined,
    code: typeof err.code === 'string' ? err.code : undefined,
    message: message.slice(0, 160),
  };
}
