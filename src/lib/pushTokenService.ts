/**
 * pushTokenService.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Complete Expo Push Token lifecycle management.
 *
 * Responsibilities:
 *   • Request notification permission before attempting token fetch.
 *   • Call Notifications.getExpoPushTokenAsync() with the EAS project ID.
 *   • Store token in devices.push_token via the device-binding Edge Function.
 *   • Detect token changes (reinstall, token rotation) and update automatically.
 *   • Cache the last-registered token in AsyncStorage to detect changes cheaply.
 *   • Clear the token from the device row on logout.
 *   • Retry when the network becomes available (expo-network NetworkState change).
 *   • Never crash the login flow — all errors are caught and logged in __DEV__.
 *
 * Token storage strategy:
 *   • devices.push_token (server)   — authoritative for delivery
 *   • AsyncStorage LAST_TOKEN_KEY   — cheap change-detection, survives restart
 *
 * Called from:
 *   • sign-in.tsx    — after successful device registration
 *   • ctx.tsx        — on SIGNED_IN event (handles reinstall/token rotation)
 *   • DrawerNav.tsx  — on sign-out (clear token)
 *
 * Platform:
 *   • iOS / Android only. Web is a no-op throughout.
 *   • Expo Go in DEV: getExpoPushTokenAsync requires a real projectId; logs a
 *     warning and returns early rather than crashing the dev experience.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import * as Network from 'expo-network';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { supabase } from '@/client/supabase';

// ─── Constants ────────────────────────────────────────────────────────────────

const LAST_TOKEN_KEY   = 'medacademy:expo_push_token';
const RETRY_DELAY_MS   = 10_000;  // 10 s initial retry delay
const MAX_RETRIES      = 3;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Returns the EAS project ID from app.json / app.config.ts. */
function getProjectId(): string | null {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId ??
    null
  );
}

/** Reads the cached token from AsyncStorage. Returns null on miss/error. */
async function getCachedToken(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(LAST_TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Persists the token to AsyncStorage. Fire-and-forget; non-fatal. */
async function cacheToken(token: string): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_TOKEN_KEY, token);
  } catch { /* non-fatal */ }
}

/** Removes the cached token from AsyncStorage. */
async function clearCachedToken(): Promise<void> {
  try {
    await AsyncStorage.removeItem(LAST_TOKEN_KEY);
  } catch { /* non-fatal */ }
}

/**
 * Writes push_token to devices row via the device-binding Edge Function.
 * Uses the authenticated user's session (anon key + JWT in supabase client).
 * The EF's update_push_token action matches on installation_id so a single
 * user with multiple devices only updates the current device's row.
 */
