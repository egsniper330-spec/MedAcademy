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
  recordPlatformIntegrity,
  platformFromProcessEnv,
  classifyIntegrityError,
  resetPlatformIntegrity,
  type PlatformIntegrityStatus,
} from '@/lib/platformIntegrity';
import {
  getNativeSecurityFlags,
  getNativeSecurityFlagsSync,
  wasLastSecurityFlagsCallUnavailable,
  requestPlayIntegrityToken,
  type NativeSecurityFlags,
  isNativeVPNDetected,
  isNativeProxyDetected,
  getIosVpnSignalPath,
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
import {
  computeRiskScorePure,
  evaluateSecurityResult,
  applyMandatoryConnectionFloor,
  VPN_SIGNAL_DEGRADED_EVENT,
  type VpnSignalPath,
} from './securityStateModel';

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
  | 'connection_probe_degraded'
  // VPN DETECTION DEGRADED (honesty fix, iOS): the VPN check could not run its
  // authoritative signal path — the native two-gate module (NWPathMonitor +
  // getifaddrs IFF_UP) is absent so only the weak NetInfo `type==='vpn'`
  // fallback ran (which provably MISSES WireGuard/OpenVPN/Tailscale/WARP),
  // the probe threw, or it timed out. Weight 0 and deliberately NOT mapped in
  // DETECTION_TO_EVENT: it can never block and never warn (unreliable network
  // heuristics must not lock users out), but it also never lets a device be
  // reported as "verified clean" — the coverage gap is logged (policy_action
  // log_only) and visible in diagnostics.
  | 'vpn_detection_degraded';

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
  /**
   * WHICH verification scope produced this verdict ('full' when omitted —
   * every pre-existing caller keeps the complete pipeline). See
   * SecurityCheckScope for the lifecycle rules.
   */
  scope?:      SecurityCheckScope;
  /**
   * Per-detector wall-clock cost in ms for THIS evaluation. Sanitized: names
   * and durations only — never a value, a token, an id or a file path. Used by
   * the resume diagnostics to show which detector actually costs the time.
   */
  timings?:    Record<string, number>;
}

/**
 * ── VERIFICATION SCOPE (the resume-latency lifecycle) ──────────────────────
 *
 * 'full'   — every detector, every network probe. Session start, manual
 *            re-checks, pre-video re-validation and post-update checks.
 * 'resume' — a background→foreground transition. Identical security DECISION
 *            (the same detectors feed the same policy model), but it reuses
 *            evidence whose measurement cannot have changed while the app was
 *            backgrounded and whose reuse window has NOT expired.
 *
 * The distinction is what a detector MEASURES, not how expensive it is:
 *
 *   | detector                         | can change while backgrounded? | resume |
 *   |----------------------------------|-------------------------------|--------|
 *   | vpn / proxy                      | YES (user toggles a tunnel)    | run    |
 *   | debugger, developer options      | YES (Settings/ADB)             | run    |
 *   | screen recording, overlay        | YES (other app starts one)     | run    |
 *   | root/jailbreak, frida/xposed,    | practically NO within the       | run*   |
 *   | magisk, tamper/signature         | reuse window                   |        |
 *   | play integrity / app attest      | only on install/update/restore | TTL    |
 *   | ssl pinning probe                | only when the TLS path changes | TTL    |
 *   | policy fetch                     | only when an admin edits it    | TTL    |
 *
 * (*) the local detectors all read ONE cached native flag batch, so re-running
 * them on resume is a single cheap call — they are NOT skipped. Skipping them
 * would be a real weakening: developer options and USB debugging can be turned
 * on in Settings while the app sits in the background.
 *
 * What IS reused on resume is evidence that is (a) network-bound, (b) attested
 * by the SERVER, and (c) already cached with its own bounded TTL:
 *   • Play Integrity / App Attest — verdict cached for PI_TTL_MS, bound to the
 *     app version, and re-verified server-side per protected action anyway;
 *   • the TLS probe — a PASS is reused for SSL_PROBE_REUSE_MS. A hostile TLS
 *     change cannot hide in that window: the transport layer pins the same
 *     chain, so every other request fails at the handshake.
 * Nothing is cached for authorization. A cached PASS can never authorize a
 * protected action; the server re-decides every protected request.
 */
export type SecurityCheckScope = 'full' | 'resume';

/** How long a SUCCESSFUL TLS probe is reused inside the resume scope. */
const SSL_PROBE_REUSE_MS = 90_000;

/** Monotonic ms of the last probe that completed without a failure category. */
let _sslProbePassedAt = 0;

