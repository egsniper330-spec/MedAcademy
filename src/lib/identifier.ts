// src/lib/identifier.ts
// Shared utilities for identifier detection and phone normalization.
// Used by sign-in, registration, user-search, credits, and admin screens.

import { supabase } from '@/client/supabase';

export type IdentifierType = 'email' | 'phone' | 'user_id' | 'name';

/**
 * Detect what kind of identifier the user typed.
 * Used to switch keyboard type and icon on sign-in.
 */
export function detectIdentifierType(value: string): IdentifierType {
  const v = value.trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return 'user_id';
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return 'email';
  // 4+ chars: covers short test numbers (e.g. "11223") as well as full E.164 / local formats
  if (/^[\+0-9\s\-\.\(\)]{4,}$/.test(v)) return 'phone';
  return 'name';
}

/**
 * Normalize a phone number to E.164 format on the client side.
 * Mirrors the DB normalize_phone_e164() function.
 * Default country: Egypt (+20) for ambiguous local numbers.
 *
 * Accepted formats → normalized result:
 *   +201020182886   → +201020182886  (already E.164)
 *   00201020182886  → +201020182886  (00-prefix)
 *   201020182886    → +201020182886  (country code without +)
 *   01020182886     → +201020182886  (local with leading 0)
 *   1020182886      → +201020182886  (national bare 10-digit)
 */
export function normalizePhoneE164(phone: string): string | null {
  const cleaned = phone.replace(/[\s\-\.\(\)]/g, '');
  if (!cleaned) return null;

  // Already E.164
  if (/^\+[1-9][0-9]{6,14}$/.test(cleaned)) return cleaned;

  // 00XX prefix → +XX  (e.g. 00201020182886 → +201020182886)
  if (/^00[1-9][0-9]{6,14}$/.test(cleaned)) return '+' + cleaned.slice(2);

  // Country code without + — e.g. 201020182886 (12 digits: EG code 20 + 10-digit national)
  if (/^20[1-9][0-9]{8,9}$/.test(cleaned)) return '+' + cleaned;

  // Egyptian mobile 01x with leading zero — e.g. 01020182886
  if (/^0[1-9][0-9]{8,9}$/.test(cleaned)) return '+20' + cleaned.slice(1);

  // Bare 10-digit Egyptian national number — e.g. 1020182886
  if (/^1[0-9]{9}$/.test(cleaned)) return '+20' + cleaned;

  return null;
}

/**
 * Format an E.164 number for display in the national format of its country.
 * Delegates to phone.ts which uses the full COUNTRIES catalogue, supporting
 * every country in the system without hardcoding.
 *
 * +201020182886  →  01020182886  (Egypt)
 * +12125551234   →  2125551234   (US — no leading 0)
 */
export { displayPhoneNational } from '@/lib/phone';

/**
 * Detect lookup method label for audit logs.
 */
export function getLookupMethod(identifier: string): string {
  return detectIdentifierType(identifier.trim());
}

/**
 * Given an email, phone, or user_id: return the email address to use for
 * Supabase Auth sign-in.  For phone-based lookup we call the
 * `get_email_by_phone` RPC (SECURITY DEFINER, callable by anon) which
 * bypasses RLS.  Querying profiles directly would fail because all
 * RLS policies on profiles require `authenticated` role — but at
 * sign-in time the user is not yet authenticated (anon role).
 */
export async function resolveEmailFromIdentifier(identifier: string): Promise<string | null> {
  const type = detectIdentifierType(identifier);

  if (type === 'email') return identifier.trim().toLowerCase();

  if (type === 'user_id') {
    // user_id lookup also needs to bypass RLS — use service-level RPC
    const { data } = await supabase
      .rpc('get_email_by_phone', { p_phone: identifier.trim() });
    // user_id is not a phone; fall back to direct query (runs as anon — may fail,
    // but user_id sign-in is admin-only so user is already authenticated)
    if (data) return data;
    // Direct query fallback (authenticated context only)
    const { data: row } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', identifier.trim())
      .maybeSingle();
    return row?.email ?? null;
  }

  if (type === 'phone') {
    // ── CRITICAL: do NOT query profiles directly here ────────────────────────
    // All profiles SELECT policies are `TO authenticated` only.
    // This function is called BEFORE sign-in, so the client is `anon`.
    // Direct table query returns 0 rows → null → "No account found".
    //
    // Solution: call get_email_by_phone() which is SECURITY DEFINER
    // and explicitly GRANTed to anon, so it bypasses RLS safely.
    //
    // IMPORTANT: always call the RPC even when normalizePhoneE164 returns null.
    // The RPC has a raw-phone fallback (v69) that matches profiles.phone directly,
    // so non-Egyptian / test / short numbers are still found.
    // Passing e164 (when available) gets the fastest path; falling back to raw
    // input still works because the RPC tries both.
    const e164 = normalizePhoneE164(identifier.trim());
    const lookupPhone = e164 ?? identifier.trim();   // never skip the RPC call
    const { data, error } = await supabase
      .rpc('get_email_by_phone', { p_phone: lookupPhone });
    if (error) {
      console.error('[resolveEmailFromIdentifier] RPC error:', error.message);
      return null;
    }
    return data ?? null;
  }

  // ── 'name' fallback: try phone lookup in case short/unusual number slipped
  // through detectIdentifierType (e.g. digits-only string shorter than the phone
  // regex threshold, or an unexpected format). This is a best-effort safety net.
  if (type === 'name') {
    const rawTrimmed = identifier.trim();
    // Only attempt if the string looks like it could be a phone (digits only / + prefix)
    if (/^[\+]?[0-9]+$/.test(rawTrimmed)) {
      const e164 = normalizePhoneE164(rawTrimmed);
      const lookupPhone = e164 ?? rawTrimmed;
      const { data } = await supabase
        .rpc('get_email_by_phone', { p_phone: lookupPhone });
      if (data) return data;
    }
    return null;
  }

  return null;
}
