/**
 * Enterprise Security Hardening — MedAcademy
 *
 * Phase 1 detectors:
 *   Root/Jailbreak, VPN, Proxy, Debug/Emulator,
 *   Developer Options, USB Debugging, Debugger, Screen Recording, App Integrity
 *
 * Phase 2 detectors (Android):
 *   Frida, Xposed/LSPosed/EdXposed, Magisk/Zygisk,
 *   Overlay Attack, App Signature, Anti-Tamper,
 *   Play Integrity API (server-verified)
 *
 * Phase 2 detectors (iOS):
 *   Jailbreak (10 methods via IOSSecurityModule), Debugger (sysctl P_TRACED),
 *   Dylib injection / Frida-on-iOS, Bundle integrity (MachO header),
 *   Screen recording (UIScreen.isCaptured + ReplayKit),
 *   VPN (utun interface scan), Proxy (CFNetworkCopySystemProxySettings),
 *   App Attest / DeviceCheck (server-verified, Play Integrity equivalent)
 *
 * Risk weights (100-point scale):
 *   tampered/signature 40 | root/jailbreak 35 | frida 30 | play_integrity 30 |
 *   app_attest 30 | magisk 25 | xposed 25 | debugger_attached 25 |
 *   developer_options 25 | adb 20 | debug 20 | app_integrity 20 |
 *   ssl_pinning 20 | vpn 15 | proxy 15 | overlay 15 | screen_recording 10
 *
 * ENFORCEMENT POLICY (default — fail-secure):
 *   root_jailbreak    → block_login
 *   frida             → block_login
 *   xposed            → block_login
 *   magisk            → block_login
 *   tamper            → block_login
 *   play_integrity    → block_login
 *   app_attest        → block_login   (iOS Play Integrity equivalent)
 *   developer_options → block_login
 *   ssl_pinning       → block_login
 *   debug             → block_login
 *   vpn               → block_login
 *   overlay           → block_video + warn
 *   screen_recording  → block_video
 *   proxy             → warn_only
 *   app_integrity     → warn_only
 *   screenshot        → log_only
 */

import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { supabase } from '@/client/supabase';
import {
  getNativeSecurityFlags,
  requestPlayIntegrityToken,
  isNativeVPNDetected,
  isNativeProxyDetected,
  generateAppAttestKey,
  attestAppAttestKey,
  generateAppAttestAssertion,
  generateDeviceCheckToken,
  APP_ATTEST_INVALID_KEY,
  APP_ATTEST_SERVER_ERROR,
  APP_ATTEST_UNSUPPORTED,
  DEVICE_CHECK_UNSUPPORTED,
} from '@/lib/nativeSecurity';
import { getSecurityGuards } from '@/lib/securityConfigService';

// SecureStore key for persisting the App Attest keyId across sessions.
// WHEN_UNLOCKED_THIS_DEVICE_ONLY: never migrated to another device, never iCloud-synced,
// only accessible when device is unlocked. Strongest class for a value that must not
// roam (App Attest keys are device-bound by hardware; the keyId is meaningless on
// another device anyway).
const ATTEST_KEY_STORE = 'app_attest_key_id';
const ATTEST_KEY_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  keychainService: 'com.medacademy.security',
};
// Maximum number of App Attest retry attempts before falling back to DeviceCheck
const APP_ATTEST_MAX_RETRIES = 2;

// ─── Types ────────────────────────────────────────────────────────────────────

export type SecurityEventType =
  | 'root_detected'
  | 'jailbreak_detected'
  | 'vpn_detected'
  | 'proxy_detected'
  | 'ssl_pinning_failure'
  | 'screenshot_detected'
  | 'screen_recording_detected'
  | 'debug_detected'
  | 'frida_detected'
  | 'xposed_detected'
  | 'magisk_detected'
  | 'overlay_detected'
  | 'signature_invalid'
  | 'tamper_detected'
  | 'play_integrity_failed'
  | 'app_attest_failed'
  | 'app_integrity_compromised'
  | 'developer_options_enabled'
  | 'adb_enabled'
  | 'debugger_attached';

export type PolicyAction = 'log_only' | 'warn_only' | 'block_video' | 'block_login';

export type DetectionType =
  | 'root_jailbreak'
  | 'vpn'
  | 'proxy'
  | 'ssl_pinning'
  | 'debug'
  | 'developer_options'
  | 'screenshot'
  | 'screen_recording'
  | 'app_integrity'
  | 'frida'
  | 'xposed'
  | 'magisk'
  | 'overlay'
  | 'tamper'
  | 'play_integrity'
  | 'app_attest';

export interface SecurityPolicy {
  detection_type: DetectionType;
  action: PolicyAction;
  enabled: boolean;
}

export interface SecurityThreat {
  type: SecurityEventType;
  detectionMethod: string;
  detected: boolean;
}

export interface SecurityCheckResult {
  threats:     SecurityThreat[];
  riskScore:   number;
  policies:    Record<DetectionType, PolicyAction>;
  blocksLogin: boolean;
  blocksVideo: boolean;
  hasWarnings: boolean;
}

// ─── Risk Score Weights ───────────────────────────────────────────────────────

const WEIGHTS: Record<SecurityEventType, number> = {
  tamper_detected:           40,
  signature_invalid:         40,
  root_detected:             35,
  jailbreak_detected:        35,
  frida_detected:            30,
  play_integrity_failed:     30,
  app_attest_failed:         30,
  magisk_detected:           25,
  xposed_detected:           25,
  debugger_attached:         25,
  developer_options_enabled: 25,
  adb_enabled:               20,
  debug_detected:            20,
  app_integrity_compromised: 20,
  ssl_pinning_failure:       20,
  vpn_detected:              15,
  proxy_detected:            15,
  overlay_detected:          15,
  screen_recording_detected: 10,
  screenshot_detected:        5,
};

