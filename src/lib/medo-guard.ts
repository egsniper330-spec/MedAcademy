/**
 * medo-guard.ts
 *
 * Retired-Project Dependency Blocker
 * ──────────────────────────────────────────────────────────────────────────────
 * Installs a global fetch interceptor that hard-blocks any outgoing network
 * request to the retired Supabase project (itrcmypbgqyaseexwvks).
 *
 * Purpose: prove the application has zero runtime dependency on the old project
 * after migration.  If ANY code path (known or forgotten) attempts to contact
 * the old project, this module throws immediately with a full diagnostic —
 * URL, HTTP method, and JS call-stack — so the offending code can be fixed to
 * use the active project: xdvjwfuqipatkpimejcb.
 *
 * Rules:
 *  • Never silently falls back to the old project.
 *  • Never swallows the error.
 *  • All fixes MUST target Supabase xdvjwfuqipatkpimejcb only.
 *
 * Import this module ONCE, as the VERY FIRST import in src/app/_layout.tsx.
 * The fetch patch is installed synchronously at module-evaluation time.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Retired Supabase project reference — must never be contacted at runtime. */
const MEDO_PROJECT_REF = 'itrcmypbgqyaseexwvks';

/** All hostnames that must never be contacted after migration. */
const BLOCKED_HOSTS: ReadonlyArray<string> = [
  `${MEDO_PROJECT_REF}.supabase.co`,
  `db.${MEDO_PROJECT_REF}.supabase.co`,
  `${MEDO_PROJECT_REF}.supabase.in`,
];

/** Active Supabase project — all requests must target this. */
const ACTIVE_PROJECT = 'xdvjwfuqipatkpimejcb';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractHostname(urlLike: string): string | null {
  try {
    return new URL(urlLike).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isBlockedUrl(url: string): boolean {
  const host = extractHostname(url);
  if (!host) return false;
  return BLOCKED_HOSTS.some((b) => host === b || host.endsWith(`.${b}`));
}

function buildErrorMessage(url: string, method: string): string {
  const stack = new Error().stack ?? '(stack unavailable)';
  return (
    '\n╔══════════════════════════════════════════════════════════════╗\n' +
    '║          [MEDO-GUARD] ❌  BLOCKED REQUEST TO MEDO            ║\n' +
    '╠══════════════════════════════════════════════════════════════╣\n' +
    `║  URL     : ${url}\n` +
    `║  Method  : ${method}\n` +
    `║  Host    : ${extractHostname(url) ?? '(parse error)'}\n` +
    '╠══════════════════════════════════════════════════════════════╣\n' +
    '║  The retired backend has been blocked.                      ║\n' +
    '║  Migrate this call to Supabase: xdvjwfuqipatkpimejcb       ║\n' +
    '╚══════════════════════════════════════════════════════════════╝\n' +
    `Call stack:\n${stack}`
  );
}

// ─── Global fetch interceptor ─────────────────────────────────────────────────

const _originalFetch = globalThis.fetch;

globalThis.fetch = function meDoGuardedFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): ReturnType<typeof fetch> {
  // Resolve the request URL regardless of input type
  let url: string;
  if (typeof input === 'string') {
    url = input;
  } else if (input instanceof URL) {
    url = input.href;
  } else {
    // Request object
    url = (input as Request).url;
  }

  if (isBlockedUrl(url)) {
    const method = init?.method ?? (typeof input !== 'string' && !(input instanceof URL) ? (input as Request).method : 'GET');
    const msg = buildErrorMessage(url, method.toUpperCase());
    console.error(msg);
    throw new Error(`[MEDO-GUARD] Blocked request to retired backend: ${url}`);
  }

  return _originalFetch.call(globalThis, input, init);
} as typeof globalThis.fetch;

// ─── Startup assertion ────────────────────────────────────────────────────────

/**
 * Call once during app startup (e.g. inside RootLayout) to verify the active
 * Supabase client is pointed at the correct project.  Throws if wrong.
 */
export function assertMeDoBlocked(): void {
  const configuredUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';

  if (!configuredUrl) {
    const msg =
      '[MEDO-GUARD] ❌  EXPO_PUBLIC_SUPABASE_URL is not set. ' +
      'The app has no Supabase project configured.';
    console.error(msg);
    throw new Error(msg);
  }

  const host = extractHostname(configuredUrl);

  if (!host || !host.includes(ACTIVE_PROJECT)) {
    const msg =
      `[MEDO-GUARD] ❌  Wrong Supabase project detected!\n` +
      `  EXPO_PUBLIC_SUPABASE_URL = "${configuredUrl}"\n` +
      `  Expected project:          ${ACTIVE_PROJECT}\n` +
      `  Actual host:               ${host ?? '(parse error)'}\n` +
      `  Fix: set EXPO_PUBLIC_SUPABASE_URL=https://${ACTIVE_PROJECT}.supabase.co in .env.local`;
    console.error(msg);
    throw new Error(msg);
  }

  // Verify old project is not the configured URL
  if (configuredUrl.includes(MEDO_PROJECT_REF)) {
    const msg =
      `[MEDO-GUARD] ❌  App is still configured to use the retired project!\n` +
      `  EXPO_PUBLIC_SUPABASE_URL = "${configuredUrl}"\n` +
      `  This URL must be updated to point to: ${ACTIVE_PROJECT}`;
    console.error(msg);
    throw new Error(msg);
  }

  console.log('[MEDO-GUARD] ✅  Active project verified:', ACTIVE_PROJECT);
  if (__DEV__) {
    console.log('[MEDO-GUARD] ✅  Fetch blocker active — any call to', MEDO_PROJECT_REF, 'will throw immediately');
  }
}
