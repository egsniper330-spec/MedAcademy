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

import { getInstallationId, getStoredDeviceFingerprint } from '@/lib/installationId';

// ── Config ──────────────────────────────────────────────────────────────────

const API_BASE: string = (() => {
  const configured = process.env.EXPO_PUBLIC_PHP_API_URL?.trim();
  if (!configured) {
    throw new Error(
      '[BackendConfig] EXPO_PUBLIC_PHP_API_URL is required. ' +
      'Configure it as https://api.medacademy.eu.cc/backend/public/index.php.'
    );
  }
  return configured.replace(/\/$/, '');
})();

/** The sole application API base; configuration fails closed when missing. */
export const backendApiBase = API_BASE;

// ── Helpers ─────────────────────────────────────────────────────────────────

function getToken(): string | null {
  try {
    // Read the PHP session stored by the web/native session adapter
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(AUTH_KEY) ?? localStorage.getItem(LEGACY_AUTH_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return parsed?.access_token ?? parsed?.current_session?.access_token ?? null;
      }
    }
  } catch { /* ignore */ }
  return null;
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
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async (): Promise<boolean> => {
    const stored = getStoredSession();
    if (!stored?.refresh_token) return false;
    const res = await apiFetchOnce<{ session: { access_token: string; refresh_token: string } }>('/auth/refresh', {
      method: 'POST',
      body: { refresh_token: stored.refresh_token },
    });
    const s = res.data?.session;
    if (res.error || !s?.access_token || !s.refresh_token) {
      // Only invalidate the stored session on a definitive auth failure from
      // the refresh endpoint (expired/revoked/invalid refresh token). A
      // transient network error (no HTTP status) must NOT log the user out.
      const status = res.error?.status;
      if (status === 401 || status === 400 || status === 422) clearSession();
      return false;
    }
    // Persist the rotated pair; the `user` object is unchanged.
    storeSession({ access_token: s.access_token, refresh_token: s.refresh_token, user: stored.user });
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
      // PHP backend error envelope: { error: { message, code } } (or flat { message })
      const inner = (errObj.error && typeof errObj.error === 'object')
        ? errObj.error as Record<string, unknown>
        : null;
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

function storeSession(session: AuthSession): void {
  try { localStorage.setItem(AUTH_KEY, JSON.stringify(session)); } catch { /* ignore */ }
}

function clearSession(): void {
  try {
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(LEGACY_AUTH_KEY);
  } catch { /* ignore */ }
}

function getStoredSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY) ?? localStorage.getItem(LEGACY_AUTH_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as AuthSession;
    if (!localStorage.getItem(AUTH_KEY)) localStorage.setItem(AUTH_KEY, JSON.stringify(session));
    return session;
  } catch { return null; }
}