// Detection type → event type mapping
const DETECTION_TO_EVENT: Record<DetectionType, SecurityEventType[]> = {
  root_jailbreak:    ['root_detected', 'jailbreak_detected'],
  vpn:               ['vpn_detected'],
  proxy:             ['proxy_detected'],
  ssl_pinning:       ['ssl_pinning_failure'],
  debug:             ['debug_detected'],
  developer_options: ['developer_options_enabled', 'adb_enabled', 'debugger_attached'],
  screenshot:        ['screenshot_detected'],
  screen_recording:  ['screen_recording_detected'],
  app_integrity:     ['app_integrity_compromised'],
  frida:             ['frida_detected'],
  xposed:            ['xposed_detected'],
  magisk:            ['magisk_detected'],
  overlay:           ['overlay_detected'],
  tamper:            ['tamper_detected', 'signature_invalid'],
  play_integrity:    ['play_integrity_failed'],
  app_attest:        ['app_attest_failed'],
};

// ─── Policy Cache ─────────────────────────────────────────────────────────────

let cachedPolicies: Record<DetectionType, PolicyAction> | null = null;
let policyCacheExpiry = 0;
const POLICY_TTL_MS = 5 * 60 * 1000;

const DEFAULT_POLICIES: Record<DetectionType, PolicyAction> = {
  root_jailbreak:    'block_login',
  vpn:               'block_login',
  proxy:             'warn_only',
  ssl_pinning:       'block_login',
  debug:             'block_login',
  developer_options: 'block_login',
  screenshot:        'log_only',
  screen_recording:  'block_video',
  app_integrity:     'warn_only',
  frida:             'block_login',
  xposed:            'block_login',
  magisk:            'block_login',
  overlay:           'block_video',
  tamper:            'block_login',
  play_integrity:    'block_login',
  app_attest:        'block_login',
};

export async function getSecurityPolicies(): Promise<Record<DetectionType, PolicyAction>> {
  if (cachedPolicies && Date.now() < policyCacheExpiry) return cachedPolicies;
  try {
    const { data, error } = await supabase
      .from('security_policies')
      .select('detection_type, action, enabled')
      .order('detection_type');
    if (error || !data) return DEFAULT_POLICIES;
    const map = { ...DEFAULT_POLICIES };
    for (const row of data) {
      map[row.detection_type as DetectionType] = row.enabled
        ? (row.action as PolicyAction)
        : 'log_only';
    }
    cachedPolicies = map;
    policyCacheExpiry = Date.now() + POLICY_TTL_MS;
    return map;
  } catch {
    return DEFAULT_POLICIES;
  }
}

export function invalidatePolicyCache() {
  cachedPolicies = null;
  policyCacheExpiry = 0;
}

// ─── VPN Whitelist Cache ──────────────────────────────────────────────────────

let vpnWhitelist: string[] = [];
let vpnWhitelistExpiry = 0;

async function getVpnWhitelist(): Promise<string[]> {
  if (vpnWhitelist.length && Date.now() < vpnWhitelistExpiry) return vpnWhitelist;
  try {
    const { data } = await supabase.from('security_vpn_whitelist').select('name');
    vpnWhitelist = (data ?? []).map((r) => r.name.toLowerCase());
    vpnWhitelistExpiry = Date.now() + POLICY_TTL_MS;
    return vpnWhitelist;
  } catch {
    return [];
  }
}

// ─── Phase 1 Detectors ───────────────────────────────────────────────────────

/**
 * Root / Jailbreak detection.
 * Android: SecurityModule.getSecurityFlags().rootDetected (6 heuristics: su paths, props,
 *          test-keys, /system write test, which su, root packages).
 * iOS:     IOSSecurityModule.getSecurityFlags().jailbreakDetected (10 independent heuristics).
 */
async function detectRootJailbreak(): Promise<SecurityThreat | null> {
  try {
    if (process.env.EXPO_OS === 'web') return null;

    if (process.env.EXPO_OS === 'ios') {
      const flags = await getNativeSecurityFlags();
      if (__DEV__) console.log('[SecurityCheck][RootJailbreak] iOS jailbreakDetected=', flags.jailbreakDetected);
      if (!flags.jailbreakDetected) return null;
      return {
        type: 'jailbreak_detected',
        detectionMethod: 'Jailbreak detected',
        detected: true,
      };
    }

    // Android — use native SecurityModule multi-method root check
    const flags = await getNativeSecurityFlags();
    if (__DEV__) {
      console.log('[SecurityCheck][RootJailbreak] Android rootDetected=', flags.rootDetected,
        '| flags=', JSON.stringify({
          rootDetected: flags.rootDetected,
          magiskDetected: flags.magiskDetected,
          tampered: flags.tampered,
        }));
    }
    if (!flags.rootDetected) return null;
    return {
      type: 'root_detected',
      detectionMethod: 'Root access detected',
      detected: true,
    };
  } catch (e) {
    if (__DEV__) {
      console.log('[SecurityCheck][RootJailbreak] exception:', e);
    }
    return null;
  }
}

/**
 * VPN detection.
 * Android: SecurityModule.getSecurityFlags().vpnDetected
 *          (ConnectivityManager TRANSPORT_VPN on ALL active networks + NetworkInterface
 *          tun/vpn/ppp/ipsec interface scan). expo-network is NOT used — it only reads the
 *          primary transport type and misses VPN-over-WiFi / VPN-over-cellular.
 * iOS:     IOSSecurityModule — utun/ipsec interface scan (no entitlement needed).
 *
 * Whitelist: if the security_vpn_whitelist table has ANY rows, the admin has explicitly
 * allowed corporate VPNs — skip detection entirely (we cannot match by name on either
 * platform without a Network Extension entitlement).
 */
