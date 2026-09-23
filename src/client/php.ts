// ─────────────────────────────────────────────────────────────────────────────
// PHP Backend Client — authoritative application API client
//
// Preserves the existing application API surface while routing every call to PHP.
//
// Usage:
//   import { backendClient } from '@/client/backendClient';
//   const { data, error } = await backendClient.from('courses').select('*');
//   const { data } = await backendClient.rpc('get_my_credits_balance');
//   await backendClient.functions.invoke('device-binding', { body: {...} });
// ─────────────────────────────────────────────────────────────────────────────

import * as SecureStore from 'expo-secure-store';
import { getInstallationId, getStoredDeviceFingerprint } from '@/lib/installationId';
import Constants from 'expo-constants';
import { Platform as RNPlatform } from 'react-native';
import { setMaintenanceControlFlowActive, isMaintenanceControlFlowActive } from '@/lib/maintenanceStateModel';

// ── Config ──────────────────────────────────────────────────────────────────

const API_BASE: string = (() => {
  const configured = process.env.EXPO_PUBLIC_PHP_API_URL?.trim();
  if (!configured) {
    throw new Error(
      '[BackendConfig] EXPO_PUBLIC_PHP_API_URL is required. ' +
      'Configure it as https://api.medacademy.site/backend/public/index.php.'
    );
  }
  return configured.replace(/\/$/, '');
})();

/** The sole application API base; configuration fails closed when missing. */
export const backendApiBase = API_BASE;

/** Raw JSON fetch against the PHP backend (single choke point; injects app
 *  identity headers and intercepts HTTP 426 UPDATE_REQUIRED globally). */
export { apiFetch };

// ── Helpers ─────────────────────────────────────────────────────────────────

function getToken(): string | null {
  // Fast path: read from in-memory cache (always up-to-date after storeSession/clearSession).
  if (_cachedSession?.access_token) return _cachedSession.access_token;
  // Fallback: localStorage (web / Expo dev).
  try {
    if (_hasLocalStorage()) {
      const raw = localStorage.getItem(AUTH_KEY) ?? localStorage.getItem(LEGACY_AUTH_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return parsed?.access_token ?? parsed?.current_session?.access_token ?? null;
      }
    }
  } catch { /* ignore */ }
  return null;
}

// ── Auth diagnostics ────────────────────────────────────────────────────────
// Safe state-transition logging for diagnosing unexpected logouts. NEVER logs
// access tokens, refresh tokens, passwords, or response bodies — only the
// transition name, outcome, and (for refresh) the HTTP status class. Active in
// all builds but terse enough to be useful in production logs.
function authStateLog(event: string, detail?: string): void {
  try {
    console.log(`[AUTH_STATE] ${event}${detail ? ` — ${detail}` : ''}`);
  } catch { /* logging must never break auth */ }
}

function classifyHttpStatus(status: number | undefined): string {
  if (status == null) return 'no_status(network)';
  if (status === 401 || status === 403) return `definitive_auth(${status})`;
  if (status === 400 || status === 422) return `definitive_request(${status})`;
  if (status >= 500) return `temporary_server(${status})`;
  return `other(${status})`;
}

// Single-flight access-token refresh: concurrent 401s share ONE refresh
// request (refresh tokens rotate — two parallel refreshes would race and
// one would fail with an already-used token).
let refreshPromise: Promise<boolean> | null = null;

// Endpoints that legitimately return 401 without a usable access token (bad
// credentials / no account) or that must never trigger the refresh flow
// (refresh/logout would recurse into themselves).
const NO_AUTO_REFRESH_PREFIXES = [
  '/auth/login', '/auth/register', '/auth/pre-login-check', '/auth/refresh',
  '/auth/logout', '/auth/forgot-password', '/auth/reset-password', '/auth/lookup',
];

function shouldAutoRefresh(path: string): boolean {
  if (NO_AUTO_REFRESH_PREFIXES.some((p) => path.startsWith(p))) return false;
  // Only attempt a refresh when there is a stored session with a refresh token
  // to rotate — otherwise the 401 is genuine and must surface as-is.
  return !!getStoredSession()?.refresh_token;
}

