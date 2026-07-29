/**
 * creditService — Single Source of Truth for the Credits system.
 *
 * ALL balance reads and mutations MUST go through this module.
 * No screen may call Supabase directly for credit data.
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

import { supabase } from '@/client/supabase';

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
    const { data, error } = await supabase.rpc('get_my_credits_balance');
    if (error) throw error;
    const bal = data as CreditBalance;
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
 * Fetch the calling doctor's credit transaction history (newest first).
 * Not cached — always fresh, so history is never stale.
 */
export async function getCreditHistory(limit = 200): Promise<CreditTransaction[]> {
  const { data, error } = await supabase.rpc('get_doctor_credit_transactions', {
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []) as CreditTransaction[];
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
