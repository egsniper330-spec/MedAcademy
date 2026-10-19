/**
 * securitySignalReport.ts — PURE builder for the on-device security-signal report.
 *
 * WHY THIS EXISTS
 *   A release install on ONE device can be blocked with a single finding and
 *   risk score 20 ("Debug Mode Active") while the same build works everywhere
 *   else. The engine reports metrologically DIFFERENT conditions — a test-only
 *   build flag, a JS debug bundle (__DEV__), an emulator-like device, a selected
 *   mock-location app — as the same event type (`debug_detected`), so the label
 *   alone cannot tell an operator which one fired, and the affected phone cannot
 *   be connected to a workstation for logcat.
 *
 *   This module turns a plain snapshot of the device's own security-signal
 *   values into a short, human-readable report the owner can copy and send to
 *   their administrator.
 *
 * ─── SAFETY CONTRACT (do not weaken) ─────────────────────────────────────────
 *   • READ-ONLY. Nothing here writes state, changes a policy, alters the risk
 *     score, releases a gate or talks to the backend. It has no imports at all
 *     (no React, no native bridge, no network) so it can never become a
 *     privileged path.
 *   • Collects ONLY security-signal values, coarse platform/API/build identity
 *     and a timestamp. No credentials, tokens, serial numbers, advertising ids
 *     or app/user data.
 *   • Reports a MISSING measurement honestly ("could not be measured") instead
 *     of presenting fail-safe defaults as a clean device.
 *
 * The snapshot is assembled by the caller (SecuritySignalReport.tsx) from
 * getNativeSecurityFlags() and expo-device/expo-application metadata.
 */

/** The Android debug-state signals that can produce a `debug_detected` finding. */
export const REPORT_SIGNALS = [
  {
    key: 'developerOptionsEnabled',
    label: 'Developer options',
    hint: 'Settings → Developer options',
  },
  {
    key: 'adbEnabled',
    label: 'USB debugging (ADB)',
    hint: 'Settings → Developer options → USB debugging',
  },
  {
    key: 'debuggerAttached',
    label: 'Debugger connected to the app',
    hint: 'A live debugger session is attached',
  },
  {
    key: 'testOnlyBuild',
    label: 'Test-only build flag',
    hint: 'The installed app was packaged as a test build',
  },
  {
    key: 'emulatorDetected',
    label: 'Emulator / virtual device',
    hint: 'Device looks like an emulator to the integrity checks',
  },
  {
    key: 'mockLocationDetected',
    label: 'Mock-location app selected',
    hint: 'Settings → Developer options → Select mock location app',
  },
] as const;

export type ReportSignalKey = (typeof REPORT_SIGNALS)[number]['key'];

/** One finding exactly as the authoritative evaluation reported it. */
export interface ReportFinding {
  /** Human label shown on the blocking screen (already resolved). */
  label: string;
  /** Raw engine event type (audit vocabulary) — support uses it to pin the detector. */
  type: string;
  /** Detector's own description of the measured condition (may be absent). */
  detectionMethod?: string | null;
}

export interface SecuritySignalSnapshot {
  platform: string;
  /** Android API level (Platform.Version); null when not applicable. */
  apiLevel?: number | null;
  deviceManufacturer?: string | null;
  deviceModel?: string | null;
  osVersion?: string | null;
  osBuildFingerprint?: string | null;
  appVersion?: string | null;
  appBuildNumber?: number | null;
  /**
   * False when the native security module could not be reached: the signal
   * values below are then fail-safe defaults, NOT measurements.
   */
  nativeModuleAvailable: boolean;
  /** Raw signal values keyed by ReportSignalKey (missing → unknown). */
  signals: Partial<Record<ReportSignalKey, unknown>>;
  findings: ReportFinding[];
  /** Epoch milliseconds when the report was produced. */
  generatedAt: number;
}

/**
 * on / off / unknown / unavailable — never conflates "not measured" with
 * "off".
 *
 * `measured` is the caller's module-level availability flag. When the native
 * security module could not be reached the values handed to us are the
 * fail-safe DEFAULTS (all false), so reporting them as "off" would be a false
 * clean claim on the one screen a blocked user relies on. They are labelled
 * "unavailable" instead.
 *
 * PER-SIGNAL granularity is not available: the native batch wraps every Kotlin
 * detector in `runCatching { … }.getOrDefault(false)`, so a detector that threw
 * is indistinguishable from a measured `false` by the time JS sees it. That is
 * why this is a module-level flag rather than a per-row one.
 */
export function signalValueLabel(
  value: unknown,
  measured: boolean = true,
): 'on' | 'off' | 'unknown' | 'unavailable' {
  if (!measured) return 'unavailable';
  if (value === true) return 'on';
  if (value === false) return 'off';
  return 'unknown';
}

function text(value: unknown, fallback = 'not reported'): string {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

/**
 * Build the report text. Deterministic: the same snapshot always produces the
 * same string (the timestamp is taken from the snapshot, never from Date.now()).
 */
export function buildSecuritySignalReport(snapshot: SecuritySignalSnapshot): string {
  const when = new Date(snapshot.generatedAt);
  const iso = Number.isNaN(when.getTime()) ? 'unknown' : when.toISOString();

  const lines: string[] = [];
  lines.push('MedAcademy device security report');
  lines.push(`Generated: ${iso}`);
  lines.push('');
  lines.push(`App: ${text(snapshot.appVersion)} (build ${text(snapshot.appBuildNumber)}) — ${text(snapshot.platform, 'unknown')}`);
  lines.push(
    `Device: ${text(snapshot.deviceManufacturer, 'unknown')} ${text(snapshot.deviceModel, 'unknown')}`,
  );
  lines.push(
    `OS: ${text(snapshot.osVersion, 'unknown')}` +
      (snapshot.platform === 'android' ? ` (API ${text(snapshot.apiLevel, 'unknown')})` : ''),
  );
  lines.push(`Build fingerprint: ${text(snapshot.osBuildFingerprint, 'not reported')}`);
  lines.push('');
  lines.push(
    snapshot.nativeModuleAvailable
      ? 'Native security module: measured (values below come from this device)'
      : 'Native security module: UNAVAILABLE — the values below could NOT be measured on this device and are fail-safe defaults, not a clean result',
  );
  lines.push('');

  lines.push(`Blocking findings reported by the app (${snapshot.findings.length}):`);
  if (snapshot.findings.length === 0) {
    lines.push('  (none reported in this evaluation)');
  } else {
    for (const f of snapshot.findings) {
      const method = f.detectionMethod && f.detectionMethod.trim().length > 0
        ? ` — detector: ${f.detectionMethod.trim()}`
        : '';
      lines.push(`  - ${f.label} [${f.type}]${method}`);
    }
  }
  lines.push('');

  lines.push('Device security signals:');
  for (const signal of REPORT_SIGNALS) {
    // "unknown"/"unavailable" are printed verbatim: an unmeasured signal must
    // never read "off". When the module itself was unreachable, the values are
    // fail-safe defaults, so every row is "unavailable" (not a clean result).
    lines.push(
      `  ${signal.label}: ${signalValueLabel(snapshot.signals[signal.key], snapshot.nativeModuleAvailable)}`,
    );
  }
  lines.push('');
  lines.push('This report is read-only: it does not change the risk score and cannot unblock the app.');
  return lines.join('\n');
}