async function refreshAccessToken(): Promise<boolean> {
  if (refreshPromise) {
    authStateLog('AUTH_REFRESH_START', 'joining in-flight refresh (single-flight)');
    return refreshPromise;
  }
  authStateLog('AUTH_REFRESH_START');
  refreshPromise = (async (): Promise<boolean> => {
    const stored = getStoredSession();
    if (!stored?.refresh_token) return false;
    const res = await apiFetchOnce<{ session: { access_token: string; refresh_token: string } }>('/auth/refresh', {
      method: 'POST',
      body: { refresh_token: stored.refresh_token },
    });
    const s = res.data?.session;
    if (res.error || !s?.access_token || !s.refresh_token) {
      // Only invalidate the stored session on a DEFINITIVE auth failure from
      // the refresh endpoint: 401 (expired/revoked/invalid refresh token),
      // 400/422 (malformed), or 403 (account suspended/blocked — the only 403
      // AuthService::refresh() throws). A transient network error (no HTTP
      // status) or a 5xx server error must NOT log the user out.
      const status = res.error?.status;
      if (status === 401 || status === 400 || status === 422 || status === 403) {
        authStateLog('AUTH_REFRESH_DEFINITIVE_FAILURE', `${classifyHttpStatus(status)} → clearing local session`);
        await clearSession();
      } else {
        authStateLog('AUTH_NETWORK_FAILURE', `${classifyHttpStatus(status)} → session PRESERVED`);
      }
      return false;
    }
    // Persist the rotated pair; the `user` object is unchanged.
    await storeSession({ access_token: s.access_token, refresh_token: s.refresh_token, user: stored.user });
    authStateLog('AUTH_REFRESH_SUCCESS');
    return true;
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function apiFetch<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ data: T | null; error: { message: string; code?: string; status?: number } | null }> {
  const result = await apiFetchOnce<T>(path, opts);
  // Expired/invalid ACCESS token → refresh the pair once, then retry the
  // original request exactly once with the new token.
  if (result.error?.status === 401 && shouldAutoRefresh(path)) {
    if (await refreshAccessToken()) {
      return apiFetchOnce<T>(path, opts);
    }
  }
  return result;
}

async function apiFetchOnce<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ data: T | null; error: { message: string; code?: string; status?: number } | null }> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...opts.headers,
  };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // App-identity headers — consumed by the server-side forced-update
  // enforcement (AuthMiddleware). Old versions get HTTP 426 on every
  // protected call regardless of any client UI.
  //
  // NATIVE-ONLY: custom headers trigger CORS preflights, and the deployed
  // allowlist does not include these names — on web every request would fail
  // its preflight and the whole SPA could not talk to the API. The server
  // defaults to a non-android platform when the header is absent, so the web
  // client is correctly evaluated against the web/ios update config; native
  // apps are unaffected by CORS and always send the headers.
  if (RNPlatform.OS !== 'web') {
    headers['X-App-Platform'] = RNPlatform.OS === 'android' ? 'android' : 'ios';
    const appVersionCode = Constants.expoConfig?.android?.versionCode ?? 0;
    if (appVersionCode > 0) headers['X-App-Version-Code'] = String(appVersionCode);
  }

  // 30s request timeout — a hung request must never leave a screen in an
  // eternal loading state (e.g. the dashboard's Promise.all).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await globalThis.fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = text; }

    if (!res.ok) {
      const errObj = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
      const inner426 = (errObj.error && typeof errObj.error === 'object')
        ? errObj.error as Record<string, unknown>
        : null;
      // Server-side forced-update enforcement (HTTP 426): the backend has
      // authoritatively decided this version is unsupported. Flip the update
      // gate immediately — no client state can keep protected UI alive.
      if (res.status === 426 && (errObj.code === 'UPDATE_REQUIRED' || inner426?.code === 'UPDATE_REQUIRED')) {
        void import('@/lib/updateConfigService').then(({ emitUpdateRejection }) =>
          emitUpdateRejection({
            latestVersion: inner426?.latestVersion,
            latestVersionCode: inner426?.latestVersionCode,
            minimumVersionCode: inner426?.minimumVersionCode,
            updateUrl: inner426?.updateUrl,
            updateMode: inner426?.updateMode,
          })
        );
      }
      // PHP backend error envelope: { error: { message, code } } (or flat { message })
      const inner = (errObj.error && typeof errObj.error === 'object')
        ? errObj.error as Record<string, unknown>
        : null;
      // Server-side MAINTENANCE gate (HTTP 503 maintenance_mode): the backend
      // has authoritatively blocked this route while maintenance is ON. This is
      // a DISTINCT state — never a logout, never a generic network error, never
      // offline (the server REACHED us to say so). The maintenance service
      // renders the full-screen maintenance UI and auto-recovers when the
      // backend reports maintenance disabled again.
      const innerCode = (errObj.code as string | undefined) ?? (inner?.code as string | undefined);
      if (res.status === 503 && (innerCode === 'maintenance_mode' || errObj.maintenance != null || inner?.maintenance != null)) {
        const maintenanceMeta = ((inner?.maintenance ?? errObj.maintenance ?? {}) as Record<string, unknown>);
        // SYNCHRONOUS canary arm (pure module, static import): the caller's
        // catch block runs before any dynamic import could resolve, so the
        // expected-control-flow flag must be set HERE — isExpectedMaintenanceError
        // is already true when getProfile / RPC callers log their error.
        setMaintenanceControlFlowActive(true);
        void import('@/lib/maintenanceService').then(({ notifyMaintenance503 }) =>
          notifyMaintenance503(
            {
              message: (inner?.message as string) ?? (errObj.message as string) ?? 'MedAcademy is temporarily unavailable while we perform maintenance.',
              retryAfter: typeof maintenanceMeta.retryAfter === 'number' ? maintenanceMeta.retryAfter : 300,
            },
            // Session context lets the service consult the SERVER-computed
            // exemption evidence (GET /maintenance/whoami): a verified
            // super_admin / whitelisted identity keeps using the app — the
            // gate never mounts for them. Never a client-declared role.
            { hasSession: !!getStoredSession()?.access_token },
          )
        );
      }
      return {
        data: null,
        error: {
          message:
            (errObj.message as string) ??
            (inner?.message as string) ??
            (typeof errObj.error === 'string' ? errObj.error : null) ??
            text ??
            `HTTP ${res.status}`,
          code: (errObj.code as string) ?? (inner?.code as string) ?? undefined,
          status: res.status,
        },
      };
    }
    return { data: parsed as T, error: null };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    authStateLog('AUTH_NETWORK_FAILURE', msg.includes('AbortError') ? 'request timed out (30s) — no session impact' : msg);
    return { data: null, error: { message: msg.includes('AbortError') ? 'Request timed out' : msg } };
  } finally {
    clearTimeout(timer);
  }
}

// ── Query Builder (chainable application data client) ────────────────────────

type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'in' | 'is' | 'contains' | 'contained_by' | 'overlaps';

interface FilterClause {
  column: string;
  op: FilterOp;
  value: unknown;
  negated: boolean;
}

class QueryBuilder<T = any> {
  private _table: string;
  private _method: string = 'select';
  private _columns: string = '*';
  private _filters: FilterClause[] = [];
  private _order: { column: string; ascending: boolean } | null = null;
  private _limitCount: number | null = null;
  private _offsetCount: number | null = null;
  private _single: boolean = false;
  private _maybeSingle: boolean = false;
  private _body: unknown = null;
  private _headers: Record<string, string> = {};
  private _orConditions: string | null = null;
  private _count: string | null = null;
  private _head: boolean = false;
  private _onConflict: string | null = null;
  private _returning: boolean = false;

  constructor(table: string) { this._table = table; }

  select(columns: string = '*', opts?: { count?: string; head?: boolean }): this {
    // The compatibility builder allows .insert(...).select() / .update(...).select() — the write
    // happens AND the affected row(s) are returned. If a write method was set
    // first, keep it (so POST/PATCH is sent) and mark that the caller wants
    // rows back; a bare .select() with no prior write is a plain read.
    if (this._method !== 'insert' && this._method !== 'update' && this._method !== 'upsert') {
      this._method = 'select';
    } else {
      this._returning = true;
    }
    this._columns = columns;
    if (opts?.count) this._count = opts.count;
    if (opts?.head) this._head = true;
    return this;
  }
  insert(data: unknown): this { this._method = 'insert'; this._body = data; return this; }
  update(data: unknown): this { this._method = 'update'; this._body = data; return this; }
  upsert(data: unknown, opts?: { onConflict?: string; ignoreDuplicates?: boolean }): this { this._method = 'upsert'; this._body = data; if (opts?.onConflict) this._onConflict = opts.onConflict; return this; }
  delete(): this { this._method = 'delete'; return this; }

  eq(col: string, val: unknown): this { this._filters.push({ column: col, op: 'eq', value: val, negated: false }); return this; }
  neq(col: string, val: unknown): this { this._filters.push({ column: col, op: 'neq', value: val, negated: false }); return this; }
  gt(col: string, val: unknown): this { this._filters.push({ column: col, op: 'gt', value: val, negated: false }); return this; }
  gte(col: string, val: unknown): this { this._filters.push({ column: col, op: 'gte', value: val, negated: false }); return this; }
  lt(col: string, val: unknown): this { this._filters.push({ column: col, op: 'lt', value: val, negated: false }); return this; }
  lte(col: string, val: unknown): this { this._filters.push({ column: col, op: 'lte', value: val, negated: false }); return this; }
  like(col: string, val: unknown): this { this._filters.push({ column: col, op: 'like', value: val, negated: false }); return this; }
  ilike(col: string, val: unknown): this { this._filters.push({ column: col, op: 'ilike', value: val, negated: false }); return this; }
  in(col: string, val: unknown): this { this._filters.push({ column: col, op: 'in', value: val, negated: false }); return this; }
  is(col: string, val: unknown): this { this._filters.push({ column: col, op: 'is', value: val, negated: false }); return this; }
  contains(col: string, val: unknown): this { this._filters.push({ column: col, op: 'contains', value: val, negated: false }); return this; }
  containedBy(col: string, val: unknown): this { this._filters.push({ column: col, op: 'contained_by', value: val, negated: false }); return this; }
  overlaps(col: string, val: unknown): this { this._filters.push({ column: col, op: 'overlaps', value: val, negated: false }); return this; }
  textSearch(col: string, query: string, opts?: { type?: string; config?: string }): this {
    // PostgREST textSearch — translate to ilike for PHP backend
    this._filters.push({ column: col, op: 'ilike', value: `%${query}%`, negated: false });
    return this;
  }
  not(col: string, op: FilterOp, val: unknown): this { this._filters.push({ column: col, op, value: val, negated: true }); return this; }
  or(conditions: string): this {
    // PostgREST-style OR: "col1.op.val1,col2.op.val2"
    // Send as a single OR parameter to the backend
    this._orConditions = conditions;
    return this;
  }
  filter(col: string, op: FilterOp, val: unknown): this { this._filters.push({ column: col, op, value: val, negated: false }); return this; }

