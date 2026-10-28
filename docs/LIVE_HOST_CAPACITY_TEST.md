# Live Spaceship host capacity test — 2026-10-27

Target: **`https://api.medacademy.site`** (Spaceship cPanel shared hosting, PHP 8.2 + MariaDB 11.4.13-cll-lve).
Generator: k6 v2.3.0 on the workstation in this repository. Every request in this
report reached the live production host — no stub, mock or local PHP process was
involved (`SESSION_MODE=none`, `BASE_URL=https://api.medacademy.site`, runner
approval `--approve-live` + `LOADTEST_APPROVED=1`).

## 1. Endpoints and workflow actually exercised

`SESSION_MODE=none` — the **public boot workflow**, exactly the four calls a cold
app launch makes before anyone signs in. All four are unauthenticated `GET`s and
read-only (verified in `backend/routes/api.php` and their handlers):

| Endpoint | Auth | Handler work |
|---|---|---|
| `GET /api/health` | none | front-controller boot + DB `SELECT 1` |
| `GET /app/version` | none | config read |
| `GET /maintenance` | none | settings read |
| `GET /support/contact` | none | settings read |

One iteration = those four calls, then a think-time pause (1,500 ms), modelling a
device that is alive but idle — not a user mashing the API.

### Why the signed-in student journey was NOT run live

Production has **no dedicated test account**: a read-only query over SSH counted
`loadtest.*` / `test*` accounts → **0** (active: 7 students, 2 doctors, 1 admin,
1 super_admin). `scripts/loadtest/issue-tokens.php` refuses to mint fixtures when
`APP_ENV=production`, by design. Driving 200 VUs with a real student's session
would hammer production under a real user's identity and revoke-able session, so
it was not done. The authenticated journey stays ready (`SESSION_MODE=pool` +
`issue-tokens.php` against a staging install, or a dedicated account).

**Therefore: these numbers measure PHP + DB request handling, not a signed-in
student's workload.**

## 2. Results — one row per stage

Thresholds set **before** the first stage: error rate > 2 %, p95 > 2000 ms,
p99 > 4000 ms, 5xx > 0.5 %, timeouts/connection failures > 0.5 % → abort
(`abortOnFail`). The 200-VU rung was additionally run with **tightened** limits
(error > 1 %, p95 > 1500 ms, p99 > 3000 ms, 5xx > 0.2 %) because 150 VUs had
already produced 5xx responses.

| Target VUs | Achieved VUs | Duration | Requests | RPS | p50 | p90 | p95 | p99 | Err % | 5xx | Timeouts | Result |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2 (smoke) | 2 | 5/15/5 s | 152 | 2.95 | 270 ms | 291 | 304 | 339 | 0 | 0 | 0 | PASS |
| 10 | 10 | 15/30/30 s | 812 | 9.65 | 267 ms | 289 | 299 | 337 | 0 | 0 | 0 | PASS |
| 25 | 25 | 15/30/30 s | 2,040 | 27.17 | 273 ms | 309 | 336 | 418 | 0 | 0 | 0 | PASS |
| 50 | 50 | 15/30/30 s | 3,872 | 50.26 | 262 ms | 283 | 294 | **3,850** | 0 | 0 | 0 | PASS (tail spike) |
| 100 | 100 | 20/30/30 s | 8,792 | 106.64 | 256 ms | 279 | 286 | 317 | 0 | 0 | 0 | PASS |
| 150 | 150 | 25/30/30 s | 13,324 | 152.73 | 265 ms | 300 | 325 | 776 | 0.10 | **13** | 0 | PASS, first 5xx |
| 200 | 200 | 20/25/30 s | 13,168 | 168.78 | 292 ms | **692** | **797** | 1,321 | 0.11 | **15** | 0 | PASS (tightened limits) |

Latency ignores time spent waiting for the generator's think-time. Percentiles are
k6's, computed from every sample in the stage.

**Achieved vs configured:** every stage reached its configured concurrency
(`vus_max` = target), so 200 concurrent simulated VUs were genuinely achieved —
they are 200 concurrent *anonymous* requests, not 200 signed-in students.

## 3. Baseline

* `GET /api/health` single-shot, no load: `200`, 0.888 s wall including TLS from
  this workstation; in-test per-endpoint p50 ≈ 270 ms.
