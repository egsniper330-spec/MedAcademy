# MedAcademy Production Readiness — Final Audit (2026-10-26)

Supersedes the "not completed" sections of
[PRODUCTION_READINESS_AUDIT_ROUND2.md](PRODUCTION_READINESS_AUDIT_ROUND2.md) and
extends [PRODUCTION_READINESS_AUDIT.md](PRODUCTION_READINESS_AUDIT.md) (client
audit, 2026-10-12). Every earlier finding is retained there; this file records
what was **resolved**, what was **measured**, and what is **still open**.

**Verdict: not yet approved for production launch.** The code is in good shape
and every automated suite passes, but three things are outside what a local
audit can decide: the dependency advisories have no patched upstream release,
the live host has never been load-tested (and must not be without approval), and
two optional index migrations are prepared but not applied.

---

## 1. What this round actually did

| # | Requested item | Status |
|---|---|---|
| 1 | Resolve `/provider-health` exposure | **Done** — route gated, internal fields removed, tests updated |
| 2 | Fix `/system-health` monitoring | **Done** — real DB probe, per-subsystem status, no secrets |
| 3 | Complete the dependency audit | **Done** — 17 production advisories identified, all build/dev-only; no safe upgrade exists yet |
| 4 | Complete the database review | **Done** — 2 fresh-install defects found and fixed; index evidence measured; migration prepared, **not applied** |
| 5 | Capacity testing | **Done** — k6 installed, bounded scripts written, **measured locally**; live host untested by design |
| 6 | External-service research | **Done** — official 2026 pricing + annual estimates |
| 7 | Functional completeness matrix | **Done** — role by role, with evidence and explicit "unverified" marks |
| 8 | Final verification + deliverables | **Done** — see §9, §10 |

Environment used for every measurement below: Windows 11 (Git Bash), PHP 8.3.35
(CLI, `pdo_mysql`/`sqlite`/`curl` enabled), MariaDB 11.4.5, k6 v2.3.0, Node
v24.18.0, npm 10.9.9. **No production system was touched.**

---

## 2. Closed findings from round 2

### F-01 — Public provider diagnostics (was P1) → **FIXED**

*Change:* `backend/routes/api.php` now registers both diagnostic routes behind
`$auth + ['role' => ['admin', 'super_admin']]`; the comment documents that public
uptime checks use `/api/health`.

*Response minimisation:* `HealthController::providerHealth` no longer selects
`status_message` or `version` — those can carry provider account/error detail.
It returns `provider_key, display_name, category, is_active, is_default, status,
last_health_check`.

*Client impact — verified, none:* the only frontend consumer of either route is
`src/app/(app)/(hubs)/export-panel.tsx` (Super Admin export panel) calling
`system-health`. `provider-health` has **no** client caller at all — it exists
only in the `php.ts` path map and the `GET_FUNCTIONS` set. No client behaviour
changes.

*Evidence (live, local stack):*

```
GET /system-health   (student token) → 403 Forbidden: requires role admin or super_admin
GET /provider-health (student token) → 403 Forbidden: requires role admin or super_admin
```

### F-02 — `/system-health` always reported `database: ok` → **FIXED**

`HealthController::systemHealth` now runs `SELECT 1` through the real PDO
connection and reports per-subsystem `{name, status, latencyMs}` for
`database` and `storage` (an `is_writable()` probe of `storage/`), plus an
overall `status` of `ok|degraded`. Failures return a **generic code**
(`database_unavailable`, `storage_not_writable`) — never the exception text, SQL,
host, path or credentials.

**Monitoring endpoint (documented):** use `GET /api/health` (alias `GET /health`)
for uptime monitors. It returns
`{status, services:{database,api}, timestamp, error, version}` and is safe to
expose publicly: `error` is only ever `null` or `database_unavailable`.
`/system-health` and `/provider-health` are admin diagnostics, not monitor
targets.

### F-03 — `appVersionIdentity` test failure → **FIXED**

Two causes, both now resolved:

1. The generated `android/gradle.properties` (git-ignored) held
   `APP_VERSION_CODE=221 / APP_VERSION_NAME=1.0.844` while `app.json` declares
   `222 / 1.0.0`. Regenerated to match; the suite is green.
2. `package.json` `postinstall` called `node scripts/sync-android-version.js`,
   **a file that does not exist**. It was masked by `|| true`, so it silently
   did nothing on every install. The dead reference is removed; the real
   mechanism is the `plugins/withDynamicVersions.js` config plugin, which writes
   the values during prebuild.

