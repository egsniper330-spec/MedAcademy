/**
 * nativeSecurity.ts
 *
 * JS bridge to the native SecurityModule (Android) AND IOSSecurityModule (iOS).
 * Registered by withSecurityModule config plugin; available in release builds.
 *
 * Android module: SecurityModule (Kotlin)
 *   Phase 1: developer options, ADB, debugger, screen recording
 *   Phase 2: Frida, Xposed/LSPosed, Magisk/Zygisk, signature,
 *             anti-tamper, Play Integrity token request
 *
 * iOS module: IOSSecurityModule (Swift)
 *   Jailbreak (10 methods), debugger (sysctl), screen recording (UIScreen.isCaptured),
 *   screenshot (UIApplication notification), VPN (utun interface scan),
 *   proxy (CFNetworkCopySystemProxySettings), dylib injection (Frida/Substrate),
 *   bundle integrity (MachO header), App Attest (DCAppAttestService),
 *   DeviceCheck (DCDevice fallback)
 *
 * All methods return safe defaults (false / null) on the opposite platform / Web /
 * Expo Go — callers never need to branch on platform.
 */

import { NativeModules, NativeEventEmitter, Platform } from 'react-native';
// PURE vocabulary only (type import — no runtime dependency on the model).
import type { VpnSignalPath } from './securityStateModel';
// PURE root-detection model (ids, confidence rules, payload validation).
import { parseRootDiagnostics, type RootDiagnosticsReport } from './rootDetectionModel';
import NetInfo from '@react-native-community/netinfo';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NativeSecurityFlags {
  // Phase 1 (Android names — iOS module maps to same keys)
  developerOptionsEnabled: boolean;
  adbEnabled:              boolean;
  debuggerAttached:        boolean;
  testOnlyBuild:           boolean;
  screenBeingRecorded:     boolean;
  // Phase 2 (Android names)
  fridaDetected:   boolean;
  xposedDetected:  boolean;
  magiskDetected:  boolean;
  signatureValid:  boolean;
  tampered:        boolean;
  // Phase 3 — new native checks (Android; iOS maps jailbreak/vpn to same keys)
  vpnDetected:          boolean;
  rootDetected:         boolean;
  emulatorDetected:     boolean;
  // NOTE: mock location is deliberately NOT part of this contract. The check
  // was removed because a release APK cannot obtain the cross-UID AppOps read
  // it needs, and the per-package app-op it exposes is persisted state rather
  // than live evidence (see the removal note in plugins/withSecurityModule.js).
  // iOS-only extras (Android module returns false for these)
  jailbreakDetected?:      boolean;
  proxyDetected?:          boolean;
  dylibInjectionDetected?: boolean;
  bundleTampered?:         boolean;
  // ── Evidence fields (Android) — observability only, NEVER threat signals ──
  /**
   * Installing package (distribution telemetry). null/undefined = unknown or
   * direct-download — legitimate under this app's direct-APK distribution
   * model. Must not be interpreted as tampering.
   */
  installerSource?:         string | null;
  /** True when a pinned expected cert SHA-256 is baked into the build. When
   *  false the native signature check is UNAVAILABLE (skipped), not passed. */
  expectedCertConfigured?: boolean;
  /** SHA-256 fingerprint of the current signing cert (public material). */
  signatureSha256?:        string | null;
  // ── Phase 4 signal plane (Part 1 redesign + Part 6/12) ────────────────────
  /** Native aggregate VPN model: 'on' | 'off' | 'suspicious' | 'unknown'.
   *  'suspicious' = callback observed a VPN that point sensors no longer
   *  find — treated as possible suppression, never as off. */
  vpnState?:               string;
  /** C++ libmedasec core loaded and inspecting /proc (evidence quality flag). */
  coreAvailable?:          boolean;
  /** Hook-framework libraries found in /proc/self/maps (Frida/Xposed class). */
  coreHookLibs?:           boolean;
  /** Injected runtimes named like Frida worker threads. */
  coreFridaThreads?:       number;
  /** /proc/self/status thread count disagrees with /proc/task enumeration. */
  coreThreadMismatch?:     boolean;
  /** Decoded hook-lib path tails from the C++ core's /proc/self/maps read
   *  (bounded sample). Evidence only — never a verdict on its own. */
  coreHookLibNames?:       string[];
  // ── Second-pass evidence model (see docs/ROOT_DETECTION_SECOND_PASS_AUDIT.md)
  /**
   * Checks that THREW or structurally could not run in the native batch
   * (hidepid-blocked process scan, unreadable /proc/self/maps, missing
   * libmedasec core, any runCatching failure). "unknown" — NEVER the same as a
   * clean result, and never auto-blocking. Absent when an older native module
   * does not emit the field.
   */
  detectionsUnavailable?:  string[];
  /**
   * Provenance: which signal fired each verdict (e.g. root:
   * artifact_probe / mount_view / su_on_path / test_keys …). rootEvidenceSignals
   * and magiskEvidenceSignals can name the SAME source — that is ONE
   * observation behind two booleans, not independent corroboration.
   */
  rootEvidenceSignals?:     string[];
  magiskEvidenceSignals?:   string[];
  fridaEvidenceSignals?:    string[];
  xposedEvidenceSignals?:   string[];
  /**
   * STRUCTURED root diagnostics (Android, false-positive investigation): one
   * classified entry per detection signal — id, category, result
   * (positive/negative/inconclusive), evidence, confidence and whether it fed
   * the verdict — plus which positives fed BOTH verdicts. Parsed from the native
   * batch's `rootDiagnostics` JSON (see src/lib/rootDetectionModel.ts). Absent on
   * iOS and on an older native module; the verdicts themselves are unchanged.
   */
  rootDiagnostics?:        RootDiagnosticsReport;
  /** Kernel-plane tunnel-class interface count (/proc/net/dev via C++). */
  netNativeTunnelIfaces?:  number;
  /** Kernel routing table has a default route via a tunnel-class interface. */
  netNativeRouteTunnel?:   boolean;
  /** Tampering/tooling packages found from the visibility-scoped catalog. */
  tamperToolPackages?:     number;
  /** True when PackageManager confirms the OFFICIAL application id at runtime. */
  packageIdentityValid?:   boolean;
  // ── Traffic-interception tools (INSTALLED-package evidence, Android) ──────
  /**
   * Application ids of installed apps from the curated interception catalog
   * (ProxyPin, Reqable, HTTP Toolkit, HttpCanary, PCAPdroid). This is an
   * INSTALLED fact obtained through targeted <queries> visibility — NOT proof
   * that the app is running, and blind to renamed/repackaged or unknown tools.
   */
  interceptionToolPackages?: string[];
  /** Human-readable labels of the same packages (never used as evidence). */
  interceptionToolLabels?:   string[];
  /**
   * Packages whose signer digest did NOT match a configured pin. Empty in
   * builds without a verified digest database — a mismatch is evidence of a
   * different signer, never proof of interception.
   */
  interceptionSignerMismatches?: string[];
  // ── User-installed CA certificates (trust-store evidence, Android) ───────
  /**
   * Result of enumerating the device's CA store through the public read-only
   * `AndroidCAStore` KeyStore view:
   *   'clean'        every alias resolved and none was user-added
   *   'user_ca'      at least one USER-ADDED CA certificate is installed
   *   'inconclusive' unreadable, empty or unclassifiable store — NEVER clean
   * Absent on an older native module / iOS, which the JS mapping treats as
   * inconclusive (never as a clean device).
   */
  userCaStatus?: 'clean' | 'user_ca' | 'inconclusive';
  /** Number of user-added CA certificates the store listed (diagnostics only). */
  userCaCount?: number;
  // ── Multi-window / split-screen state (window-state evidence) ─────────────
  /**
   * Last measured window mode of THIS app: 'fullscreen' | 'multi_window' |
   * 'picture_in_picture' | 'unknown'. Evidence and cross-check for the report;
   * the enforcement decision uses the LIVE window-mode signal
   * (onNativeWindowModeChanged / getNativeWindowMode), not this snapshot.
   */
  windowMode?:                  string;
  /** True for split-screen / another multi-window mode AND for our own PiP. */
  inMultiWindowMode?:           boolean;
  /** True only when THIS app is floating in picture-in-picture. */
  inPictureInPictureMode?:      boolean;
  /** False means "no real measurement yet" — never "full-screen confirmed". */
  windowModeMeasured?:          boolean;
}

