/**
 * sectionDelete.ts — PURE error mapping for section deletion.
 *
 * Kept free of React/network imports so it can be unit tested in plain Node.
 *
 * The dedicated endpoint (POST /courses/{id}/sections/{section_id}/delete)
 * answers with a specific status for each real failure mode:
 *
 *   400 — malformed section/course id
 *   403 — the doctor does not own the course
 *   404 — the course or the section does not exist (also used for a section
 *         that belongs to a DIFFERENT course, so the endpoint never confirms
 *         that an id exists elsewhere)
 *   409 — a foreign key we do not own still references the section; the
 *         transaction was rolled back and nothing was deleted
 *
 * Mapping the STATUS (rather than parsing a message) keeps the UI localized and
 * honest: raw SQL/DB text is never shown to a doctor, and an unknown status
 * falls back to the existing generic "Failed to delete section." message.
 */

export type SectionDeleteErrorKey =
  | 'cb.error.sectionNotFound'
  | 'cb.error.sectionForbidden'
  | 'cb.error.sectionConflict'
  | 'cb.error.sectionInvalid';

/** Translate a failed deletion's HTTP status into a localized message key. */
export function sectionDeleteErrorKey(status: number | null | undefined): SectionDeleteErrorKey | null {
  const code = Number(status);
  switch (code) {
    case 404:
      return 'cb.error.sectionNotFound';
    case 403:
      return 'cb.error.sectionForbidden';
    case 409:
      return 'cb.error.sectionConflict';
    case 400:
      return 'cb.error.sectionInvalid';
    default:
      return null;
  }
}