  order(col: string, opts?: { ascending?: boolean }): this { this._order = { column: col, ascending: opts?.ascending ?? true }; return this; }
  limit(n: number): this { this._limitCount = n; return this; }
  range(from: number, to: number): this { this._offsetCount = from; this._limitCount = to - from + 1; return this; }
  single(): this { this._single = true; return this; }
  maybeSingle(): this { this._maybeSingle = true; return this; }

  /** Set request headers (used by some callers for idempotency keys etc.) */
  headers(h: Record<string, string>): this { this._headers = { ...this._headers, ...h }; return this; }

  /** Override body (some callers do .select().body(...) pattern — rare but exists) */
  body(b: unknown): this { this._body = b; return this; }

  /** Execute the query and return { data, error, count } */
  then<U>(
    resolve?: (value: { data: T | null; error: { message: string; code?: string; status?: number } | null; count: number | null }) => U | PromiseLike<U>,
    reject?: (reason: unknown) => U | PromiseLike<U>
  ): Promise<U> {
    return this._execute().then(resolve, reject);
  }

  private async _execute(): Promise<{ data: T | null; error: { message: string; code?: string; status?: number } | null; count: number | null }> {
    const params = new URLSearchParams();
    if (this._method === 'select' || this._returning) {
      params.set('select', this._columns);
    }
    for (const f of this._filters) {
      const neg = f.negated ? 'not.' : '';
      if (f.op === 'eq' && !f.negated) params.set(f.column, String(f.value));
      else if (f.op === 'in' && Array.isArray(f.value)) params.set(f.column, `${neg}in.(${(f.value as unknown[]).join(',')})`);
      else if (f.op === 'is') params.set(f.column, `${neg}is.${f.value == null ? 'null' : String(f.value)}`);
      else params.set(f.column, `${neg}${f.op}.${String(f.value)}`);
    }
    if (this._orConditions) params.set('or', this._orConditions);
    if (this._order) params.set('order', `${this._order.column}.${this._order.ascending ? 'asc' : 'desc'}`);
    if (this._limitCount != null) params.set('limit', String(this._limitCount));
    if (this._offsetCount != null) params.set('offset', String(this._offsetCount));
    if (this._single || this._maybeSingle) params.set('limit', '1');
    if (this._count) params.set('count', this._count);
    if (this._head) params.set('head', 'true');
    if (this._onConflict) params.set('on_conflict', this._onConflict);

    const qs = params.toString();
    const path = `/api/${this._table}${qs ? '?' + qs : ''}`;

    const methodMap: Record<string, string> = {
      select: 'GET', insert: 'POST', update: 'PATCH', upsert: 'POST', delete: 'DELETE',
    };
    const method = methodMap[this._method] ?? 'GET';
    const body = ['insert', 'update', 'upsert'].includes(this._method) ? this._body : undefined;

    const res = await apiFetch<T[] | T>(path, { method, body, headers: this._headers });
    if (res.error) return { data: null, error: res.error, count: null };

    let data: T | null = res.data as T | null;
    if (this._single || this._maybeSingle) {
      if (Array.isArray(data)) data = (data as unknown[])[0] as T ?? (this._maybeSingle ? null : null);
    }
    if (this._head || this._count) {
      // PHP backend returns { count: N } for count=exact&head=true
      const countBody = res.data as unknown;
      const count = (typeof countBody === 'object' && countBody !== null && 'count' in countBody)
        ? (countBody as { count: number }).count
        : null;
      return { data: null, error: null, count };
    }
    return { data, error: null, count: null };
  }
}

// ── Auth ────────────────────────────────────────────────────────────────────

interface AuthUser { id: string; email: string | null; phone: string | null; user_metadata?: Record<string, unknown>; app_metadata?: Record<string, unknown>; }
interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
  user: AuthUser;
}

const AUTH_KEY = 'php-auth-token';
const LEGACY_AUTH_KEY = 'sb-auth-token';
const SECURE_STORE_KEY = 'php-auth-session';
/** Diagnostic threshold: a SecureStore read slower than this is logged (never truncated). */
const HYDRATION_TIMEOUT_MS = 3_000;
/** Hard cap for a genuinely HUNG native bridge — startup must remain bounded. */
const HYDRATION_HARD_CAP_MS = 10_000;

// ── Compact session format for SecureStore (stays under 2KB) ─────────────────
// SecureStore has a 2KB value limit. A full AuthSession with long JWTs and
// large user_metadata could exceed it. The compact format stores only what is
// needed to reconstruct the session on restore; the full AuthSession is kept
// in the in-memory cache for runtime use.
interface CompactSession {
  at: string;                          // access_token
  rt: string;                          // refresh_token
  uid: string;                         // user.id
  email: string | null;                // user.email
  phone: string | null;                // user.phone
  meta?: Record<string, unknown>;      // user.user_metadata
  app?: Record<string, unknown>;       // user.app_metadata
}

function _toCompact(s: AuthSession): CompactSession {
  return {
    at: s.access_token,
    rt: s.refresh_token,
    uid: s.user.id,
    email: s.user.email,
    phone: s.user.phone,
    meta: s.user.user_metadata,
    app: s.user.app_metadata,
  };
}

function _fromCompact(c: CompactSession): AuthSession {
  return {
    access_token: c.at,
    refresh_token: c.rt,
    user: {
      id: c.uid,
      email: c.email,
      phone: c.phone,
      user_metadata: c.meta,
      app_metadata: c.app,
    },
  };
}

// ── In-memory session cache + SecureStore persistence ────────────────────────
// Synchronous reads (getToken, getStoredSession) hit _cachedSession.
// Writes (storeSession, clearSession) update the cache AND persist to
// SecureStore (native) and/or localStorage (web/dev) for cross-restart survival.
// On module load, _hydrateFromSecureStore() populates the cache from disk.
let _cachedSession: AuthSession | null = null;

