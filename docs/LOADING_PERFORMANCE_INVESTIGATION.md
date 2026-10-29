# MedAcademy — loading performance investigation

Scope: why the app feels slow on cold launch, on return from background, when
revisiting a screen, and when opening API-driven screens. Everything below is
either **verified in code / executed in a test** or explicitly marked
**not measured**. No device timings were fabricated; a physical iPhone/Android
run is still required for the numbers marked ⚠️.

---

## 1. Startup timeline (structure, verified in code)

The launch is a **chain of four gates**, each of which can hold everything behind
it:

| # | Stage | Code | Blocks what? | Nature |
| --- | --- | --- | --- | --- |
| 0 | JS start | `src/app/_layout.tsx` (first module evaluated) | everything | bundle parse (Hermes bytecode in release) |
| 1 | Session restore | `SessionProvider` (`src/ctx.tsx`) — `backendClient.auth.getSession()` | the entire tree (spinner) | SecureStore reads, local |
| 2 | Security verdict | `SecurityContext` → `runSecurityChecks()` (`src/lib/security.ts`), 13 detectors + policy GET | **every protected request** (`php.ts` defers them behind the lock, up to 20 s) | native probes + up to 3 network calls |
| 3 | Profile | `(app)/_layout.tsx` → `getProfile()` | role redirect → the dashboard mount | 1 network call |
| 4 | Screen data (phase 1) | dashboard `Promise.all([subs, unread])` | the screen's content | 2 parallel network calls |
| 5 | Screen data (phase 2) | dashboard `Promise.all([courses, categories])` | only the **Explore** section | 2 parallel network calls, started *after* the screen is usable |

Verified details that matter:

* Session restore **already** resolves `isLoading` before `checkRevocation()`:
  `setIsLoading(false)` runs first, the revocation round trip is awaited after
  it. Cold launch is therefore not blocked by the device-binding check.
* The security config GET is **single-flight and started before the detector
  batch** (previous round), so stage 2 costs `max(detectors)` and not
  `detectors + config`.
* Independent requests inside a screen are already parallel (`Promise.all`) in
  the dashboard, doctor overview, students, explore and course details.
* The dashboard is **two-phase**: the first usable screen depends only on the
  student's OWN reads (enrollments + unread count); the public catalogue and the
  near-static category list load behind it. Before that change all four were in
  one `Promise.all` and the whole screen body sat behind a spinner until the
  slowest — usually the largest — response arrived. See §3 and §6.
* Image prefetch is capped at 8 URLs (`PREFETCH_LIMIT`) and fire-and-forget.
* The `(app)` shell runs the security evaluation **once**: the layout no longer
  calls `check()` on resume (that duplicate was removed and is now guarded by a
  comment + tests).

Stage 2 is the only gate whose duration the app cannot shorten by caching, and it
is deliberately fail-closed. It is also the gate that makes "cold launch" and
"return from background" feel slow when the network is poor.

## 2. Measured request counts (executed, not estimated)

`tests/dataReusePerformance.test.cjs` runs the real `src/lib/myCoursesCache.ts`
against a stubbed transport on a controlled clock and counts calls.

| Sequence | Before | After |
| --- | --- | --- |
| Dashboard → My Courses → Course → Lesson → Profile → Explore (one burst) | 6 `enrollments` downloads | **1** |
| Three surfaces mounting at the same moment | 3 downloads | **1** |
| Same screen re-read inside 60 s | 1 per read | **0** |
| Read after 60 s | 1 | 1 (window is not a store) |
| Read after enrollment / sign-out / account switch | — | 1 (invalidated, never stale) |

Structural measurement (asserted by `tests/iphoneStartupPerformance.test.cjs`):

| Metric | Before | After |
| --- | --- | --- |
| `get-security-policies` GETs per security evaluation | 2 | **1** |
| in-scope screens that blank on focus | 8 | **0** |
| GETs while typing a 7-character Video Library query | 7 | **1** |

## 3. Screen-by-screen

| Screen | Current behaviour | Confirmed bottleneck | Evidence | Change / recommendation |
| --- | --- | --- | --- | --- |
| Student Dashboard | **two-phase** load; SWR on focus | enrollment re-download (fixed) **and** the catalogue/categories gating the first paint (fixed) | 6 call sites for `getMySubscriptions`; `tests/dashboardLoadPhases.test.cjs` | **fixed**: reads through the 60 s cache (1 request per burst); catalogue + categories now start after `setLoading(false)` so the screen is usable without them |
| Explore | featured + enrollments + search (parallel); SWR | same enrollment re-download | same | **fixed** |
| My Courses | 1 read on focus | same enrollment re-download | same | **fixed** |
| Student Profile | 1 read + profile | same enrollment re-download | same | **fixed** |
| Course details | 3 reads, enrollment extras fired in parallel with the course read, dev timing log already present | none found | `[CourseDetail] loaded duration=…` | no change needed |
| Lesson player | lesson + enrollments + materials | same enrollment re-download | same | **fixed** |
| Video Library | 1 read; debounced search; throttled VdoCipher sync on focus | none remaining (was: 1 request + spinner per keystroke) | `tests/iphoneStartupPerformance.test.cjs` | no change |
| Students | 2 parallel reads; SWR | none found | `Promise.all` in `loadData` | no change |
| Doctor Courses / Overview | parallel reads; SWR | none found | same | no change |
| Notifications | 1 read; SWR | none found | `useStaleWhileRevalidateFocus` | no change |
| Offline Library / Course | local storage reads, no API on focus | none found | no network calls in loaders | no change |

