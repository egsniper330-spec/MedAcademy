/**
 * courseEnrollment.ts — FREE-course self-enrollment, in one place.
 *
 * ── The defect this fixes ────────────────────────────────────────────────────
 * A doctor publishes a course with price 0. The student sees "Free", taps
 * Subscribe/Enroll — and the app opens the doctor's CONTACT sheet, exactly as
 * for a paid course. Nothing was ever sent to the server, so the student was
 * never enrolled and no amount of tapping changed that.
 *
 * The backend has always had the correct operation (`POST /courses/{id}/enroll`:
 * published-course check, server-side price authority, `enrollments` UNIQUE
 * (student_id, course_id) so it cannot duplicate), but NO client code called
 * it. Both student entry points now do, through this module, so the rule lives
 * in one place instead of being re-derived per screen.
 *
 * ── Rules ────────────────────────────────────────────────────────────────────
 *   • FREE only. The client's `isFreeCourse()` is a DISPLAY hint; the server
 *     re-reads `price_egp` from the published course row and answers 402 for a
 *     paid course. A tampered client therefore cannot enroll for free.
 *   • PAID courses keep the contact/purchase flow — `paid_course` is returned so
 *     the caller can open the existing SubscribeSheet unchanged.
 *   • The owner is always the authenticated token; no id is ever sent.
 *   • Idempotent: a repeated tap or a retry is a success ("already enrolled"),
 *     and the server's UNIQUE index makes concurrent requests collapse into one
 *     enrollment row.
 *   • A SUSPENDED enrollment is reported as such and is never reactivated by
 *     re-enrolling — access revocation stays authoritative.
 */
import { apiFetch } from '@/client/php';
import { invalidateMySubscriptionsCache } from '@/lib/myCoursesCache';

/** Why an enrollment attempt did not produce access. */
export type EnrollmentFailureCode =
  | 'paid_course'     // server says price > 0 → use the paid/contact flow
  | 'suspended'       // an existing enrollment is suspended (do NOT bypass)
  | 'unavailable'     // feature disabled / server refuses enrollment right now
  | 'not_found'       // course missing or no longer published
  | 'auth'            // 401/403 other than the above
  | 'network'         // never reached the server (timeout/offline) — NOT success
  | 'failed';         // any other server error

export class EnrollmentError extends Error {
  readonly code: EnrollmentFailureCode;
  readonly status?: number;
  constructor(code: EnrollmentFailureCode, message: string, status?: number) {
    super(message);
    this.name = 'EnrollmentError';
    this.code = code;
    this.status = status;
  }
}

export interface EnrollmentResult {
  /** true when the student was already enrolled (first request did the work). */
  alreadyEnrolled: boolean;
  enrollmentId: string | null;
  status: string;
}

/**
 * DISPLAY-ONLY free check.
 *
 * `price_egp` missing/null is treated as free because that is how the existing
 * course cards render it ("Free") — but this function NEVER authorizes
 * anything: the server decides with its own published row and answers 402 when
 * the course is actually paid.
 */
export function isFreeCourse(course: { price_egp?: number | string | null } | null | undefined): boolean {
  if (!course) return false;
  const raw = course.price_egp;
  if (raw === null || raw === undefined || raw === '') return true;
  const price = Number(raw);
  return Number.isFinite(price) && price <= 0;
}

/** One in-flight request per course: concurrent taps share one POST. */
const inFlight = new Map<string, Promise<EnrollmentResult>>();

/**
 * Enroll the SIGNED-IN student in a free course.
 *
 * Throws `EnrollmentError` for every non-success outcome; callers must use
 * `error.code` to decide the UI (paid → contact sheet, network → retry message)
 * and must never show a success message on a thrown error.
 */
export function enrollInFreeCourse(courseId: string): Promise<EnrollmentResult> {
  const existing = inFlight.get(courseId);
  if (existing) return existing;

  const run = (async (): Promise<EnrollmentResult> => {
    const { data, error } = await apiFetch<{
      success?: boolean;
      already_enrolled?: boolean;
      enrollment_id?: string | null;
      status?: string;
    }>(`/courses/${encodeURIComponent(courseId)}/enroll`, {
      method: 'POST',
      // The server takes the student from the token; an empty body is enough.
      body: {},
    });

    if (error) {
      const status = error.status ?? 0;
      if (status === 402) {
        throw new EnrollmentError('paid_course', error.message, status);
      }
      if (status === 403) {
        const code = (error.code ?? '').toLowerCase();
        if (code === 'feature_disabled') {
          throw new EnrollmentError('unavailable', error.message, status);
        }
        // Suspended enrollment is reported by the server as a 403.
        throw new EnrollmentError(
          /suspended/i.test(error.message) ? 'suspended' : 'auth',
          error.message,
          status,
        );
      }
      if (status === 404) throw new EnrollmentError('not_found', error.message, status);
      if (status === 409) {
        // Older server: duplicate enrollment as a conflict. The student IS
        // enrolled, so this is a success for the user, not an error.
        return { alreadyEnrolled: true, enrollmentId: null, status: 'active' };
      }
      if (status === 0) throw new EnrollmentError('network', error.message, status);
      throw new EnrollmentError('failed', error.message, status);
    }

    // The student's enrollment list changed: drop the short-TTL copy so My
    // Courses / Explore / the course page read the real list immediately
    // instead of a pre-enrollment snapshot.
    invalidateMySubscriptionsCache();

    return {
      alreadyEnrolled: data?.already_enrolled === true,
      enrollmentId: data?.enrollment_id ?? null,
      status: data?.status ?? 'active',
    };
  })();

  inFlight.set(courseId, run);
  // Clear the slot whatever the outcome so a later retry can run again.
  void run.then(
    () => inFlight.delete(courseId),
    () => inFlight.delete(courseId),
  );
  return run;
}

/** Test/DI hook: forget any in-flight entry (never used by production paths). */
export function __resetEnrollmentInFlight(): void {
  inFlight.clear();
}
