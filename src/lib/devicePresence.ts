/**
 * Device presence — ONE model for every surface that shows a device's
 * online/offline state: Super Admin Manage Devices, the admin devices panel,
 * My Devices and the doctor DeviceManagerSheet.
 *
 * WHY THIS FILE EXISTS (verified root cause of the reported bug)
 * --------------------------------------------------------------
 * 1. `devices.last_active_at` is a MySQL DATETIME with no zone suffix, and the
 *    client used to do `new Date(device.last_active_at)`. A naive
 *    "2026-10-21 10:00:00.000000" is parsed by JS in the VIEWER's local zone, not
 *    UTC. In UTC+3 (Cairo) a heartbeat 1 minute old was read as 3 hours old —
 *    exactly the "says three hours when less than five minutes have passed"
 *    report — and the 5-minute `isOnline` window then called a live device
 *    offline.
 * 2. Nothing refreshed `last_active_at` while the app ran: only login/device
 *    registration wrote it. So "online" really meant "logged in recently", and a
 *    device in active use aged into "offline" five minutes after login.
 * 3. Presence was computed independently in four places with an undocumented
 *    5-minute constant, so the row badge, the per-device label and the counts
 *    could disagree, and nothing told "unknown" apart from "offline".
 *
 * THE CONTRACT NOW
 * ----------------
 * - The backend sends `last_seen_at` (ISO-8601 UTC with `Z`),
 *   `last_seen_epoch_ms`, `presence` and `server_time`; this module parses those
 *   and never re-interprets a naive string as local time.
 * - Elapsed time is measured against the SERVER clock (`setServerClock` from any
 *   response), so a skewed device clock cannot produce a wrong duration.
 * - ONLINE means: a backend-confirmed heartbeat inside `PRESENCE_ONLINE_WINDOW_MS`.
 *   Otherwise the device is OFFLINE (inferred) or UNKNOWN (no usable timestamp).
 *   An exact "went offline at" moment is NOT observable on iOS/Android, so none
 *   is ever produced or displayed.
 * - A network error changes nothing: presence is only ever derived from the last
 *   confirmed server timestamp, never from a failed request.
 *
 * Pure module (no React, no react-native imports) so the policy is unit-testable
 * in Node with the repository's existing suite conventions.
 */

export type DevicePresenceState = 'online' | 'offline' | 'unknown' | 'blocked' | 'logged_out';

/** A foreground app posts one heartbeat per interval (matches the backend). */
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 60_000;
/** 2 heartbeat intervals + jitter before a confirmed device stops being online. */
export const PRESENCE_ONLINE_WINDOW_MS = 150_000;
/** A timestamp further in the future than this cannot come from a real beat. */
export const PRESENCE_FUTURE_TOLERANCE_MS = 5 * 60_000;

/** The presence-relevant subset of a `DeviceRecord`. */
export interface DevicePresenceInput {
  status?: string | null;
  /** ISO-8601 UTC from the backend (preferred). */
  last_seen_at?: string | null;
  /** Epoch milliseconds from the backend (already unit-correct). */
  last_seen_epoch_ms?: number | null;
  /** Raw legacy column value — only parsed as a LAST resort, always as UTC. */
  last_active_at?: string | null;
}

export interface DevicePresence {
  state: DevicePresenceState;
  /** Epoch ms of the last CONFIRMED online event, or null when unknown. */
  lastSeenMs: number | null;
  /** True when `state` was derived from a real timestamp (not invented). */
  observed: boolean;
}

/* ─────────────────────────── server clock ──────────────────────────────── */

let serverOffsetMs = 0;

/**
 * Anchor the server clock from a response (`server_epoch_ms`). Every presence
 * computation afterwards measures elapsed time against the server, so a device
 * whose own clock is wrong still shows the right duration.
 */
export function setServerClock(serverEpochMs: number | null | undefined, deviceNowMs: number = Date.now()): void {
  if (typeof serverEpochMs !== 'number' || !Number.isFinite(serverEpochMs) || serverEpochMs <= 0) return;
  serverOffsetMs = serverEpochMs - deviceNowMs;
}

/** Current server time in epoch ms (device clock + measured offset). */
export function getServerNow(deviceNowMs: number = Date.now()): number {
  return deviceNowMs + serverOffsetMs;
}

/** Test hook: forget any measured offset. */
export function resetServerClock(): void {
  serverOffsetMs = 0;
}

/** Measured offset, exposed for diagnostics/tests. */
export function getServerClockOffsetMs(): number {
  return serverOffsetMs;
}

/* ────────────────────────── timestamp parsing ──────────────────────────── */

const NAIVE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,6}))?$/;
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parse a backend timestamp to epoch ms, or null when it is missing/invalid.
 *
 * - ISO-8601 with `Z`/offset → Date.parse (unambiguous).
 * - Naive "YYYY-MM-DD HH:MM:SS[.ffffff]" → treated as UTC (the column is UTC by
 *   policy). NEVER as local time — that was the bug.
 * - Numeric strings/numbers → epoch seconds (10 digits) or milliseconds
 *   (13 digits); this is the seconds-vs-milliseconds guard.
 * - Empty / garbage / non-finite → null, which renders as "unknown".
 */
