/**
 * TEMPORARY SECURITY TEST BUILD — REMOVE AFTER TESTING.
 *
 * Active ONLY when the bundle is built with EXPO_PUBLIC_SECURITY_TEST_BUILD=1
 * (the dedicated `security-test` EAS profile in eas.json). Release and
 * development profiles never set it, so the flag compiles to `false` and the
 * filter below removes nothing.
 *
 * What it does: drops LOCAL device-environment findings (Developer Options,
 * USB debugging, debugger, root, Magisk, Xposed/LSPosed, Frida, test-only
 * build) from the client evaluation so a rooted, developer-enabled tablet can
 * run the lesson player for VdoCipher watermark testing.
 *
 * What it does NOT do: it does not touch backend enforcement, VdoCipher DRM,
 * watermarking, PDF protection, authentication, authorization, HTTPS/SSL
 * pinning, screen-recording detection or the integrity/signature check.
 */
export const SECURITY_TEST_BUILD = process.env.EXPO_PUBLIC_SECURITY_TEST_BUILD === '1';

const TEST_BYPASSED_THREAT_TYPES: ReadonlySet<string> = new Set([
  'developer_options_enabled',
  'adb_enabled',
  'debugger_attached',
  'debug_detected',
  'root_detected',
  'magisk_detected',
  'xposed_detected',
  'frida_detected',
]);

/** True when this finding is a local device-environment finding waived for the test build. */
export function isSecurityTestBypassed(threat: { type: string }): boolean {
  return SECURITY_TEST_BUILD && TEST_BYPASSED_THREAT_TYPES.has(threat.type);
}
