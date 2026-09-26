/**
 * impersonationService — the ONE authoritative impersonation contract.
 *
 * Backend contract (PHP POST /auth/impersonate, super_admin-only):
 *   Request : { target_user_id }
 *   200     : { session: { access_token, refresh_token, expires_in, token_type },
 *               target: { id, email, role, full_name, status, ... } }
 *   Errors  : 401 unauthenticated · 403 not-super-admin / super-admin target /
 *             suspended target · 404 unknown target · 422 missing id · 400
 *             self-target · 5xx (maintenance 503 / update 426 via transport).
 *
 * The backend is STATELESS per request (each call issues a FRESH token pair
 * registered in refresh_tokens; no server-side "active impersonation" row
 * blocks repeats) — repeatability is therefore a CLIENT lifecycle contract:
 *
 *   SUPER_ADMIN_NORMAL → IMPERSONATION_STARTING → IMPERSONATED_USER_ACTIVE
 *                      → IMPERSONATION_EXITING → SUPER_ADMIN_RESTORING → back.
 *
 * Success is CONFIRMED, not assumed: startImpersonationSession resolves only
 * after the swap is installed AND the target's profile has actually loaded
 * from the backend. Only then may the caller show the banner.
 */
import { backendClient } from '@/client/backendClient';
import { getProfile } from '@/lib/api';
import {
  useImpersonationStore, useProfileStore, type UserRole,
  peekImpersonationSnapshot, dropImpersonationSnapshot,
} from '@/lib/store';

interface PhpSession {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  token_type?: string;
}

/** Structured, user-presentable error for a failed impersonation attempt. */
export class ImpersonationError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ImpersonationError';
    this.status = status;
  }
}

function statusMessage(status: number, fallback: string): string {
  switch (status) {
    case 400: return 'You cannot impersonate your own account.';
    case 401: return 'Your session expired. Sign in again and retry.';
    case 403: return fallback; // backend supplies the specific policy reason
    case 404: return 'That user no longer exists.';
    case 422: return fallback;
    case 429: return 'Too many attempts. Please wait a moment.';
    case 503: return 'The server is under maintenance. Try again later.';
    default:  return fallback;
  }
}

/** How long the target profile may take to confirm before we abort + restore. */
const CONFIRM_TIMEOUT_MS = 20_000;

/**
 * WEB-RELOAD RE-ARM.
 *
 * A web page reload keeps the persisted (localStorage) auth session — which
 * after a swap is the TARGET's — but wipes the in-memory impersonation store.
 * Without re-arm: no banner, no restore context, Super Admin stranded in the
 * target account until manual logout. With re-arm:
 *
 *   • snapshot exists AND the current session is the target's
 *       → restore the in-memory impersonation state; banner + Exit come back.
 *   • snapshot exists but the session no longer matches (logged out, signed
 *       in as someone else, or the Super Admin already restored)
 *       → drop the snapshot; never resurrect a stale impersonation.
 *
 * sessionStorage is tab-scoped, dies with the tab, and never reaches disk —
 * the restore context stays unreadable to the impersonated user and cannot
 * survive into a fresh session. Native is a no-op (no reload path exists).
 *
 * Safe to call unconditionally at app boot (root layout, once).
 */
