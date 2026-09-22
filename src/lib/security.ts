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
import {
  classifySslProbe,
  isSslProbeSecurityFinding,
  type SslProbeFailureCategory,
} from './securityStateModel';
import * as SecureStore from 'expo-secure-store';
import { backendClient } from '@/client/backendClient';
import {
  getNativeSecurityFlags,
  getNativeSecurityFlagsSync,
  wasLastSecurityFlagsCallUnavailable,
  requestPlayIntegrityToken,
  type NativeSecurityFlags,
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
import { getSecurityGuards, getSecurityConfig } from '@/lib/securityConfigService';
// PURE state model (no react-native/expo imports) — risk scoring + policy
// evaluation are delegated there so they are unit-testable with plain node.
import { computeRiskScorePure, evaluateSecurityResult } from './securityStateModel';

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
  | 'debugger_attached'
  // Observability-only (P4): reported when native detection could not run so
  // a fail-safe default is never mistaken for a measured-clean state.
  // Server treats it as a plain log event — never escalates strikes.
  | 'detection_unavailable'
  // Fail-closed SENTINEL (state-sync fix): served ONLY while a security
  // evaluation has not yet completed (cold start, or an evaluation that
  // threw). It is a client-side state marker, NOT a device finding — it is
  // never produced by a detector, never logged to the backend, and never
  // presented as "App Integrity Compromised" (the previous 'tamper_detected'
  // sentinel mislabeled every cold start as an integrity failure — the exact
  // false positive observed on the physical device). The gate copy for this
  // event says the check is re-running; it clears as soon as a real
  // evaluation completes (SecurityContext check() finally-block + gate
  // sticky-clear transition).
  | 'security_unverified'
  // CONNECTION PROBE OBSERVABILITY (misclassification fix): emitted when the
  // connection-security probe could not VERIFY the pinned origin but the
  // failure is NOT evidence of a TLS/pin mismatch — timeout, network error,
  // server error, or inconclusive. Weight 0, never blocking: weak internet is
  // a reachability state, not a proven security violation. A REAL pin
  // mismatch still emits 'ssl_pinning_failure' exactly as before.
  | 'connection_probe_degraded';

export type PolicyAction = 'log_only' | 'warn_only' | 'block_video' | 'block_login';

export type DetectionType =
  | 'root_jailbreak'
  | 'vpn'
  | 'proxy'
  | 'ssl_pinning'
  | 'connection_probe'
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
  /**
   * Evidence-quality metadata accompanying this check (distinguishes
   * "verified against pin" from "check unavailable", records distribution
   * telemetry, etc.). Observability only — never adds to the risk score.
   */
  evidence?:   SecurityEvidence;
}

/** Evidence-quality + distribution telemetry attached to a security check. */
export interface SecurityEvidence {
  /** Installing package if the platform reports one (may legitimately be null). */
  installerSource?:          string | null;
  /** True when a pinned expected cert SHA-256 is configured in the build. */
  expectedCertConfigured?:   boolean;
  /** SHA-256 fingerprint of the current signing cert (public material). */
  signatureSha256?:          string | null;
  /** Installed non-self packages holding SYSTEM_ALERT_WINDOW (capability count — NOT a threat). */
  overlayCapableAppsCount?:  number;
  /** True when the native batch call could not run — flags are defaults, not measurements. */
  detectionUnavailable?:     boolean;
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
  // Observability-only event (native module unavailable). Never a threat on
  // its own — reported for coverage-gap visibility, weight 0.
  detection_unavailable:      0,
  // Fail-closed sentinel (see type union above). Small non-zero weight so a
  // blocked-during-evaluation screen never reads "Risk Score: 0"; the BLOCK
  // itself comes from SecurityContext's explicit blocksLogin/blocksVideo on
  // the sentinel result, never from this weight.
  security_unverified:       10,
  // Connection-probe observability (misclassification fix): a timeout/network
  // failure to the pinned origin is NOT a security violation. Weight 0 and
  // log-only policy — the app does NOT block on weak connectivity. A genuine
  // pin mismatch (TLS identity rejected while the origin answered) remains a
  // blocking ssl_pinning_failure.
  connection_probe_degraded:  0,
};

/** Weight of the fail-closed sentinel — used by SecurityContext's sentinel results. */
export const SECURITY_UNVERIFIED_WEIGHT: number = WEIGHTS.security_unverified;