// Auth methods preserve the existing frontend contract while calling PHP
const authMethods = {
  getSession: async () => {
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
    storeSession(session);
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
    storeSession(session);
    return { data: { session, user: d.user }, error: null };
  },

  signOut: async ({ scope }: { scope?: string } = {}): Promise<{ error: { message: string; code?: string } | null }> => {
    if (scope !== 'local') {
      // 'global' or default: notify the server to revoke the refresh token so
      // the session cannot be re-established after logout.
      const session = getStoredSession();
      await apiFetch('/auth/logout', {
        method: 'POST',
        body: session?.refresh_token ? { refresh_token: session.refresh_token } : {},
      });
    }
    clearSession();
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
    // Use the provided refresh_token or the stored one
    const refreshToken = opts?.refresh_token ?? stored.refresh_token;
    const res = await apiFetch<{ session: { access_token: string; refresh_token: string } }>('/auth/refresh', {
      method: 'POST',
      body: { refresh_token: refreshToken },
    });
    if (res.error || !res.data) {
      clearSession();
      return { data: { session: null }, error: res.error };
    }
    const s = res.data.session;
    const session: AuthSession = {
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      user: stored.user,
    };
    storeSession(session);
    return { data: { session }, error: null };
  },

  setSession: async (session: { access_token: string; expires_at?: number; refresh_token?: string }) => {
    const existing = getStoredSession();
    const user = existing?.user ?? { id: '', email: null, phone: null };
    storeSession({ access_token: session.access_token, refresh_token: existing?.refresh_token ?? '', user });
    return { error: null };
  },

  verifyOtp: async ({ phone, email, token, type, email_otp }: { phone?: string; email?: string; token?: string; type?: string; email_otp?: string }) => {
    const res = await apiFetch<{ user: AuthUser; session: { access_token: string; refresh_token: string } }>('/auth/login', {
      method: 'POST', body: { phone, email, token: token ?? email_otp, type },
    });
    if (res.error) return { data: { session: null, user: null }, error: res.error };
    const d = res.data!;
    const session: AuthSession = { access_token: d.session.access_token, refresh_token: d.session.refresh_token, user: d.user };
    storeSession(session);
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
  'admin-doctor-earnings':  '/analytics/doctor-earnings',
  'admin-enrollment':       '/admin/enrollment',
  'admin-update-email':     '/admin/update-email',
  'block-user':             '/admin/users/{id}/block',
  'device-binding':         '/device-binding',
  'get-security-config':    '/security/config',
  'get-security-version':   '/security/version',
  'get-signed-url':         '/storage/signed-url',
  'impersonate':            '/auth/impersonate',
  'process-violation':      '/security/violations',
  'provider-health':        '/provider-health',
  'restore-account':        '/admin/users/{id}/restore',
  'security-logger':        '/security/events',
  'student-operations':     '/student-operations',
  'system-health':          '/system-health',
  'vdocipher-otp':          '/video/otp',
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
};

// Multi-action Edge Functions (original EF dispatches on body.action)
const EDGE_ACTION_MAP: Record<string, Record<string, string>> = {
  'credits': {
    allocate:       '/credits/allocate',
    bulk_allocate:  '/credits/bulk-allocate',
    revoke:         '/credits/revoke',
    refund:         '/credits/refund',
  },
  'activation-codes': {
    batch_create:    '/activation-codes/batch-create',
    clone_batch:     '/activation-codes/clone-batch',
    deactivate:      '/activation-codes/deactivate',
    reactivate:      '/activation-codes/reactivate',
    bulk_delete:     '/activation-codes/bulk-delete',
    bulk_disable:    '/activation-codes/deactivate',
    bulk_enable:     '/activation-codes/reactivate',
    disable_batch:   '/activation-codes/deactivate',
    enable_batch:    '/activation-codes/reactivate',
    hard_delete_batch: '/activation-codes/bulk-delete',
    delete_code:     '/activation-codes/bulk-delete',
  },
};

// Edge Functions whose PHP routes are GET-only (config/version/health probes)
const GET_FUNCTIONS = new Set(['get-security-config', 'get-security-version', 'provider-health']);
// Edge Functions whose PHP routes are POST-only regardless of the caller's
// requested method (the original vdocipher-upload-status EF used GET; the PHP
// route /video/upload-status accepts POST with a JSON body).
const FORCE_POST_FUNCTIONS = new Set(['vdocipher-upload-status']);

async function invokeFunction<T = any>(
  name: string,
  opts: { body?: unknown; method?: string; headers?: Record<string, string> } = {}
): Promise<{ data: T | null; error: { message: string; context?: { text: () => Promise<string> } } | null }> {
  const method = FORCE_POST_FUNCTIONS.has(name) ? 'POST' : (opts.method ?? (GET_FUNCTIONS.has(name) ? 'GET' : 'POST'));
  const payload = (opts.body ?? {}) as Record<string, unknown>;

  // 1. Resolve the PHP route (static map, action dispatch, or special cases)
  let route = EDGE_FUNCTION_MAP[name];

  if (!route && EDGE_ACTION_MAP[name] && typeof payload.action === 'string') {
    route = EDGE_ACTION_MAP[name][payload.action] ?? undefined;
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
  if (name === 'trash-user') {
    // trash-user EF: trash → POST /users/{id}/trash; action:'restore' → /admin/users/{id}/restore
    if (typeof payload.target_user_id === 'string') {
      payload.id = payload.target_user_id;
      delete payload.target_user_id;
    }
    route = payload.action === 'restore' ? '/admin/users/{id}/restore' : '/users/{id}/trash';
    delete payload.action;
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
  if (name === 'activation-codes') {
    if (payload.action === 'delete_code' && payload.code_id != null && !Array.isArray(payload.code_ids)) {
      // Single hard delete → bulk-delete with one id (PHP bulk-delete is the only hard-delete route)
      payload.code_ids = [payload.code_id];
      delete payload.code_id;
    }
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
  'redeem_activation_code':           '/activation-codes/redeem',
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

      // Intentional PHP polling replacement for the former push subscription
      let lastCheck = Date.now();
      const interval = setInterval(async () => {
        try {
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
      }, 5000); // Poll every 5 seconds
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
