# RTL navigation, resume loading and continuous watermark motion — fix report

Date: 2026-10-25

This document records what was actually broken, what changed, and what still
requires a physical-device run. It is written after re-inspecting the code,
not from the previous attempt's claims.

---

## 1. Navigation drawer changed sides (iOS, now also Android)

### Root cause

`panelTrackStyle()` anchored the panel with:

```ts
direction: 'rtl', justifyContent: 'flex-end'
```

Yoga **reverses the main axis** of a `row` under RTL. So in an RTL row
main-start is the RIGHT edge and `flex-end` is the **LEFT** one. The panel was
laid out on the left while its slide vector (`closedOffset = +width`, i.e.
"closed to the right") still pointed right: on open it travelled inwards from
~290 px and settled on the LEFT edge — the reported "it opens on one side and
moves to the other", which appeared on iPhone as soon as the anchor changed.

A second, independent hazard was present: the anchor depended on the layout
direction (`direction: 'rtl'`) while `I18nManager.isRTL` also mirrors `row`
navigators. Two mirrors is one too many; the result differs depending on
whether the native RTL relaunch has already happened.

### Fix

`flexDirection` is **physical** — Yoga never flips `row` / `row-reverse`
because of `direction` — so the mirror is expressed exactly once, physically:

| App locale | track `direction` | track `flexDirection` | panel lands |
| ---------- | ----------------- | --------------------- | ----------- |
| English    | `ltr` (pinned)    | `row`                 | LEFT        |
| Arabic     | `ltr` (pinned)    | `row-reverse`         | RIGHT       |

The panel itself re-declares the app locale's direction
(`panelDirection`), so Arabic content still lays out right-to-left even on the
launch before a native RTL relaunch.

`DrawerNav` also **snaps** the animated offset when the home edge changes
(`sideRef`), so switching language while the drawer is closed/open cannot
animate the panel across the screen.

Files: `src/lib/ui/drawerDirection.ts`, `src/components/DrawerNav.tsx`.

---

## 2. Arabic greeting still left-aligned

### Root cause

`DashboardHeader` derived its row from `direction: isRTL ? 'rtl' : 'ltr'`.
That relies on the platform honouring the per-view direction *and* does not
change the fact that the title block is `flex: 1` and its text children fill
the column. On the launch before the native RTL relaunch the block sat at the
trailing edge with only `textAlign: 'right'` inside it — visually left-ish,
exactly as reported.

### Fix

* Physical row order: `flexDirection: isRTL ? 'row-reverse' : 'row'` with
  `direction: 'ltr'` on the row (one mirror only).
* Explicit physical padding (`paddingLeft` / `paddingRight`) — `paddingStart`
  would resolve against the forced LTR.
* The title block anchors its whole content column with
  `alignItems: isRTL ? 'flex-end' : 'flex-start'`, so the greeting and the
  account name below it align to the same edge even if a text-level
  `textAlign` were ever lost.
* The account name is still **data**: never translated, never transliterated,
  never replaced by the role label.

Files: `src/components/DashboardHeader.tsx`.

---

## 3. Doctor contact sheet stayed English

### Root cause

`SubscribeSheet` (the single flow behind both the Explore list and the course
page) had hardcoded English copy: title, hint, loading, error, retry, empty
state and accessibility labels. It also had no direction handling.

### Fix

* New dictionary keys (English + Arabic): `course.subscribeSheetTitle`,
  `…Hint`, `…Loading`, `…Error`, `…ErrorHint`, `…Empty`.
* Channel labels go through the existing dictionary (`contact.whatsapp`,
  `contact.phone`, …). Product names keep their brand spelling; a
  Super-Admin-provided custom label stays verbatim because it is data.
* The sheet declares the app locale's direction (`direction: rtl|ltr`), so
  rows mirror (icon on the right), the directional chevron flips (`‹` / `›`)
  and the close control uses `marginStart`.
* Instructor name/number/handle are never translated. Subscription logic and
  the authorization of the contact list are untouched.

Files: `src/components/SubscribeSheet.tsx`, `src/lib/i18n/resources.ts`.

---

## 4. Arabic bottom-tab order

### Root cause / requirement

Arabic must read right→left: Home rightmost, then Explore, My Courses, Profile
leftmost. Two surfaces render the bar:

* **JS bar (Android/web)** — our own `flexDirection: 'row'` row, which only
  reverses when `I18nManager.isRTL` is true. That flag is set only by the
  native relaunch a language switch schedules, so at runtime the order lagged.
