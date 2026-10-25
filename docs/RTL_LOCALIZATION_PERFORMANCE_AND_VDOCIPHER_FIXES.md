# RTL / localization / loading / VdoCipher fixes (2026-10-25)

Scope: the seven reported issues from the Android + iOS device screenshots.
Every item below was traced in the real code before changing it; nothing was
"styled over". Device-specific behaviour that could not be reproduced on a
physical device is called out explicitly in §Remaining limitations.

| # | Issue | Root cause (short) | State |
|---|-------|--------------------|-------|
| 1 | Student greeting showed the role label instead of the name | `roleLabel={t('role.student')}` was passed where line 2 belongs | fixed |
| 2 | Android drawer opened from the right, settled on the left | panel anchored with a physical `left:0`/`right:0` + `translateX` | fixed |
| 3 | Course details ignored Arabic | ~30 English literals in `course/[id].tsx` + `CourseProgressBar` | fixed |
| 4 | Language options crowded, checkmark misplaced | `space-between` rows, free-floating 18 dp check | fixed |
| 5 | Long loading on resume / thumbnails / navigation | spinner-per-focus, unbounded image prefetch, 8 s GET probe on every resume | fixed (see §5) |
| 6 | VdoCipher watermark does not move | screen shows the *provider* layer, which the app cannot animate | documented + bounded |
| 7 | VdoCipher offline error 6120 | inline `embedInfo` → bridge re-runs `load()` on every render | fixed |

---

## 1. Student greeting

**Was:** `DashboardHeader roleLabel={t('role.student')} greeting={t('home.welcome')}`
→ Arabic showed "طالب" over "مرحباً"; the account name never appeared.

**Now:** line 1 = `t('home.welcome')` ("مرحباً" / "Welcome"), line 2 = the
authenticated account name. `DashboardHeader` gained `subtitle` +
`subtitleAccessibilityLabel`; the role label is no longer passed by the student
dashboard (doctor/admin dashboards keep their existing overline).

The name is **data**: it is read from `profile.full_name`, never passed through
`t()`, never transliterated, and rendered without a `writingDirection` override
so an Arabic name lays out RTL, a Latin name LTR, and a mixed-script name is
resolved by the platform bidi algorithm. `textAlign` still follows the app
direction. Empty/missing → `t('common.user')` ("مستخدم" / "User").

Files: `src/app/(app)/(student)/dashboard.tsx`,
`src/components/DashboardHeader.tsx`, `src/lib/i18n/resources.ts`
(`home.signedInAs`).

## 2. Android drawer side

**Root cause:** the panel was pinned with physical `left: 0` / `right: 0` and
moved with `translateX`. Which of `left`/`right` wins for an absolutely
positioned view under an RTL layout direction changed across RN/Yoga versions
(Yoga 1 resolved them against the writing direction, later versions physically).
When the anchor and the slide axis disagree, the panel *arrives* from the right
and *settles* on the left — the reported symptom.

**Fix:** the panel no longer uses any physical edge. It sits inside a full-screen
track whose `direction` is forced from the app locale and whose
`justifyContent` puts it on the inline-start edge
(`flex-start`/`ltr` vs `flex-end`/`rtl`). Flexbox has no left/right ambiguity, so
the open and closed positions cannot disagree. The scrim is now a full-screen
layer behind the panel (zIndex 1 vs 2), so it needs no geometry of its own and a
tap anywhere outside the panel still closes the drawer. Slide offsets, border
edge, shadow direction, chevrons and the active-row rule all still come from the
same pure model.

Files: `src/components/DrawerNav.tsx`, `src/lib/ui/drawerDirection.ts`,
`tests/navigationDrawerDirection.test.cjs` (updated to the new invariants).

## 3. Course details localization

Every application-owned label on `src/app/(app)/course/[id].tsx` now goes
through the existing i18n layer: not-found state, back button label, archived
banner, Preview-as-Student banner and its exit button, difficulty badge, lesson
counts, price "Free", progress stats, "About This Course", feature rows,
"Course Content" + the `sections · lessons · time` summary, per-section counts,
`x of y done`, "Free Preview", "Available <date>", "Subscribe", and the lesson
row accessibility labels. `CourseProgressBar` (rendered on this screen) had the
same problem and is localized too ("% complete", "done", "left", remaining time).

* Counts are **plural-aware** via `tCount` (`course.sectionCount.*`,
  `home.lessonsCount.*`), so Arabic gets its own dual/plural forms instead of a
  `n === 1 ? ... : ...s` ternary.
