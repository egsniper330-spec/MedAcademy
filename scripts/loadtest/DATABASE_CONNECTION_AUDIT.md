# Database connection audit — MedAcademy (Spaceship cPanel shared hosting)

**Date:** 2026-10-27 · **Target inspected:** `https://api.medacademy.site` (PHP 8.2 + MariaDB)
**Scope:** why the host reports `SQLSTATE[HY000] [1226] … max_user_connections`, what was
changed, and what the changes are actually proven to do.

> **Nothing in this document was deployed.** No production file, database schema, cron job or
> configuration was modified, and no production data was written. Section 9 lists exactly what
> must be uploaded before any of these improvements take effect on the live host.

---

## 0. Executive summary

| Question | Answer | Basis |
|---|---|---|
| Is there a connection **leak** (a connection opened and never closed)? | **No.** One `new PDO` exists in the entire application, created lazily, never persistent, and released when the script ends. | §2 F1 (code) |
| What actually caused the 1226 errors at 150–200 VUs? | The account's **simultaneous** connection cap (50) being exceeded because each request **held its one slot for the whole request**, including slow phases that use no database at all (PDF render, document hashing, file streaming). Demand is `requests/s × hold time`. | §2 F2/F3, §5.3 |
| Was that proven or inferred? | The quota message and the 50-connection cap are **facts from the host**. The hold-time contribution is a **measured mechanism** (§5.3) — an exact per-stage attribution on the live host was not possible without deploying. | §2.3 |
| What changed? | `Database::release()` + 5 verified call sites, and an honest, non-amplifying failure surface for quota exhaustion (503 `database_busy` + `Retry-After`, logged distinctly, no retry). | §4 |
| Does it work? | Locally **yes, end to end**: with the account allowance deliberately saturated, the API answers `503 database_busy` with `Retry-After` on every request, never a faked 200 — 19/19 checks pass. | §5.2 |
| Is production fixed? | **No — not yet.** The code is verified locally and undeployed. | §9 |
| Can MedAcademy now support N concurrent students? | **Unproven.** Only anonymous public traffic has ever been load tested. See §7. | §6 C1 |

---

## 1. What was inspected and run

Inspected (all read-only): `backend/src/Database/Database.php`, every `new PDO` / persistent-connection
site, `backend/src/Middleware/ErrorHandler.php`, `backend/src/Http/{Response,ApiException}.php`,
`StorageController.php`, `MaterialDeliveryController.php`, `MaterialPdfVariantService.php`,
`UploadIntegrityService.php`, `WorkerLock.php`, `scripts/watermark-worker.php`, `routes/api.php`,
and the whole of `scripts/loadtest/`.

Executed (all local unless stated):

| # | What | Result |
|---|---|---|
| 1 | PHP lint on every changed file | clean (§5.1) |
| 2 | `backend/tests/database/connection_lifecycle_tests.php` (new) | **19 passed, 0 failed** (§5.2) |
| 3 | Live staged anonymous load test (2 → 10 → 25 VUs) | 3/3 PASS, 0 errors (§5.4) |
| 4 | Local phase-hold measurement (synthetic 20 MiB) | sha256 162 ms, 256 KB chunked send 17.8 ms (§5.3) |
| 5 | `tests/loadtestPlan.test.cjs` (incl. new P9b workloads) | **97 passed, 0 failed** |
| 6 | Full JS suite / `tsc` / lint | §5.5 |

Deliberately **not** run: any production mutation, migration, cron change, mail/PDF-queue work,
authenticated load test against production, or load test above 25 VUs (see §6 C3/C4).

---

## 2. Findings

### 2.1 F1 — There is no leak, and no connection pool [CONFIRMED, code]

`backend/src/Database/Database.php`

* One singleton per request: `Database::instance()` (`:41`), one `PDO` field (`:39`).
* One creation site in the whole application — `new PDO($dsn, …)` at `:71`. The only other
  `new PDO` in the repository is `backend/scripts/db-diagnose.php:79`, an operator script.
