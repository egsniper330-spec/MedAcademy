# MedAcademy load testing (k6)

Bounded, read-only load tests for the MedAcademy PHP API. This directory is
developer tooling: **nothing here ships in the app or is required at runtime**,
and no k6 package is added to `package.json`.

- `smoke.js` — 1 virtual user, 5 iterations. Proves the toolchain and the
  credentials work. Run this first, every time.
- `student-journey.js` — the real student flow (app open → session → dashboard →
  course → lessons → settings), ramped and bounded.
- `seed-local.php` — creates the `loadtest.*` fixtures the journey needs.
- `lib/config.js` — shared env parsing, bounded stages, thresholds.

## 1. Install k6 (Windows, no admin)

Any one of these is fine; the suite only needs `k6` on `PATH` (or `K6_BIN`).

```bash
# Option A — official standalone binary (used for this audit, no admin needed)
curl -L -o k6.zip https://github.com/grafana/k6/releases/download/v2.3.0/k6-v2.3.0-windows-amd64.zip
unzip k6.zip && ./k6-v2.3.0-windows-amd64/k6.exe version

# Option B — winget (may prompt for elevation)
winget install --id Grafana.k6 -e

# Option C — Chocolatey / Scoop, if you already use them
choco install k6 -y
scoop install k6
```

Verify: `k6 version` → `k6.exe v2.3.0 (...)`.

## 2. Start a local stack (PHP + MariaDB/MySQL)

PHP's built-in server is for development: it runs **one request at a time**, so
its throughput is a floor, not a capacity estimate (see the audit report).

```bash
# MariaDB/MySQL: create an empty database and import the schema
mysql -u root -p -e "CREATE DATABASE medacademy_loadtest CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -p medacademy_loadtest < backend/database/schema.sql

# backend/.env (git-ignored) — local values only
APP_ENV=local
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=medacademy_loadtest
DB_USER=...
DB_PASS=...
JWT_SECRET=<any long random string>
RATE_LIMIT_LOGIN_PER_MINUTE=10

# Seed the fixtures (refuses to run when APP_ENV=production)
php scripts/loadtest/seed-local.php --password='<a test password>'

# Serve the API
php -S 127.0.0.1:8090 -t backend/public backend/public/index.php
```

Sanity check before loading: `curl -s http://127.0.0.1:8090/api/health`

## 3. Run the tests

```bash
export BASE_URL=http://127.0.0.1:8090
export LOADTEST_STUDENT_EMAIL=loadtest.student@example.invalid
export LOADTEST_STUDENT_PASSWORD='<the password from step 2>'

# a) smoke — must be 100% green before anything else
k6 run scripts/loadtest/smoke.js

# b) bounded journey: 5 VUs, 10s ramp / 30s hold / 5s down = 45s total
MAX_VUS=5 RAMP_SECONDS=10 HOLD_SECONDS=30 RAMP_DOWN_SECONDS=5 \
  k6 run scripts/loadtest/student-journey.js

# c) escalate only after (b) is green
MAX_VUS=20 P95_MS=6000 P99_MS=12000 k6 run scripts/loadtest/student-journey.js
```

### The PDF worker path is audited separately

The personalized lesson-PDF pipeline (queue, priority, cron worker, waiting UX) has its own
report and its own PHP suites — it is **not** driven by this k6 suite, because PDF generation
would enqueue real work and video delivery comes from the provider's CDN:

* report: `scripts/loadtest/PDF_WORKER_PERFORMANCE_AUDIT.md`
* `php backend/tests/material-queue/pdf_worker_performance_tests.php` (per-size render, budget
  stop, lock overlap, reuse, isolation)
* `php backend/tests/material-queue/pdf_queue_concurrency_tests.php` (1/5/10/20/50 simultaneous
  student requests, drained with the shipped cron shape)

### Live, account-free probe (`SESSION_MODE=none`)

When the target is a **live** host that has no dedicated test account, the same
ladder can measure it without touching anybody's session: `none` skips the login
and the authenticated fixture lookup, so every iteration is the four public boot
calls (`/api/health`, `/app/version`, `/maintenance`, `/support/contact`). It
measures PHP + DB request handling — **not** a signed-in student journey, and the
report says so. Never point this at a real student's account: producing 200 VUs
from one person's session would hammer production under their identity.

```bash
BASE_URL=https://api.medacademy.site LOADTEST_APPROVED=1 SESSION_MODE=none \
THINK_TIME_MS=1500 MAX_VUS=50 \
  node scripts/loadtest/run-stages.cjs --approve-live --stages=50 \
    --stage-ramp=15 --stage-hold=30 --results=scripts/loadtest/results/live-<label>
```

