# Personalized-PDF pre-generation queue (hybrid watermarking)

**Status:** implemented in the repository. **Not deployed.** Migration `038` is
**not applied** and **no cron entry exists** yet.

This document describes how a personalized (watermarked) student PDF is produced
now that generation has moved out of the request path, and what the host needs.

---

## 1. Why it changed

Before, `POST /materials/pdf-url` rendered the copy **inside the request**. On
shared cPanel hosting that meant:

* the first student to open a large PDF held one PHP-FPM worker for the whole
  render (FPDI + TCPDF, tens of seconds on a 20 MB, 300-page document);
* ten students opening the same document at once held ten workers, and the
  pool — shared with every other request on the account — was exhausted;
* the same document could be rendered N times by N concurrent requests, throttled
  only by a per-variant `flock`.

The queue keeps the exact same watermarking engine and cache identity, and moves
*when* the work happens.

---

## 2. The flow

```
doctor uploads a PDF
  POST /storage/upload            → object stored privately
  POST /api/lesson_materials      → DataController verifies the stored bytes
                                    (size + PDF structure) and commits the row
                                    ↓
                          MaterialPdfQueueService::enqueueMaterial()
                          one row per ELIGIBLE enrolled student in
                          lesson_material_pdf_jobs (priority 10)
                          → the upload request returns immediately

cron: watermark-worker.php (bounded batch)
  claim 5 jobs (atomic, priority order)
    → re-check material/lesson/course publication, permission, enrollment,
      profile status (the SAME rules delivery enforces)
    → re-derive the variant key from the LIVE source
    → render to <variant>.pdf.<rand>.part
    → validate header + %%EOF + size
    → atomic rename into place
    → insert/update lesson_material_pdfs
    → mark the job ready

student opens the PDF
  POST /materials/pdf-url
    ready copy     → mint a 300 s token URL, status: "ready"
    missing copy   → enqueue/boost THIS student's job (priority 0),
                     status: "preparing", retry_after: n   (no render here)
  GET /materials/pdf-status?material_id=…   (poll, no token, no render)
  GET /materials/pdf?token=…                (re-authorises, streams privately)

doctor/admin opens a PDF
  Same endpoint. Staff get a single inline render for their own preview copy —
  bounded by construction (one document), and the student copies were already
  queued in the background.
```

Nothing in the client can ask for the unwatermarked original: `/materials/pdf`
only ever streams a registry-owned personalized copy and fails closed with
`watermark_unavailable` if it is missing.

---

## 3. Database

### 3.1 Apply (later — owner action)

`backend/database/mysql-migrations/038_pdf_watermark_queue.sql`

* phpMyAdmin → select the MedAcademy database → **Import** → choose the file, or
  paste it into the SQL tab. Run it **once**.
* It is additive: one new table, `lesson_material_pdf_jobs`. No existing column,
  row, index or constraint is touched.
* Re-running is harmless (`CREATE TABLE IF NOT EXISTS`).
* Verify by looking at the table list / Structure tab. Do **not** query
  `information_schema` — the cPanel MySQL user often has no grant on it.

### 3.2 Roll back

`backend/database/mysql-migrations/038_pdf_watermark_queue_down.sql` drops the
queue table only. Generated copies in `lesson_material_pdfs` and their files stay
deliverable; the next request simply renders inline again. Remove the cron entry
at the same time.

### 3.3 What the table holds

| Column | Purpose |
| --- | --- |
| `material_id`, `student_id` | who/what the copy is for |
| `source_hash`, `variant_key` | the EXACT cache identity; a replaced source or changed engine settings produce a new job |
| `status` | `queued` / `processing` / `ready` / `failed` / `skipped` |
| `priority` | `0` = a student is waiting, `10` = upload pre-generation |
| `attempts`, `max_attempts` | bounded retries (default 4) |
| `lock_token`, `locked_at`, `locked_by` | atomic claim; only the holder can complete/fail. `locked_at` is **kept on a finished row** so `ready_at - locked_at` measures the render (that measurement feeds the wait estimate); `lock_token`/`locked_by` are cleared, and every claim/stale path additionally requires `status = 'processing'` |
| `run_after` | retry backoff gate |
| `last_error` | machine-readable stage, never a path/name/content |

`UNIQUE (material_id, student_id, variant_key)` is the duplicate guard: concurrent
uploads/requests cannot create two jobs for the same copy.