* **iOS native bar** — UITabBar mirrors by itself when the app is RTL. Reversing
  the array unconditionally would double-reverse.

### Fix

* JS bar: `direction: 'ltr'` (neutral) + `flexDirection: isRTL ? 'row-reverse'
  : 'row'`. The manual mirror is the only mirror, and it applies immediately on
  a language change.
* iOS bar: reverse a **copy** of the visible tabs only when the app direction
  and the platform direction disagree (`appRTL !== I18nManager.isRTL`) — the
  one case the system cannot produce by itself.
* Route mapping untouched: items are still rendered and pressed by
  `route.name`, hidden tabs are still excluded, `initialRouteName` and
  `backBehavior="history"` unchanged.

Files: `src/components/ResponsiveTabBar.tsx`,
`src/components/navigation/RoleTabShell.ios.tsx`.

---

## 5. Long loading after resume + false "Course not found"

### Root cause

Two separate defects:

1. **Every failure was reported as not-found.** `course/[id].tsx` loaded inside
   `try { … } catch {}` and rendered `course === null` as "Course not found".
   A 30 s timeout, a request deferred by the security lock during post-resume
   device verification (refused when the 20 s deferral bound expired), a
   containment abort, a token-refresh race or a 502 all produced the same
   message — for a course the student was enrolled in.
2. **The resume verification ran twice.** `(app)/_layout.tsx` called
   `check()` on every foreground transition *in addition to* SecurityContext's
   own authoritative resume verification (`requestResumeVerification('resume')`).
   Two full evaluations meant two native detector sweeps, two TLS probes and
   two policy fetches while the network lock held every screen request.

### Fix

* New pure module `src/lib/courseLoadError.ts`:
  * `notFound` **only** for HTTP 404, the adapter's no-row verdict
    (`PGRST116`/`not_found`) or a message that says the row does not exist;
  * everything else is `transient`; `retryable: false` only for authoritative
    refusals (401/403, suspended account, failed authentication).
* `course/[id].tsx`:
  * a generation guard so only the newest load may commit state (a stale error
    can no longer overwrite fresh content, and vice versa);
  * `setLoading(false)` in `finally` — a hung or queued request can never leave
    an indefinite spinner;
  * a distinct failure state (“Could not load this course”, access unchanged)
    with a Retry action; “Course not found” is reserved for a real missing row;
  * bounded auto-retry (2 attempts, 800 ms → 1600 ms) only for transient,
    retryable failures and only when nothing is on screen;
  * an enrollment/progress failure no longer aborts the course page;
  * a background refresh keeps content mounted (`loading && !course`);
  * diagnostics: duration, sanitized status/code/message, classification,
    retryability. No token, no payload, no identity.
* `(app)/_layout.tsx`: the duplicate `check()` is removed; SecurityContext is
  the single resume verification. Feature-flag refresh and warning presentation
  are unchanged (warnings still route from the one published verdict).

Bounded retries only, no polling, no timer chains, and every existing
enforcement (token expiry, integrity, forced update, entitlement, lock
deferral bounds) is untouched.

Files: `src/lib/courseLoadError.ts` (new), `src/app/(app)/course/[id].tsx`,
`src/app/(app)/_layout.tsx`.

---

## 6. VdoCipher watermark was stationary (and looked like the provider mark)

### Root causes

1. **The frame loop could not run the physics.** The step functions in
   `watermarkMotion.ts` were plain JS, but `useFrameCallback` runs a Reanimated
   **worklet** on the UI thread, and a worklet may only call other worklets.
   The step therefore never completed.
2. **The loop read stale geometry.** It read `containerWRef.current` /
   `pillWRef.current`. A worklet captures plain objects when it is created, so
   mutations on the JS thread are invisible to it: the loop saw `0` and bailed
   out on **every** frame. The mark only moved when `syncMotion()` re-projected
   it from the JS thread on a layout pass — "stationary for long periods, moves
   occasionally", exactly as reported.
3. **On iPhone the visible mark was the provider `rtext` layer**, which
   relocates once per `interval` (8 s) and cannot bounce continuously. That is
   also why it "still looked like the old watermark".

### Fix

* `'worklet'` on `stepWatermarkMotion`, `advanceAxis`, `clamp`, `maxCoord`
  (they stay ordinary callable functions for Node tests and `syncMotion`).
* Geometry moved to shared values (`containerWSV`, `containerHSV`, `pillWSV`,
  `pillHSV`) updated in the layout callbacks; the frame callback reads only
  those.