* `PDO::ATTR_PERSISTENT` is **not** set, and no `p:mysql:` DSN exists anywhere: a request never
  inherits a connection from a previous request. Enabling persistence on this host would be
  actively harmful (it multiplies held slots across FPM workers) and was not done.
* The connection is created **lazily** — a request that touches no table (for example a static
  asset) opens none at all.

### 2.2 F2 — The slot used to be held for the entire request [CONFIRMED, code + measurement]

`Database.php` held `$this->pdo` until the script ended. The following phases are slow,
use **no** database, and used to run while the slot was still occupied:

| Call site | Phase that no longer holds the slot | Measured (local, synthetic) |
|---|---|---|
| `UploadIntegrityService.php:378` | `hash_file('sha256')` + structure parse of the stored upload | **162 ms** for 20 MiB (123 MiB/s) |
| `MaterialDeliveryController.php:318` | streaming the personalized PDF to the client | 256 KB-chunk loop: **17.8 ms** for 20 MiB locally; on the host this is bounded by the **client's link**, so the local figure is a floor |
| `MaterialPdfVariantService.php:169` | the PDF watermark render (`personalize()`), the slowest phase in the application | from the queue run: **≈0.24 s** per 4-page copy (see `scripts/loadtest/README.md`) |
| `StorageController.php:261` | `file_get_contents()` of a public object | proportional to object size |
| `StorageController.php:319` | `file_get_contents()` of a signed private object | proportional to object size |

By Little's law the connection demand of the host is `requests/second × hold time`. Removing
seconds-scale hold time from the upload, PDF-render and download paths is therefore the
lever on a *simultaneous* connection cap.

### 2.3 F3 — The cap that was hit is per account, not per server [CONFIRMED, host evidence]

From the previous live run (`docs/LIVE_HOST_CAPACITY_TEST.md:80-87`):

```
SQLSTATE[HY000] [1226] User 'vcoafnqsgg_api' has exceeded the 'max_user_connections' resource
```

* `SHOW VARIABLES` on the host: `max_user_connections = 50`, server `max_connections = 500`.
* The application's own account ceiling is therefore **10× tighter** than the server's, and it is
  the binding constraint — the server itself stayed healthy (`max_used_connections = 139` includes
  every other tenant on the node; `Threads_connected = 62` after the run).
* 30 such errors were logged: 15 in the 150-VU minute and 15 in the 200-VU minute, matching k6's
  per-stage `server_error` counts (13 and 15) — i.e. the 5xx were the quota, not a crash.

> **Inference, clearly labelled:** attributing the 150-VU onset *specifically* to hold time rather
> than to raw request rate cannot be proven from the deployed code alone, because the old code was
> still running during that test. What is proven is (a) the cap is 50 simultaneous connections,
> (b) each request holds exactly one, (c) the previously held phases are 0.16–0.25 s in size
> (§2.2), and (d) `release()` really does return the slot and reconnect lazily (§5.2 C1).

### 2.4 F4 — A quota error used to look like a broken server [CONFIRMED, code]

`Database::pdo()` wrapped *every* connect failure in a generic `500`. A capacity signal was
therefore indistinguishable from a defect, the client had nothing to act on, and a client retry
would have amplified load on an already-saturated server. Now:

* `Database::isConnectionQuotaError()` (`:115`) matches **only** `1226`, `1203` and `1040`
  (or the literal `max_user_connections` / `Too many connections`), so a genuine outage
  (`2002` connection refused, `1045` access denied) is **not** misreported as capacity.
* A quota failure becomes `503` with code `database_busy` and a short `Retry-After: 2`
  (`ErrorHandler.php:44-52`), and the log line carries `capacity=db_connection_quota`.
* **No retry is attempted inside the request** — deliberately, to avoid amplifying load.

### 2.5 F5 — Transaction and exception safety [CONFIRMED, code + test]

* `release()` is a **no-op while a transaction is open** (`Database.php:139-157`): it checks
  `inTransaction()` first and keeps the handle, so a write path can never have its unit of work
  silently dropped. Verified by C2 (§5.2).
