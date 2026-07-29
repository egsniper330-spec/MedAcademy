/**
 * useForceUpdate.ts
 *
 * Determines whether the installed app version requires a forced update or
 * can show a soft "newer version available" banner.
 *
 * ─── Semver comparison ────────────────────────────────────────────────────────
 *  Uses numeric segment comparison so:
 *    1.9.9  < 1.10.0  ✓
 *    2.0.0  > 1.99.0  ✓
 *  Plain string comparison would give the wrong answer for these cases.
 *
 * ─── Force update logic ───────────────────────────────────────────────────────
 *  isForceUpdateRequired = installed < minimum_supported_version
 *  This is independent of the `force_update` DB flag. The flag is an additional
 *  admin override that can hard-block even if versions match (emergency lockout).
 *
 * ─── Soft update logic ────────────────────────────────────────────────────────
 *  isSoftUpdateAvailable = installed >= minimum_supported_version
 *                        AND installed < latest_version
 *  Soft updates are purely informational — the app is fully usable.
 *
 * ─── AppState refresh ─────────────────────────────────────────────────────────
 *  When the app returns to the foreground, the hook re-evaluates based on the
 *  latest in-memory config (already refreshed by SecurityContext's AppState
 *  listener). No additional network call is made here.
 *
 * ─── Offline behavior ─────────────────────────────────────────────────────────
 *  Uses getSecurityConfig() which reads from in-memory → SecureStore cache →
 *  SAFE_DEFAULTS. SAFE_DEFAULTS has force_update=false and minimum=1.0.0,
 *  so the app is NEVER hard-blocked by a missing config (fail-open for updates,
 *  fail-secure for security detectors).
 */

import { useState, useEffect, useCallback } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import Constants from 'expo-constants';
import { getSecurityConfig } from '@/lib/securityConfigService';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ForceUpdateState {
  /** True when installed version is below minimum_supported_version. App must block. */
  isForceUpdateRequired: boolean;
  /**
   * True when installed >= minimum_supported_version but < latest_version.
   * App is usable; show a dismissible banner.
   */
  isSoftUpdateAvailable: boolean;
  /** The currently installed version string (from app.json → expo.version). */
  installedVersion: string;
  /** The minimum version floor from the remote config. */
  minimumVersion: string;
  /** The latest available version from the remote config. */
  latestVersion: string;
  /** Admin-controlled update screen title. */
  updateTitle: string;
  /** Admin-controlled update screen body copy. */
  updateMessage: string;
  /** Opens the correct app store URL for the current platform. */
  openStore: () => void;
}

// ─── Semver helpers ───────────────────────────────────────────────────────────

/**
 * Parses a semver-like string into numeric [major, minor, patch] triple.
 * Extra pre-release/build metadata after patch is ignored.
 * Returns [0,0,0] for malformed input (fail-safe).
 */
function parseSemver(ver: string): [number, number, number] {
  const m = ver.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/**
 * Compares two semver strings numerically.
 * Returns:
 *   -1 if a < b
 *    0 if a == b
 *   +1 if a > b
 *
 * Examples:
 *   compareSemver('1.9.9',  '1.10.0') → -1   ✓ (not string comparison!)
 *   compareSemver('2.0.0',  '1.99.0') → +1   ✓
 *   compareSemver('1.2.3',  '1.2.3')  →  0
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const [aMaj, aMin, aPat] = parseSemver(a);
  const [bMaj, bMin, bPat] = parseSemver(b);

  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1;
  if (aMin !== bMin) return aMin < bMin ? -1 : 1;
  if (aPat !== bPat) return aPat < bPat ? -1 : 1;
  return 0;
}

/** True when a is strictly less than b. */
export function semverLt(a: string, b: string): boolean {
  return compareSemver(a, b) === -1;
}

/** True when a is greater than or equal to b. */
export function semverGte(a: string, b: string): boolean {
  return compareSemver(a, b) >= 0;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useForceUpdate(): ForceUpdateState {
  const installedVersion =
    (Constants.expoConfig?.version ?? '1.0.0').trim();

  const computeState = useCallback((): ForceUpdateState => {
    const cfg = getSecurityConfig();

    const minimumVersion = cfg.minimum_supported_version || cfg.minimum_app_version || '1.0.0';
    const latestVersion  = cfg.latest_version || minimumVersion;
    const updateTitle    = cfg.update_title;
    const updateMessage  = cfg.update_message;

    // Hard block: installed is strictly below the minimum floor
    // OR the admin has set force_update=true as an emergency override.
    const belowMinimum      = semverLt(installedVersion, minimumVersion);
    const isForceUpdateRequired = belowMinimum || cfg.force_update;

    // Soft update: installed is acceptable but not the latest
    const isSoftUpdateAvailable =
      !isForceUpdateRequired && semverLt(installedVersion, latestVersion);

    const openStore = () => {
      const url =
        process.env.EXPO_OS === 'ios'
          ? cfg.ios_store_url
          : cfg.android_store_url;
      if (url && url.length > 0) {
        Linking.openURL(url).catch(() => {});
      }
    };

    return {
      isForceUpdateRequired,
      isSoftUpdateAvailable,
      installedVersion,
      minimumVersion,
      latestVersion,
      updateTitle,
      updateMessage,
      openStore,
    };
  }, [installedVersion]);

  const [state, setState] = useState<ForceUpdateState>(computeState);

  // Re-evaluate whenever the app returns to the foreground.
  // SecurityContext has already refreshed the in-memory config via its own
  // AppState listener, so getSecurityConfig() returns the latest values here.
  useEffect(() => {
    // Initial evaluation
    setState(computeState());

    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        // Small tick to let SecurityContext's listener run first and update the cache
        setTimeout(() => setState(computeState()), 200);
      }
    });
    return () => sub.remove();
  }, [computeState]);

  return state;
}