function _hasLocalStorage(): boolean {
  try { return typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function'; } catch { return false; }
}

function _isNative(): boolean {
  return process.env.EXPO_OS !== 'web';
}

/** Hydrate the in-memory cache from SecureStore on app start. */
async function _hydrateFromSecureStore(): Promise<void> {
  if (!_isNative()) return;
  try {
    const raw = await SecureStore.getItemAsync(SECURE_STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Backward compat: old format stored full AuthSession; new format uses CompactSession.
      _cachedSession = (parsed.at != null) ? _fromCompact(parsed as CompactSession) : (parsed as AuthSession);
    }
  } catch { /* ignore */ }
}

/**
 * Hydration — AUTHORITATIVE, never truncated by a short timer.
 *
 * THE OFFLINE-LOGIN BUG (root cause, state/order — not a UI guess):
 * the previous implementation raced the SecureStore read against a 3-second
 * timeout and let the TIMEOUT resolve as silent success. On a slow cold start
 * (cold native bridge, disk contention, first unlock after boot) the local
 * read legitimately takes longer than 3s; getSession() then resolved with
 * session=null AND isLoading=false, the root Stack.Protected guard mounted the
 * (auth) group, and a fully-authenticated user landed on LOGIN. Offline there
 * is no way back (login cannot succeed without a network), and the late real
 * read was discarded because nothing re-ran the initial session load.
 *
 * New contract: getSession() awaits the REAL read. The 3s timer is diagnostic
 * only; the hard cap exists solely so a genuinely HUNG native bridge cannot
 * hang startup forever (10s → resolve → unreadable session → login is then
 * genuinely correct because no session can be read). A late read that lands
 * after a cap-truncated first getSession() still self-heals: the poll-based
 * onAuthStateChange listener observes the token appear and emits SIGNED_IN.
 *
 * This path performs NO network I/O (SecureStore is local) — a network
 * failure can never reach it, let alone be treated as a logout.
 */
function _hydrateWithTimeout(): Promise<void> {
  let settled = false;
  const read = _hydrateFromSecureStore().finally(() => { settled = true; });
  setTimeout(() => {
    if (!settled && !_cachedSession) {
      authStateLog('AUTH_HYDRATION_SLOW', `SecureStore read >${HYDRATION_TIMEOUT_MS}ms — still authoritative, waiting (offline login bug guard)`);
    }
  }, HYDRATION_TIMEOUT_MS);
  const hungBridgeCap = new Promise<void>((resolve) => setTimeout(resolve, HYDRATION_HARD_CAP_MS));
  return Promise.race([read, hungBridgeCap]);
}

// Kick off hydration immediately at module load. getSession() awaits this.
const _hydrationDone: Promise<void> = _hydrateWithTimeout();

async function storeSession(session: AuthSession): Promise<void> {
  _cachedSession = session;
  // Persist to localStorage (web/dev fallback)
  if (_hasLocalStorage()) {
    try { localStorage.setItem(AUTH_KEY, JSON.stringify(session)); } catch { /* ignore */ }
  }
  // Persist to SecureStore (native production) — await to guarantee persistence.
  if (_isNative()) {
    try {
      const compact = JSON.stringify(_toCompact(session));
      await SecureStore.setItemAsync(SECURE_STORE_KEY, compact);
    } catch { /* SecureStore full/inaccessible — non-fatal, in-memory cache is authoritative */ }
  }
}

async function clearSession(): Promise<void> {
  authStateLog('AUTH_SESSION_CLEARED');
  _cachedSession = null;
  if (_hasLocalStorage()) {
    try {
      localStorage.removeItem(AUTH_KEY);
      localStorage.removeItem(LEGACY_AUTH_KEY);
    } catch { /* ignore */ }
  }
  if (_isNative()) {
    try {
      await SecureStore.deleteItemAsync(SECURE_STORE_KEY);
    } catch { /* ignore */ }
  }
}

function getStoredSession(): AuthSession | null {
  // In-memory cache is always checked first.
  if (_cachedSession) return _cachedSession;
  // Fallback: read from localStorage (works on web / Expo dev).
  if (_hasLocalStorage()) {
    try {
      const raw = localStorage.getItem(AUTH_KEY) ?? localStorage.getItem(LEGACY_AUTH_KEY);
      if (!raw) return null;
      const session = JSON.parse(raw) as AuthSession;
      _cachedSession = session;
      return session;
    } catch { return null; }
  }
  return null;
}

// Auth methods preserve the existing frontend contract while calling PHP
const authMethods = {
  getSession: async () => {
    // Ensure SecureStore hydration has completed before reading the cache.
    // On first call this waits for _hydrateFromSecureStore(); subsequent calls resolve instantly.
    await _hydrationDone;
    const session = getStoredSession();
    return { data: { session }, error: null };
  },

  getUser: async () => {
    const session = getStoredSession();
    if (!session) return { data: { user: null }, error: null };
    // The backend returns { user: {...} }; unwrap it so callers receive the
    // established { data: { user } } contract (user.id must be the user
    // object itself, not the response envelope).
    const res = await apiFetch<{ user: AuthUser | null }>('/auth/me');
    if (res.error || !res.data) return { data: { user: null }, error: res.error };
    return { data: { user: res.data.user ?? null }, error: null };
  },

  signInWithPassword: async ({ email, password, ...device }: {
    email: string;
    password: string;
    installation_id?: string;
    device_fingerprint?: string;
    device_name?: string;
    platform?: string;
    device_model?: string;
    os?: string;
    os_version?: string;
    app_version?: string;
    manufacturer?: string;
  }) => {
    // Attach the persisted device context when available so the backend can
    // enforce blocked-device rules at login time. Explicit device fields from
    // the caller (sign-in screen computes the fingerprint once and reuses it
    // for device registration) take precedence over the persisted values.
    const [storedInstallationId, storedFp] = await Promise.all([
      getInstallationId().catch(() => null),
      getStoredDeviceFingerprint().catch(() => null),
    ]);
    const installationId = device.installation_id || storedInstallationId || undefined;
    const fingerprint = device.device_fingerprint || storedFp || undefined;
    const res = await apiFetch<{ user: AuthUser; session: { access_token: string; refresh_token: string } }>('/auth/login', {
      method: 'POST', body: {
        identifier: email, password,
        ...(installationId ? { installation_id: installationId } : {}),
        ...(fingerprint ? { device_fingerprint: fingerprint } : {}),
        ...(device.device_name ? { device_name: device.device_name } : {}),
        ...(device.platform ? { platform: device.platform } : {}),
        ...(device.device_model ? { device_model: device.device_model } : {}),
        ...(device.os ? { os: device.os } : {}),
        ...(device.os_version ? { os_version: device.os_version } : {}),
        ...(device.app_version ? { app_version: device.app_version } : {}),
        ...(device.manufacturer ? { manufacturer: device.manufacturer } : {}),
      },
    });
    if (res.error) return { data: { session: null, user: null }, error: res.error };
    const d = res.data!;
    const session: AuthSession = { access_token: d.session.access_token, refresh_token: d.session.refresh_token, user: d.user };
    await storeSession(session);
    return { data: { session, user: d.user }, error: null };
  },

  signUp: async ({ email, password, options }: { email: string; password: string; options?: { data?: Record<string, unknown> } }) => {
    const [installationId, fingerprint] = await Promise.all([
      getInstallationId().catch(() => null),
      getStoredDeviceFingerprint().catch(() => null),
    ]);
    const res = await apiFetch<{ user: AuthUser; session: { access_token: string; refresh_token: string } | null }>('/auth/register', {
      method: 'POST', body: {
        email, password, ...options?.data,
        ...(installationId ? { installation_id: installationId } : {}),
        ...(fingerprint ? { device_fingerprint: fingerprint } : {}),
      },
    });
    if (res.error) return { data: { session: null, user: null }, error: res.error };
    const d = res.data!;
    if (!d.session) return { data: { session: null, user: d.user }, error: null };
    const session: AuthSession = { access_token: d.session.access_token, refresh_token: d.session.refresh_token, user: d.user };
    await storeSession(session);
    return { data: { session, user: d.user }, error: null };
  },

  signOut: async ({ scope }: { scope?: string } = {}): Promise<{ error: { message: string; code?: string } | null }> => {
    authStateLog('AUTH_EXPLICIT_LOGOUT', `scope=${scope ?? 'global'}`);
    if (scope !== 'local') {
      // 'global' or default: notify the server to revoke the refresh token so
      // the session cannot be re-established after logout.
      const session = getStoredSession();
      await apiFetch('/auth/logout', {
        method: 'POST',
        body: session?.refresh_token ? { refresh_token: session.refresh_token } : {},
      });
    }
    await clearSession();
    return { error: null };
  },

  resetPasswordForEmail: async (email: string) => {
    const res = await apiFetch('/auth/forgot-password', { method: 'POST', body: { email } });
    return { error: res.error };
  },

  updateUser: async ({ password, data }: { password?: string; data?: Record<string, unknown> }) => {
    const body: Record<string, unknown> = {};
    if (password) body.password = password;
    if (data) Object.assign(body, data);
    const res = await apiFetch('/users/me', { method: 'PATCH', body });
    if (res.error) return { data: { user: null }, error: res.error };
    return { data: { user: res.data }, error: null };
  },

  refreshSession: async (opts?: { refresh_token?: string }) => {
    const stored = getStoredSession();
    if (!stored) return { data: { session: null }, error: null };
    // Default path (foreground resume, etc.): share the SINGLE-FLIGHT refresh
    // lock used by the 401 interceptor. Refresh tokens ROTATE on every use — if
    // the foreground handler and a concurrent 401-triggered refresh both POST the
    // same pre-rotation token, the backend rotates it on the first call and
    // rejects the second with 401, which would clear a perfectly valid session.
    // refreshAccessToken() guarantees exactly one refresh request at a time and
    // already implements the correct failure handling: definitive auth failures
    // (401/400/422) clear the session; network errors / timeouts / server errors
    // preserve it (the former unconditional clearSession() here was the root
    // cause of the "logged out after a short period" bug).
    if (!opts?.refresh_token) {
      const ok = await refreshAccessToken();
      if (!ok) {
        // refreshAccessToken() already cleared the session on a definitive auth
        // failure and preserved it on a transient network error. Surface an error
        // so callers (foreground handler) treat this as non-fatal and do NOT
        // clear again.
        return { data: { session: getStoredSession() }, error: { message: 'refresh failed' } };
      }
      return { data: { session: getStoredSession() }, error: null };
    }
    // Explicit-token path (legacy provider adapter only) keeps its own POST and
    // the same definitive-vs-transient failure handling.
    const res = await apiFetch<{ session: { access_token: string; refresh_token: string } }>('/auth/refresh', {
      method: 'POST',
      body: { refresh_token: opts.refresh_token },
    });
    if (res.error || !res.data) {
      const status = res.error?.status;
      // 403 = account suspended/blocked (only 403 AuthService::refresh() throws)
      // — definitive. Network errors / 5xx preserve the session.
      if (status === 401 || status === 400 || status === 422 || status === 403) {
        await clearSession();
      }
      return { data: { session: null }, error: res.error };
    }
    const s = res.data.session;
    const session: AuthSession = {
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      user: stored.user,
    };
    await storeSession(session);
    return { data: { session }, error: null };
  },

  setSession: async (session: { access_token: string; expires_at?: number; refresh_token?: string; user?: AuthUser }) => {
    // Optional `user` override: impersonation swaps the session to a DIFFERENT
    // user, so the stored user identity must be replaced, not reused.
    const existing = getStoredSession();
    const user = session.user ?? existing?.user ?? { id: '', email: null, phone: null };
    await storeSession({ access_token: session.access_token, refresh_token: session.refresh_token ?? existing?.refresh_token ?? '', user });
    return { error: null };
  },

  verifyOtp: async ({ phone, email, token, type, email_otp }: { phone?: string; email?: string; token?: string; type?: string; email_otp?: string }) => {
    const res = await apiFetch<{ user: AuthUser; session: { access_token: string; refresh_token: string } }>('/auth/login', {
      method: 'POST', body: { phone, email, token: token ?? email_otp, type },
    });
    if (res.error) return { data: { session: null, user: null }, error: res.error };
    const d = res.data!;
    const session: AuthSession = { access_token: d.session.access_token, refresh_token: d.session.refresh_token, user: d.user };
    await storeSession(session);
    return { data: { session, user: d.user }, error: null };
  },

  // Poll-based auth state listener; the PHP backend remains authoritative
  onAuthStateChange: (callback: (event: string, session: AuthSession | null) => void) => {
    let lastToken = getToken();
    const interval = setInterval(() => {
      const current = getToken();
      if (current !== lastToken) {
        lastToken = current;
        const s = getStoredSession();
        callback(current ? 'SIGNED_IN' : 'SIGNED_OUT', s);
      }
    }, 2000);
    return { data: { subscription: { unsubscribe: () => clearInterval(interval) } } };
  },

};

// ── Storage ─────────────────────────────────────────────────────────────────

function createStorageBucket(bucket: string) {
  return {
    upload: async (path: string, file: Blob | ArrayBuffer, opts?: { contentType?: string; upsert?: boolean; cacheControl?: string; metadata?: Record<string, unknown> }) => {
      const formData = new FormData();
      formData.append('file', file instanceof Blob ? file : new Blob([file]));
      formData.append('bucket', bucket);
      formData.append('path', path);
      const token = getToken();
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      try {
        const res = await globalThis.fetch(`${API_BASE}/storage/upload`, {
          method: 'POST', headers, body: formData,
        });
        const data = await res.json();
        if (!res.ok) {
          const detail = typeof data?.error === 'object' ? data.error?.message : data?.error;
          return { error: { message: detail ?? data?.message ?? `HTTP ${res.status}`, status: res.status } };
        }
        return { error: null as { message: string; code?: string } | null };
      } catch (e: unknown) {
        return { error: { message: e instanceof Error ? e.message : String(e) } };
      }
    },
    getPublicUrl: (path: string) => {
      // Public buckets are served directly by the API host, not through the
      // front-controller path or the HMAC-signed private-file endpoint.
      const apiUrl = new URL(API_BASE);
      const rootPath = apiUrl.pathname
        .replace(/\/backend\/public\/index\.php\/?$/, '')
        .replace(/\/$/, '');
      const publicPath = path.split('/').map(encodeURIComponent).join('/');
      const publicUrl = `${apiUrl.origin}${rootPath}/storage/public/${encodeURIComponent(bucket)}/${publicPath}`;
      return { data: { publicUrl }, publicUrl };
    },
    remove: async (paths: string[]): Promise<{ error: { message: string; code?: string; status?: number } | null }> => {
      for (const p of paths) {
        const result = await apiFetch('/storage/delete', { method: 'POST', body: { bucket, path: p } });
        if (result.error) return { error: result.error };
      }
      return { error: null };
    },
    createSignedUrl: async (path: string, expiresIn: number): Promise<{ data: { signedUrl: string } | null; error: { message: string; code?: string } | null }> => {
      const res = await apiFetch<{ signed_url?: string; signedUrl?: string }>('/storage/signed-url', {
        method: 'POST', body: { bucket, path, expires_in: expiresIn },
      });
      if (res.error) return { data: null, error: res.error };
      return { data: { signedUrl: res.data?.signed_url ?? res.data?.signedUrl ?? '' }, error: null };
    },
  };
}

// ── Functions ───────────────────────────────────────────────────────────────

const EDGE_FUNCTION_MAP: Record<string, string> = {
  'redeem-codes':           '/redeem-codes',
  'redeem-code-redeem':     '/redeem-codes/redeem',
  'admin-doctor-earnings':  '/analytics/doctor-earnings',
  'admin-enrollment':       '/admin/enrollment',
  'admin-update-email':     '/admin/update-email',
  'block-user':             '/admin/users/{id}/block',
  'device-binding':         '/device-binding',
  'get-security-config':    '/security/config',
  'get-app-update-config':  '/admin/app-updates',
  'set-app-update-config':  '/admin/app-updates/{platform}',
  'get-security-policies':  '/security/policies',
  'get-security-version':   '/security/version',
  'get-signed-url':         '/storage/signed-url',
  'impersonate':            '/auth/impersonate',
  'process-violation':      '/security/violations',
  'provider-health':        '/provider-health',
  'restore-account':        '/admin/users/{id}/restore',
  'security-logger':        '/security/events',
  'security-evidence-key':  '/security/device-key',
  'security-evidence-challenge': '/security/challenge',
  'security-evidence-verify':    '/security/evidence',
  'security-evidence-revoke':    '/security/device-keys/{id}/revoke',
  'student-operations':     '/student-operations',
  'system-health':          '/system-health',
  'system-diagnostics':     '/admin/system/diagnostics',
  'system-diagnostics-one': '/admin/system/diagnostics/{id}',
  'get-maintenance-status': '/maintenance',
  'set-maintenance-mode':   '/admin/maintenance',
  'vdocipher-otp':          '/video/otp',
  'vdocipher-offline-authorize': '/video/offline-authorize',
  'verify-app-integrity':   '/integrity/app',
  'verify-play-integrity':  '/integrity/play',
  'video-health-scan':      '/video/health-scan',
  'vdocipher-upload-init':  '/video/upload-init',
  'vdocipher-upload-status':'/video/upload-status',
  'vdocipher-delete-video': '/video/delete',
  'vdocipher-cancel-upload': '/video/cancel-upload',
  'video-assemble-upload':  '/video/assemble',
  'delete-lesson':          '/lessons/{id}/delete',
  'bulk-user-ops':          '/admin/bulk-user-ops',
  'trash-cleanup':          '/admin/trash-cleanup',
  'user-management':        '/admin/user-management',
};// Multi-action Edge Functions (original EF dispatches on body.action)
const EDGE_ACTION_MAP: Record<string, Record<string, string>> = {
  'credits': {
    allocate:       '/credits/allocate',
    bulk_allocate:  '/credits/bulk-allocate',
    revoke:         '/credits/revoke',
    refund:         '/credits/refund',
  },
};

// Edge Functions whose PHP routes are GET-only (config/version/health probes)
const GET_FUNCTIONS = new Set(['get-security-config', 'get-security-policies', 'get-security-version', 'provider-health', 'get-app-update-config', 'system-diagnostics', 'system-diagnostics-one', 'get-maintenance-status']);
// Edge Functions whose PHP routes REQUIRE PUT (the upsert contract)
const FORCE_PUT_FUNCTIONS = new Set(['set-app-update-config']);
// Edge Functions whose PHP routes are POST-only regardless of the caller's
// requested method (the original vdocipher-upload-status EF used GET; the PHP
// route /video/upload-status accepts POST with a JSON body).
const FORCE_POST_FUNCTIONS = new Set(['vdocipher-upload-status']);

async function invokeFunction<T = any>(
  name: string,
  opts: { body?: unknown; method?: string; headers?: Record<string, string> } = {}
): Promise<{ data: T | null; error: { message: string; context?: { text: () => Promise<string> } } | null }> {
  const method = FORCE_PUT_FUNCTIONS.has(name)
    ? 'PUT'
    : FORCE_POST_FUNCTIONS.has(name) ? 'POST' : (opts.method ?? (GET_FUNCTIONS.has(name) ? 'GET' : 'POST'));
  const payload = (opts.body ?? {}) as Record<string, unknown>;

  // 1. Resolve the PHP route (static map, action dispatch, or special cases)
  let route = EDGE_FUNCTION_MAP[name];

  if (!route && EDGE_ACTION_MAP[name] && typeof payload.action === 'string') {
    route = EDGE_ACTION_MAP[name][payload.action] ?? undefined;
  }

  if (name === 'restore-account') {
    // restore-account sends target_user_id but the PHP route uses {id}
    if (typeof payload.target_user_id === 'string') {
      payload.id = payload.target_user_id;
      delete payload.target_user_id;
    }
  }
  if (name === 'change-password') {
    // Admin changes another user's password → admin endpoint; self-service → user endpoint
    route = payload.target_user_id ? '/auth/admin/change-password' : '/auth/change-password';
  }
  if (name === 'delete-user') {
    // GET = preflight (never deletes); POST = permanent delete
    route = method === 'GET' ? '/admin/delete-user/preflight' : '/admin/delete-user';
  }
  if (name === 'delete-course') {
    route = '/courses/{id}/delete';
    if (typeof payload.course_id === 'string') payload.id = payload.course_id;
    delete payload.course_id;
  }
  if (name === 'delete-lesson') {
    route = '/lessons/{id}/delete';
    if (typeof payload.lesson_id === 'string') payload.id = payload.lesson_id;
    delete payload.lesson_id;
  }
  if (name === 'set-app-update-config') {
    // PUT /admin/app-updates/{platform}: the route token is literally
    // `{platform}` (Router extracts params by token name), so the payload key
    // must STAY `platform`. Mapping it to `id` here used to delete the only
    // source of the token → every save failed with
    // "Missing route parameter: platform".
    if (typeof payload.platform !== 'string' || payload.platform === '') {
      return { data: null, error: { message: 'set-app-update-config requires a platform (android|ios)' } };
    }
  }
  if (name === 'trash-user') {
    // trash-user EF: trash → POST /users/{id}/trash; action:'restore' → /admin/users/{id}/restore
    if (typeof payload.target_user_id === 'string') {
      payload.id = payload.target_user_id;
      delete payload.target_user_id;
    }
    route = payload.action === 'restore' ? '/admin/users/{id}/restore' : '/users/{id}/trash';
    delete payload.action;
  }
  if (name === 'redeem-code-revoke' || name === 'redeem-code-archive') {
    // revoke/archive send code_id but the PHP routes use {id}
    if (typeof payload.code_id === 'string') payload.id = payload.code_id;
    delete payload.code_id;
    route = name === 'redeem-code-revoke' ? '/redeem-codes/{id}/revoke' : '/redeem-codes/{id}/archive';
  }

  if (!route) {
    return { data: null, error: { message: `Unknown function: ${name}` } };
  }

  // 2. Route templating: /courses/{id}/delete ← payload.id
  const template = route.match(/\{([^}]+)\}/g);
  if (template) {
    for (const token of template) {
      const key = token.slice(1, -1);
      const v = payload[key];
      if (v == null) return { data: null, error: { message: `Missing route parameter: ${key}` } };
      route = route.replace(token, String(v));
      delete payload[key];
    }
  }

  // 3. Payload normalization (keep the PHP controllers' named-field contracts)
  if (name === 'user-management') {
    // EF sent action: create_user|create_doctor|create_admin|create_super_admin
    const roleMap: Record<string, string> = {
      create_user: 'student', create_doctor: 'doctor', create_admin: 'admin', create_super_admin: 'super_admin',
    };
    if (typeof payload.action === 'string' && roleMap[payload.action]) payload.role = roleMap[payload.action];
    delete payload.action;
  }
  if (name === 'credits') {
    delete payload.action;
  }

  // 4. GET requests carry their body as query parameters
  if (method === 'GET') {
    const qs = new URLSearchParams(
      Object.entries(payload).reduce<Record<string, string>>((acc, [k, v]) => {
        if (v != null && typeof v !== 'object') acc[k] = String(v);
        return acc;
      }, {})
    ).toString();
    const res = await apiFetch<T>(route + (qs ? '?' + qs : ''), { method: 'GET', headers: opts.headers });
    if (res.error) return { data: null, error: { message: res.error.message } };
    return { data: res.data, error: null };
  }

  const res = await apiFetch<T>(route, {
    method,
    body: payload,
    headers: opts.headers,
  });

  if (res.error) {
    return { data: null, error: { message: res.error.message } };
  }
  return { data: res.data, error: null };
}

