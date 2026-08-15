/**
 * DiagnosticStore — iOS startup sequence recorder.
 *
 * Design constraint: MUST NOT depend on React rendering being alive.
 * The DiagScreen overlay was invisible because the React render tree
 * itself was not producing any output (black screen). This version
 * writes every event directly to console.log immediately — no React,
 * no UI, no providers required.
 *
 * Three retrieval paths — all independent of the React tree:
 *
 *   A. Xcode device console (primary — always works even with black screen)
 *      Every diag() call prints: [DIAG +Nms] [TAG] message | extra
 *      Every flush prints a full snapshot:
 *        [DIAG SNAPSHOT sid=XXXXXX] [+0ms][TAG] line ...
 *
 *   B. AsyncStorage persistence (survives process death)
 *      Key: __medacademy_startup_diag__
 *      Read on next launch via React Native Debugger / Flipper storage panel,
 *      or retrieved by the DiagScreen PREV button on the next launch.
 *
 *   C. Global JS error / unhandled-rejection capture (installed at module-eval time)
 *      Catches errors that occur before any try/catch in application code.
 *
 * Works in RELEASE builds — no __DEV__ guard anywhere.
 * All console.log calls appear in Xcode → Window → Devices and Simulators →
 * device console, filterable by the prefix "[DIAG".
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Constants ─────────────────────────────────────────────────────────────────
const STORAGE_KEY       = '__medacademy_startup_diag__';
const MAX_ENTRIES       = 120;
// Flush to AsyncStorage 800 ms after the last event, AND emit a full
// console snapshot at that point so there is a complete ordered log
// in the Xcode console even if the app never reaches a stable state.
const FLUSH_INTERVAL_MS = 800;
// Emit a full console snapshot every N new events even before the flush timer.
const CONSOLE_SNAPSHOT_EVERY = 10;

// ── Types ─────────────────────────────────────────────────────────────────────
export interface DiagEntry {
  /** Monotonic ms since this module was first evaluated */
  t: number;
  /** Wall-clock HH:MM:SS.mmm */
  ts: string;
  /** Short tag: JS | LAYOUT | SESSION | SC | APP_SC | USE_SC | ERR | GLOBAL */
  tag: string;
  /** Human-readable event label */
  msg: string;
  /** Optional extra payload */
  extra?: string;
}

// ── Module-level state ────────────────────────────────────────────────────────
const _t0 = Date.now();
const _ring: DiagEntry[] = [];
let _dirty           = false;
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
let _snapshotCounter = 0;
const _sessionId     = String(_t0);

// ── Low-level console line formatter (no dependencies) ───────────────────────
function _line(e: DiagEntry): string {
  return `[+${e.t}ms][${e.ts}][${e.tag}] ${e.msg}${e.extra ? ' | ' + e.extra : ''}`;
}

