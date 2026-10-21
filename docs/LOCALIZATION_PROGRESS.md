# Arabic localization — migration status and continuation guide

**Snapshot:** 2026-10-21 · checkpoint after the "doctor role + student profile + shared
primitives" batch.

This file is the durable hand-off for the remaining localization work. Read it
together with `docs/LOCALIZATION.md` (architecture) and
`docs/TRANSLATION_TERMINOLOGY.md` (approved wording). It records what is done,
what is left, how to measure it, and the exact conventions a continuation must
follow so the dictionary does not fork.

---

## 1. Where the project stands

| Metric | Project baseline | Previous checkpoint | Now |
|---|---|---|---|
| Hardcoded-English candidates (`npm run i18n:audit`) | ~1 765 | 1 504 | **1 291** |
| Files with candidates | 112 | 101 | **80** |
| Dictionary keys (EN = AR, exact parity) | — | 1 299 | **1 607** |
| Localization gate `tests/i18nLocalization.test.cjs` | — | 105 passed | **120 passed, 0 failed** |
| Terminology gate `tests/i18nTerminology.test.cjs` | — | 85 passed | **85 passed, 0 failed** |
| Preference gate `tests/languagePreference.test.cjs` | — | 51 passed | **51 passed, 0 failed** |
| `npx tsc --noEmit` | clean | clean | **clean** |

Work on this batch started from an intermediate audit reading of 1 500 candidates
across 98 files; the "previous checkpoint" column is the last documented
snapshot (`docs/LOCALIZATION.md` history), not that intermediate number.

Reproduce:

```bash
npm run i18n:audit                      # counts candidates (a gauge, not a gate)
node tests/i18nLocalization.test.cjs    # dictionary + referenced-key + migrated-screen gate
node tests/i18nTerminology.test.cjs     # approved vocabulary + plurals
node tests/languagePreference.test.cjs  # precedence / persistence / runtime switching
```

The audit total counts *candidates*: JSX text, rendered props
(`placeholder`/`label`/`title`/`accessibilityLabel`/`message`), and literals in
`Alert.alert` / `showToast` / `setError`. Roughly 8–10 % of the remaining total
is a false positive (`Promise`, `void`, route paths, enum values) and a few rows
are stale hits from files edited after the audit ran; see §5.

---

## 2. Completed in this checkpoint

Every file below now imports the i18n module, resolves its copy through `t()`
(or a `labelKey`/`*Key` table resolved at render), and — where listed in
`MIGRATED_SCREENS` — is pinned by `tests/i18nLocalization.test.cjs` (retired-copy
assertions + referenced-key existence).

### Doctor role

| File | Namespace | Notes |
|---|---|---|
| `src/app/(app)/(doctor)/dr-overview.tsx` | `drOverview.*` + `nav.*`/`status.*` | 7-tile KPI grid, quick-action table (`labelKey`), recent lists, course status chip via `courseStatusLabel`, dates follow the app locale. |
| `src/app/(app)/(doctor)/courses.tsx` | `drCourses.*` + `courseStatus.*`/`difficulty.*` | Search/status filters, empty states, course cards, options sheet, delete dialog fact table, plural toasts (`deletedTitle` + `studentsRemoved.*`). Default new-course title stays data (`Untitled Course`) — see §5. |
| `src/app/(app)/(doctor)/students.tsx` | `drStudents.*` + `status.*` + `bulk.selected` | Tabs, bulk-selection bar, add-via-credits wizard, profile modal fact table, bulk confirm/result dialogs, per-status chips through `statusLabel`. |
| `src/app/(app)/(hubs)/doctor-earnings.tsx` | `doctorEarnings.*` | Admin view of a doctor's earnings: settings toggle, earnings mode, credit/course price modals, pricing history, `EGP` amounts are formatted LTR with Latin digits (`numberingSystem: 'latn'`). |

### Student role

