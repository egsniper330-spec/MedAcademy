/**
 * pdfDeliveryProgress.ts — truthful progress for the personalized-PDF delivery.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The download panel used to jump to **15 %** the moment a transfer started and
 * then sit there until it hit 100 %. That number was a hardcoded placeholder:
 * on web the file was fetched with `fetch()`, which reports no byte callbacks,
 * so there was nothing real to show — and on native a missing/failed
 * `Content-Length` made the reported total 0, which the UI also rendered as a
 * stalled bar. Both cases are the same defect: a percentage that is not derived
 * from received bytes.
 *
 * This module owns the numbers the panel is allowed to show:
 *
 *   • percent  = bytesReceived / totalBytes   — only when the total is KNOWN.
 *   • unknown total → percent is `null` and the caller renders an INDETERMINATE
 *     indicator. A percentage is never invented.
 *   • progress is monotonic (peak bytes) — a retried/resumed transfer can
 *     re-report lower counters and must not rewind the bar.
 *   • the generation stage and the transfer stage are separate states, so
 *     "Preparing/Generating" is never disguised as download progress.
 *   • 100 % is not reachable from this module at all: the caller only marks the
 *     delivery complete after the file is saved and its size verified.
 *
 * Dependency-free (no React, no React Native), so `tests/pdfDeliveryProgress.test.cjs`
 * can execute it directly — same convention as `uploadProgress.ts`.
 */
import { formatByteCount, percentOf } from './uploadProgress';

export type DeliveryStage = 'preparing' | 'generating' | 'downloading' | 'saving' | 'done';

/** i18n key for each stage title. Every key exists in en AND ar. */
const STAGE_KEYS: Record<DeliveryStage, string> = {
  preparing: 'lesson.preparingPdf',
  generating: 'lesson.stageGenerating',
  downloading: 'lesson.downloadingNow',
  saving: 'lesson.stageSaving',
  done: 'lesson.downloadComplete',
};

export function deliveryStageKey(stage: DeliveryStage): string {
  return STAGE_KEYS[stage] ?? STAGE_KEYS.downloading;
}

export interface DeliverySnapshot {
  stage: DeliveryStage;
  bytesReceived: number;
  totalBytes: number;
  /** 0–100, or null when the total is unknown (⇒ indeterminate UI). */
  percent: number | null;
  /** True only when a reliable total exists. */
  determinate: boolean;
  /** Smoothed bytes/second; 0 until two samples exist. */
  speedBps: number;
  /** Seconds remaining at the smoothed speed, or null. */
  etaSeconds: number | null;
  elapsedMs: number;
}

export interface DeliveryTracker {
  setStage(stage: DeliveryStage): void;
  /** Record the total once a reliable value is known (header / progress event). */
  setTotal(totalBytes: number): void;
  snapshot(bytesReceived?: number, atMs?: number): DeliverySnapshot;
  readonly stage: DeliveryStage;
  readonly totalBytes: number;
}

/**
 * A transfer tracker with monotonic bytes and a smoothed rate.
 *
 * `smoothing` is the exponential-moving-average weight for new samples: raw
 * per-chunk rates swing wildly (0 → 3× the real rate), which made an ETA jump
 * between seconds and minutes. 0.3 keeps the number readable without lagging
 * behind a genuine stall.
 */
