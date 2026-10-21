# Earnings feature — retirement record

**Status:** retired in the app (Doctor, Admin and Super Admin). Nothing in this
document has been deployed. No production database was touched.

The earnings *feature* is removed. Everything it merely touched — credits, the
credit ledger, course pricing, enrollment management, refunds on removal,
revenue reporting — is kept and still works.

## 1. What was removed

### Client (React Native / Expo)

| File | Change |
| --- | --- |
| `src/app/(app)/(doctor)/dr-earnings.tsx` | **deleted** — doctor earnings screen |
| `src/app/(app)/(hubs)/doctor-earnings.tsx` | **deleted** — admin earnings / pricing console |
| `src/app/(app)/(hubs)/sa-doctor-earnings.tsx` | **deleted** — Super Admin per-doctor earnings |
| `src/lib/nativeTabRegistry.tsx` | doctor tab list no longer contains `dr-earnings`; the two hub screens are no longer registered |
| `src/app/(app)/_layout.tsx` | drawer entries and deep-link targets for the three screens removed |
| `src/components/DrawerNav.tsx` | Earnings row and its two flag gates removed |
| `src/app/(app)/(doctor)/dr-profile.tsx` | embedded earnings card, `EarningsTab`, pricing/toggle/payout UI and the earnings student sheet removed |
| `src/app/(app)/(superadmin)/sa-users.tsx` | per-doctor earnings action removed |
| `src/app/(app)/(superadmin)/sa-finance.tsx`, `src/app/(app)/(hubs)/revenue.tsx` | doctor-earnings shortcuts and reset-earnings actions removed |
| `src/app/(app)/(hubs)/global-search.tsx`, `(hubs)/create-student.tsx`, `(student)/profile.tsx`, `(doctor)/students.tsx`, `(doctor)/dr-overview.tsx`, `(hubs)/doctor-credit-timeline.tsx` | references to the removed screens/issues cleaned up |
| `src/lib/api.ts` | every earnings data function + type removed (`getDoctorEarningsDashboard`, `getAdminDoctorEarningsDashboard`, `getDoctorPricingHistory`, `getDoctorPricingSettings`, `setDoctorGlobalPrice`, `setDoctorCreditPrice`, `setDoctorCoursePrice`, `setDoctorEarningsSettings`, `recalculateDoctorEarnings`, `resetDoctorEarnings`, `resetPlatformEarnings`, `getPlatformEarningsStats`, `getDoctorStudentProfile`, earnings row/type definitions) |
| `src/client/php.ts` | PHP route map no longer contains any earnings endpoint |
| `src/lib/featureFlags.ts` | the `doctor_earnings` key is **kept** (mirror of the server registry, which still protects the retained earnings tables). No UI reads it. |
| `src/lib/i18n/resources.ts` | earnings-only strings removed from **both** dictionaries, including `nav.earnings` |

Enrollment suspension/resumption and the student-removal refund path are
enrollment management, not earnings, and are **retained** (`suspendStudentCourseAccess`
stays the single canonical suspension writer; `suspendCourseSubscription` delegates to it).

### Backend (PHP)

| File | Change |
| --- | --- |
| `backend/routes/api.php` | every earnings-only route withdrawn |
| `backend/src/Controllers/AnalyticsController.php` | `recalculateEarnings`, `resetDoctorEarnings`, `resetPlatformEarnings` retained but **unrouted** (documented in-file) |
| `backend/src/Controllers/CreditController.php` | `doctorEarnings` (`GET /credits/doctor/{id}`) retained but **unrouted** |
| `backend/src/Controllers/RpcController.php` | `doctorEarningsDashboard` and `doctorStudentProfile` retained but **unrouted** |

Routes withdrawn: `GET /credits/doctor/{id}`,
`POST /analytics/recalculate-earnings/{doctorId}`,
`POST /analytics/reset-doctor-earnings/{doctorId}`,
`POST /analytics/reset-platform-earnings`,
`GET /admin/doctor-earnings/{doctorId}`,
`POST /rpc/get-doctor-earnings-dashboard`,
`GET /rpc/doctor-student-profile`,
`POST /rpc/set-doctor-earnings-settings`,
`POST /rpc/set-doctor-credit-price`,
`POST /rpc/set-doctor-course-price`,
`GET /rpc/doctor-pricing-history`.

