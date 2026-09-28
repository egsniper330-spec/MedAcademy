/**
 * offlineEntitlement.ts
 *
 * ═══════════════════════════════════════════════════════════════════════
 * SERVER-AUTHORITATIVE OFFLINE ENTAILMENT REVALIDATION (Android + iOS)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Downloaded offline videos must never remain usable after the user loses
 * legitimate access to the course (admin removes the enrollment, the student
 * is removed, the course is deleted/trashed, …). The DRM layer already
 * enforces the finite rental license server-side; this module closes the
 * remaining gap: access REVOCATION. It compares the locally downloaded
 * courses against the server-authoritative entitlement state whenever the
 * app is ONLINE and the offline library refreshes, and deletes the offline
 * downloads (through the official deleteOfflineVideo wrapper) for courses
 * the server no longer grants.
 *
 * FAILURE POLICY (critical — this is the safety boundary):
 *   • Only a successful 2xx backend response is authoritative.
 *   • Network errors, timeouts, DNS failures, 401/403/5xx, maintenance
 *     mode, token-refresh failures → NO deletion (evaluated:false).
 *   • Being offline never deletes anything (callers only invoke when
 *     connected; this module additionally fail-opens on any throw).
 *   • Unknown role / missing profile → NO deletion.
 *   Temporary unavailability must never masquerade as revocation.
 *
 * PREDICATE — mirrors backend VdoCipherService::offlineAuthorize() exactly:
 *   • Students: an `enrollments` row for (student_id, course_id) must exist
 *     (that is the server's own download/playback entitlement check).
 *   • Privileged (doctor/assistant/admin/super_admin): the server bypasses
 *     enrollment checks; the `courses` row itself is the entitlement and a
 *     trashed course is the app-wide deleted marker.
 *   The client NEVER invents stricter or looser policy than the server's
 *   own download authorization.
 *
 * IDEMPOTENT: deletion runs per entry through the official SDK remove +
 * tombstone; a re-run finds nothing left to delete. Entry deletions are
 * independent — one failure never blocks the others (the next successful
 * revalidation retries the remainder).
 */

import { backendClient } from '@/client/backendClient';
import {
  deleteOfflineVideo,
  getOfflineVideos,
  type OfflineVideoEntry,
} from './offlineVideoService';

/** Same privileged set the backend's offlineAuthorize() uses. */
const PRIVILEGED_ROLES = new Set(['doctor', 'assistant', 'admin', 'super_admin']);

export interface EntitlementRevalidationResult {
  /** true = an authoritative verdict was applied (even when it removed nothing). */
  evaluated: boolean;
  /** Course ids removed from the device during this run. */
  removedCourseIds: string[];
}

/**
 * Pure decision core (unit-tested in tests/offlineEntitlement.test.cjs).
 * Returns the downloaded course ids whose access the server no longer grants.
 *
 * `enrollmentRows` / `courseRows` semantics: the caller queries exactly the
 * table the server's own predicate uses for this role. `null` means "could
 * not be determined" (query failed / not applicable) → deletes NOTHING.
 */
export function computeRevokedCourseIds(
  role: string | null | undefined,
  downloadedCourseIds: string[],
  enrollmentRows: { course_id?: string | null }[] | null,
  courseRows: { id?: string | null; status?: string | null }[] | null,
): string[] {
  if (!downloadedCourseIds.length) return [];
  // Unknown role → the predicate itself is undeterminable (server uses a
  // different rule per role) → delete nothing (fail-open).
  if (!role) return [];
  if (!PRIVILEGED_ROLES.has(role)) {
    // Student path — mirror offlineAuthorize: enrollment ROW existence is
    // the entitlement (the server counts rows without a status filter, so
    // the client must not invent one).
    if (!enrollmentRows) return []; // undeterminable → delete nothing
    const entitled = new Set(
      enrollmentRows.map((r) => String(r.course_id ?? '')).filter(Boolean),
    );
    return downloadedCourseIds.filter((id) => !entitled.has(id));
  }
  // Privileged path — the course row IS the entitlement; `trashed` is the
  // app-wide deleted marker (courses never hard-delete while retaining
  // offline metadata otherwise).
  if (!courseRows) return []; // undeterminable → delete nothing
  const live = new Map<string, string | null>(
    courseRows.map((r) => [String(r.id ?? ''), r.status ?? null]),
  );
  return downloadedCourseIds.filter((id) => {
    const status = live.get(id);
    return status === undefined || status === 'trashed';
  });
}

/**
 * Revalidates every downloaded course for the current account against the
 * authoritative backend. Call ONLY while online (offline is a no-op by
 * policy and by the throw-guard below).
 */
export async function revalidateOfflineEntitlements(p: {
  userId: string;
  role: string | null | undefined;
}): Promise<EntitlementRevalidationResult> {
  const blocked: EntitlementRevalidationResult = { evaluated: false, removedCourseIds: [] };
  if (!p?.userId) return blocked;

  // Group the current account's offline entries by course. Only THIS
  // account's rows participate (account-switch isolation matches
  // hydrateOfflineLibrary's owner binding).
  const byCourse = new Map<string, OfflineVideoEntry[]>();
  for (const e of getOfflineVideos()) {
    if (!e?.meta || e.meta.userId !== p.userId) continue;
    const cid = e.meta.courseId;
    if (!cid || cid === '__nocourse__') continue; // no course authority to check against
    const list = byCourse.get(cid);
    if (list) list.push(e);
    else byCourse.set(cid, [e]);
  }
  // Nothing course-bound on the device → trivially consistent.
  if (byCourse.size === 0) return { evaluated: true, removedCourseIds: [] };

  const courseIds = [...byCourse.keys()];
  const privileged = !!p.role && PRIVILEGED_ROLES.has(p.role);

  let revoked: string[];
  try {
    if (privileged) {
      const { data, error } = await backendClient
        .from('courses')
        .select('id, status')
        .in('id', courseIds)
        .limit(200);
      if (error || !data) return blocked; // 4xx/5xx/maintenance → delete nothing
      revoked = computeRevokedCourseIds(p.role, courseIds, null, data);
    } else {
      // Same read the server itself performs (SELECT … FROM enrollments
      // WHERE student_id = ? AND course_id = ?) — batched over all
      // downloaded courses; a course missing from the reply is revoked.
      const { data, error } = await backendClient
        .from('enrollments')
        .select('course_id')
        .eq('student_id', p.userId)
        .in('course_id', courseIds)
        .limit(200);
      if (error || !data) return blocked;
      revoked = computeRevokedCourseIds(p.role, courseIds, data, null);
    }
  } catch {
    return blocked; // network/timeout/DNS — NEVER interpreted as revocation
  }

  if (!revoked.length) return { evaluated: true, removedCourseIds: [] };

  // Authoritative revocation: delete each entry through the OFFICIAL
  // mechanism (VdoDownload.remove + tombstone + emit). Independent
  // per-entry try/catch keeps one failure from blocking the rest.
  const removed: string[] = [];
  for (const cid of revoked) {
    const entries = byCourse.get(cid) ?? [];
    let allGone = true;
    for (const e of entries) {
      try {
        await deleteOfflineVideo(e.meta.mediaId);
      } catch {
        allGone = false; // retried by the next successful revalidation
      }
    }
    if (allGone) removed.push(cid);
  }
  return { evaluated: true, removedCourseIds: removed };
}
