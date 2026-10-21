# Arabic localization

The app ships in **English and Arabic**. By default the language follows the
**device** language, but users can pin a language from the in-app
**App Language / لغة التطبيق** selector (student profile and doctor profile
settings). The choice persists across restarts and can be returned to
"system default".

Effective language, in order:

1. an explicit saved override (`ar` / `en`) — wins over everything;
2. otherwise the device's preferred language list;
3. an unsupported device language falls back to **English**.

## 1. Architecture

```
src/lib/i18n/
  resources.ts       flat, dot-namespaced EN + AR dictionaries (source of truth)
  detect.ts          PURE: tag → locale, interpolation, fallback chain, non-translatable keys
  preference.ts      PURE: preference model ('system' | 'ar' | 'en'), precedence, parsing
  preferenceStore.ts PURE: persistence contract over an injected AsyncStorage-like store
  index.ts           device half: getLocales(), active-locale + preference store,
                     I18nManager RTL, <I18nProvider>, useTranslation(), t()

src/components/LanguageSetting.tsx  the in-app selector (App Language / لغة التطبيق)

tests/i18nLocalization.test.cjs   detection / fallback / interpolation / RTL / completeness
                                  / referenced-key coverage
 tests/languagePreference.test.cjs  precedence / persistence / reset / invalid values /
                                    storage failure / runtime wiring
scripts/i18n-coverage.js          remaining hardcoded-English audit (npm run i18n:audit)
```

- `t('namespace.key', { name })` is the single translation entry point. It reads
  the module-level active locale, so services and module constants (the tab
  registry) can translate too.
- **Fallback chain:** active locale → English → the key. A missing key never
  throws; a key missing from Arabic renders English; a key missing everywhere
  renders the key, which the completeness test prevents from shipping.
- **Interpolation:** `{name}` placeholders; both languages must use the same
  placeholder set (asserted by the test suite).
- Keys are namespaced (`common.*`, `nav.*`, `tabs.*`, `auth.*`, `security.*`,
  `update.*`, …). `translate('en', …)` and the raw `en` dictionary are the
  English source of truth; English behaviour is unchanged.

## 2. Device-language detection

`resolveLocale()` compares the **base language subtag** of each preferred tag,
in preference order:

| Device tags | Result |
|---|---|
| `ar`, `ar-EG`, `ar-SA`, `ar_MA`, `ar-EG-u-nu-latn` | Arabic |
| `en`, `en-US` | English |
| `fr-FR`, `de-DE`, empty/unknown | English |

Only the first *supported* language wins, so `en-US, ar-EG` stays English and
`fr-FR, ar-EG` selects Arabic.

- The locale is seeded **before the first child renders**, so `t()` during render
  already sees the right language (tab labels are resolved at render time, not
  frozen in a module constant).
- The provider re-detects the device locale whenever the app returns to the
  foreground, so a device-language change is picked up without a restart and
  without losing authentication.

## 2b. App-language preference (in-app selector)

`LanguagePreference` is `'system' | 'ar' | 'en'`; `'system'` is the default.

- **Precedence** lives in `effectiveLocale()` (`preference.ts`): a saved
  override wins, otherwise `resolveLocale(deviceTags)`, otherwise English. The
  rule is unit-tested directly, so the UI cannot drift from it.
- **Persistence** uses `@react-native-async-storage/async-storage` under the key
  `@medacademy/app_language`. `'system'` is stored as the **absence** of the key
  (`removeItem`), which is what makes "follow the device" resume correctly —
  writing the literal string `system` would freeze the first-resolved locale.
- **Failure handling** (`preferenceStore.ts`): a read error, a missing key, an
  unparseable/legacy value, or a missing storage module all resolve to
  `'system'`. A failed write returns `persisted: false`; the session still shows
  the chosen language but `LanguageSetting` shows an explicit error toast rather
  than silently displaying a language that will not survive a restart.
- **Ordering**: `setLanguagePreference()` attempts the write *before* publishing
  the new locale, so what is displayed and what is stored cannot disagree.
- **Runtime switch**: the locale lives in a module store read through
  `useSyncExternalStore`, so every consumer repaints in place — no sign-out, no
  token/session reset, no navigation reset. With `'system'` selected the
  provider re-detects the device language on each foreground return.

## 3. RTL

- Arabic is right-to-left; English is unchanged LTR.
- **Native:** `I18nManager.allowRTL(true)` + `I18nManager.forceRTL(true)`.
  Direction is applied at startup, on locale change and on every language
  preference change.