/** Evidence-quality + distribution telemetry attached to a security check. */
export interface SecurityEvidence {
  /**
   * WHICH iOS VPN signal path produced this check's VPN decision:
   *   'native'           — IOSSecurityModule two-gate check (NWPath + getifaddrs)
   *   'netinfo-fallback' — native module absent; weak NetInfo type==='vpn' only
   *   'unavailable'      — neither path produced a measurement
   * null/undefined on platforms (# Android reads its own native batch).
   * Observability only: it never changes the block decision, but it makes the
   * difference between "measured clean" and "could not measure" auditable.
   */
  vpnSignalPath?:            VpnSignalPath | null;
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
  /**
   * Individual checks that THREW or structurally could not run inside an
   * otherwise successful batch (second pass): hidepid-blocked process scan,
   * unreadable /proc/self/maps, missing native core, any runCatching failure.
   * "unknown", never a clean result — and weight 0: a coverage gap is not a
   * device violation (same philosophy as vpn_detection_degraded).
   */
  unavailableChecks?:        string[];
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
  // VPN-detection-degraded evidence (iOS honesty fix): the VPN check could not
  // run its authoritative path. Weight 0 — a coverage gap is not a device
  // violation and must never raise the risk score or lock anyone out.
  vpn_detection_degraded:     0,
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
  // MANDATORY CONNECTION BLOCK (owner requirement — see
  // applyMandatoryConnectionFloor in securityStateModel.ts): a CONFIRMED VPN or
  // proxy is always block_login. `proxy` used to be warn_only, which — combined
  // with a warn_only server row for `vpn` — is what produced the reported
  // dismissible "Continue Anyway" path on iOS. The bundled default plus the
  // floor now make that unreachable from the client side.
  vpn:               'block_login',
  proxy:             'block_login',
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

// ─── ONE CONFIG REQUEST FOR BOTH CACHES ──────────────────────────────────────
//
// ROOT CAUSE of the iPhone startup/resume latency regression:
// `getSecurityPolicies()` and `getVpnWhitelist()` each performed their OWN
// `get-security-policies` GET. The endpoint returns `{ policies, vpn_whitelist }`
// in ONE payload, so every evaluation — cold start, post-resume, and the 30 s
// periodic tick — made the SAME request twice, and because the whitelist fetch
// ran INSIDE detectVPN() (before the native probe) while the policy fetch ran
// AFTER the detector batch, the two round trips were also SERIALIZED with the
// whole detector pipeline in between.
//
// The startup network lock defers every protected screen request until this
// evaluation completes, so both round trips sat directly on the critical path
// of "app is usable". On iOS — where each request also crosses the bridge and
// often rides a slower cellular path — that read as "every screen shows a
// loading state for a long time".
//
// The fix is a SINGLE-FLIGHT shared fetch: one request, one parse, both caches
// populated, and `runSecurityChecks` starts it BEFORE the detectors so the
// network wait overlaps the native probes. Nothing about the security decision
// changes — same endpoint, same timeout, same fail-secure defaults, same 5-min
// TTL, same mandatory connection floor.
let securityConfigInFlight: Promise<void> | null = null;
// Bumped by invalidatePolicyCache(): a response from a PREVIOUS account/session
// must never repopulate the caches after a logout or identity switch.
let securityConfigGeneration = 0;

interface SecurityConfigPayload {
  policies?: Record<string, { action?: string; enabled?: boolean }>;
  vpn_whitelist?: unknown;
}

/**
 * Fetch the authoritative security config ONCE and populate BOTH caches.
 * Concurrent callers join the in-flight request (no duplicate round trip).
 * A failed/timeout fetch leaves the caches untouched so the callers apply
 * their existing fail-secure fallbacks.
 */
async function loadSecurityConfigOnce(): Promise<void> {
  if (securityConfigInFlight) return securityConfigInFlight;
  const generation = securityConfigGeneration;
  const run = (async () => {
    let payload: SecurityConfigPayload | null = null;
    try {
      const { data } = await withTimeout(
        backendClient.functions.invoke('get-security-policies', { method: 'GET' }),
        DETECTOR_TIMEOUT_MS,
        () => ({ data: null, error: null }),
      );
      payload = (data as SecurityConfigPayload | null) ?? null;
    } catch {
      payload = null;
    }
    // Invalidation happened while this was in flight → discard the result. The
    // next caller issues a fresh request for the NEW identity.
    if (generation !== securityConfigGeneration) return;

    const now = Date.now();

    // ── Policies (unchanged parsing + mandatory connection floor) ──────────
    const rows = payload?.policies;
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
        // MANDATORY CONNECTION FLOOR (see securityStateModel): whatever the
        // server rows say, vpn/proxy resolve to at least block_login. This is
        // the client half of the fix for the reported iOS bypass — a
        // `warn_only` (or disabled) vpn/proxy row can no longer turn a
        // confirmed VPN into a dismissible "Continue Anyway" warning. The
        // server serves the same floor, so this only closes the gaps created
        // by an older client, an offline launch, or a stale cache.
        cachedPolicies = applyMandatoryConnectionFloor(merged);
        policyCacheExpiry = now + POLICY_TTL_MS;
      }
    }

    // ── VPN whitelist (same key, same normalisation, same TTL) ─────────────
    const list = payload?.vpn_whitelist;
    if (Array.isArray(list)) {
      vpnWhitelist = list
        .filter((n): n is string => typeof n === 'string')
        .map((n) => n.toLowerCase());
      vpnWhitelistFetched = true;
      vpnWhitelistExpiry = now + POLICY_TTL_MS;
    }
  })();
  securityConfigInFlight = run;
  try {
    await run;
  } finally {
    // Always release the slot so a later evaluation can retry after a failure.
    if (securityConfigInFlight === run) securityConfigInFlight = null;
  }
}

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
        cachedPolicies = applyMandatoryConnectionFloor({ ...DEFAULT_POLICIES });
        policyCacheExpiry = Date.now() + POLICY_TTL_MS;
        return cachedPolicies;
      }
    } catch { /* state unavailable → attempt the fetch as before */ }
  }

  // One shared request populates BOTH the policy and whitelist caches.
  await loadSecurityConfigOnce();
  if (cachedPolicies && Date.now() < policyCacheExpiry) return cachedPolicies;

  // Server unreachable / payload unusable → fail-secure defaults, cached so a
  // flapping network cannot turn every evaluation into a fetch.
  cachedPolicies = applyMandatoryConnectionFloor({ ...DEFAULT_POLICIES });
  policyCacheExpiry = Date.now() + POLICY_TTL_MS;
  return cachedPolicies;
}