async function detectVPN(): Promise<SecurityThreat | null> {
  try {
    if (process.env.EXPO_OS === 'web') return null;

    // If admin has whitelisted any VPNs, skip detection for this device
    const whitelist = await getVpnWhitelist();
    if (whitelist.length > 0) {
      if (__DEV__) {
        console.log('[SecurityCheck][VPN] skipped — admin VPN whitelist has entries');
      }
      return null;
    }

    if (process.env.EXPO_OS === 'ios') {
      // Diagnostic: always log on iOS so false-positive investigations have evidence.
      // iOS path: native IOSSecurityModule.checkVPNSafe() (NWPath gate + getifaddrs IFF_UP gate).
      // JS fallback (detectVPNviaNetInfo) only runs when native module is null.
      console.log('[SecurityCheck][VPN] iOS: invoking isNativeVPNDetected…',
        '| detector=IOSSecurityModule.checkVPNSafe (two-gate: NWPath+getifaddrs)',
        '| fallback=NetInfo type===vpn only');
      const vpn = await isNativeVPNDetected();
      console.log('[SecurityCheck][VPN] iOS: raw result =', vpn,
        '| decision =', vpn ? '🔴 BLOCK (VPN active)' : '✅ PASS (no VPN)');
      if (!vpn) return null;
      return {
        type: 'vpn_detected',
        detectionMethod: 'VPN Connection detected',
        detected: true,
      };
    }

    // Android — native SecurityModule: ConnectivityManager TRANSPORT_VPN +
    // NetworkInterface name scan (tun/vpn/ppp/ipsec). Correctly excludes WiFi/cellular.
    const flags = await getNativeSecurityFlags();
    console.log('[SecurityCheck][VPN] Android: raw vpnDetected =', flags.vpnDetected,
      '| decision =', flags.vpnDetected ? '🔴 BLOCK' : '✅ PASS');
    if (!flags.vpnDetected) return null;
    return {
      type: 'vpn_detected',
      detectionMethod: 'VPN Connection detected',
      detected: true,
    };
  } catch (e) {
    if (__DEV__) {
      console.log('[SecurityCheck][VPN] exception:', e);
    }
    return null;
  }
}

/**
 * Proxy detection.
 * Android: environment variable scan (http_proxy / https_proxy / all_proxy).
 * iOS:     IOSSecurityModule: CFNetworkCopySystemProxySettings (HTTP/HTTPS/SOCKS).
 */
async function detectProxy(): Promise<SecurityThreat | null> {
  try {
    if (process.env.EXPO_OS === 'web') return null;

    if (process.env.EXPO_OS === 'ios') {
      const proxy = await isNativeProxyDetected();
      if (__DEV__) {
        console.log('[SecurityCheck][Proxy] iOS proxyDetected=', proxy);
      }
      if (!proxy) return null;
      return { type: 'proxy_detected', detectionMethod: 'Proxy connection detected', detected: true };
    }

    // Android: environment variable scan
    const httpProxy  = (globalThis as Record<string, unknown>)['http_proxy']  as string | undefined;
    const httpsProxy = (globalThis as Record<string, unknown>)['https_proxy'] as string | undefined;
    const allProxy   = (globalThis as Record<string, unknown>)['all_proxy']   as string | undefined;
    const found = !!(httpProxy || httpsProxy || allProxy);
    if (__DEV__) {
      console.log('[SecurityCheck][Proxy] Android proxyDetected=', found,
        '| http_proxy=', httpProxy, 'https_proxy=', httpsProxy, 'all_proxy=', allProxy);
    }
    if (!found) return null;
    return { type: 'proxy_detected', detectionMethod: 'Proxy connection detected', detected: true };
  } catch (e) {
    if (__DEV__) {
      console.log('[SecurityCheck][Proxy] exception:', e);
    }
    return null;
  }
}

/**
 * Debug / emulator detection.
 * Android: SecurityModule.getSecurityFlags().emulatorDetected (Build fingerprint/model/
 *          manufacturer/QEMU props/sensor count) PLUS __DEV__ JS flag.
 * iOS/all: __DEV__ flag only (iOS emulator is Simulator, not security-relevant).
 */
async function detectDebug(): Promise<SecurityThreat | null> {
  try {
    if (process.env.EXPO_OS === 'web') return null;

    if (__DEV__) {
      console.log('[SecurityCheck][Debug] __DEV__=true');
      return { type: 'debug_detected', detectionMethod: 'Debug mode active', detected: true };
    }

    if (process.env.EXPO_OS === 'android') {
      const flags = await getNativeSecurityFlags();
      if (__DEV__) {
        console.log('[SecurityCheck][Debug] Android emulatorDetected=', flags.emulatorDetected);
      }
      if (flags.emulatorDetected) {
        return {
          type: 'debug_detected',
          detectionMethod: 'Emulator / debug environment detected',
          detected: true,
        };
      }
    }

    if (__DEV__) {
      console.log('[SecurityCheck][Debug] no debug/emulator detected');
    }
    return null;
  } catch (e) {
    if (__DEV__) {
      console.log('[SecurityCheck][Debug] exception:', e);
    }
    return null;
  }
}

/**
 * Developer-options / debugger detection.
 * Android: SecurityModule (Developer Options flag, ADB, Debug.isDebuggerConnected).
 * iOS:     IOSSecurityModule: sysctl kinfo_proc P_TRACED flag.
 */
