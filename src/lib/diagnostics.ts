/**
 * DiagnosticStore — iOS startup sequence recorder. v3 (Windows-compatible retrieval)
 *
 * Design constraints:
 *  • MUST NOT depend on React rendering being alive.
 *  • MUST be retrievable on Windows WITHOUT Xcode or a Mac.
 *  • Works in RELEASE builds — no __DEV__ guard anywhere.
 *
 * ── Four retrieval paths (all React-UI-free) ─────────────────────────────────
 *
 *  A. /diag expo-router screen (PRIMARY for Windows)
 *     Navigate to medacademy:///diag via any iOS deep-link tool (see CHANGES.md).
 *     The screen is registered OUTSIDE all providers and navigation guards so it
 *     renders even when the normal app UI is completely black.
 *     It reads directly from AsyncStorage and displays the log on-screen.
 *
 *  B. HTTP POST beacon to a paste endpoint (AUTOMATED, no touch needed)
 *     On every flush, diagnostics.ts POSTs the log as plain text to:
 *       process.env.EXPO_PUBLIC_DIAG_ENDPOINT  (if set at build time)
 *     Receive it at https://paste.rs or https://hastebin.com or any URL that
 *     accepts a POST body and returns the paste URL in the response body.
 *     This fires even before any React component mounts.
 *
 *  C. AsyncStorage persistence (survives process death)
 *     Key: __medacademy_startup_diag__
 *     Readable via the /diag screen on the next launch even after a crash.
 *
 *  D. console.log (Xcode / idevicesyslog on Windows via libimobiledevice)
 *     Kept for completeness; not the primary Windows path.
 *
 * ── Immediate flush guarantee ─────────────────────────────────────────────────
 *  Every diag() call writes to AsyncStorage IMMEDIATELY (no debounce).
 *  A separate debounced HTTP beacon fires 1 500 ms after the last event.
 *  This ensures the log is persisted even if the app crashes within 50 ms of
 *  the first event.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Constants ─────────────────────────────────────────────────────────────────
export const STORAGE_KEY = '__medacademy_startup_diag__';
const MAX_ENTRIES        = 200;
// HTTP beacon fires 1 500 ms after the last event (debounced).
const BEACON_INTERVAL_MS = 1500;
// console snapshot every N events — kept for environments where console is available.
const CONSOLE_SNAPSHOT_EVERY = 10;

// ── Paste endpoint — set EXPO_PUBLIC_DIAG_ENDPOINT at build time ──────────────
// Example: EXPO_PUBLIC_DIAG_ENDPOINT=https://paste.rs
// Leave unset to disable HTTP beaconing (storage-only mode).
const _beaconUrl: string =
  (process.env.EXPO_PUBLIC_DIAG_ENDPOINT ?? '').trim();

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
let _beaconTimer: ReturnType<typeof setTimeout> | null = null;
let _snapshotCounter = 0;
const _sessionId     = String(_t0);

// ── Line formatter ────────────────────────────────────────────────────────────
function _line(e: DiagEntry): string {
  return `[+${String(e.t).padStart(5)}ms][${e.ts}][${e.tag}] ${e.msg}${e.extra ? ' | ' + e.extra : ''}`;
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

// ── Core append ───────────────────────────────────────────────────────────────
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

  // ── A. Immediate console.log (Xcode / idevicesyslog) ─────────────────────
  // eslint-disable-next-line no-console
  console.log(`[DIAG +${entry.t}ms] [${tag}] ${msg}${extra ? ' | ' + extra : ''}`);

  // ── B. Periodic console snapshot ─────────────────────────────────────────
  _snapshotCounter++;
  if (_snapshotCounter % CONSOLE_SNAPSHOT_EVERY === 0) {
    _emitConsoleSnapshot('periodic');
  }

  // ── C. IMMEDIATE AsyncStorage write — no debounce ────────────────────────
  // Write on every single event so the log survives a crash within milliseconds.
  _persistNow();

  // ── D. Debounced HTTP beacon ──────────────────────────────────────────────
  if (_beaconUrl) {
    if (_beaconTimer !== null) clearTimeout(_beaconTimer);
    _beaconTimer = setTimeout(_sendBeacon, BEACON_INTERVAL_MS);
  }
}

/** Record a caught error: message + first relevant stack line. */
export function diagError(tag: string, label: string, err: unknown): void {
  const msg  = err instanceof Error ? err.message : String(err);
  const line = err instanceof Error
    ? (err.stack ?? '').split('\n').find(
        l => l.includes('.tsx') || l.includes('.ts') || l.includes('.js')
      )?.trim() ?? ''
    : '';
  diag(tag, `${label}: ${msg}`, line || undefined);
}

/** Synchronous read of current ring buffer. */
export function getDiagEntries(): DiagEntry[] {
  return _ring.slice();
}

/** Wipe ring + AsyncStorage. */
export async function clearDiag(): Promise<void> {
  _ring.length = 0;
  try { await AsyncStorage.removeItem(STORAGE_KEY); } catch (_) {}
}