Routes that stay and keep their existing `doctor_earnings` data-protection gate:
`GET /rpc/doctor-credit-transactions`, `GET /rpc/doctor-activity-stats`,
`POST /rpc/set-enrollment-assigned-price`,
`POST /rpc/remove-student-and-record-earnings`.

## 2. Deliberately retained (data safety)

No destructive migration was written. These tables, their rows and their
triggers are untouched:

- `doctor_earnings_events`
- `doctor_earnings_transactions`
- `doctor_payout_requests`
- `doctor_pricing_history`
- `platform_earnings_resets`

Their columns also survive on `profiles` (`earnings_enabled`, `earnings_mode`,
`doctor_global_price`, `doctor_pricing_mode`, `credit_selling_price`) and on
`enrollments` (`assigned_price`). Historical financial records therefore remain
reconcilable; only the UI and the write/read endpoints are gone.

The `doctor_earnings` feature flag stays registered in
`FeatureFlagService::REGISTRY` (default **on**, `superadmin_exempt`) because the
generic Data API still refuses doctors direct reads of the earnings tables
through it. Removing the key would silently open that path.

## 3. Files to upload if deployment is later approved

Application code only — no schema change is required for the earnings removal:

```
backend/routes/api.php
backend/src/Controllers/CourseController.php          (section delete endpoint)
backend/src/Controllers/StudentBulkController.php     (course-scoped bulk guard)
backend/src/Controllers/AnalyticsController.php       (comments only)
backend/src/Controllers/CreditController.php          (comments only)
backend/src/Controllers/RpcController.php             (comments only)
```

The section-delete fix is code-only and needs **no** migration to work: the
endpoint clears the `enrollments.last_lesson_id` pointer inside its own
transaction. `backend/database/mysql-migrations/034_fix_enrollments_last_lesson_fk.sql`
is the matching schema correction (`ON DELETE SET NULL`) for future installs and
other delete paths — run it only with separate approval. `backend/database/schema.sql`
and `backend/database/schema-no-triggers.sql` are reference dumps for fresh
installs; they are not uploaded to a running server.

## 4. Verification

Source-level suites (no PHP runtime, no device, no deployment in this
environment):

- `node tests/earningsRemoved.test.cjs` — screens, routes, nav, PHP map, client
  API, retained features and retained tables.
- `node tests/featureFlagEnforcement.test.cjs` — the retained gates and the
  retirement of the earnings-only routes.
- `node tests/apiDataMinimization.test.cjs` — the withdrawn cross-user profile
  endpoint keeps its guards in code and has no client wrapper.
- `node tests/navigationOwnership.test.cjs`, `tests/navigationDrawerDirection.test.cjs`,
  `tests/platformCenter.test.cjs`, `tests/platformControlCenter.test.cjs`,
  `tests/adminDiagnosticsAudit.test.cjs`, `tests/iosParity.test.cjs`,
  `tests/globalFixesRegression.test.cjs`, `tests/profileSafeArea.test.cjs`.
- `node tests/i18nLocalization.test.cjs`, `tests/i18nTerminology.test.cjs` and
  `npm run i18n:audit` for the dictionary.

## 5. Remaining cleanup (needs separate approval)

1. Delete the retained unrouted handlers (`doctorEarningsDashboard`,
   `doctorStudentProfile`, `CreditController::doctorEarnings`,
   `AnalyticsController::{recalculateEarnings,resetDoctorEarnings,resetPlatformEarnings}`)
   once this release has shipped.
2. Decide whether the retained earnings tables should be archived. Do **not**
   drop them; they are the only record of historical payouts.
3. The `doctor_earnings` flag can be retired only together with a hard
   staff-only rule on the earnings tables in `DataController`.