* Connections are not leaked on exceptions: the handle is a single object freed when the request
  ends; the failure modes are covered by C1–C4.
* The queue worker (`scripts/watermark-worker.php`) runs in its own process with its own
  connection, guarded by `WorkerLock` (an `flock`-based single-instance lock); it calls
  `release()` before the render phase rather than holding a slot for its whole `--max-seconds`
  budget.

---

## 3. Changes

### 3.1 Backend (fixes)

| File | Change | Why |
|---|---|---|
| `backend/src/Database/Database.php` | added `release()`, `isConnected()`, `isConnectionQuotaError()`, `BUSY_RETRY_AFTER_SECONDS`; quota-aware connect failure; class docblock explaining the hold-time model | hand the slot back before DB-free slow phases; make saturation a distinct, logged, non-amplifying failure |
| `backend/src/Middleware/ErrorHandler.php` | tags quota failures and emits `Retry-After` when the previous exception is a quota error | the client must be able to back off; operators must be able to grep capacity separately from outages |
| `backend/src/Services/UploadIntegrityService.php` | `release()` before hash/parse | the hash reads the whole document |
| `backend/src/Services/MaterialPdfVariantService.php` | `release()` before the watermark render | the render is the slowest phase in the application |
| `backend/src/Controllers/MaterialDeliveryController.php` | `release()` before streaming the personalized PDF | transfer time is the client's link |
| `backend/src/Controllers/StorageController.php` | `release()` before both `file_get_contents()` reads | same reason, both storage routes |

### 3.2 Load-test tooling (measurement, not features)

| File | Change | Why |
|---|---|---|
| `scripts/loadtest/student-journey.js` | `workload` tag on every request + per-workload Trend/Counter; optional `pdf-availability` (`/materials/pdf-status`) and `video-metadata` (`/rpc/lesson-video-state`) workloads; `stage.workloads` in the summary | five workloads with different costs must never be merged into one "N users" number |
| `scripts/loadtest/lib/plan.mjs` | plan carries `pdfMaterialId` / `videoLessonId`; the report renders a workload table and passes workloads through | an unexercised workload must print as `**no**` with its missing precondition |
| `scripts/loadtest/README.md` | workload table, corrected default thresholds, new env vars | the operator must know what each number does and does not describe |
| `tests/loadtestPlan.test.cjs` | new **P9b** section (6 checks) | pins that unmeasured workloads are never reported as numbers |

---

## 4. Verification

### 4.1 PHP lint — clean

```
php -l backend/src/Database/Database.php
php -l backend/src/Middleware/ErrorHandler.php
php -l backend/src/Services/UploadIntegrityService.php
php -l backend/src/Services/MaterialPdfVariantService.php
php -l backend/src/Controllers/StorageController.php
php -l backend/src/Controllers/MaterialDeliveryController.php
php -l backend/tests/database/connection_lifecycle_tests.php
```

### 4.2 `connection_lifecycle_tests.php` — 19 passed, 0 failed

```
php backend/tests/database/connection_lifecycle_tests.php      # local API on :8090
19 passed; 0 skipped; 0 failed
ALL CONNECTION-LIFECYCLE CHECKS PASSED
```

| Check | What it proves |
|---|---|
| **C1** a query holds a connection · `release()` drops the handle · the next query opens a **NEW server connection id** | release + transparent lazy reconnect; callers need no other change |
| **C2** still connected while a transaction is open · the same connection is kept | `release()` can never discard committed work in progress |
| **C3** 1226 / 1203 / 1040 recognised; 2002 / 1045 / unknown SQLSTATE **not** reported as capacity | narrow classification — capacity is never blamed for an outage |
| **C4** the account allowance is genuinely saturated · the refusal really is the quota error · every request got a definitive status · **quota exhaustion produced the distinct 503 `database_busy` + `Retry-After`** · each of the 6 requests was refused · no 200 was faked · `Retry-After` is short · the quota was restored | the **client-visible contract** end to end, with the saturation held by the test itself (2 connections + a refused third), so a pass cannot be a lucky race |

