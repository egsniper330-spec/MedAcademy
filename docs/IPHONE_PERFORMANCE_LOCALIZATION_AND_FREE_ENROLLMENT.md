# iPhone performance, Arabic localization/RTL, contact warning, free enrollment

Status: implemented, tested at the JS/PHP-source level. Nothing in this change is
deployed. Backend deployment requires the files listed at the end.

---

## 1. iPhone performance regression — root cause

Three independent defects, all in the "the app feels like it is always loading" class:

### 1.1 The security config endpoint was fetched TWICE per evaluation

`src/lib/security.ts` had two functions that each did their own
`get-security-policies` GET:

* `getSecurityPolicies()` — after the detector batch, and
* `getVpnWhitelist()` — called from inside `detectVPN()`, i.e. BEFORE the batch.

The endpoint returns `{ policies, vpn_whitelist }` in one payload, so the second
request was pure duplication; worse, because one ran inside the detector
pipeline and the other after it, the two round trips were **serialised** around
the whole detector batch.

The startup network lock defers every protected screen request until this
evaluation completes, so those two round trips sat directly on the critical path
of "the app is usable". On iOS, where each request also crosses the bridge, that
is exactly the reported symptom (every screen showing a spinner, nothing
finishing quickly).

**Fix:** `loadSecurityConfigOnce()` — one single-flight request that populates
both caches — started with `const policiesP = getSecurityPolicies();`
**before** the detector batch so the network wait overlaps the native probes,
and awaited where its result is consumed (`const policies = await policiesP;`).
A generation counter discards a response that belongs to a previous
account/session (`invalidatePolicyCache()`).

Nothing about the decision changed: same endpoint, same `DETECTOR_TIMEOUT_MS`,
same 5-minute `POLICY_TTL_MS`, same `applyMandatoryConnectionFloor()` fail-secure
floor, same offline fast-path, all 13 detectors still run, and a resume still
reuses only a **passing** TLS probe (`SSL_PROBE_REUSE_MS`).

### 1.2 Every focus blanked the screen

Screens did `useFocusEffect(() => { setLoading(true); load(); })` with
`{loading ? <Spinner/> : content}`. Returning from any pushed screen, or closing
a sheet, unmounted the content and re-waited for the whole request batch.

**Fix:** `src/lib/useStaleWhileRevalidateFocus.ts` — the spinner is raised only
when there is genuinely nothing to show (`hasContent()`), a focus that arrives
while a batch is running does not start a second one (`inFlightRef`), and no
response data is cached (freshness semantics unchanged). Applied to Doctor
Video Library, Doctor Students, Doctor Courses, Doctor Overview, Student
Dashboard, Explore/My Courses list, Notifications (both roles) and Course
details.

### 1.3 Video Library refetched once per keystroke

The search box and the server query were the same state, so every character
re-created the loader and re-ran the focus effect: one GET plus one spinner per
character.

**Fix:** `searchInput` (what is typed, bound to the `TextInput`) is debounced
300 ms into `search` (the query), the focus loader no longer raises a
full-screen spinner, filter/sort changes refetch behind a
`prevFilterKeyRef` guard, and pull-to-refresh has its own indicator
(`refreshingList`) instead of reusing `loading`.

### 1.4 What was measured

| Measurement | Before | After | How |
| --- | --- | --- | --- |
| `get-security-policies` GETs per security evaluation | 2 | 1 | single `functions.invoke('get-security-policies'` call site + single-flight assertion (`tests/iphoneStartupPerformance.test.cjs`) |
| GETs while typing a 7-character query in Video Library | 7 | 1 | debounce (300 ms) + typed/queried state split |
| Screens that blank their list on focus | 8 in scope | 0 | `useStaleWhileRevalidateFocus` present, `setLoading(true)` absent |
| Full web bundle compiles | — | yes | Metro `entry.bundle?platform=web` → HTTP 200, 3,989,110 bytes |

**No physical iPhone was available.** No frame timings, TTI or device logs were
captured, so no claim is made about a measured on-device speed-up; the numbers
above are request-count and code-path measurements, verified by the test suite.

---

## 2. Arabic localization and RTL

### 2.1 Screens now fully translated (en + ar)

Doctor: Video Library (including the nested **upload queue panel**), Students,
Balance (credits), Notifications.
Student: My Courses, Offline Videos (library + course), Notifications.
Both roles: About Us, Contact Us, Terms & Conditions, Privacy Policy.

Localization goes through the existing dictionaries (`src/lib/i18n/resources.ts`)
with the existing key conventions; no parallel system was introduced. API
identifiers, enum values, database fields and user-entered names are untouched.