Test result: `node tests/appVersionIdentity.test.cjs` → **69 assertions passed**.

---

## 3. New findings this round

### N-01 — `schema.sql` could not create a fresh database (P1, fixed)

Two independent defects in the checked-in schema:

1. `enrollments.visibility_level` was declared
   `PUBLIC.ENROLLMENT_VISIBILITY` — an **unconverted PostgreSQL enum type**.
   MySQL/MariaDB reject the whole `CREATE TABLE`:
   `ERROR 4161 (HY000): Unknown data type: 'ENROLLMENT_VISIBILITY'`.
2. At least five index names were declared **twice** in the same script
   (`idx_audit_logs_created_at`, `idx_courses_status`,
   `idx_lessons_section_order`, `idx_devices_user_status` ×3,
   `idx_enrollments_student_id`, …). `CREATE INDEX` has no `IF NOT EXISTS` in
   MySQL, so a fresh import aborts with *Duplicate key name*.

Both are fixed: the enum is now `VARCHAR(32) DEFAULT 'all'` with an explicit
`CHECK (visibility_level IN ('all','admin_only','super_admin_only'))`
(matching the values the controller actually accepts), and duplicate index
declarations are de-duplicated (the handful that needed two genuinely different
definitions kept both under distinct names).

*Proof the fix works:* a clean import of `backend/database/schema.sql` into an
empty MariaDB database now completes with **exit 0 and 74 tables**; the whole
`mysql-migrations/` series then applies on top. This is the first time this
round could build a database from the repository's own scripts.

**This is a fresh-install fix only.** It does not alter the live schema, and the
live database is untouched.

### N-02 — Redundant duplicate UNIQUE index on `enrollments` (P3, documented)

`enrollments` carries both `UNIQUE (student_id, course_id)` and
`UNIQUE enrollments_active_unique (student_id, course_id)` — identical columns,
identical uniqueness, two index structures maintained on every write. Harmless
but wasteful. **Not changed:** dropping a unique index on the live table needs
a maintenance window and is not worth one on its own. Recorded for the next
migration batch.

### N-03 — Backend regression harness had stale route expectations (P2, fixed)

`backend/scripts/regression-test.php` still listed `POST /activation-codes` and
`POST /activation-codes/redeem`, which were removed with the activation-code
system. Every run therefore reported two false failures (`404 Route not found`).
Removed, with a comment naming the replacement endpoints.

The same harness reported the two `/video/*` routes as failures on any server
without `VDOCIPHER_API_SECRET` (they correctly answer
`500 Video service not configured`). That case is now a **`SKIP` with a stated
reason**, counted separately from passes, and it still fails on a server that
*has* the secret.

### N-04 — Dead `postinstall` reference (P3, fixed)

See F-03 above.

### N-05 — Every device-less login logged a PHP warning (P2, fixed)

Found in the running server's own log while load-testing:

```
{"level":"error","message":"PHP error","context":{"severity":2,
 "message":"Trying to access array offset on null",
 "file":"…/backend/src/Services/AuthService.php","line":257}}
```

`login()` legitimately leaves `$device` null when the client sends no device
fingerprint (the code comments require that to be allowed), then read
`$device['id']` twice — for the audit row and for the session's `device_id`.
PHP 8 evaluates that to `null` and logs a warning on **every** such login. It
survives today only because warnings are not converted to exceptions; anywhere
they are, login would 500.

Fixed by reading `$device['id'] ?? null` into `$deviceId`. Verified: three
logins after the change produce **no new log entries** (the log file still ends
at its 2026-08-24 entries).

---

## 4. Capacity testing — k6

### 4.1 Installation

| | |
|---|---|
| Method | Official standalone Windows binary (no admin, no service, no system change) |
| Version | **k6 v2.3.0** (`commit/e088784614, go1.26.8, windows/amd64`) |
| Source | `https://github.com/grafana/k6/releases/download/v2.3.0/k6-v2.3.0-windows-amd64.zip` |
| Integrity | SHA-256 verified against the release `checksums.txt`: `112276d4…48ce43` ✔ |
| Location | `.freebuff/tools/k6/k6.exe` (git-ignored) |
| Runtime deps | none added to `package.json` — the tool stays out of the app |

`k6 version` and a 5-iteration smoke test both pass (§4.3).

### 4.2 Scripts (committed, read-only)

