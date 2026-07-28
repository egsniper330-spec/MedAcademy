/**
 * pushTokenService.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * FCM device token lifecycle for locally-built Android Studio / Xcode apps.
 *
 * BUILD CONTEXT — why this does NOT use getExpoPushTokenAsync:
 *
 *   getExpoPushTokenAsync() is an Expo-hosted proxy service:
 *     Device FCM token → expo.host/--/api/v2/push/getExpoPushToken → ExponentPushToken[…]
 *
 *   That exchange requires:
 *     1. An EAS projectId — used by Expo's servers to look up your FCM credentials
 *     2. Your FCM server key registered with Expo's push service
 *
 *   This app is built locally with Android Studio (bare workflow).
 *   There is no EAS projectId, no eas.json, and no FCM key uploaded to Expo.
 *   Calling getExpoPushTokenAsync() would throw ERR_NOTIFICATIONS_NO_EXPERIENCE_ID
 *   immediately — it is hardcoded to throw when projectId is absent.
 *
 * CORRECT APPROACH for bare workflow / local builds:
 *
 *   Use getDevicePushTokenAsync() directly.
 *   This calls the native Firebase SDK on Android (FCM registration token)
 *   and APNs on iOS — no Expo proxy, no projectId, no EAS required.
 *   The raw FCM token is stored in devices.push_token.
 *   Your backend (Edge Function or own server) sends notifications directly
 *   via FCM HTTP API / APNs using that token.
 *
 *   Token format stored:
 *     Android: raw FCM registration token (long alphanumeric string)
 *     iOS:     APNs device token (hex string)
 *     Web:     no-op (not applicable)
 *
 * PREREQUISITE — google-services.json (Android):
 *   expo-notifications depends on firebase-messaging:25.0.1 (verified in
 *   node_modules/expo-notifications/android/build.gradle). FCM registration
 *   requires google-services.json in android/app/ AND the google-services
 *   Gradle plugin applied. Without it getDevicePushTokenAsync() will throw.
 *   Steps:
 *     1. Create a Firebase project at console.firebase.google.com
 *     2. Add Android app with package: com.medacademy.app
 *     3. Download google-services.json → place in android/app/
 *     4. In android/build.gradle → dependencies → add:
 *          classpath 'com.google.gms:google-services:4.4.2'
 *     5. In android/app/build.gradle → bottom → add:
 *          apply plugin: 'com.google.gms.google-services'
 *   (iOS equivalent: download GoogleService-Info.plist → ios/<AppName>/)
 *
 * Token storage strategy:
 *   devices.push_token (server)   — authoritative for delivery
 *   AsyncStorage LAST_TOKEN_KEY   — cheap change-detection, survives restart
 *
 * Called from:
 *   sign-in.tsx   — after successful device registration (fire-and-forget)
 *   DrawerNav.tsx — on sign-out (clear token + cancel retry)
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import * as Network from 'expo-network';
import { Platform } from 'react-native';
import { supabase } from '@/client/supabase';

// ─── Constants ────────────────────────────────────────────────────────────────

const LAST_TOKEN_KEY = 'medacademy:device_push_token';
const RETRY_DELAY_MS = 10_000;
const MAX_RETRIES    = 3;

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function getCachedToken(): Promise<string | null> {
  try { return await AsyncStorage.getItem(LAST_TOKEN_KEY); }
  catch { return null; }
}

async function cacheToken(token: string): Promise<void> {
  try { await AsyncStorage.setItem(LAST_TOKEN_KEY, token); }
  catch { /* non-fatal */ }
}

async function clearCachedToken(): Promise<void> {
  try { await AsyncStorage.removeItem(LAST_TOKEN_KEY); }
  catch { /* non-fatal */ }
}

/**
 * Writes the native FCM/APNs token to devices.push_token via device-binding EF.
 * The EF's update_push_token action matches on installation_id so a single
 * user with multiple devices only updates the correct device row.
 */
async function persistTokenToServer(
  token: string,
  installationId: string,
): Promise<boolean> {
  try {
    const { error } = await supabase.functions.invoke('device-binding', {
      body: { action: 'update_push_token', push_token: token, installation_id: installationId },
    });
    if (error) {
      if (__DEV__) console.warn('[pushTokenService] server persist failed:', error.message);
      return false;
    }
    return true;
  } catch (e) {
    if (__DEV__) console.warn('[pushTokenService] server persist exception:', e);
    return false;
  }
}