const SAFE_FLAGS: NativeSecurityFlags = {
  developerOptionsEnabled: false,
  adbEnabled:              false,
  debuggerAttached:        false,
  testOnlyBuild:           false,
  screenBeingRecorded:     false,
  fridaDetected:           false,
  xposedDetected:          false,
  magiskDetected:          false,
  signatureValid:          true,   // assume valid on non-Android (safe default)
  tampered:                false,
  // Phase 3
  vpnDetected:          false,
  rootDetected:         false,
  emulatorDetected:     false,
  // Phase 4 signal plane defaults (unknown/unavailable ≠ safe; policy decides)
  vpnState: 'unknown',
  coreAvailable: false,
  coreHookLibs: false,
  coreFridaThreads: 0,
  coreThreadMismatch: false,
  netNativeTunnelIfaces: 0,
  netNativeRouteTunnel: false,
  tamperToolPackages: 0,
  packageIdentityValid: true,
  // Multi-window: 'unknown' + measured:false is the honest default — it is the
  // same state as "this platform could not answer" (web / iOS / module absent)
  // and is never treated as a confirmed full-screen measurement.
  windowMode: 'unknown',
  inMultiWindowMode: false,
  inPictureInPictureMode: false,
  windowModeMeasured: false,
  // No tool list is the honest default for "the module could not answer":
  // an installed-package scan that did not run must never read as "clean",
  // which is why the JS detector reports it as INCONCLUSIVE, not as zero.
  interceptionToolPackages: [],
  interceptionToolLabels: [],
  interceptionSignerMismatches: [],
  // No status means the store was NOT read: 'inconclusive', never 'clean'.
  userCaStatus: 'inconclusive',
  userCaCount: 0,
  // iOS extras default to safe
  jailbreakDetected:       false,
  proxyDetected:           false,
  dylibInjectionDetected:  false,
  bundleTampered:          false,
};

// ─── Module access ────────────────────────────────────────────────────────────

function getModule(): typeof NativeModules['SecurityModule'] | null {
  if (Platform.OS !== 'android') return null;
  return NativeModules.SecurityModule ?? null;
}

function getIOSModule(): typeof NativeModules['IOSSecurityModule'] | null {
  if (Platform.OS !== 'ios') return null;
  // IOSSecurityModule is compiled into the app via plugins/withSecurityModule and
  // is registered in the Xcode project. NativeModules.IOSSecurityModule is the live
  // native module — callers should NOT assume null.
  // (Historical note: the module was temporarily absent during early development.
  // It is now fully compiled, registered, and active.)
  return NativeModules.IOSSecurityModule ?? null;
}

// ─── Batch API (preferred — single bridge crossing) ───────────────────────────

/**
 * True when the LAST getNativeSecurityFlags() call actually reached a native
 * module and got a real result. False when the module was missing or the call
 * threw — i.e. the returned flags are fail-safe defaults, NOT measurements.
 *
 * Fail-safe contract: callers that enforce security decisions MUST consult this
 * flag; a false here means "detection unavailable", which is a distinct state
 * from "confirmed safe". It does NOT auto-block (a transient native error must
 * never lock out legitimate users), but it must be reported so admins can see
 * coverage gaps instead of silently trusting all-green dashboards.
 */
let _lastFlagsCallUnavailable = false;
export function wasLastSecurityFlagsCallUnavailable(): boolean {
  return _lastFlagsCallUnavailable;
}

/** Last successfully measured flags (SAFE_FLAGS until the first native call
 *  completes). Lets synchronous evaluators (detectAppIntegrity) read the
 *  measurement their calling cycle already made without a second native
 *  round-trip. The async getNativeSecurityFlags() refreshes this cache. */
let _lastMeasuredFlags: NativeSecurityFlags = { ...SAFE_FLAGS };
export function getNativeSecurityFlagsSync(): NativeSecurityFlags {
  return _lastMeasuredFlags;
}

/**
 * Parses the native batch's STRUCTURED root diagnostics (Android only).
 *
 * The Kotlin batch carries it as a JSON string (a WritableMap cannot hold nested
 * objects). Anything unusable is DROPPED instead of being replaced by an empty
 * report — an empty report would read as "nothing found" (measured clean),
 * which is the exact confusion the structured report exists to remove.
 */
function withRootDiagnostics(flags: NativeSecurityFlags): NativeSecurityFlags {
  const raw = (flags as unknown as { rootDiagnostics?: unknown }).rootDiagnostics;
  if (typeof raw !== 'string') return flags;
  const parsed = parseRootDiagnostics(raw);
  if (parsed) return { ...flags, rootDiagnostics: parsed };
  const stripped: NativeSecurityFlags = { ...flags };
  delete stripped.rootDiagnostics;
  return stripped;
}

/**
 * One real native round-trip. `measured:false` means the returned object is the
 * fail-safe default, NOT a measurement.
 */