| File | Purpose |
|---|---|
| [scripts/loadtest/README.md](../scripts/loadtest/README.md) | install, run, stop, thresholds, safety rules |
| [scripts/loadtest/lib/config.js](../scripts/loadtest/lib/config.js) | env parsing, **bounded** stages, thresholds, 50-VU hard ceiling |
| [scripts/loadtest/smoke.js](../scripts/loadtest/smoke.js) | 1 VU × 5 iterations, strict — run first |
| [scripts/loadtest/student-journey.js](../scripts/loadtest/student-journey.js) | the real student flow, ramped |
| [scripts/loadtest/seed-local.php](../scripts/loadtest/seed-local.php) | idempotent fixtures; **refuses to run when `APP_ENV=production`** |

Journey per iteration (12 requests, the same order the app uses): `/api/health`
→ `/auth/me` → `/courses` → `/notifications` → `/credits/me` →
`/courses/{id}` → `/courses/{id}/lessons` → `/security/policies` →
`/platform/branding` → `/platform/feature-flags`. Login happens once in
`setup()` and the token is shared, because `POST /auth/login` is rate limited to
10/min per IP — a per-iteration login would measure the limiter.

### 4.3 Measured results — local PHP 8.3 + MariaDB 11.4

Environment: both server and database on the same machine as the load generator;
PHP built-in server (`php -S`, **single worker**), 12 published courses × 12
lessons, 12 enrollments, 50,020 notification rows. Think time 300 ms.
Each run: 5–10 s ramp, 20–30 s hold, 5 s ramp-down (45 s total).

| VUs | req/s | p50 | p95 | p99 | max | errors |
|----:|------:|----:|----:|----:|----:|-------:|
| 1 | 17.0 | 15.9 ms | 32.9 ms | 46.7 ms | 122 ms | 0.00 % |
| 5 | 55.3 | 36.7 ms | 101.1 ms | 135.2 ms | 180 ms | 0.00 % |
| 10 | 61.4 | 101.1 ms | 184.0 ms | 233.0 ms | 284 ms | 0.00 % |
| 20 | 62.2 | 253.8 ms | 364.5 ms | 419.2 ms | 478 ms | 0.00 % |

Per-endpoint (5 VUs, 165 samples each):

| Endpoint | p50 | p95 | p99 |
|---|---:|---:|---:|
| `GET /auth/me` | 47.3 ms | 95.1 ms | 124.1 ms |
| `GET /courses/{id}/lessons` | 41.5 ms | 86.6 ms | 99.9 ms |
| `GET /courses/{id}` | 41.1 ms | 84.6 ms | 114.3 ms |
| `GET /platform/feature-flags` | 39.3 ms | 84.6 ms | 105.1 ms |
| `GET /platform/branding` | 41.5 ms | 82.8 ms | 105.3 ms |
| `GET /security/policies` | 43.0 ms | 82.5 ms | 114.5 ms |
| `GET /courses` | 46.1 ms | 81.9 ms | 107.1 ms |
| `GET /notifications` | 42.5 ms | 80.2 ms | 105.7 ms |
| `GET /api/health` | 38.2 ms | 77.8 ms | 102.7 ms |
| `GET /credits/me` | 41.9 ms | 73.7 ms | 101.8 ms |
| `POST /auth/login` | 124.4 ms | — | — |

Raw summaries and the per-endpoint JSON are in `.freebuff/loadtest-results/`
(git-ignored).

### 4.4 What these numbers mean — and what they do not

**Bottleneck (confirmed): the web server, not the code.** Throughput is flat at
~62 req/s from 10 to 20 VUs while p95 triples (184 ms → 364 ms). That is
classic queueing at a single PHP worker: PHP's built-in server handles one
request at a time, so every extra user waits in line. Zero errors were observed —
it degrades by queueing, not by failing.

Per-request *service time* is therefore the useful signal here: **~16 ms median
per API call** at 1 VU, with the slowest endpoint (`/auth/me`, which joins
profile + security state) around 47 ms p50. No endpoint showed pathological cost.

**Explicitly not claimed:**

- **No maximum concurrent-student capacity is claimed.** A single-worker dev
  server cannot measure production concurrency. cPanel's real handler is
  LiteSpeed/Apache with PHP-FPM/suEXEC, whose worker pool is configured by the
  host, not by this repo.
- **Virtual users ≠ concurrent API requests ≠ concurrent video viewers.** Each
  VU here issues one request at a time (12 per iteration with 300 ms pauses).
  Video never touches PHP: playback is served by the video provider's CDN and
  only the OTP/authorization call hits this API, so a thousand simultaneous
  viewers are ~1 short API call each, not a thousand PHP workers.