// ── RPC ─────────────────────────────────────────────────────────────────────

const RPC_MAP: Record<string, string> = {
  'admin_reset_violations':           '/rpc/admin-reset-violations',
  'archive_course':                   '/courses/{id}/archive',
  'check_registration_conflicts':     '/rpc/check-registration-conflicts',
  'create_course_audited':            '/rpc/create-course-audited',
  'duplicate_course':                 '/courses/{id}/duplicate',
  'get_archive_analytics':            '/analytics/archive-analytics',
  'get_archived_courses':             '/analytics/archived-courses',
  'get_chunk_upload_state':           '/rpc/chunk-upload-state',
  'get_course_delete_stats':          '/analytics/course-delete-stats/{id}',
  'get_course_progress':              '/courses/{id}/progress',
  'get_deletion_stats':               '/analytics/deletion-stats',
  'get_doctor_activity_stats':        '/rpc/doctor-activity-stats/{doctorId}',
  'get_doctor_credit_transactions':   '/rpc/doctor-credit-transactions/{doctorId}',
  'get_doctor_earnings_dashboard':    '/rpc/doctor-earnings-dashboard/{doctorId}',
  'get_doctor_student_profile':       '/rpc/doctor-student-profile',
  'get_doctor_students':              '/doctors/students',
  'get_email_by_phone':               '/rpc/get-email-by-phone',
  'get_enum_values_bulk':             '/rpc/enum-values-bulk',
  'get_lesson_video_state':           '/rpc/lesson-video-state',
  'get_my_credits_balance':           '/credits/me',
  'get_orphan_deletion_records':      '/rpc/orphan-deletion-records',
  'get_risky_devices':                '/analytics/risky-devices',
  'get_security_stats':               '/analytics/security-stats',
  'get_security_version':             '/security/version',
  'get_teacher_provider_permissions': '/rpc/teacher-provider-permissions',
  'get_trash_list':                   '/analytics/trash-list',
  'get_trash_stats':                  '/analytics/trash-stats',
  'get_user_activity':                '/analytics/user-activity/{id}',
  'get_user_profile_summary':         '/analytics/user-profile/{id}',
  'get_video_asset_usage':            '/analytics/video-asset-usage',
  'delete_video_asset':               '/video/assets/delete',
  'grant_course_access':              '/courses/grant-access',
  'lookup_user_by_identifier':        '/admin/user-lookup',
  'mark_deletion_repaired':           '/rpc/mark-deletion-repaired',
  'mark_lesson_video_missing':        '/rpc/mark-lesson-video-missing',
  'permanently_delete_course':        '/rpc/permanently-delete-course',
  'pre_login_device_check':           '/auth/pre-login-check',
  'publish_course':                   '/courses/{id}/publish',
  'recalculate_doctor_earnings':      '/analytics/recalculate-earnings/{doctorId}',
  'recover_stale_upload_sessions':    '/rpc/recover-stale-upload-sessions',
  'remove_course_enrollment':         '/rpc/remove-course-enrollment',
  'remove_student_and_record_earnings': '/rpc/remove-student-and-record-earnings',
  'reset_doctor_earnings':            '/analytics/reset-doctor-earnings/{doctorId}',
  'reset_platform_earnings':          '/analytics/reset-platform-earnings',
  'reset_user_password_by_admin':     '/rpc/reset-user-password-by-admin',
  'restore_course':                   '/courses/{id}/restore',
  'run_db_audit':                     '/analytics/db-audit',
  'search_audit_logs':                '/rpc/search-audit-logs',
  'set_doctor_credit_price':          '/rpc/set-doctor-credit-price',
  'set_enrollment_assigned_price':    '/rpc/set-enrollment-assigned-price',
  'set_user_role':                    '/admin/users/{id}/role',
  'set_user_status':                  '/admin/users/{id}/status',
  'unpublish_course':                 '/courses/{id}/unpublish',
  'update_course_audited':            '/rpc/update-course-audited',
  'upsert_teacher_provider_permission': '/rpc/upsert-teacher-provider-permission',
  'write_audit_log':                  '/admin/audit-logs',
};

