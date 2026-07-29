import { createClient } from 'jsr:@supabase/supabase-js@2';

/**
 * get-security-config — serves the active security_config row to authenticated clients.
 *
 * This is the FULL config endpoint. Clients call it only when the lightweight
 * get-security-version endpoint reports a version change (or on first login).
 * Typical payload: ~400 bytes.
 *
 * Security model:
 *   • Requires a valid Supabase Auth JWT in the Authorization header.
 *   • Unauthenticated requests receive a 401 (not the config).
 *   • Uses the service role to read the table (bypasses RLS).
 *   • Response stripped to minimum — no IDs, no audit fields, no updated_by.
 *   • All fields validated server-side; malformed values replaced with safe defaults.
 *
 * Response shape (SecurityConfigPayload):
 *   {
 *     play_integrity_enabled:  boolean,
 *     expected_cert_sha256s:   string[],   // validated array; [] when not set
 *     minimum_app_version:     string,
 *     force_update:            boolean,
 *     security_version:        number,
 *     extras:                  Record<string, unknown>,
 *     fetched_at:              string,     // ISO-8601 UTC
 *   }
 *
 * Error responses:
 *   401 { error: "Unauthorized" }          — missing / invalid JWT
 *   404 { error: "No active config" }      — table is empty
 *   500 { error: "Internal server error" } — unexpected failure
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Service-role client: reads security_config bypassing RLS
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

// ─── Validation helpers ────────────────────────────────────────────────────────

/** Validates a SHA-256 cert fingerprint: 64 uppercase hex chars, no colons. */
function isValidSha256(val: unknown): val is string {
  return typeof val === 'string' && /^[0-9A-Fa-f]{64}$/.test(val);
}

/**
 * Validates and normalises an array of cert fingerprints.
 * Rules (same as DB constraint):
 *   - Each entry must be exactly 64 hex characters.
 *   - Empty strings are dropped.
 *   - Duplicates are deduplicated (case-insensitive).
 *   - All entries are uppercased.
 *   - Non-string entries are dropped silently.
 */
function sanitiseCertArray(raw: unknown): string[] {
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

/** Validates a semver-like string: "major.minor.patch" with optional pre-release. */
function isValidVersion(val: unknown): val is string {
  return typeof val === 'string' && /^\d+\.\d+\.\d+/.test(val);
}

// ─── Response shape ────────────────────────────────────────────────────────────

interface SecurityConfigPayload {
  play_integrity_enabled:     boolean;
  /** Validated array of trusted cert fingerprints (64 uppercase hex, no colons). */
  expected_cert_sha256s:      string[];
  /** @deprecated Use minimum_supported_version. Kept for old cached bundles. */
  minimum_app_version:        string;
  /** Hard floor: clients below this version are force-blocked. */
  minimum_supported_version:  string;
  /** Soft ceiling: clients below this (but above floor) see a dismissible banner. */
  latest_version:             string;
  force_update:               boolean;
  /** Admin-controlled title for the force-update screen. */
  update_title:               string;
  /** Admin-controlled body copy for the force-update screen. */
  update_message:             string;
  /** Android Play Store URL. */
  android_store_url:          string;
  /** iOS App Store URL. */
  ios_store_url:              string;
  security_version:           number;
  extras:                     Record<string, unknown>;
  fetched_at:                 string;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  try {
    // ── 1. Authenticate the caller ─────────────────────────────────────────
    // We require a valid session JWT. Anonymous / unauthenticated clients
    // cannot retrieve the security config — it is only served post-login.
    // Pre-login security is handled by static defaults in the client bundle.
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const jwt = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authErr } = await supabase.auth.getUser(jwt);
    if (authErr || !user) {
      return json({ error: 'Unauthorized' }, 401);
    }

    // ── 2. Fetch the active configuration row ──────────────────────────────
    const { data, error } = await supabase
      .from('security_config')
      .select(
        'play_integrity_enabled, expected_cert_sha256s, minimum_app_version, ' +
        'minimum_supported_version, latest_version, force_update, ' +
        'update_title, update_message, android_store_url, ios_store_url, ' +
        'security_version, extras'
      )
      .eq('is_active', true)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[get-security-config] DB error:', error.message);
      return json({ error: 'Internal server error' }, 500);
    }

    if (!data) {
      console.warn('[get-security-config] No active config row found — returning safe defaults');
      return json({ error: 'No active config' }, 404);
    }

    // ── 3. Validate and sanitize each field ────────────────────────────────
    // Reject or coerce any malformed value rather than forwarding it blindly.

    // Legacy field — read from DB if it exists, else default to 1.0.0
    const legacyMinVersion = isValidVersion(data.minimum_app_version)
      ? data.minimum_app_version as string
      : '1.0.0';

    // Canonical hard floor
    const minSupportedVersion = isValidVersion(data.minimum_supported_version)
      ? data.minimum_supported_version as string
      : legacyMinVersion;

    const latestVersion = isValidVersion(data.latest_version)
      ? data.latest_version as string
      : minSupportedVersion;

    const payload: SecurityConfigPayload = {
      play_integrity_enabled:
        typeof data.play_integrity_enabled === 'boolean'
          ? data.play_integrity_enabled
          : false,

      expected_cert_sha256s: sanitiseCertArray(data.expected_cert_sha256s),

      minimum_app_version: legacyMinVersion,

      minimum_supported_version: minSupportedVersion,

      latest_version: latestVersion,

      force_update:
        typeof data.force_update === 'boolean' ? data.force_update : false,

      update_title:
        typeof data.update_title === 'string' && data.update_title.trim().length > 0
          ? data.update_title.trim()
          : 'Update Required',

      update_message:
        typeof data.update_message === 'string' && data.update_message.trim().length > 0
          ? data.update_message.trim()
          : 'A critical update is available. Please update the app to continue.',

      android_store_url:
        typeof data.android_store_url === 'string' ? data.android_store_url.trim() : '',

      ios_store_url:
        typeof data.ios_store_url === 'string' ? data.ios_store_url.trim() : '',

      security_version:
        typeof data.security_version === 'number' && data.security_version > 0
          ? Math.floor(data.security_version)
          : 1,

      extras:
        data.extras && typeof data.extras === 'object' && !Array.isArray(data.extras)
          ? (data.extras as Record<string, unknown>)
          : {},

      fetched_at: new Date().toISOString(),
    };

    return json(payload);

  } catch (err) {
    console.error('[get-security-config] Unexpected error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