---

## 4. Cron (NOT configured)

Two entries in cPanel → **Cron Jobs**. Nothing in this change creates them.

```
# every minute — bounded batch (5 renders, 50 s wall clock).
# The LIVE cron currently runs every FIVE minutes; if you change the cadence,
# set MATERIAL_PDF_WORKER_INTERVAL_SECONDS to the new interval in the same change
# (60 for this one) so the waiting-time estimate stays truthful.
* * * * * /usr/local/bin/php /home/USERNAME/medacademy-api/scripts/watermark-worker.php --limit=5 --max-seconds=50 >> /home/USERNAME/medacademy-api/storage/logs/watermark-worker.log 2>&1

# nightly 03:15 — 24-hour retention (replace --apply with nothing for a dry run first)
15 3 * * * /usr/local/bin/php /home/USERNAME/medacademy-api/scripts/watermark-worker.php --limit=0 --retention --apply >> /home/USERNAME/medacademy-api/storage/logs/watermark-retention.log 2>&1
```

Adjust the PHP binary (`which php`) and the absolute path — cPanel cron does not
inherit the shell's `PATH` or working directory.

Safe first run (no writes):

```
php scripts/watermark-worker.php --limit=3 --pretty
php scripts/watermark-worker.php --limit=0 --retention --pretty      # dry run
```

Flags: `--limit=N` (0–100), `--max-seconds=N` (5–600), `--stale=N` (lock
reclaim, default 900), `--prewarm-reserved=N` (aging slots, see §6.3),
`--retention`, `--retention-days=N`, `--apply`, `--status`, `--pretty`.

### 4.1 The cadence is configuration the estimate depends on

The waiting-time estimate (§6.2) is computed from the deployed schedule, so the
schedule has to be stated to the application:

| Setting | Default | Must match |
| --- | --- | --- |
| `MATERIAL_PDF_WORKER_INTERVAL_SECONDS` | `300` | the Cron interval. **Change it to `60` when the cron moves to every minute** |
| `MATERIAL_PDF_WORKER_JOBS_PER_RUN` | `5` | `--limit` in the Cron command |
| `MATERIAL_PDF_PREWARM_STARVATION_SECONDS` | `900` | when background work earns a reserved slot |
| `MATERIAL_PDF_PREWARM_RESERVED_CLAIMS` | `1` | slots per run the worker may give to aged background work; `0` disables aging |

Leaving `MATERIAL_PDF_WORKER_INTERVAL_SECONDS` at `300` after shortening the cron
only makes the estimate more pessimistic (it never promises a wait the schedule
cannot keep). Leaving it at `60` after *lengthening* the cron would under-state
the wait — hence the rule: change them together.

### Verifying the deployment (verified on a local MariaDB, 2026-10-27)

`--status` is read-only (no claims, no writes) and is safe to run while cron is
active. **It is also the quickest way to confirm migration 038 is applied**: it
exits `1` with `queue schema NOT ready (apply migration 038)` when the table is
missing, and `0` with the counters when it is present.

```
php backend/scripts/watermark-worker.php --status --pretty
```

```
schema_ok             : true
due_now               : 0
oldest_failed_reason  : NULL
queued                : 0
processing            : 0
failed                : 0
oldest_queued_at      : NULL
copies                : 0
copy_bytes            : 0
retention_days        : 90
```

Failure detection without extra tooling:

| Symptom | What it means | Action |
|---|---|---|
| `queued` grows while `due_now` stays 0 and `processing` is 0 | no worker is running (cron missing/disabled) | check the cPanel cron entry and the log file |
| `processing` sticks at a non-zero value for > 15 min | a worker died mid-render | the next successful run reclaims the lock (`--stale=900`); run `--limit=5` by hand |
| `failed` grows, `oldest_failed_reason` names a stage | a source PDF or the engine is broken | fix the source/engine, students see `failed` + a Retry button |
| `--status` exits 1 | table missing | apply migration 038 |

The cron log should contain exactly one JSON line per run
(`{"worker":"cron-…","claimed":N,"ready":N,…}`). A run that stops appearing is
the earliest signal that cron is not firing.

**Schedule rationale.** One minute is frequent enough that a pre-generated copy
is usually ready before a student asks, and cheap because an empty queue costs
one indexed `SELECT`. Each run stops on its own budget, so a slow render cannot
pile up processes on the shared host. The worker is safe to run twice at once:
claims are atomic.