- **Reload requirement (native only).** React Native mirrors layout only after
  the native UI is re-created. So immediately after switching to Arabic the
  **text** is Arabic while the **layout** is still in the previous direction;
  the next launch renders fully mirrored (and switching back to English needs
  the same relaunch to restore LTR). The app deliberately does **not** force a
  reload — that would drop navigation and the session. `applyRTL()` returns
  `needsRestart`, surfaced as `rtlNeedsRestart`, and `LanguageSetting` tells the
  user ("Relaunch the app to mirror the layout…" / "…to restore the standard
  left-to-right layout"). **Web needs no relaunch**: `document.dir` flips
  immediately.
- `allowRTL(true)` is never set to `false`: it is a global capability switch,
  and turning it off would disable RTL for a later Arabic launch on the same
  install. Direction is controlled only by `forceRTL`.
- **Web:** `document.documentElement.dir/lang` flips immediately; no reload.
- Layout mirroring is left to React Native's own direction handling — rows are
  not manually reversed, and non-directional icons are not mirrored.
- Text that must remain LTR (emails, phone numbers, URLs, passwords, IDs) uses
  LTR input settings / `textAlign` in the relevant fields; numeric values keep
  their own alignment.

## 4. What is translated

Navigation and shell surfaces are fully localized:

- All role tab labels (`nativeTabRegistry` → `titleKey`, resolved by both the JS
  and iOS native tab shells).
- The drawer: every student/doctor/admin/super-admin item, section heading, role
  label, connectivity status, sign-out and menu accessibility labels.
- Page header back label.
- Sign-in, **registration/sign-up**, account blocked/suspended, forced password
  change and the password-recovery screen — in BOTH groups (`(auth)` and the
  post-session duplicates under `(app)`), which now share the same copy keys.
- Force-update screen (checking, forced/optional variants, version rows,
  release notes, errors, recheck).
- **Security warning screens** (`(auth)` and `(app)`): title, body variants
  (blocked / warnings / pending / clear), risk-score label and risk bands,
  detected-issues heading, the zero-finding and in-progress states, the
  compromised-device warning, support-contact chooser and its load-error/
  not-configured states, the VPN/proxy block copy and every per-platform
  connection instruction, and the footer. Threat labels and descriptions are
  resolved from the dictionaries through `resolveFindingCopyKey()` at render
  time (`security.threat.<key>.{label,desc}`); an unknown event falls back to
  `security.threat.unknown.*`.
- **Security gate** (`security-gate.tsx`): already resolved through
  `security.gate.event.<key>.{title,instruction}`; the screen's own English copy
  table was replaced by a key registry (`GATE_EVENT_KEYS`), so the dictionary is
  the only source of truth and both languages carry all 20 gated events.
- **Security Center** (`security.tsx`): heading, watermark-ID card (including
  the read-only and not-applicable states), change-password form, success/error
  copy.
- **Account screens**: login history (statuses, summary stats, device/unknown
  fallback, failure reason, empty state), notifications (title, empty state,
  mark-as-read/delete accessibility labels), edit profile (labels, hints,
  validation, save/toast copy, ID card note).
- Student dashboard stat-card labels (`home.myCourses` / `home.inProgress` /
  `home.completed`).
- **Doctor profile** (`(doctor)/dr-profile.tsx`, previously the single largest
  audit offender at 109 candidates): header and role/status badges, overview
  stats, forensic-watermark card (ID, copy/copied state, note), account and
  contact rows, contact editor modal, earnings toggle + hints + platform-
  unavailable state, settings tab (profile/security/information links), edit
  name/email and change-password modals, sign-out confirmation, plus the whole
  embedded earnings tab (stat cards, chart legend/periods, course revenue table,
  pricing/admin tools, reset confirmation, transaction rows, student profile
  modal with suspend/restore/remove flows). Transaction types and chart periods
  are resolved through key maps at render time, never at module load.
- **Lesson screen** (`lesson/[id].tsx`): materials section (heading, subscriber
  gate, file-count pluralisation, PDF row, download), load-failure/not-found/
  not-available states with retry, app-owned player affordances (play, resume
  position, download state machine: queued/processing/downloading/paused/failed/
  completed, redownload-expired, watch-offline, cancel/pause/resume/retry),
  material open/download error copy, free-preview badge, security-warning
  banner, processing/coming-soon states, lesson notes heading, completion
  banner and mark-as-complete — in **both** layout variants. Third-party player
  chrome (Plyr tooltips, YouTube/VdoCipher native UI) is untouched and remains
  untranslated by design; the centre play/pause fix, double-tap seeking,
  fullscreen and network-lock behaviour are unchanged.
- **Standalone earnings screens** (`(doctor)/dr-earnings.tsx` and the Super
  Admin read-only `(hubs)/sa-doctor-earnings.tsx`): toggle card and its frozen/
  active/inactive variants, platform-unavailable and "system disabled" empty
  states, stat cards, revenue timeline (period chips, income/deduction legend,
  no-data state), course revenue table, transaction rows and their type labels,
  pricing & admin tools (global price, fallback logic, recalculate/reset with
  confirmation), the student profile modal (identity rows, pricing source,
  enrollments, suspend/restore/remove) and, on the Super Admin view, the
  read-only badge, credit selling price, both KPI grids, credit ledger summary,
  balance-trend and credit-history sections, the credit transaction-type
  vocabulary and the data-source note. Transaction types, chart periods and
  credit types resolve through key maps at render time, never at module load.
- The in-app **language selector** itself, including its option labels (language
  endonyms stay in their own script: `العربية`, `English`).

Every migrated screen is pinned by section **5b** of
`tests/i18nLocalization.test.cjs`: it asserts the screen imports the i18n
module, that every statically referenced `t('…')` key exists in BOTH
dictionaries, and that the screen no longer contains the English copy that used
to be hardcoded in it (comments are stripped first, so prose about the UI does
not count as shipped copy).

Remaining coverage is measured by `npm run i18n:audit`, which reports hardcoded
English candidates per file (JSX text, rendered props, `setError`, `Alert`,
toast messages). It is a progress gauge, **not** a gate; the gate is
`tests/i18nLocalization.test.cjs`.

**Current numbers:** 1,607 English keys with exact Arabic parity, **1,291**
remaining candidates across 80 files — down from 1,765 / 112 at the start of the
phase. Live numbers and the per-file breakdown are maintained in
`docs/LOCALIZATION_PROGRESS.md`. The largest remaining files are
`course-builder/[id].tsx`, `(hubs)/global-search.tsx`, `lesson-editor/[id].tsx`,
`(hubs)/sa-audit.tsx`, `(superadmin)/sa-platform.tsx`, `(hubs)/sa-credits.tsx`,
`(hubs)/enrollment-manager.tsx`, `(hubs)/create-student.tsx` and
`(superadmin)/sa-users.tsx`. Those screens are **not** fully localized yet; do
not read the dictionary size as coverage.

Enums are rendered through `src/lib/i18n/labels.ts` (`statusLabel`,
`courseStatusLabel`, `difficultyLabel`): the stored value never changes, only the
printed label. Dates use the app locale with `numberingSystem: 'latn'` so month
names translate while digits stay consistent; currency codes (`EGP`) and
identifiers always stay LTR.

**RTL in the earnings screens.** Direction is handled explicitly where RN does
not do it for us: table columns that hug the trailing edge use
`textAlign: isRTL ? 'left' : 'right'` (numbers stay right-aligned in LTR),
row-leading margins use `marginEnd`/`marginStart` instead of physical
left/right, and every disclosure/back chevron is rotated for RTL. Charts and
table rows themselves are left to React Native's own row mirroring — no
`row-reverse`, no `scaleX(-1)`.

Candidates that are deliberately **not** translated: route paths, testIDs,
style tokens, API/enum values, console logs, `i18n` keys themselves, vendored
bundles (the minified Plyr player embedded in `plyrBundle.ts`) and
user/admin-authored content.

## 5. Backend and third-party content

- No backend contract, schema, auth or security-enforcement change was made for
  localization. API field names and machine-readable values are untouched.
- Course titles, lesson content, user names and other user/admin-authored data
  are **not** translated — the product has no translated-content model.
- Server-generated messages (validation errors returned by PHP, `friendlyError`
  passthroughs) are rendered as received; translating them would require a
  backend `Accept-Language` contract, which is intentionally out of scope.
  **Exception — Security Center password change:** that screen never renders
  free-form backend text verbatim. `passwordChangeError()` maps known causes
  (too short / mismatch / same-as-current / network) to localized copy and
  falls back to a localized generic error for anything unknown, keeping the
  original message in a `console.warn` for developer diagnostics only.
- **Registration/sign-up** maps the backend sign-up failures to stable keys
  (`signUp.emailTaken`, `signUp.validEmail`, `signUp.tooManyAttempts`, …) and
  localizes the phone-validator message at the call site; `validateNationalNumber`
  itself stays pure English (no device-language read in shared logic).
- Third-party player chrome cannot be localized through the current
  integration: the Plyr control labels inside the lesson WebView, and VdoCipher /
  YouTube native player UI, are rendered by those components. Surrounding app
  labels (section titles, controls the app owns) are localizable; the embedded
  player's own tooltips/labels are not.

## 5b. Terminology and plurals

Approved Arabic terminology (with the reference that justifies each decision)
lives in [TRANSLATION_TERMINOLOGY.md](TRANSLATION_TERMINOLOGY.md). The headline
decision: **"My Courses" → «دوراتي»** and "Courses" → «الدورات»; «مساق/مساقات»
(the university credit-subject word) is rejected for this product and pinned
out of the dictionary by `tests/i18nTerminology.test.cjs`.

Counts go through `tCount(baseKey, count)` (CLDR categories):

```ts
t('common.items')                 // ✗ wrong for 2 and for 11
tCount('lesson.fileCount', 2)     // ✓ «ملفان»
tCount('lesson.fileCount', 11)    // ✓ «11 ملفًا»
```

Arabic uses six forms (`zero/one/two/few/many/other`); English uses
`one/other`. A plural key is the base plus the category suffix
(`lesson.fileCount.few`), and **all six must exist in both dictionaries** — the
i18n gate fails otherwise. Arabic one/two forms intentionally omit `{count}`
(«ملف واحد»), so the placeholder rule is: a translation may never introduce a
placeholder English does not provide, and non-plural keys must match exactly.

## 5c. Anchored menus and popovers (RTL)

Menus that hang off a trigger must **not** use a physical side. `right: 0` is
never mirrored by React Native, which is why triggers moved to the right in
Arabic while their menus opened to the left.

- `src/lib/ui/anchoredMenuPosition.ts` — pure placement math: align the menu's
  inline-start edge to the trigger's inline-start edge (left/left in LTR,
  right/right in RTL), open below, flip above when needed, clamp inside the
  window and cap the height.