export function invalidatePolicyCache() {
  cachedPolicies = null;
  policyCacheExpiry = 0;
  vpnWhitelist = [];
  vpnWhitelistExpiry = 0;
  vpnWhitelistFetched = false;
  // Drop any in-flight config response: it was requested for the PREVIOUS
  // account and must not repopulate this session's caches.
  securityConfigGeneration += 1;
  securityConfigInFlight = null;
}

// ─── VPN Whitelist Cache ──────────────────────────────────────────────────────

let vpnWhitelist: string[] = [];
let vpnWhitelistExpiry = 0;
// Distinguishes "whitelist is genuinely empty" from "never fetched / fetch failed"
// so a transient failure cannot blank out a configured whitelist.
let vpnWhitelistFetched = false;

/**
 * SYNCHRONOUS peek at the cached VPN whitelist — the fast containment path
 * (native TRANSPORT_VPN callback) uses this to avoid pausing playback for a
 * VPN the admin explicitly allowed. Returns true ONLY when a fetch has
 * COMPLETED and returned entries; "never fetched" and "fetch failed" both
 * return false, i.e. fail CLOSED (detection stays active). This mirrors the
 * whitelist skip in detectVPN() exactly.
 */
export function isVpnWhitelistKnownNonEmpty(): boolean {
  return vpnWhitelistFetched && vpnWhitelist.length > 0;
}