async function readNativeSecurityFlagsOnce(): Promise<{ flags: NativeSecurityFlags; measured: boolean }> {
  if (Platform.OS === 'android') {
    const mod = getModule();
    if (!mod) {
      console.warn('[NativeSecurity][Stage-2] ❌ Module is null — returning SAFE_FLAGS (detection UNAVAILABLE, not measured). Check native registration.');
      return { flags: SAFE_FLAGS, measured: false };
    }
    try {
      const flags = await mod.getSecurityFlags() as NativeSecurityFlags;
      const merged = withRootDiagnostics({ ...SAFE_FLAGS, ...flags });
      _lastMeasuredFlags = merged;
      return { flags: merged, measured: true };
    } catch (e) {
      console.error('[NativeSecurity][Stage-2] ❌ getSecurityFlags() threw:', e, '— returning SAFE_FLAGS (detection UNAVAILABLE, not measured)');
      return { flags: SAFE_FLAGS, measured: false };
    }
  }

  if (Platform.OS === 'ios') {
    const mod = getIOSModule();
    if (!mod) {
      console.warn('[NativeSecurity][Stage-2] ❌ iOS module null — returning SAFE_FLAGS (detection UNAVAILABLE)');
      return { flags: SAFE_FLAGS, measured: false };
    }
    try {
      const flags = await mod.getSecurityFlags() as NativeSecurityFlags;
      const merged = withRootDiagnostics({ ...SAFE_FLAGS, ...flags });
      // FIX: the iOS branch previously did not refresh the sync snapshot, so
      // getNativeSecurityFlagsSync() (used by detectAppIntegrity) kept reading
      // SAFE_FLAGS on iOS even after a successful measurement.
      _lastMeasuredFlags = merged;
      return { flags: merged, measured: true };
    } catch (e) {
      console.error('[NativeSecurity][Stage-2] ❌ iOS getSecurityFlags() threw:', e, '— returning SAFE_FLAGS (detection UNAVAILABLE)');
      return { flags: SAFE_FLAGS, measured: false };
    }
  }

  // Web: no native module by design — this is the SUPPORTED platform behavior,
  // not a degradation. Availability stays false so callers skip enforcement.
  return { flags: SAFE_FLAGS, measured: false };
}

/**
 * PER-CYCLE COALESCE + SHORT TTL for the native flag batch.
 *
 * WHY: runSecurityChecks() reads the flag batch once per detector — 16 call
 * sites in security.ts — and the periodic pipeline repeats that every
 * CONTINUOUS_CHECK_INTERVAL_MS. With no cache, ONE check cycle crossed the
 * native bridge ~16 times, and each crossing re-reads Settings.Global, the
 * package manager and /proc inside Kotlin. The warm-up call in
 * runSecurityChecks() ("so every detector re-uses it") therefore did nothing:
 * by the time the detectors ran, every one of them issued its own call.
 *
 * SAFETY — why this cannot hide a security condition:
 *   • TTL is one check cycle (milliseconds), so every NEW cycle performs a real
 *     measurement; a stale value can never outlive the current cycle.
 *   • Concurrent callers share ONE in-flight promise, so a measurement is never
 *     half-applied and the fail-safe/unavailable contract is decided once.
 *   • FAILURES ARE NEVER CACHED: a call that could not reach the module leaves
 *     the cache cold, so the next caller retries immediately instead of
 *     inheriting a fail-safe default.
 *   • The gated values (developer options, ADB, debugger, test-only build) are
 *     user-initiated settings that change on a human timescale, and the
 *     pipeline re-runs on a 30 s timer, on foreground resume, on gate re-check
 *     and after a policy/config change.
 */
const FLAGS_CACHE_TTL_MS = 500;
let _flagsCacheAt = 0;
let _flagsInFlight: Promise<NativeSecurityFlags> | null = null;

/**
 * Returns ALL security flags in one native call.
 * Falls back to SAFE_FLAGS if the module is unavailable — and records the
 * degradation in wasLastSecurityFlagsCallUnavailable() so callers can tell
 * "measured clean" apart from "could not measure".
 * Works on both Android (SecurityModule) and iOS (IOSSecurityModule).
 */
export async function getNativeSecurityFlags(): Promise<NativeSecurityFlags> {
  const now = Date.now();
  if (_flagsCacheAt !== 0 && now - _flagsCacheAt < FLAGS_CACHE_TTL_MS) {
    return _lastMeasuredFlags;
  }
  if (_flagsInFlight) return _flagsInFlight;

  _flagsInFlight = readNativeSecurityFlagsOnce()
    .then(({ flags, measured }) => {
      _lastFlagsCallUnavailable = !measured;
      _flagsCacheAt = measured ? Date.now() : 0;
      return flags;
    })
    .finally(() => {
      _flagsInFlight = null;
    });
  return _flagsInFlight;
}

/** Test/engineering seam: drop the coalescing cache (never used in app code). */
export function resetNativeSecurityFlagsCache(): void {
  _flagsCacheAt = 0;
  _flagsInFlight = null;
}

// ─── Individual APIs ──────────────────────────────────────────────────────────

export async function isNativeDeveloperOptionsEnabled(): Promise<boolean> {
  const mod = getModule();
  if (!mod) return false;
  try { return await mod.isDeveloperOptionsEnabled() as boolean; } catch { return false; }
}

export async function isNativeAdbEnabled(): Promise<boolean> {
  const mod = getModule();
  if (!mod) return false;
  try { return await mod.isAdbEnabled() as boolean; } catch { return false; }
}

export async function isNativeDebuggerAttached(): Promise<boolean> {
  if (Platform.OS === 'android') {
    const mod = getModule();
    if (!mod) return false;
    try { return await mod.isDebuggerAttached() as boolean; } catch { return false; }
  }
  if (Platform.OS === 'ios') {
    const mod = getIOSModule();
    if (!mod) return false;
    try { return await mod.isDebuggerAttached() as boolean; } catch { return false; }
  }
  return false;
}

export async function isNativeScreenBeingRecorded(): Promise<boolean> {
  if (Platform.OS === 'android') {
    const mod = getModule();
    if (!mod) return false;
    try { return await mod.isScreenBeingRecorded() as boolean; } catch { return false; }
  }
  if (Platform.OS === 'ios') {
    const mod = getIOSModule();
    if (!mod) return false;
    try { return await mod.isScreenBeingRecorded() as boolean; } catch { return false; }
  }
  return false;
}

export async function isNativeFridaDetected(): Promise<boolean> {
  if (Platform.OS === 'android') {
    const mod = getModule();
    if (!mod) return false;
    try { return await mod.isFridaDetected() as boolean; } catch { return false; }
  }
  if (Platform.OS === 'ios') {
    // On iOS, Frida is detected via dylib injection scan
    const mod = getIOSModule();
    if (!mod) return false;
    try { return await mod.isDylibInjectionDetected() as boolean; } catch { return false; }
  }
  return false;
}

export async function isNativeXposedDetected(): Promise<boolean> {
  const mod = getModule();  // Android-only — Xposed has no iOS equivalent
  if (!mod) return false;
  try { return await mod.isXposedDetected() as boolean; } catch { return false; }
}

export async function isNativeMagiskDetected(): Promise<boolean> {
  const mod = getModule();  // Android-only — Magisk has no iOS equivalent
  if (!mod) return false;
  try { return await mod.isMagiskDetected() as boolean; } catch { return false; }
}

