/**
 * integrityClient — client half of the SERVER-BOUND Play Integrity flow.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Principle: the client can be tampered with, so the client NEVER decides
 * security outcomes. This helper only PROVES to the backend that the running
 * binary is the genuine production app. The proof chain:
 *
 *   1. get_nonce  → server issues a single-use 256-bit request_hash bound to
 *                   (this user, this protected action). 5-minute TTL.
 *   2. The hash is handed to Google's Play Integrity API (classic request
 *      nonce) — Google signs it INTO the integrity token.
 *   3. verify     → the backend decodes the token via Google's own API,
 *      checks requestHash/package/cert/verdicts, and persists a verdict row.
 *   4. The protected API call carries the hash in the X-Integrity-Hash
 *      header; the backend matches it against ITS OWN verdict row.
 *
 * A modified APK that suppresses steps 1–3 simply sends no header. Whether
 * that is tolerated is a SERVER-side policy decision (security_config
 * extras.play_integrity.actions.<action> = log_only | enforce) — never a
 * client decision. On the default log_only tier nothing here blocks anyone.
 *
 * Design notes:
 *  - Fail-open by design at the CLIENT layer (returns null): a Play-Services-
 *    less device (legitimate sideload scenario) or a transient Google outage
 *    must not crash UX. The server still applies its own tier.
 *  - The verdict is bound to ONE action; the in-memory cache below is keyed
 *    to the same TTL the server enforces (5 min) so a fresh hash is fetched
 *    for each protected action window. Nothing here is ever treated by the
 *    server as proof on its own.
 */

import { Platform } from 'react-native';
import { backendClient } from '@/client/backendClient';
import { requestPlayIntegrityToken } from '@/lib/nativeSecurity';

/** Server verdict TTL is 300s; refresh our hash slightly before expiry. */
const CACHE_TTL_MS = 4 * 60 * 1000;

let _cached: { hash: string; fetchedAt: number } | null = null;

/** Test hook. */
export function resetIntegrityCache(): void {
  _cached = null;
}

/**
 * Obtain a request_hash whose Google-verified integrity verdict is persisted
 * server-side and bound to `action` for this user. Returns null when the
 * flow cannot complete (non-Android, no Play Services, transient failure) —
 * callers then proceed WITHOUT the X-Integrity-Hash header and the server
 * decides per its policy whether that is acceptable.
 */
export async function getIntegrityHash(action: string): Promise<string | null> {
  try {
    if (Platform.OS !== 'android') return null;

    if (_cached && Date.now() - _cached.fetchedAt < CACHE_TTL_MS) {
      return _cached.hash;
    }

    // 1. Authenticated challenge — binds user + action + single-use hash.
    const { data: challenge, error: chErr } = await backendClient.functions.invoke(
      'verify-play-integrity',
      { body: { action: 'get_nonce', protected_action: action } }
    );
    if (chErr || !challenge?.request_hash) return null;
    const requestHash = String(challenge.request_hash);

    // 2. Native Play Integrity token over that hash (classic nonce).
    const token = await requestPlayIntegrityToken(requestHash);
    if (!token) return null;

    // 3. Backend decodes via Google and persists the verdict row.
    const { data: verdict, error: vErr } = await backendClient.functions.invoke(
      'verify-play-integrity',
      { body: { action: 'verify', token, request_hash: requestHash } }
    );
    if (vErr || verdict?.passed !== true) return null;

    _cached = { hash: requestHash, fetchedAt: Date.now() };
    return requestHash;
  } catch {
    return null;
  }
}

/** Current hash if still fresh (no network); null otherwise. */
export function peekIntegrityHash(): string | null {
  return _cached && Date.now() - _cached.fetchedAt < CACHE_TTL_MS ? _cached.hash : null;
}