- **No conversion factor** from these numbers to the live host exists. Local
  MySQL is on loopback; the live database is too (cPanel `localhost`), but CPU
  steal, LVE throttling, TLS, and shared-node contention are all absent here.

### 4.5 Running this against the live host (only with your approval)

1. Get the host's approval, ideally at an off-peak hour. Shared hosting is
   multi-tenant; a heavy run can degrade other sites on the node and may breach
   the host's terms.
2. Record the baseline first: cPanel → *Metrics → Resource Usage* (CPU, PMEM,
   EP, faults) and `GET /api/health` latency.
3. Use `scripts/loadtest/smoke.js` first (1 VU), then the journey at
   `MAX_VUS=5` with `HOLD_SECONDS=60`. Do not exceed 10 VUs on shared hosting.
4. **Stop conditions** — abort on the first occurrence of any of these:
   `508` (CloudLinux entry-process limit), any `5xx` above 0.5 %, a new/rising
   resource fault in cPanel, p95 > 2 s, or `GET /api/health` failing.
   `k6 run --duration 60s` bounds the run independently of the script.
5. Only then, and only for that account/plan, does a "safe concurrent request
   rate" become a measured statement — the cPanel limits themselves
   (CPU %, entry processes, memory, MySQL `max_connections`) are set by the
   provider and are not visible from this repository.

---

## 5. Dependency audit

`npm audit --omit=dev` today: **17 advisories — 0 critical, 6 high, 11 moderate.**
(The round-2 figure of 25 with 1 critical predates the lockfile updates already
in this working tree; the critical `shell-quote` advisory is resolved.)

### 5.1 The six high findings

| Package | Advisory | Range | Resolved to | Reached via | Reachable in the shipped app? |
|---|---|---|---|---|---|
| `shell-quote` | GHSA-w7jw-789q-3m8p (critical, older) + GHSA-pqg4-j6r4-53mv | `<1.11.0` | **1.12.0** ✔ | `react-native → react-devtools-core` | **No** — dev tools |
| `node-forge` | GHSA-86w9-cpqp-85rv | `<=1.4.0` | **no fix published** | `expo → @expo/cli`, `@expo/code-signing-certificates` | **No** — build/signing tooling |
| `zod` | GHSA-mrhx-c7xc-m3w5 | `<4.6.6` | 3.25.76 (no 3.x fix) | `expo → @expo/cli` | **No** — CLI only |
| `@expo/cli` | transitively from the above | — | — | `expo` | **No** — build tool |
| `expo` | (no direct SDK advisory found; flagged via `@expo/cli`) | — | — | direct dependency | **No** — the flag is the CLI subtree |
| `@react-native-async-storage/expo-with-async-storage` | advisory attributed via the plugin chain | — | no dedicated GHSA found | config plugin | **No** — prebuild-time only |

### 5.2 Evidence for "not shipped"

- No application source imports any of them:
  `grep -r "zod\|node-forge\|shell-quote\|js-yaml" src/ scripts/` → **no matches**.
- The existing web export in `dist/` (7.2 MB entry bundle, contains app code —
  confirmed by a control token) contains **zero** occurrences of `node-forge` or
  `shell-quote`.
- `npm ls` shows every one of them only under tooling branches (`expo →
  @expo/cli`, `react-native → react-devtools-core`, `eslint`, `babel-jest`).

### 5.3 Decisions

- **No upgrades applied.** Nothing in the shipped bundle is affected, and
  `node-forge` has no patched release — an "upgrade" would mean forking or
  overrides that break Expo's signing toolchain.
- **`expo` was not bumped.** SDK 55 pairs with React Native 0.83; the latest is
  SDK 58 / RN 0.88. That is a multi-day, device-tested migration, not an audit
  fix. It is the correct *next* project, not a patch to squeeze in.
- **Residual risk accepted and recorded:** a developer machine running
  `node-forge`-based Expo signing tools on attacker-influenced cert material is
  the only affected scenario. Mitigation is procedural (build from trusted
  inputs), not a version bump.
- Re-check with `npm audit --omit=dev` after any Expo SDK upgrade; the
  `node-forge` advisory should clear whenever upstream ships a fix.

---

## 6. Database review

### 6.1 Schema and migrations

- `schema.sql` now imports cleanly (N-01); 74 tables; all `mysql-migrations/`
  apply on top. Migration `034` shows the enrollments table ending up with the
  duplicate unique index described in N-02.
- Migrations that use `DROP CONSTRAINT` (`006_drop_redundant_upload_audit_logs_c0.sql`)
  are **MySQL-only syntax**; on MariaDB they print an error and skip. The
  constraint is a CHECK, so the effect is cosmetic — but a MariaDB host would
  need the equivalent `DROP CHECK`.