* DEV heartbeat `[VDO_WM_MOVE] moved=yes|NO …` every 2 s gives device-readable
  proof of motion (position, per-axis delta, velocity, box size; no identity).
* Layer policy: the server now selects the layer with `VIDEO_WATERMARK_LAYER`
  (`backend/src/Video/VdoCipherService.php`):
  * `app` (default) — no `annotate` on the OTP, so `annotateApplied` is false
    and every player path renders the app overlay (RN overlay for the native
    SDK, in-HTML watermark for the web player): continuous motion, Plyr design.
  * `provider` — attach `annotate`; the app then suppresses its own overlay.
    Stronger forensically (burned into the stream) but one relocate per
    interval, so continuous motion is impossible on it.
  The anti-duplication rule (`resolveWatermarkLayers`) is unchanged and holds on
  both settings, including against an old server that still sends `annotate`.

> **Trade-off you can reverse:** the `app` default moves the watermark from a
> burned-in stream mark to the application overlay (same identity, two lines,
> same typography). The overlay is client-rendered; FLAG_SECURE/screen-capture
> protection is unchanged. Set `VIDEO_WATERMARK_LAYER=provider` to restore the
> burned-in mark and accept an 8-second relocate instead of continuous motion.

Files: `src/lib/watermarkMotion.ts`, `src/components/NativeWatermarkOverlay.tsx`,
`src/lib/watermarkLayers.ts` (documentation), `backend/src/Video/VdoCipherService.php`,
`backend/.env.example`.

---

## Tests

| Command | Result |
| ------- | ------ |
| `npx tsc --noEmit -p tsconfig.json` | clean |
| `npm run test:state` | 274 + 79 passed, 0 failed |
| `node scripts/run-all-tests.cjs` | 114 suites passed, 1 failed |
| `node tests/navigationDrawerDirection.test.cjs` | 70 passed |
| `node tests/courseLoadFailure.test.cjs` (new) | 38 passed |
| `node tests/watermarkContinuousMotion.test.cjs` (new) | 23 passed |
| `node tests/arabicTabOrder.test.cjs` (new) | 24 passed |
| `npx eslint <changed files>` | 0 errors (pre-existing warnings only) |

The one failing suite is `dependencyLicensePolicy.test.cjs`, **pre-existing and
unrelated**: a previous session overwrote `DEPENDENCY_LICENSE_AUDIT.md` with a
different report, so the audit no longer names `tecnickcom/tcpdf` /
`LGPL-3.0-or-later`. It must be restored by re-running the licence audit; no
content was invented here.

Suite updates (assertions were changed to the NEW contract, not weakened):
`navigationDrawerDirection`, `courseByIdSelect`, `navigationLoadingAndPrefetch`,
`perceivedPerformance`, `doctorHeaderVideoLibraryCreditsLocalization`,
`courseBuilderLocalizationAndRtl`, `supportContactFlows`.

---

## Physical-device checklist (not run here)

iOS and Android, Arabic then English:

1. Open/close/reopen the drawer ten times — it must stay on the right in Arabic
   and the left in English, including after switching language without a
   restart.
2. Dashboard: `مرحباً` and the account name right-aligned, in that order; an
   English or mixed-script name keeps its own script.
3. Bottom tabs in Arabic: الرئيسية rightmost → استكشاف → دوراتي → الملف الشخصي
   leftmost; tap each; restart and confirm persistence.
4. Course page → Subscribe: every label Arabic, rows mirrored, chevron on the
   left of each row; open one channel.
5. Resume: background the app 5 s and 30 min, return to a course, repeat.
   Watch for `[CourseDetail] loaded duration=…` in the log; any failure must
   read "Could not load this course" with Retry — never "Course not found".
6. Video: watch a VdoCipher lesson for 60 s and confirm `[VDO_WM_MOVE]
   moved=yes` every 2 s with changing `dx`/`dy` and periodic sign flips; enter
   and exit fullscreen, rotate, pause/resume; leave and reopen the player.

---

## Backend deployment

Only one backend source file changed:

* `backend/src/Video/VdoCipherService.php`
* `backend/.env.example` (documentation only; nothing to upload)

Server configuration:

* Optional: `VIDEO_WATERMARK_LAYER=app` (default) or `provider`.
  Without this change the server keeps attaching `annotate`, so iOS continues to
  show the provider mark until the file is uploaded.

Frontend: rebuild the app (Expo native build for iOS/Android). No new
dependency, no native config-plugin change, no migration, no VdoCipher dashboard
change is required.