/**
 * Raw outcome of the native root-framework filesystem probe.
 *
 * WHY IT IS SEPARATE FROM THE BOOLEANS ABOVE:
 *   `magiskDetected` / `rootDetected` are verdicts that now include this probe.
 *   This object carries the EVIDENCE behind that verdict (which paths were
 *   present, which answered EACCES) so the in-app diagnostics screen and the
 *   signed evidence payload can report exactly what was observed instead of a
 *   single opaque boolean.
 *
 * FAIL-CLOSED CONTRACT: this returns NULL when the module is missing, the call
 * throws, or the platform is not Android. It never returns an empty-but-valid
 * object, because `{ present: [], denied: [] }` would read as "measured clean" —
 * the precise confusion this probe exists to remove. Callers must treat null as
 * UNKNOWN, never as safe.
 */
export interface NativeRootArtifactEvidence {
  available: true;
  /** True when the native rule found root-manager evidence. */
  rootFrameworkEvidence: boolean;
  /** Paths that exist and are stat-able (e.g. an unmounted /data/adb). */
  present: string[];
  /** Paths that exist but are root-only (EACCES) — the DenyList-resistant signal. */
  denied: string[];
  /** Probes that failed for an unrelated reason; not evidence either way. */
  unreadable: string[];
  /**
   * /data/adb children that answered EACCES. Only meaningful together with a
   * PRESENT /data/adb — never evidence on its own (optional: older modules).
   */
  managerDenied?: string[];
  /**
   * Paths whose errno cannot decide anything — the parent is root-only on stock
   * Android (/debug_ramdisk) or SELinux/OEM-dependent (/data/local). These were
   * the clean-device "evidence" behind the reported false positives. Optional.
   */
  indeterminate?: string[];
  /** Verified-boot / bootloader state. Evidence only — never a sole verdict. */
  bootloaderUnlocked: boolean;
  verifiedBootState: string;
  /**
   * Root-framework MOUNTS seen in this process's mount view, as named kinds
   * (`root_overlay_on_system`, `root_module_mount`, `magisk_debug_ramdisk`).
   * Empty = none seen, NOT proof of a clean device: a hidden (DenyList) root
   * framework removes these mounts from the app's namespace. Optional because
   * an older native module does not emit it.
   */
  mountEvidence?: string[];
  /** Bounded sample of the matching mount lines (paths only). */
  mountSamples?: string[];
  /** `su` reachable through the process PATH (stat-based probe). */
  suOnPath?: string[];
  /** `/system` is writable by this process — a remounted-system artifact. */
  systemWritable?: boolean;
}