| File | Namespace | Notes |
|---|---|---|
| `src/app/(app)/(student)/profile.tsx` | `studentProfile.*` + `profile.*`/`role.*`/`validation.*` | ID card, account/academic sections, subscription stats, security rows, info links (key table), edit-profile / change-password / academic modals, sign-out confirm. |

### Shared primitives and small screens

| File | Keys | Notes |
|---|---|---|
| `src/lib/i18n/labels.ts` | — | **New.** `statusLabel()`, `courseStatusLabel()`, `difficultyLabel()`: stored enum values stay untouched, only the printed label is localized. Use these instead of `textTransform: 'capitalize'` on a raw status string. |
| `src/components/ScreenState.tsx` | `common.loading`, `common.requestFailed`, `common.offlineTitle`, `common.somethingWentWrong`, `common.retryWhenOnline`, `common.tryAgain` | Loading/error defaults localized; explicit `label`/`retryLabel` props still win. |
| `src/components/ResponsiveModal.tsx` | `common.unsavedChanges`, `common.unsavedBody`, `common.keepEditing`, `common.discard` | Discard-changes dialog. |
| `src/components/MaintenanceGate.tsx` | `common.maintenanceTitle`, `common.tryAgainLater` | Server message itself is server-authored and passes through. |
| `src/app/index.tsx` | `landing.tagline`, `common.signIn`, `common.createAccount` | Landing screen. |
| `src/components/CourseProgressBar.tsx` | `course.yourProgress` | |
| `src/components/ContentProtectionWarning.tsx` | `common.iUnderstand`, `contentProtection.remainingViolations.*` | Plural-aware remaining-strikes sentence. |
| `src/components/ImpersonationBanner.tsx` | `impersonation.banner`, `impersonation.bannerAs` | |
| `src/components/OfflineVideoPlayer.tsx` (web stub) | `offline.webUnavailable`, `offline.webHint` | |
| `src/components/OfflineVideoPlayer.native.tsx` | `offline.errorExpiredRental`, `offline.errorIncomplete`, `offline.downloadExpired`, `offline.expiredBody`, `offline.playbackBlocked`, `offline.gateBody`, `offline.playbackError`, `offline.expiredBodyShort`, `offline.drmFail`, `player.exitFullscreen` | Player chrome uses the module-level `t()` (reads the active locale at call time); screens use `useTranslation()` so they repaint live. |
| `src/components/VdoCipherPlayerWebView.tsx`, `src/components/VdoCipherPlayerNativeAdapter.native.tsx` | `player.loading`, `player.unavailable`, `player.exitFullscreen` | |
| `src/components/ui/dialog.tsx` | `common.close` | Screen-reader-only close label. |
| `src/app/(app)/(student)/explore.tsx` | `common.courses`, `explore.searchPlaceholder` | |
| `src/app/(auth)/sign-in.tsx` | `auth.noAccountFound`, `common.networkError` | Last two English literals. |
| `src/app/(app)/info/privacy.tsx`, `src/app/(app)/info/terms.tsx` | `studentProfile.privacy`, `studentProfile.terms` | Headers (body copy comes from CMS). |

---

## 3. Remaining inventory (current audit, descending)

`node scripts/i18n-coverage.js --top 200` prints this list live.