---

## 5. Retention: 24 hours, and what it costs

`lesson_material_pdfs.created_at` is the retention clock (fixed from
generation). Downloads do not reset it; a copy older than 24 hours is deleted
by the sweep (the next request regenerates it — this is a cache, never the
original).

Safety rules enforced by the sweep:

* rows with an active (`queued`/`processing`) job for the same
  material+student are skipped;
* only files inside `lesson-material-pdfs/{course}/{material}/{student}/` are
  removable, and only after their own registry row is deleted;
* original uploads in `lesson-materials` are never touched;
* dry run unless `--apply`.

**Storage implications.** A personalized copy is roughly the size of its source
(a layered watermark does not re-encode the document in vector mode; raster mode
is larger). So the steady-state ceiling is:

```
copies_on_disk ≈ active_students × materials_opened_in_24h × avg_pdf_size
```

For example 500 students × 10 documents × 2 MB ≈ **10 GB**. Check the real
number before launch:

```sql
SELECT COUNT(*) AS copies, ROUND(SUM(file_size)/1073741824, 2) AS gb
  FROM lesson_material_pdfs;
```

Queue counters come from the worker's `--status` flag, shown above. They are
**not** exposed over HTTP: no controller calls `MaterialPdfQueueService::health()`
in this repository (an earlier version of this document claimed an admin status
endpoint carried them — it does not; the SSH/cPanel command is the supported
way).

**Shared-hosting constraints.**

* Disk quota is per account and shared with videos/backups. If the quota is
  tight, lower the retention window (`--retention-days=45`) *deliberately* — the
  default is 90 and it is not shortened silently.
* Inode limits matter more than bytes on cPanel: one inode per copy. Keep the
  nightly sweep enabled.
* Generation CPU is bounded by `--max-seconds` and `PDF_WATERMARK_*` limits, but
  it still competes with request workers. Run the batch at a quiet hour if the
  host is busy, or lower `--limit`.
* There is no Redis/daemon requirement. If MySQL is unavailable the worker exits
  non-zero and cron mails the owner; nothing is lost because the jobs are rows.

---

## 6. Client contract

`POST /materials/pdf-url` → `{ material_id, intent, retry? }`

```json
{ "status": "ready",     "url": "…", "expires_at": "…", "watermarked": true }
{ "status": "preparing", "url": null, "retry_after": 15, "retry_allowed": false }
{ "status": "failed",    "url": null, "reason": "engine_unavailable", "retry_allowed": true }
```

`GET /materials/pdf-status?material_id=…` returns the same `status` plus
`attempts`/`max_attempts`/`retry_after`, without minting a token.

### 6.1 States, and the wait contract

`status` keeps the three-value contract older clients rely on (`ready` |
`preparing` | `failed`). `state` is the precise one:

| `state` | Meaning | App behaviour |
| --- | --- | --- |
| `queued` | a job exists and is due, waiting for the next worker tick | keep waiting, show the estimate |
| `generating` | a worker is rendering this copy now | keep waiting, show the estimate |
| `ready` | the copy exists and is valid right now | mint and download |
| `failed` | attempts exhausted; `retry_allowed: true` | show the failure and one explicit Retry |
| `unavailable` | the queue could not be read (e.g. migration 038 missing) | pending, never ``ready`` |

Both PDF endpoints also carry the waiting fields, so the client never has to
guess:

```json
{
  "status": "preparing", "state": "queued",
  "queue_position": 3, "jobs_ahead": 2, "processing_now": 1,
  "eta_seconds": 315, "eta_min_seconds": 15, "eta_max_seconds": 315,
  "eta_basis": "measured_render_median", "eta_samples": 12,
  "retry_after": 5, "retry_allowed": false
}
```

### 6.2 How the estimate is computed (and when it refuses to guess)

* **`queue_position` / `jobs_ahead`** — the row's real rank in the worker's own
  claim order, counted over jobs that are **due now**. A job inside retry backoff
  blocks nobody, so it is not counted. A prewarm job's rank is by **age**,
  because the aging reservation serves the oldest one first.
