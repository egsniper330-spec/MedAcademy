/**
 * Build Verification Marker
 * ─────────────────────────────────────────────────────────────────────────────
 * All five values are derived at runtime from app.json (injected by Expo's
 * Constants module) so they always reflect the current build — even when the
 * The CI platform sync-writes a new version string into app.json before packaging.
 *
 * DO NOT hardcode version strings here — the platform updates app.json
 * version automatically on every sync (1.0.714, 1.0.715, …) and a hardcoded
 * value will always be stale, causing the packaging probe to fail.
 *
 * Source of truth for each export:
 *   BUILD_VERSION_NAME  ← expo.version               (e.g. "1.0.821")
 *   BUILD_VERSION_CODE  ← expo.android.versionCode   (e.g. 212)
 *   BUILD_APP_NAME      ← expo.name                  (e.g. "MedAcademy")
 *   BUILD_ID            ← expo.ios.buildNumber        (e.g. "212")
 *   BUILD_TIMESTAMP     ← expo.extra.buildTimestamp   (ISO string set by CI)
 *                         Falls back to expo.version so it is never empty.
 */
import Constants from 'expo-constants';

const expoConfig = Constants.expoConfig ?? Constants.manifest ?? {};
type AnyConfig = Record<string, unknown>;

export const BUILD_VERSION_NAME: string =
  (expoConfig as AnyConfig & { version?: string }).version ?? '0.0.0';

export const BUILD_VERSION_CODE: number =
  ((expoConfig as AnyConfig).android as { versionCode?: number } | undefined)
    ?.versionCode ?? 0;

export const BUILD_APP_NAME: string =
  (expoConfig as AnyConfig & { name?: string }).name ?? 'MedAcademy';

/** iOS build number string (e.g. "212"), from expo.ios.buildNumber in app.json. */
export const BUILD_ID: string =
  ((expoConfig as AnyConfig).ios as { buildNumber?: string } | undefined)
    ?.buildNumber ?? BUILD_VERSION_NAME;

/**
 * ISO-8601 timestamp set by CI via expo.extra.buildTimestamp in app.json.
 * Falls back to the version string so the probe always has a non-empty value.
 */
export const BUILD_TIMESTAMP: string =
  ((expoConfig as AnyConfig).extra as { buildTimestamp?: string } | undefined)
    ?.buildTimestamp ?? BUILD_VERSION_NAME;
