/**
 * pdfPreparation.ts — the PURE rules behind the personalized-PDF waiting
 * experience.
 *
 * WHY A MODULE
 *   Waiting for a server-generated PDF is the one place in the app where a wrong
 *   client decision looks like a broken document: give up too early and a healthy
 *   queued job is reported as a failure; poll too hard and a free shared host is
 *   hammered. Both decisions are pure arithmetic over server-reported numbers, so
 *   they live here — with no React Native imports — and are unit tested in
 *   `tests/materialPdfWaiting.test.cjs` instead of being asserted by regex.
 *
 * ── THE POLLING BUDGET IS THE WORKER SCHEDULE ───────────────────────────────
 *   A student's copy is rendered by the cron worker, NOT inside the request. The
 *   shipped cadence is five minutes, so the poll budget must outlast more than
 *   one tick: `PDF_POLL_MAX_WAIT_MS` is 15 minutes (three ticks), reached
 *   whichever comes first with `PDF_POLL_MAX_ATTEMPTS`.
 *
 *   When the budget is genuinely spent the caller shows the "still queued" state
 *   with a Check-again action. It NEVER shows a Retry (which re-queues) for a job
 *   that is still healthy — `retry_allowed` from the server is the only thing
 *   that may offer that.
 *
 * ── THE ESTIMATE IS SERVER-GROUNDED ─────────────────────────────────────────
 *   The client never invents a duration. It renders `eta_min_seconds` /
 *   `eta_max_seconds` when the server measured them, and the transparent
 *   "not available yet" fallback when it did not (`eta_*` all null).
 */

/** The precise states the queue reports (MaterialPdfQueueService::STATE_*). */
export type PdfPrepState = 'queued' | 'generating' | 'ready' | 'failed' | 'unavailable';

/** What the waiting sheet shows while the copy is not ready yet. */
export type PdfPrepPhase = 'queued' | 'generating';

// ── Polling budget ──────────────────────────────────────────────────────────

/** Never poll faster than this, whatever the server's interval says. */
export const PDF_POLL_FLOOR_MS = 5_000;
/** Longest natural (grown) interval between polls. */
export const PDF_POLL_CEILING_MS = 20_000;
/** A server `retry_after` is honoured up to this, even past the ceiling. */
export const PDF_POLL_SERVER_MAX_MS = 120_000;
/** Growth factor per poll while the copy is still pending. */
export const PDF_POLL_GROWTH = 1.6;
/**
 * HARD deferral budget: 15 minutes = three cron ticks at the verified
 * five-minute cadence. See MATERIAL_PDF_WORKER_INTERVAL_SECONDS in the backend.
 */
export const PDF_POLL_MAX_WAIT_MS = 15 * 60 * 1_000;
/** Safety net so a stuck loop cannot run forever; the deadline is the real bound. */
export const PDF_POLL_MAX_ATTEMPTS = 240;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * The next wait, in ms.
 *
 * Grows towards `PDF_POLL_CEILING_MS` from the FLOOR (not from the previous
 * value, so a dismissal/restart cannot inherit a long delay), and always honours
 * a server `retry_after` that asks for longer — that is how the server keeps a
 * student in retry backoff from being polled every few seconds.
 */
export function nextPollDelay(currentMs: number, retryAfterSeconds?: number | null): number {
  const base = clamp(
    Number.isFinite(currentMs) && currentMs > 0 ? currentMs : PDF_POLL_FLOOR_MS,
    PDF_POLL_FLOOR_MS,
    PDF_POLL_CEILING_MS,
  );
  const grown = Math.min(PDF_POLL_CEILING_MS, Math.round(base * PDF_POLL_GROWTH));
  const server = Math.round(
    clamp((Number(retryAfterSeconds) || 0) * 1_000, 0, PDF_POLL_SERVER_MAX_MS),
  );
  return clamp(Math.max(grown, server), PDF_POLL_FLOOR_MS, PDF_POLL_SERVER_MAX_MS);
}

/**
 * Has the deferral budget been spent? `attempts` and elapsed time are both
 * bounds; the first one reached stops the loop.
 */
export function pollBudgetExhausted(startedAt: number, now: number, attempts: number): boolean {
  if (attempts >= PDF_POLL_MAX_ATTEMPTS) return true;
  return now - startedAt >= PDF_POLL_MAX_WAIT_MS;
}