## 4. Frontend vs backend vs network

* **Frontend**: the measurable waste was duplicated reads (fixed) and
  re-mount/blank-on-focus (fixed earlier). Rendering uses capped prefetch and
  parallel batches.
* **Backend**: the hot reads go through `DataController::select`, which compiles
  **one** SQL query per table plus one batched `WHERE … IN (…)` per embedded
  relation (`fetchRelationRows`) — no per-parent loop, i.e. **no N+1** on
  courses/enrollments/notifications. `enrollments` has
  `UNIQUE (student_id, course_id)`, so the student's list read is index-covered.
* **Not measured**: actual endpoint durations, payload byte sizes and SQL timings
  — no production/staging server access from here. Recommended next step is the
  timeline below plus server-side `X-Response-Time` sampling.

## 5. Instrumentation (new, dev-only)

`src/lib/perfTimeline.ts` records five stage timestamps and prints them once per
launch when the landing screen's data arrives:

```
[Perf] cold launch timeline (ms since JS start)
  js-start            0
  session-restored   34   (+34)
  security-verdict  920   (+886)
  profile-resolved 1180   (+260)
  screen-data      1495   (+315)
```

It is a no-op outside a dev build, records no ids/tokens/payloads, and answers
the question this investigation could not answer without hardware: **which gate
dominates on your device**. Cold launch, resume and a screen round-trip should be
measured separately.

Also present (pre-existing): `[CourseDetail] loaded duration=…ms` in dev builds.

## 6. Strategies evaluated

| Strategy | Verdict |
| --- | --- |
| Short-TTL cache of reused API data | **implemented** for the enrollment list (60 s, account-keyed, invalidated by writes) |
| Persistent cache | rejected for this data — enrollments/access can change server-side; offline data already has its own owner-scoped store |
| Stale-while-revalidate | already implemented for the listed screens |
| Dedupe identical in-flight requests | **implemented** where duplicates are proven (security config single-flight, credits cache, enrollment cache). A blanket transport-level dedupe was **rejected**: it would collide with the security-lock deferral queue and with POST semantics |
| Parallelise independent requests | already done in every in-scope loader |
| Avoid remounts / keep content on refresh | done earlier (`useStaleWhileRevalidateFocus`) |
| Lazy-load nonessential data | **implemented** for the dashboard: catalogue + categories moved to a second phase that starts after the first usable paint (`tests/dashboardLoadPhases.test.cjs`). The same trick is **not** applied to screens where the catalogue *is* the content (Explore, Course details) — there it would only move the spinner |
| Pagination / smaller payloads | **recommended**, not done: `getMySubscriptions` embeds `courses(*)`; narrowing it touches 6 consumers and needs payload measurements first |
| Image caching / thumbnails | already capped (8) and disk-cached by expo-image |
| Defer nonessential init | **implemented**: categories load in dashboard phase 2; image prefetch still runs on the catalogue response |
| Backend indexes | `enrollments` fine; `courses(status, created_at)` would help the published list on a large catalogue (needs a migration) |

## 7. Security invariants (unchanged, asserted)

* The network lock still defers/refuses every protected request; its allowlist is
  asserted **by exact set** in the new test.
* The 20 s deferral bound, fail-secure policy defaults, mandatory connection
  floor, 5-minute policy TTL, offline fast-path and all 13 detectors are
  unchanged.
* Cached enrollment data is **never** an authorization decision: course, lesson,
  material and video access are decided by the server on each delivery request
  (OTP, PDF delivery, download authorization).
* Cache entries are keyed by `studentId`; sign-out and account switch clear them.
* Nothing is cached after a failed read.

## 8. Tests

```
node tests/dataReusePerformance.test.cjs     # 37 passed (real call-count measurements)
node scripts/run-all-tests.cjs               # 122 suites passed, 0 failed
npx tsc --noEmit                             # clean
npx eslint <changed files>                   # 0 errors
```

`php -l` and the PHP suites: **not run** — no PHP binary in this environment.

## 9. What still needs a device

* Absolute timings for the five stages (use the printed timeline).
* Whether stage 2 (security-verdict) or stage 3/4 dominates on the user's iPhone.
* Frame-level render cost of the dashboards and list scrolling.
* Resume timings after >90 s in background (TLS probe reuse window).
