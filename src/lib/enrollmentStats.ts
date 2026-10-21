/**
 * Enrollment statistics — the pure half of the Admin/Super Admin analytics
 * screen. No React, no react-native imports, so every rule below is unit-tested
 * in Node by tests/enrollmentStats.test.cjs.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Two metrics are easy to confuse and impossible to un-confuse once they are
 * rendered as one number:
 *
 *   • `unique_students` — distinct student ACCOUNTS. One student in five
 *     courses counts once.
 *   • `enrollments`     — student↔course enrolments. That same student counts
 *     five times.
 *
 * The backend returns BOTH on every row and in every total (see
 * backend/src/Controllers/EnrollmentStatsController.php). This module is the one
 * place that decides which number a card, a table cell or a detail header
 * shows, so the selected mode can never apply to one figure and not another.
 *
 * Nothing here recomputes a count from a client-side list: the server owns the
 * aggregates. The only client-side arithmetic is (a) picking a metric and
 * (b) checking that a full page of per-course rows sums to the platform total —
 * a reconciliation probe that surfaces a backend discrepancy instead of hiding
 * it.
 */

/*
 * LOCAL TYPE SHAPES (not imported from src/lib/api.ts on purpose).
 *
 * These are the structural minimums this module needs, which keeps it free of
 * React/backend-client imports and therefore compilable on its own in Node — the
 * same trick src/lib/devicePresence.ts uses. The real API types are supersets, so
 * they are assignable to these without a cast in either direction.
 */

export type EnrollmentCountingMode = 'unique_students' | 'enrollments';

export type EnrollmentStatsSort =
  | 'unique_students'
  | 'enrollments'
  | 'courses'
  | 'name'
  | 'title'
  | 'doctor';

export interface EnrollmentMetricsLike {
  unique_students?: number | null;
  enrollments?: number | null;
}

export interface EnrollmentTotalsLike extends EnrollmentMetricsLike {
  courses_with_enrollments?: number | null;
  doctors_with_enrollments?: number | null;
  courses_total?: number | null;
  doctors_total?: number | null;
}

export interface EnrollmentPolicyLike {
  include_archived?: boolean;
  student_role_only?: boolean;
  excludes_trashed?: boolean;
  counts_are_distinct?: boolean;
}

export interface EnrollmentRowLike extends EnrollmentMetricsLike {
  course_id?: string;
  doctor_id?: string | null;
  doctor_name?: string | null;
  status?: string | null;
  archived_at?: string | null;
  courses_count?: number | null;
}

export interface EnrollmentQueryLike {
  search?: string;
  sort?: EnrollmentStatsSort;
  order?: 'asc' | 'desc';
  page?: number;
  per_page?: number;
  include_archived?: boolean;
  doctor_id?: string;
  course_status?: string;
}

/** Default mode: the plainest possible reading of "how many students?". */
export const DEFAULT_COUNTING_MODE: EnrollmentCountingMode = 'unique_students';

export const COUNTING_MODES: EnrollmentCountingMode[] = ['unique_students', 'enrollments'];

/** Any row that carries both metrics (course row, doctor row, totals). */
export type EnrollmentMetricCarrier = EnrollmentMetricsLike;

/**
 * The value of `row` under the selected mode. Missing values become 0 rather
 * than NaN/undefined so a partial response can never render "NaN students".
 */