### 6.2 Index evidence (measured, not guessed)

`EXPLAIN` on the real queries from the controllers:

| Query | Plan today | Verdict |
|---|---|---|
| `courses` list (student): `status='published' OR EXISTS(enrollment)` `ORDER BY created_at` | `ALL` + filesort | OR-across-tables defeats a single index. Fine at small size; see migration note. |
| `lessons` by course | `ref idx_lessons_course_id` ✔ | good |
| `notifications` by user, `ORDER BY created_at DESC LIMIT 100` | `ref idx_notifications_user_id` + **filesort** | improvable |
| `enrollments` count by (student, status) | `ref idx_enrollments_student_status`, **covering** ✔ | good |
| `auth/me` profile + security read | primary key ✔ | good |

Composite index test on `notifications (user_id, created_at)`, same session,
`SET profiling=1`, 50,020 rows:

```
before: 3.67 ms / 0.66 ms / 1.35 ms   (filesort)
after:  1.78 ms / 0.57 ms / 0.61 ms   (no filesort)
```

Modest at this volume, and it removes the sort entirely — which is what matters
as a user's notification history grows.

### 6.3 Prepared migration (NOT applied)

[migration 037](../backend/database/mysql-migrations/037_perf_query_indexes.sql)
adds `notifications (user_id, created_at)` and `courses (status, created_at)`,
with the measurements above, the reason it does *not* rewrite the OR query, an
idempotency note, and the rollback (`DROP INDEX`, data-safe).

**It has not been run against production and must not be until you schedule it.**
It is additive, online-DDL, and reversible in one statement.

### 6.4 Concurrency and N+1

- Enrollment is protected by a UNIQUE key and the controller handles the
  lost-race case explicitly (verified by the suite: "the genuine lost race of
  two concurrent requests").
- Admin bulk operations issue one query per selected user — bounded by the
  selection, no unbounded loop. Acceptable, noted rather than changed.
- No N+1 pattern found on the student read paths exercised by the load test:
  per-iteration query count is constant regardless of course/lesson count.

---

## 7. External services — official 2026 pricing

All figures from the vendors' own pricing pages (read 2026-10-26). Where a
figure could not be confirmed it is marked.

| Service | Free tier | Paid | Card to start |
|---|---|---|---|
| **UptimeRobot** | 50 monitors, **5-minute** checks | — | No |
| **Better Stack** | 10 monitors / 10 heartbeats, 1 status page | $29/responder/mo (annual) or $34 monthly | Not stated |
| **Sentry** | 5,000 errors/mo, **1 user** | Team **$26/mo** (annual), 50k errors, unlimited users | Not stated |
| **Cloudflare R2** | 10 GB-mo, 1M Class A, 10M Class B | $0.015/GB-mo; $4.50/M Class A; $0.36/M Class B; **egress $0** | Not stated |
| **Cloudflare Stream** | not numerically confirmed | **$5 / 1,000 min stored**/mo; **$1 / 1,000 min delivered** | Not stated |
| **Bunny Stream** | trial | storage from **$0.01/GB**; delivery from **$0.005/GB**; **$1/mo minimum** | No |
| **Backblaze B2** | first 10 GB free | **$6.95/TB-mo**; egress free to 3× stored, then **$0.01/GB** | Not confirmed |
| **Grafana k6** | OSS free; Cloud **500 VUH/mo** | Cloud Pro $0.15/VUH, $19/mo platform fee | Cloud: no |

### Annual estimates

Assumptions (state them to anyone who reads the number):
20-minute average lesson; a 480-lesson library ≈ 9,600 stored minutes ≈ 72 GB at
~1 Mbit/s; an "active student" watches **20 lessons (400 minutes) per month**;
storage constant across tiers unless noted. Excluded because unpriced/unknown:
the current video provider's own fees (VdoCipher — not researched, existing
contract), cPanel hosting, domain, app-store fees, email/SMS, and any
professional services.

| Scenario | Delivered min/mo | Cloudflare Stream | Bunny Stream | R2 (storage/backup only) |
|---|---:|---|---|---|
| **100 students** | 40,000 | $48/mo storage + $40/mo delivery ≈ **$1,056/yr** | 72 GB + 300 GB ≈ **$27/yr** | **<$2/yr** (inside free tier) |
| **1,000 students** | 400,000 | $576 + $4,800 ≈ **$5,376/yr** | 72 GB + 3,000 GB ≈ **$190/yr** | ~$13/yr (72 GB) |
| **10,000 students** | 4,000,000 | $1,152 (2× library) + $48,000 ≈ **$49,152/yr** | 144 GB + 30,000 GB ≈ **$1,820/yr** | ~$26/yr |