async function detectDeveloperOptions(): Promise<SecurityThreat | null> {
  try {
    if (process.env.EXPO_OS === 'web') return null;

    if (process.env.EXPO_OS === 'ios') {
      const flags = await getNativeSecurityFlags();
      if (__DEV__) {
        console.log('[SecurityCheck][DevOptions] iOS debuggerAttached=', flags.debuggerAttached);
      }
      if (!flags.debuggerAttached) return null;
      return {
        type: 'developer_options_enabled',
        detectionMethod: 'Debugger attached',
        detected: true,
      };
    }

    // Android
    const flags = await getNativeSecurityFlags();
    const active: string[] = [];
    if (flags.developerOptionsEnabled) active.push('Developer Options enabled');
    if (flags.adbEnabled)              active.push('USB Debugging (ADB) enabled');
    if (flags.debuggerAttached)        active.push('Debugger attached');
    if (flags.testOnlyBuild)           active.push('test-only build flag');
    if (__DEV__) {
      console.log('[SecurityCheck][DevOptions] Android checks=', active.join(', ') || 'none');
    }
    if (active.length === 0) return null;
    // Build a clean user-facing label — never expose raw method names
    const label = flags.developerOptionsEnabled ? 'Developer options enabled'
      : flags.adbEnabled ? 'USB debugging enabled'
      : flags.debuggerAttached ? 'Debugger attached'
      : 'Developer mode active';
    return { type: 'developer_options_enabled', detectionMethod: label, detected: true };
  } catch (e) {
    if (__DEV__) {
      console.log('[SecurityCheck][DevOptions] exception:', e);
    }
    return null;
  }
}

/**
 * Screen recording detection.
 * Android: SecurityModule MediaProjection / WindowManager.isScreenRecorded().
 * iOS:     IOSSecurityModule: UIScreen.isCaptured (AirPlay / QuickTime / ReplayKit).
 *          Also driven by the NativeEventEmitter in useContentProtection for real-time response.
 */
async function detectScreenRecording(): Promise<SecurityThreat | null> {
  try {
    if (process.env.EXPO_OS === 'web') return null;

    const flags = await getNativeSecurityFlags();
    if (__DEV__) {
      console.log('[SecurityCheck][ScreenRecording] screenBeingRecorded=', flags.screenBeingRecorded);
    }
    if (!flags.screenBeingRecorded) return null;

    const method = process.env.EXPO_OS === 'ios'
      ? 'IOSSecurityModule: UIScreen.isCaptured (AirPlay/QuickTime/ReplayKit)'
      : 'SecurityModule: MediaProjection / WindowManager.isScreenRecorded()';
    return { type: 'screen_recording_detected', detectionMethod: method, detected: true };
  } catch (e) {
    if (__DEV__) {
      console.log('[SecurityCheck][ScreenRecording] exception:', e);
    }
    return null;
  }
}

function detectAppIntegrity(): SecurityThreat | null {
  try {
    if (process.env.EXPO_OS === 'web') return null;
    if (__DEV__) {
      console.log('[SecurityCheck][AppIntegrity] __DEV__=true');
      return { type: 'app_integrity_compromised', detectionMethod: 'App integrity check failed', detected: true };
    }
    return null;
  } catch { return null; }
}

// ─── Phase 2 Detectors ───────────────────────────────────────────────────────

/**
 * Frida detection.
 * Android: SecurityModule port probe + /proc/maps + process scan + known files.
 * iOS:     IOSSecurityModule dylib injection scan (frida-gadget, DYLD_INSERT_LIBRARIES).
 */
async function detectFrida(): Promise<SecurityThreat | null> {
  try {
    if (process.env.EXPO_OS === 'web') return null;

    const flags = await getNativeSecurityFlags();
    if (__DEV__) {
      console.log('[SecurityCheck][Frida] fridaDetected=', flags.fridaDetected);
    }
    if (!flags.fridaDetected) return null;

    return { type: 'frida_detected', detectionMethod: 'Instrumentation framework detected', detected: true };
  } catch (e) {
    if (__DEV__) {
      console.log('[SecurityCheck][Frida] exception:', e);
    }
    return null;
  }
}

/** Xposed / LSPosed / EdXposed — Android only (no iOS equivalent) */
async function detectXposed(): Promise<SecurityThreat | null> {
  try {
    if (process.env.EXPO_OS !== 'android') return null;
    const flags = await getNativeSecurityFlags();
    if (__DEV__) {
      console.log('[SecurityCheck][Xposed] xposedDetected=', flags.xposedDetected);
    }
    if (!flags.xposedDetected) return null;
    return {
      type: 'xposed_detected',
      detectionMethod: 'Xposed framework detected',
      detected: true,
    };
  } catch (e) {
    if (__DEV__) {
      console.log('[SecurityCheck][Xposed] exception:', e);
    }
    return null;
  }
}

/**
 * SSL Pinning enforcement.
 *
 * The JS layer cannot intercept TLS handshakes directly — that is the job of
 * the native OkHttp CertificatePinner (Android) and URLSessionDelegate (iOS).
 * What this detector does:
 *
 *   1. Fire a probe request to the Supabase API with a known-good CORS endpoint.
 *   2. If the native pin layer rejects the certificate, the fetch will throw a
 *      network error (ERR_CERT_AUTHORITY_INVALID / NSURLErrorServerCertificateUntrusted).
 *   3. Distinguish a pin failure from a genuine offline state by also checking
 *      whether a plain known-good HTTPS host (Apple/Google CDN) is reachable.
 *
 * Result semantics:
 *   • PASS  (null)             — probe succeeded; certificate matched a pinned hash.
 *   • FAIL  (threat)           — probe failed AND the device is online → pin mismatch.
 *   • SKIP  (null)             — device appears offline; cannot distinguish pin fail
 *                                from no network; non-blocking.
 *   • Web   (null)             — browser enforces TLS; no JS-level pinning needed.
 *
 * DEV builds: skip probe entirely (native pinner is not active in Expo Go / debug
 * builds). Logging fires only in __DEV__.
 *
 * Certificate rotation: add new pins to the native pinner configuration BEFORE
 * removing old ones. During the overlap window both pins are valid and this
 * probe will continue to return null (pass).
 */