// RPCs whose PHP route carries a path parameter: route token → payload key
const RPC_PATH_ALIASES: Record<string, Record<string, string>> = {
  'archive_course':                 { id: 'p_course_id' },
  'duplicate_course':               { id: 'p_course_id' },
  'get_course_delete_stats':        { id: 'p_course_id' },
  'get_course_progress':            { id: 'p_course_id' },
  'get_doctor_activity_stats':      { doctorId: 'p_doctor_id' },
  'get_doctor_credit_transactions': { doctorId: 'p_doctor_id' },
  'get_doctor_earnings_dashboard':  { doctorId: 'p_doctor_id' },
  'get_user_activity':              { id: 'p_user_id' },
  'get_user_profile_summary':       { id: 'p_user_id' },
  'publish_course':                 { id: 'p_course_id' },
  'recalculate_doctor_earnings':    { doctorId: 'p_doctor_id' },
  'reset_doctor_earnings':          { doctorId: 'p_doctor_id' },
  'restore_course':                 { id: 'p_course_id' },
  'set_user_role':                  { id: 'p_user_id' },
  'set_user_status':                { id: 'p_user_id' },
  'unpublish_course':               { id: 'p_course_id' },
};

// RPC payload keys the PHP handlers read under a DIFFERENT name
// (beyond the generic p_ → plain-key strip)
const RPC_KEY_RENAMES: Record<string, Record<string, string>> = {
  'set_user_role':                       { p_new_role: 'role' },
  'set_user_status':                     { p_new_status: 'status' },
  'get_chunk_upload_state':              { p_upload_id: 'upload_id' },
  'reset_user_password_by_admin':        { p_target_id: 'user_id' },
  'upsert_teacher_provider_permission':  { p_provider_key: 'provider', p_is_enabled: 'enabled' },
  'set_doctor_credit_price':             { p_new_price: 'price' },
  'admin_reset_violations':              { target_user_id: 'user_id' },
  // The PHP port renamed the original `p_email` arg to `identifier`
  'pre_login_device_check':              { p_email: 'identifier' },
};

