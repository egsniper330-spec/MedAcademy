/**
 * deviceKey — client half of the device-bound challenge/response evidence flow.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ROLE: the client is a SENSOR + EVIDENCE PRODUCER — never a security
 * authority. Everything here can be patched out by a modified APK; that is
 * expected and harmless because authorization happens ONLY on the backend
 * (SecurityEvidenceService consults ITS OWN decision rows, gated by
 * operator-controlled policy tiers). This module exists so a LEGITIMATE
 * client can produce cryptographic evidence a tamperer cannot forge:
 *
 *   1. ensureDeviceKey() — Android Keystore generates an EC P-256 keypair.
 *      The private key is NON-EXPORTABLE (it lives in TEE/StrongBox and can
 *      never reach JS, files, or the network). Reported backing is honest:
 *      strongbox/tee/software/unknown — never a false hardware claim.
 *   2. registerDeviceKey() — sends ONLY the public key (SPKI PEM) + key id
 *      to the backend, bound to this user + device fingerprint.
 *   3. challenge + sign + submit — for a protected action the client asks
 *      the SERVER for a single-use challenge (bound to user, device, session,
 *      action, and the SHA-256 request-hash of the exact body it will send),
 *      signs the canonical evidence with the Keystore key, and submits both.
 *      The backend verifies the signature with ITS OWN stored copy of the
 *      public key and derives the assurance verdict itself.
 *   4. The protected call then carries X-Security-Evidence + X-Security-Signature
 *      headers; the SERVER decides (per security_config.extras.device_evidence
 *      policy) whether the call may proceed without them.
 *
 * This is NOT Play Integrity / App Attest and makes no APK-genuineness claim:
 * a Keystore signature proves possession of a device key, not the integrity
 * of the binary. It composes with the existing integrity layer
 * (src/lib/integrityClient.ts), which remains independent.
 *
 * BOOTSTRAP SEMANTICS (server-enforced, migration 019): evidence from a
 * freshly registered key is capped at DEGRADED no matter what the sensors
 * report — a patched APK cannot sign itself into TRUSTED. The SERVER promotes
 * a key to verified only after server-observed tenure (warmup_hours), active
 * account/device state, and clean server-recorded violation history. With
 * "enforce_strict" tiers (recommended for vdo_otp/redeem), a modified client
 * that registers today is gated out of high-risk actions during the warmup
 * window and stays gated if its account carries violations.
 *
 * CLIENT-LEVEL FAILURE = fail-open (return null headers): a Keystore-less
 * device or transient error must not brick UX. The server's tier decides
 * what an unevidenced call is allowed to do — never this module.
 */

import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import { backendClient } from '@/client/backendClient';
import { NativeModules } from 'react-native';
import { getStoredDeviceFingerprint } from '@/lib/installationId';
import { getIntegrityHash } from '@/lib/integrityClient';

// ── Native bridge ─────────────────────────────────────────────────────────────

interface NativeDeviceKeyModule {
  ensureDeviceKey(): Promise<string>;          // resolves keystore_security
  getDevicePublicKeyPem(): Promise<string>;    // SPKI PEM (public material)
  signDevicePayload(payloadB64: string): Promise<string>; // base64 DER ECDSA-SHA256
  getDeviceKeyId(): Promise<string>;
  isWirelessDebuggingEnabled(): Promise<boolean>;
  // Gap-closure (schema v2) — optional so older native builds stay compatible:
  getBinaryIntegrity?: () => Promise<string>;  // JSON: cert/DEX/libs/assets measurement
  getVpnState?: () => Promise<string>;         // unknown | off | on | suspicious
  getNativeNetworkEvidence?: () => Promise<string>; // /proc/net dev+route evidence (JSON)
}

function getDeviceKeyModule(): NativeDeviceKeyModule | null {
  if (Platform.OS !== 'android') return null;
  return (NativeModules.SecurityModule as NativeDeviceKeyModule | null | undefined) ?? null;
}