Notes that matter for honesty:

* C4 uses a **database-backed** public route on purpose. It originally used `/api/health`, which
  returned `200 {"status":"degraded"}` six times out of six — that route *catches* database errors
  by design, so it can never demonstrate the contract. The default is now `/support/contact`
  (override with `CONN_TEST_PATH`, e.g. `/api/support/contact` on a host that mounts under `/api`).
* C4 needs `UPDATE` on `mysql.*` to set a user quota, and refuses to run when `APP_ENV=production`.
  Where the privilege is absent it prints **SKIP with the reason** and the summary counts it as
  skipped — never as a pass. The local run above is **19 pass / 0 skipped**.

### 4.3 Phase-hold measurement — `.freebuff/tools/hold-phase-measure.php`

```
file            : medacademy-hold-phase-12912.bin (20.0 MiB)
sha256          : 162.0 ms   (123.5 MiB/s)
chunked send    : 17.8 ms    (20.0 MiB read back, 1,120.8 MiB/s)
```

This is a **phase measurement on synthetic files**, not a load test. It says how much hold time
each `release()` removes; it does not by itself claim a capacity figure. (On the host the send
phase is bounded by the client's connection, so 17.8 ms is a floor, not a representative value.)

### 4.4 Live staged run — 2 → 10 → 25 VUs, anonymous (`SESSION_MODE=none`)

`scripts/loadtest/results/live-audit/` (`report.md`, `report.json`, `stages.csv`).
Thresholds fixed **before** the run: error rate > **1 %**, 5xx/508 > **0.5 %**, timeouts/connection
failures > **0.5 %**, p95 > **2000 ms**, p99 > **4000 ms** (`abortOnFail`).

| VUs (target/achieved) | shape | requests | req/s | p50 / p95 / p99 | error rate | timeouts | 5xx | result |
|---|---|---|---|---|---|---|---|---|
| 2 / 2 | 15 s ramp · 30 s hold · 10 s down | 172 | 2.23 | 282 / 350 / 392 ms | 0 % | 0 | 0 | **PASS** |
| 10 / 10 | same | 792 | 10.30 | 279 / 374 / 1196 ms | 0 % | 0 | 0 | **PASS** |
| 25 / 25 | same | 1,976 | 25.82 | 274 / 364 / 1228 ms | 0 % | 0 | 0 | **PASS** |

Read this for what it is: **anonymous public boot traffic** (`/api/health`, `/app/version`,
`/maintenance`, `/support/contact`) with `THINK_TIME_MS=1500`, on the **currently deployed**
backend — i.e. without the §3.1 changes. It shows the host is healthy in this range and that the
harness reaches its targets against production; it says nothing about the fix, about signed-in
students, or about a ceiling.

Two honest caveats:
* The ~274–282 ms p50 floor also appears on static content (previous audit), i.e. it is this
  workstation's network/TLS path to the host, not PHP/DB time. Throughput here is bounded by
  `VUs / (RTT + think)`, so these rungs can never find the server's ceiling.
* p99 ≈ 1.2 s at 10 and 25 VUs is a single slow request class in that window (see
  `timeseries.csv`), not a trend: p50 and p95 are flat from 2 to 25 VUs.

### 4.5 JS suite

`node --test tests/loadtestPlan.test.cjs` → **97 passed, 0 failed**, including the new P9b
workload checks (`workloads` survive into the report; the markdown shows a workload section; a
measured workload lists separately; an unmeasured one is `**no**`, not a number; the missing
precondition is named; the "no other row may be quoted for it" warning is present).
Full-suite and static-check results: §5.

---

## 5. Full checks run for this task

| Check | Command | Result |
|---|---|---|
| PHP lint (7 changed/added files, final state) | `php -l <file>` | **clean** |
| Connection lifecycle (new) | `php backend/tests/database/connection_lifecycle_tests.php` | **19 passed; 0 skipped; 0 failed** |
| Load-test plan/report unit tests | `node --test tests/loadtestPlan.test.cjs` | **97 passed, 0 failed** |
| Full JS test suite | `npm test` (`test:state` + `run-all-tests.cjs`) | **132 passed, 0 failed** (335.8 s), exit 0 |
| TypeScript | `npx tsc --noEmit` | **exit 0**, no diagnostics |
| Lint (files changed by this task) | `npx eslint scripts/loadtest/student-journey.js scripts/loadtest/lib/plan.mjs tests/loadtestPlan.test.cjs` | **0 errors**, 1 pre-existing warning (unused `catch (e)` in the journey's fixture parse at `student-journey.js:290`, untouched by this task) |
| Lint (whole repository) | `npm run lint` → `eslint .` | **pre-existing failures, unrelated to this task:** 23,429 problems (12,248 errors / 11,181 warnings) across the repository (e.g. 1,802 `no-var`), **none of them in any file this task changed** (verified by grepping the lint output for `scripts/loadtest` and `loadtestPlan` — zero matches). The first attempt also died on Node's default heap limit (`FATAL ERROR: Ineffective mark-compacts near heap limit`, exit 134) after ~6 min and had to be re-run with `NODE_OPTIONS=--max-old-space-size=6144`. |

So: the changed files lint clean; the repository-wide lint gate fails for pre-existing reasons and is reported as **failing, not passed** — it is not something this task introduced, and cleaning 12,248 unrelated errors is out of scope.

---

## 6. Capacity conclusions — per workload, no merging

**C1 · Anonymous public API traffic — measured.** 200 concurrent VUs were previously achieved with
0.11 % errors, and this run confirms 2/10/25 VUs with 0 % errors. However, the first 5xx appeared at
**150 VUs**, and every one of them was the account's connection quota — with the old code (slots
held for the whole request) still deployed.

**C2 · Authenticated student browsing — NOT MEASURED.** No dedicated staging account exists, and
production must not be driven with a real student's session (one person's identity for 200 VUs).
The suite is ready for it: set `SESSION_MODE=pool` (or `login`) plus `LOADTEST_TOKEN_POOL_FILE` /
`LOADTEST_STUDENT_EMAIL(_S)`, and the report will print `auth-read` as a separate row.