* Idle server-side state before the ramp: node load average 22.74 / 20.21 / 19.71
  on 24 cores (shared node — other tenants included), 131 GB RAM with 23.7 GB
  used, MariaDB `Threads_connected` low, `max_connections = 500`,
  `max_user_connections = 50`.

## 4. Bottleneck — proven, not inferred

The 5xx responses are **MariaDB per-user connection-quota errors**, from the
production log (`storage/logs/app.log`, sanitized; no credentials or user data):

```
{"ts":"2026-10-27T11:12:18Z","level":"error","request_id":"d836f01a02a21936",
 "message":"Database connection failed",
 "context":{"status":500,"previous":"SQLSTATE[HY000] [1226] User 'vcoafnqsgg_api'
            has exceeded the 'max_user_connections' resource …"}}
```

* `SHOW VARIABLES` → **`max_user_connections = 50`** for the API's DB user, while
  the server-wide `max_connections = 500`.
* Exactly **30** such errors in the log: **15 in the 150-VU minute (11:10)** and
  **15 in the 200-VU minute (11:12)** — matching k6's per-stage `server_error`
  counts (13 and 15).
* `Connection_errors_max_connections = 0`, so it is the *per-account* quota, not
  the server ceiling.
* Nothing above 100 VUs failed; nothing at 100 VUs or below produced a single
  5xx, timeout or connection failure.

**First observed bottleneck: > 50 simultaneously-open DB connections from the
application account.** Everything else held: PHP answered every request, p99
stayed under 1.4 s at 200 VUs, and the database reported
`Threads_running` 8 with no `max_connections` refusals after the run.

### Degradation, by the numbers

* **Up to 100 VUs the host was indifferent** — p50 256 ms, p95 286 ms, 0 errors,
  106 req/s.
* **150 VUs:** p99 jumps to 776 ms and the first 13 5xx appear.
* **200 VUs:** p90 692 ms (2.5× the 100-VU value) and p95 797 ms, with 15 5xx.
  Per-10-second buckets show the errors clustered in three buckets
  (6 / 3 / 6) once the ramp saturated — a sustained quota collision, not one
  cold-start blip.
* **50 VUs** produced a single p99 outlier of 3.85 s with no errors — a short
  stall worth watching, but not repeatable at 100 VUs (p99 317 ms).

## 5. Measured vs unavailable

Measured (read-only probes over SSH — `.freebuff/probe-db-status.php`,
`.freebuff/probe-loadtest-accounts.php`):

| Metric | Value |
|---|---|
| `max_user_connections` / `max_connections` | 50 / 500 |
| `Max_used_connections` (high-water) | 139 |
| `Threads_connected` / `Threads_running` after run | 62 / 8 |
| `Connection_errors_max_connections` | 0 |
| `Aborted_connects` (since 2 h uptime) | 1,147 |
| `Slow_queries` (cumulative) | 43 |
| `Innodb_row_lock_waits` / avg | 159 / 7.2 ms |
| `Table_locks_waited` | 112 |
| `Created_tmp_disk_tables` (cumulative) | 201,730 |
| `innodb_buffer_pool_size` | 118 MB |
| Node load / cores / RAM | 22.74 / 24 / 131 GB (23.7 GB used) |
| Data volume | 11 profiles, 6 courses, 6 lessons, 4 materials, 4 enrollments |

**Unavailable (stated as unavailable, not estimated):**

* CloudLinux LVE per-account CPU / entry-process / memory usage — no `lveinfo`,
  `lveps` or `cloudlinux-stat` binary is reachable from the account, and the
  cPanel *Resource Usage* page is UI-only. **Per-account CPU limits were
  therefore never confirmed or refuted**; the absence of 508s is the only
  evidence that entry-process limits were not hit.