async function detectSSLPinning(): Promise<SecurityThreat | null> {
  // Web: browser enforces TLS; no JS-level pinning needed
  if (process.env.EXPO_OS === 'web') return null;

  // In DEV / Expo Go the native pinner is not loaded — skip to avoid false positives
  if (__DEV__) return null;

  try {
    // Step 1: check network connectivity so we don't false-positive when offline
    const Network = await import('expo-network');
    const state = await Network.getNetworkStateAsync();
    const isConnected = state.isConnected && state.isInternetReachable;
    if (!isConnected) {
      // Device is offline; cannot distinguish pin fail from no network — non-blocking
      return null;
    }

    // Step 2: probe the Supabase REST API — the native pinner validates this TLS connection.
    // Use the health endpoint (no auth required, tiny response).
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
    if (!supabaseUrl) return null; // misconfigured — skip

    const probeUrl = `${supabaseUrl}/rest/v1/?apikey=${process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? ''}`;

    let probeOk = false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      // Use globalThis.fetch explicitly — NOT bare `fetch`.
      // On iOS JSC, bare `fetch` in module scope can resolve to undefined if the
      // lazy getter hasn't fired yet.  globalThis.fetch is always the live value
      // (medo-guard + whatwg-fetch polyfill) at the time this async function runs.
      const res = await globalThis.fetch(probeUrl, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      // Any HTTP response (even 4xx) means TLS handshook — pin passed
      probeOk = res.status > 0;
    } catch {
      // fetch threw — could be: (a) certificate pin rejected, (b) transient network glitch.
      // Distinguish by trying a well-known HTTPS host that is NOT pinned.
      try {
        const fallbackController = new AbortController();
        const fallbackTimeout = setTimeout(() => fallbackController.abort(), 5000);
        await globalThis.fetch('https://www.apple.com/library/test/success.html', {
          method: 'HEAD',
          signal: fallbackController.signal,
        });
        clearTimeout(fallbackTimeout);
        // Fallback succeeded → device is online but our pinned host failed → PIN MISMATCH
        probeOk = false;
      } catch {
        // Both probes failed → device appears offline → non-blocking
        return null;
      }
    }

    if (!probeOk) {
      return {
        type: 'ssl_pinning_failure',
        detectionMethod: 'SSL/TLS certificate mismatch detected',
        detected: true,
      };
    }

    return null;
  } catch {
    return null;
  }
}

/** Magisk / Zygisk — Android only (no iOS equivalent) */
async function detectMagisk(): Promise<SecurityThreat | null> {
  try {
    if (process.env.EXPO_OS !== 'android') return null;
    const flags = await getNativeSecurityFlags();
    if (__DEV__) {
      console.log('[SecurityCheck][Magisk] magiskDetected=', flags.magiskDetected);
    }
    if (!flags.magiskDetected) return null;
    return {
      type: 'magisk_detected',
      detectionMethod: 'Root management framework detected',
      detected: true,
    };
  } catch (e) {
    if (__DEV__) {
      console.log('[SecurityCheck][Magisk] exception:', e);
    }
    return null;
  }
}

/** Overlay / tapjacking — Android only (SYSTEM_ALERT_WINDOW has no iOS equivalent) */
async function detectOverlay(): Promise<SecurityThreat | null> {
  try {
    if (process.env.EXPO_OS !== 'android') return null;
    const flags = await getNativeSecurityFlags();
    if (__DEV__) {
      console.log('[SecurityCheck][Overlay] overlayDetected=', flags.overlayDetected);
    }
    if (!flags.overlayDetected) return null;
    return {
      type: 'overlay_detected',
      detectionMethod: 'Screen overlay detected',
      detected: true,
    };
  } catch (e) {
    if (__DEV__) {
      console.log('[SecurityCheck][Overlay] exception:', e);
    }
    return null;
  }
}

/**
 * Signature + tamper detection.
 * Android: cert SHA-256 vs trusted fingerprints + installer source + native lib presence.
 * iOS:     IOSSecurityModule: MachO magic byte check + embedded.mobileprovision presence.
 *          (iOS code signing is enforced by the OS; this is a belt-and-suspenders layer.)
 */
async function detectTamper(): Promise<SecurityThreat | null> {
  try {
    if (process.env.EXPO_OS === 'web') return null;

    if (process.env.EXPO_OS === 'ios') {
      const flags = await getNativeSecurityFlags();
      if (__DEV__) {
        console.log('[SecurityCheck][Tamper] iOS bundleTampered=', flags.bundleTampered);
      }
      if (flags.bundleTampered) {
        return { type: 'tamper_detected', detectionMethod: 'App integrity check failed', detected: true };
      }
      return null;
    }

    // Android
    const flags = await getNativeSecurityFlags();
    const { SIGNATURE_CHECK_READY, TRUSTED_CERTS } = getSecurityGuards();
    if (__DEV__) {
      console.log('[SecurityCheck][Tamper] Android signatureValid=', flags.signatureValid, '| tampered=', flags.tampered,
        '| sigCheckReady=', SIGNATURE_CHECK_READY, '| trustedCerts=', TRUSTED_CERTS.length);
    }

    // Signature check: pass only when runtime cert matches ANY trusted fingerprint.
    if (SIGNATURE_CHECK_READY && TRUSTED_CERTS.length > 0) {
      if (!flags.signatureValid) {
        return { type: 'signature_invalid', detectionMethod: 'App signature verification failed', detected: true };
      }
    }

    if (flags.tampered) {
      return { type: 'tamper_detected', detectionMethod: 'App integrity check failed', detected: true };
    }

    return null;
  } catch (e) {
    if (__DEV__) {
      console.log('[SecurityCheck][Tamper] exception:', e);
    }
    return null;
  }
}