// Detection type → event type mapping
const DETECTION_TO_EVENT: Record<DetectionType, SecurityEventType[]> = {
  root_jailbreak:    ['root_detected', 'jailbreak_detected'],
  vpn:               ['vpn_detected'],
  proxy:             ['proxy_detected'],
  ssl_pinning:       ['ssl_pinning_failure'],
  // Probe OBSERVABILITY rides its own bucket — NOT ssl_pinning — so a
  // timeout/network failure can never inherit ssl_pinning's block_login
  // action (policy decides blocking; the weight alone is not the guard).
  connection_probe:  ['connection_probe_degraded'],
  debug:             ['debug_detected', 'debugger_attached'],
  developer_options: ['developer_options_enabled', 'adb_enabled'],
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
// NOTE (Developer-Options blocking policy): the four Android debug-state
// DETECTORS stay technically separate — developer_options_enabled (inert
// toggle), adb_enabled (USB debugging), debugger_attached (live debugger),
// debug_detected (test-only build) — so the backend event trail records
// exactly which surface is present. They are deliberately NOT separate
// POLICY buckets: `debug_adb`/`debug_options` do not exist in the production
// security_policies CHECK constraint (chk_security_policies_detection_type)
// and the owner requires ALL debug states to block. Evidence events map:
//   developer_options → developer_options_enabled + adb_enabled
//   debug             → debug_detected + debugger_attached
// both buckets are block_login (server security_policies authoritative).

// ─── Policy Cache ─────────────────────────────────────────────────────────────

let cachedPolicies: Record<DetectionType, PolicyAction> | null = null;
let policyCacheExpiry = 0;
const POLICY_TTL_MS = 5 * 60 * 1000;

const DEFAULT_POLICIES: Record<DetectionType, PolicyAction> = {
  root_jailbreak:    'block_login',
  vpn:               'block_login',
  proxy:             'warn_only',
  ssl_pinning:       'block_login',
  // Probe observability: a degraded/timeout connection probe is logged, never
  // blocks — a REAL pin mismatch (ssl_pinning_failure above) keeps blocking.
  connection_probe:  'log_only',
  debug:             'block_login',
  developer_options: 'block_login',
  // MANDATORY SECURITY BLOCK (owner requirement): Developer Options — the
  // inert toggle itself — blocks login and locks the authenticated app via
  // the central SecurityGate until disabled. ADB/debugger states map into
  // the same blocking buckets (see DETECTION_TO_EVENT note). The detector
  // keeps the four states technically separate for the event trail; the
  // POLICY is uniform block_login. Server security_policies is authoritative;
  // this is the fail-secure fallback when the server is unreachable.
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
  // SERVER-SIDE POLICY SOURCE: /security/policies serves the authoritative
  // security_policies table (validated allowlist of detection types + actions
  // — no arbitrary config). Fail-secure: on fetch error the bundled safe
  // defaults are used and cached briefly, never an empty/permissive map.
  if (cachedPolicies && Date.now() < policyCacheExpiry) return cachedPolicies;
  // OFFLINE FAST-PATH: with no connectivity the fetch can only burn its full
  // timeout before hitting the SAME fail-secure fallback below. Skip straight
  // to it — the network-reconnect listener invalidates and refetches the
  // moment connectivity returns. No permissive default is introduced: the
  // fallback IS the bundled safe policy set.
  if (process.env.EXPO_OS !== 'web') {
    try {
      const Network = await import('expo-network');
      const st = await Network.getNetworkStateAsync();
      if (!(st.isConnected && st.isInternetReachable !== false)) {
        cachedPolicies = { ...DEFAULT_POLICIES };
        policyCacheExpiry = Date.now() + POLICY_TTL_MS;
        return cachedPolicies;
      }
    } catch { /* state unavailable → attempt the fetch as before */ }
  }
  try {
    const { data } = await withTimeout(
      backendClient.functions.invoke('get-security-policies', { method: 'GET' }),
      DETECTOR_TIMEOUT_MS,
      () => ({ data: null, error: null }),
    );
    const rows = (data as { policies?: Record<string, { action?: string; enabled?: boolean }> } | null)?.policies;
    if (rows && typeof rows === 'object') {
      const VALID_ACTIONS: PolicyAction[] = ['log_only', 'warn_only', 'block_video', 'block_login'];
      const merged = { ...DEFAULT_POLICIES } as Record<DetectionType, PolicyAction>;
      let sawAny = false;
      for (const [type, row] of Object.entries(rows)) {
        if (!(type in merged)) continue; // strict allowlist — unknown types ignored
        if (!row || typeof row !== 'object') continue;
        if (row.enabled === false) {
          // Disabled detection: downgraded to log_only, never removed
          merged[type as DetectionType] = 'log_only';
          sawAny = true;
          continue;
        }
        const action = row.action as PolicyAction | undefined;
        if (action && VALID_ACTIONS.includes(action)) {
          merged[type as DetectionType] = action;
          sawAny = true;
        }
      }
      if (sawAny) {
        cachedPolicies = merged;
        policyCacheExpiry = Date.now() + POLICY_TTL_MS;
        return cachedPolicies;
      }
    }
  } catch {
    // Server unreachable → keep fail-secure defaults below
  }
  cachedPolicies = { ...DEFAULT_POLICIES };
  policyCacheExpiry = Date.now() + POLICY_TTL_MS;
  return cachedPolicies;
}

export function invalidatePolicyCache() {
  cachedPolicies = null;
  policyCacheExpiry = 0;
  vpnWhitelist = [];
  vpnWhitelistExpiry = 0;
  vpnWhitelistFetched = false;
}

// ─── VPN Whitelist Cache ──────────────────────────────────────────────────────

let vpnWhitelist: string[] = [];
let vpnWhitelistExpiry = 0;
// Distinguishes "whitelist is genuinely empty" from "never fetched / fetch failed"
// so a transient failure cannot blank out a configured whitelist.
let vpnWhitelistFetched = false;

async function getVpnWhitelist(): Promise<string[]> {
  if (vpnWhitelistFetched && Date.now() < vpnWhitelistExpiry) return vpnWhitelist;
  try {
    // Network-bound: bound the fetch so a hung request cannot stall the
    // security pipeline (on timeout → empty list → detection stays active).
    const { data } = await withTimeout(
      backendClient.functions.invoke('get-security-policies', { method: 'GET' }),
      DETECTOR_TIMEOUT_MS,
      () => ({ data: null, error: null }),
    );
    const list = (data as { vpn_whitelist?: unknown } | null)?.vpn_whitelist;
    vpnWhitelist = Array.isArray(list)
      ? list.filter((n): n is string => typeof n === 'string').map((n) => n.toLowerCase())
      : [];
    vpnWhitelistFetched = true;
    vpnWhitelistExpiry = Date.now() + POLICY_TTL_MS;
    return vpnWhitelist;
  } catch {
    return [];
  }
}

// ─── Fail-closed timeout helper ────────────────────────────────────────────
// SECURITY INARIANT: a hung detector (network fetch with no OS-level timeout,
// native promise that never settles) must never stall the security pipeline —
// a stalled pipeline used to hold the checkRef mutex forever and silently
// swallow every VPN/foreground re-check (verified root cause of the
// "VPN only detected after restart" incident).
// On timeout the detector resolves to its fail-safe value (null = no threat,
// server defaults = fail-secure policy) so the check cycle always completes.
const DETECTOR_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(onTimeout()); }
    }, ms);
    p.then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(onTimeout()); } },
    );
  });
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
    //
    // Part 1 redesign — the decision is a MULTI-SIGNAL evaluation, not a
    // single framework boolean. Known Smali bypasses patch exactly one
    // method (hasTransport / isUp / the interface-name compare); each of
    // those now leaves contradictory evidence in an INDEPENDENT plane:
    //   • vpnState   — native aggregate model: 'on' | 'off' | 'suspicious'
    //                  ('suspicious' = callback observed a VPN the sensors
    //                  no longer find — i.e. active suppression) | 'unknown'
    //   • netNative  — C++ read of the KERNEL interface/route tables
    //                  (/proc/net/dev, /proc/net/route). A userspace hook
    //                  faking the framework APIs does not edit these.
    //   • coreRasp   — C++ /proc/self/maps hook-library + injected-thread
    //                  evidence (an instrumentation framework present).
    // Positive signal from ANY plane → threat. A patched boolean with all
    // other planes reporting 'on' still blocks.
    const flags = await getNativeSecurityFlags();
    const netTunnels = Number(flags.netNativeTunnelIfaces ?? 0);
    const vpnState = typeof flags.vpnState === 'string' ? flags.vpnState : 'unknown';
    if (!wasLastSecurityFlagsCallUnavailable()) {
      console.log('[SecurityCheck][VPN] Android: raw vpnDetected =', flags.vpnDetected,
        '| vpnState =', vpnState,
        '| netTunnels =', netTunnels,
        '| decision =', flags.vpnDetected ? '🔴 BLOCK' : '✅ PASS');
    } else {
      // Fail-safe visibility: native module missing/error → flags are defaults,
      // NOT a measurement. Never silently treat as "confirmed safe".
      console.warn('[SecurityCheck][VPN] Android: native module UNAVAILABLE — VPN state UNKNOWN (fail-safe default)');
    }

    // Signal A: the framework plane (transport + interface names).
    if (flags.vpnDetected) {
      return { type: 'vpn_detected', detectionMethod: 'VPN Connection detected', detected: true };
    }
    // Signal B: native aggregate model — 'on' (sensor agreement) and
    // 'suspicious' (callback saw a VPN that sensors deny = suppression)
    // both block; only an explicit 'off' passes here. 'unknown' is left to
    // the policy layer (does not block on its own; logged as evidence).
    if (vpnState === 'on' || vpnState === 'suspicious') {
      return {
        type: 'vpn_detected',
        detectionMethod: `VPN detected (native aggregate: ${vpnState})`,
        detected: true,
      };
    }
    // Signal C: kernel-plane tunnel interfaces with an active default route
    // through one of them — independent of every framework API.
    if (netTunnels > 0 && flags.netNativeRouteTunnel === true) {
      return {
        type: 'vpn_detected',
        detectionMethod: `VPN detected (kernel tunnel interface x${netTunnels})`,
        detected: true,
      };
    }
    return null;
  } catch (e) {
    if (__DEV__) {
      console.log('[SecurityCheck][VPN] exception:', e);
    }
    return null;
  }
}

