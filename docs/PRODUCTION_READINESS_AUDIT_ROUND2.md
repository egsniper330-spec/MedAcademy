# MedAcademy Production Readiness — Round 2 Findings

> **Update 2026-10-26:** F-01, F-02 and F-03 are **resolved**, and the items
> listed in §4 as "not completed" were completed. See
> [PRODUCTION_READINESS_AUDIT_FINAL.md](PRODUCTION_READINESS_AUDIT_FINAL.md) for the
> fixes, the measured load-test results, the index evidence and the deployment
> checklist. The findings below are kept unchanged as the historical record.

Date: 2026-10-25. Scope: read-only backend and dependency audit, plus baseline checks. This round made **no code or production changes**. It extends `docs/PRODUCTION_READINESS_AUDIT.md`, which covers the client-side audit from 2026-10-12, and does not repeat it.

## 1. Verified results

| Check | Command | Result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | Pass (clean) |
| Test suite | `node tests/appVersionIdentity.test.cjs` | **Fail** (see F-03) |
| Production npm audit | `npm audit --omit=dev` | 25 advisories: 1 critical, 10 high, 14 moderate |
| Route/handler consistency | `node backend/scripts/check-route-methods.js` (from repo root) | Pass: 203 methods, all 56 handler methods exist |
| PHP syntax lint | `php -l` on every backend file | **Could not run.** PHP is not installed on this machine, so the lint output is meaningless and is not counted as a pass |
| Load test | k6 | **Could not run.** k6 is not installed, and no local PHP server exists |

## 2. Backend security review

Verified as correct (no change needed):

- **Signed-file delivery** (`StorageController::signedFile`): the HMAC is checked with `hash_equals` before the file is read. The path is rejected if it contains `..`, the bucket is allow-listed, and expired links return 410. Lesson PDFs are refused on redemption, so the unwatermarked original cannot be fetched directly.
- **Signature comparisons** across the codebase (`Jwt`, `MaterialDeliveryController`, `VideoController`, `IntegrityService`, `SecurityEvidenceService`) all use `hash_equals`. No loose `==` comparison of secrets was found.
- **Rate limiting** is applied to the login, password-reset and phone/email lookup endpoints (per IP).
- No raw `$_GET`/`$_POST` access and no shell execution in the backend.

### F-01 — Public provider diagnostics disclose internal state (P1, confirmed)

- `backend/routes/api.php:55` registers `GET /provider-health` with no auth middleware.
- `HealthController::providerHealth` returns every row of `provider_registry`, including `status_message`, `version` and `last_health_check`.
- The regression script `backend/scripts/regression-test.php:105` pins this route as public, so changing its auth needs a deliberate decision and a test update.
- **Not changed in this round.** The fix (require an admin role, or return only `provider_key` and `status`) changes an API contract, so it needs your approval. Once approved, the change is a one-line route change plus an update to the regression test.

### F-02 — `/system-health` always reports the database as `ok` (P2, confirmed)

- `HealthController::systemHealth` hard-codes `'database' => 'ok'` and never queries the database. It cannot detect a database outage.
- The live health check that matters is `/api/health`, which runs `SELECT 1`. Uptime monitors should use that endpoint.
- Not changed. The fix is a `SELECT 1` probe, which is a small behaviour change.

### F-03 — `appVersionIdentity` test fails: stale generated output (P2, not a source defect)

- The test expects `APP_VERSION_CODE` and `APP_VERSION_NAME` in `android/gradle.properties`. That line is missing.
- `android/` is generated and git-ignored (0 tracked files). The fix is a fresh `expo prebuild`, which this round did not run.
- Treat it as a stale local artifact, not a repository defect.

## 3. Dependency review (npm, production only)

Advisories that reach the shipped app dependency tree:

| Severity | Package | Path | Note |
|---|---|---|---|
| critical | `shell-quote` 1.8.4–1.10.0 | `react-native` → `react-devtools-core` | Dev tooling path. Confirm it is not bundled into the release. |
| high | `expo` (direct) | — | Expo SDK advisory. Needs a compatibility-checked upgrade, not a blind bump. |
| high | `@react-native-async-storage/expo-with-async-storage` (direct) | — | Check the fixed version against the Expo SDK. |
| high | `zod` < 4.6.6 (transitive) | — | Check whether runtime validation uses the vulnerable code path. |
| high | `node-forge`, `js-yaml`, `@xmldom/xmldom`, `brace-expansion`, `source-map-js`, `@expo/cli`, `@expo/code-signing-certificates` (transitive) | — | Mostly build tooling. |

**Status:** the advisories are recorded, but no upgrades were applied. Upgrades must go through the Expo SDK compatibility matrix in separate, testable groups. Recommended order: `expo` and `@react-native-async-storage` together, then `zod`, then the transitive build tooling.

## 4. Not completed in this round

- **Database schema and index review:** partially read (the `enrollments` table has a unique key on `(student_id, course_id)` and FK constraints). Full index analysis was not finished.
- **k6 load scripts and capacity measurement:** not written or run. No staging environment exists and PHP is not installed locally. A capacity figure requires a bounded test against a local PHP server, which needs PHP and k6 installed first.
- **Pricing and service research:** not performed in this round.
- **Full feature verification matrix:** not produced.

## 5. Backend deployment

No backend files were created or modified in this round, so there is nothing to upload to the live PHP server.

When F-01 or F-02 is approved, the affected files will be:

- `backend/routes/api.php` (route auth)
- `backend/src/Controllers/HealthController.php` (response shape or probe)
- `backend/scripts/regression-test.php` (pinned expectation)

These must be deployed together, with the same change mirrored in `backend/deploy-package/` if that package is still used for releases.

## 6. Launch status

**Not ready for production** on the evidence of this round. The main blockers are the critical and high dependency advisories (needing a reviewed upgrade) and the unauthenticated diagnostics in F-01. Capacity is still unmeasured.
