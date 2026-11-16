/**
 * DIAGNOSTIC (SECURITY-TEST) BUILD SWITCH — build-time only.
 *
 * ─── WHAT THIS IS ────────────────────────────────────────────────────────────
 * A single, explicit, COMPILE-TIME switch that lets a temporary diagnostic APK
 * reach the dashboard on a test tablet whose device environment would otherwise
 * be blocked (Developer Options / USB debugging / Magisk / Xposed-LSPosed).
 * It exists so a crash can be reproduced with Logcat attached; it is NOT a
 * feature and it must never ship to users.
 *
 * ─── HOW IT IS ENABLED (and why it cannot be enabled by accident) ────────────
 * TWO build-time variables must BOTH be present while the JS bundle is built:
 *
 *   EXPO_PUBLIC_SECURITY_TEST_BUILD=1
 *   EXPO_PUBLIC_SECURITY_TEST_BUILD_ACK=security-test
 *
 * The second key is deliberate: a stray first variable (an exported shell var,
 * a copied .env line, a leftover CI setting) can NEVER enable the mode on its
 * own. Both values are inlined by Metro at bundle time — they are read exactly
 * once, statically, with literal `process.env.X` member access (a dynamic
 * `process.env[key]` is NOT inlined by Metro and would silently disable the
 * flag in a release bundle).
 *
 * The only profile that declares both is `security-test` in eas.json, which is
 * `distribution: internal` and is never referenced by `submit`. Automated
 * guards enforce all of that before packaging:
 *   • scripts/check-diagnostic-build-guards.cjs  (build gate, wired into
 *     `npm run validate` / `prebuild:validate`)
 *   • tests/diagnosticSecurityBuild.test.cjs     (regression suite)
 *
 * NOTHING RUNTIME CAN ENABLE THIS: no SecureStore/AsyncStorage key, no remote
 * config, no route param, no deep link, no server flag. Flipping it requires a
 * new bundle, i.e. a new APK.
 *
 * ─── WHAT IT WAIVES (and what it never touches) ──────────────────────────────
 * WAIVED: only LOCAL device-environment findings — the ones that are true by
 * construction on a developer's test device and say nothing about the account:
 * Developer Options, USB debugging (ADB), attached debugger, root framework
 * (Magisk/Zygisk), hook frameworks (Xposed/LSPosed/Frida), and the test-only
 * build marker.
 *
 * NEVER WAIVED: authentication/authorization, backend enforcement, VPN/overlay
 * policy, screen-recording detection, signature/integrity (Play Integrity,
 * tamper, cert pinning), multi-window enforcement, SSL pinning, watermarks and
 * PDF protection. Detection itself is not removed either: every detector still
 * runs and every finding is still reported to the backend (logThreats) — the
 * filter only removes those findings from the local BLOCKING decision.
 *
 * See docs/DIAGNOSTIC_SECURITY_BUILD.md for the operator instructions.
 */

import { DIAGNOSTIC_BUILD_FLAG } from './diagnosticBuildFlag';

/**
 * Local device-environment findings waived in a diagnostic build. Kept as a
 * frozen list (not just a Set) so the banner, the docs and the tests all name
 * the same, auditable set.
 */
export const DIAGNOSTIC_WAIVED_CHECKS: readonly string[] = Object.freeze([
  'developer_options_enabled',
  'adb_enabled',
  'debugger_attached',
  'debug_detected',
  'root_detected',
  'magisk_detected',
  'xposed_detected',
  'frida_detected',
]);

const DIAGNOSTIC_WAIVED_SET: ReadonlySet<string> = new Set(DIAGNOSTIC_WAIVED_CHECKS);

/**
 * TRUE only in a build whose flag module was armed before compilation.
 *
 * The value comes from `./diagnosticBuildFlag`, a plain constant, NOT from
 * `process.env`: a release bundle inlines `EXPO_PUBLIC_*` inside the Metro
 * worker, and Android builds 223 / 43926766869 showed that worker can inline
 * `undefined` even when the bundling process itself sees the keys — the minifier
 * then deletes every diagnostic marker as dead code. A source constant cannot be
 * misread that way; `scripts/arm-diagnostic-suspension.cjs` writes it, and only
 * when both build-time keys are present (see that script and the flag module).
 *
 * Never read from storage, network, props, route params or remote config.
 */
export const SECURITY_TEST_BUILD: boolean = DIAGNOSTIC_BUILD_FLAG;

/** True when this finding is a local device-environment finding waived for the diagnostic build. */
export function isSecurityTestBypassed(threat: { type: string }): boolean {
  return SECURITY_TEST_BUILD && DIAGNOSTIC_WAIVED_SET.has(threat.type);
}

/**
 * Status object for the diagnostic indicator and for on-device verification
 * (step 1 of the investigation: "confirm diagnostic-mode status").
 * `enabled:false` in every production build, with no runtime input involved.
 */
export function diagnosticBuildStatus(): {
  enabled: boolean;
  waived: readonly string[];
} {
  return {
    enabled: SECURITY_TEST_BUILD,
    waived: SECURITY_TEST_BUILD ? DIAGNOSTIC_WAIVED_CHECKS : [],
  };
}

let _logged = false;

/**
 * One-shot, unmistakable startup marker.
 *
 * WHY: the first thing to verify on the tablet is "is THIS install the
 * diagnostic build?". This line answers it from Logcat alone
 * (`adb logcat | grep DIAG-BUILD`) without touching the UI, and it is emitted
 * only when the switch is on — a production build prints nothing at all.
 */
export function logDiagnosticBuildStatus(): void {
  if (!SECURITY_TEST_BUILD || _logged) return;
  _logged = true;
  console.warn(
    '[DIAG-BUILD] ACTIVE — this is a DIAGNOSTIC build. Local device-environment ' +
    'checks are waived for the BLOCKING decision only: ' +
    DIAGNOSTIC_WAIVED_CHECKS.join(', ') +
    '. Detection still runs and findings are still reported. NOT FOR PRODUCTION.',
  );
}