/** Remaining poll budget in ms (never negative) — used for messaging/tests. */
export function pollBudgetRemaining(startedAt: number, now: number): number {
  return Math.max(0, PDF_POLL_MAX_WAIT_MS - (now - startedAt));
}

// ── State interpretation ────────────────────────────────────────────────────

/**
 * Resolve the server's answer into one precise state.
 *
 * `state` is authoritative when present. Older servers only send the three-value
 * `status`, which is mapped conservatively (`preparing` → `queued`, i.e. "keep
 * waiting"), and an unrecognised answer is never treated as ready.
 */
export function normalizePrepState(
  status?: string | null,
  state?: string | null,
): PdfPrepState {
  const known: PdfPrepState[] = ['queued', 'generating', 'ready', 'failed', 'unavailable'];
  if (state && (known as string[]).includes(state)) return state as PdfPrepState;
  if (status === 'ready') return 'ready';
  if (status === 'failed') return 'failed';
  return 'queued';
}

/** Which waiting phase a pending state belongs to. */
export function phaseOf(state: PdfPrepState): PdfPrepPhase {
  return state === 'generating' ? 'generating' : 'queued';
}

/** Localized title/body for the two waiting phases. */
export function describePrep(phase: PdfPrepPhase): { titleKey: string; bodyKey: string } {
  return phase === 'generating'
    ? {
        titleKey: 'lesson.materialGeneratingTitle',
        bodyKey: 'lesson.materialGeneratingDesc',
      }
    : {
        titleKey: 'lesson.materialQueuedTitle',
        bodyKey: 'lesson.materialQueuedDesc',
      };
}

/**
 * The queue-position line, or null when it is not meaningful.
 *
 * Shown only from position 2 upwards: position 1 with nothing ahead is noise, and
 * the number is a count of jobs — never a student, a document or a path.
 */
export function queuePositionView(
  position?: number | null,
): { key: string; params: { position: number } } | null {
  if (!Number.isFinite(Number(position))) return null;
  const value = Math.floor(Number(position));
  if (value < 2) return null;
  return { key: 'lesson.materialQueuePosition', params: { position: value } };
}

// ── Estimated wait, in words ────────────────────────────────────────────────

export type EtaUnit = 'minutes' | 'hours' | 'days';

/**
 * Round a duration UP to the coarsest friendly unit: minutes below two hours,
 * hours below two days, days beyond that. Rounding up is deliberate — the
 * estimate must not promise a shorter wait than the measurement supports.
 */
export function etaUnit(seconds: number): { unit: EtaUnit; value: number } {
  const safe = Math.max(1, Math.round(seconds));
  if (safe < 7_200) return { unit: 'minutes', value: Math.max(1, Math.ceil(safe / 60)) };
  if (safe < 172_800) return { unit: 'hours', value: Math.max(1, Math.ceil(safe / 3_600)) };
  return { unit: 'days', value: Math.max(1, Math.ceil(safe / 86_400)) };
}

/**
 * The ETA line: an approximate value when both bounds round to the same number, a
 * range when they differ, and the transparent fallback when the server had no
 * measurement to give (`eta_min`/`eta_max` null or non-positive).
 */
export function describeEta(
  minSeconds?: number | null,
  maxSeconds?: number | null,
): { key: string; params?: Record<string, number> } {
  const min = Number(minSeconds);
  const max = Number(maxSeconds);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) {
    return { key: 'lesson.materialEtaUnknown' };
  }

  const low = etaUnit(Math.min(min, max));
  const high = etaUnit(Math.max(min, max));
  const suffix = high.unit.charAt(0).toUpperCase() + high.unit.slice(1);

  // Different units (e.g. 50 min → 2 h): the coarser upper bound alone is the
  // only honest single statement.
  if (low.unit !== high.unit) {
    return { key: `lesson.materialEtaApprox${suffix}`, params: { [high.unit]: high.value } };
  }
  if (low.value === high.value) {
    return { key: `lesson.materialEtaApprox${suffix}`, params: { [high.unit]: high.value } };
  }
  return {
    key: `lesson.materialEtaRange${suffix}`,
    params: { min: low.value, max: high.value },
  };
}

/** True when the server supplied a usable estimate at all. */
export function hasEta(minSeconds?: number | null, maxSeconds?: number | null): boolean {
  const min = Number(minSeconds);
  const max = Number(maxSeconds);
  return Number.isFinite(min) && Number.isFinite(max) && min > 0 && max > 0;
}