export function rearmImpersonationAfterReload(): void {
  if (process.env.EXPO_OS !== 'web') return;
  const snap = peekImpersonationSnapshot();
  if (!snap) return;
  try {
    // The impersonation store is authoritative in-memory; if it already says
    // active (e.g. double-invocation) keep it in sync and stop.
    if (useImpersonationStore.getState().impersonation.active) {
      dropImpersonationSnapshot();
      return;
    }
    // The snapshot is only valid while the CURRENT persisted session IS the
    // target's. The persisted session after a reload is the swapped pair —
    // its access token must NOT equal the original (Super Admin) token.
    void backendClient.auth.getSession().then(({ data: { session } }) => {
      const stillImpersonating = !!session?.access_token && session.access_token !== snap.originalAccessToken;
      if (stillImpersonating && snap.originalAccessToken) {
        useImpersonationStore.getState().startImpersonation(
          snap.originalAccessToken,
          snap.originalRefreshToken ?? '',
          snap.originalEmail ?? '',
          snap.originalUserId ?? '',
          (snap.originalRole ?? 'super_admin') as UserRole,
          snap.targetName ?? 'user',
          (snap.targetRole ?? 'student') as UserRole,
        );
      } else {
        dropImpersonationSnapshot();
      }
    }).catch(() => dropImpersonationSnapshot());
  } catch { /* never block boot */ }
}

/**
 * Start impersonating `targetUserId`. Performs the REAL session swap and
 * RESOLVES ONLY ON CONFIRMED SUCCESS — the target's profile must actually
 * load. On any failure the original Super-Admin state is fully restored
 * before this throws, so the app is never left in an ambiguous state.
 *
 * Safe to call repeatedly with different or the same targets; also safe to
 * call while ALREADY impersonating (performs an atomic A→B switch: A's
 * context is ended server-side, then B is started).
 */
export async function startImpersonationSession(
  targetUserId: string,
  targetName: string,
  targetRole: UserRole,
): Promise<void> {
  // ── 0. Already impersonating? End the CURRENT impersonation atomically ──
  // (A→B switch). The end call restores the ORIGINAL super-admin session into
  // the impersonation store (fresh snapshot), so step 1 below snapshots the
  // genuine Super-Admin session — never B's — before starting B.
  if (useImpersonationStore.getState().impersonation.active) {
    await endImpersonationSession();
  }

  // ── 1. Snapshot the ORIGINAL (Super Admin) session BEFORE any swap. ────
  const { data: { session: currentSession } } = await backendClient.auth.getSession();
  if (!currentSession?.access_token) {
    throw new ImpersonationError(401, 'No active session to save.');
  }

  // The actor's authoritative role — from the hydrated profile store, never
  // guessed. Without it the banner cannot restore the correct dashboard.
  const actorProfile = useProfileStore.getState().profile;
  const originalRole = (actorProfile?.role ?? 'super_admin') as UserRole;

  // ── 2. Backend call. Authorization + target rules + `impersonation_started`
  //       audit all happen server-side. ────────────────────────────────────
  const res = await backendClient.functions.invoke('impersonate', {
    body: { target_user_id: targetUserId },
  });
  if (res.error) {
    const status = (res.error as { status?: number }).status ?? 0;
    throw new ImpersonationError(status, statusMessage(status, res.error.message || 'Impersonation failed.'));
  }
  const data = res.data as { session?: PhpSession; target?: { id?: string; full_name?: string; role?: string; email?: string | null } } | null;

  // Contract check: the backend MUST return a target session pair. A
  // malformed/empty response is a hard failure — never treated as success.
  const targetSession = data?.session;
  if (!targetSession?.access_token || !targetSession.refresh_token) {
    throw new ImpersonationError(0, 'Server returned an invalid impersonation session.');
  }

  // ── 3. Persist the original context (in-memory only — the impersonated
  //       user can never read or edit it). ─────────────────────────────────
  useImpersonationStore.getState().startImpersonation(
    currentSession.access_token,
    currentSession.refresh_token ?? '',
    actorProfile?.email ?? currentSession.user?.email ?? '',
    actorProfile?.id ?? currentSession.user?.id ?? '',
    originalRole,
    targetName || data?.target?.full_name || 'user',
    targetRole || ((data?.target?.role as UserRole) ?? 'student'),
  );

  // ── 4. REAL identity switch — swap the persisted auth session to the
  //       target's token pair. setSession now emits SIGNED_IN synchronously,
  //       so the (app) layout effect (keyed on session.user.id) starts the
  //       TARGET's bootstrap in the same task. ─────────────────────────────
  await backendClient.auth.setSession({
    access_token: targetSession.access_token,
    refresh_token: targetSession.refresh_token,
    user: { id: data?.target?.id ?? targetUserId, email: data?.target?.email ?? null, phone: null } as never,
  });

  // Drop the cached Super-Admin profile so the layout's hydration guard
  // re-fetches for the TARGET. (The layout effect fires on the SIGNED_IN
  // emission above; the store being already-clear avoids a flash of stale UI.)
  useProfileStore.getState().clearProfile();

  // ── 5. CONFIRM the target account actually loads. Success is NOT the HTTP
  //       200 — it is the target's profile resolving through the real API
  //       with the target's token. Everything here restores the original
  //       session on failure so no ambiguous state can survive. ────────────
  const confirmTarget = async (): Promise<void> => {
    const p = await getProfile(data?.target?.id ?? targetUserId);
    if (!p || (!p.role && !p.status)) {
      throw new Error('target profile incomplete');
    }
  };
  try {
    await Promise.race([
      confirmTarget(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('impersonation confirmation timed out')), CONFIRM_TIMEOUT_MS)),
    ]);
  } catch (err) {
    // Roll back to the Super-Admin session — the impersonation did NOT take.
    await backendClient.auth.setSession({
      access_token: currentSession.access_token,
      refresh_token: currentSession.refresh_token ?? '',
      user: { id: currentSession.user?.id ?? '', email: currentSession.user?.email ?? null, phone: null } as never,
    });
    useImpersonationStore.getState().endImpersonation();
    useProfileStore.getState().clearProfile();
    const msg = err instanceof Error && /timeout/.test(err.message)
      ? 'The target account did not load in time. Impersonation was cancelled.'
      : 'The target account could not be loaded. Impersonation was cancelled.';
    throw new ImpersonationError(0, msg);
  }
}

