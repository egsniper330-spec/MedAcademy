/**
 * watermarkIdentity.ts — the ONE authoritative watermark identity resolver.
 *
 * ONLINE and OFFLINE players MUST render the identical watermark identity:
 *   "{full_name} • {public_user_id}"   (public_user_id = MED-#### product id)
 * or ID-only "{public_user_id}" when the name is unavailable.
 *
 * Product rule (identical to the online player's long-standing behavior):
 *   • Only PUBLIC identifiers are ever rendered — public_user_id
 *     (MED-####) or the legacy watermark_id token. NEVER the internal
 *     database user id (a UUID). A UUID here is a leak, not a fallback.
 *   • If no public identifier is loaded, the overlay renders NOTHING
 *     (null). Callers render the overlay only when this resolves —
 *     exactly like the online player's {!!watermarkId && …} guard.
 *   • The result is MEMOIZED per profile object, so the identity cannot
 *     flip mid-session when unrelated state re-renders the player
 *     (the root cause of the "watermark settings randomly change" bug).
 *
 * PARITY: pure shared module — Android, iOS and web all resolve the
 * identical identity. No platform branches.
 */

export interface WatermarkProfileShape {
  public_user_id?: string | null;
  watermark_id?: string | null;
  full_name?: string | null;
}

export interface WatermarkIdentity {
  /** Public id token (MED-#### / legacy WM id) — never a UUID. */
  id: string;
  /** Viewer display name (optional). */
  name: string | null;
}

/** A UUID v4 shape — the internal DB id. Never user-facing. */
function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

/**
 * Resolve the displayable watermark identity from a profile.
 * Returns null when no SAFE identity exists — callers then render no
 * overlay (the online player's exact behavior).
 */
export function resolveWatermarkIdentity(
  profile: WatermarkProfileShape | null | undefined
): WatermarkIdentity | null {
  if (!profile) return null;
  const candidates = [profile.public_user_id, profile.watermark_id];
  for (const raw of candidates) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (id && !looksLikeUuid(id)) {
      const name = typeof profile.full_name === 'string' ? profile.full_name.trim() : '';
      return { id, name: name || null };
    }
    // A UUID in a public-id slot is dirty data — skip it, never render it.
  }
  return null;
}

/** The exact online label format: "NAME • ID" or "ID". */
export function watermarkLabel(identity: WatermarkIdentity): string {
  return identity.name ? `${identity.name} • ${identity.id}` : identity.id;
}