- `src/components/AnchoredMenu.tsx` — measures the trigger with
  `measureInWindow`, feeds the app's real direction from `useTranslation()`, and
  renders through `PortalOverlay` (window coordinates) or `inline` (when the
  trigger is already inside a native `<Modal>`).

Use it for every anchored menu instead of an absolutely positioned view. The
placement suite (`tests/rtlMenuPlacement.test.cjs`) verifies the numbers for
both directions, the collision fallback, small windows and the wiring, and
fails if any screen reintroduces a hardcoded-side menu.

**Not verified:** actual on-device/emulator rendering. The maths and the wiring
are tested; a visual RTL pass on a device is still required.

## 6. Adding a translation

1. Add the key to **both** `en` and `ar` in `resources.ts` (same placeholders).
2. Use `t('namespace.key')` at the call site — never a device-language check.
3. Run `node tests/i18nLocalization.test.cjs` (completeness + placeholders +
   referenced-key coverage) and `npm run i18n:audit`.

Module-level constants must store **keys**, not translated strings
(`{ key, labelKey }`), and resolve them with `t()` during render — otherwise the
label freezes in whatever locale was active at import time.

## 7. Verification

```bash
npm run i18n:audit                     # coverage gauge
node tests/i18nLocalization.test.cjs   # dictionary + RTL wiring gate
node tests/i18nTerminology.test.cjs    # approved terminology + Arabic plurals
node tests/rtlMenuPlacement.test.cjs   # anchored-menu placement (RTL/LTR)
node tests/languagePreference.test.cjs # preference contract
npm test                               # every suite
npx tsc --noEmit                       # types
npx eslint <changed files>             # lint
npm run validate                       # native/config/security stages
```

