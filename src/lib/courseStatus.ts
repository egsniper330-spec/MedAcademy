/**
 * courseStatus — ONE normalization of `courses.status` for every list/filter.
 *
 * WHY THIS MODULE EXISTS
 * ──────────────────────
 * The Doctor → Courses tabs (All / Drafts / Published) were filtering in three
 * inconsistent places:
 *
 *   1. the screen asked the API for `?status=draft`,
 *   2. the PHP `/courses` endpoint IGNORED that parameter and returned every
 *      course the doctor owns,
 *   3. the screen rendered whatever came back without a client-side check.
 *
 * Result: Drafts showed published courses and vice-versa. On top of that, the
 * tab change never triggered a reload (`useStaleWhileRevalidateFocus` keeps a
 * stable focus subscription), so the list did not even attempt to change.
 *
 * The fix is a single, dependency-free predicate the UI can apply to the rows
 * it already holds. It is deliberately tolerant about representation because
 * historical rows (and other clients) used different spellings for the same
 * state — but it never guesses in the dangerous direction: anything it does not
 * recognize is NOT shown under Published or Drafts (only under All).
 *
 * Kept pure and free of React/Expo imports so the regression suite can require
 * it directly with Node (see tests/courseStatusFilter.test.cjs).
 */

/** The three tabs the Doctor → Courses screen exposes. */
export type CourseStatusTab = 'all' | 'draft' | 'published';

/** Canonical state used by the predicates below. */
export type NormalizedCourseStatus = 'published' | 'draft' | 'hidden' | 'archived' | 'unknown';

type CourseLike = {
  status?: unknown;
  archived_at?: unknown;
};

function norm(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * True when the row is archived (either an `archived_at` timestamp or the
 * status itself). Archived courses must never appear in a normal tab even if
 * their stored status still says `published` — the timestamp is authoritative.
 */
export function isCourseArchived(course: CourseLike | null | undefined): boolean {
  if (!course) return false;
  if (course.archived_at !== null && course.archived_at !== undefined && course.archived_at !== '') {
    return true;
  }
  return norm(course.status) === 'archived';
}

/**
 * Normalize a stored status value.
 *
 * Accepted aliases (legacy / alternative representations found in the
 * codebase and in older data):
 *   published  ← 'published', 'active', 'live', 'public'
 *   draft      ← 'draft', 'unpublished', 'pending', 'waiting', '' / null
 *   hidden     ← 'hidden', 'private', 'unlisted'
 *   archived   ← 'archived'
 * Anything else is 'unknown' and is only visible in the All tab.
 */
export function normalizeCourseStatus(course: CourseLike | null | undefined): NormalizedCourseStatus {
  if (!course) return 'unknown';
  if (isCourseArchived(course)) return 'archived';
  const s = norm(course.status);
  switch (s) {
    case 'published':
    case 'active':
    case 'live':
    case 'public':
      return 'published';
    // The DB column defaults to 'draft'; an empty value can only be a legacy
    // row, and treating it as a draft is the safe (unpublished) direction.
    case 'draft':
    case 'unpublished':
    case 'pending':
    case 'waiting':
    case '':
      return 'draft';
    case 'hidden':
    case 'private':
    case 'unlisted':
      return 'hidden';
    case 'archived':
      return 'archived';
    default:
      return 'unknown';
  }
}

/** True when a course belongs in the given tab. `all` includes every row. */
export function matchesCourseStatusTab(
  course: CourseLike | null | undefined,
  tab: CourseStatusTab,
): boolean {
  if (tab === 'all') return true;
  return normalizeCourseStatus(course) === tab;
}

/**
 * Filter a already-loaded list for a tab. Pure: the input array is never
 * mutated, and order is preserved so the screen's own sorting still applies.
 */
export function filterCoursesByStatus<T extends CourseLike>(
  courses: readonly T[] | null | undefined,
  tab: CourseStatusTab,
): T[] {
  if (!Array.isArray(courses)) return [];
  if (tab === 'all') return [...courses];
  return courses.filter((course) => matchesCourseStatusTab(course, tab));
}

/** Convenience predicate used by dashboards/KPIs. */
export function isCoursePublished(course: CourseLike | null | undefined): boolean {
  return normalizeCourseStatus(course) === 'published';
}

/** How many rows each tab would show — used for tab badges/regression tests. */
export function countByStatusTab(
  courses: readonly CourseLike[] | null | undefined,
): Record<CourseStatusTab, number> {
  const list = Array.isArray(courses) ? courses : [];
  return {
    all: list.length,
    draft: list.filter((course) => matchesCourseStatusTab(course, 'draft')).length,
    published: list.filter((course) => matchesCourseStatusTab(course, 'published')).length,
  };
}