export async function getNativeRootArtifactEvidence(): Promise<NativeRootArtifactEvidence | null> {
  if (Platform.OS !== 'android') return null;
  const mod = getModule();
  if (!mod) return null;
  try {
    const raw = await mod.getRootArtifactEvidence() as string | null;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    const parsed = JSON.parse(raw) as NativeRootArtifactEvidence;
    // Guard against a malformed/partial payload: an object without the boolean
    // and the arrays is not usable evidence. Null (UNKNOWN) is honest; a
    // half-parsed object could be read as clean.
    if (parsed?.available !== true || typeof parsed.rootFrameworkEvidence !== 'boolean') return null;
    if (!Array.isArray(parsed.present) || !Array.isArray(parsed.denied)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * On-demand STRUCTURED root diagnostics — "why was this device classified as
 * rooted?" without a debugger.
 *
 * Returns one classified entry per native check (id, category, positive /
 * negative / inconclusive, evidence, confidence, contributes) plus which
 * positives fed BOTH verdicts. NULL on iOS, on an older native module, and
 * whenever the report is unusable — callers must treat null as UNKNOWN, never as
 * a clean device. Internal diagnostics only: no student-facing UI reads this and
 * the evidence strings hold system artifact paths, package ids and counts — no
 * user data, tokens or identifiers.
 */
export async function getRootDetectionDiagnostics(): Promise<RootDiagnosticsReport | null> {
  if (Platform.OS !== 'android') return null;
  const mod = getModule();
  if (!mod || typeof mod.getRootDiagnostics !== 'function') return null;
  try {
    const raw = await mod.getRootDiagnostics() as string | null;
    return parseRootDiagnostics(raw);
  } catch {
    return null;
  }
}

export async function isNativeSignatureValid(): Promise<boolean> {
  const mod = getModule();
  if (!mod) return true; // safe default on non-Android
  try { return await mod.isSignatureValid() as boolean; } catch { return true; }
}

export async function isNativeTampered(): Promise<boolean> {
  if (Platform.OS === 'android') {
    const mod = getModule();
    if (!mod) return false;
    try { return await mod.isTampered() as boolean; } catch { return false; }
  }
  if (Platform.OS === 'ios') {
    const mod = getIOSModule();
    if (!mod) return false;
    try { return await mod.isBundleTampered() as boolean; } catch { return false; }
  }
  return false;
}

// ─── Phase 3 — new individual Android APIs ────────────────────────────────────

// ─── Pure-JS iOS VPN detection ───────────────────────────────────────────────
//
// This is a FALLBACK only — used when the native IOSSecurityModule is null
// (e.g. Expo Go, simulator without native module compiled).
//
// In production builds, isNativeVPNDetected() calls mod.isVPNDetected() via the
// native Swift module (IOSSecurityModule.checkVPNSafe()), which now uses a two-gate
// check (NWPath + getifaddrs IFF_UP). This JS path is only reached on fallback.
//
// FALSE-POSITIVE FIX:
//
// The previous Method 2 triggered on state.type === 'other' || 'unknown'.
// @react-native-community/netinfo returns 'other' for ANY connection type it cannot
// classify as wifi, cellular, bluetooth, ethernet, wimax, or vpn. This includes:
//   • Ethernet adapters via USB-C/Lightning dongle (not VPN)
//   • Tethering / Personal Hotspot connections (not VPN)
//   • Some corporate Wi-Fi SSIDs where system reports 'other' (not VPN)
//   • iCloud Private Relay (NOT a VPN; iOS does not report it as vpn)
//
// Method 1 (state.type === 'vpn') is the ONLY reliable cross-platform signal from
// NetInfo. @react-native-community/netinfo reports type=vpn when:
//   • iOS Settings > VPN is actively connected (IKEv2, IPSec, L2TP, Personal VPN)
//   • NEVPNManager status is .connected at the framework level
//
// Third-party packet-tunnel apps (WireGuard, OpenVPN, Tailscale, Cloudflare WARP)
// on iOS do NOT reliably report type=vpn — they require the native module's NWPath +
// getifaddrs approach. The JS fallback therefore misses them, but this is acceptable
// because: (a) the native module IS compiled and will handle them, (b) the JS fallback
// only runs when the native module is absent, where we prefer no false-positive.
//
//  ┌─────────────────────────────────────────────────────────────────────────┐
//  │ VPN type            │ NetInfo type  │ JS fallback detects?              │
//  ├─────────────────────┼───────────────┼───────────────────────────────────┤
//  │ Personal VPN        │ 'vpn'         │ ✅ Method 1 — direct type match   │
//  │ IKEv2 (system)      │ 'vpn'         │ ✅ Method 1                       │
//  │ IPSec (system)      │ 'vpn'         │ ✅ Method 1                       │
//  │ L2TP (system)       │ 'vpn'         │ ✅ Method 1                       │
//  │ WireGuard app       │ 'other'       │ ❌ Not detected (native handles)  │
//  │ OpenVPN app         │ 'other'       │ ❌ Not detected (native handles)  │
//  │ Tailscale           │ 'other'       │ ❌ Not detected (native handles)  │
//  │ Cloudflare WARP     │ 'other'       │ ❌ Not detected (native handles)  │
//  │ Ethernet dongle     │ 'other'       │ ✅ Not flagged (false-pos removed) │
//  │ Hotspot             │ 'other'       │ ✅ Not flagged (false-pos removed) │
//  └─────────────────────────────────────────────────────────────────────────┘

async function detectVPNviaNetInfo(): Promise<boolean> {
  const TAG = '[NativeSecurity][iOS-VPN-JS-fallback]';
  try {
    console.log(TAG, 'Stage-1: fetching NetInfo state…');
    const state = await NetInfo.fetch();
    console.log(TAG, 'Stage-2: raw state =', JSON.stringify({
      type:                state.type,
      isConnected:         state.isConnected,
      isInternetReachable: state.isInternetReachable,
    }));

    // Method 1 — only reliable JS signal: NetInfo explicitly classifies as 'vpn'.
    // Covers: Personal VPN, IKEv2, IPSec, L2TP in iOS Settings > VPN.
    if (state.type === 'vpn') {
      console.log(TAG, 'Stage-3 ✅ POSITIVE: type === "vpn" (explicit VPN transport)');
      return true;
    }

    // Method 2 REMOVED — type=other/unknown caused false positives on:
    //   • USB-C Ethernet adapters, Hotspot, corporate Wi-Fi, iCloud Private Relay.
    // Packet-tunnel VPNs (WireGuard, OpenVPN, Tailscale, WARP) that show as 'other'
    // are handled by the native IOSSecurityModule two-gate check. When the native
    // module is absent (fallback path), we accept the miss to avoid false positives.

    console.log(TAG, 'Stage-3 ✗ No VPN signal. type=' + state.type +
      ', connected=' + String(state.isConnected) +
      ' (note: type=other is NOT treated as VPN in JS fallback)');
    return false;
  } catch (e) {
    console.warn(TAG, 'NetInfo.fetch() threw:', e, '→ fail-open (returning false)');
    return false;
  }
}

/**
 * Android: native SecurityModule ConnectivityManager TRANSPORT_VPN + NetworkInterface scan.
 * iOS:     pure-JS multi-method detection via @react-native-community/netinfo.
 *          (IOSSecurityModule removed for build stability — see comment above.)
 *          Covers Personal VPN, IKEv2, IPSec, WireGuard, OpenVPN, Tailscale, WARP.
 */
/**
 * WHICH iOS VPN signal path is live right now.
 *
 *   'native'           — IOSSecurityModule present: NWPathMonitor gate +
 *                        getifaddrs(IFF_UP) tunnel-interface gate (authoritative).
 *   'netinfo-fallback' — native module absent: only NetInfo type==='vpn' runs,
 *                        which MISSES packet-tunnel VPNs (WireGuard, OpenVPN,
 *                        Tailscale, Cloudflare WARP report as wifi/other).
 *
 * Exported so the security pipeline can report a degraded VPN signal AS
 * EVIDENCE instead of letting the weaker path pass as a verified-clean result.
 * Returns null on non-iOS platforms (their decision comes from the native
 * security-flag batch).
 */
export function getIosVpnSignalPath(): VpnSignalPath | null {
  if (Platform.OS !== 'ios') return null;
  // 'unavailable' is reported by the caller when the probe itself could not
  // produce a measurement (threw / timed out).
  return getIOSModule() ? 'native' : 'netinfo-fallback';
}

export async function isNativeVPNDetected(): Promise<boolean> {
  console.log('[NativeSecurity][isNativeVPNDetected] platform=', Platform.OS);

  if (Platform.OS === 'android') {
    const mod = getModule();
    console.log('[NativeSecurity][isNativeVPNDetected] android mod=', mod ? '✓' : '✗ null');
    if (!mod) return false;
    try {
      const result = await mod.isVpnActive() as boolean;
      console.log('[NativeSecurity][isNativeVPNDetected] android result=', result);
      return result;
    } catch (e) {
      console.warn('[NativeSecurity][isNativeVPNDetected] android threw:', e);
      return false;
    }
  }

  if (Platform.OS === 'ios') {
    // Try native module first (if ever recompiled/re-added)
    const mod = getIOSModule();
    if (mod) {
      try {
        const result = await mod.isVPNDetected() as boolean;
        console.log('[NativeSecurity][isNativeVPNDetected] iOS native result=', result);
        return result;
      } catch {
        console.warn('[NativeSecurity][isNativeVPNDetected] iOS native threw → JS fallback');
      }
    } else {
      console.log('[NativeSecurity][isNativeVPNDetected] iOS native module null → JS fallback (expected after build fix)');
    }
    return detectVPNviaNetInfo();
  }

  return false;
}

/** Android multi-method root detection (su paths, props, test-keys, write test, packages).
 *  iOS: always false — use jailbreakDetected from getSecurityFlags instead. */
export async function isNativeRootDetected(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const mod = getModule();
  if (!mod) return false;
  try { return await mod.isRooted() as boolean; } catch { return false; }
}

/** Android emulator detection (Build fingerprint/model/props/sensor count).
 *  Always false on iOS/Web. */
export async function isNativeEmulatorDetected(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const mod = getModule();
  if (!mod) return false;
  try { return await mod.isEmulator() as boolean; } catch { return false; }
}

/** Android mock location detection (AppOpsManager + Settings.Secure + permission scan).
 *  Always false on iOS/Web. */
export async function isNativeMockLocationDetected(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const mod = getModule();
  if (!mod) return false;
  try { return await mod.isMockLocationEnabled() as boolean; } catch { return false; }
}

/** iOS proxy detection via CFNetworkCopySystemProxySettings. Always false on Android/Web. */
export async function isNativeProxyDetected(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  const mod = getIOSModule();
  if (!mod) return false;
  try { return await mod.isProxyDetected() as boolean; } catch { return false; }
}

/** iOS jailbreak detection (17 heuristics — Dopamine/RootHide/Palera1n aware). Always false on Android/Web. */
export async function isNativeJailbreakDetected(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  const mod = getIOSModule();
  if (!mod) return false;
  try { return await mod.isJailbreakDetected() as boolean; } catch { return false; }
}

// ─── App Attest (iOS) ─────────────────────────────────────────────────────────

// ─── App Attest error codes (re-exported for callers to distinguish) ──────────

/** Error code returned when the App Attest key has been permanently invalidated. */
export const APP_ATTEST_INVALID_KEY = 'APP_ATTEST_INVALID_KEY';
/** Error code returned when Apple's attestation/assertion server is transiently unavailable. */
export const APP_ATTEST_SERVER_ERROR = 'APP_ATTEST_SERVER_ERROR';
/** Error code when App Attest is not supported on this device (simulator / A11-). */
export const APP_ATTEST_UNSUPPORTED = 'APP_ATTEST_UNSUPPORTED';
/** Error code when DeviceCheck is not supported. */
export const DEVICE_CHECK_UNSUPPORTED = 'DEVICE_CHECK_UNSUPPORTED';

/**
 * Generates an App Attest key and returns the keyId.
 * iOS 14+ / physical A12+ device only.
 * Rejects with APP_ATTEST_UNSUPPORTED on simulator / older device — caller should use DeviceCheck.
 * The JS caller MUST persist the keyId to expo-secure-store for reuse across sessions.
 */
export async function generateAppAttestKey(): Promise<string | null> {
  if (Platform.OS !== 'ios') return null;
  const mod = getIOSModule();
  if (!mod) return null;
  try {
    return await mod.generateAppAttestKey() as string;
  } catch {
    return null;
  }
}

/**
 * Attests a previously generated key using Apple's servers.
 * clientDataHashBase64: base64-encoded SHA-256 hash of the server challenge.
 * Returns base64-encoded attestation object to send to the backend.
 *
 * Throws with code APP_ATTEST_INVALID_KEY  → key is permanently invalid; call generateAppAttestKey() again.
 * Throws with code APP_ATTEST_SERVER_ERROR → transient; retry without regenerating.
 */
export async function attestAppAttestKey(
  keyId: string,
  clientDataHashBase64: string,
): Promise<string | null> {
  if (Platform.OS !== 'ios') return null;
  const mod = getIOSModule();
  if (!mod) return null;
  return await mod.attestAppAttestKey(keyId, clientDataHashBase64) as string;
  // Intentionally let the error propagate so callers can inspect the error code
}

/**
 * Generates an App Attest assertion for a per-request challenge.
 * challenge: the server-generated nonce string (hashed internally with SHA-256 by Swift).
 * Returns base64-encoded assertion to send to the backend.
 *
 * Throws with code APP_ATTEST_INVALID_KEY  → key invalidated; caller must regenerate + re-attest.
 * Throws with code APP_ATTEST_SERVER_ERROR → transient; retry.
 */
export async function generateAppAttestAssertion(
  keyId: string,
  challenge: string,
): Promise<string | null> {
  if (Platform.OS !== 'ios') return null;
  const mod = getIOSModule();
  if (!mod) return null;
  return await mod.generateAppAttestAssertion(keyId, challenge) as string;
  // Intentionally let the error propagate so callers can inspect the error code
}

/**
 * Generates a DeviceCheck token as fallback when App Attest is unavailable.
 * Does not prove app authenticity, but confirms a real Apple device.
 * Returns base64-encoded token to send to our backend.
 */
export async function generateDeviceCheckToken(): Promise<string | null> {
  if (Platform.OS !== 'ios') return null;
  const mod = getIOSModule();
  if (!mod) return null;
  try {
    return await mod.generateDeviceCheckToken() as string;
  } catch {
    return null;
  }
}

/**
 * Request a Google Play Integrity token.
 * The nonce must be a server-generated unique value (base64url, 16-500 bytes).
 * Returns null on non-Android or when Play Services are unavailable.
 * The token must be verified server-side — NEVER trust the client result.
 */
export async function requestPlayIntegrityToken(nonce: string): Promise<string | null> {
  const mod = getModule();
  if (!mod) return null;
  try {
    return await mod.requestIntegrityToken(nonce) as string;
  } catch {
    return null;
  }
}

// ─── NativeEventEmitter — works on both Android and iOS ──────────────────────

let _androidEmitter: NativeEventEmitter | null = null;
let _iosEmitter:     NativeEventEmitter | null = null;

function getAndroidEmitter(): NativeEventEmitter | null {
  const mod = getModule();
  if (!mod) return null;
  if (!_androidEmitter) _androidEmitter = new NativeEventEmitter(mod);
  return _androidEmitter;
}

function getIOSEmitter(): NativeEventEmitter | null {
  const mod = getIOSModule();
  if (!mod) return null;
  if (!_iosEmitter) _iosEmitter = new NativeEventEmitter(mod);
  return _iosEmitter;
}

export type RecordingEventCallback  = () => void;
export type ScreenshotEventCallback = () => void;

/* ─────────────── NATIVE CONTAINMENT (the fast path, Android only) ────────
 * SecurityContainment.kt owns two things natively, before any React work:
 *   • the LATCH that keeps a confirmed window-mode / VPN violation confirmed,
 *   • a full-screen COVER attached to this app's own window, so the screen is
 *     blocked on the same frame as the signal rather than after a bridge round
 *     trip, a React render and a navigation commit.
 *
 * The floating-window / overlay evidence path (obscured touches, the overlay
 * latch, its permission and JS events) was REMOVED with that subsystem.
 *
 * These functions are the whole JS surface. All degrade to a safe no-op off
 * Android, so callers never branch on platform and never read "module absent"
 * as "safe".
 */

export type NativeContainmentReason = 'window' | 'vpn';

export interface NativeContainmentState {
  /** Every reason the NATIVE side currently holds (ordered, deduped). */
  reasons: NativeContainmentReason[];
  /** The platform's window-mode reading mirrored natively. */
  mode: string;
  /** Native monotonic ms (elapsedRealtime) at emit time. */
  signalMs: number;
  /** Which native path produced this state (diagnostics only). */
  source: string;
}

const EMPTY_CONTAINMENT: NativeContainmentState = {
  reasons: [],
  mode: 'unknown',
  signalMs: 0,
  source: 'unavailable',
};

function normaliseReasons(raw: unknown): NativeContainmentReason[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const out: NativeContainmentReason[] = [];
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (value === 'window' || value === 'vpn') {
      if (!out.includes(value)) out.push(value);
    }
  }
  return out;
}

function toContainmentState(raw: unknown): NativeContainmentState {
  if (!raw || typeof raw !== 'object') return EMPTY_CONTAINMENT;
  const r = raw as Record<string, unknown>;
  return {
    reasons: normaliseReasons(r.reasons),
    mode: typeof r.mode === 'string' && r.mode.length > 0 ? r.mode : 'unknown',
    signalMs: typeof r.nativeMs === 'number' ? r.nativeMs : 0,
    source: typeof r.source === 'string' ? r.source : 'native',
  };
}

/** One authoritative native containment reading (used on mount and on resume). */
export async function getNativeContainmentState(): Promise<NativeContainmentState> {
  const mod = getModule();
  if (!mod || typeof mod.getContainmentState !== 'function') return EMPTY_CONTAINMENT;
  try {
    return toContainmentState(await mod.getContainmentState());
  } catch {
    return EMPTY_CONTAINMENT;
  }
}

/**
 * Live native containment state. Emitted on every reason change (raise/clear),
 * so one subscription carries window + VPN without any polling.
 */
export function onNativeContainmentChanged(
  cb: (state: NativeContainmentState) => void,
): () => void {
  if (Platform.OS !== 'android') return () => {};
  const emitter = getAndroidEmitter();
  if (!emitter) return () => {};
  const sub = emitter.addListener('containmentStateChanged', (evt: unknown) => {
    cb(toContainmentState(evt));
  });
  return () => sub.remove();
}

/** The native cover's own recheck button asked for a verification. */
export function onNativeContainmentRevalidateRequested(cb: () => void): () => void {
  if (Platform.OS !== 'android') return () => {};
  const emitter = getAndroidEmitter();
  if (!emitter) return () => {};
  const sub = emitter.addListener('containmentRevalidateRequested', () => cb());
  return () => sub.remove();
}

/**
 * Tell the native side the React gate is now on screen: the native cover stands
 * down, so the user sees exactly ONE lock screen. The native REASON SET stays
 * authoritative — unmounting the React gate makes the cover return.
 */
export async function reportNativeGateMounted(): Promise<void> {
  const mod = getModule();
  if (!mod || typeof mod.reportGateMounted !== 'function') return;
  try { await mod.reportGateMounted(); } catch { /* diagnostics only */ }
}

export async function reportNativeGateUnmounted(): Promise<void> {
  const mod = getModule();
  if (!mod || typeof mod.reportGateUnmounted !== 'function') return;
  try { await mod.reportGateUnmounted(); } catch { /* diagnostics only */ }
}

/**
 * Native containment timeline (monotonic ms marks).
 *
 * RELEASE-BUILD REASON: every `android.util.Log` call is stripped by
 * `-assumenosideeffects` in proguard-rules, so native logging cannot be read on
 * the APK users install. The native side keeps this bounded ring buffer instead
 * and we print it from JS (`ReactNativeJS` lines are not stripped), which makes
 * detection → cover → bridge → gate latency measurable on a release build.
 *
 * PRIVACY: stage names, reason names, counts and timestamps ONLY — no URL,
 * token, identity or payload can appear in it.
 */
export interface NativeContainmentTimeline {
  entries: string[];
  /** Marks dropped after the 64-entry bound was reached. */
  dropped: number;
  /** The live reason CSV at read time. */
  reasons: string;
  mode: string;
  /** Age of the unbroken violation (monotonic ms); -1 when clear. */
  latchAgeMs: number;
  /**
   * Window-mode aggregation counters (see src/lib/windowModeAggregator.ts).
   * They make the churn MEASURABLE on a release build: how many duplicate
   * reports the single decision point collapsed, how many weak full-screen
   * snapshots it refused while a foreign window was in force, and how many
   * recoveries it held back for a confirming read.
   */
  windowSuppressed: number;
  /** Duplicates collapsed by the last ACCEPTED transition. */
  windowCollapsed: number;
}

export async function getNativeContainmentTimeline(): Promise<NativeContainmentTimeline | null> {
  const mod = getModule();
  if (!mod || typeof mod.getContainmentTimeline !== 'function') return null;
  try {
    const raw = await mod.getContainmentTimeline();
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const entries = Array.isArray(r.entries)
      ? (r.entries as unknown[]).filter((e): e is string => typeof e === 'string')
      : [];
    return {
      entries,
      dropped: typeof r.dropped === 'number' ? r.dropped : 0,
      reasons: typeof r.reasons === 'string' ? r.reasons : '',
      mode: typeof r.mode === 'string' ? r.mode : 'unknown',
      latchAgeMs: typeof r.latchAgeMs === 'number' ? r.latchAgeMs : -1,
      windowSuppressed: typeof r.windowSuppressed === 'number' ? r.windowSuppressed : 0,

      windowCollapsed: typeof r.windowCollapsed === 'number' ? r.windowCollapsed : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Clear ONE native reason from the POLICY path only (a completed verdict saying
 * an admin-whitelisted VPN is allowed). Window reasons are platform evidence and
 * are never cleared from JS decisions. (The overlay reason no longer exists.)
 */
export async function clearNativeContainmentReason(
  reason: NativeContainmentReason,
): Promise<boolean> {
  const mod = getModule();
  if (!mod || typeof mod.clearContainmentReason !== 'function') return false;
  try {
    return (await mod.clearContainmentReason(reason)) === true;
  } catch {
    return false;
  }
}

/* ─────────────── Multi-window / split-screen (mandatory full-screen) ───────
 * See plugins/withSecurityModule.js (Android SecurityModule.kt + the
 * withMainActivity forwarders) for the native implementation and its
 * documented platform limits (MULTI_WINDOW_DETECTION_LIMITS in
 * securityStateModel.ts). The whole JS surface is these three functions plus
 * the evidence fields in NativeSecurityFlags:
 *
 *   getNativeWindowMode()             — one authoritative measurement
 *   enableNativeWindowModeMonitoring() — attach the native triggers
 *   onNativeWindowModeChanged(cb)      — push updates on real transitions
 *
 * They degrade to "unknown" / no-op off Android (Expo Go, web, iOS), so a
 * caller never branches on platform — and never mistakes "module absent" for
 * "full-screen confirmed".
 */

export interface NativeWindowModeReading {
  /** 'fullscreen' | 'multi_window' | 'picture_in_picture' | 'unknown'. */
  mode: string;
  /** True for split-screen / multi-window AND for our own PiP. */
  inMultiWindow: boolean;
  /** True only when THIS app is floating in picture-in-picture. */
  inPictureInPicture: boolean;
  /**
   * False means the platform could not answer (no activity yet, older device,
   * module unavailable). It is NOT a full-screen measurement.
   */
  measured: boolean;
}

const UNMEASURED_WINDOW_MODE: NativeWindowModeReading = {
  mode: 'unknown',
  inMultiWindow: false,
  inPictureInPicture: false,
  measured: false,
};

/** Normalise an untrusted native/JSON value into the reading contract. */
function toWindowModeReading(raw: unknown): NativeWindowModeReading {
  if (!raw || typeof raw !== 'object') return UNMEASURED_WINDOW_MODE;
  const r = raw as Record<string, unknown>;
  const mode = typeof r.mode === 'string' && r.mode.length > 0 ? r.mode : 'unknown';
  return {
    mode,
    inMultiWindow: r.inMultiWindow === true,
    inPictureInPicture: r.inPictureInPicture === true,
    measured: r.measured === true,
  };
}

/**
 * THE PROCESS-WIDE VPN STATE (native `VpnWatch`).
 *
 * `vpnTransport` is the fact a video barrier needs: THIS app's default network
 * carries `NetworkCapabilities.TRANSPORT_VPN`, i.e. our own traffic is tunnelled.
 * `vpnPresent` only says a VPN exists somewhere on the device. They are kept
 * apart deliberately — "a VPN exists" is not "our traffic uses it".
 *
 * `registered: false` means UNKNOWN (the watcher could not start). Callers must
 * treat that as BLOCKED: an unmeasured network is not a clean network.
 */
export interface NativeVpnSnapshot {
  vpnTransport: boolean;
  vpnPresent: boolean;
  registered: boolean;
  /** Monotonic age of the last state change; -1 when it has never changed. */
  ageSinceChangeMs: number;
}

/**
 * Make sure the native watcher is running. The activity starts it on resume, so
 * this is only a self-heal for the case where the JS layer is reached first.
 */
export async function ensureNativeVpnWatch(): Promise<boolean> {
  const mod = getModule();
  if (!mod || typeof mod.ensureVpnWatchRegistration !== 'function') return false;
  try {
    return (await mod.ensureVpnWatchRegistration()) === true;
  } catch {
    return false;
  }
}

/**
 * FAST mandatory VPN preflight: one bridge call, no network, no detector suite.
 * Resolves null when the module or the reading is unavailable (fail closed).
 */
export async function getNativeVpnSnapshot(): Promise<NativeVpnSnapshot | null> {
  const mod = getModule();
  if (!mod || typeof mod.getVpnSnapshot !== 'function') return null;
  try {
    const raw = await mod.getVpnSnapshot();
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    return {
      vpnTransport: r.vpnTransport === true,
      vpnPresent: r.vpnPresent === true,
      registered: r.registered === true,
      ageSinceChangeMs: typeof r.ageSinceChangeMs === 'number' ? r.ageSinceChangeMs : -1,
    };
  } catch {
    return null;
  }
}

/**
 * One authoritative measurement of the CURRENT window mode.
 *
 * Android-only by construction: the documented APIs (isInMultiWindowMode /
 * isInPictureInPictureMode, API 24+) describe the Android window model. On
 * iOS/web this resolves the honest 'unknown', measured:false — those platforms
 * have their own windowing model that this restriction does not cover.
 */
export async function getNativeWindowMode(): Promise<NativeWindowModeReading> {
  const mod = getModule();
  if (!mod || typeof mod.getWindowMode !== 'function') return UNMEASURED_WINDOW_MODE;
  try {
    return toWindowModeReading(await mod.getWindowMode());
  } catch {
    // A thrown read is unmeasured, never "full-screen".
    return UNMEASURED_WINDOW_MODE;
  }
}

/**
 * Attach the native window-mode triggers (activity callback relay, window
 * layout watcher, host-resume hook) and re-read the mode once.
 *
 * Idempotent and safe on every session start / foreground return (Android can
 * recreate the activity, which drops the watcher). Resolves true only when a
 * REAL measurement exists afterwards — false means "this platform cannot
 * answer", which callers must not read as proof of full-screen use.
 */
export async function enableNativeWindowModeMonitoring(): Promise<boolean> {
  const mod = getModule();
  if (!mod || typeof mod.enableWindowModeMonitoring !== 'function') return false;
  try {
    return (await mod.enableWindowModeMonitoring()) === true;
  } catch {
    return false;
  }
}

/**
 * Subscribe to real window-mode transitions. The native side emits only on an
 * actual change of state (it deduplicates repeated reports of the same mode),
 * so this is one event per transition — not one per layout pass or per check.
 */
export function onNativeWindowModeChanged(
  cb: (reading: NativeWindowModeReading) => void,
): () => void {
  if (Platform.OS !== 'android') return () => {};
  const emitter = getAndroidEmitter();
  if (!emitter) return () => {};
  const sub = emitter.addListener('windowModeChanged', (evt: unknown) => {
    cb(toWindowModeReading(evt));
  });
  return () => sub.remove();
}

// ── Screen recording events ───────────────────────────────────────────────────

export function onScreenRecordingStarted(cb: RecordingEventCallback): () => void {
  if (Platform.OS === 'android') {
    const emitter = getAndroidEmitter();
    if (!emitter) return () => {};
    const sub = emitter.addListener('screenRecordingStarted', cb);
    return () => sub.remove();
  }
  if (Platform.OS === 'ios') {
    const emitter = getIOSEmitter();
    if (!emitter) return () => {};
    const sub = emitter.addListener('iOSScreenRecordingStarted', cb);
    return () => sub.remove();
  }
  return () => {};
}

export function onScreenRecordingStopped(cb: RecordingEventCallback): () => void {
  if (Platform.OS === 'android') {
    const emitter = getAndroidEmitter();
    if (!emitter) return () => {};
    const sub = emitter.addListener('screenRecordingStopped', cb);
    return () => sub.remove();
  }
  if (Platform.OS === 'ios') {
    const emitter = getIOSEmitter();
    if (!emitter) return () => {};
    const sub = emitter.addListener('iOSScreenRecordingStopped', cb);
    return () => sub.remove();
  }
  return () => {};
}

// ── Screenshot events (iOS native, supplements expo-screen-capture listener) ──

/**
 * Subscribe to native iOS screenshot events.
 * Fires immediately on UIApplication.userDidTakeScreenshotNotification.
 * On Android, screenshots are blocked by FLAG_SECURE — this is never called.
 */
export function onNativeScreenshotTaken(cb: ScreenshotEventCallback): () => void {
  if (Platform.OS !== 'ios') return () => {};
  const emitter = getIOSEmitter();
  if (!emitter) return () => {};
  const sub = emitter.addListener('iOSScreenshotTaken', cb);
  return () => sub.remove();
}

// ── Native iOS security event subscriptions ───────────────────────────────────

/**
 * Subscribe to the iOS native jailbreak-detected event.
 * Emitted by IOSSecurityModule immediately after getSecurityFlags() fires a positive.
 * Never fires on Android/Web.
 */
export function onNativeJailbreakDetected(cb: (detail: string) => void): () => void {
  if (Platform.OS !== 'ios') return () => {};
  const emitter = getIOSEmitter();
  if (!emitter) return () => {};
  const sub = emitter.addListener('iOSJailbreakDetected', (evt: { detail: string }) => cb(evt?.detail ?? 'jailbreak'));
  return () => sub.remove();
}

/**
 * Subscribe to the iOS native debugger-attached event.
 * Emitted by IOSSecurityModule when the batch flags call detects a debugger.
 */
export function onNativeDebuggerAttached(cb: (detail: string) => void): () => void {
  if (Platform.OS !== 'ios') return () => {};
  const emitter = getIOSEmitter();
  if (!emitter) return () => {};
  const sub = emitter.addListener('iOSDebuggerAttached', (evt: { detail: string }) => cb(evt?.detail ?? 'debugger'));
  return () => sub.remove();
}

/**
 * Subscribe to the iOS native integrity-failed event.
 * Emitted by IOSSecurityModule when bundle tamper is detected via the batch call.
 */
export function onNativeIntegrityFailed(cb: (detail: string) => void): () => void {
  if (Platform.OS !== 'ios') return () => {};
  const emitter = getIOSEmitter();
  if (!emitter) return () => {};
  const sub = emitter.addListener('iOSIntegrityFailed', (evt: { detail: string }) => cb(evt?.detail ?? 'integrity'));
  return () => sub.remove();
}