async function persistTokenToServer(
  token: string,
  installationId: string,
): Promise<boolean> {
  try {
    const { error } = await supabase.functions.invoke('device-binding', {
      body: {
        action:           'update_push_token',
        push_token:       token,
        installation_id:  installationId,
      },
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

/**
 * Clears push_token on the server by setting it to null.
 * Called on logout so the device no longer receives notifications after sign-out.
 */
async function clearTokenOnServer(installationId: string): Promise<void> {
  try {
    await supabase.functions.invoke('device-binding', {
      body: {
        action:           'update_push_token',
        push_token:       null,
        installation_id:  installationId,
      },
    });
  } catch { /* non-fatal — device will silently reject deliveries */ }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Register or refresh the Expo Push Token for this device.
 *
 * Designed to be called after every successful login:
 *   • First call: fetches token, stores on server, caches locally.
 *   • Subsequent calls: compares with cached token; skips server write if unchanged.
 *   • Reinstall / token rotation: detects change, updates server automatically.
 *   • Network unavailable: schedules a one-shot retry after RETRY_DELAY_MS.
 *
 * @param installationId  Stable device ID from getInstallationId()
 */
export async function registerPushToken(installationId: string): Promise<void> {
  if (Platform.OS === 'web') return;

  // ── Step 1: Check notification permission ─────────────────────────────────
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') {
    if (__DEV__) console.log('[pushTokenService] Permission not granted — skipping token registration');
    return;
  }

  // ── Step 2: Get project ID ─────────────────────────────────────────────────
  const projectId = getProjectId();
  if (!projectId) {
    if (__DEV__) {
      console.warn(
        '[pushTokenService] EAS project ID not found.\n' +
        '  → Set expo.extra.eas.projectId in app.json or configure eas.json.\n' +
        '  → Push tokens will not be registered until this is configured.'
      );
    }
    return;
  }

  // ── Step 3: Fetch the Expo Push Token ─────────────────────────────────────
  let tokenData: Notifications.ExpoPushToken;
  try {
    tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
  } catch (e) {
    if (__DEV__) console.warn('[pushTokenService] getExpoPushTokenAsync failed:', e);
    // Schedule retry after RETRY_DELAY_MS if online
    scheduleRetry(installationId);
    return;
  }

  const newToken = tokenData.data; // "ExponentPushToken[xxxxxx]"

  // ── Step 4: Change detection — skip server write if token unchanged ────────
  const cachedToken = await getCachedToken();
  if (cachedToken === newToken) {
    if (__DEV__) console.log('[pushTokenService] Token unchanged — no server write needed');
    return;
  }

  if (__DEV__) {
    console.log(
      '[pushTokenService] Token',
      cachedToken ? 'changed → updating' : 'new → registering',
      newToken.slice(0, 40) + '…'
    );
  }

  // ── Step 5: Check network before server write ──────────────────────────────
  const netState = await Network.getNetworkStateAsync();
  const isOnline  = netState.isConnected && netState.isInternetReachable;
  if (!isOnline) {
    if (__DEV__) console.log('[pushTokenService] Offline — will retry when network is available');
    scheduleRetry(installationId);
    return;
  }

  // ── Step 6: Persist to server ──────────────────────────────────────────────
  const ok = await persistTokenToServer(newToken, installationId);
  if (ok) {
    await cacheToken(newToken);
    if (__DEV__) console.log('[pushTokenService] Token registered successfully');
  } else {
    scheduleRetry(installationId);
  }
}

/**
 * Remove the push token on this device from the server.
 * Call immediately before or after supabase.auth.signOut().
 *
 * @param installationId  Stable device ID from getInstallationId()
 */
export async function unregisterPushToken(installationId: string): Promise<void> {
  if (Platform.OS === 'web') return;
  // Clear server first (we still have a valid session at this point)
  await clearTokenOnServer(installationId);
  // Clear local cache regardless of server result
  await clearCachedToken();
  if (__DEV__) console.log('[pushTokenService] Token unregistered');
}

// ─── Retry logic ──────────────────────────────────────────────────────────────

let _retryCount   = 0;
let _retryTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule a retry of registerPushToken after RETRY_DELAY_MS.
 * Uses exponential back-off (×2 per attempt) up to MAX_RETRIES.
 * Cancelled automatically when a new successful registration supersedes it.
 */
function scheduleRetry(installationId: string): void {
  if (_retryCount >= MAX_RETRIES) {
    if (__DEV__) console.log('[pushTokenService] Max retries reached — giving up');
    return;
  }
  if (_retryTimeout) return; // already scheduled

  const delay = RETRY_DELAY_MS * Math.pow(2, _retryCount);
  _retryCount++;
  if (__DEV__) console.log(`[pushTokenService] Scheduling retry ${_retryCount}/${MAX_RETRIES} in ${delay}ms`);

  _retryTimeout = setTimeout(async () => {
    _retryTimeout = null;
    await registerPushToken(installationId);
  }, delay);
}

/**
 * Cancel any pending retry (call on logout or when the component unmounts).
 */
export function cancelPushTokenRetry(): void {
  if (_retryTimeout) {
    clearTimeout(_retryTimeout);
    _retryTimeout = null;
  }
  _retryCount = 0;
}
