# 2026-10-08 — Doctor Earnings feature-flag enforcement: deploy record

> **REGENERATED 2026-10-09.** The original single-file artifact went stale: its own
> preflight correctly refused to pass because `RpcController.php` had changed again (the
> cross-user profile response was minimized) and the security-hardening pass had also
> changed nine other backend files plus added one new class. The package was rebuilt as a
> **10-file deployable unit** and the preflight was **extended, never relaxed** (24/24 →
> 242/242 checks, all 24 originals preserved). See the package `README.md` for the current
> artifact table and `ENV-CONFIG.md` for the rate-limit configuration reference.

**Package:** `backend/deploy-package/2026-10-08-doctor-earnings-enforcement/`
**Artifacts (10 required + 1 optional):** mirrored tree `src/**` → `backend/src/**`
**`RpcController.php` sha256:** `9784d5bdde5c218d5e43b9f2fb9b09a3faf8248e82370793320e685decbb34a9`
_(superseded `d4c027404d4d9223b0db2bce942006368ec2ef5d3d60c5441d875125523ba21f`)_
**Rollback:** `rollback/src/**` (byte-identical to `git HEAD`); the new
`RateLimitService.php` has no baseline — rollback means **deleting** it.
**Database changes:** none (the `rate_limits` table already exists in both shipped schemas)
**Configuration changes:** none required (all 13 `RATE_LIMIT_*` keys are optional)

## Root cause (confirmed from source)

`doctor_earnings` was asserted in only three places — `CreditController:256`,
`DataController::assertFeatureFlags` (generic earnings-table reads) and
`RpcController::doctorEarningsDashboard`. Every other doctor-callable earnings
surface was ungated, so a doctor with a stale screen / cached route / raw API
call could still read and write earnings while the Super Admin flag was OFF.

## Fix

One shared, staff-exempt, override-aware gate (`assertDoctorEarningsEnabled`)
applied to all six doctor-callable earnings surfaces, gate-first (before
parameter validation and before any DB write):

| Surface | Route |
|---|---|
| `doctorActivityStats` | `GET /rpc/doctor-activity-stats/{doctorId}` |
| `doctorCreditTransactions` | `GET /rpc/doctor-credit-transactions/{doctorId}` |
| `doctorEarningsDashboard` | `GET /rpc/doctor-earnings-dashboard/{doctorId}` |
| `doctorStudentProfile` | `POST /rpc/doctor-student-profile` |
| `setEnrollmentAssignedPrice` | `POST /rpc/set-enrollment-assigned-price` |
| `removeStudentAndRecordEarnings` | `POST /rpc/remove-student-and-record-earnings` |

Refusal contract unchanged: `403 { error: { code: "feature_disabled",
feature: "doctor_earnings" } }` — no internals leaked.

## Verified locally

| Check | Result |
|---|---|
| `node preflight.cjs` (package == tested source for all 11 artifacts, rollback baselines real, 6/6 gates, staff-exempt, override-aware, gate-before-write, no internal-error leakage, allowlist columns present in both schemas, rate-limit contract, bucket-identity trust, dependency completeness, config-reference accuracy) | **242/242 PASS**, exit 0 → `preflight-output.txt` |
| `node verify-live.cjs` with no credentials (reachability probe only) | `GET /health` 200, unauth earnings call 401, exit 2 (INCOMPLETE — by design) |
| `npx tsc --noEmit` | clean |
| `node tests/featureFlagEnforcement.test.cjs` (new) | 76 checks PASS |
| `node tests/systemBarsPlugin.test.cjs` (new) | 29 checks PASS |
| full `tests/*.test.cjs` suite | 0 suites failing |

## NOT yet done — requires the server / device (only you can do these)

1. **Upload** `RpcController.php` to `backend/src/Controllers/` on api.medacademy.site.
2. **Live verification**: `node verify-live.cjs` with `SUPERADMIN_*` and `DOCTOR_*` credentials.
   Until that reports `STATUS: PASSED`, the flag is **not** proven enforced in production.
3. **Doctor device loop**: login as doctor → Earnings ON works → Super Admin disables →
   refresh (no reinstall) → Earnings unavailable → direct route/API blocked → re-enable → works.
4. Backend files from the *separate* Support Contact work are still undeployed and are
   **deliberately not** part of this package: `routes/api.php`, `DataController.php`,
   `AnalyticsController.php`, `StorageController.php`, `SupportController.php`,
   `database/mysql-migrations/001_add_support_settings.sql`, `database/schema.sql`.
   The regenerated preflight now asserts this explicitly: every changed `backend/src` file
   is either packaged or on a known-unrelated list, and no packaged file may import a
   changed-but-unpackaged file (checked over 62 dependency edges). **Decide separately**
   whether/when that feature ships — it is out of scope for this package.