/**
 * Mock location detection — Android only.
 * Uses SecurityModule.getSecurityFlags().mockLocationDetected which checks:
 *   - AppOpsManager.OPSTR_MOCK_LOCATION granted to any non-system app (API 23+)
 *   - Settings.Secure.ALLOW_MOCK_LOCATION legacy flag (pre-API 23 fallback)
 *   - Installed packages holding ACCESS_MOCK_LOCATION permission
 */
async function detectMockLocation(): Promise<SecurityThreat | null> {
  try {
    if (process.env.EXPO_OS !== 'android') return null;
    const flags = await getNativeSecurityFlags();
    if (__DEV__) {
      console.log('[SecurityCheck][MockLocation] mockLocationDetected=', flags.mockLocationDetected);
    }
    if (!flags.mockLocationDetected) return null;
    return {
      type: 'debug_detected',
      detectionMethod: 'Mock location enabled',
      detected: true,
    };
  } catch (e) {
    if (__DEV__) {
      console.log('[SecurityCheck][MockLocation] exception:', e);
    }
    return null;
  }
}

/**
 * Play Integrity (Android) / App Attest (iOS) — server-verified device/app integrity.
 *
 * Android: Google Play Integrity API — token request → server-side verdict.
 * iOS:     Apple App Attest (DCAppAttestService, iOS 14+) with DeviceCheck fallback.
 *          Both use the same EF (verify-app-integrity) — the server determines
 *          which verification path to use based on the 'platform' field.
 *
 * The client ONLY sends the token/assertion; verdict always comes from the server.
 */

// Shared TTL cache — 10 min rate limit to avoid Apple/Google quota exhaustion
let _piNonce: string | null   = null;
let _piResult: boolean | null = null;
let _piExpiry = 0;
const PI_TTL_MS = 10 * 60 * 1000;

// iOS App Attest key — loaded from SecureStore on first use, regenerated on invalidation
let _appAttestKeyId: string | null = null;
// Whether the in-memory keyId has already been persisted (avoids duplicate SecureStore writes)
let _appAttestKeyPersisted = false;

export async function runPlayIntegrityCheck(): Promise<SecurityThreat | null> {
  try {
    if (process.env.EXPO_OS === 'web') return null;
    if (process.env.EXPO_OS === 'ios') return runAppAttestCheck();

    // ── Android: Google Play Integrity ──────────────────────────────────────
    const { PLAY_INTEGRITY_READY } = getSecurityGuards();
    if (!PLAY_INTEGRITY_READY) return null;

    if (_piResult !== null && Date.now() < _piExpiry) {
      return _piResult ? null : {
        type: 'play_integrity_failed',
        detectionMethod: 'Device integrity check failed',
        detected: true,
      };
    }

    // 1. Get a fresh nonce from our backend (prevents replay attacks)
    const { data: nonceData, error: nonceErr } = await supabase.functions.invoke('verify-play-integrity', {
      body: { action: 'get_nonce' },
    });
    if (nonceErr || !nonceData?.nonce) return null;
    _piNonce = nonceData.nonce as string;

    // 2. Request token from Play Integrity API (native)
    const token = await requestPlayIntegrityToken(_piNonce);
    if (!token) {
      _piResult = true;
      _piExpiry = Date.now() + PI_TTL_MS;
      return null;
    }

    // 3. Server-side verification — client NEVER interprets verdict
    const { data: verifyData, error: verifyErr } = await supabase.functions.invoke('verify-play-integrity', {
      body: { action: 'verify', token, nonce: _piNonce },
    });
    if (verifyErr) return null;

    const passed = verifyData?.passed === true;
    _piResult = passed;
    _piExpiry = Date.now() + PI_TTL_MS;

    if (!passed) {
      return {
        type: 'play_integrity_failed',
        detectionMethod: 'Device integrity check failed',
        detected: true,
      };
    }
    return null;
  } catch { return null; }
}

/**
 * App Attest check for iOS (called internally by runPlayIntegrityCheck on iOS).
 *
 * Lifecycle:
 *  1. Load persisted keyId from SecureStore (survives app restarts).
 *  2. If no keyId: generateKey() → persist to SecureStore.
 *  3. Get a server challenge.
 *  4. If key not yet attested by server: attest once.
 *  5. generateAssertion(keyId, challenge) → verify server-side.
 *  6. On APP_ATTEST_INVALID_KEY: delete persisted key, regenerate once, re-attest, retry.
 *  7. On APP_ATTEST_SERVER_ERROR (transient): skip this check, return null (non-blocking).
 *  8. On APP_ATTEST_UNSUPPORTED (simulator / A11-): fall through to DeviceCheck.
 *  9. DeviceCheck: use ONLY for genuine unavailability, NOT transient errors.
 * 10. Neither available → skip, non-blocking.
 */