* Dates use `formatLocalizedDate(..., locale)` — no `toLocaleDateString('en-US')`
  anywhere on the screen.
* Course language is stored from a **fixed** list in the builder, so those known
  names are translated (`languageName.*`); any other stored text is shown
  verbatim.
* **Not translated (by design):** course titles, section names, lesson titles,
  instructor names, tags, descriptions, price amount, archive reason. Note the
  screenshot's "New Section": that is a stored *section title* (the builder's
  default name for a new section), not a UI label — translating it would rewrite
  doctor-authored content. New sections created in Arabic get the Arabic default,
  because the default name comes from the dictionary at creation time.

Files: `src/app/(app)/course/[id].tsx`, `src/components/CourseProgressBar.tsx`,
`src/lib/i18n/resources.ts` (`course.*` block, `languageName.*`).

## 4. Language selector

Rows used `justifyContent: 'space-between'` inside one undivided card, with the
selected check as a bare 18 dp icon at the row's trailing edge (and an empty
18 dp spacer on the others). A long translated label pushed it around, and with
no separation it read as belonging to the gap between options.

Now: one card, one full-width row per option (`minHeight: 56`, `gap: 10`, own
1 dp border, selected tint), and a fixed 22 dp radio marker on **every** row at
the leading edge — its position cannot depend on label length, and it mirrors
automatically in RTL. The check/busy spinner is drawn *inside* the marker.
Labels flex with `minWidth: 0` so they never clip. Radio semantics
(`accessibilityRole="radio"`, `accessibilityState.selected`) and the
saved/save-failed toasts are unchanged, as is persistence and the relaunch hint.

Files: `src/components/LanguageSetting.tsx`.

## 5. Loading / performance

### 5a. Course screen no longer blanks on every focus
`useFocusEffect(() => { setLoading(true); loadData(); })` replaced the content
with a full-screen spinner every time the screen regained focus. It now uses the
existing `useStaleWhileRevalidateFocus`: first entry keeps the spinner, later
entries refresh in the background with content mounted. `hasContent` also
requires `course.id === id`, so a reused route instance never shows another
course's data. `previewMode` changes still trigger a reload (no spinner).

### 5b. Duplicate request batches
`useStaleWhileRevalidateFocus` now holds an in-flight guard: a focus that fires
while a load is already running is skipped instead of starting a second identical
batch. This is a concurrency guard, **not** a cache — no response is stored or
reordered, and the next focus after it settles fetches normally.

### 5c. Thumbnail prefetch is bounded
`prefetchCourseImages` warmed **every** published course image right after login
— a burst competing with the images the list actually needed, which is why the
first visible thumbnails arrived last. It now warms at most
`PREFETCH_LIMIT = 8` per call (already-warmed URLs still skipped); everything
else loads on demand from expo-image's disk cache, which is then warm for the
next visit. Course image URLs are content-stable paths (`/storage/public/...`),
so the cache key does not change between launches.

### 5d. Resume: the slowest security detector was a GET
All security detectors run in parallel, so the background→foreground hold waits
for the slowest one. The TLS-pinning probe did `GET <api root>` with an 8 s
budget on every check *including every resume*. It only needs the handshake (it
classifies "any HTTP status" plus failure text), so it is now `HEAD` with a 5 s
bound. Detection semantics are unchanged: pin-mismatch classification
(`tls_rejected` → `ssl_pinning_failure`), the offline fast path, the 10 s
per-detector bound and the parallel execution are all untouched. Worst-case hold
from this detector drops from 8 s to 5 s, and no response body is downloaded.

**Measurements.** No physical device profiling was available in this
environment, so no before/after millisecond figures are claimed. What is
verifiable and deterministic:
* returning to the course screen no longer unmounts content or shows a spinner
  (previously: every focus);
* at most 8 image prefetches per data load (previously: the whole catalog);
* at most one identical request batch per screen at a time;
* the resume-critical probe is bounded at 5 s instead of 8 s, HEAD instead of GET.

## 6. VdoCipher watermark motion

The moving ("bouncing") watermark is `NativeWatermarkOverlay`, driven by
`watermarkMotion.ts` (billiard physics, Reanimated `useFrameCallback`, no
per-frame React renders, no timers). It is mounted wherever
`resolveWatermarkLayers()` selects the **app** layer: Android native playback and
all offline playback.

