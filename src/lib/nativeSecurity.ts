/**
 * nativeSecurity.ts
 *
 * JS bridge to the native SecurityModule (Android) AND IOSSecurityModule (iOS).
 * Registered by withSecurityModule config plugin; available in release builds.
 *
 * Android module: SecurityModule (Kotlin)
 *   Phase 1: developer options, ADB, debugger, screen recording
 *   Phase 2: Frida, Xposed/LSPosed, Magisk/Zygisk, overlay, signature,
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
  overlayDetected: boolean;
  signatureValid:  boolean;
  tampered:        boolean;
  // Phase 3 — new native checks (Android; iOS maps jailbreak/vpn to same keys)
  vpnDetected:          boolean;
  rootDetected:         boolean;
  emulatorDetected:     boolean;
  mockLocationDetected: boolean;
  // iOS-only extras (Android module returns false for these)
  jailbreakDetected?:      boolean;
  proxyDetected?:          boolean;
  dylibInjectionDetected?: boolean;
  bundleTampered?:         boolean;
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
  overlayDetected:         false,
  signatureValid:          true,   // assume valid on non-Android (safe default)
  tampered:                false,
  // Phase 3
  vpnDetected:          false,
  rootDetected:         false,
  emulatorDetected:     false,
  mockLocationDetected: false,
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
  return NativeModules.IOSSecurityModule ?? null;
}

// ─── Batch API (preferred — single bridge crossing) ───────────────────────────

/**
 * Returns ALL security flags in one native call.
 * Falls back to SAFE_FLAGS if the module is unavailable.
 * Works on both Android (SecurityModule) and iOS (IOSSecurityModule).
 */
export async function getNativeSecurityFlags(): Promise<NativeSecurityFlags> {
  if (Platform.OS === 'android') {
    const mod = getModule();
    console.log('[NativeSecurity][Stage-2] getModule() =>', mod ? '✓ module found' : '✗ NULL — SecurityModule not compiled/registered');
    if (!mod) {
      console.warn('[NativeSecurity][Stage-2] ❌ Module is null — returning SAFE_FLAGS. All detectors will report false. Check native compile errors.');
      return SAFE_FLAGS;
    }
    try {
      console.log('[NativeSecurity][Stage-2] Calling mod.getSecurityFlags()…');
      const flags = await mod.getSecurityFlags() as NativeSecurityFlags;
      console.log('[NativeSecurity][Stage-5] JS received native response:', JSON.stringify(flags));
      const merged = { ...SAFE_FLAGS, ...flags };
      console.log('[NativeSecurity][Stage-5] After SAFE_FLAGS merge (should be identical):', JSON.stringify(merged));
      return merged;
    } catch (e) {
      console.error('[NativeSecurity][Stage-2] ❌ getSecurityFlags() threw:', e, '— returning SAFE_FLAGS');
      return SAFE_FLAGS;
    }
  }

  if (Platform.OS === 'ios') {
    const mod = getIOSModule();
    console.log('[NativeSecurity][Stage-2] getIOSModule() =>', mod ? '✓ iOS module found' : '✗ NULL — IOSSecurityModule not registered');
    if (!mod) {
      console.warn('[NativeSecurity][Stage-2] ❌ iOS module null — returning SAFE_FLAGS');
      return SAFE_FLAGS;
    }
    try {
      const flags = await mod.getSecurityFlags() as NativeSecurityFlags;
      console.log('[NativeSecurity][Stage-5] iOS JS received native response:', JSON.stringify(flags));
      const merged = { ...SAFE_FLAGS, ...flags };
      return merged;
    } catch (e) {
      console.error('[NativeSecurity][Stage-2] ❌ iOS getSecurityFlags() threw:', e, '— returning SAFE_FLAGS');
      return SAFE_FLAGS;
    }
  }

  console.log('[NativeSecurity][Stage-2] Platform is web — returning SAFE_FLAGS');
  return SAFE_FLAGS;
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

export async function isNativeOverlayDetected(): Promise<boolean> {
  const mod = getModule();  // Android-only — SYSTEM_ALERT_WINDOW is Android-only
  if (!mod) return false;
  try { return await mod.isOverlayDetected() as boolean; } catch { return false; }
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

/** Android VPN detection via ConnectivityManager TRANSPORT_VPN + NetworkInterface tun/ppp scan.
 *  On iOS, VPN is detected via IOSSecurityModule utun/ipsec interface scan. */
export async function isNativeVPNDetected(): Promise<boolean> {
  if (Platform.OS === 'android') {
    const mod = getModule();
    if (!mod) return false;
    try { return await mod.isVpnActive() as boolean; } catch { return false; }
  }
  if (Platform.OS === 'ios') {
    const mod = getIOSModule();
    if (!mod) return false;
    try { return await mod.isVPNDetected() as boolean; } catch { return false; }
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