async function runAppAttestCheck(): Promise<SecurityThreat | null> {
  try {
    // Cache: avoid hammering Apple quota — 10-min TTL
    if (_piResult !== null && Date.now() < _piExpiry) {
      return _piResult ? null : {
        type: 'app_attest_failed',
        detectionMethod: 'Device integrity check failed',
        detected: true,
      };
    }

    // ── Step 1: Load persisted keyId from SecureStore ─────────────────────────
    if (!_appAttestKeyId) {
      try {
        const stored = await SecureStore.getItemAsync(ATTEST_KEY_STORE, ATTEST_KEY_OPTIONS);
        if (stored) {
          _appAttestKeyId = stored;
          _appAttestKeyPersisted = true;
        }
      } catch { /* SecureStore unavailable — proceed without persisted key */ }
    }

    // ── Step 2: Attempt App Attest assertion (with key regeneration on invalidation) ─
    for (let attempt = 0; attempt < APP_ATTEST_MAX_RETRIES; attempt++) {
      // 2a. Generate new key if we don't have one
      if (!_appAttestKeyId) {
        try {
          const newKeyId = await generateAppAttestKey();
          if (!newKeyId) break; // generateAppAttestKey returned null (unsupported) — fall through
          _appAttestKeyId = newKeyId;
          _appAttestKeyPersisted = false;
          // Persist immediately so the key survives a crash before attestation.
          // WHEN_UNLOCKED_THIS_DEVICE_ONLY: device-bound, not synced, strongest class.
          try {
            await SecureStore.setItemAsync(ATTEST_KEY_STORE, newKeyId, ATTEST_KEY_OPTIONS);
            _appAttestKeyPersisted = true;
          } catch { /* non-fatal — key still valid in-memory this session */ }
        } catch (keyErr: unknown) {
          const code = (keyErr as { code?: string })?.code;
          if (code === APP_ATTEST_UNSUPPORTED) {
            // Simulator or A11-: genuine unavailability → fall through to DeviceCheck
            break;
          }
          // Any other key-generation error: skip this check
          return null;
        }
      }

      // 2b. Get server challenge
      const { data: nonceData, error: nonceErr } = await supabase.functions.invoke('verify-app-integrity', {
        body: { action: 'get_challenge', platform: 'ios' },
      });
      if (nonceErr || !nonceData?.challenge) return null; // Backend unavailable → non-blocking

      const challenge = nonceData.challenge as string;

      // 2c. Attest key on first use (server stores the public key once)
      if (!_appAttestKeyPersisted) {
        const { error: attestErr } = await supabase.functions.invoke('verify-app-integrity', {
          body: { action: 'attest_key', keyId: _appAttestKeyId, challenge, platform: 'ios' },
        });
        if (attestErr) {
          // Server-side attestation failed: discard key and regenerate on next attempt
          _appAttestKeyId = null;
          _appAttestKeyPersisted = false;
          try { await SecureStore.deleteItemAsync(ATTEST_KEY_STORE); } catch { /* ignore */ }
          continue;
        }
        _appAttestKeyPersisted = true;
        try { await SecureStore.setItemAsync(ATTEST_KEY_STORE, _appAttestKeyId!, ATTEST_KEY_OPTIONS); } catch { /* ignore */ }
      }

      // 2d. Generate assertion for this request
      let assertion: string | null = null;
      try {
        assertion = await generateAppAttestAssertion(_appAttestKeyId!, challenge);
      } catch (assertErr: unknown) {
        const code = (assertErr as { code?: string })?.code;
        if (code === APP_ATTEST_INVALID_KEY) {
          // Key permanently invalidated by Apple — clear and regenerate on next loop iteration
          _appAttestKeyId = null;
          _appAttestKeyPersisted = false;
          try { await SecureStore.deleteItemAsync(ATTEST_KEY_STORE); } catch { /* ignore */ }
          continue;
        }
        if (code === APP_ATTEST_SERVER_ERROR) {
          // Transient Apple server error — do NOT fall back to DeviceCheck; skip check
          return null;
        }
        // Other assertion errors: skip
        return null;
      }

      if (!assertion) return null;

      // 2e. Server-side assertion verification
      const { data: verifyData, error: verifyErr } = await supabase.functions.invoke('verify-app-integrity', {
        body: { action: 'verify_assertion', keyId: _appAttestKeyId, assertion, challenge, platform: 'ios' },
      });
      if (verifyErr) return null; // Transient server issue — non-blocking

      const passed = verifyData?.passed === true;
      _piResult = passed;
      _piExpiry = Date.now() + PI_TTL_MS;
      if (!passed) {
        return {
          type: 'app_attest_failed',
          detectionMethod: 'Device integrity check failed',
          detected: true,
        };
      }
      return null; // Passed ✔
    }

    // ── Step 3: DeviceCheck fallback (genuine App Attest unavailability only) ─
    // We reach here only when App Attest is genuinely unsupported — NOT for transient
    // server errors (those return null above) or key invalidation (retried above).
    let dcToken: string | null = null;
    try {
      dcToken = await generateDeviceCheckToken();
    } catch (dcErr: unknown) {
      const code = (dcErr as { code?: string })?.code;
      if (code === DEVICE_CHECK_UNSUPPORTED) return null; // Simulator — skip, non-blocking
      return null;
    }

    if (!dcToken) return null;

    const { data: dcData, error: dcErr } = await supabase.functions.invoke('verify-app-integrity', {
      body: { action: 'verify_device_check', token: dcToken, platform: 'ios' },
    });
    if (dcErr) return null;

    const dcPassed = dcData?.passed === true;
    _piResult = dcPassed;
    _piExpiry = Date.now() + PI_TTL_MS;
    if (!dcPassed) {
      return {
        type: 'app_attest_failed',
        detectionMethod: 'Device integrity check failed',
        detected: true,
      };
    }
    return null;
  } catch { return null; }
}

/**
 * Clears the persisted App Attest keyId from SecureStore and memory.
 * Call when the user logs out or when a forced key rotation is required.
 */