* PHP-FPM/Apache worker counts and queue depth (`ps` shows no per-request PHP
  processes from the account's shell).
* Query latency per statement, query count per request, DB CPU/memory/I/O,
  deadlock history — the application instruments none of these, and enabling
  query logging on production was out of scope.

## 6. Is this enough to size real student usage?

It is enough to say the host **serves 200 concurrent anonymous boot requests at
~169 req/s with p95 < 0.8 s**, and that the first wall is the 50-connection DB
quota. It is **not** a capacity statement for signed-in student traffic:

* the workload is 4 public endpoints, not the dashboard/course/lesson mix;
* the dataset is tiny (6 courses), so no measured data-scale effect exists;
* one generator, one IP, no video traffic (video is served by the provider's CDN
  and consumes no PHP worker);
* 30-second holds show steady state, not a soak.

Do **not** read this as "MedAcademy supports 200 concurrent students".

## 7. Recommendations, from the measured evidence

1. **Raise the DB user quota** (or move to a pooled connection strategy): 50
   `max_user_connections` against a 500 server limit is the binding constraint,
   and it failed at 150 VUs while the server itself stayed healthy.
2. **Check connection per request**: if every PHP request opens its own DB
   connection, the account can serve at most 50 concurrent requests no matter
   how much CPU it has; reuse/pooling raises that ceiling without new hardware.
3. **Investigate `Created_tmp_disk_tables = 201,730`** (queries spilling temp
   tables to disk) — a query-shape signal, flagged as unmeasured here.
4. **Keep 30-season sizing realistic**: sizing for ≥150 simultaneous requests
   requires the quota fix first; below ~100 concurrent requests the host showed
   no sign of strain.
5. **Add a dedicated test account or staging install** so the authenticated
   student journey can be measured with `SESSION_MODE=pool`, and re-run this
   ladder before/after any change.

## 8. Reproduce exactly

```bash
# dry run, no traffic
BASE_URL=https://api.medacademy.site LOADTEST_APPROVED=1 SESSION_MODE=none \
  node scripts/loadtest/run-stages.cjs --plan --approve-live

# one rung (repeat per rung, lowest first, stop at the first unhealthy one)
BASE_URL=https://api.medacademy.site LOADTEST_APPROVED=1 SESSION_MODE=none \
  THINK_TIME_MS=1500 MAX_VUS=50 \
  node scripts/loadtest/run-stages.cjs --approve-live --stages=50 \
    --stage-ramp=15 --stage-hold=30 --results=scripts/loadtest/results/live-<label>
```

Raw artifacts (git-ignored): `scripts/loadtest/results/live-{smoke,a,b,c,d}/` and
the consolidated `scripts/loadtest/results/live-2026-10-27/`
(`report.md`, `report.json`, `stages.csv`, `timeseries.csv`).

## 9. Known reporting gap

The per-endpoint table shows `requests: n/a` for the endpoints that *were*
called. The k6 release in use does not export a `count` for `Trend` metrics, and
the scenario records per-endpoint timings as trends. The counts reconcile
exactly from the measured iteration count instead: with `SESSION_MODE=none`
every iteration issues one call to each of the four public endpoints
(200-VU stage: 3,292 iterations × 4 = 13,168 requests = the measured total).

## 9a. Follow-up: the database-connection finding (2026-10-27)

The 1226 errors recorded in §5–§6 are the trigger for a separate, code-level
investigation: `scripts/loadtest/DATABASE_CONNECTION_AUDIT.md`. That report establishes
that there is no connection leak (one lazily-created, non-persistent `PDO` per request),
identifies the real mechanism — each request held its only connection slot for the whole
request, including database-free phases such as the PDF render, the upload hash and the
file streaming — and adds `Database::release()` plus an honest failure surface
(503 `database_busy` + `Retry-After`, logged distinctly, no in-request retry).

Status of that work, stated plainly:

* verified **locally** (19/19 lifecycle checks, including an end-to-end saturated-quota
  test that asserts 503 + `database_busy` + `Retry-After` and that no 200 is faked);
* **not deployed**, so the numbers in this file still describe the pre-fix code — no test
  in this document may be read as evidence for the fix;
* a conservative anonymous re-check (2 → 10 → 25 VUs, 0 % errors) is recorded in
  `scripts/loadtest/README.md`; it confirms the host is healthy in that range but says
  nothing about the fix.

Nothing in this file's measurements has been rewritten, and no additional production
load test was run beyond those three short rungs.

## 10. Production impact

* No production file, database record, schema, PHP setting or cron job was
  changed. No file was uploaded.
* No account was used to sign in, so no session was created or revoked; no
  student data was read (the four endpoints are public).
* The only writes were the load itself and the 30 `Database connection failed`
  error lines it produced in `storage/logs/app.log`.
* The ladder is bounded (each rung ≤ 85 s) with automatic abort thresholds, and
  was driven only after the smoke rung was green.
