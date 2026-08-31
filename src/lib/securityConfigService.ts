/**
 * securityConfigService.ts
 *
 * Fetches, validates, caches, and vends the dynamic security configuration.
 *
 * ─── Version-check-first strategy (bandwidth optimisation) ───────────────────
 *  Every refresh cycle calls the lightweight `get-security-version` endpoint
 *  first (~40-byte response). Only when the returned security_version differs
 *  from the cached version is the full `get-security-config` payload fetched
 *  (~600 bytes). This eliminates ~99% of full config downloads.
 *
 *  Triggers for a version check:
 *    • Right after login (via SecurityContext)
 *    • Every 15 minutes (timer in SecurityContext)
 *    • When app returns to foreground (AppState in SecurityContext)
 *
 * ─── Multi-certificate fingerprint support ───────────────────────────────────
 *  The config carries `expected_cert_sha256s: string[]` — an ordered array of
 *  trusted cert fingerprints. Signature verification passes if the runtime cert
 *  matches ANY entry. This allows seamless cert rotation: add the new cert,
 *  wait 15 min for propagation, then remove the old one — zero downtime.
 *
 * ─── Cache layers ─────────────────────────────────────────────────────────────
 *  Layer 1 (in-memory):            Zero-latency getter. Lost on process restart.
 *  Layer 2 (SecureStore/localStorage): Survives restart + offline.
 *  Layer 3 (SAFE_DEFAULTS):        First install / never authenticated.
 *
 * ─── Security rules ───────────────────────────────────────────────────────────
 *  • Every field from server validated before use; malformed → reject + keep cache.
 *  • Network failure → cache; no cache → SAFE_DEFAULTS. Never crashes.
 *  • Server cannot re-enable a detector that was already running (admin DB change only).
 */

import * as SecureStore from 'expo-secure-store';
import { backendClient } from '@/client/backendClient';
import { STATIC_SECURITY } from '@/config/security';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DynamicSecurityConfig {
  /** Whether the Play Integrity API check should run. */
  play_integrity_enabled:     boolean;
  /**
   * Trusted APK signing cert fingerprints (64 uppercase hex chars, no colons).
   * Empty array → signature check skipped. Succeeds if runtime cert matches ANY entry.
   */
  expected_cert_sha256s:      string[];
  /**
   * Hard floor: clients STRICTLY BELOW this version are force-blocked.
   * Compared using proper semver (1.9.9 < 1.10.0, not lexicographic).
   * @deprecated Use minimum_supported_version going forward.
   */
  minimum_app_version:        string;
  /**
   * Hard floor (canonical field): clients STRICTLY BELOW this version are
   * force-blocked and cannot proceed until they update.
   */
  minimum_supported_version:  string;
  /**
   * Soft ceiling: clients below this but above minimum_supported_version
   * see a dismissible "newer version available" banner.
   */
  latest_version:             string;
  /** When true AND installed < minimum_supported_version, the app is hard-blocked. */
  force_update:               boolean;
  /** Admin-controlled title shown on the force-update screen. */
  update_title:               string;
  /** Admin-controlled body text shown on the force-update screen. */
  update_message:             string;
  /** Google Play store URL (opened on "Update Now" on Android). */
  android_store_url:          string;
  /** Apple App Store URL (opened on "Update Now" on iOS). */
  ios_store_url:              string;
  /** Monotonically increasing config version. Clients compare this before fetching full config. */
  security_version:           number;
  /** Forward-compatible bag for future settings. */
  extras:                     Record<string, unknown>;
  /** ISO-8601 UTC timestamp of when this config was fetched from the server. */
  fetched_at:                 string;
  /** True when this config came from the local cache (not a fresh server fetch). */
  from_cache:                 boolean;
}

// ─── Safe defaults ────────────────────────────────────────────────────────────
// Fail-secure: PI disabled, no cert check, no force-update, floor at 1.0.0.
// All other detectors (root, frida, overlay, etc.) still run normally.
// force_update=false ensures the app is never blocked by a missing config.
const SAFE_DEFAULTS: DynamicSecurityConfig = {
  play_integrity_enabled:    false,
  expected_cert_sha256s:     [],
  minimum_app_version:       '1.0.0',
  minimum_supported_version: '1.0.0',
  latest_version:            '1.0.0',
  force_update:              false,
  update_title:              'Update Required',
  update_message:            'A critical update is available. Please update the app to continue.',
  android_store_url:         '',
  ios_store_url:             '',
  security_version:          0,
  extras:                    {},
  fetched_at:                new Date(0).toISOString(),
  from_cache:                false,
};