/**
 * Proxy detection.
 * Android: native SecurityModule three-tier probe — JVM system proxy properties
 *          (http.proxyHost/https.proxyHost/socksProxyHost — what ProxySelector
 *          actually honors), ProxySelector.select() on the live API origin, and
 *          LinkProperties.httpProxy (API 29+). The previous JS env-var scan
 *          (globalThis.http_proxy) is dead code on Android app processes —
 *          those properties live on the JVM, not in JS.
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

    // Android: native three-tier probe (see SecurityModule.detectProxy).
    // Proxy policy default is warn_only — imperfect detection must never lock
    // users out; it reports evidence to the backend where policy is applied.
    const flags = await getNativeSecurityFlags();
    if (__DEV__) {
      console.log('[SecurityCheck][Proxy] Android proxyDetected=', flags.proxyDetected);
    }
    if (!flags.proxyDetected) return null;
    return { type: 'proxy_detected', detectionMethod: 'Proxy configuration detected', detected: true };
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
      // FIX (event-accurate mapping): this branch detects a LIVE DEBUGGER
      // (sysctl kinfo_proc P_TRACED). It previously emitted
      // developer_options_enabled — the wrong event — which mislabeled the
      // condition in the audit trail and gate UI. debugger_attached is the
      // accurate event type; it maps into the same blocking `debug` bucket,
      // so the security policy is unchanged.
      return {
        type: 'debugger_attached',
        detectionMethod: 'Debugger attached',
        detected: true,
      };
    }

    // Android
    // DETECTION vs POLICY (owner-mandated model): the four Android debug
    // states are detected as DISTINCT event types — developer_options_enabled,
    // adb_enabled, debugger_attached, debug_detected (test-only build) — so
    // the backend audit trail records exactly which surface is present. ALL
    // FOUR are MANDATORY security blocks per the owner's security policy:
    // they map into the block_login policy buckets (developer_options / debug)
    // and lock the app behind the central SecurityGate until cleared.
    const flags = await getNativeSecurityFlags();
    if (flags.debuggerAttached) {
      return { type: 'debugger_attached', detectionMethod: 'Debugger attached', detected: true };
    }
    if (flags.adbEnabled) {
      return { type: 'adb_enabled', detectionMethod: 'USB debugging (ADB) enabled', detected: true };
    }
    if (flags.developerOptionsEnabled) {
      return { type: 'developer_options_enabled', detectionMethod: 'Developer options enabled', detected: true };
    }
    if (flags.testOnlyBuild) {
      return { type: 'debug_detected', detectionMethod: 'test-only build flag', detected: true };
    }
    return null;
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

/**
 * App-integrity evaluation (Part 6/7 hardening).
 *
 * Package identity: PackageManager must report the OFFICIAL application id
 * (com.medacademy.app). A repackaged APK installed under a different package
 * name fails here regardless of its signing certificate.
 *
 * Signing identity: the native layer compares the APK's signing cert SHA-256
 * against the build-injected production pin (BuildConfig.EXPECTED_CERT_SHA256,
 * direct reference — R8 keeps it). signatureValid=false means re-signed or
 * tampered; expectedCertConfigured=false means no pin in this build (dev) —
 * the check is then UNAVAILABLE, never a verdict.
 *
 * This remains evidence + a local UX gate, NOT the authorization boundary:
 * the same findings travel to the backend via security events and the
 * device-evidence flow, where binary-integrity baselines are enforced.
 */
