/**
 * DiagnosticStore — iOS startup sequence recorder.
 *
 * Works in RELEASE builds (no __DEV__ guard). Stores entries both:
 *   1. In-memory ring buffer (MAX_ENTRIES) — fastest, always available
 *   2. AsyncStorage (persisted) — survives process restarts if the log
 *      is written before a crash/black-screen occurs
 *
 * Usage:
 *   import { diag } from '@/lib/diagnostics';
 *   diag('SESSION_PROVIDER', 'getSession START');
 *
 * All writes are fire-and-forget (never await in hot paths). Reading is
 * synchronous from the in-memory buffer for the overlay UI.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Constants ─────────────────────────────────────────────────────────────────
const STORAGE_KEY = '__medacademy_startup_diag__';
const MAX_ENTRIES  = 120;
const FLUSH_INTERVAL_MS = 400;   // batch writes to AsyncStorage at most every 400 ms

// ── Types ─────────────────────────────────────────────────────────────────────
export interface DiagEntry {
  /** Monotonic timestamp: milliseconds since the DiagnosticStore was loaded */
  t: number;
  /** Wall-clock HH:MM:SS.mmm */
  ts: string;
  /** Short tag, e.g. "SC", "SESSION", "LAYOUT" */
  tag: string;
  /** Human-readable event label */
  msg: string;
  /** Optional extra payload (error messages, boolean flags, etc.) */
  extra?: string;
}

// ── Module-level state ────────────────────────────────────────────────────────
const _t0 = Date.now();
const _ring: DiagEntry[] = [];
let _dirty = false;
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
let _sessionId = String(Date.now()); // unique per JS process start

/** Format a Date into HH:MM:SS.mmm */
function _fmtTime(now: number): string {
  const d = new Date(now);
  return (
    String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0') + ':' +
    String(d.getSeconds()).padStart(2, '0') + '.' +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}

/** Append to the in-memory ring, schedule a debounced AsyncStorage flush. */
export function diag(tag: string, msg: string, extra?: string | null): void {
  const now = Date.now();
  const entry: DiagEntry = {
    t:  now - _t0,
    ts: _fmtTime(now),
    tag,
    msg,
    extra: extra ?? undefined,
  };

  _ring.push(entry);
  if (_ring.length > MAX_ENTRIES) _ring.splice(0, _ring.length - MAX_ENTRIES);

  _dirty = true;
  if (_flushTimer !== null) return;  // already scheduled
  _flushTimer = setTimeout(_flushToStorage, FLUSH_INTERVAL_MS);
}

/** Record a caught error. Captures message + first stack line. */
export function diagError(tag: string, label: string, err: unknown): void {
  const msg  = err instanceof Error ? err.message : String(err);
  const line = err instanceof Error ? (err.stack ?? '').split('\n')[1]?.trim() ?? '' : '';
  diag(tag, `${label}: ${msg}`, line || undefined);
}

/** Return a shallow copy of current ring buffer entries (newest last). */
export function getDiagEntries(): DiagEntry[] {
  return _ring.slice();
}

/** Clear in-memory buffer and persisted log. Useful when starting a new capture. */
export async function clearDiag(): Promise<void> {
  _ring.length = 0;
  _dirty = false;
  try { await AsyncStorage.removeItem(STORAGE_KEY); } catch (_) {}
}

/** Load the previously persisted log from AsyncStorage (call once on mount of overlay). */
export async function loadPersistedDiag(): Promise<DiagEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { sessionId?: string; entries?: DiagEntry[] };
    return parsed.entries ?? [];
  } catch (_) {
    return [];
  }
}

/** Returns the unique session ID for this JS process launch. */
export function getDiagSessionId(): string { return _sessionId; }

// ── Internal: batched AsyncStorage write ─────────────────────────────────────
function _flushToStorage(): void {
  _flushTimer = null;
  if (!_dirty) return;
  _dirty = false;
  const snapshot = { sessionId: _sessionId, entries: _ring.slice() };
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)).catch(() => {});
}

// Record the very first event — module evaluation time.
// This fires before any component mounts, proving the JS bundle started.
diag('JS', 'bundle eval — diagnostics module loaded', `sessionId=${_sessionId}`);