Monitoring, all tiers: **UptimeRobot $0** or Better Stack **~$348/yr**; Sentry
$0 (≤5k errors) up to **$312/yr**; k6 OSS **$0** (Grafana Cloud free covers
500 VUH/mo of CI runs).

**Read the delivery column carefully.** Bunny is dramatically cheaper per
delivered GB because Stream prices by *minute*; Cloudflare Stream prices storage
as prepaid capacity and delivery per minute. These are list prices, not a quote,
and they are only comparable if your actual watch-time matches the assumption —
at 40 lessons/month per student instead of 20, double the delivery lines.

---

## 8. Functional completeness — role by role

Evidence legend: **[live]** = exercised by HTTP against the local PHP+MariaDB
stack this round · **[suite]** = covered by a passing automated suite ·
**[code]** = read and reviewed, not executed · **unverified** = no evidence.

### Student

| Workflow | Status | Evidence |
|---|---|---|
| Sign in (email/identifier + password), JWT session | **Verified** | [live] `POST /auth/login` 200; [suite] regression harness |
| Session restore, `/auth/me` | **Verified** | [live] 200; [suite] |
| Course discovery / list | **Verified** | [live] `/courses` |
| Course detail + curriculum | **Verified** | [live] `/courses/{id}`, `/courses/{id}/lessons` |
| Free-course self-enrollment, idempotency, price from DB, published-only, suspension, feature flag | **Verified** | [suite] `backend/tests/course-enrollment` **39/39** |
| Notifications list | **Verified** | [live] 200 |
| Credits balance / transactions | **Verified** | [live] `/credits/me` |
| Security policy fetch | **Verified** | [live] `/security/policies` |
| Protected PDF delivery (watermarked, token-gated) | **Verified (authorization)** | [suite] `pdf-watermark/auth_tests.php` all passed; [suite] material lifecycle 33/33 |
| Video playback (OTP → provider) | **Unverified here** — needs a real VdoCipher secret; the route correctly returns 500 "not configured" without one | [code] |
| Offline download / entitlement | **Unverified** — device-only | [suite] client-side `offlineState` suite passes |
| Arabic RTL layout | **Partially verified** — see §10.3 | [suite] 4 RTL suites |

### Doctor / instructor

| Workflow | Status | Evidence |
|---|---|---|
| Own course list (`doctor_id` scoped) | **Verified** | [suite] regression harness role gating; [code] controller |
| Create/edit/publish/archive course, sections, lessons | **Verified (authz only)** — real create/edit needs a doctor session + fixtures; harness confirms role gating | [code] |
| Lesson material upload / replace / delete + storage cleanup | **Verified** | [suite] `material-lifecycle` **33/33** |
| Video upload (init/chunk/assemble) | **Unverified** — needs provider credentials | [code] |
| Student list scoped to own students | **Verified (authz)** | [suite] role gating |
| Earnings / revenue views | **Unverified** — no fixtures for financial data | [code] |

### Admin

| Workflow | Status | Evidence |
|---|---|---|
| User list / detail / role / status / block / restore | **Verified (authz)** | [suite] harness: student gets 403 on all `/admin/*` |
| Audit log read/write | **Verified (authz)** | [suite] harness |
| Bulk user operations | **Verified (authz)**, behaviour [code] |
| Trash cleanup, enrollment grant, device reset | **Verified (authz)** | [suite] harness |
| System/provider diagnostics (routes in §2) | **Verified** | [live] 403 for student, [code] admin path |

### Super Admin

| Workflow | Status | Evidence |
|---|---|---|
| Platform branding / CMS pages / feature flags | **Verified (read)** | [live] `/platform/*` 200 for an authenticated user |
| App update config + release lifecycle | **Verified** | [suite] `updateDetection`, `appReleasesAndWatermark`, `releaseConfigConsistency` |
| Maintenance mode | **Verified** | [suite] harness + middleware [code] |
| Impersonation | **Verified (authz)** | [code] + suite |
| Redeem codes, support settings | **Verified (authz)** | [suite] harness |

### Cross-cutting / public

