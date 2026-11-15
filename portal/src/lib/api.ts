/**
 * MedAcademy portal API client.
 *
 * - Access token lives in memory only.
 * - Refresh token lives in sessionStorage, so closing the tab ends the session.
 * - One single-flight refresh, retried once on 401.
 * - Never derives the API origin from user input.
 */

import { isStaffRole } from './permissions';

const RAW_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'https://api.medacademy.site';
export const API_BASE = RAW_BASE.replace(/\/+$/, '');

const REFRESH_KEY = 'med_portal_refresh';

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;
  /** Seconds from a 429 Retry-After header, when the server sent a valid value. */
  retryAfter?: number;

  constructor(message: string, status = 0, code?: string, details?: unknown, retryAfter?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get('Retry-After');
  if (!raw || !/^\d+$/.test(raw.trim())) return undefined;
  const seconds = Number(raw.trim());
  return seconds > 0 ? seconds : undefined;
}

export interface PublicUser {
  id: string;
  email: string | null;
  full_name: string | null;
  phone?: string | null;
  phone_e164?: string | null;
  role: 'student' | 'doctor' | 'admin' | 'super_admin' | 'assistant';
  status: string;
  avatar_url?: string | null;
  watermark_id?: string | null;
  public_user_id?: string | null;
  university_id?: string | null;
  faculty_id?: string | null;
  academic_level_id?: string | null;
  contact_whatsapp?: string | null;
  contact_telegram?: string | null;
  contact_phone?: string | null;
  created_at?: string;
}

export interface Session {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export interface LoginResponse {
  user: PublicUser;
  session: Session;
  device?: unknown;
}

type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, QueryValue>;
  auth?: boolean;
  retry?: boolean;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

let accessToken: string | null = null;
let refreshPromise: Promise<boolean> | null = null;
let authExpiredHandler: (() => void) | null = null;

export function onAuthExpired(handler: () => void): () => void {
  authExpiredHandler = handler;
  return () => {
    if (authExpiredHandler === handler) authExpiredHandler = null;
  };
}

export function getRefreshToken(): string | null {
  try {
    return sessionStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

export function setSession(session: Session | null): void {
  accessToken = session?.access_token ?? null;
  try {
    if (session?.refresh_token) sessionStorage.setItem(REFRESH_KEY, session.refresh_token);
    else sessionStorage.removeItem(REFRESH_KEY);
  } catch {
    /* storage may be unavailable in hardened browsers */
  }
}

export function clearSession(): void {
  accessToken = null;
  try {
    sessionStorage.removeItem(REFRESH_KEY);
  } catch {
    /* ignore */
  }
}

export function hasAccessToken(): boolean {
  return accessToken !== null;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, `${API_BASE}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function messageFrom(payload: unknown, fallback: string): string {
  if (typeof payload === 'string' && payload.trim()) return payload;
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail']) {
      const value = obj[key];
      if (typeof value === 'string' && value) return value;
      // The PHP API wraps failures as {"error":{"message":…,"code":…}}.
      if (value && typeof value === 'object') {
        const nested = (value as Record<string, unknown>).message;
        if (typeof nested === 'string' && nested) return nested;
      }
    }
  }
  return fallback;
}

function codeFrom(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const obj = payload as Record<string, unknown>;
  if (typeof obj.code === 'string') return obj.code;
  const nested = obj.error;
  if (nested && typeof nested === 'object' && typeof (nested as Record<string, unknown>).code === 'string') {
    return (nested as Record<string, unknown>).code as string;
  }
  return undefined;
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function refreshSession(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  const token = getRefreshToken();
  if (!token) return false;

  refreshPromise = (async () => {
    try {
      const response = await fetch(buildUrl('/auth/refresh'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: token }),
        credentials: 'omit',
      });
      const payload = await parseResponse(response);
      if (!response.ok) return false;
      const session = (payload as { session?: Session } | null)?.session;
      if (!session?.access_token) return false;
      setSession(session);
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();

  const ok = await refreshPromise;
  if (!ok) {
    clearSession();
    authExpiredHandler?.();
  }
  return ok;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, auth = true, retry = true, signal, headers = {} } = options;

  const doFetch = async (): Promise<Response> => {
    const requestHeaders: Record<string, string> = { Accept: 'application/json', ...headers };
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (auth && accessToken) requestHeaders.Authorization = `Bearer ${accessToken}`;
    return fetch(buildUrl(path, query), {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      signal,
      cache: 'no-store',
    });
  };

  let response: Response;
  try {
    response = await doFetch();
  } catch (error) {
    if ((error as { name?: string }).name === 'AbortError') throw error;
    throw new ApiError('Network error. Check your connection and try again.', 0, 'network_error');
  }

  if (response.status === 401 && auth && retry && getRefreshToken()) {
    const refreshed = await refreshSession();
    if (refreshed) return request<T>(path, { ...options, retry: false });
  }

  const payload = await parseResponse(response);
  if (!response.ok) {
    const code = codeFrom(payload);
    if (response.status === 401) {
      clearSession();
      authExpiredHandler?.();
    }
    throw new ApiError(
      messageFrom(payload, `Request failed (${response.status})`),
      response.status,
      code,
      payload,
      response.status === 429 ? retryAfterSeconds(response) : undefined,
    );
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal) =>
    request<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string, query?: Record<string, QueryValue>) =>
    request<T>(path, { method: 'DELETE', query }),
};

export async function login(identifier: string, password: string): Promise<PublicUser> {
  const data = await request<LoginResponse>('/portal/auth/login', {
    method: 'POST',
    auth: false,
    body: { identifier: identifier.trim(), password },
  });
  if (!data?.session?.access_token || !data.session.refresh_token) {
    throw new ApiError('The server did not return a portal session.', 500, 'invalid_session');
  }
  if (!isStaffRole(data.user?.role)) {
    clearSession();
    throw new ApiError('This account is not permitted to use the staff portal.', 403, 'portal_role_forbidden');
  }
  setSession(data.session);
  return data.user;
}

export async function restoreSession(): Promise<PublicUser | null> {
  if (!getRefreshToken()) return null;
  const refreshed = await refreshSession();
  if (!refreshed) return null;
  try {
    const data = await api.get<{ user: PublicUser }>('/auth/me');
    if (!isStaffRole(data.user.role)) {
      await logout();
      return null;
    }
    return data.user;
  } catch {
    clearSession();
    return null;
  }
}

export async function logout(): Promise<void> {
  const token = getRefreshToken();
  try {
    if (token) await api.post('/auth/logout', { refresh_token: token });
  } catch {
    /* local sign-out must always succeed */
  } finally {
    clearSession();
  }
}

/** Multipart upload with byte progress (XHR, because fetch has no upload progress). */
export function uploadFile<T>(
  path: string,
  formData: FormData,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', buildUrl(path));
    xhr.withCredentials = false;
    if (accessToken) xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
    xhr.setRequestHeader('Accept', 'application/json');

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new ApiError('Upload failed. Check your connection.', 0, 'upload_network'));
    xhr.onabort = () => reject(new ApiError('Upload cancelled.', 0, 'upload_aborted'));
    xhr.onload = () => {
      let payload: unknown = null;
      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        payload = xhr.responseText;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload as T);
      } else {
        reject(new ApiError(
          messageFrom(payload, `Upload failed (${xhr.status})`),
          xhr.status,
          (payload as { code?: string } | null)?.code,
          payload,
        ));
      }
    };
    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(formData);
  });
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