| Candidates | File |
|---|---|
| 83 | `src/app/(app)/course-builder/[id].tsx` |
| 78 | `src/app/(app)/(hubs)/global-search.tsx` |
| 66 | `src/app/(app)/lesson-editor/[id].tsx` |
| 40 | `src/app/(app)/(hubs)/sa-audit.tsx` |
| 34 | `src/app/(app)/(superadmin)/sa-platform.tsx` |
| 33 | `src/app/(app)/(hubs)/sa-credits.tsx` |
| 31 | `src/app/(app)/(hubs)/enrollment-manager.tsx` |
| 30 | `src/app/(app)/(hubs)/create-student.tsx` |
| 28 | `src/app/(app)/(superadmin)/sa-users.tsx` |
| 27 | `src/app/(app)/(hubs)/trash-bin.tsx` |
| 26 | `src/app/(app)/(hubs)/video-library.tsx` |
| 26 | `src/components/VideoUploadQueue.tsx` |
| 25 | `src/app/(app)/(hubs)/sa-redeem-codes.tsx` |
| 25 | `src/app/(app)/user-activity.tsx` |
| 24 | `src/app/(app)/(hubs)/doctor-credit-timeline.tsx` |
| 24 | `src/app/(app)/(hubs)/sec-dashboard.tsx` |
| 24 | `src/app/(app)/(hubs)/video-settings.tsx` |
| 24 | `src/components/DeviceManagerSheet.tsx` |
| 22 | `src/app/(app)/(hubs)/sec-diag.tsx` |
| 22 | `src/app/(app)/my-devices.tsx` |
| 21 | `src/components/ActionMenu.tsx` |
| 20 | `src/app/(app)/(hubs)/bulk-import-students.tsx` |
| 20 | `src/app/(app)/(hubs)/notifications-center.tsx` |
| 20 | `src/app/(app)/(hubs)/revenue.tsx` |
| 20 | `src/app/(app)/(superadmin)/sa-analytics.tsx` |
| 19 | `src/app/(app)/(hubs)/bulk-credits.tsx` |
| 19 | `src/app/(app)/(hubs)/bulk-import.tsx` |
| 19 | `src/app/(app)/(hubs)/sec-policies.tsx` |
| 18 | `src/app/(app)/(hubs)/app-updates.tsx` |
| 16 | `src/app/(app)/(hubs)/content-protection.tsx` |
| 16 | `src/app/(app)/course/[id].tsx` |
| 15 | `src/app/(app)/(hubs)/cms.tsx` |
| 15 | `src/app/(app)/(hubs)/health.tsx` |
| 15 | `src/app/(app)/(hubs)/storage.tsx` |
| 15 | `src/app/(app)/security-diagnostics.tsx` |
| 14 | `src/app/(app)/(hubs)/credits.tsx` |
| 14 | `src/app/(app)/(hubs)/sa-courses.tsx` |
| 14 | `src/app/(app)/(superadmin)/sa-finance.tsx` |
| 13 | `src/app/(app)/(hubs)/admin-credits.tsx` |
| 13 | `src/app/(app)/(hubs)/revenue-analytics.tsx` |
| 13 | `src/app/(app)/(hubs)/sa-reports.tsx` |
| 13 | `src/app/(app)/archived-courses/index.tsx` |
| 12 | `src/app/(app)/(hubs)/branding.tsx` |
| 12 | `src/app/(app)/(hubs)/currency.tsx` |
| 12 | `src/app/(app)/(hubs)/export-panel.tsx` |
| 12 | `src/app/(app)/(hubs)/maintenance.tsx` |
| 12 | `src/app/(app)/(hubs)/sa-content.tsx` |
| 11 | `src/app/(app)/(hubs)/reports.tsx` |
| 11 | `src/app/(app)/(hubs)/sa-support-settings.tsx` |
| 11 | `src/app/(app)/(hubs)/violation-management.tsx` |
| 11 | `src/components/VideoLibraryPicker.tsx` |
| 9 | `src/app/(app)/(hubs)/delete-permissions.tsx` |
| 9 | `src/app/(app)/(hubs)/student-credentials.tsx` |
| 9 | `src/app/(app)/offline-library.tsx` |
| 8 | `src/app/(app)/(hubs)/db-audit.tsx` |
| 8 | `src/app/(app)/(hubs)/feature-flags.tsx` |
| 8 | `src/app/(app)/(hubs)/impersonation.tsx` |
| 8 | `src/app/(app)/info/contact.tsx` |
| 7 | `src/components/VideoReplaceSheet.tsx` |
| 6 | `src/app/(app)/(hubs)/system-providers.tsx` |
| 6 | `src/app/(app)/offline-course.tsx` |
| 6 | `src/components/CourseCard.tsx` |
| 6 | `src/components/VideoThumbnailCard.tsx` |
| 6 | `src/components/YouTubePlayer.tsx` |
| 5 | `src/app/(app)/(hubs)/fraud-alerts.tsx` |
| 5 | `src/app/(app)/info/about.tsx` |
| 5 | `src/components/LargeFileWarning.tsx` |
| 5 | `src/components/StorageMonitor.tsx` |
| 4 | `src/app/(app)/(hubs)/video-providers.tsx` |
| 4 | `src/components/OfflineVideoPlayer.native.tsx` |
| 3 | `src/components/SubscribeSheet.tsx` |
| 2 | `src/app/(app)/(student)/explore.tsx` |
| 2 | `src/app/(auth)/sign-in.tsx` |
| 2 | `src/app/index.tsx` |
| 2 | `src/components/MaintenanceGate.tsx` |
| 2 | `src/components/ResponsiveModal.tsx` |
| 2 | `src/components/ScreenState.tsx` |
| 2 | `src/components/VdoCipherPlayerNativeAdapter.native.tsx` |
| 2 | `src/components/VdoCipherPlayerWebView.tsx` |
| 1 | `src/app/(app)/(admin)/users.tsx` |
| 1 | `src/app/(app)/(doctor)/courses.tsx` |
| 1 | `src/app/(app)/info/privacy.tsx` |
| 1 | `src/app/(app)/info/terms.tsx` |
| 1 | `src/app/(app)/lesson/[id].tsx` |
| 1 | `src/components/ConfirmDialog.tsx` |
| 1 | `src/components/ContentProtectionWarning.tsx` |
| 1 | `src/components/CourseProgressBar.tsx` |
| 1 | `src/components/ImpersonationBanner.tsx` |
| 1 | `src/components/OfflineVideoPlayer.tsx` |
| 1 | `src/components/OfflineVideoPlayer.types.ts` |
| 1 | `src/components/ProfilePhotoActions.tsx` |
| 1 | `src/components/ui/dialog.tsx` |
| 1 | `src/components/VdoCipherPlayer.tsx` |
| 1 | `src/components/VideoPlayer.tsx` |