export function parseServerTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? normaliseEpochNumber(value) : null;
  }

  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw === '') return null;

  // Numeric string: epoch seconds or milliseconds.
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? normaliseEpochNumber(n) : null;
  }

  // Naive DATETIME → declare it UTC instead of letting the engine guess local.
  const naive = NAIVE_DATETIME.exec(raw);
  if (naive && !HAS_ZONE.test(raw)) {
    const [, y, mo, d, h, mi, s, frac] = naive;
    const ms = Date.UTC(
      Number(y), Number(mo) - 1, Number(d),
      Number(h), Number(mi), Number(s ?? '0'),
      frac ? Number(frac.padEnd(6, '0').slice(0, 3)) : 0,
    );
    return Number.isFinite(ms) ? ms : null;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 10-digit values are seconds (2026 ≈ 1.8e9); 13-digit values are ms. */
function normaliseEpochNumber(value: number): number {
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
}

/* ───────────────────────────── presence ────────────────────────────────── */

/**
 * Derive the presence of a device from its last CONFIRMED timestamp.
 *
 * `status` wins for blocked/logged-out devices: they are not "unknown", they
 * simply cannot be online. Everything else is a function of elapsed time against
 * the server clock, inside the documented window.
 */
export function getPresence(
  device: DevicePresenceInput,
  opts: { nowMs?: number } = {},
): DevicePresence {
  const status = (device.status ?? 'active').toLowerCase();

  if (status === 'blocked') return { state: 'blocked', lastSeenMs: lastSeenOf(device), observed: true };
  if (status === 'logged_out') return { state: 'logged_out', lastSeenMs: lastSeenOf(device), observed: true };

  const lastSeenMs = lastSeenOf(device);
  if (lastSeenMs === null) return { state: 'unknown', lastSeenMs: null, observed: false };

  const nowMs = opts.nowMs ?? getServerNow();
  const elapsed = nowMs - lastSeenMs;

  // A beat that claims to be far in the future is not a beat we can trust
  // (legacy row written with the server's local zone, or a clock jump).
  if (elapsed < -PRESENCE_FUTURE_TOLERANCE_MS) {
    return { state: 'unknown', lastSeenMs, observed: false };
  }

  return {
    state: elapsed <= PRESENCE_ONLINE_WINDOW_MS ? 'online' : 'offline',
    lastSeenMs,
    observed: true,
  };
}

function lastSeenOf(device: DevicePresenceInput): number | null {
  const direct = parseServerTimestamp(device.last_seen_epoch_ms);
  if (direct !== null) return direct;
  return parseServerTimestamp(device.last_seen_at) ?? parseServerTimestamp(device.last_active_at);
}

/* ─────────────────────────── label composition ─────────────────────────── */

export type PresenceTranslate = (key: string, params?: Record<string, string | number>) => string;
export type PresenceTranslateCount = (key: string, count: number, params?: Record<string, string | number>) => string;

/** Translation key for the badge/label of a presence state. */
export function presenceLabelKey(state: DevicePresenceState): string {
  switch (state) {
    case 'online': return 'device.presence.onlineNow';
    case 'blocked': return 'device.presence.blocked';
    case 'logged_out': return 'device.presence.loggedOut';
    case 'offline': return 'device.presence.offline';
    default: return 'device.presence.unknown';
  }
}

/** Split an elapsed duration into the unit the UI formats (never negative). */
export function elapsedParts(elapsedMs: number): { unit: 'now' | 'minutes' | 'hours' | 'days'; count: number } {
  const ms = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  if (ms < 60_000) return { unit: 'now', count: 0 };
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return { unit: 'minutes', count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: 'hours', count: hours };
  return { unit: 'days', count: Math.floor(hours / 24) };
}

/**
 * Localized relative phrase: «الآن» / «قبل ٥ دقائق» / "5 min ago".
 * Uses the plural-aware keys, so Arabic picks the right form for 2 / 3–10 / 11+.
 */
export function formatRelativePresence(
  elapsedMs: number,
  t: PresenceTranslate,
  tCount: PresenceTranslateCount,
): string {
  const { unit, count } = elapsedParts(elapsedMs);
  if (unit === 'now') return t('device.justNow');
  if (unit === 'minutes') return tCount('device.ago.minutes', count);
  if (unit === 'hours') return tCount('device.ago.hours', count);
  return tCount('device.ago.days', count);
}

/**
 * Absolute timestamp in the VIEWER's timezone (the parsed instant is UTC, so the
 * displayed clock time is local by construction). Numbers stay LTR/grouped the
 * same way as the rest of the admin UI.
 */
export function formatAbsoluteTimestamp(epochMs: number): string {
  try {
    return new Date(epochMs).toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return new Date(epochMs).toISOString();
  }
}

/**
 * The single, non-contradictory status line for a device.
 *
 * Online  → "Online now" (no "offline for …" text at all)
 * Offline → "Last seen 5 min ago" (inferred: we do not know WHEN it went offline)
 * Unknown → "Presence unknown"
 * Blocked / logged out → their own state, never a duration.
 */
export function formatPresenceLine(
  presence: DevicePresence,
  t: PresenceTranslate,
  tCount: PresenceTranslateCount,
  opts: { nowMs?: number } = {},
): string {
  if (presence.state === 'blocked' || presence.state === 'logged_out' || presence.state === 'unknown') {
    return t(presenceLabelKey(presence.state));
  }
  if (presence.state === 'online') return t('device.presence.onlineNow');
  const nowMs = opts.nowMs ?? getServerNow();
  const relative = formatRelativePresence(nowMs - (presence.lastSeenMs ?? nowMs), t, tCount);
  return t('device.lastSeenWithTime', { when: relative });
}