// ─── Cache key + TTL ──────────────────────────────────────────────────────────
// v3 key: new shape (force-update fields). Old v2 key is simply ignored — no
// migration needed because SAFE_DEFAULTS are secure and the full config is
// re-fetched on login. Clients with old cache see safe defaults until login.
const CACHE_KEY      = 'security_config_v3';
const REFRESH_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ─── In-memory store ──────────────────────────────────────────────────────────
let _memoryConfig: DynamicSecurityConfig | null = null;
let _lastFetchedAt = 0; // epoch ms of last successful server fetch

// ─── Persistent cache helpers ─────────────────────────────────────────────────

async function persistConfig(cfg: DynamicSecurityConfig): Promise<void> {
  try {
    const serialized = JSON.stringify(cfg);
    if (process.env.EXPO_OS === 'web') {
      localStorage.setItem(CACHE_KEY, serialized);
    } else {
      // WHEN_UNLOCKED_THIS_DEVICE_ONLY: security config must not roam to another
      // device (config contains cert fingerprints + policy flags), and must not be
      // accessible in background — it is always re-fetched on next foreground activation.
      await SecureStore.setItemAsync(CACHE_KEY, serialized, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        keychainService: 'com.medacademy.security',
      });
    }
  } catch { /* non-fatal */ }
}

async function readPersistedConfig(): Promise<DynamicSecurityConfig | null> {
  try {
    let raw: string | null = null;
    if (process.env.EXPO_OS === 'web') {
      raw = localStorage.getItem(CACHE_KEY);
    } else {
      raw = await SecureStore.getItemAsync(CACHE_KEY, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        keychainService: 'com.medacademy.security',
      });
    }
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DynamicSecurityConfig;
    // Basic shape guard before trusting persisted value
    if (typeof parsed.security_version !== 'number') return null;
    if (!Array.isArray(parsed.expected_cert_sha256s)) return null;
    if (typeof parsed.minimum_supported_version !== 'string') return null;
    return { ...parsed, from_cache: true };
  } catch {
    return null;
  }
}

async function clearPersistedConfig(): Promise<void> {
  try {
    if (process.env.EXPO_OS === 'web') {
      localStorage.removeItem(CACHE_KEY);
    } else {
      await SecureStore.deleteItemAsync(CACHE_KEY, {
        keychainService: 'com.medacademy.security',
      });
    }
  } catch { /* non-fatal */ }
}

// ─── Fingerprint validation ───────────────────────────────────────────────────

/**
 * Validates and normalises an array of cert fingerprints.
 * Rules (mirrors DB constraint + get-security-config EF logic):
 *   - Each entry must be exactly 64 hex characters.
 *   - Empty strings and non-strings are dropped.
 *   - Duplicates are deduplicated (case-insensitive).
 *   - All valid entries are uppercased.
 */
function validateFingerprints(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    if (!/^[0-9A-Fa-f]{64}$/.test(entry)) continue;
    const upper = entry.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    result.push(upper);
  }
  return result;
}

// ─── Server response validation ───────────────────────────────────────────────

/** Validates a semver-like string (major.minor.patch[...]) */
function isValidSemver(val: unknown): val is string {
  return typeof val === 'string' && /^\d+\.\d+\.\d+/.test(val);
}

