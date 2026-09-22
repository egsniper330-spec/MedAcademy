/**
 * creditService — Single Source of Truth for the Credits system.
 *
 * ALL balance reads and mutations MUST go through this module.
 * No screen may bypass the PHP credit service for credit data.
 *
 * Architecture:
 *   Read  balance  → get_my_credits_balance RPC (SECURITY DEFINER, reads own row)
 *   Read  history  → get_doctor_credit_transactions RPC (SECURITY DEFINER)
 *   Write (enroll) → grant_course_access RPC (SECURITY DEFINER, fully atomic)
 *   Write (admin)  → credits Edge Function (admin/super_admin only)
 *
 * Cache:
 *   In-memory, 30-second TTL.
 *   Invalidated immediately after any mutation.
 *   All consumers get the same cached value within the TTL window.
 */

import { backendClient } from '@/client/backendClient';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CreditBalance {
  allocated: number;
  consumed: number;
  remaining: number;
  /** Alias for allocated — used by some legacy UI fields */
  total_allocated: number;
  /** Alias for consumed — used by some legacy UI fields */
  used: number;
  updated_at?: string;
}

export interface CreditTransaction {
  id: string;
  transaction_type: string;
  amount: number;
  notes: string | null;
  balance_before: number | null;
  balance_after: number | null;
  created_at: string;
  course_title: string | null;
  student_name: string | null;
}

export interface EnrollResult {
  success: boolean;
  idempotent?: boolean;
  balance_before?: number;
  balance_after?: number;
  transaction_id?: string;
}

// ── In-memory cache ────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000; // 30 seconds

let _cachedBalance: CreditBalance | null = null;
let _cacheTimestamp = 0;
let _inflightPromise: Promise<CreditBalance> | null = null;

function isCacheValid(): boolean {
  return _cachedBalance !== null && Date.now() - _cacheTimestamp < CACHE_TTL_MS;
}

/** Invalidate cache immediately — call after any credit mutation. */
export function invalidateCreditCache(): void {
  _cachedBalance = null;
  _cacheTimestamp = 0;
  _inflightPromise = null;
}

// ── Balance ────────────────────────────────────────────────────────────────────

/**
 * Get the calling doctor's credit balance.
 * Uses in-memory cache (30 s TTL). Cache is shared — all concurrent callers
 * share one in-flight request so the DB is never hit twice in parallel.
 */
export async function getCreditBalance(): Promise<CreditBalance> {
  // Return from cache if still valid
  if (isCacheValid()) return _cachedBalance!;

  // Deduplicate concurrent callers — only one network request at a time
  if (_inflightPromise) return _inflightPromise;

  _inflightPromise = (async (): Promise<CreditBalance> => {
    const { data, error } = await backendClient.rpc('get_my_credits_balance');
    if (error) throw error;
    // PHP route /credits/me returns { credits: { allocated, consumed, remaining } } —
    // unwrap the envelope. (Older Supabase RPC returned the row flat; accept both.)
    const raw = (data as { credits?: Partial<CreditBalance> } | null)?.credits ?? data;
    const bal: CreditBalance = {
      allocated: Number(raw?.allocated ?? 0),
      consumed: Number(raw?.consumed ?? 0),
      remaining: Number(raw?.remaining ?? 0),
      total_allocated: Number(raw?.allocated ?? 0),
      used: Number(raw?.consumed ?? 0),
      updated_at: raw?.updated_at,
    };
    _cachedBalance = bal;
    _cacheTimestamp = Date.now();
    _inflightPromise = null;
    return bal;
  })();

  return _inflightPromise;
}

/** Force-refresh the balance, bypassing cache. */
export async function refreshCreditBalance(): Promise<CreditBalance> {
  invalidateCreditCache();
  return getCreditBalance();
}

// ── Transactions / History ─────────────────────────────────────────────────────

/**
 * Fetch the CALLING user's credit transaction history (newest first).
 *
 * The PHP RPC route is /rpc/doctor-credit-transactions/{doctorId} — the path
 * parameter is REQUIRED by the client's route template. It defaults to the
 * authenticated session's own user id so a screen can never accidentally
 * query another account's history; the backend additionally authorizes that
 * the caller may read the requested doctor's rows.
 */
export async function getCreditHistory(limit = 200): Promise<CreditTransaction[]> {
  const { data: sessionData } = await backendClient.auth.getSession();
  const userId = sessionData?.session?.user?.id ?? '';
  const { data, error } = await backendClient.rpc('get_doctor_credit_transactions', {
    p_doctor_id: userId,
    p_limit: limit,
  });
  if (error) throw error;
  // PHP returns { transactions: [...] } — unwrap the envelope (accept flat array too).
  const rows = Array.isArray(data) ? data : (data as { transactions?: unknown[] } | null)?.transactions;
  return (rows ?? []) as CreditTransaction[];
}

// ── Enrollment (atomic) ────────────────────────────────────────────────────────

/**
 * Enroll an EXISTING student in a course via doctor credits.
 *
 * Routes through the student-operations Edge Function (service-role client)
 * which calls process_student_activation RPC atomically:
 *   lock credits → verify ≥1 → insert enrollment → deduct → ledger → audit
 *
 * Invalidates credit cache on success.
 *
 * @throws Error with structured message from the backend (INSUFFICIENT_CREDITS, etc.)
 */
export async function enrollStudentViaCredits(
  studentId: string,
  courseId: string,
): Promise<EnrollResult> {
  const { processStudentOperation } = await import('./api');
  const result = await processStudentOperation({
    mode:       'enroll_existing_credits',
    student_id: studentId,
    course_id:  courseId,
  });

  // Invalidate so next getCreditBalance() fetches fresh data from DB
  invalidateCreditCache();

  return {
    success:         result.success,
    idempotent:      result.activation?.idempotent,
    balance_before:  result.activation?.balance_before,
    balance_after:   result.activation?.balance_after,
    transaction_id:  result.activation?.transaction_id,
  };
}