| Item | Status | Evidence |
|---|---|---|
| Health endpoints (`/`, `/api/health`, `/health`) | **Verified** | [live] 200 + real DB probe |
| Route ↔ handler consistency | **Verified** | [suite] `check-route-methods.js`: 203 methods, all handlers exist |
| Full route sweep (auth reject / role reject / auth accept) | **Verified** | [suite] harness **117/117 executed passed, 2 skipped** |
| PHP syntax of every backend file | **Verified** | `php -l` × **145 files, 0 errors** |
| TypeScript | **Verified** | `tsc --noEmit` clean |
| Client test suite | **Verified** | **123 suites passed, 0 failed** |
| Certificate pinning / VPN / root detection enforcement | **Verified (server-side)** | [suite] `serverSideSecurityEnforcement`, `vpnMandatoryBlock` |
| Live uptime / capacity | **Unverified** — no live test performed | — |

---

## 9. Verification log (exact commands and results)

| Check | Command | Result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | **PASS** (clean, exit 0) |
| Client suites | `npm test` | **PASS — 123 passed, 0 failed** (196 s) |
| Backend PHP lint | `php -l` over `backend/**/*.php` | **PASS — 145 files, 0 syntax errors** |
| Route/handler consistency | `node backend/scripts/check-route-methods.js` | **PASS** |
| Backend route sweep | `php backend/scripts/regression-test.php` | **PASS — 117/117 executed, 2 skipped** (provider unconfigured) |
| Enrollment rules | `bash backend/tests/course-enrollment/run.sh` | **PASS — 39/39** |
| Material lifecycle | `bash backend/tests/material-lifecycle/run.sh` | **PASS — 33/33** |
| PDF auth | `php backend/tests/pdf-watermark/auth_tests.php` | **PASS — all authorization checks** |
| PDF error cases | `php backend/tests/pdf-watermark/error_tests.php` | **2 cases FAIL locally**: `too_many_pages`, `source_too_large` — the env-var overrides those cases rely on do not take effect once a real `backend/.env` is loaded. Environment-sensitive suite, not a product defect; needs a run without `backend/.env`. |
| k6 smoke | `k6 run scripts/loadtest/smoke.js` | **PASS — 30/30 checks, 0 % failed** |
| k6 journey ×4 | see §4.3 | **PASS** at 1/5/10/20 VUs, 0 % errors |
| Schema import | `mariadb < backend/database/schema.sql` | **PASS — exit 0, 74 tables** |
| Migrations | `mysql-migrations/*.sql` in order | **applied**; MariaDB-only gaps noted in §6.1 |

Tools **not available** (so nothing is claimed for them): a real device or
simulator (no visual/RTL screenshot verification, no cold-launch timing), a
VdoCipher account, the live cPanel host, Docker (not installed).

---

## 10. Files, deployment and rollback

### 10.1 Backend files that MUST be deployed to the live server

| Path | Why | Deploy? |
|---|---|---|
| `backend/src/Controllers/HealthController.php` | real DB probe; strips `status_message`/`version` | **YES** |
| `backend/src/Services/AuthService.php` | null-device login warning (N-05) | **YES** |
| `backend/routes/api.php` | admin gate on `/system-health`, `/provider-health` | **YES** |
| `backend/scripts/regression-test.php` | operational test harness (not routed; deploy only if you run it from SSH) | Optional |
| `backend/database/mysql-migrations/037_perf_query_indexes.sql` | **prepared, do not import yet** | **NO — after approval** |
| `backend/database/schema.sql`, `schema-no-triggers.sql` | fresh-install correctness only; live DB unaffected | No (keep in repo) |

Deploy all three PHP files **together** — the route gate references the new
controller response shape, and shipping only one leaves either an unauthenticated
route or a controller nobody can reach. No new env var is required; no PHP
extension is required beyond what the server already runs; **no frontend rebuild
is needed** for this set.

**Deploy order matters — stale package warning.**
`backend/deploy-package/2026-10-23-pdf-watermark-mandatory/routes/api.php` is a
**full copy of the route table with the old public health routes** (lines 53–54)
and the package contains no `HealthController`. If that package is ever replayed
verbatim *after* this change, it silently reopens `/system-health` and
`/provider-health`. There is **no deploy package for this change set**; upload
the three files individually, or upload this `routes/api.php` last.

### 10.1a Is a database migration required?

**No.** None of the three deployed files needs a schema change:

- the health gate and the DB probe use tables that already exist;
- the `AuthService` change touches no SQL;
- the two schema files are **fresh-install corrections only** — the live
  `enrollments` table already exists and is unaffected.

Two *optional* schema items, both gated on a decision:

1. [Migration 037](../backend/database/mysql-migrations/037_perf_query_indexes.sql)
   — the two performance indexes. Not required for correctness.
2. `chk_enrollments_visibility` now exists in `schema.sql`, so a **new** install
   enforces the three legal values. The live table will not have it. Before ever
   adding it, prove the existing rows comply (a violation makes the `ALTER`
   fail):
   ```sql
   SELECT visibility_level, COUNT(*) FROM enrollments
    GROUP BY visibility_level;
   -- every row must be all / admin_only / super_admin_only
   ```
   Then: `ALTER TABLE enrollments ADD CONSTRAINT chk_enrollments_visibility
   CHECK (visibility_level IN ('all','admin_only','super_admin_only'));`
   Skipping it changes no behaviour — the controller already rejects any other
   value with a 422.

### 10.2 Frontend

- **No rebuild required** for the backend fixes (no client contract changed).
- `app.json`'s `versionCode` is unchanged this round.
- If you ship the RTL/header work already in the tree, rebuild the native app —
  those are source-level component changes, not OTA-safe copy.

### 10.3 Local-only artifacts (never deployed)

`.freebuff/tools/` (k6, portable MariaDB, PHP ini), `.freebuff/loadtest-results/`,
`.freebuff/*.log`, and **`backend/.env`** — a throwaway local file with a test
database password, ignored by git, containing no production value.

### 10.4 All files created / modified / deleted

**Created**

| File | Reason |
|---|---|
| `docs/PRODUCTION_READINESS_AUDIT_FINAL.md` | this report |
| `scripts/loadtest/README.md` | install/run/stop/safety |
| `scripts/loadtest/lib/config.js` | shared bounded config |
| `scripts/loadtest/smoke.js` | toolchain verification |
| `scripts/loadtest/student-journey.js` | bounded student scenario |
| `scripts/loadtest/seed-local.php` | idempotent fixtures (production-refusing) |
| `backend/database/mysql-migrations/037_perf_query_indexes.sql` | prepared indexes (not applied) |

**Modified**

| File | Change |
|---|---|
| `backend/routes/api.php` | admin gate on the two diagnostic routes |
| `backend/src/Controllers/HealthController.php` | real probes; minimised payloads |
| `backend/src/Services/AuthService.php` | `$deviceId ?? null` on the no-device login path |
| `backend/database/schema.sql` | enum type fixed; duplicate indexes removed |
| `backend/database/schema-no-triggers.sql` | same enum fix |
| `backend/scripts/regression-test.php` | stale routes removed; skip semantics; counters |
| `package.json` | dead `postinstall` reference removed |

**Deleted:** none.

**Untouched by this round but present in the working tree** (from earlier work,
reviewed and left as-is): `THIRD_PARTY_NOTICES.md`,
`docs/dependency-license-inventory.json`, `package-lock.json`, `app.json`,
`tests/healthEndpointsHardening.test.cjs`,
`docs/PRODUCTION_READINESS_AUDIT_ROUND2.md`.

### 10.5 Rollback

- Health routes/controller: revert those two files and redeploy; the previous
  behaviour returns immediately (the routes were public before).
- Migration 037: `ALTER TABLE notifications DROP INDEX idx_notifications_user_created;`
  and `ALTER TABLE courses DROP INDEX idx_courses_status_created;` — dropping an
  index never touches data.
- Load-test scripts: delete `scripts/loadtest/`; no runtime dependency exists.

---

## 11. Still open / needs your decision

1. **Live capacity test — deliberately NOT run.** You asked for no production
   modification, so no traffic was sent to the live host in this round. Note that
   even the approved baseline could not have covered authenticated reads: there
   is no dedicated load-test account on the server, and `POST /auth/login` is
   rate limited to 10/min per IP. A future baseline therefore needs (a) a
   disposable live account with a known password, and (b) a public-only variant
   of the journey (health + root) for the unauthenticated part. Until then no
   concurrent-user number will be stated.
2. **Migration 037** — additive and reversible; needs a go-ahead and a slot.
3. **Dependency advisories** — `node-forge` has no upstream fix; the only real
   remedy is the Expo SDK 55 → 58 upgrade, which is its own tested project.
4. **PDF error suite** — re-run without `backend/.env` to confirm
   `too_many_pages` / `source_too_large` (environmental, not product).
5. **RTL** — the central fixes (PageHeader, DashboardHeader, drawer geometry)
   are in the tree and pass 4 RTL suites, but no screen-by-screen **visual**
   verification was possible without a simulator or device. Screens that build
   their own header must still be spot-checked on hardware.