export async function clearAppAttestKey(): Promise<void> {
  _appAttestKeyId = null;
  _appAttestKeyPersisted = false;
  _piResult = null;
  _piExpiry = 0;
  try { await SecureStore.deleteItemAsync(ATTEST_KEY_STORE, ATTEST_KEY_OPTIONS); } catch { /* ignore */ }
}

// ─── Risk Score Calculator ────────────────────────────────────────────────────

export function computeRiskScore(threats: SecurityThreat[]): number {
  const total = threats.filter((t) => t.detected).reduce((sum, t) => sum + (WEIGHTS[t.type] ?? 0), 0);
  return Math.min(100, total);
}

// ─── Full Security Check ──────────────────────────────────────────────────────

export async function runSecurityChecks(): Promise<SecurityCheckResult> {
  if (__DEV__) {
    console.log('[SecurityCheck][runSecurityChecks] ▶ starting all checks on platform=', process.env.EXPO_OS);
  }

  // Warm up the native flag batch cache ONCE so every detector re-uses it
  let rawFlags: Awaited<ReturnType<typeof getNativeSecurityFlags>> | null = null;
  try {
    rawFlags = await getNativeSecurityFlags();
    if (__DEV__) {
      console.log('[SecurityCheck][runSecurityChecks] raw native flags:', JSON.stringify(rawFlags));
    }
  } catch (e) {
    if (__DEV__) {
      console.log('[SecurityCheck][runSecurityChecks] ⚠️ getNativeSecurityFlags failed:', e);
    }
  }

  const [
    rootThreat, vpnThreat, proxyThreat, debugThreat, devOptsThreat, screenRecThreat,
    fridaThreat, xposedThreat, magiskThreat, overlayThreat, tamperThreat,
    mockLocThreat, piThreat, sslThreat,
  ] = await Promise.all([
    detectRootJailbreak(),
    detectVPN(),
    detectProxy(),
    detectDebug(),
    detectDeveloperOptions(),
    detectScreenRecording(),
    detectFrida(),
    detectXposed(),
    detectMagisk(),
    detectOverlay(),
    detectTamper(),
    detectMockLocation(),
    runPlayIntegrityCheck(),
    detectSSLPinning(),
  ]);
  const integrityThreat = detectAppIntegrity();

  if (__DEV__ && sslThreat) {
    if (__DEV__) {
      console.warn('[security] SSL pinning failure detected:', sslThreat.detectionMethod);
    }
  }

  const allThreats: SecurityThreat[] = [
    rootThreat, vpnThreat, proxyThreat, debugThreat,
    devOptsThreat, screenRecThreat, integrityThreat,
    fridaThreat, xposedThreat, magiskThreat, overlayThreat,
    tamperThreat, mockLocThreat, piThreat, sslThreat,
  ].filter((t): t is SecurityThreat => t !== null && t.detected);

  if (__DEV__) {
    console.log('[SecurityCheck][runSecurityChecks] ✅ detected threats:', allThreats.map(t => t.type).join(', ') || 'none');
  }

  const riskScore = computeRiskScore(allThreats);
  const policies  = await getSecurityPolicies();
  if (__DEV__) {
    console.log('[SecurityCheck][runSecurityChecks] riskScore=', riskScore);
  }

  let blocksLogin  = false;
  let blocksVideo  = false;
  let hasWarnings  = false;

  for (const threat of allThreats) {
    const detectionType = (Object.entries(DETECTION_TO_EVENT) as [DetectionType, SecurityEventType[]][])
      .find(([, events]) => events.includes(threat.type))?.[0];
    if (!detectionType) continue;
    const action = policies[detectionType];
    if (action === 'block_login') blocksLogin = true;
    if (action === 'block_video') blocksVideo = true;
    if (action === 'warn_only')   hasWarnings = true;
  }

  return { threats: allThreats, riskScore, policies, blocksLogin, blocksVideo, hasWarnings };
}

// ─── Security Event Logger ────────────────────────────────────────────────────

interface LogSecurityEventOptions {
  eventType:        SecurityEventType;
  detectionMethod?: string;
  policyAction?:    PolicyAction;
  riskScore?:       number;
  deviceId?:        string;
  platform?:        string;
  appVersion?:      string;
  metadata?:        Record<string, unknown>;
}

export async function logSecurityEvent(opts: LogSecurityEventOptions): Promise<void> {
  try {
    await supabase.functions.invoke('security-logger', {
      body: {
        event_type:       opts.eventType,
        detection_method: opts.detectionMethod,
        policy_action:    opts.policyAction,
        risk_score:       opts.riskScore ?? 0,
        device_id:        opts.deviceId,
        platform:         opts.platform ?? process.env.EXPO_OS,
        app_version:      opts.appVersion ?? Constants.expoConfig?.version,
        metadata:         opts.metadata ?? {},
      },
    });
  } catch { /* never block user flow */ }
}

export async function logThreats(
  threats: SecurityThreat[],
  policies: Record<DetectionType, PolicyAction>,
  riskScore: number,
  deviceId?: string,
): Promise<void> {
  if (!threats.length) return;
  const events = threats.map((t) => {
    const detectionType = (Object.entries(DETECTION_TO_EVENT) as [DetectionType, SecurityEventType[]][])
      .find(([, evts]) => evts.includes(t.type))?.[0];
    const policyAction = detectionType ? policies[detectionType] : 'log_only';
    return {
      event_type:       t.type,
      detection_method: t.detectionMethod,
      policy_action:    policyAction,
      risk_score:       riskScore,
      device_id:        deviceId,
      platform:         process.env.EXPO_OS,
      app_version:      Constants.expoConfig?.version,
    };
  });
  try {
    await supabase.functions.invoke('security-logger', { body: events });
  } catch { /* silently fail */ }
}
