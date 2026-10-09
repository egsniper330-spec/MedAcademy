/**
 * securityLock.ts — CENTRAL, RACE-SAFE SECURITY LOCK (pure, no imports).
 *
 * ⚠️ This module must stay dependency-free (no react-native, no expo, no
 * network) so it can be compiled standalone and unit-tested with plain node
 * (see tests/securityLock.test.cjs and .freebuff/run-state-tests.cjs).
 *
 * ─── THE DEFECT THIS MODULE CLOSES ─────────────────────────────────────────
 *
 * Enforcement used to live in TWO disconnected places:
 *
 *   1. The block SCREEN was driven by `blocksLogin` (SecurityGate overlay).
 *   2. The PLAYER was stopped by `blocksVideo` — and only that.
 *
 * VPN/proxy policy is `block_login` (see DEFAULT_POLICIES in security.ts).
 * So a detected VPN produced `blocksLogin:true, blocksVideo:false`: the gate
 * rendered full-screen, but the VdoCipher native player was never unmounted
 * and kept decoding/playing (and kept its audio session) BEHIND the gate.
 * Nothing aborted in-flight protected requests, nothing stopped the 30s
 * periodic/progress traffic, and nothing blocked NEW requests while blocked.
 *
 * ─── THE MODEL ─────────────────────────────────────────────────────────────
 *
 *   signal / verdict ──engage──▶ LOCK (composed holders) ──▶ containment
 *                                        │
 *                                        ├─ abort every registered in-flight
 *                                        │  protected request (AbortController)
 *                                        ├─ invoke every registered playback
 *                                        │  stopper (immediate pause)
 *                                        └─ notify subscribers (React state)
 *
 * Holders compose by SOURCE NAME (a Set semantics via a Map), so a release
 * from one source can never clear a lock still held by another — the classic
 * "two signals, one release" race. `hard` is true when ANY live holder is
 * hard; a hard lock is what screens use to UNMOUNT the native player.
 *
 * A SOFT lock (provisional containment) is what the native VPN callback
 * engages IMMEDIATELY, before the network-bound verdict lands: it pauses
 * playback and halts protected traffic at once, then the authoritative
 * verdict either upgrades it (hard) or releases it (e.g. a whitelisted VPN).
 */

export type SecurityLockSource = string;

export interface SecurityLockState {
  /** Any holder at all → protected requests are refused and playback paused. */
  locked: boolean;
  /** At least one holder is authoritative → the native player must unmount. */
  hard: boolean;
  /** Live holder names (sorted, stable — safe to render/diff). */
  sources: SecurityLockSource[];
}

interface Holder {
  hard: boolean;
}

const holders = new Map<SecurityLockSource, Holder>();

/** In-flight protected requests, keyed by an opaque id → its abort callback. */
const protectedAborts = new Map<number, { abort: () => void }>();
let nextAbortId = 1;

/** Immediate playback-stop callbacks registered by mounted players. */
const playbackStoppers = new Set<() => void>();

const listeners = new Set<(state: SecurityLockState) => void>();

/**
 * CONTAINMENT DIAGNOSTICS — monotonic timestamps for the immediate-containment
 * path, so detection → lock → stop latency is MEASURED rather than assumed.
 *
 * PRIVACY: timestamps, counts and booleans ONLY. Never a URL, host, token,
 * authorization header, request body or user id. Safe to log in __DEV__ and to
 * surface in the admin diagnostics screen.
 */
export interface ContainmentDiagnostics {
  /** Monotonic ms the native VPN signal was raised, as reported by the native side. */
  nativeSignalMs: number | null;
  /** Monotonic ms JS received that signal (same clock as every other field). */
  jsReceiptMs: number | null;
  /** Monotonic ms the lock transitioned into `locked` — i.e. containment ran. */
  lockEngagedMs: number | null;
  /** Monotonic ms the abort sweep started. */
  abortInitiatedMs: number | null;
  /** Monotonic ms the abort sweep finished. */
  abortCompletedMs: number | null;
  /** Monotonic ms the playback-stop sweep finished (stop confirmation). */
  playerStopCompletedMs: number | null;
  /** Monotonic ms a protected request was last REGISTERED (started). */
  lastProtectedRequestStartMs: number | null;
  /** Protected requests aborted by the most recent containment. */
  abortedRequests: number;
  /** Playback stoppers invoked by the most recent containment. */
  stoppedPlayers: number;
  /**
   * Protected requests refused because the lock was already active. Must stay
   * at 0 growth after containment — a rising count proves a gate breach.
   */
  refusedProtectedRequests: number;
}