// RPCs that map to GET routes (everything else POSTs)
const GET_RPCS = new Set([
  'get_archive_analytics',
  'get_archived_courses',
  'get_chunk_upload_state',
  'get_course_delete_stats',
  'get_course_progress',
  'get_deletion_stats',
  'get_doctor_activity_stats',
  'get_doctor_credit_transactions',
  'get_doctor_earnings_dashboard',
  'get_doctor_students',
  'get_lesson_video_state',
  'get_my_credits_balance',
  'get_orphan_deletion_records',
  'get_risky_devices',
  'get_security_stats',
  'get_security_version',
  'get_teacher_provider_permissions',
  'get_trash_list',
  'get_trash_stats',
  'get_user_activity',
  'get_user_profile_summary',
  'get_video_asset_usage',
  'search_audit_logs',
]);

async function rpc<T = any>(
  procedure: string,
  params?: Record<string, unknown>,
  _options?: unknown
): Promise<{ data: T | null; error: { message: string; code?: string; status?: number } | null }> {
  let route = RPC_MAP[procedure];
  if (!route) {
    return { data: null, error: { message: `Unknown RPC: ${procedure}` } };
  }

  const working: Record<string, unknown> = { ...(params ?? {}) };

  // 1. Path-parameter substitution (/{id} / {doctorId} ← p_* payload keys)
  const template = route.match(/\{([^}]+)\}/g);
  if (template) {
    const aliases = RPC_PATH_ALIASES[procedure] ?? {};
    for (const token of template) {
      const key = token.slice(1, -1);
      const payloadKey = aliases[key] ?? key;
      const v = working[payloadKey];
      if (v == null) return { data: null, error: { message: `Missing parameter: ${payloadKey}` } };
      route = route.replace(token, String(v));
      delete working[payloadKey];
    }
  }

  // 2. Explicit key renames (PHP reads plain keys, some under different names)
  const renames = RPC_KEY_RENAMES[procedure];
  if (renames) {
    for (const [from, to] of Object.entries(renames)) {
      if (working[from] !== undefined) {
        working[to] = working[from];
        delete working[from];
      }
    }
  }

  // 3. Generic p_ prefix strip → plain keys (p_phone → phone, p_limit → limit, …)
  const finalParams: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(working)) {
    finalParams[k.startsWith('p_') ? k.slice(2) : k] = v;
  }

  if (GET_RPCS.has(procedure)) {
    const qs = new URLSearchParams(
      Object.entries(finalParams).reduce<Record<string, string>>((acc, [k, v]) => {
        if (v != null && typeof v !== 'object') acc[k] = String(v);
        return acc;
      }, {})
    ).toString();
    const res = await apiFetch<T>(route + (qs ? '?' + qs : ''));
    return { data: res.data, error: res.error };
  }

  const res = await apiFetch<T>(route, { method: 'POST', body: finalParams });
  return { data: res.data, error: res.error };
}