> The single-candidate rows in the shared components are almost all stale audit
> hits: the file was edited in this batch but the audit line was recorded before
> the edit. Re-run the audit before touching them — the only genuine leftovers in
> that group are type annotations (`Promise`, `void`) which must not be
> translated.

---

## 4. Ordering that gives the most coverage per unit of work

1. **`course-builder/[id].tsx` → `lesson-editor/[id].tsx`** — 149 candidates in
   two files, mostly toasts + field labels; reuse `course.*` and `lesson.*`
   keys wherever the meaning already matches.
2. **`global-search.tsx`** — the last shared entry point that is fully English.
3. **Super Admin cluster** (`sa-audit`, `sa-platform`, `sa-credits`,
   `sa-users`, `sa-analytics`, `sa-finance`, `sa-courses`, `sa-content`,
   `sa-reports`) — one `sa*` namespace per screen; `saOverview.*` and
   `saEarnings.*` already exist and are the style template.
4. **Hubs tail** (bulk import, video library, security policy screens) — many
   are 5–20 candidates and can be closed in one pass each.
5. **Student extras** (`user-activity`, `my-devices`, `offline-library`,
   `offline-course`, `info/*`) — reuse `profile.*`, `device.*` and `offline.*`.

---

## 5. Classifying a candidate before translating it

The audit deliberately over-counts. For each hit decide:

1. **Genuine first-party UI copy** → migrate to `t()` / a `labelKey` table.
2. **Machine-readable values that must not change** — enum values
   (`'suspended'`, `'logged_out'`), API field names, route paths, storage keys,
   `testID`s, CSS-ish tokens. Translate the *label*, never the value — use
   `statusLabel()` / `courseStatusLabel()` from `src/lib/i18n/labels.ts`.