Where the student sees the **provider** layer — iOS native and the WebView player
— the mark is drawn by VdoCipher *inside* its own protected surface. React
Native cannot animate it, and there is no supported provider API for per-frame
movement (`interval`/`skip` only relocate it on a timer). The only ways to get
continuous motion there would be:
1. render the app overlay *on top* as well → two watermarks at once (explicitly
   forbidden by the anti-duplication contract), or
2. drop the burned-in provider annotation and rely on the app overlay → replaces
   an unremovable layer with a client-hideable one.

Neither is a safe default, so the limitation is documented in
`src/lib/watermarkLayers.ts` rather than worked around. Owner decision required
if motion on iOS must take priority over the burned-in layer.

## 7. VdoCipher offline 6120

**What 6120 is (vendor documentation, not inference).** VdoCipher's Android error
table lists **6120 = "Renderer Error"**: "This can occur temporarily on some rare
devices (also permanently on a few) due to memory or resource constraints
required for video playback… Make sure you are not loading more than one
VdoPlayer instance at any given time, as that would make this error much more
common." The same table documents **6187** separately as an expired DRM license.
Sources: <https://www.vdocipher.com/docs/mobile/android/error-codes/>,
offline API: <https://www.vdocipher.com/docs/mobile/react-native/offline/>,
persistent license: <https://www.vdocipher.com/docs/server/playbackauth/offline/>.

So the failure stage is **playback/decoder initialisation**, not download and not
license expiry (6187 would be reported instead). The app's download side already
follows the documented contract: `VdoDownload.getDownloadOptions(enqueue)` with
track selection, live SDK events, `VdoDownload.query()` reconciliation, and an
offline OTP that carries `licenseRules = {canPersist: true, rentalDuration}`
(`backend/src/Video/VdoCipherService.php::offlineAuthorize`).

**Root cause found:** `vdocipher-rn-bridge`'s Android
`ReactVdoPlayerUIViewManagerImpl#setEmbedInfo` does not diff its input — it
rebuilds `VdoInitParams` and calls `vdoPlayer.load(params)` every time React hands
it an object. Both adapters passed an **inline object literal**, so every state
change on the screen (loading, watermark flags, fullscreen, ready, error) produced
a new object and a fresh `load()` over the live session: repeated player
initialisations, exactly the condition the vendor says makes 6120 common. It also
explains the "static/reset watermark" feel and audio restarting.

**Fix:**
* online adapter: `embedInfo` memoised on `[otp, playbackInfo]`;
* offline player: `offlineEmbedInfo` memoised on `[entry.meta.mediaId]`;
* both are now passed by reference, so the native view initialises once per
  session and is never remounted by a re-render;
* the offline error surface gained a one-tap **Retry** that clears the error and
  bumps an attempt counter used in the player's `key` — the failed native view is
  unmounted (releasing its decoder/DRM session) and a fresh one is created. That
  is the documented recovery for a transient 6120, without asking the student to
  force-quit the app. An **expired rental** (6187-class) is never offered a retry
  — it needs a new download.

Files: `src/components/VdoCipherPlayerNativeAdapter.native.tsx`,
`src/components/OfflineVideoPlayer.native.tsx`.

## Tests

`node scripts/run-all-tests.cjs` → **112 suites passed, 0 failed** (273 s).

New suites (all passing):
* `tests/studentGreetingAndLanguageSelector.test.cjs` (23)
* `tests/courseDetailsLocalization.test.cjs` (37)
* `tests/vdoPlayerSingleInitAnd6120.test.cjs` (24)
* `tests/navigationLoadingAndPrefetch.test.cjs` (20)

Updated: `tests/navigationDrawerDirection.test.cjs` (new flex-anchor invariants).
Also run: `npx tsc --noEmit` (clean), `npx eslint` on every changed file
(0 errors; only pre-existing unused-import warnings), `node scripts/i18n-coverage.js`
reports **no** hardcoded copy left in the course screen or progress widget.

## Backend

**No backend file was modified or created by this task, so there is nothing new to
upload for it.** The offline DRM contract it depends on
(`canPersist`/`rentalDuration` in `VdoCipherService::offlineAuthorize`) already
exists in the repository; `tests/vdoPlayerSingleInitAnd6120.test.cjs` now guards
it.

## Remaining limitations

1. **No physical Android/iOS device was available here.** Items 1, 3, 4 are
   verifiable from code and tests; item 2's RTL behaviour and item 7's DRM
   recovery need a device run (see the checklist in the final report).
2. **Item 6 on iOS/WebView** is a provider-layer limitation, not an app bug.
3. Offline playback also needs a VdoCipher entitlement whose offline OTP permits
   persistence; without it the SDK reports a licence error (not 6120).