Plural keys used with `tCount()` now carry all six forms
(`offlineCourse.videoCount.*`, `offlineCourse.downloadedCount.*`) — the missing
forms were a real defect that made Arabic counts render the raw key.

### 2.2 RTL heading root cause

The title had no `textAlign`, so React Native resolved it through
`I18nManager.isRTL` — the **native** layout flag, which only flips after the
relaunch `applyRTL()` schedules. Until that relaunch (and permanently in builds
where the native flag is not set) Arabic copy was laid out with English
direction rules, leaving the heading on the left.

`src/components/PageHeader.tsx` now derives direction from the **app locale**
it already uses for `t()` and for the back-arrow glyph:

* `textAlign: isRTL ? 'right' : 'left'` and `writingDirection` on title *and*
  subtitle;
* the row is physically mirrored (`row-reverse`) with `gap` spacing (no physical
  margins), so the leading control sits on the right;
* the back affordance mirrors by **glyph** (`ArrowRight` in RTL) because the
  platform does not mirror icons;
* no `I18nManager` dependency, no `scaleX(-1)`, no global mirroring — English
  layouts are unchanged.

Notifications, About, Contact, Terms and Privacy all render this shared header
with a `t(...)` title.

---

## 3. Missing default contact = red warning

In `src/app/(app)/course-builder/[id].tsx` the unavailable option now renders a
**red, bold, localized** warning with an accessibility label + live region:

* English: `Unavailable — configure it in your Profile page`
* Arabic: `غير متاحة — يمكن إعدادها من صفحة الملف الشخصي`
* colour `#DC2626` (light) / `#F87171` (dark); the row keeps 0.85 opacity so the
  warning stays readable while still looking unavailable (other disabled rows
  stay at 0.55);
* the option remains **disabled** and cannot be selected;
* `unknown` (profile still loading) stays muted and is never presented as a
  confirmed problem; a confirmed `missing` cannot stay selected;
* validity is still checked, not mere non-emptiness (WhatsApp ≥ 6 digits,
  Telegram handle shape, phone ≥ 4 digits).

This is the only place the option is offered, so there is no second copy to
drift.

---

## 4. Free courses enroll immediately

**Before:** tapping Subscribe on a free course opened the doctor's contact
sheet. Nothing was sent to the server, so the student was never enrolled and My
Courses stayed empty.

**After:** both student entry points (Explore list, Course details) call the new
`src/lib/courseEnrollment.ts`, which POSTs `/courses/{id}/enroll`. The server:

1. takes the owner from the token (no id is ever sent);
2. requires the `student` role (staff use the audited grant path);
3. reads `price_egp` from the **published** row — a client that claims "free"
   for a paid course still gets 402 and no enrollment;
4. returns `already_enrolled` for a repeat/retry instead of an error;
5. collapses concurrent requests: the lost racer's duplicate-key (SQLSTATE
   23000) is resolved by re-reading the winner's row;
6. never reactivates a `suspended` enrollment (403);
7. writes the audit event only on a genuine creation.

Client behaviour: success is announced only after the awaited server response;
`paid_course` (402) falls back to the unchanged `SubscribeSheet` flow; a network
failure is reported as a failure; concurrent taps share one promise, so three
taps produce one POST. The course card flips to enrolled at once, and My Courses
(which revalidates on focus) shows it without a restart.

Paid courses are unchanged: same contact/purchase sheet, same credit/audit
grant path (`CourseController::grantAccess`, `RpcController`).

---

## 5. Files

Created:

* `src/lib/courseEnrollment.ts`
* `src/lib/useStaleWhileRevalidateFocus.ts` (pre-existing in this tree; used by
  the screens above)
* `tests/iphoneStartupPerformance.test.cjs`
* `tests/freeCourseEnrollment.test.cjs`
* `tests/arabicRtlAndContactWarning.test.cjs`
* `backend/tests/course-enrollment/enroll_tests.php`
* `backend/tests/course-enrollment/run.sh`
* `docs/IPHONE_PERFORMANCE_LOCALIZATION_AND_FREE_ENROLLMENT.md` (this file)