function validateServerResponse(raw: unknown): DynamicSecurityConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if ('error' in r) return null;

  const play_integrity_enabled =
    typeof r.play_integrity_enabled === 'boolean' ? r.play_integrity_enabled : false;

  // Multi-cert array: validate each fingerprint
  const expected_cert_sha256s = validateFingerprints(r.expected_cert_sha256s);

  // Legacy field — kept for backward compat with old cached bundles
  const minimum_app_version =
    isValidSemver(r.minimum_app_version) ? r.minimum_app_version : '1.0.0';

  // Canonical hard-floor version
  const minimum_supported_version =
    isValidSemver(r.minimum_supported_version) ? r.minimum_supported_version : minimum_app_version;

  // Soft ceiling: if not provided, treat as same as minimum (no banner shown)
  const latest_version =
    isValidSemver(r.latest_version) ? r.latest_version : minimum_supported_version;

  const force_update = typeof r.force_update === 'boolean' ? r.force_update : false;

  // Admin-controlled update screen copy
  const update_title =
    typeof r.update_title === 'string' && r.update_title.trim().length > 0
      ? r.update_title.trim()
      : 'Update Required';

  const update_message =
    typeof r.update_message === 'string' && r.update_message.trim().length > 0
      ? r.update_message.trim()
      : 'A critical update is available. Please update the app to continue.';

  const android_store_url =
    typeof r.android_store_url === 'string' ? r.android_store_url.trim() : '';

  const ios_store_url =
    typeof r.ios_store_url === 'string' ? r.ios_store_url.trim() : '';

  const security_version =
    typeof r.security_version === 'number' && r.security_version > 0
      ? Math.floor(r.security_version)
      : 1;

  const extras =
    r.extras && typeof r.extras === 'object' && !Array.isArray(r.extras)
      ? (r.extras as Record<string, unknown>)
      : {};

  const fetched_at =
    typeof r.fetched_at === 'string' ? r.fetched_at : new Date().toISOString();

  return {
    play_integrity_enabled,
    expected_cert_sha256s,
    minimum_app_version,
    minimum_supported_version,
    latest_version,
    force_update,
    update_title,
    update_message,
    android_store_url,
    ios_store_url,
    security_version,
    extras,
    fetched_at,
    from_cache: false,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Synchronous getter — zero latency, never throws, never returns null.
 * Returns: in-memory config → SAFE_DEFAULTS.
 * Call `loadSecurityConfig()` at least once (after login) before using in detectors.
 */
export function getSecurityConfig(): DynamicSecurityConfig {
  return _memoryConfig ?? SAFE_DEFAULTS;
}

/**
 * True when the in-memory config was fetched within the last 15 minutes.
 * Used by SecurityContext to guard the version-check call.
 */
export function isSecurityConfigFresh(): boolean {
  return _memoryConfig !== null && Date.now() - _lastFetchedAt < REFRESH_TTL_MS;
}

/**
 * Lightweight version probe — calls `get-security-version` and returns the
 * remote security_version only (~40-byte response). Returns null on any failure.
 *
 * The caller compares this with `getSecurityConfig().security_version` and
 * only calls `loadSecurityConfig()` when the values differ.
 */
export async function checkRemoteSecurityVersion(): Promise<number | null> {
  try {
    const { data, error } = await backendClient.functions.invoke('get-security-version');
    if (error || !data) return null;
    const v = (data as Record<string, unknown>).security_version;
    return typeof v === 'number' && v > 0 ? Math.floor(v) : null;
  } catch {
    return null;
  }
}

/**
 * Version-aware refresh — the primary refresh entry point.
 *
 * Flow:
 *   1. Call `get-security-version` (~40 bytes).
 *   2. Compare with cached version.
 *   3. If equal → skip full fetch, return existing config.
 *   4. If different → call `loadSecurityConfig()` for full payload.
 *   5. On version-check failure → fall through to `loadSecurityConfig()`
 *      so offline / network-error cases still use cache correctly.
 *
 * Never throws. Always returns a valid DynamicSecurityConfig.
 */
export async function checkAndRefreshSecurityConfig(): Promise<DynamicSecurityConfig> {
  const cached = getSecurityConfig();

  // ── Step 1: lightweight version probe ────────────────────────────────────
  const remoteVersion = await checkRemoteSecurityVersion();

  if (remoteVersion !== null) {
    if (remoteVersion === cached.security_version && _memoryConfig !== null) {
      // Version identical — skip full download, update freshness timestamp only
      _lastFetchedAt = Date.now();
      if (__DEV__) {
        console.log(
          `[securityConfigService] Version unchanged (v${remoteVersion}) — skipping full fetch`
        );
      }
      return _memoryConfig;
    }
    if (__DEV__) {
      console.log(
        `[securityConfigService] Version changed (cached=${cached.security_version}, remote=${remoteVersion}) — fetching full config`
      );
    }
  }
  // Version changed OR version-check failed → fetch full config
  return loadSecurityConfig();
}

/**
 * Fetches the full security configuration from `get-security-config`.
 * Called only when the version probe indicates a change (or on first login).
 *
 * Flow:
 *   1. Invoke get-security-config EF (JWT required).
 *   2. Validate all fields.
 *   3. Update in-memory + persistent cache.
 *   4. On failure: return cached config or SAFE_DEFAULTS.
 *   5. NEVER throws.
 */
export async function loadSecurityConfig(): Promise<DynamicSecurityConfig> {
  // ── Try server ────────────────────────────────────────────────────────────
  try {
    const { data, error } = await backendClient.functions.invoke('get-security-config');
    if (!error && data) {
      const validated = validateServerResponse(data);
      if (validated) {
        _memoryConfig = validated;
        _lastFetchedAt = Date.now();
        void persistConfig(validated);
        return validated;
      }
      if (__DEV__) {
        console.warn('[securityConfigService] Server response failed validation — using cache');
      }
    } else if (error) {
      if (__DEV__) {
        console.warn('[securityConfigService] Fetch failed:', error.message, '— using cache');
      }
    }
  } catch (e) {
    if (__DEV__) {
      console.warn('[securityConfigService] Unexpected fetch error:', e, '— using cache');
    }
  }

  // ── Try persistent cache ──────────────────────────────────────────────────
  const cached = await readPersistedConfig();
  if (cached) {
    _memoryConfig = cached;
    // Do NOT update _lastFetchedAt — next cycle will retry the server
    return cached;
  }

  // ── Safe defaults ─────────────────────────────────────────────────────────
  if (__DEV__) {
    console.warn('[securityConfigService] No cache — using safe defaults. Call loadSecurityConfig() after login.');
  }
  return SAFE_DEFAULTS;
}

/**
 * Pre-warm from SecureStore on app start (no session needed).
 * Ensures getSecurityConfig() returns a valid value immediately on restart.
 */
export async function prewarmSecurityConfig(): Promise<void> {
  if (_memoryConfig) return;
  const cached = await readPersistedConfig();
  if (cached) _memoryConfig = cached;
}

/**
 * Clear all caches on logout so the next user starts from SAFE_DEFAULTS.
 */
export async function invalidateSecurityConfig(): Promise<void> {
  _memoryConfig = null;
  _lastFetchedAt = 0;
  await clearPersistedConfig();
}

/**
 * Derived security guards — computed from the live dynamic config.
 * Replaces the old static PLAY_INTEGRITY_READY / SIGNATURE_CHECK_READY consts.
 */
export function getSecurityGuards() {
  const cfg       = getSecurityConfig();
  const staticCfg = STATIC_SECURITY;

  // Build the full trusted cert set: DB certs first, static bootstrap fallback appended
  // if it is not already in the set (handles first-launch before server config loaded).
  const dynamicCerts  = cfg.expected_cert_sha256s; // already validated + uppercased
  const bootstrapCert = staticCfg.signing.expectedSha256?.toUpperCase() ?? '';
  const trustedCerts  = bootstrapCert && !dynamicCerts.includes(bootstrapCert)
    ? [...dynamicCerts, bootstrapCert]
    : dynamicCerts;

  return {
    /**
     * True when Play Integrity is enabled in DB AND static credentials are set.
     * DB flag is the master switch; static bundle must supply project reference.
     */
    PLAY_INTEGRITY_READY:
      cfg.play_integrity_enabled &&
      staticCfg.playIntegrity.projectNumber.length > 0 &&
      staticCfg.playIntegrity.androidPackageName.length > 0,

    /**
     * True when at least one trusted cert fingerprint is available.
     * Signature check is only active when this is true.
     */
    SIGNATURE_CHECK_READY: trustedCerts.length > 0,

    /**
     * Complete set of trusted cert fingerprints (DB + static bootstrap fallback).
     * detectTamper() matches the runtime cert against ALL entries in this set.
     */
    TRUSTED_CERTS: trustedCerts,
  };
}