function detectAppIntegrity(): SecurityThreat | null {
  try {
    if (process.env.EXPO_OS === 'web') return null;
    const flags = getNativeSecurityFlagsSync();
    const issues: string[] = [];

    // 1. Package identity (Part 6).
    if (typeof flags.packageIdentityValid === 'boolean' && !flags.packageIdentityValid) {
      issues.push('package identity mismatch');
    }
    // 2. Signing certificate against the build-time pin (Part 6).
    if (flags.expectedCertConfigured === true && flags.signatureValid === false) {
      issues.push('signing certificate mismatch');
    }
    // 3. Native anti-tamper (dex/lib presence, distribution-aware).
    if (flags.tampered === true) {
      issues.push('binary tampering');
    }

    if (issues.length === 0) return null;
    if (__DEV__) {
      console.log('[SecurityCheck][AppIntegrity] findings:', issues.join('; '));
    }
    return {
      type: 'app_integrity_compromised',
      detectionMethod: `App integrity check failed (${issues.join('; ')})`,
      detected: true,
    };
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
 *   1. Fire a probe request to the PHP API with a known-good CORS endpoint.
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

  const probeStart = Date.now();
  try {
    // Step 1: connectivity gate — genuinely offline is NOT a security finding
    // (offline behavior is owned by the offline policy architecture).
    const Network = await import('expo-network');
    const state = await Network.getNetworkStateAsync();
    const isConnected = state.isConnected && state.isInternetReachable;
    if (!isConnected) {
      return null;
    }

    // Step 2: probe the pinned origin (the PHP backend — TLS validated by the
    // platform/native pinning layer where wired).
    const phpApiUrl = process.env.EXPO_PUBLIC_PHP_API_URL?.trim();
    if (!phpApiUrl) return null; // configuration guard reports this separately

    const fetchWithTimeout = async (url: string, ms: number, method: 'GET' | 'HEAD') => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ms);
      try {
        // globalThis.fetch explicitly — bare `fetch` can be undefined in iOS JSC
        // module scope before the lazy getter fires.
        return await globalThis.fetch(url, { method, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    };

    let originOk = false;
    let originCategory: SslProbeFailureCategory = 'none';
    let originHttpStatus = -1;
    try {
      const res = await fetchWithTimeout(phpApiUrl, 8000, 'GET');
      originHttpStatus = res.status;
      // Any HTTP response (even 4xx) means TLS handshook — identity accepted.
      originOk = res.status > 0;
      if (!originOk) originCategory = 'http_error';
    } catch (e: unknown) {
      // Classify the failure: abort() → timeout; TypeError → network/DNS;
      // anything else → unknown. NOTE: on Android no native pin enforcement
      // is wired today, so a fetch-level rejection here cannot be a pin
      // mismatch — it is reachability. If a native pinner is later wired and
      // rejects a TLS identity, surface it as category 'tls_rejected' and
      // this classifier will emit the real ssl_pinning_failure.
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      originCategory = /abort/i.test(msg) ? 'timeout' : /network|dns|failed to fetch|connect/i.test(msg) ? 'network_error' : 'unknown';
    }

    // Step 3: only when the ORIGIN failed do we probe an unpinned control host
    // to distinguish "device offline/degraded network" from "origin-specific
    // failure". The control host is a global CDN — reachable under conditions
    // where a single distant origin is not, so this NO LONGER proves a pin
    // mismatch; it only proves the device has SOME internet.
    let controlOk: boolean | null = null;
    if (!originOk) {
      try {
        await fetchWithTimeout('https://www.apple.com/library/test/success.html', 5000, 'HEAD');
        controlOk = true;
      } catch {
        controlOk = false;
      }
    }

    const outcome = classifySslProbe(originOk, controlOk, originCategory);
    const elapsed = Date.now() - probeStart;

    if (__DEV__) {
      console.log('[SecurityCheck][SSLPinning] outcome=', outcome, 'category=', originCategory,
        'httpStatus=', originHttpStatus, 'control=', controlOk, 'elapsedMs=', elapsed);
    }

    if (isSslProbeSecurityFinding(outcome)) {
      return {
        type: 'ssl_pinning_failure',
        detectionMethod: 'TLS identity of the API server was rejected by certificate pinning',
        detected: true,
      };
    }

    if (outcome !== 'pin_verified') {
      // OBSERVABILITY ONLY (weight 0, never blocking): log the degradation with
      // its category so diagnostics can answer "timeout vs network error vs
      // server failure". Contains no secrets and no technical exposure to the
      // student UI (the gate only renders blocking findings).
      return {
        type: 'connection_probe_degraded',
        detectionMethod: `Connection check inconclusive (${originCategory})`,
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
 * Signature + tamper detection — distribution-aware.
 *
 * Android: cert SHA-256 vs trusted fingerprints (server-supplied via
 *          security_config.expected_cert_sha256s, with a static bootstrap
 *          fallback) + native lib presence. Installer source is DISTRIBUTION
 *          TELEMETRY ONLY by default: this app is distributed as a direct-
 *          downloaded release APK, so a null/non-Play installer is NOT tamper
 *          evidence. Admins can enable a server-controlled strict mode by
 *          setting extras.require_play_installer=true in security_config —
 *          intended for a future Play-only production rollout.
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
    const requirePlayInstaller =
      getSecurityConfig().extras?.require_play_installer === true;
    if (__DEV__) {
      console.log('[SecurityCheck][Tamper] Android signatureValid=', flags.signatureValid, '| tampered=', flags.tampered,
        '| sigCheckReady=', SIGNATURE_CHECK_READY, '| trustedCerts=', TRUSTED_CERTS.length,
        '| requirePlayInstaller=', requirePlayInstaller, '| installerSource=', flags.installerSource ?? null,
        '| expectedCertConfigured=', flags.expectedCertConfigured ?? false);
    }

    // Signature check: pass only when runtime cert matches ANY trusted fingerprint.
    // UNAVAILABLE when no fingerprint is configured anywhere — that state is
    // surfaced as evidence (expectedCertConfigured=false), never as a failure.
    if (SIGNATURE_CHECK_READY && TRUSTED_CERTS.length > 0) {
      if (!flags.signatureValid) {
        return { type: 'signature_invalid', detectionMethod: 'App signature verification failed', detected: true };
      }
    }

    if (flags.tampered) {
      return { type: 'tamper_detected', detectionMethod: 'App integrity check failed', detected: true };
    }

    // Server-controlled strict mode ONLY (see detectTamper doc above).
    // Default OFF: direct-download distribution must never read as tampering.
    if (requirePlayInstaller) {
      const installer = flags.installerSource ?? null;
      if (installer !== 'com.android.vending') {
        return {
          type: 'tamper_detected',
          detectionMethod: 'App not installed from an approved store (strict installer policy)',
          detected: true,
        };
      }
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

    // 1. Request-hash challenge from our backend (single-use, 5-min TTL,
    //    bound to this user; the generic action covers the security-gate UX
    //    check — protected endpoints use action-scoped challenges).
    const { data: nonceData, error: nonceErr } = await backendClient.functions.invoke('verify-play-integrity', {
      body: { action: 'get_nonce', protected_action: 'generic' },
    });
    if (nonceErr || !nonceData?.request_hash) return null;
    _piNonce = nonceData.request_hash as string;

    // 2. Request token from Play Integrity API (native; the hash becomes
    //    Google-signed requestDetails.requestHash)
    const token = await requestPlayIntegrityToken(_piNonce);
    if (!token) {
      _piResult = true;
      _piExpiry = Date.now() + PI_TTL_MS;
      return null;
    }

    // 3. Server-side verification — client NEVER interprets verdict. The
    //    backend decodes via Google (fail-closed) and persists a verdict row
    //    bound to (user, action, request_hash).
    const { data: verifyData, error: verifyErr } = await backendClient.functions.invoke('verify-play-integrity', {
      body: { action: 'verify', token, request_hash: _piNonce },
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
      const { data: nonceData, error: nonceErr } = await backendClient.functions.invoke('verify-app-integrity', {
        body: { action: 'get_challenge', platform: 'ios' },
      });
      if (nonceErr || !nonceData?.challenge) return null; // Backend unavailable → non-blocking

      const challenge = nonceData.challenge as string;

      // 2c. Attest key on first use (server stores the public key once)
      if (!_appAttestKeyPersisted) {
        const { error: attestErr } = await backendClient.functions.invoke('verify-app-integrity', {
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
      const { data: verifyData, error: verifyErr } = await backendClient.functions.invoke('verify-app-integrity', {
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

    const { data: dcData, error: dcErr } = await backendClient.functions.invoke('verify-app-integrity', {
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
  // Delegates to the PURE model (securityStateModel.ts) so the risk formula
  // is unit-testable. Semantics unchanged: Σ weights of detected threats,
  // clamped to 0..100. Risk score is INFORMATIONAL — the block decision is
  // policy-driven (evaluateSecurityResult), never score-driven.
  return computeRiskScorePure(threats, WEIGHTS);
}

// ─── Full Security Check ──────────────────────────────────────────────────────

export async function runSecurityChecks(): Promise<SecurityCheckResult> {
  if (__DEV__) {
    console.log('[SecurityCheck][runSecurityChecks] ▶ starting all checks on platform=', process.env.EXPO_OS);
  }

  // ── OFFLINE FAST-PATH (genuine-offline detection only — no policy change) ──
  // A genuinely offline device cannot complete the NETWORK-bound detectors
  // (Play Integrity nonce/verdict; server policy fetch). Those checks already
  // resolve to "no threat" on network failure — but only after their full
  // network timeouts, which held the fail-closed startup gate up for ~10–20s
  // before Offline Mode appeared. Skipping them WHEN THE DEVICE IS GENUINELY
  // OFFLINE is honest: they cannot produce evidence offline either way, and
  // the connectivity-restore listener re-runs the full pipeline the moment
  // the network returns. EVERY LOCAL detector (root, emulator, mock location,
  // developer options, USB debugging, debugger, frida/xposed/magisk, overlay,
  // screen recording, tamper/signature) still runs — genuine violations still
  // block offline exactly as online.
  let genuinelyOffline = false;
  if (process.env.EXPO_OS !== 'web') {
    try {
      const Network = await import('expo-network');
      const st = await Network.getNetworkStateAsync();
      genuinelyOffline = !(st.isConnected && st.isInternetReachable !== false);
    } catch { /* unreachable state → assume online (full pipeline) */ }
    if (__DEV__ && genuinelyOffline) {
      console.log('[SecurityCheck][runSecurityChecks] device genuinely offline — skipping network-bound detectors (local detectors still run)');
    }
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
    // Every detector is individually bounded (DETECTOR_TIMEOUT_MS): a single
    // hung native/network call can no longer stall the whole pipeline. A timed-
    // out detector resolves to its fail-safe value (null = no threat from that
    // detector this cycle) so the check always completes and the mutex below
    // (SecurityContext checkRef) is always released.
    withTimeout(detectRootJailbreak(),        DETECTOR_TIMEOUT_MS, () => null),
    withTimeout(detectVPN(),                  DETECTOR_TIMEOUT_MS, () => null),
    withTimeout(detectProxy(),                DETECTOR_TIMEOUT_MS, () => null),
    withTimeout(detectDebug(),                DETECTOR_TIMEOUT_MS, () => null),
    withTimeout(detectDeveloperOptions(),     DETECTOR_TIMEOUT_MS, () => null),
    withTimeout(detectScreenRecording(),      DETECTOR_TIMEOUT_MS, () => null),
    withTimeout(detectFrida(),                DETECTOR_TIMEOUT_MS, () => null),
    withTimeout(detectXposed(),               DETECTOR_TIMEOUT_MS, () => null),
    withTimeout(detectMagisk(),               DETECTOR_TIMEOUT_MS, () => null),
    withTimeout(detectOverlay(),              DETECTOR_TIMEOUT_MS, () => null),
    withTimeout(detectTamper(),               DETECTOR_TIMEOUT_MS, () => null),
    withTimeout(detectMockLocation(),         DETECTOR_TIMEOUT_MS, () => null),
    // Play Integrity is entirely network-bound (backend nonce → Google API).
    // Offline it can only burn its timeouts before returning null anyway.
    withTimeout(genuinelyOffline ? Promise.resolve(null) : runPlayIntegrityCheck(), DETECTOR_TIMEOUT_MS, () => null),
    withTimeout(detectSSLPinning(),           DETECTOR_TIMEOUT_MS, () => null),
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

  // ── Evidence-quality metadata (observability — never scored) ───────────────
  // Distinguishes "verified" from "unavailable" and carries distribution
  // telemetry so the backend can audit evidence quality per event.
  const evidence: SecurityEvidence = {
    installerSource:         rawFlags?.installerSource ?? undefined,
    expectedCertConfigured:  rawFlags?.expectedCertConfigured ?? false,
    signatureSha256:         rawFlags?.signatureSha256 ?? undefined,
    overlayCapableAppsCount: rawFlags?.overlayCapableAppsCount ?? undefined,
    detectionUnavailable:    wasLastSecurityFlagsCallUnavailable(),
  };

  // Delegates the AUTHORITATIVE policy evaluation to the PURE model
  // (securityStateModel.ts) so the findings → policy → state transition is
  // unit-tested (tests/securityStateModel.test.cjs). Semantics unchanged:
  // OR-composition over per-finding policy actions — blocked while ANY
  // blocking finding is live, recoverable when a fresh evaluation finds none.
  const verdict = evaluateSecurityResult({
    threats: allThreats,
    policies,
    detectionToEvent: DETECTION_TO_EVENT,
    weights: WEIGHTS,
  });
  const { blocksLogin, blocksVideo, hasWarnings } = verdict;

  // ── P4: report detection degradation for observability ────────────────────
  // When the native batch was unavailable, the flags above are fail-safe
  // defaults, NOT measurements. Fire-and-forget a 'detection_unavailable'
  // event (server: log_only, never escalates) at most once per session so
  // admins can see coverage gaps without risking user lockout.
  if (wasLastSecurityFlagsCallUnavailable() && process.env.EXPO_OS !== 'web') {
    void reportDetectionUnavailableOnce();
  }

  return { threats: allThreats, riskScore, policies, blocksLogin, blocksVideo, hasWarnings, evidence };
}

// Once-per-session guard for detection_unavailable telemetry.
let _detectionUnavailableReported = false;
function reportDetectionUnavailableOnce(): void {
  if (_detectionUnavailableReported) return;
  _detectionUnavailableReported = true;
  void logSecurityEvent({
    eventType: 'detection_unavailable',
    detectionMethod: 'Native security module unavailable — flags are fail-safe defaults, not measurements',
    policyAction: 'log_only',
    riskScore: 0,
    metadata: { platform: process.env.EXPO_OS, dev: __DEV__ === true },
  }).catch(() => { /* never block user flow */ });
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
    await backendClient.functions.invoke('security-logger', {
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
  evidence?: SecurityEvidence,
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
      // Evidence-quality metadata: lets the backend tell "measured clean with
      // pin" apart from "check unavailable" and audit distribution telemetry.
      metadata: {
        expected_cert_configured:   evidence?.expectedCertConfigured ?? null,
        signature_sha256:           evidence?.signatureSha256 ?? null,
        installer_source:           evidence?.installerSource ?? null,
        overlay_capable_apps_count: evidence?.overlayCapableAppsCount ?? null,
        detection_unavailable:      evidence?.detectionUnavailable ?? false,
      },
    };
  });
  try {
    await backendClient.functions.invoke('security-logger', { body: events });
  } catch { /* silently fail */ }
}