const diagnostics: ContainmentDiagnostics = {
  nativeSignalMs: null,
  jsReceiptMs: null,
  lockEngagedMs: null,
  abortInitiatedMs: null,
  abortCompletedMs: null,
  playerStopCompletedMs: null,
  lastProtectedRequestStartMs: null,
  abortedRequests: 0,
  stoppedPlayers: 0,
  refusedProtectedRequests: 0,
};

/**
 * Monotonic ms clock. `performance.now()` is monotonic and unaffected by wall-
 * clock/NTP changes, so every JS-side latency here uses the SAME clock.
 */
function nowMs(): number {
  try {
    const perf = (globalThis as { performance?: { now?: () => number } }).performance;
    if (perf && typeof perf.now === 'function') return perf.now();
  } catch {
    /* fall through to the wall clock */
  }
  return Date.now();
}

/** Snapshot the containment timings. Returns a copy — callers cannot mutate it. */
export function getContainmentDiagnostics(): ContainmentDiagnostics {
  return { ...diagnostics };
}

/**
 * Record the JS-side receipt of a native VPN signal. Called from the
 * `vpnStateChanged` listener BEFORE any containment work, so the measured
 * latency is event-receipt → lock-engaged, excluding nothing. Carries no
 * payload — only the native-reported signal time and our own monotonic clock.
 */
export function markNativeVpnSignal(nativeSignalMs: number | null): void {
  diagnostics.nativeSignalMs = nativeSignalMs;
  diagnostics.jsReceiptMs    = nowMs();
}

function snapshot(): SecurityLockState {
  let hard = false;
  for (const h of holders.values()) {
    if (h.hard) { hard = true; break; }
  }
  return {
    locked: holders.size > 0,
    hard,
    sources: [...holders.keys()].sort(),
  };
}

function notify(): void {
  const state = snapshot();
  for (const cb of [...listeners]) {
    try {
      cb(state);
    } catch {
      /* a misbehaving subscriber must never break enforcement */
    }
  }
}

/**
 * CONTAINMENT — the effectful half of engaging the lock. Runs exactly once per
 * transition into `locked` (never on the soft→hard upgrade, so an upgrade
 * cannot re-abort an already-empty registry or double-pause).
 */
function contain(): void {
  // Order matters for the measured latency: the lock is considered ENGAGED the
  // instant we start containing, then each sweep is timed against that mark.
  diagnostics.lockEngagedMs = nowMs();

  // 1. Abort every in-flight protected request. The registry is drained first
  //    so a re-entrant abort callback cannot double-fire or mutate the loop.
  const pending = [...protectedAborts.values()];
  protectedAborts.clear();
  diagnostics.abortInitiatedMs = nowMs();
  diagnostics.abortedRequests  = pending.length;
  for (const p of pending) {
    try {
      p.abort();
    } catch {
      /* already settled */
    }
  }
  diagnostics.abortCompletedMs = nowMs();

  // 2. Stop playback immediately (pause the native player / tear down the
  //    WebView player; the screen's own hard-lock keying then unmounts it).
  const stops = [...playbackStoppers];
  diagnostics.stoppedPlayers = stops.length;
  for (const stop of stops) {
    try {
      stop();
    } catch {
      /* a player that already unmounted must not break containment */
    }
  }
  diagnostics.playerStopCompletedMs = nowMs();
}

function applyChange(wasLocked: boolean): void {
  const nowLocked = holders.size > 0;
  if (!wasLocked && nowLocked) contain();
  notify();
}

/**
 * Engage the lock under `source`. Idempotent per source.
 *
 * @param opts.hard true for an AUTHORITATIVE (policy-verdict) block; false (or
 *        omitted) for provisional containment driven by a fast native signal.
 *        A hard engage always wins over a soft one from any other source.
 */