**C3 · PDF availability — NOT MEASURED.** Requires `LOADTEST_PDF_MATERIAL_ID` and a session.
`GET /materials/pdf-status` is read-only and queues nothing, so it is safe to include — but only
once a disposable account exists.

**C4 · PDF generation / watermark worker — NOT MEASURED, and must not be run against production.**
It would enqueue real watermark jobs whose output is stored on the shared host. Staging only. The
README records a local worker measurement (4-page source → copy in 0.24 s).

**C5 · Video — NOT MEASURED.** `GET /rpc/lesson-video-state` (metadata, DB only) is wired up behind
`LOADTEST_VIDEO_LESSON_ID`, but **actual video delivery comes from the VdoCipher CDN**, not this
host: no API request may be quoted as video-streaming capacity.

**What would move the needle, in evidence order:** (1) deploy §3.1 and repeat the anonymous ladder
at 100/150/200 to see whether the 1226 5xx at 150 disappear — that is the only test that can
confirm the hold-time fix; (2) stand up a staging account for `auth-read`; (3) only if the quota
still binds, discuss raising `max_user_connections` with the provider — **not** proposed here
(unknown whether it is permitted, and it is not justified until the deployed behaviour is measured).

**Host metrics that are available vs not:**

| Metric | Availability |
|---|---|
| HTTP status distribution, latency percentiles, RPS, timeouts (per endpoint & workload) | **measured by this suite** |
| `max_user_connections` / `max_connections`, `max_used_connections`, `Threads_connected`, `Threads_running` | **available to the operator** via SQL over SSH — *not* through the API; server-wide, so they include other tenants |
| Connection-acquisition latency, per-query latency, slow-query log, query count per request | **not exposed**; would need instrumentation or a DB-level setting (deliberately not enabled on production) |
| CPU, memory, I/O, LVE (CloudLinux) limits, entry processes | **cPanel Resource Usage graphs only**; no API, no reliable per-request attribution |