* **`eta_*`** — from `MATERIAL_PDF_WORKER_INTERVAL_SECONDS`,
  `MATERIAL_PDF_WORKER_JOBS_PER_RUN`, the job's own `run_after`, and the
  **median** of recent successful render durations (`ready_at - locked_at`, last
  7 days, up to 50 samples):
  `runs = ceil(rank / slots)`, `eta_min = notBefore + (runs-1)·interval + render`,
  `eta_max = notBefore + runs·interval + render`. `eta_seconds` is the
  conservative upper bound; the range exists because the next tick may be
  imminent or a whole interval away.
  * interactive copies: `slots = jobsPerRun − reservedPrewarmClaims`
  * prewarm copies: `slots = reservedPrewarmClaims` (the reservation is the only
    guaranteed progress background work gets)
* **`eta_basis`** — `measured_render_median`, or `insufficient_samples` when
  fewer than 3 renders have been measured, `already_ready`, `unknown`,
  `queue_unavailable`, `estimate_failed`. **With no measurement every `eta_*`
  field is `null`**: the app then shows the transparent fallback
  (“الوقت المتوقع غير متاح حاليًا، وسنحدّث الحالة تلقائيًا.”) rather than an
  invented number.
* `retry_after` is a **polling interval**, never an ETA.
* Only counts are exposed. No other student, document or path is ever named.

### 6.3 Aging: background pre-generation cannot be deferred forever

`claim()` orders strictly `priority ASC` — correct for waiting students, but it
meant that while student requests kept arriving, upload pre-generation waited
indefinitely (measured: see `scripts/loadtest/PDF_WORKER_PERFORMANCE_AUDIT.md`
§7 C5). The fix is bounded rather than a priority inversion:

* only `priority >= 10` (prewarm) rows are eligible — a waiting student (0)
  **always** outranks them, so interactive work is never starved;
* only a row already older than `MATERIAL_PDF_PREWARM_STARVATION_SECONDS`;
* the **oldest** such row is taken first, so no single background job can be left
  permanently behind newer ones;
* at most `MATERIAL_PDF_PREWARM_RESERVED_CLAIMS` **per worker run**, claimed
  *before* the interactive batch, so the slot is never lost to the run's budget.
  With `--limit=5` that is at most one of five renders, and only after 15 min.

The claim itself is unchanged and still atomic
(`WHERE status = 'queued'` + lock token), so a second worker cannot double-claim.

### 6.4 The app's polling lifecycle

The app (`src/app/(app)/lesson/[id].tsx`, rules in `src/lib/pdfPreparation.ts`)
acknowledges immediately, then polls `pdf-status` with exponential backoff
bounded by the ACTUAL worker schedule: floor 5 s, cap 20 s, and a hard 15-minute
budget — three cron ticks at the shipped five-minute cadence. It stops on
`ready` (and downloads automatically), on a terminal `failed` (offering one
explicit `retry: true`), on dismissal, or at the deadline — where it shows the
“still queued” state with a *Check again* action instead of a false failure.
During `queued`/`generating` it shows the localized queue copy, the estimate
range when the server provides one, and the queue position when it is meaningful
(≥ 2). Dismissing the modal cancels the poll loop.

Rate limits (per account): `MATERIAL_PDF_MINT_PER_MINUTE` (60),
`MATERIAL_PDF_STATUS_PER_MINUTE` (120).

---

## 7. Failure stages

The worker records the stage from `ApiException` codes raised by
`PdfWatermarkService`: `engine_unavailable`, `pdf_parse`, `render_failed`,
`output_missing`, `publish_failed`, `source_not_pdf`, `source_too_large`,
`storage_unwritable`, `schema`. The worker adds `material_missing`,
`not_eligible`, `stale_variant`, `stale_lock`, `unexpected`.

A job stops after 4 attempts (30 s → 60 s → 120 s backoff) and becomes `failed`;
the student sees the failure and can retry. A copy that failed for EVERY student
almost always means the engine is missing on the host — run
`scripts/watermark-diagnostics.php`.

---

## 8. What is NOT covered

* Preview (`is_preview`) lessons are open to any authenticated user, so their
  copies cannot be pre-generated for unknown identities; they are queued on
  demand. That is the only path with a first-open wait.
* The queue does not generate for suspended enrollments, unpublished
  lessons/courses, hidden/disabled materials, or suspended profiles — by design.
* Legacy `lesson-pdfs` (the old lecture-notes bucket) is still staff-only and is
  never personalized.