export function metricValue(row: EnrollmentMetricCarrier, mode: EnrollmentCountingMode): number {
  const raw = mode === 'unique_students' ? row.unique_students : row.enrollments;
  const n = typeof raw === 'number' ? raw : Number(raw ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** Translation key for the mode itself (the selector + the card labels). */
export function countingModeLabelKey(mode: EnrollmentCountingMode): string {
  return mode === 'unique_students'
    ? 'enrollmentStats.mode.uniqueStudents'
    : 'enrollmentStats.mode.actualEnrollments';
}

/** Translation key for the one-line explanation under the selector. */
export function countingModeHintKey(mode: EnrollmentCountingMode): string {
  return mode === 'unique_students'
    ? 'enrollmentStats.mode.uniqueStudentsHint'
    : 'enrollmentStats.mode.actualEnrollmentsHint';
}

/** Counts are derived, never the sum of client-side lists. */
export function sumMetric(rows: EnrollmentMetricCarrier[], mode: EnrollmentCountingMode): number {
  return rows.reduce((total, row) => total + metricValue(row, mode), 0);
}

/**
 * True when `sum` matches `expected`. Used by the reconciliation banner: with
 * every course row loaded, Σ course enrolments MUST equal the platform total
 * (both come from the same pair set). A mismatch is reported, never rounded away.
 */
export function reconciles(sum: number, expected: number): boolean {
  return sum === expected;
}

/** Sort columns offered per table (server-side sort whitelist). */
export const DOCTOR_SORT_COLUMNS: EnrollmentStatsSort[] = ['unique_students', 'enrollments', 'courses', 'name'];
export const COURSE_SORT_COLUMNS: EnrollmentStatsSort[] = ['unique_students', 'enrollments', 'title', 'doctor'];

/**
 * Toggle a column: same column flips the direction, a new column starts
 * descending (largest first is what an admin wants when sorting by a count).
 */
export function nextSort(
  current: { sort: EnrollmentStatsSort; order: 'asc' | 'desc' },
  column: EnrollmentStatsSort,
): { sort: EnrollmentStatsSort; order: 'asc' | 'desc' } {
  if (current.sort === column) {
    return { sort: column, order: current.order === 'desc' ? 'asc' : 'desc' };
  }
  const alphabetic = column === 'name' || column === 'title' || column === 'doctor';
  return { sort: column, order: alphabetic ? 'asc' : 'desc' };
}

/** Page numbers to render around the current page (always includes 1 + last). */
export function pageWindow(page: number, totalPages: number, radius = 1): number[] {
  const last = Math.max(1, Math.trunc(totalPages) || 1);
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), last);
  const pages = new Set<number>([1, last]);
  for (let p = current - radius; p <= current + radius; p++) {
    if (p >= 1 && p <= last) pages.add(p);
  }
  return [...pages].sort((a, b) => a - b);
}

/** "1 / 4" style caption without locale-dependent formatting surprises. */
export function pageCaption(page: number, totalPages: number, total: number): string {
  const last = Math.max(1, Math.trunc(totalPages) || 1);
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), last);
  return `${current} / ${last} · ${Math.max(0, Math.trunc(total) || 0)}`;
}

/**
 * Request params for the doctors table. `per_page` is clamped to the server's
 * own maximum so a stale client cannot ask for an unbounded page.
 */
export function doctorsQuery(state: {
  search?: string;
  sort?: EnrollmentStatsSort;
  order?: 'asc' | 'desc';
  page?: number;
  perPage?: number;
  includeArchived?: boolean;
}): EnrollmentQueryLike {
  return {
    search: state.search?.trim() || undefined,
    sort: state.sort ?? 'unique_students',
    order: state.order ?? 'desc',
    page: clampPage(state.page),
    per_page: clampPerPage(state.perPage),
    include_archived: !!state.includeArchived,
  };
}

/**
 * Request params for the courses table. `doctor_id` is the "filter by doctor"
 * control; when it is empty every doctor's courses are shown.
 */
export function coursesQuery(state: {
  search?: string;
  sort?: EnrollmentStatsSort;
  order?: 'asc' | 'desc';
  page?: number;
  perPage?: number;
  includeArchived?: boolean;
  doctorId?: string | null;
  courseStatus?: string | null;
}): EnrollmentQueryLike {
  const doctorId = state.doctorId?.trim();
  const status = state.courseStatus?.trim();
  return {
    search: state.search?.trim() || undefined,
    sort: state.sort ?? 'enrollments',
    order: state.order ?? 'desc',
    page: clampPage(state.page),
    per_page: clampPerPage(state.perPage),
    include_archived: !!state.includeArchived,
    doctor_id: doctorId || undefined,
    course_status: status || undefined,
  };
}