// ── Format wall clock ─────────────────────────────────────────────────────────
function _fmtTime(now: number): string {
  const d = new Date(now);
  return (
    String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0') + ':' +
    String(d.getSeconds()).padStart(2, '0') + '.' +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}

// ── Core append: write to ring + emit to console immediately ─────────────────
export function diag(tag: string, msg: string, extra?: string | null): void {
  const now   = Date.now();
  const entry: DiagEntry = {
    t:     now - _t0,
    ts:    _fmtTime(now),
    tag,
    msg,
    extra: extra ?? undefined,
  };

  _ring.push(entry);
  if (_ring.length > MAX_ENTRIES) _ring.splice(0, _ring.length - MAX_ENTRIES);

  // ── A. Immediate console.log — visible in Xcode device console right now ──
  // eslint-disable-next-line no-console
  console.log(`[DIAG +${entry.t}ms] [${tag}] ${msg}${extra ? ' | ' + extra : ''}`);

  // ── B. Periodic full snapshot to console (every N events) ─────────────────
  _snapshotCounter++;
  if (_snapshotCounter % CONSOLE_SNAPSHOT_EVERY === 0) {
    _emitConsoleSnapshot('periodic');
  }

  // ── C. Schedule AsyncStorage flush ────────────────────────────────────────
  _dirty = true;
  if (_flushTimer !== null) clearTimeout(_flushTimer); // reset debounce window
  _flushTimer = setTimeout(_flushToStorage, FLUSH_INTERVAL_MS);
}

/** Record a caught error: message + first relevant stack line. */
export function diagError(tag: string, label: string, err: unknown): void {
  const msg  = err instanceof Error ? err.message : String(err);
  const line = err instanceof Error
    ? (err.stack ?? '').split('\n').find(l => l.includes('.tsx') || l.includes('.ts') || l.includes('.js'))?.trim() ?? ''
    : '';
  diag(tag, `${label}: ${msg}`, line || undefined);
}

/** Synchronous read of current ring buffer (used by DiagScreen). */
export function getDiagEntries(): DiagEntry[] {
  return _ring.slice();
}

/** Wipe ring + AsyncStorage. */
export async function clearDiag(): Promise<void> {
  _ring.length = 0;
  _dirty       = false;
  try { await AsyncStorage.removeItem(STORAGE_KEY); } catch (_) {}
}

/** Load the previously persisted log (call on DiagScreen mount). */
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

/** Unique ID for this JS process launch. */
export function getDiagSessionId(): string { return _sessionId; }

// ── Emit a complete ordered snapshot to console ───────────────────────────────
// Prefixed with [DIAG SNAPSHOT] so it can be found even if earlier lines
// scroll off the Xcode console buffer.
function _emitConsoleSnapshot(reason: string): void {
  const lines = _ring.map(_line);
  // eslint-disable-next-line no-console
  console.log(
    `[DIAG SNAPSHOT sid=${_sessionId} reason=${reason} count=${lines.length}]\n` +
    lines.join('\n')
  );
}

// ── Flush ring to AsyncStorage + emit final console snapshot ──────────────────
function _flushToStorage(): void {
  _flushTimer = null;
  if (!_dirty) return;
  _dirty = false;

  // Emit full snapshot to console at flush time — this is the most complete
  // ordered log of everything that happened since JS started.
  _emitConsoleSnapshot('flush');

  const snapshot = { sessionId: _sessionId, entries: _ring.slice() };
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL ERROR CATCHERS — installed at module-evaluation time.
// These fire for any JS error that escapes all try/catch boundaries,
// including errors during module loading or in other components.
// They have NO dependency on React, providers, or any app logic.
// ─────────────────────────────────────────────────────────────────────────────
(function _installGlobalErrorCatchers() {
  // 1. React Native's global error handler (JSC + Hermes, Release + Debug).
  //    This is the lowest-level JS error surface in RN.
  //    It fires for uncaught errors thrown synchronously anywhere in JS.
  try {
    const prev = (globalThis as Record<string, unknown>).ErrorUtils;
    if (prev && typeof (prev as { setGlobalHandler?: unknown }).setGlobalHandler === 'function') {
      const eu = prev as {
        setGlobalHandler: (h: (err: unknown, isFatal: boolean) => void) => void;
        getGlobalHandler: () => ((err: unknown, isFatal: boolean) => void) | null;
      };
      const existing = eu.getGlobalHandler();
      eu.setGlobalHandler((err: unknown, isFatal: boolean) => {
        const msg = err instanceof Error ? err.message : String(err);
        const stk = err instanceof Error
          ? (err.stack ?? '').split('\n').slice(0, 4).join(' | ')
          : '';
        diag('GLOBAL', `ErrorUtils global handler isFatal=${isFatal}: ${msg}`, stk || undefined);
        // Force an immediate flush so the error reaches AsyncStorage quickly.
        if (_flushTimer !== null) { clearTimeout(_flushTimer); _flushTimer = null; }
        _flushToStorage();
        // Chain to existing handler (RN's default crash reporter).
        if (typeof existing === 'function') existing(err, isFatal);
      });
      diag('GLOBAL', 'ErrorUtils.setGlobalHandler installed');
    } else {
      diag('GLOBAL', 'ErrorUtils not available — skipped');
    }
  } catch (e) {
    // Cannot use diagError here (might be circular); fall back to bare console.
    // eslint-disable-next-line no-console
    console.log('[DIAG] ErrorUtils setup failed:', String(e));
  }

  // 2. Unhandled Promise rejections.
  //    In JSC (RN 0.83 / New Architecture) unhandled rejections are delivered
  //    to the global 'unhandledrejection' event if the runtime supports it,
  //    otherwise they go through ErrorUtils above.
  //    We install both for belt-and-suspenders coverage.
  try {
    if (typeof globalThis !== 'undefined' &&
        typeof (globalThis as Record<string, unknown>).addEventListener === 'function') {
      (globalThis as unknown as EventTarget).addEventListener('unhandledrejection', (ev: Event) => {
        const reason = (ev as PromiseRejectionEvent).reason;
        const msg    = reason instanceof Error ? reason.message : String(reason);
        const stk    = reason instanceof Error
          ? (reason.stack ?? '').split('\n').slice(0, 4).join(' | ')
          : '';
        diag('GLOBAL', `unhandledrejection: ${msg}`, stk || undefined);
        if (_flushTimer !== null) { clearTimeout(_flushTimer); _flushTimer = null; }
        _flushToStorage();
      });
      diag('GLOBAL', 'unhandledrejection listener installed on globalThis');
    } else {
      diag('GLOBAL', 'globalThis.addEventListener not available for unhandledrejection');
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('[DIAG] unhandledrejection setup failed:', String(e));
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// FIRST EVENT — module evaluation.
// This is the earliest possible JS log entry. Its presence in the Xcode
// console proves: (a) JSC is running, (b) the JS bundle was parsed,
// (c) this module was required/imported successfully.
// ─────────────────────────────────────────────────────────────────────────────
diag('JS', 'bundle eval — diagnostics module loaded', `sid=${_sessionId}`);