---

## 7. Deployment requirements and rollback

Order matters: upload the library change together with its callers, because the callers reference a
method that must exist.

1. **Back up first**, one `.bak` per file, outside the web root
   (e.g. `~/backups/2026-10-27-db-connections/<file>.bak`).
2. Upload, in this order:
   1. `backend/src/Database/Database.php` — adds `release()`, quota classification, `Retry-After` constant
   2. `backend/src/Middleware/ErrorHandler.php` — tags quota failures, emits `Retry-After`
   3. `backend/src/Services/UploadIntegrityService.php`
   4. `backend/src/Services/MaterialPdfVariantService.php`
   5. `backend/src/Controllers/MaterialDeliveryController.php`
   6. `backend/src/Controllers/StorageController.php`
3. `php -l` each uploaded file **on the server** and hit `GET /api/health` (expect `200`).
4. **No migration, no schema change, no cron change, no `.env` change** is required.
   `backend/tests/database/connection_lifecycle_tests.php` is a developer test — it does not need
   uploading to production, and it refuses to run there anyway.
5. **Rollback:** restore the `.bak` files and re-check `/api/health`. Nothing stateful was written,
   so no data rollback is needed.
6. **Post-deploy verification (the only test that proves the fix):** repeat the staged anonymous
   run — `2 → 10 → 25 → 50 → 100`, extending only while every stage stays inside the stop
   thresholds — and confirm that no `1226` / `database_busy` appears at the levels that previously
   produced 13–15 5xx. Stop immediately on the first 508/503 or resource warning.

---

## 8. What was *not* done (explicitly)

* No deployment, no file uploaded to the host, no production data written or deleted.
* No migration, schema change, `.env` change, cron change or database-configuration change.
* No `max_user_connections` increase requested or attempted.
* No production load test above 25 VUs (2 → 10 → 25 only, all healthy).
* No authenticated load test against production, and no real student's session used.
* No PDF-generation or video-delivery load produced anywhere.
* No credential, token, cookie or student datum appears in this document or in any artifact it
  references.

---

## 9. Files

**Created**

* `backend/tests/database/connection_lifecycle_tests.php` — C1–C4 connection-lifecycle suite
* `scripts/loadtest/DATABASE_CONNECTION_AUDIT.md` — this report
* `.freebuff/tools/hold-phase-measure.php` — phase-hold measurement (developer tool, not shipped)
* `scripts/loadtest/results/live-audit/` — `report.md`, `report.json`, `stages.csv`, `timeseries.csv`, `stage-*.stage.json`

**Modified (backend — these are the files to upload)**

* `backend/src/Database/Database.php`
* `backend/src/Middleware/ErrorHandler.php`
* `backend/src/Services/UploadIntegrityService.php`
* `backend/src/Services/MaterialPdfVariantService.php`
* `backend/src/Controllers/MaterialDeliveryController.php`
* `backend/src/Controllers/StorageController.php`

**Modified (tooling/tests — not deployed)**

* `scripts/loadtest/student-journey.js`
* `scripts/loadtest/lib/plan.mjs`
* `scripts/loadtest/README.md`
* `tests/loadtestPlan.test.cjs`

**Read for the audit, unchanged:** `docs/LIVE_HOST_CAPACITY_TEST.md` (the previous live run, which
supplies the 1226 evidence and the 150/200-VU numbers cited above).

---

## 10. Production change statement

No production deployment occurred. No migration ran. No production data, hosting configuration,
PHP setting, database setting or cron job was changed. The live traffic issued during this task was
limited to three short read-only anonymous stages (2, 10 and 25 VUs, 75 s each) against public
endpoints, all of which completed inside the stop thresholds with zero errors.
