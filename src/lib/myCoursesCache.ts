/**
 * myCoursesCache — the student's enrollment list, fetched ONCE per short window.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `getMySubscriptions()` is the app's fattest read: an `enrollments` query that
 * embeds the full course row plus its doctor and category. Six screens call it:
 *
 *   Student dashboard · Explore (enrolled markers) · My Courses · Profile ·
 *   Course details (the subscribed check) · Lesson player (access check)
 *
 * A normal student journey is dashboard → My Courses → Course → Lesson → back,
 * so the SAME list was downloaded four to six times within a few seconds, each
 * time with a loading state attached. That is the "it reloads every time I go
 * back" feeling, and it is pure duplicated network + JSON parse + render work.
 * Returning to a screen must not re-download a list the user is still looking at.
 *
 * ── WHAT IT IS (AND IS NOT) ─────────────────────────────────────────────────
 *   • 60 s TTL, in memory only. It is a SHORT reuse window, not an offline store
 *     and not a source of truth — after it expires the server is asked again.
 *     Long enough to cover a whole "dashboard → my courses → course → lesson →
 *     profile" walk (a few seconds of real use), short enough that a change made
 *     on another device shows up on the next visit.
 *   • SINGLE-FLIGHT: concurrent callers share one request (`Promise`), so two
 *     screens mounting together (dashboard + drawer-driven Explore) cannot
 *     produce two downloads.
 *   • ACCOUNT-SCOPED: every entry is keyed by the `studentId` it was fetched
 *     for, so a different account can never read the previous one's rows.
 *   • INVALIDATED on every write we perform (enrollment, purchase, sign-in /
 *     account switch), so the list a student sees right after enrolling is the
 *     real one, not a pre-enrollment snapshot.
 *
 * ── WHAT IT MUST NEVER DO ───────────────────────────────────────────────────
 * Authorization is NOT cached. Access to a course/lesson/material is always
 * decided by the server on the request that delivers the content (the video OTP,
 * the PDF delivery endpoint, the lesson/material endpoints). A stale enrollment
 * list can therefore show a course card that the server will refuse to serve —
 * a cosmetic delay at worst — but it can never GRANT anything. Suspension is
 * likewise enforced server-side on every access path.
 */
import { getMySubscriptions } from '@/lib/api';

/**
 * How long a fetched enrollment list may be reused across screens.
 *
 * ONE named constant for the whole module — nothing else hardcodes a duration.
 * 60 s keeps the benefit for a normal navigation burst while staying inside the
 * window a student would consider "current"; every write we perform still
 * invalidates immediately (see invalidateMySubscriptionsCache).
 */
export const MY_COURSES_CACHE_TTL_MS = 60_000;

/** One enrollment row exactly as the API returns it (shape unchanged). */
export type SubscriptionRow = Awaited<ReturnType<typeof getMySubscriptions>>[number];

type Entry = {
  studentId: string;
  fetchedAt: number;
  data: SubscriptionRow[];
};

let entry: Entry | null = null;
let inFlight: { studentId: string; promise: Promise<SubscriptionRow[]> } | null = null;

/**
 * Invalidation generation.
 *
 * A request that started BEFORE an invalidation carries pre-invalidation rows
 * (before an enrollment, before a sign-out, before an account switch). Without
 * this guard, that request would write them into `entry` on resolve and the app
 * would serve pre-enrollment data for a further TTL — the exact "I enrolled but
 * My Courses still shows the old list" failure. A response may only populate the
 * cache if no invalidation happened while it was in flight.
 */
let generation = 0;

/** True only for the SAME student inside the TTL window. */
function isFresh(studentId: string): boolean {
  return (
    entry !== null &&
    entry.studentId === studentId &&
    Date.now() - entry.fetchedAt < MY_COURSES_CACHE_TTL_MS
  );
}

/**
 * Read the student's enrollments, reusing a very recent result when there is one.
 *
 * Drop-in replacement for `getMySubscriptions(studentId)` — the returned rows are
 * exactly what the API returned (no shape changes, no filtering).
 */
export async function getMySubscriptionsCached(studentId: string): Promise<SubscriptionRow[]> {
  if (isFresh(studentId)) return entry!.data;

  // A different account's request must not be answered with this one's rows.
  if (inFlight && inFlight.studentId === studentId) return inFlight.promise;

  const generationAtStart = generation;
  const promise = (async () => {
    const rows = await getMySubscriptions(studentId);
    // The caller still receives the rows it asked for, but they are NEVER cached
    // when an invalidation (enrollment / purchase / sign-out / account switch)
    // landed while the request was in flight.
    if (generationAtStart === generation) {
      entry = { studentId, fetchedAt: Date.now(), data: rows };
    }
    return rows;
  })();

  inFlight = { studentId, promise };
  try {
    return await promise;
  } finally {
    // Clear only OUR slot: a newer request (after invalidation) owns its own.
    if (inFlight && inFlight.promise === promise) inFlight = null;
  }
}

/**
 * Drop the cached list. Call after ANY operation that can change enrollment:
 * free/credit enrollment, purchase, sign-in and account switch. Cheap and
 * idempotent.
 *
 * Bumping `generation` is what makes this safe against an in-flight response: a
 * request that started before this call can no longer repopulate the cache, and
 * a fresh call started after it is not joined to the pre-invalidation request
 * (`inFlight` is cleared), so the next screen reads post-enrollment data.
 */
export function invalidateMySubscriptionsCache(): void {
  generation += 1;
  entry = null;
  inFlight = null;
}

/** Test/DI hook: read the cache state without exposing it to app code. */
export function __myCoursesCacheState(): { hasEntry: boolean; studentId: string | null; inFlight: boolean } {
  return {
    hasEntry: entry !== null,
    studentId: entry?.studentId ?? null,
    inFlight: inFlight !== null,
  };
}