3. **Third-party controlled text** — Plyr/YouTube/VdoCipher chrome, vendor
   brand names, user-authored content. Leave as-is (see `docs/LOCALIZATION.md`
   §5). Brand names that appear as *our* labels (e.g. WhatsApp) can be
   transliterated (`واتساب`) because we own the label.
4. **Persisted data defaults** — `Untitled Course` (new-course title),
   CMS bodies, course titles: stored values, not UI chrome. Translating them
   would write a language-specific value into the database, so they stay English
   and are listed here as intentional.
5. **False positives** — type annotations (`Promise`, `void`), identifiers,
   comments already stripped by the scanner, file paths, `Content-Type`-style
   constants, `sr-only`/test-only strings. Never add a dictionary key for these.

Additional rules:

- Do not translate backend-returned raw messages blindly. Map *stable* error
  patterns/ids (as `validation.ts` does) and let the rest pass through.
- Keep inherently LTR content (emails, URLs, `+20…` numbers, `EGP`/ISO currency
  codes) LTR even inside Arabic strings. For dates use
  `toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en-US', { numberingSystem:
  'latn', … })` so month names localize while digits stay consistent.
- Never rename or remove existing keys that other screens already use; add a
  sibling key when the context genuinely differs.

---

## 6. Conventions for the next batch

```tsx
// screen/component
import { useTranslation } from '@/lib/i18n';

export default function Screen() {
  const { t, tCount, locale } = useTranslation();
  …
}
```

- **Namespace per surface:** `drOverview.*`, `drCourses.*`, `drStudents.*`,
  `doctorEarnings.*`, `studentProfile.*`, `adminDevices.*`, `adminUsers.*`,
  `adminAudit.*`, `adminAcademic.*`, `password.*`, `editUser.*`, `createUser.*`,
  `bulk.*`, `profilePhoto.*`, `deleteAccount.*` follow the screen, not the role.
- **Module-level tables** (chips, filters, action menus) carry
  `labelKey` / `descriptionKey` and are resolved with `t(entry.labelKey)`
  inside the component. `tests/i18nLocalization.test.cjs` verifies every such
  literal key exists in both dictionaries.
- **Enum labels** go through `src/lib/i18n/labels.ts`, never through a raw
  `textTransform: 'capitalize'` (capitalization is meaningless in Arabic).
- **Plurals:** use `tCount('ns.base', n)` with all six CLDR forms
  (`zero/one/two/few/many/other`). Arabic one/two forms may drop `{count}` —
  but only when no other placeholder is present (the gate enforces the rule);
  otherwise keep `{count}` and phrase the sentence around it.
- **Beware shadowing:** `onChangeText={t => …}`, `lbl(t)`, `tabs.map(t => …)`
  and `(t: string)` params silently shadow the translator. Rename the local to
  `v`/`label`/`tabItem` (this was required in several files already).
- **Interpolation over concatenation:** one key with `{name}`/`{count}` instead
  of `Prefix + variable + suffix`. Two complete sentences may be joined with a
  space when each is independently translatable (see `drCourses.deletedTitle`
  + `drCourses.studentsRemoved`).
- Add the new keys to **both** `en` and `ar` in
  `src/lib/i18n/resources.ts` (append in the section matching the namespace),
  then run the gates below.

---

## 7. Definition of done for a batch

```bash
node scripts/i18n-coverage.js --top 20          # total must drop, no new file may appear
node tests/i18nLocalization.test.cjs            # every referenced/table key exists in EN + AR
node tests/i18nTerminology.test.cjs             # vocabulary + plurals unchanged or documented
node tests/languagePreference.test.cjs
NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit
npx eslint <changed files>
```

Then extend `MIGRATED_SCREENS` in `tests/i18nLocalization.test.cjs` with the
file, a `minKeys` floor and 3–5 **retired** English strings that must no longer
appear in the component code (comments are stripped before the check, so a
string that only survives in prose is still retired).