/**
 * End the impersonation session. Audited server-side with the TARGET's
 * (current) token, then the original Super-Admin session is restored and
 * confirmed (its profile reloads) before this resolves.
 */
export async function endImpersonationSession(): Promise<void> {
  // 1. Server-audited end — the CURRENT token is the target's, which is what
  //    /auth/impersonation/end expects (it audits against the target id).
  try {
    await backendClient.functions.invoke('impersonation-end', { body: {} });
  } catch {
    // Network/5xx on the audit call must not trap the Super Admin inside the
    // impersonated account — restore proceeds; the failure is visible to the
    // backend logs via the request itself.
  }

  // 2. Restore the original session.
  const { impersonation } = useImpersonationStore.getState();
  if (impersonation.originalAccessToken) {
    const { error } = await backendClient.auth.setSession({
      access_token: impersonation.originalAccessToken,
      refresh_token: impersonation.originalRefreshToken ?? '',
      user: { id: impersonation.originalUserId, email: impersonation.originalEmail, phone: null } as never,
    });
    if (error) {
      // Original token expired while impersonating → clean sign-out rather
      // than a half-restored state.
      await backendClient.auth.signOut();
    }
  } else {
    await backendClient.auth.signOut();
  }

  // 3. Reset local state and force authoritative re-hydration.
  useImpersonationStore.getState().endImpersonation();
  useProfileStore.getState().clearProfile();

  // 4. CONFIRM the Super-Admin profile reloads (best-effort): a failure here
  //    must not trap anyone — the (app) layout bootstrap retries on its own
  //    lifecycle (foreground/epoch) — but resolving after the profile store
  //    has re-populated makes "restored" a confirmed fact, not an assumption.
  const uid = impersonation.originalUserId;
  if (uid) {
    try {
      await Promise.race([
        getProfile(uid),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('restore confirmation timed out')), CONFIRM_TIMEOUT_MS)),
      ]);
    } catch {
      // Non-fatal: the layout bootstrap owns recovery/retry.
    }
  }
}