Modified (frontend): `src/lib/security.ts`, `src/lib/i18n/resources.ts`,
`src/components/PageHeader.tsx`, `src/components/VideoUploadQueue.tsx`,
`src/app/(app)/(doctor)/video-library.tsx`,
`src/app/(app)/(doctor)/students.tsx`,
`src/app/(app)/(doctor)/courses.tsx`,
`src/app/(app)/(doctor)/dr-overview.tsx`,
`src/app/(app)/(student)/dashboard.tsx`,
`src/app/(app)/(student)/explore.tsx`,
`src/app/(app)/(student)/my-courses.tsx`,
`src/app/(app)/notifications.tsx`,
`src/app/(app)/course/[id].tsx`,
`src/app/(app)/course-builder/[id].tsx`,
`src/app/(app)/lesson-editor/[id].tsx`,
`src/app/(app)/offline-library.tsx`,
`src/app/(app)/offline-course.tsx`,
`src/app/(app)/info/about.tsx`, `contact.tsx`, `terms.tsx`, `privacy.tsx`,
`src/app/(app)/(hubs)/credits.tsx`.

Modified (backend, **this request**): `backend/src/Controllers/CourseController.php`
(`enroll()` only).

Modified (tests updated to the new behaviour): `tests/courseBuilderDefaultContact.test.cjs`,
`tests/videoLibrarySync.test.cjs`, `tests/fullscreenLatency.test.cjs`.

Modified (doc): `DEPENDENCY_LICENSE_AUDIT.md` (names `tecnickcom/tcpdf`, as the
licence policy test requires).

> Note: the working tree also contains the uncommitted backend work from the
> earlier PDF-upload/cleanup request (`LessonMaterialController`,
> `UploadIntegrityService`, `MaterialFileCleanupService`, `StorageService`,
> `DataController`, `RpcController`, `StorageController`, `PdfWatermarkService`,
> `routes/api.php`, `scripts/…`). Those are **not** part of this change; if they
> have not been deployed yet, they travel with `CourseController.php`.

---

## 6. Deployment

Backend (required for this request):

* `backend/src/Controllers/CourseController.php`

Routes: no change (`POST /courses/{id}/enroll` already existed and is registered).

Database: **no migration**. `enrollments` already has
`UNIQUE(student_id, course_id)` and `enrollment_method` is a free-text audit
column (`'direct'` is already the UI's fallback label).

Configuration: **none**. No new environment variables, no VdoCipher/dashboard
change, no paid service introduced.

Frontend: rebuild required (JS/native bundle). No `ios/` changes, so no
`pod install`; EAS/native rebuild only because the JS bundle changed.

Verification on the server (safe, read-only first):

```bash
php -l backend/src/Controllers/CourseController.php
php -r 'require "backend/src/bootstrap.php"; echo MedAcademy\Utils\Config::string("APP_ENV"), PHP_EOL;'
php backend/scripts/server-selfcheck.php
```

## 7. Tests

| Command | Result |
| --- | --- |
| `node scripts/run-all-tests.cjs` | **121 suites passed, 0 failed** |
| `node scripts/run-state-tests.cjs` | 274 + 79 passed, 0 failed |
| `node tests/iphoneStartupPerformance.test.cjs` | 32 passed |
| `node tests/freeCourseEnrollment.test.cjs` | 47 passed |
| `node tests/arabicRtlAndContactWarning.test.cjs` | 57 passed |
| `node tests/i18nLocalization.test.cjs` | 129 passed |
| `npx tsc --noEmit` | clean |
| `npx eslint <changed files>` | 0 errors (pre-existing warnings only) |
| Metro web bundle | HTTP 200, 3,989,110 bytes |
| `bash backend/tests/course-enrollment/run.sh` | **NOT RUN — no PHP binary in this environment** |

## 8. Limitations

* No physical iPhone/Android device: no device-level timings, no VoiceOver/TalkBack
  pass, no RTL visual confirmation on hardware.
* The PHP enrollment suite and `php -l` could not be executed here (PHP is not
  installed). The suite is written against the real controller and the existing
  `material-lifecycle` harness pattern; run it on the server or any PHP 8.2 CLI
  with `pdo_sqlite` before relying on it.
* `npx expo export --platform web` did not finish inside the 10-minute budget;
  integrity was instead verified by `tsc`, the suite run and a successful Metro
  bundle request.

## 9. Rollback

* Frontend: revert the JS bundle (previous build). No data or schema change, so
  nothing else to undo.
* Backend: restore the previous `CourseController.php`. Older clients never
  called `enroll`, so the previous behaviour (409 on duplicate) is still safe;
  the new client maps 409 to "already enrolled", so a mixed rollout does not
  produce false failures.
* Enrollments created by the new path are ordinary `enrollments` rows
  (`enrollment_method = 'direct'`); they can be removed with the existing
  audited admin removal (`POST /rpc/remove-course-enrollment`) if needed.
