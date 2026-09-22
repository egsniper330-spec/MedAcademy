/**
 * previewAsStudent.ts — "Preview as Student" session state.
 *
 * Product decision (owner-approved): Doctors get a clean, small preview feature
 * that renders THEIR OWN published course through the real student-facing
 * screens. It intentionally does NOT:
 *   - change the doctor's role, JWT, or profile (no account switching)
 *   - grant access to other doctors' courses (the course page must already be
 *     reachable via normal authorization — doctors can only open their own
 *     courses from My Courses; published-course browsing is public anyway)
 *   - bypass any server-side gate (VdoCipherService::otp already allows
 *     privileged roles to play through the SAME endpoint students use)
 *
 * What it DOES: while a preview session is active, the shared course/lesson
 * screens render with student semantics (published-only lessons, student
 * empty-state copy, enrolled-student presentation) so the doctor sees exactly
 * what a student sees — including any student-only authorization bugs.
 *
 * State is session-only (module scope) — never persisted, never sent to the
 * backend. Only ONE course can be previewed at a time; the course screen shows
 * an explicit banner with an Exit control.
 */

let previewCourseId: string | null = null;

export function startPreviewAsStudent(courseId: string): void {
  previewCourseId = courseId;
}

export function stopPreviewAsStudent(): void {
  previewCourseId = null;
}

/** True when the given course is currently being previewed as a student. */
export function isPreviewingCourse(courseId?: string | null): boolean {
  return previewCourseId !== null && (!courseId || previewCourseId === courseId);
}

/** True when ANY student-preview session is active (used by lesson screens). */
export function isPreviewStudent(): boolean {
  return previewCourseId !== null;
}
