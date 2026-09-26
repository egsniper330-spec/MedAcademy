/**
 * appIdentity.ts — THE authoritative installed-app identity source.
 *
 * Reads the real NATIVE application version at runtime:
 *   • Application.nativeApplicationVersion — user-facing version
 *     (Android versionName / iOS CFBundleShortVersionString)
 *   • Application.nativeBuildVersion — developer-facing build
 *     (Android versionCode / iOS CFBundleVersion)
 *
 * Per Expo's docs (build-reference/app-versions) these are the native build
 * properties — they are what "what build is actually installed" means, and
 * they are what the backend's versionCode floor compares against.
 *
 * Constants.expoConfig is the JS build-time config and is used ONLY as a
 * fallback when the native module cannot report (some web/dev runtimes) —
 * never as the primary source, and never for package.json/app.json alone.
 *
 * Web returns 0 codes / '' name: the platform is excluded from native
 * enforcement (no headers → the server treats it as version-unknown), and
 * evaluateUpdateVerdict stands down on unknown identity.
 */

import Constants from 'expo-constants';
import * as Application from 'expo-application';
import { Platform as RNPlatform } from 'react-native';

export interface AppIdentity {
  /** User-facing version: Android versionName / iOS CFBundleShortVersionString. */
  versionName: string;
  /** Developer-facing build: Android versionCode / iOS CFBundleVersion. */
  buildNumber: number;
}

function positiveInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Resolve the installed identity once per process.
 *
 * Order per platform:
 *  1. Application.nativeBuildVersion / nativeApplicationVersion (the real
 *     native build property — authoritative on Android AND iOS).
 *  2. Constants.expoConfig fallback (build-time JS config; identical values
 *     when prebuild injected them into the native project).
 *  3. Web → 0 / '' (never falsely blocks or un-blocks).
 */
function resolveIdentity(): AppIdentity {
  if (RNPlatform.OS === 'web') {
    return { versionName: Constants.expoConfig?.version ?? '', buildNumber: 0 };
  }

  const nativeBuild = positiveInt(
    (Application as unknown as { nativeBuildVersion?: string | number | null }).nativeBuildVersion
  );
  const nativeName = (Application as unknown as { nativeApplicationVersion?: string | null })
    .nativeApplicationVersion;

  if (nativeBuild > 0) {
    return {
      versionName: (nativeName ?? '').trim() ||
        (Constants.expoConfig?.version ?? '').trim(),
      buildNumber: nativeBuild,
    };
  }

  // Native module unavailable (e.g. some dev runtimes) → build-time fallback.
  const fallbackCode = RNPlatform.OS === 'android'
    ? positiveInt(Constants.expoConfig?.android?.versionCode)
    : positiveInt(Constants.expoConfig?.ios?.buildNumber);
  return {
    versionName: (Constants.expoConfig?.version ?? '').trim(),
    buildNumber: fallbackCode,
  };
}

const IDENTITY: AppIdentity = resolveIdentity();

export function getAppIdentity(): AppIdentity {
  return IDENTITY;
}

/** Android versionCode / iOS CFBundleVersion as an integer (0 = unknown). */
export function getInstalledBuildNumber(): number {
  return IDENTITY.buildNumber;
}

/** Android versionName / iOS CFBundleShortVersionString ('' = unknown). */
export function getInstalledVersionName(): string {
  return IDENTITY.versionName;
}

/** 'android' | 'ios' | 'web' — matches the backend AppUpdateService platforms. */
export function getAppPlatform(): 'android' | 'ios' | 'web' {
  if (RNPlatform.OS === 'web') return 'web';
  return RNPlatform.OS === 'android' ? 'android' : 'ios';
}