## 8. Migration status

Coverage is tracked in **`docs/LOCALIZATION_PROGRESS.md`**: current audit
counts, the completed surfaces (with their namespaces), the remaining file
inventory, candidate-classification rules, batch conventions and the exact
continuation commands. Read it before starting a new localization batch.

Automated protection for migrated screens lives in
`tests/i18nLocalization.test.cjs` → `MIGRATED_SCREENS`: each entry pins the
screen's key count floor, proves every referenced key exists in both
dictionaries, and asserts the retired English copy is gone (comments stripped).
The suite also verifies every `labelKey` / `descriptionKey` table entry in the
app resolves in both languages.

## 9. Known limitations

- Native layout mirroring needs a **relaunch** after a direction change (see §3).
  Text switches immediately; the mirrored layout arrives on the next launch.
  Web needs no relaunch.
- No physical-device or emulator RTL verification was performed as part of this
  work. What is verified automatically: the direction API wiring, the preference
  contract, dictionary parity/completeness and referenced-key coverage. Visual
  mirroring on iOS/Android (drawers, chevrons, progress bars, modals) still
  needs a device pass — see `docs/DEVICE_VALIDATION_CHECKLIST.md`.
- The `/system` language choice only re-reads the device language while the app
  is foregrounded or on the next launch; there is no background locale-change
  observer in React Native.
- Third-party player chrome (Plyr/YouTube/VdoCipher) is not translatable through
  the current integrations (see §5).