async function getVpnWhitelist(): Promise<string[]> {
  if (vpnWhitelistFetched && Date.now() < vpnWhitelistExpiry) return vpnWhitelist;
  // Shares the ONE `get-security-policies` request with getSecurityPolicies()
  // (see loadSecurityConfigOnce) — this used to be a second, identical GET.
  // A failed/timeout fetch leaves `vpnWhitelistFetched` false, so the next
  // evaluation retries instead of caching an empty whitelist as fact, and
  // detection stays ACTIVE (fail closed).
  await loadSecurityConfigOnce();
  if (vpnWhitelistFetched && Date.now() < vpnWhitelistExpiry) return vpnWhitelist;
  return [];
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
/**
 * WHICH iOS VPN signal path the LAST check used (see SecurityEvidence).
 * 'unavailable' means no measurement was possible. Only an iOS-side value:
 * Android's VPN decision comes from the native security-flag batch.
 */
let lastVpnSignalPath: VpnSignalPath | null = null;

/**
 * Evidence-only finding for a connection detector that could not run its
 * authoritative signal path. Weight 0, mapped to no policy bucket → it can
 * never block or warn; it exists so "we could not verify" is auditable instead
 * of being reported as a clean device.
 */
function vpnDetectionDegradedThreat(detail: string): SecurityThreat {
  return { type: VPN_SIGNAL_DEGRADED_EVENT, detectionMethod: detail, detected: true };
}

async function detectVPN(): Promise<SecurityThreat | null> {
  try {
    if (process.env.EXPO_OS === 'web') return null;

    // START the whitelist lookup — but do NOT await it here. The native tunnel
    // probe below is independent of it, and awaiting first put a whole network
    // round trip in front of the probe on EVERY cold start, resume and periodic
    // tick (the whitelist lives in the same payload as the policy fetch). The
    // security DECISION is unchanged: a non-empty whitelist still suppresses the
    // finding — it is simply applied right after the probe instead of before it.
    const whitelistP = getVpnWhitelist();

    if (process.env.EXPO_OS === 'ios') {
      // Diagnostic: always log on iOS so false-positive investigations have evidence.
      // iOS path: native IOSSecurityModule.checkVPNSafe() (NWPath gate + getifaddrs IFF_UP gate).
      // JS fallback (detectVPNviaNetInfo) only runs when native module is null.
      //
      // HONESTY FIX: the fallback path is NOT equivalent to the native one (it
      // only sees NetInfo type==='vpn', so it provably misses WireGuard/
      // OpenVPN/Tailscale/WARP). It used to look identical to a verified-clean
      // result. The signal path is now recorded on every iOS check and a
      // degraded signal is REPORTED as evidence (weight 0, never blocking) so
      // "could not verify" is never presented as "verified clean".
      lastVpnSignalPath = getIosVpnSignalPath();
      console.log('[SecurityCheck][VPN] iOS: invoking isNativeVPNDetected…',
        '| detector=IOSSecurityModule.checkVPNSafe (two-gate: NWPath+getifaddrs)',
        '| fallback=NetInfo type===vpn only',
        '| signalPath=', lastVpnSignalPath);
      const vpn = await isNativeVPNDetected();
      console.log('[SecurityCheck][VPN] iOS: raw result =', vpn,
        '| decision =', vpn ? '🔴 BLOCK (VPN active)' : '✅ PASS (no VPN)');
      // Admin-whitelisted VPNs suppress the finding entirely (same rule as
      // before — only the await point moved, to overlap with the probe).
      if ((await whitelistP).length > 0) {
        if (__DEV__) {
          console.log('[SecurityCheck][VPN] skipped — admin VPN whitelist has entries');
        }
        return null;
      }
      if (vpn) {
        return {
          type: 'vpn_detected',
          detectionMethod: 'VPN Connection detected',
          detected: true,
        };
      }
      if (lastVpnSignalPath !== 'native') {
        // No VPN observed, but not by the authoritative signal: report the
        // coverage gap instead of a clean verdict. Never a block (a degraded
        // heuristic must not lock anyone out) — the policy layer treats this
        // event as unmapped/log_only.
        return vpnDetectionDegradedThreat(
          lastVpnSignalPath === 'unavailable'
            ? 'VPN check could not run on this device (no native tunnel signal available) — result is NOT a verified clean state'
            : 'VPN check ran on the weak NetInfo fallback (native tunnel probe unavailable) — packet-tunnel VPNs may be missed; result is NOT a verified clean state',
        );
      }
      return null;
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
    // Admin-whitelisted VPNs suppress the finding (unchanged rule; the lookup
    // overlapped with the native batch above instead of blocking it).
    if ((await whitelistP).length > 0) {
      if (__DEV__) {
        console.log('[SecurityCheck][VPN] skipped — admin VPN whitelist has entries');
      }
      return null;
    }
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
    // A thrown VPN probe is NOT a clean device. On iOS report the coverage gap
    // as evidence (weight 0, non-blocking) instead of silently returning null;
    // Android keeps its existing native-unavailable telemetry path.
    if (process.env.EXPO_OS === 'ios') {
      lastVpnSignalPath = 'unavailable';
      return vpnDetectionDegradedThreat('VPN check threw on this device — result is NOT a verified clean state');
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

// ── RESTORED (was: TEMPORARY DEBUG GATE) ─────────────────────────────────────
// Developer Options + USB Debugging (ADB) detection were bypassed for an
// authorized real-device debugging session on the owner's physical Android
// tablet. The bypass has been REMOVED: a release build installed on a device
// with either setting enabled is detected again and locked behind the central
// SecurityGate, as the owner's security policy requires.
//
// Both flags keep their own event types (developer_options_enabled /
// adb_enabled) so the backend audit trail records exactly which surface is
// present; both map into the blocking `developer_options` policy bucket
// (block_login). DEBUG DISABLE constant intentionally deleted — there is no
// longer any single line that can switch these detections off in production.
// ─────────────────────────────────────────────────────────────────────────────
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
    // RESTORED: USB debugging (ADB) and Developer Options are mandatory blocks
    // again (both map to the blocking developer_options bucket). The bypass
    // used during the authorized device-debugging session is gone.
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
      // HEAD, not GET (resume latency): this probe only needs the TLS handshake
      // to complete — the classification below keys off "any HTTP status" and
      // the failure text, never the body. A GET downloaded the API root's
      // payload on EVERY check, including every background→foreground resume,
      // and its 8 s budget was the longest of any detector: because all
      // detectors run in parallel the resume hold waits for the slowest one, so
      // on a weak connection this single probe could hold the whole app for
      // up to 8 s after returning from another app ("the loading takes very
      // long on iOS"). HEAD + a 5 s bound keeps the exact same pass/fail
      // semantics and can only shorten the hold.
      const res = await fetchWithTimeout(phpApiUrl, 5000, 'HEAD');
      originHttpStatus = res.status;
      // Any HTTP response (even 4xx) means TLS handshook — identity accepted.
      originOk = res.status > 0;
      if (!originOk) originCategory = 'http_error';
    } catch (e: unknown) {
      // Classify the failure. A rejected TLS identity is a SECURITY event and
      // must be reported as 'tls_rejected' so classifySslProbe() resolves to
      // 'pin_mismatch' → ssl_pinning_failure (risk 20 → block_login).
      //
      // As of 2026-10-09 BOTH platforms enforce real pinning:
      //   • Android — network_security_config.xml <pin-set>, enforced by the
      //     platform TLS stack (see plugins/withNetworkSecurityConfig.js);
      //   • iOS — PinningURLProtocol SPKI check on the presented chain.
      // A proxy/MITM CA therefore fails the handshake, and the failure text is
      // distinguishable from plain unreachability:
      //   Android/Conscrypt: SSLPeerUnverifiedException,
      //     "Certificate pinning failure!",
      //     "Trust anchor for certification path not found".
      //   iOS: NSURLErrorServerCertificateUntrusted (-1202), or the
      //     fail-closed NSURLErrorCancelled emitted by the pin URLProtocol.
      //
      // TLS rejection is tested FIRST so it can never be downgraded to a
      // generic 'network_error' (which is weight 0 / log-only).
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      const tlsRejected =
        /pin(ning)?\s*failure/i.test(msg) ||
        /SSLPeerUnverifiedException/i.test(msg) ||
        /trust anchor|certification path not found/i.test(msg) ||
        /CERTIFICATE_VERIFY_FAILED|SSL certificate problem/i.test(msg) ||
        /ServerCertificateUntrusted|-1202/i.test(msg);
      originCategory = tlsRejected
        ? 'tls_rejected'
        : /abort/i.test(msg)
          ? 'timeout'
          : /network|dns|failed to fetch|connect/i.test(msg)
            ? 'network_error'
            : 'unknown';
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

    // A VERIFIED pin (the actual security property) — recorded so a resume
    // within SSL_PROBE_REUSE_MS does not re-probe. Only this outcome is
    // cached; an inconclusive probe is never reused as if it had passed.
    _sslProbePassedAt = Date.now();
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

    // Signature check: pass only when the runtime cert matches a trusted
    // fingerprint AND the BUILD actually pinned one.
    //
    // Why the extra `expectedCertConfigured` condition matters: with an empty
    // BuildConfig.EXPECTED_CERT_SHA256 the native check returns
    // signatureValid=true having compared NOTHING (see
    // SecurityModule.checkSignatureValid — `if (expected.isEmpty()) return true`).
    // Without this condition, a release built on a machine that never generated
    // the pin would have its unverified signature read as "verified" whenever
    // the server had trusted certs configured. Requiring the build-time pin
    // keeps "UNAVAILABLE" distinct from "passed" — the same rule
    // detectAppIntegrity() already applies. UNAVAILABLE is surfaced as evidence
    // (expectedCertConfigured=false in the security event), never as a verdict.
    const buildPinnedCert = flags.expectedCertConfigured === true;
    if (SIGNATURE_CHECK_READY && TRUSTED_CERTS.length > 0 && buildPinnedCert) {
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
 * MOCK LOCATION — deliberately NOT detected. There is no detector function here
 * and no `mock_location` evidence field anywhere in the pipeline.
 *
 * A third-party APK cannot read another package's `android:mock_location` app-op
 * (the cross-UID query needs UPDATE_APP_OPS_STATS, a signature|privileged
 * permission), and the per-package mode it would expose is persisted state that
 * outlives the Developer-options toggle and can be OEM-preset. `MODE_ALLOWED`
 * therefore never proved "Developer options are on", "the user selected a mock
 * app" or "locations are being mocked right now" — it only produced a
 * login-blocking risk-20 finding on stock devices (last seen on Android 16 /
 * API 36 with Developer options OFF). MedAcademy has no location-based feature,
 * so the check protected nothing. See the removal note in
 * plugins/withSecurityModule.js and docs/MOCK_LOCATION_REMOVAL.md.
 */

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
// `_piResult` is the THREAT-DECISION cache only: true = "produced no threat this
// cycle", false = "produced a blocking threat". It is NOT a verdict record — in
// particular `true` does NOT mean "verified". Whether the check actually ran and
// what the platform said lives in `platformIntegrity` (see below); that is the
// only thing diagnostics and reports may read. Keeping the two separate is what
// stops an unavailable/deferred check from being presented as a pass.
let _piResult: boolean | null = null;
let _piExpiry = 0;
const PI_TTL_MS = 10 * 60 * 1000;

/**
 * Record the integrity outcome for reporting. Pure bookkeeping — it never
 * changes a weight, policy, or gate decision. See `platformIntegrity.ts` for
 * the status vocabulary and invariants.
 */
function settlePlatformIntegrity(
  status: PlatformIntegrityStatus,
  detail: string | null,
): void {
  recordPlatformIntegrity({ status, platform: platformFromProcessEnv(), detail });
}

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
    if (!PLAY_INTEGRITY_READY) {
      settlePlatformIntegrity('unavailable', 'Play Integrity build-time guard inactive (PLAY_INTEGRITY_READY=false) — check did NOT run');
      return null;
    }

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
    if (nonceErr || !nonceData?.request_hash) {
      const c = classifyIntegrityError(
        nonceErr ?? { message: 'nonce response missing request_hash' },
        'android',
      );
      settlePlatformIntegrity(c.status, c.detail);
      return null;
    }
    _piNonce = nonceData.request_hash as string;

    // 2. Request token from Play Integrity API (native; the hash becomes
    //    Google-signed requestDetails.requestHash)
    const token = await requestPlayIntegrityToken(_piNonce);
    if (!token) {
      // No token (no Play Services, or an unsupported device). This is an
      // ENVIRONMENT limitation, NOT a verified pass. Recorded as
      // 'unavailable' so no diagnostic, report or summary can ever present it
      // as a satisfied control. The cache below is still written, but note
      // WHAT it caches: `_piResult` is the THREAT DECISION for this cycle
      // (true = "produced no threat"), not a verdict. It exists so a device
      // without Play Services does not re-enter the native bridge every cycle.
      settlePlatformIntegrity('unavailable', 'Play Integrity token unavailable (no Play Services / unsupported device) — check did NOT run');
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
    if (verifyErr) {
      const c = classifyIntegrityError(verifyErr, 'android');
      settlePlatformIntegrity(c.status, c.detail);
      return null;
    }

    const passed = verifyData?.passed === true;
    _piResult = passed;
    _piExpiry = Date.now() + PI_TTL_MS;
    settlePlatformIntegrity(
      passed ? 'passed' : 'failed',
      passed
        ? 'Play Integrity verdict: device/app genuine'
        : 'Play Integrity verdict: integrity failure reported by the server',
    );

    if (!passed) {
      return {
        type: 'play_integrity_failed',
        detectionMethod: 'Device integrity check failed',
        detected: true,
      };
    }
    return null;
  } catch (e: unknown) {
    // Unexpected throw: inconclusive, never a pass.
    settlePlatformIntegrity(
      'error',
      `Play Integrity flow threw unexpectedly (${(e as { message?: string })?.message ?? 'unknown'}) — NOT a pass`,
    );
    return null;
  }
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
  // Tracks the most informative reason the flow could not produce a verdict, so
  // every terminal exit can record an accurate status instead of a blanket
  // "unknown". 'deferred' wins over a generic transient 'error' because it is
  // the most specific cause (a deliberate server-side product decision).
  let unverifiedStatus: PlatformIntegrityStatus | null = null;
  let unverifiedDetail: string | null = null;
  const noteUnverified = (status: PlatformIntegrityStatus, detail: string) => {
    if (unverifiedStatus === 'deferred') return; // already the most specific
    unverifiedStatus = status;
    unverifiedDetail = detail;
  };
  const finishUnverified = (): null => {
    settlePlatformIntegrity(
      unverifiedStatus ?? 'error',
      unverifiedDetail ?? 'App Attest produced no verdict — NOT a pass',
    );
    return null;
  };

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
          // Any other key-generation error: skip this check (recorded as
          // inconclusive — never as a pass).
          noteUnverified('error', `App Attest key generation failed (${code ?? 'unknown'}) — check did NOT run`);
          return finishUnverified();
        }
      }

      // 2b. Get server challenge
      const { data: nonceData, error: nonceErr } = await backendClient.functions.invoke('verify-app-integrity', {
        body: { action: 'get_challenge', platform: 'ios' },
      });
      if (nonceErr || !nonceData?.challenge) {
        // Backend unavailable → non-blocking, but explicitly NOT a pass.
        const c = classifyIntegrityError(
          nonceErr ?? { message: 'challenge response missing challenge' },
          'ios',
        );
        noteUnverified(c.status, c.detail);
        return finishUnverified();
      }

      const challenge = nonceData.challenge as string;

      // 2c. Attest key on first use (server stores the public key once)
      if (!_appAttestKeyPersisted) {
        const { error: attestErr } = await backendClient.functions.invoke('verify-app-integrity', {
          body: { action: 'attest_key', keyId: _appAttestKeyId, challenge, platform: 'ios' },
        });
        if (attestErr) {
          // Server-side attestation failed. Classify BEFORE discarding the key:
          // HTTP 503/501 means the server deliberately has App Attest
          // enforcement OFF (the deferred product decision). That is not a
          // device fault and is not worth retrying inside this cycle.
          const c = classifyIntegrityError(attestErr, 'ios');
          noteUnverified(c.status, c.detail);
          // Key may need regeneration on the next real attempt.
          _appAttestKeyId = null;
          _appAttestKeyPersisted = false;
          try { await SecureStore.deleteItemAsync(ATTEST_KEY_STORE); } catch { /* ignore */ }
          if (c.status === 'deferred') break; // do not spin on a deliberate deferral
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
          noteUnverified('error', 'App Attest assertion failed (Apple server error) — inconclusive, NOT a pass');
          return finishUnverified();
        }
        // Other assertion errors: skip
        noteUnverified('error', `App Attest assertion failed (${code ?? 'unknown'}) — check did NOT run`);
        return finishUnverified();
      }

      if (!assertion) {
        noteUnverified('error', 'App Attest produced no assertion — check did NOT run');
        return finishUnverified();
      }

      // 2e. Server-side assertion verification
      const { data: verifyData, error: verifyErr } = await backendClient.functions.invoke('verify-app-integrity', {
        body: { action: 'verify_assertion', keyId: _appAttestKeyId, assertion, challenge, platform: 'ios' },
      });
      if (verifyErr) {
        // Transient server issue — non-blocking, but explicitly NOT a pass.
        const c = classifyIntegrityError(verifyErr, 'ios');
        noteUnverified(c.status, c.detail);
        return finishUnverified();
      }

      const passed = verifyData?.passed === true;
      _piResult = passed;
      _piExpiry = Date.now() + PI_TTL_MS;
      settlePlatformIntegrity(
        passed ? 'passed' : 'failed',
        passed
          ? 'App Attest assertion verified by the server'
          : 'App Attest assertion rejected: real integrity failure reported by the server',
      );
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
      if (code === DEVICE_CHECK_UNSUPPORTED) {
        // Simulator — skip, non-blocking. Recorded as an environment fact.
        noteUnverified('unavailable', 'DeviceCheck unsupported on this device (simulator) — check did NOT run');
        return finishUnverified();
      }
      noteUnverified('error', `DeviceCheck token unavailable (${code ?? 'unknown'}) — check did NOT run`);
      return finishUnverified();
    }

    if (!dcToken) {
      noteUnverified('unavailable', 'DeviceCheck returned no token — check did NOT run');
      return finishUnverified();
    }

    const { data: dcData, error: dcErr } = await backendClient.functions.invoke('verify-app-integrity', {
      body: { action: 'verify_device_check', token: dcToken, platform: 'ios' },
    });
    if (dcErr) {
      const c = classifyIntegrityError(dcErr, 'ios');
      noteUnverified(c.status, c.detail);
      return finishUnverified();
    }

    const dcPassed = dcData?.passed === true;
    _piResult = dcPassed;
    _piExpiry = Date.now() + PI_TTL_MS;
    settlePlatformIntegrity(
      dcPassed ? 'passed' : 'failed',
      dcPassed
        ? 'DeviceCheck token verified by the server'
        : 'DeviceCheck verdict: real integrity failure reported by the server',
    );
    if (!dcPassed) {
      return {
        type: 'app_attest_failed',
        detectionMethod: 'Device integrity check failed',
        detected: true,
      };
    }
    return null;
  } catch (e: unknown) {
    // Unexpected throw: inconclusive, never a pass.
    settlePlatformIntegrity(
      'error',
      `App Attest flow threw unexpectedly (${(e as { message?: string })?.message ?? 'unknown'}) — NOT a pass`,
    );
    return null;
  }
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
  // The integrity cache is gone, so the reported status must go back to
  // "not checked" rather than describing a stale previous session.
  resetPlatformIntegrity();
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

export async function runSecurityChecks(
  options: { scope?: SecurityCheckScope } = {},
): Promise<SecurityCheckResult> {
  // Default is the COMPLETE pipeline, so every existing caller is unchanged.
  const scope: SecurityCheckScope = options.scope === 'resume' ? 'resume' : 'full';
  const timings: Record<string, number> = {};
  const evaluationStart = Date.now();
  let sslReused = false;
  /** Measure ONE detector without changing what it decides. */
  const track = async <T,>(name: string, run: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      return await run();
    } finally {
      timings[name] = Date.now() - t0;
    }
  };
  if (__DEV__) {
    console.log('[SecurityCheck][runSecurityChecks] ▶ starting checks on platform=', process.env.EXPO_OS, 'scope=', scope);
  }

  // ── OFFLINE FAST-PATH (genuine-offline detection only — no policy change) ──
  // A genuinely offline device cannot complete the NETWORK-bound detectors
  // (Play Integrity nonce/verdict; server policy fetch). Those checks already
  // resolve to "no threat" on network failure — but only after their full
  // network timeouts, which held the fail-closed startup gate up for ~10–20s
  // before Offline Mode appeared. Skipping them WHEN THE DEVICE IS GENUINELY
  // OFFLINE is honest: they cannot produce evidence offline either way, and
  // the connectivity-restore listener re-runs the full pipeline the moment
  // the network returns. EVERY LOCAL detector (root, emulator,
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

  // ── START THE CONFIG FETCH NOW (not after the detectors) ─────────────────
  // The policy+whitelist payload is network-bound and independent of every
  // native probe, so waiting for the detector batch before requesting it added
  // a FULL round trip to every evaluation — and the startup network lock holds
  // every screen request until this evaluation finishes, which is exactly what
  // made the iPhone feel slow to load. It is started here so the network wait
  // overlaps the native probes. Single-flight: detectVPN's whitelist lookup
  // joins this same request (no duplicate GET).
  const policiesP = getSecurityPolicies();

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
    piThreat, sslThreat,
  ] = await Promise.all([
    // Every detector is individually bounded (DETECTOR_TIMEOUT_MS): a single
    // hung native/network call can no longer stall the whole pipeline. A timed-
    // out detector resolves to its fail-safe value (null = no threat from that
    // detector this cycle) so the check always completes and the mutex below
    // (SecurityContext checkRef) is always released.
    track('root',       () => withTimeout(detectRootJailbreak(),        DETECTOR_TIMEOUT_MS, () => null)),
    track('vpn',        () => withTimeout(detectVPN(),                  DETECTOR_TIMEOUT_MS, () => vpnDetectionDegradedThreat(
      // A timed-out VPN probe is a coverage gap, not a clean device. The
      // fallback value keeps that distinction visible on iOS; on other
      // platforms the Android/Play-Integrity unavailable telemetry applies.
      process.env.EXPO_OS === 'ios'
        ? 'VPN check timed out on this device — result is NOT a verified clean state'
        : 'VPN check timed out — result is NOT a verified clean state'
    ))),
    track('proxy',      () => withTimeout(detectProxy(),                DETECTOR_TIMEOUT_MS, () => null)),
    track('debug',      () => withTimeout(detectDebug(),                DETECTOR_TIMEOUT_MS, () => null)),
    track('devOptions', () => withTimeout(detectDeveloperOptions(),     DETECTOR_TIMEOUT_MS, () => null)),
    track('screenRec',  () => withTimeout(detectScreenRecording(),      DETECTOR_TIMEOUT_MS, () => null)),
    track('frida',      () => withTimeout(detectFrida(),                DETECTOR_TIMEOUT_MS, () => null)),
    track('xposed',     () => withTimeout(detectXposed(),               DETECTOR_TIMEOUT_MS, () => null)),
    track('magisk',     () => withTimeout(detectMagisk(),               DETECTOR_TIMEOUT_MS, () => null)),
    track('overlay',    () => withTimeout(detectOverlay(),              DETECTOR_TIMEOUT_MS, () => null)),
    track('tamper',     () => withTimeout(detectTamper(),               DETECTOR_TIMEOUT_MS, () => null)),
    // Play Integrity is entirely network-bound (backend nonce → Google API).
    // Offline it can only burn its timeouts before returning null anyway.
    track('platformIntegrity', () => withTimeout(
      genuinelyOffline ? Promise.resolve(null) : runPlayIntegrityCheck(),
      DETECTOR_TIMEOUT_MS,
      () => null,
    )),
    // TLS probe — the one network-bound detector with no internal TTL, so it is
    // the slowest thing a resume could still wait for. A VERIFIED pin is reused
    // inside SSL_PROBE_REUSE_MS in the resume scope only; 'full' always probes.
    track('ssl', () => {
      if (scope === 'resume' && Date.now() - _sslProbePassedAt < SSL_PROBE_REUSE_MS) {
        sslReused = true;
        timings.ssl = 0;
        return Promise.resolve(null);
      }
      return withTimeout(detectSSLPinning(), DETECTOR_TIMEOUT_MS, () => null);
    }),
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
    tamperThreat, piThreat, sslThreat,
  ].filter((t): t is SecurityThreat => t !== null && t.detected);

  if (__DEV__) {
    console.log('[SecurityCheck][runSecurityChecks] ✅ detected threats:', allThreats.map(t => t.type).join(', ') || 'none');
  }

  const riskScore = computeRiskScore(allThreats);
  const policies  = await policiesP;
  if (__DEV__) {
    console.log('[SecurityCheck][runSecurityChecks] riskScore=', riskScore);
  }

  // ── Evidence-quality metadata (observability — never scored) ───────────────
  // Distinguishes "verified" from "unavailable" and carries distribution
  // telemetry so the backend can audit evidence quality per event.
  const evidence: SecurityEvidence = {
    // WHICH iOS VPN signal produced this check (see SecurityEvidence doc).
    vpnSignalPath:           process.env.EXPO_OS === 'ios' ? lastVpnSignalPath : null,
    installerSource:         rawFlags?.installerSource ?? undefined,
    expectedCertConfigured:  rawFlags?.expectedCertConfigured ?? false,
    signatureSha256:         rawFlags?.signatureSha256 ?? undefined,
    overlayCapableAppsCount: rawFlags?.overlayCapableAppsCount ?? undefined,
    detectionUnavailable:    wasLastSecurityFlagsCallUnavailable(),
    unavailableChecks:       rawFlags?.detectionsUnavailable ?? undefined,
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

  // ── Partial degradation (second pass) ───────────────────────────────────
  // Individual checks inside an otherwise successful batch that threw or
  // structurally could not run (e.g. the /proc cmdline scan under hidepid=2).
  // Reported once per session with the check names — log_only, weight 0, never
  // a block: a coverage gap must be auditable without punishing the user.
  const unavailableChecks = rawFlags?.detectionsUnavailable ?? [];
  if (unavailableChecks.length > 0 && process.env.EXPO_OS !== 'web') {
    void reportPartialDetectionUnavailableOnce(unavailableChecks);
  }

  // ── Resume diagnostics (Phase E) ──────────────────────────────────────────
  // One compact line: the scope, the total, whether the TLS probe was reused,
  // and each detector's cost. Names + durations only — no token, no id, no
  // payload, no device evidence. Printed in DEV or when the operator turns on
  // EXPO_PUBLIC_SECURITY_DIAGNOSTICS=1, so a physical device can be measured
  // without a debugger attached.
  const totalMs = Date.now() - evaluationStart;
  if (__DEV__ || process.env.EXPO_PUBLIC_SECURITY_DIAGNOSTICS === '1') {
    const slowest = Object.entries(timings)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => k + '=' + v + 'ms')
      .join(' ');
    console.log(
      '[SecurityCheck][timing] scope=' + scope + ' total=' + totalMs + 'ms'
      + ' sslReused=' + (sslReused ? 'yes' : 'no')
      + ' threats=' + allThreats.length
      + (slowest ? ' | ' + slowest : ''),
    );
  }

  return {
    threats: allThreats, riskScore, policies, blocksLogin, blocksVideo, hasWarnings, evidence,
    scope, timings,
  };
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

// Once-per-session guard for PARTIAL detection degradation (per-check, not
// whole-batch). Separate from the guard above so either kind is always visible.
let _partialDetectionUnavailableReported = false;
function reportPartialDetectionUnavailableOnce(checks: string[]): void {
  if (_partialDetectionUnavailableReported) return;
  _partialDetectionUnavailableReported = true;
  // Cap the payload: the list is bounded in Kotlin anyway, but telemetry must
  // never grow unbounded if a native module misbehaves.
  const bounded = checks.slice(0, 24);
  void logSecurityEvent({
    eventType: 'detection_unavailable',
    detectionMethod: `Individual security checks unavailable: ${bounded.join(', ')}`,
    policyAction: 'log_only',
    riskScore: 0,
    metadata: { platform: process.env.EXPO_OS, checks: bounded, dev: __DEV__ === true },
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
        // WHICH iOS VPN signal path produced this check ('native' /
        // 'netinfo-fallback' / 'unavailable', null elsewhere) — lets the
        // backend tell a measured-clean VPN state apart from a coverage gap.
        vpn_signal_path:            evidence?.vpnSignalPath ?? null,
      },
    };
  });
  try {
    await backendClient.functions.invoke('security-logger', { body: events });
  } catch { /* silently fail */ }
}