export const MIN_PER_PAGE = 5;
export const MAX_PER_PAGE = 100;
export const DEFAULT_PER_PAGE = 20;

export function clampPerPage(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return DEFAULT_PER_PAGE;
  return Math.min(MAX_PER_PAGE, Math.max(MIN_PER_PAGE, Math.trunc(value)));
}

export function clampPage(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.trunc(value));
}

/**
 * The headline card values. `secondary` is the OTHER metric, shown smaller so
 * both numbers are always visible and neither is mistaken for the other.
 */
export function headlineCards(
  totals: EnrollmentTotalsLike | null | undefined,
  mode: EnrollmentCountingMode,
): { primary: number; secondary: number; secondaryMode: EnrollmentCountingMode } {
  const other: EnrollmentCountingMode = mode === 'unique_students' ? 'enrollments' : 'unique_students';
  return {
    primary: metricValue(totals ?? {}, mode),
    secondary: metricValue(totals ?? {}, other),
    secondaryMode: other,
  };
}

/**
 * Mode persistence across the statistics views: one module-level value, so
 * switching tabs/screens keeps the admin's choice without a global store or
 * storage write. Deliberately NOT persisted to disk — a mode is a view, not a
 * preference of the account.
 */
let currentMode: EnrollmentCountingMode = DEFAULT_COUNTING_MODE;

export function getCountingMode(): EnrollmentCountingMode {
  return currentMode;
}

export function setCountingMode(mode: EnrollmentCountingMode): EnrollmentCountingMode {
  currentMode = COUNTING_MODES.includes(mode) ? mode : DEFAULT_COUNTING_MODE;
  return currentMode;
}

/** Test hook. */
export function resetCountingMode(): void {
  currentMode = DEFAULT_COUNTING_MODE;
}

/**
 * Human-readable status of a course in this statistics context. Archived is
 * called out explicitly because those rows are excluded by default and an admin
 * toggling `include_archived` should see WHY a course was missing.
 */
export function courseStatusKey(row: Pick<EnrollmentRowLike, 'status' | 'archived_at'>): string {
  if (row.archived_at || row.status === 'archived') return 'enrollmentStats.courseStatus.archived';
  if (row.status === 'published') return 'enrollmentStats.courseStatus.published';
  return 'enrollmentStats.courseStatus.draft';
}

/** Doctor label fallback — a course whose doctor profile is missing. */
export function doctorLabelKey(row: { doctor_id?: string | null; doctor_name?: string | null }): string | null {
  return !row.doctor_id || !row.doctor_name ? 'enrollmentStats.unassignedDoctor' : null;
}

/** Row identity for list keys (every server row carries exactly one of these). */
export function rowKey(row: EnrollmentRowLike): string {
  return row.course_id ?? row.doctor_id ?? '';
}

/**
 * A short, explicit description of the counting rules in force, built from the
 * server's policy echo — so the UI can never drift from the backend.
 */
export function policyNoteKeys(policy: EnrollmentPolicyLike | null | undefined): string[] {
  if (!policy) return [];
  const keys = ['enrollmentStats.policy.activeOnly'];
  if (policy.student_role_only) keys.push('enrollmentStats.policy.studentsOnly');
  if (policy.excludes_trashed) keys.push('enrollmentStats.policy.excludesTrashed');
  keys.push(policy.include_archived
    ? 'enrollmentStats.policy.includesArchived'
    : 'enrollmentStats.policy.excludesArchived');
  if (policy.counts_are_distinct) keys.push('enrollmentStats.policy.duplicatesCollapsed');
  return keys;
}