Measured on the live Spaceship host (2026-10-27): 10→200 VUs, every rung reached
its target, p95 286 ms at 100 VUs and 797 ms at 200 VUs, and the first 5xx
appeared at 150 VUs — SQLSTATE 1226, the DB user's `max_user_connections = 50`
quota (the server allows 500). Full results: `docs/LIVE_HOST_CAPACITY_TEST.md`.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `BASE_URL` | — (required) | API root, no trailing slash |
| `SESSION_MODE` | `pool` | `pool` (one pre-issued token per VU) · `login` (each VU logs in) · `none` (account-free: public boot calls only) · `shared` (baseline only, one session for everybody) |
| `LOADTEST_STUDENT_EMAIL` / `_PASSWORD` | — (required) | dedicated test account (`pool`/`login`) |
| `MAX_VUS` | 200 | peak virtual users (**hard ceiling 200** in `lib/plan.mjs`) |
| `RAMP_SECONDS` / `HOLD_SECONDS` / `RAMP_DOWN_SECONDS` | 30 / 60 / 15 | the run is exactly these three |
| `THINK_TIME_MS` | 500 | pause per iteration (models a human reading a screen) |
| `P95_MS` / `P99_MS` | 2000 / 4000 | latency thresholds |
| `MAX_ERROR_RATE` | 0.01 | `http_req_failed` threshold |
| `LOGIN_EACH_ITERATION` | 0 | `1` adds a login per iteration (see the rate-limit note) |
| `LOADTEST_PDF_MATERIAL_ID` | — | enables the **pdf-availability** workload (`GET /materials/pdf-status`); needs a session |
| `LOADTEST_VIDEO_LESSON_ID` | — | enables the **video-metadata** workload (`GET /rpc/lesson-video-state`); needs a session |
| `MAX_SERVER_ERROR_RATE` / `MAX_TIMEOUT_RATE` | 0.005 / 0.005 | stop lines for 5xx+508 and for timeouts/connection failures |

### One report, five workload classes

The runner reports **anonymous public traffic**, **authenticated student reads**,
**PDF availability**, **PDF generation**, **video metadata** and **video
delivery** as separate rows, because they cost the host different things and a
single merged "N users" number is true for none of them.

| workload | how it is exercised | measured? |
|---|---|---|
| `anon-boot` | `/api/health`, `/app/version`, `/maintenance`, `/support/contact` | always |
| `auth-read` | `/auth/me`, `/courses`, `/notifications`, `/credits/me`, … | needs a session (`pool`/`login`) |
| `pdf-availability` | `GET /materials/pdf-status?material_id=…` (read-only, queues nothing) | needs `LOADTEST_PDF_MATERIAL_ID` |
| `pdf-generation` | the watermark worker rendering copies | **no** — staging only: it would enqueue real jobs |
| `video-metadata` | `GET /rpc/lesson-video-state?lesson_id=…` (DB only) | needs `LOADTEST_VIDEO_LESSON_ID` |
| `video-delivery` | bytes from the VdoCipher CDN | **no** — that is the provider's CDN, not this host |

The report prints a `**no**` and the missing precondition for any class that was
not exercised, and refuses to let another row's number stand in for it. Never
quote `anon-boot` numbers as student capacity.

### Stopping a run

- It stops **by itself** after `RAMP_SECONDS + HOLD_SECONDS + RAMP_DOWN_SECONDS`.
  There is no unbounded executor in this suite on purpose.
- `Ctrl+C` stops immediately and still prints the summary.
- For a hard cap independent of the script: `k6 run --duration 60s ...`
  or `k6 run --max-duration 120s ...`.

## 3a. The staged ladder (10 → 25 → 50 → 100 → 150 → 200)

`run-stages.cjs` runs each rung as a **separate k6 process** and stops at the
first rung that breaches a stop condition, so a poisoned stage cannot leak
state into the next one.

```bash
BASE_URL=http://127.0.0.1:8090 LOADTEST_APPROVED=1 \
  SESSION_MODE=pool LOADTEST_TOKEN_POOL_FILE=scripts/loadtest/.tokens.json \
  MAX_VUS=200 HOLD_SECONDS=60 RAMP_SECONDS=30 RAMP_DOWN_SECONDS=15 \
  node scripts/loadtest/run-stages.cjs --results=scripts/loadtest/results/ladder
```

Outputs `report.md`, `report.json`, `stages.csv` and `timeseries.csv`. The report
states **configured target vs achieved VUs** and never calls a passing rung a
capacity ceiling.