export function createDeliveryTracker(
  startMs: number,
  options: { totalBytes?: number; now?: () => number; smoothing?: number } = {},
): DeliveryTracker {
  const now = options.now ?? (() => Date.now());
  const smoothing = options.smoothing ?? 0.3;
  let stage: DeliveryStage = 'preparing';
  let total = Number.isFinite(options.totalBytes) && (options.totalBytes ?? 0) > 0 ? Number(options.totalBytes) : 0;
  let peakBytes = 0;
  let lastMs = startMs;
  let speedBps = 0;

  return {
    setStage(next) { stage = next; },
    setTotal(nextTotal) {
      // The wire total always beats an earlier guess, and a later `0` (a chunked
      // response that omits Content-Length) must not erase a known total.
      if (Number.isFinite(nextTotal) && nextTotal > 0) total = nextTotal;
    },
    snapshot(bytesReceived, atMs) {
      const at = atMs ?? now();
      if (typeof bytesReceived === 'number' && Number.isFinite(bytesReceived)) {
        const clamped = Math.max(0, bytesReceived);
        if (clamped > peakBytes) {
          const dt = at - lastMs;
          if (dt > 0) {
            const instant = ((clamped - peakBytes) * 1000) / dt;
            speedBps = speedBps > 0 ? speedBps * (1 - smoothing) + instant * smoothing : instant;
            lastMs = at;
          }
          peakBytes = clamped;
        }
      }
      const remaining = total - peakBytes;
      return {
        stage,
        bytesReceived: peakBytes,
        totalBytes: Math.max(0, total),
        // percentOf returns null for an unknown total — that is the signal the
        // panel uses to stop showing a number entirely.
        percent: percentOf(peakBytes, total),
        determinate: total > 0,
        speedBps: Math.round(speedBps),
        etaSeconds: speedBps > 0 && remaining > 0 ? Math.ceil(remaining / speedBps) : null,
        elapsedMs: Math.max(0, at - startMs),
      };
    },
    get stage() { return stage; },
    get totalBytes() { return total; },
  };
}

/**
 * Should the UI re-render for this sample?
 *
 * A 20 MB transfer emits hundreds of byte events; re-rendering on each one is
 * pure waste. Emit when the rounded percentage moves, or after `minIntervalMs`
 * so the byte counter and speed still tick during a slow stretch.
 */
export function shouldEmitProgress(
  previous: { percent: number | null; atMs: number } | null,
  next: DeliverySnapshot,
  atMs: number,
  minIntervalMs = 250,
): boolean {
  if (!previous) return true;
  if (next.percent === null) return atMs - previous.atMs >= minIntervalMs;
  if (previous.percent === null) return true;
  if (Math.round(next.percent) !== Math.round(previous.percent)) return true;
  return atMs - previous.atMs >= minIntervalMs;
}

/** "1.4 MB / 18 MB" when the total is known, "1.4 MB" when it is not. */
export function describeTransfer(receivedBytes: number, totalBytes: number): string {
  const received = formatByteCount(receivedBytes);
  return Number.isFinite(totalBytes) && totalBytes > 0
    ? `${received} / ${formatByteCount(totalBytes)}`
    : received;
}

/** Same, from a snapshot. */
export function describeTransferred(snapshot: DeliverySnapshot): string {
  return describeTransfer(snapshot.bytesReceived, snapshot.determinate ? snapshot.totalBytes : 0);
}

/**
 * Is the file that landed on disk the COMPLETE file the server declared?
 *
 * 100 % belongs to this answer, not to "the response finished". A download can
 * end with fewer bytes than `Content-Length` promised — a dropped connection, a
 * proxy cutting the body, a full disk — and the native path used to report
 * success on "file exists and is non-empty", which is exactly how a truncated
 * PDF reached the share sheet.
 *
 * Rules:
 *   • missing file            → never complete;
 *   • empty file              → never complete;
 *   • expected size KNOWN     → the stored size must EQUAL it (short ⇒ truncated,
 *                               long ⇒ not the document the server described);
 *   • expected size UNKNOWN   → no size claim is invented: the caller relies on
 *                               the transfer engine's own completion signal,
 *                               and only "a real, non-empty file" is asserted.
 */
export type StoredFileReason = 'ok' | 'missing' | 'empty' | 'short' | 'long';

export function verifyStoredDownload(input: {
  exists: boolean;
  storedBytes: number;
  /** 0 when the total was never known. */
  expectedBytes: number;
}): { ok: boolean; reason: StoredFileReason } {
  const stored = Number(input.storedBytes);
  const expected = Number(input.expectedBytes);
  if (!input.exists) return { ok: false, reason: 'missing' };
  if (!Number.isFinite(stored) || stored <= 0) return { ok: false, reason: 'empty' };
  if (Number.isFinite(expected) && expected > 0 && stored !== expected) {
    return { ok: false, reason: stored < expected ? 'short' : 'long' };
  }
  return { ok: true, reason: 'ok' };
}