// ── Change polling (intentional replacement for push subscriptions) ──────────

type PollingCallback = (payload: { eventType: string; new: any; old: any }) => void;

function createPoller(_name: string) {
  const listeners: Array<{ table: string; event: string; callback: PollingCallback }> = [];
  const intervals: ReturnType<typeof setInterval>[] = [];

  const poller = {
    on(event: string, opts: { event?: string; table?: string; schema?: string; filter?: string }, callback: PollingCallback) {
      const tableName = opts.table ?? _name;
      const eventType = opts.event ?? event;
      listeners.push({ table: tableName, event: eventType, callback });

      // Intentional PHP polling replacement for the former push subscription.
      // MAINTENANCE REQUEST-STORM GUARD: while the server-authoritative
      // maintenance verdict is active, these authenticated pollers can ONLY
      // receive 503 maintenance_mode (the gate blocks /api/*). Polling every
      // 5s into a guaranteed refusal is a request storm against a struggling
      // server. The canary check pauses the cycle; the maintenance service's
      // own silent recovery poll (plus the epoch re-bootstrap) covers revival,
      // and for verified-exempt identities (SA/whitelist) the gate exempts
      // their requests so the poll never pauses for them.
      let lastCheck = Date.now();
      const tick = async () => {
        try {
          // Pause while the maintenance gate is up (request-storm guard). The
          // flag reflects the SERVER's verdict; a verified-exempt identity
          // (SA/whitelist) never publishes the UI verdict, so their pollers
          // keep running and simply succeed against the exempted gate.
          if (isMaintenanceControlFlowActive()) return; // paused, silent
          const res = await apiFetch<unknown[]>(`/api/${tableName}?order=created_at.desc&limit=5`);
          if (res.data && Array.isArray(res.data)) {
            for (const row of res.data) {
              const rowTime = new Date((row as Record<string, unknown>).created_at as string).getTime();
              if (rowTime > lastCheck) {
                callback({ eventType: 'INSERT', new: row, old: null });
              }
            }
            lastCheck = Date.now();
          }
        } catch { /* ignore polling errors */ }
      };
      const interval = setInterval(tick, 5000); // Poll every 5 seconds
      intervals.push(interval);
      return poller;
    },

    subscribe(_callback?: (state: string) => void) { if (_callback) _callback('SUBSCRIBED'); return poller; },
    unsubscribe() {
      intervals.forEach(clearInterval);
      return Promise.resolve('ok');
    },
  };
  return poller;
}

// ── Composed Client ─────────────────────────────────────────────────────────

export const backendClient = {
  // Data operations
  from<T = any>(table: string): QueryBuilder<T> {
    return new QueryBuilder<T>(table);
  },

  rpc<T = any>(procedure: string, params?: Record<string, unknown>) {
    return rpc<T>(procedure, params);
  },

  // Auth
  auth: authMethods,

  // Storage
  storage: {
    from(bucket: string) { return createStorageBucket(bucket); },
    listBuckets: async () => {
      const res = await apiFetch<Array<{ id: string; name: string; public: boolean }>>('/storage/buckets');
      return { data: res.data ?? [], error: res.error };
    },
  },

  // Named server actions routed to PHP controllers
  functions: {
    invoke: invokeFunction,
  },

  // Polling subscriptions for device/revocation updates
  poll(name: string) { return createPoller(name); },

  removePoller(poller: { unsubscribe: () => Promise<string> }) {
    return poller.unsubscribe();
  },

  removeAllPollers() { return Promise.resolve(); },
};