### Timeseries output is bounded — watch the disk

`--out json` writes **every sample**: a real 200-VU rung produced ~4 KB of
samples per request, filled a disk, and then k6 could not write its own summary
(the confusing symptom was `k6 did not complete a run (exit 0)`).

* a rung is killed once its `.ndjson` exceeds `LOADTEST_MAX_OUTPUT_MB` (default
  **512**) and reported as `timeseries_output_cap` — a generator limit, not a
  server result;
* if the disk is already full, k6's own error is now quoted with the fix;
* on a small disk run with `--ndjson=0`: aggregate metrics, percentiles and the
  per-endpoint table still work, only the trend column becomes `n/a`.

A full 10→200 ladder was executed locally against the stub API with
`--ndjson=0`: **200/200 VUs achieved, 0 % errors** — that validates the harness,
NOT the shared host's capacity.

## 4. Why login is not per-iteration

`POST /auth/login` is rate limited per IP (`RATE_LIMIT_LOGIN_PER_MINUTE`, 10 in
the shipped `.env.example`). Logging in on every iteration would measure the
limiter, not the application. The journey therefore logs in once in `setup()`
and shares the token — which is also what the app does (it reuses a refresh
token). Use `LOGIN_EACH_ITERATION=1` deliberately to test the limiter itself.

## 5. Rules for this suite

- Read-only by design. The journey calls no endpoint that enrolls, purchases,
  uploads, sends a notification or deletes anything.
- Never point `seed-local.php` at production: it refuses when `APP_ENV=production`.
- No credentials in the repository. Everything comes from the environment.
- **Do not run a substantial test against the live cPanel host.** Shared hosting
  is multi-tenant and the account has CloudLinux LVE limits (CPU, entry
  processes, memory); a heavy run degrades other sites on the node. If a live
  check is ever approved, keep it to the read-only health endpoint at low rate,
  watch the host's Resource Usage graph, and stop on the first 508 (entry-process
  limit), 503, or resource fault.

## 6. Reading the results

Report, at minimum: VUs, `http_reqs` rate (req/s), `http_req_duration`
p50/p95/p99, `http_req_failed`, total duration, and the environment. Keep
"virtual users", "concurrent API requests" and "concurrent video viewers"
separate — video is served by the provider's CDN, so a video viewer does not
consume a PHP worker.

Per-endpoint numbers: `k6 run --out json=out.json ...` and aggregate the
`http_req_duration` points by `tags.name`.

## Host capacity probe (`audit-host.js`)

Read-only, bounded probe for the **live** host: one static request (`/`) and one
PHP+DB request (`/api/health`) per iteration, so the difference isolates
application time from network time.

```bash
K6_BIN=.freebuff/tools/k6/k6.exe
BASE_URL=https://api.medacademy.site VUS=20 HOLD=20s RAMP=5s \
  $K6_BIN run scripts/loadtest/audit-host.js
```