export function engageSecurityLock(source: SecurityLockSource, opts?: { hard?: boolean }): void {
  const wasLocked = holders.size > 0;
  const hard = opts?.hard === true;
  const prev = holders.get(source);
  // Preserve an existing hard holder: a later soft engage on the same source
  // must never downgrade an authoritative block.
  const nextHard = hard || prev?.hard === true;
  if (prev && prev.hard === nextHard) return; // no state change
  holders.set(source, { hard: nextHard });
  applyChange(wasLocked);
}

/** Release `source`'s hold. Other holders keep the lock alive. */
export function releaseSecurityLock(source: SecurityLockSource): void {
  if (!holders.has(source)) return;
  const wasLocked = holders.size > 0;
  holders.delete(source);
  applyChange(wasLocked);
}

/** Release EVERY holder (logout, session identity change, test teardown). */
export function releaseAllSecurityLocks(): void {
  if (holders.size === 0) return;
  holders.clear();
  applyChange(true);
}

export function isSecurityLocked(): boolean {
  return holders.size > 0;
}

export function isSecurityLockHard(): boolean {
  return snapshot().hard;
}

export function getSecurityLockState(): SecurityLockState {
  return snapshot();
}

/** Subscribe to lock-state changes. Fires immediately with the current state. */
export function subscribeSecurityLock(cb: (state: SecurityLockState) => void): () => void {
  listeners.add(cb);
  try {
    cb(snapshot());
  } catch {
    /* ignore */
  }
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Register an in-flight protected request so containment can abort it.
 * Returns an unregister function to call when the request settles.
 *
 * If the lock is ALREADY active the request is aborted immediately and a
 * no-op unregister is returned — a request can never slip in behind the lock
 * through a race between the caller's own check and the engage.
 */
export function registerProtectedAbort(controller: { abort: () => void }): () => void {
  if (holders.size > 0) {
    // GATE BREACH TELEMETRY: this counter rising while `lockEngagedMs` is set
    // means something tried to start a protected request behind the lock.
    diagnostics.refusedProtectedRequests++;
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
    return () => {};
  }
  const id = nextAbortId++;
  diagnostics.lastProtectedRequestStartMs = nowMs();
  protectedAborts.set(id, controller);
  return () => {
    protectedAborts.delete(id);
  };
}

/**
 * Register an immediate playback-stop callback (pause the native player).
 * Returns an unregister function to call on player unmount.
 */
export function registerPlaybackStopper(stop: () => void): () => void {
  playbackStoppers.add(stop);
  //  A player that MOUNTS AFTER containment has already run would otherwise
  //  never be stopped: `contain()` fires once per transition into `locked`, and
  //  the WebView/native player may finish initializing behind the gate (e.g. a
  //  route that mounts the player while the lock is already up, or a WebView
  //  that committed its document late). Stop it on registration — mirroring
  //  registerProtectedAbort's refuse-behind-the-lock behaviour — so playback
  //  can never begin on an already-locked screen.
  if (holders.size > 0) {
    try {
      stop();
    } catch {
      /* a player that is not ready must not break containment */
    }
  }
  return () => {
    playbackStoppers.delete(stop);
  };
}

/** Test hook — clears all state without notifying. */
export function _resetSecurityLockForTests(): void {
  holders.clear();
  protectedAborts.clear();
  playbackStoppers.clear();
  listeners.clear();
  nextAbortId = 1;
  diagnostics.nativeSignalMs = null;
  diagnostics.jsReceiptMs = null;
  diagnostics.lockEngagedMs = null;
  diagnostics.abortInitiatedMs = null;
  diagnostics.abortCompletedMs = null;
  diagnostics.playerStopCompletedMs = null;
  diagnostics.lastProtectedRequestStartMs = null;
  diagnostics.abortedRequests = 0;
  diagnostics.stoppedPlayers = 0;
  diagnostics.refusedProtectedRequests = 0;
}

/** Test hook — count of registered in-flight protected requests. */
export function _protectedInflightForTests(): number {
  return protectedAborts.size;
}

/** Test hook — count of registered playback stoppers. */
export function _playbackStoppersForTests(): number {
  return playbackStoppers.size;
}
