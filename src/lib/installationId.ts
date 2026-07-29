/**
 * installationId.ts
 * Generates and persists a per-installation UUID, and stores the device
 * fingerprint computed at registration time so ctx.tsx can retrieve the
 * exact same value without re-computing (Constants.sessionId changes per-launch,
 * so re-computing always produces a different fingerprint).
 *
 * Persistence contract:
 *   - Survives: app restart, device reboot
 *   - Changes:  complete uninstall + reinstall, factory reset
 *
 * Storage:
 *   - iOS/Android: expo-secure-store (Keychain / Keystore)
 *   - Web:         localStorage (fallback)
 */

import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

const STORAGE_KEY = 'med_academy_installation_id';
const FINGERPRINT_KEY = 'med_academy_device_fp';

function generateId(): string {
  // Use expo-crypto for a proper UUID v4
  return Crypto.randomUUID();
}

export async function getInstallationId(): Promise<string> {
  try {
    if (process.env.EXPO_OS === 'web') {
      // Web fallback — localStorage
      let id = localStorage.getItem(STORAGE_KEY);
      if (!id) {
        id = generateId();
        localStorage.setItem(STORAGE_KEY, id);
      }
      return id;
    }

    // Native: SecureStore (Keychain on iOS, Keystore on Android)
    let id = await SecureStore.getItemAsync(STORAGE_KEY);
    if (!id) {
      id = generateId();
      // AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: installation ID must survive device
      // reboot (background access needed for violation reporting before first unlock),
      // but must NOT migrate to another device (ID is device-specific).
      await SecureStore.setItemAsync(STORAGE_KEY, id, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
        keychainService: 'com.medacademy.security',
      });
    }
    return id;
  } catch (err) {
    // Last-resort: generate ephemeral ID (won't persist but won't crash)
    if (__DEV__) console.warn('[InstallationId] storage error, using ephemeral ID:', err);
    return generateId();
  }
}

/** Clear installation ID (called on explicit app wipe / user request). */
export async function clearInstallationId(): Promise<void> {
  try {
    if (process.env.EXPO_OS === 'web') {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      await SecureStore.deleteItemAsync(STORAGE_KEY);
    }
  } catch (_) {}
}

/**
 * Persist the device fingerprint that was sent to the server at registration.
 * Must be called immediately after registerDevice() succeeds so ctx.tsx can
 * retrieve the exact same value on subsequent launches — re-computing it
 * produces a different string because Constants.sessionId changes per launch.
 */
export async function storeDeviceFingerprint(fp: string): Promise<void> {
  try {
    if (process.env.EXPO_OS === 'web') {
      localStorage.setItem(FINGERPRINT_KEY, fp);
    } else {
      await SecureStore.setItemAsync(FINGERPRINT_KEY, fp, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
        keychainService: 'com.medacademy.security',
      });
    }
  } catch (_) {}
}

/**
 * Retrieve the fingerprint stored at registration time.
 * Returns null if the device has never registered (e.g. fresh install before
 * first login), in which case check_authorization skips the per-device check
 * and relies solely on the security_version comparison.
 */
export async function getStoredDeviceFingerprint(): Promise<string | null> {
  try {
    if (process.env.EXPO_OS === 'web') {
      return localStorage.getItem(FINGERPRINT_KEY);
    }
    return await SecureStore.getItemAsync(FINGERPRINT_KEY);
  } catch (_) {
    return null;
  }
}

/** Clear fingerprint on explicit logout / app wipe. */
export async function clearDeviceFingerprint(): Promise<void> {
  try {
    if (process.env.EXPO_OS === 'web') {
      localStorage.removeItem(FINGERPRINT_KEY);
    } else {
      await SecureStore.deleteItemAsync(FINGERPRINT_KEY);
    }
  } catch (_) {}
}