/** Load the previously persisted log (reads AsyncStorage). */
export async function loadPersistedDiag(): Promise<{ sessionId: string; entries: DiagEntry[] } | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { sessionId?: string; entries?: DiagEntry[] };
    return { sessionId: parsed.sessionId ?? '?', entries: parsed.entries ?? [] };
  } catch (_) {
    return null;
  }
}

/** Unique ID for this JS process launch. */
export function getDiagSessionId(): string { return _sessionId; }

/** Build the full plain-text log string (used by /diag screen and HTTP beacon). */
export function buildLogText(): string {
  const header = `=== MedAcademy Startup Diagnostic ===\nsid=${_sessionId}\nentries=${_ring.length}\n\n`;
  return header + _ring.map(_line).join('\n');
}

// ── Immediate AsyncStorage write ──────────────────────────────────────────────
function _persistNow(): void {
  const snapshot = { sessionId: _sessionId, entries: _ring.slice() };
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)).catch(() => {});
}

// ── console snapshot ──────────────────────────────────────────────────────────
function _emitConsoleSnapshot(reason: string): void {
  // eslint-disable-next-line no-console
  console.log(
    `[DIAG SNAPSHOT sid=${_sessionId} reason=${reason} count=${_ring.length}]\n` +
    _ring.map(_line).join('\n')
  );
}

// ── HTTP beacon — POST log text to paste endpoint ────────────────────────────
// Uses the global fetch that is available in RN's JSC/Hermes runtime.
// Fire-and-forget; errors are logged as DIAG entries but never thrown.
function _sendBeacon(): void {
  _beaconTimer = null;
  if (!_beaconUrl) return;
  const body = buildLogText();
  // eslint-disable-next-line no-console
  console.log(`[DIAG] Sending beacon to ${_beaconUrl} (${body.length} bytes)`);
  fetch(_beaconUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'text/plain' },
    body,
  })
    .then(async (r) => {
      const location = await r.text().catch(() => '');
      // eslint-disable-next-line no-console
      console.log(`[DIAG] Beacon response ${r.status}: ${location.trim()}`);
      diag('BEACON', `HTTP ${r.status}`, location.trim().slice(0, 120) || undefined);
    })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      // eslint-disable-next-line no-console
      console.log(`[DIAG] Beacon failed: ${msg}`);
      diag('BEACON', `send failed: ${msg}`);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL ERROR CATCHERS — installed at module-evaluation time.
// No dependency on React, providers, or any app logic.
// ─────────────────────────────────────────────────────────────────────────────
(function _installGlobalErrorCatchers() {
  // 1. React Native's ErrorUtils — lowest-level uncaught error surface.
  try {
    const eu = (globalThis as Record<string, unknown>).ErrorUtils as {
      setGlobalHandler: (h: (err: unknown, isFatal: boolean) => void) => void;
      getGlobalHandler: () => ((err: unknown, isFatal: boolean) => void) | null;
    } | undefined;

    if (eu && typeof eu.setGlobalHandler === 'function') {
      const existing = eu.getGlobalHandler();
      eu.setGlobalHandler((err: unknown, isFatal: boolean) => {
        const msg = err instanceof Error ? err.message : String(err);
        const stk = err instanceof Error
          ? (err.stack ?? '').split('\n').slice(0, 4).join(' | ')
          : '';
        diag('GLOBAL', `ErrorUtils isFatal=${isFatal}: ${msg}`, stk || undefined);
        // Force immediate AsyncStorage + beacon on fatal errors.
        _persistNow();
        if (_beaconUrl) {
          if (_beaconTimer !== null) { clearTimeout(_beaconTimer); _beaconTimer = null; }
          _sendBeacon();
        }
        if (typeof existing === 'function') existing(err, isFatal);
      });
      diag('GLOBAL', 'ErrorUtils.setGlobalHandler installed');
    } else {
      diag('GLOBAL', 'ErrorUtils not available');
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('[DIAG] ErrorUtils setup failed:', String(e));
  }

  // 2. Unhandled Promise rejections.
  try {
    if (typeof (globalThis as Record<string, unknown>).addEventListener === 'function') {
      (globalThis as unknown as EventTarget).addEventListener('unhandledrejection', (ev: Event) => {
        const reason = (ev as PromiseRejectionEvent).reason;
        const msg    = reason instanceof Error ? reason.message : String(reason);
        const stk    = reason instanceof Error
          ? (reason.stack ?? '').split('\n').slice(0, 4).join(' | ')
          : '';
        diag('GLOBAL', `unhandledrejection: ${msg}`, stk || undefined);
        _persistNow();
        if (_beaconUrl) {
          if (_beaconTimer !== null) { clearTimeout(_beaconTimer); _beaconTimer = null; }
          _sendBeacon();
        }
      });
      diag('GLOBAL', 'unhandledrejection listener installed');
    } else {
      diag('GLOBAL', 'globalThis.addEventListener not available');
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('[DIAG] unhandledrejection setup failed:', String(e));
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// FIRST EVENT — module evaluation.
// ─────────────────────────────────────────────────────────────────────────────
diag('JS', 'bundle eval — diagnostics v3 loaded', `sid=${_sessionId} beacon=${_beaconUrl || 'off'}`);