* Hard ceiling **100 VUs**; abort on >2 % failures, any 5xx/508, or p95 > 8 s.
* Writes `.freebuff/loadtest-results/host-vus<N>.json` (git-ignored).
* **Read the RTT caveat first.** If the machine running k6 has a slow link (the
  audit's workstation measured ~1.45 s RTT), throughput is capped by
  `VUs / (RTT + think)` and says nothing about the server's ceiling. Use a
  datacenter generator (e.g. Grafana Cloud k6 free tier) for the real numbers.
* Results and interpretation: `docs/PRE_LAUNCH_INFRASTRUCTURE_AUDIT.md` §5–§6.

## Remote generation (Grafana Cloud k6) — PENDING, not run

The local audit showed the workstation's ~1.45 s RTT caps throughput at
`VUs / (RTT + think)`, so a local run cannot find the server's saturation point.
The remote run below has **not** been executed. Do not report a remote number
until the summary is pasted from Grafana.

1. Create a **free** Grafana Cloud account → *Performance testing* (k6) → note
   the project URL and create a **Project API token** (read/write for k6).
2. Install the CLI: `winget install --id Grafana.k6 -e` (or the official
   release zip). Verify `k6 version`.
3. `k6 cloud login --token <PROJECT_API_TOKEN>`
4. Seed a **staging/test** API with the `loadtest.*` fixtures
   (`php scripts/loadtest/seed-local.php`) and point `BASE_URL` at it. Never at
   `api.medacademy.site` for a load run.
5. Run, bounded, one level at a time (stop at the first failing level):

   ```bash
   PRIMARY_URL=<staging-base-url> \
   LOADTEST_STUDENT_EMAIL=loadtest.student@example.invalid \
   LOADTEST_STUDENT_PASSWORD='<test password>' \
   MAX_VUS=20 RAMP_SECONDS=30 HOLD_SECONDS=60 RAMP_DOWN_SECONDS=15 \
   k6 cloud run scripts/loadtest/student-journey.js
   ```

6. Record from the Grafana summary: VUs, `http_reqs`/s, p50/p95/p99,
   `http_req_failed`, duration. Repeat with `MAX_VUS=50` only if p95 < 1.5 s and
   the error rate is < 1 % at 20. The suite's own ceiling is 50.
7. Do **not** send any traffic to VdoCipher or other providers. Playback and
   media are out of scope.

If no remote generator is available, the repository work is complete and this
procedure remains the only missing measurement — label it "remote test pending".

## Measured results — 2026-10-27 (this workstation, not a datacenter generator)

### Live host (production, read-only: `GET /` + `GET …/api/health` only)

`audit-host.js`, 15 s hold, abort thresholds active. `static` and `php` are the
two TTFBs; the difference is the application's share of the response.

| VUs | req/s | static p50/p95 (ms) | php p50/p95 (ms) | php − static (p50) | failures |
|---|---|---|---|---|---|
| 1 | 1.5 | 317 / 327 | 303 / 307 | −14 | 0 |
| 3 | 4.8 | 288 / 323 | 283 / 318 | −5 | 0 |
| 5 | 8.4 | 214 / 294 | 217 / 307 | +4 | 0 |
| 10 | 16.1 | 243 / 317 | 244 / 308 | 0 | 0 |
| 10 (THINK=0) | 30.4 | 284 / 309 | 286 / 310 | +2 | 0 |

**Reading:** throughput rises linearly with VUs and latency does not move; the
~250–300 ms floor is present on a **static** file too, so it is network/TLS path,
not PHP. Almost none of a response's time is application time at these rates.
**The host was not saturated and no ceiling was established** — each VU is
one-request-at-a-time, so 10 VUs cannot exceed `10 / RTT ≈ 33 req/s` regardless
of the server. Finding the ceiling needs a low-RTT datacenter generator (§7).

### Local stack (PHP built-in server + MariaDB 11.4, `student-journey.js`)

The built-in server handles **one request at a time**, so this measures the
application cost per request, not capacity.

| VUs | req/s | avg / p95 (ms) | failures |
|---|---|---|---|
| 5 | 45.2 | 34.8 / 65.5 | 0 |
| 10 | 51.0 | 102.3 / 158.2 | 0 |
| 20 | 54.9 | 242.8 / 338.3 | 0 |

Throughput plateaus at ~51–55 req/s while latency grows linearly ⇒ the ceiling is
the single PHP process (`1 / ~19 ms`), not the application logic. Per-request
application cost ≈ **19–20 ms** across a 9-endpoint journey, all checks green.

### Live host, post-audit conservative re-check (2026-10-27, anonymous only)

`SESSION_MODE=none`, `THINK_TIME_MS=1500`, shape 15 s ramp / 30 s hold / 10 s down per
rung, thresholds fixed before the run (error > 1 %, 5xx/508 > 0.5 %, timeouts > 0.5 %,
p95 > 2000 ms, p99 > 4000 ms). Results: `results/live-audit/`.

| VUs (target/achieved) | requests | req/s | p50 / p95 / p99 | errors | timeouts | result |
|---|---|---|---|---|---|---|
| 2 / 2 | 172 | 2.23 | 282 / 350 / 392 ms | 0 % | 0 | PASS |
| 10 / 10 | 792 | 10.30 | 279 / 374 / 1196 ms | 0 % | 0 | PASS |
| 25 / 25 | 1,976 | 25.82 | 274 / 364 / 1228 ms | 0 % | 0 | PASS |

These rungs measure **anonymous public boot traffic against the currently deployed
backend**; the p50 floor (~275 ms) also appears on static content, so it is this
workstation's network path, not application time. Rungs above 50 VUs were not run here:
the 150/200-VU behaviour (and the DB connection-quota errors it produced) is documented in
`docs/LIVE_HOST_CAPACITY_TEST.md`, and the connection-lifecycle audit that addresses it is
`scripts/loadtest/DATABASE_CONNECTION_AUDIT.md`.

### Queue worker cost (local, real PDF)

One 4-page source (6.8 KB) → personalized copy 132 KB, rendered by
`watermark-worker.php --limit=5 --max-seconds=50` in **0.24 s** (job `ready`,
`attempts` 0, no lock left). Copies are ~19× the source by size because the
vector engine embeds fonts.