async function clearTokenOnServer(installationId: string): Promise<void> {
  try {
    await supabase.functions.invoke('device-binding', {
      body: { action: 'update_push_token', push_token: null, installation_id: installationId },
    });
  } catch { /* non-fatal */ }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Register or refresh the native FCM/APNs push token for this device.
 *
 * Uses getDevicePushTokenAsync() — the bare-workflow API that returns the raw
 * FCM registration token (Android) or APNs token (iOS) directly from the
 * native SDK. No EAS projectId, no Expo proxy service, no internet call to
 * Expo's servers required.
 *
 * Lifecycle:
 *   • First call:   fetches token, writes to server, caches locally.
 *   • Subsequent:   compares with cache; skips server write if unchanged.
 *   • Reinstall:    token changes → detected by cache diff → server updated.
 *   • Offline:      schedules exponential-backoff retry up to MAX_RETRIES.
 *   • Never throws: all errors caught; login flow is never blocked.
 *
 * @param installationId  Stable device ID from getInstallationId()
 */
export async function registerPushToken(installationId: string): Promise<void> {
  if (Platform.OS === 'web') return;

  // ── Step 1: Notification permission guard ─────────────────────────────────
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') {
    if (__DEV__) console.log('[pushTokenService] Permission not granted — skipping');
    return;
  }

  // ── Step 2: Get raw FCM / APNs token (no projectId needed) ────────────────
  let deviceToken: string;
  try {
    const result = await Notifications.getDevicePushTokenAsync();
    // result.data is the raw FCM registration token string on Android
    deviceToken = typeof result.data === 'string'
      ? result.data
      : JSON.stringify(result.data);
  } catch (e) {
    if (__DEV__) {
      console.warn(
        '[pushTokenService] getDevicePushTokenAsync failed:', e,
        '\n  → Ensure google-services.json is in android/app/ and the',
        'google-services Gradle plugin is applied (see file header for steps).'
      );
    }
    scheduleRetry(installationId);
    return;
  }

  // ── Step 3: Change detection ───────────────────────────────────────────────
  const cached = await getCachedToken();
  if (cached === deviceToken) {
    if (__DEV__) console.log('[pushTokenService] Token unchanged — no server write needed');
    return;
  }
  if (__DEV__) {
    console.log(
      '[pushTokenService] Token',
      cached ? 'changed → updating' : 'new → registering',
      deviceToken.slice(0, 30) + '…'
    );
  }

  // ── Step 4: Network check ─────────────────────────────────────────────────
  const net = await Network.getNetworkStateAsync();
  if (!net.isConnected || !net.isInternetReachable) {
    if (__DEV__) console.log('[pushTokenService] Offline — scheduling retry');
    scheduleRetry(installationId);
    return;
  }

  // ── Step 5: Persist to server ─────────────────────────────────────────────
  const ok = await persistTokenToServer(deviceToken, installationId);
  if (ok) {
    await cacheToken(deviceToken);
    if (__DEV__) console.log('[pushTokenService] Token registered successfully');
  } else {
    scheduleRetry(installationId);
  }
}

/**
 * Remove the push token for this device from the server.
 * Call before supabase.auth.signOut() while the session is still valid.
 *
 * @param installationId  Stable device ID from getInstallationId()
 */
export async function unregisterPushToken(installationId: string): Promise<void> {
  if (Platform.OS === 'web') return;
  await clearTokenOnServer(installationId);
  await clearCachedToken();
  if (__DEV__) console.log('[pushTokenService] Token unregistered');
}

// ─── Retry logic ──────────────────────────────────────────────────────────────

let _retryCount   = 0;
let _retryTimeout: ReturnType<typeof setTimeout> | null = null;

function scheduleRetry(installationId: string): void {
  if (_retryCount >= MAX_RETRIES) {
    if (__DEV__) console.log('[pushTokenService] Max retries reached — giving up');
    return;
  }
  if (_retryTimeout) return; // already pending

  const delay = RETRY_DELAY_MS * Math.pow(2, _retryCount);
  _retryCount++;
  if (__DEV__) console.log(`[pushTokenService] Retry ${_retryCount}/${MAX_RETRIES} in ${delay}ms`);

  _retryTimeout = setTimeout(async () => {
    _retryTimeout = null;
    await registerPushToken(installationId);
  }, delay);
}

/** Cancel any pending retry. Call on logout. */
export function cancelPushTokenRetry(): void {
  if (_retryTimeout) { clearTimeout(_retryTimeout); _retryTimeout = null; }
  _retryCount = 0;
}
