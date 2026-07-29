/**
 * ─────────────────────────────────────────────────────────────────────────────
 * src/config/security.ts  —  STATIC security configuration only
 *
 * This file contains ONLY values that:
 *   (a) Must be baked into the client bundle at build time, AND
 *   (b) Cannot change without publishing a new app version.
 *
 * ─── What belongs here ───────────────────────────────────────────────────────
 *   ✅ Android package name (required by native Play Integrity SDK before auth)
 *   ✅ Google Cloud project number (scopes the PI token request at OS level)
 *   ✅ Local fallback defaults for the security policy engine
 *
 * ─── What does NOT belong here ───────────────────────────────────────────────
 *   ❌ play_integrity_enabled flag   → lives in security_config DB table
 *   ❌ expected_cert_sha256           → lives in security_config DB table
 *   ❌ minimum_app_version            → lives in security_config DB table
 *   ❌ force_update                   → lives in security_config DB table
 *
 * Dynamic values are fetched by src/lib/securityConfigService.ts after login,
 * cached in SecureStore, and re-used offline. Changing them in the DB takes
 * effect on all clients within the 15-minute refresh window — no app release.
 *
 * See docs/PLAY_INTEGRITY_SETUP.md for full setup instructions.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── Helper ───────────────────────────────────────────────────────────────────

/** Read an EXPO_PUBLIC_* env var. Returns '' if unset. Logs a dev warning when warnIfEmpty=true. */
function env(key: string, warnIfEmpty = false): string {
  const val = process.env[key] ?? '';
  if (__DEV__ && warnIfEmpty && !val) {
    console.warn(
      `[config/security] ${key} is not set.\n` +
      `  → The corresponding feature is disabled until configured.\n` +
      `  → See docs/PLAY_INTEGRITY_SETUP.md for setup instructions.`
    );
  }
  return val;
}

// ─── Static configuration ─────────────────────────────────────────────────────

export const STATIC_SECURITY = {

  // ── Play Integrity API — static client-side only ────────────────────────────
  //
  // These two values are passed to the Android native IntegrityManagerFactory
  // before any network call. They CANNOT be dynamic because they are consumed
  // by the OS-level API before the app has a session to fetch remote config.
  //
  playIntegrity: {

    /**
     * Your Google Cloud project number (NOT the project ID string).
     * Found at: Google Cloud Console → Home → Project info card → "Project number"
     * Example: "123456789012"
     *
     * Safe to embed in the client bundle (not a secret).
     * Set as EXPO_PUBLIC_PLAY_INTEGRITY_PROJECT_NUMBER in .env.production.
     */
    projectNumber: env('EXPO_PUBLIC_PLAY_INTEGRITY_PROJECT_NUMBER', true),

    /**
     * Your Android app's package name as registered in Play Console.
     * Example: "com.medacademy.app"
     * Must match expo.android.package in app.json exactly.
     *
     * This is a static value: changing the package name requires a new app.
     * Set as EXPO_PUBLIC_ANDROID_PACKAGE_NAME in .env.production.
     * Mirror this value in the Supabase secret ANDROID_PACKAGE_NAME.
     */
    androidPackageName: env('EXPO_PUBLIC_ANDROID_PACKAGE_NAME', true),
  },

  // ── Signing certificate — static BOOTSTRAP fallback only ───────────────────
  //
  // This is used ONLY as a last-resort fallback before the first successful
  // dynamic config fetch (e.g. very first app launch with no cache yet).
  //
  // The authoritative value is stored in the security_config DB table and is
  // served by the get-security-config Edge Function. Changing it there takes
  // effect on all clients within 15 minutes — no app release required.
  //
  signing: {

    /**
     * Static bootstrap fallback for the expected cert SHA-256 fingerprint.
     * 64 uppercase hex characters, no colons.
     *
     * Prefer updating the value in the DB (security_config.expected_cert_sha256).
     * Only set this env var as a compile-time safety net.
     *
     * Set as EXPO_PUBLIC_EXPECTED_CERT_SHA256 in .env.production.
     * If left empty: signature check is skipped until the DB provides a value.
     */
    expectedSha256: env('EXPO_PUBLIC_EXPECTED_CERT_SHA256'),
  },

} as const;

// Keep the old export name as an alias so any remaining imports resolve cleanly.
// New code should import STATIC_SECURITY directly.
/** @deprecated Use STATIC_SECURITY */
export const SECURITY_CONFIG = STATIC_SECURITY;