// ── Canonical JSON (MUST match SecurityEvidenceService::canonicalJson) ────────
// Recursively sort object keys, minimal separators. Lists keep order; objects
// sort by key. Strings are JSON-encoded; booleans/numbers/null verbatim.

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys.map(
      (k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`
    );
    return `{${pairs.join(',')}}`;
  }
  // undefined / functions must never appear — drop defensively
  return 'null';
}

/** SHA-256 lowercase hex — the request-hash the server binds challenges to. */
export async function requestHashForBody(body: Record<string, unknown>): Promise<string> {
  const canonical = canonicalize(body);
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, canonical, {
    encoding: Crypto.CryptoEncoding.HEX,
  });
}

// ── Key lifecycle ─────────────────────────────────────────────────────────────

export type DeviceKeySecurity = 'strongbox' | 'tee' | 'software' | 'unknown' | null;

let _registrationAttempted = false;

/**
 * Ensure the Keystore keypair exists and is registered with the backend.
 * Idempotent + best-effort: safe to call at login/session establishment.
 * Failure returns null and never throws (enforcement is server-side).
 */
export async function ensureDeviceKeyRegistered(
  fingerprint: string
): Promise<DeviceKeySecurity> {
  const mod = getDeviceKeyModule();
  if (!mod || !fingerprint) return null;

  try {
    const security = (await mod.ensureDeviceKey()) as DeviceKeySecurity;
    if (_registrationAttempted) return security ?? null;

    const [publicKeyPem, keyId] = await Promise.all([
      mod.getDevicePublicKeyPem(),
      mod.getDeviceKeyId(),
    ]);
    if (!publicKeyPem || !keyId) return security ?? null;

    const { error } = await backendClient.functions.invoke('security-evidence-key', {
      body: {
        key_id: keyId,
        public_key_pem: publicKeyPem,
        device_fingerprint: fingerprint,
        keystore_security: security ?? 'unknown',
      },
    });
    if (!error) _registrationAttempted = true;
    return security ?? null;
  } catch {
    return null;
  }
}

/** Test hook. */
export function resetDeviceKeyRegistration(): void {
  _registrationAttempted = false;
}

// ── Evidence acquisition for protected calls ─────────────────────────────────

interface EvidenceHeaders {
  'X-Security-Evidence': string;
  'X-Security-Signature': string;
}

let _inflight: Promise<EvidenceHeaders | null> | null = null;

/**
 * Monotonic client counter (anti-replay). Starts at the ms clock (far ahead
 * of any previous run's stored value) and increments strictly by 1 per use.
 * The SERVER's device_keys.counter remains authoritative — GREATEST() bumps
 * it — but presenting an increasing sequence avoids false rejections when
 * two evidence rounds happen back-to-back within the same millisecond.
 */
let _counter = Date.now();
function nextCounter(): number {
  _counter = Math.max(_counter + 1, Date.now());
  return _counter;
}

// ═══════════════════════════════════════════════════════════════════
// Evidence schema v2 fields (gap-closure Parts 2/3/4/10/13).
// Integrity is MEASURED natively (cert/DEX/libs/assets across base +
// split APKs) and JUDGED server-side against the stored baseline — no
// client-side expected-hash compare exists, so there is nothing to
// patch into "pass". VPN is a 4-state model, not a boolean.
// ═══════════════════════════════════════════════════════════════════

let _integrityCache: { value: Record<string, unknown>; at: number } | null = null;
const INTEGRITY_TTL_MS = 5 * 60 * 1000;

/** Measured binary integrity from the native layer (schema v2, optional). */
async function buildIntegrityEvidence(): Promise<Record<string, unknown> | undefined> {
  try {
    if (_integrityCache && Date.now() - _integrityCache.at < INTEGRITY_TTL_MS) {
      return _integrityCache.value;
    }
    const mod = getDeviceKeyModule();
    const raw = mod?.getBinaryIntegrity ? await mod.getBinaryIntegrity() : null;
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    _integrityCache = { value: parsed, at: Date.now() };
    // Part 3: native network evidence rides INSIDE the integrity blob
    // (single measured structure; no second protocol).
    try {
      const netRaw = mod?.getNativeNetworkEvidence ? await mod.getNativeNetworkEvidence() : null;
      if (netRaw) parsed.native_net = JSON.parse(netRaw);
    } catch { /* unavailable stays absent */ }

    return parsed;
  } catch {
    return undefined; // absent field = UNAVAILABLE; server policy applies
  }
}

/** Aggregate VPN state model from the native layer (schema v2, optional). */
async function buildVpnState(): Promise<string | undefined> {
  try {
    const mod = getDeviceKeyModule();
    const state = mod?.getVpnState ? await mod.getVpnState() : null;
    if (state && ['unknown', 'off', 'on', 'suspicious'].includes(state)) return state;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Configuration version stamp (schema v2, optional). Mirrors the server's
 * security_version so the backend can correlate client-side policy
 * application with its own configuration revisions. The SERVER's
 * security_config remains the authoritative policy — always.
 */
async function getConfigVersion(): Promise<number | undefined> {
  try {
    const { getSecurityConfig } = await import('@/lib/securityConfigService');
    const v = getSecurityConfig().security_version;
    return typeof v === 'number' && v > 0 ? Math.floor(v) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Full flow for one protected call:
 *   challenge (server) → sign (Keystore) → verify (server) → headers.
 * Returns null on ANY failure — callers proceed without evidence headers and
 * the SERVER policy decides whether that is acceptable. Never throws.
 *
 * @param action       protected action key (vdo_otp | redeem | device_bind)
 * @param requestHash  SHA-256 (lowercase hex) of the canonical JSON of the
 *                     EXACT body that will be sent on the protected call
 * @param fingerprint  this device's fingerprint (must match the registered device)
 */
export async function getEvidenceHeaders(
  action: 'vdo_otp' | 'redeem' | 'device_bind' | 'financial',
  requestHash: string,
  fingerprint: string
): Promise<EvidenceHeaders | null> {
  const mod = getDeviceKeyModule();
  if (!mod || !fingerprint || !/^[0-9a-f]{64}$/.test(requestHash)) return null;

  // Single-flight: concurrent protected calls share one evidence round-trip.
  if (_inflight) return _inflight;
  _inflight = (async (): Promise<EvidenceHeaders | null> => {
    try {
      // 1. Server-issued challenge (client NEVER chooses it). Bound to this
      //    user + device + session + action + request-hash server-side.
      const { data: ch, error: chErr } = await backendClient.functions.invoke(
        'security-evidence-challenge',
        { body: { action, device_fingerprint: fingerprint, request_hash: requestHash } }
      );
      if (chErr || !ch?.challenge) return null;

      // 2. Collect fresh sensor evidence (single batched native call).
      const flags = await collectEvidenceFlags();

      // 3. Canonical payload — exactly what both signatures cover.
      const keyId = await mod.getDeviceKeyId();
      const payload = {
        action,
        challenge: String(ch.challenge),
        counter: nextCounter(),
        device_fingerprint: fingerprint,
        evidence: flags,
        key_id: String(keyId),
        request_hash: requestHash,
        integrity: await buildIntegrityEvidence(),
        vpn_state: await buildVpnState(),
        config_version: await getConfigVersion(),
        schema_version: 2,
        timestamp: Date.now(),
      };
      const canonical = canonicalize(payload);

      // 4. Keystore signature over the canonical bytes (private key never leaves TEE).
      const payloadB64 = encodeUtf8ToBase64(canonical);
      const signature = await mod.signDevicePayload(payloadB64);
      if (!signature) return null;

      // 5. Backend verifies EVERYTHING and stores the assurance decision.
      const { data: verdict, error: vErr } = await backendClient.functions.invoke(
        'security-evidence-verify',
        { body: { payload, signature } }
      );
      if (vErr || !verdict?.evidence_id || verdict.passed !== true) return null;

      return {
        'X-Security-Evidence': String(verdict.evidence_id),
        // The signature accompanies the protected request so the backend can
        // additionally tie the HTTP call to the signed evidence artifact.
        'X-Security-Signature': signature,
      };
    } catch {
      return null;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/** Lightweight sensor snapshot for the evidence bundle (all best-effort). */
async function collectEvidenceFlags(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  try {
    const { getNativeSecurityFlags } = await import('@/lib/nativeSecurity');
    const flags = await getNativeSecurityFlags();
    out.vpn = flags.vpnDetected === true;
    out.proxy = flags.proxyDetected === true;
    out.root = flags.rootDetected === true;
    out.magisk = flags.magiskDetected === true;
    out.frida = flags.fridaDetected === true;
    out.xposed = flags.xposedDetected === true;
    out.emulator = flags.emulatorDetected === true;
    out.mock_location = flags.mockLocationDetected === true;
    out.developer_options = flags.developerOptionsEnabled === true;
    out.adb = flags.adbEnabled === true;
    out.debugger = flags.debuggerAttached === true;
    out.test_only = flags.testOnlyBuild === true;
    out.tampered = flags.tampered === true;
    out.overlay = flags.overlayDetected === true;
    out.screen_recording = flags.screenBeingRecorded === true;
    out.signature_valid = flags.signatureValid === true;
    out.signature_mismatch = flags.signatureValid === false;
    const wireless = getDeviceKeyModule();
    if (wireless) {
      try { out.wireless_debugging = (await wireless.isWirelessDebuggingEnabled()) === true; } catch { /* absent */ }
    }
  } catch {
    // Sensor failure → empty flags; the server treats unknown as not-observed.
  }
  return out;
}

/** UTF-8 → base64 (no wrap), matching the native module's decoder. */
function encodeUtf8ToBase64(text: string): string {
  const bytes: number[] = [];
  // eslint-disable-next-line no-control-regex
  const normalized = text.replace(/[\uD800-\uDFFF]/g, '?'); // lone surrogates can't encode
  for (const ch of normalized) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Public helper for screens: wireless-debugging state (distinct from USB ADB). */
export async function isWirelessDebuggingEnabled(): Promise<boolean | null> {
  const mod = getDeviceKeyModule();
  if (!mod) return null;
  try {
    return (await mod.isWirelessDebuggingEnabled()) === true;
  } catch {
    return null;
  }
}

// ── One-call helper for protected API flows ───────────────────────────────────

let _bootstrapDone = false;

/** Test hook. */
export function resetDeviceKeyBootstrap(): void {
  _bootstrapDone = false;
}

/**
 * Build ALL security headers for one protected call:
 *   - X-Integrity-Hash (Google-verified APK layer, when available)
 *   - X-Security-Evidence + X-Security-Signature (Keystore device-key layer)
 *
 * `body` MUST be the exact object handed to the API call — its canonical
 * SHA-256 is the request-hash the challenge is bound to. Every step is
 * best-effort: absent headers mean the SERVER policy decides, never us.
 */
export async function buildProtectedCallHeaders(
  action: 'vdo_otp' | 'redeem' | 'device_bind' | 'financial',
  body: Record<string, unknown>,
  fingerprint?: string
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};

  // Layer 1 — APK genuineness (existing Google-verified flow).
  try {
    const integrityHash = await getIntegrityHash(action);
    if (integrityHash) headers['X-Integrity-Hash'] = integrityHash;
  } catch { /* server decides per its tier */ }

  // Layer 2 — device-bound signed evidence (this module).
  const fp = fingerprint ?? (await getStoredDeviceFingerprint().catch(() => null)) ?? '';
  if (!fp) return headers;
  if (!_bootstrapDone) {
    _bootstrapDone = true; // one attempt per app run; failures fail open
    await ensureDeviceKeyRegistered(fp);
  }
  try {
    const requestHash = await requestHashForBody(body);
    const evidence = await getEvidenceHeaders(action, requestHash, fp);
    if (evidence) Object.assign(headers, evidence);
  } catch { /* server decides per its tier */ }

  return headers;
}
