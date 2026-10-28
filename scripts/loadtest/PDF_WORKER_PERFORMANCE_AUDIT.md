# PDF watermark worker — performance, queue priority and download-wait audit

**Date:** 2026-10-27 · **Scope:** the personalized lesson-PDF pipeline (upload → queue →
cron worker → delivery), measured locally on the real code against a real MariaDB.
**Companion reports:** `scripts/loadtest/DATABASE_CONNECTION_AUDIT.md` (connection lifecycle),
`docs/LIVE_HOST_CAPACITY_TEST.md` (live anonymous load test).

> **Nothing was deployed, no production record was created, no cron job was changed and no
> migration ran.** Everything below is local measurement plus code tracing. The live
> concurrency stages (1/5/10/20/50 students over HTTP) were **not run** — §9 states exactly
> what they need and asks for approval.

---

## 0. Executive summary

| Question | Answer | Evidence |
|---|---|---|
| Is the hybrid pre-generation + priority design actually implemented? | **Yes for pre-generation, priority ordering and reuse** — `enqueueMaterial()` fans out prewarm jobs on upload-adjacent paths, `prioritize()` inserts/raises a student job to priority 0, and `claim()` orders `priority ASC`. **No for fairness**: there is no aging, so a steady stream of student requests defers prewarm indefinitely (measured: §7 C5). | §2, §7 |
| How long does one personalized copy take? | **0.14 s** (1-page 120 KB) → **1.17 s** (62-page 11.4 MB), median of 3 isolated renders; ≈0.019–0.04 s/page; peak memory 74 MB. | §5 |
| Does the shipped cron shape (`--limit=5 --max-seconds=50 --min-render-seconds=15`) fit? | **Yes, comfortably**: five 11 MB copies ≈ 6 s of rendering against a 35 s usable budget. The binding constraint is `--limit=5` — **5 copies per run**, i.e. ≈300/hour at a one-minute cron. | §6 |
| Queue latency for a class of students? | 5 students: p50 3.1 s / 2.8 s. 50 students: p50 41.4 s / 41.6 s, p95 66.5 s / 72.2 s, drained in 10 worker runs (68.5 s / 75.0 s) — **at most 5 copies per tick** is what creates the queue. Two verified runs; the spread is workstation, not queue (§11). | §7 |
| Does the lock/recovery story hold? | **Yes**: two simultaneous launches → exactly one claims, the loser reports `worker_locked` and touches nothing; a fatal releases the held job; a backdated lock is requeued by `recoverStale`. | §8 |
| Is the student waiting experience adequate? | **Partly.** Immediate acknowledgment, automatic polling and auto-download on ready are implemented; an **accurate or any estimated wait time is NOT** — and with a five-minute cron the client's ~82 s poll budget can expire while the copy is still queued, showing the student a failure for a document that will be ready. | §10 |
| Can N students download personalized PDFs concurrently? | **Unproven beyond the queue.** This report measures the queue/worker on one machine. A host-capacity claim needs the staged HTTP test in §9. | §9 |

---

## 1. What was inspected

Read in full or traced: `backend/src/Services/MaterialPdfQueueService.php` (claims, priority,
retry, backoff, stale recovery, retention), `backend/src/Services/MaterialPdfVariantService.php`
(identity, reuse, atomic publish, registry), `backend/src/Services/PdfWatermarkService.php`
(engine selection, `personalize()`), `backend/scripts/watermark-worker.php` (lock, budget,
one-job-at-a-time loop, shutdown handler), `backend/src/Services/WorkerLock.php`,
`backend/src/Controllers/MaterialDeliveryController.php` (`pdfUrl`, `pdfStatus`, `pendingResponse`,
`readyResponse`), `backend/routes/api.php`, `backend/database/mysql-migrations/032_*.sql` and
`038_*.sql`, `src/lib/api.ts` and `src/app/(app)/lesson/[id].tsx` (the waiting UI).

Measurement used the project's own stack: FPDF + FPDI + TCPDF from `backend/vendor`, a real
MariaDB, the real CLI worker as a subprocess, and real (disposable) students.

---

## 2. Verified implementation status

| # | Behaviour | Status | Code |
|---|---|---|---|
| 1 | Automatic pre-generation after upload | **IMPLEMENTED** | `MaterialPdfQueueService::enqueueMaterial()` (`:192`) fans out to `eligibleStudents()` (`:160`) in 100-row chunks; `PRIORITY_PREWARM = 10` |
| 2 | Per-student personalized copy + reuse | **IMPLEMENTED** | `MaterialPdfVariantService::identity()` (`:80`) + `existing()` (`:299`) + `ensure()` (`:120`); registry `lesson_material_pdfs` UNIQUE (material, student, variant_key) |
| 3 | Priority for a student's own request | **IMPLEMENTED** | `prioritize()` (`:415`) → `enqueueStudent(..., PRIORITY_STUDENT = 0)`; `claim()` orders `priority ASC` (`:539`) |
| 4 | Correct queue ordering & safe claiming | **IMPLEMENTED** | claim is a conditional `UPDATE … WHERE status = 'queued'` per row, then read back by `lock_token` (`:549`–`:578`); no `SKIP LOCKED` needed |
| 5 | Immediate acknowledgment when not ready | **IMPLEMENTED** | `pendingResponse()` returns `{status:'preparing', retry_after, message}`; app sets a preparing state before the first poll (`lesson/[id].tsx:764`) |
| 6 | Accurate, server-grounded waiting estimate | **NOT IMPLEMENTED** | the API exposes `retry_after` only — a **polling interval** (10 s, 60 s when the schema is missing), never a queue position or an ETA |
| 7 | Queue status + estimate updates in the UI | **PARTIALLY IMPLEMENTED** | bounded poll of `GET /materials/pdf-status` (10 attempts, 1.2 s base, ×1.6, cap 8 s) — status updates work, no estimate is shown |
| 8 | Automatic transition when the copy becomes ready | **IMPLEMENTED** | `lesson/[id].tsx:779` mints the token and proceeds as soon as the status reads `ready` |
| 9 | Duplicate-job prevention & retry handling | **IMPLEMENTED** | UNIQUE key + `INSERT … ON DUPLICATE KEY UPDATE`; `markFailed()` backoff 30 s→30 min, `max_attempts = 4`; `retry()` only for the student's own failed job (explicit action) |
| 10 | Worker scheduling & overlap protection | **IMPLEMENTED** | `WorkerLock` (`flock(LOCK_EX|LOCK_NB)`) acquired before any DB work; `--status` stays read-only; fatal-safe shutdown release; `recoverStale(900)` |
| 11 | Interactive cannot starve background | **NOT IMPLEMENTED** | strict `priority ASC` with no aging: prewarm is deferred while interactive jobs keep arriving (measured in §7 C5) |
| 12 | Ready copies reused without regeneration | **IMPLEMENTED** | worker short-circuits on `existing()` → `ready:cached` (§7 P5: file mtime unchanged) |

**Documented deviations from the "hybrid" intent:** (a) no ETA anywhere in the contract, (b) no
aging/promotion for prewarm jobs, (c) the client's poll budget (~82 s) is shorter than a
five-minute cron interval.

---

## 3. Test environment and workload

| | |
|---|---|
| Machine | developer workstation (Windows), `D:` volume at **>99 % full during part of the runs** — see §11 |
| PHP | 8.3 CLI, `memory_limit = 512M` (peak observed 74 MB) |
| Engine | vector — `setasign/FPDI 2.x + TCPDF 6.x (embedded DejaVu Sans)` |
| Database | MariaDB 11.4 local, `max_connections = 151`, schema with migrations 032/035/038 applied |
| Worker | the real `backend/scripts/watermark-worker.php`, its own process, `--stale=86400` during measurement so the sweep could not touch rows the suite does not own |
| Fixtures | synthetic "scanned handout" PDFs (raster pages + text line), generated by `make_size_fixtures.php`; nothing sensitive, nothing committed |
| Students | disposable `qtest-perf-*` / `qtest-conc-*` users with real enrollments, removed in `finally` blocks |

---

## 4. Source and output validation

| Size class | Source bytes | Pages | Copy bytes | Ratio | Page count preserved | Valid PDF |
|---|---|---|---|---|---|---|
| 100k | 122,013 | 1 | 230,563 | 1.89× | yes | yes |
| 1m | 1,221,197 | 7 | 1,364,647 | 1.12× | yes | yes |
| 5m | 5,620,375 | 31 | 5,904,133 | 1.05× | yes | yes |
| 10m | 11.2–11.4 M | 61–62 | 11.7–11.9 M | 1.04× | yes | yes |

* The **1.89×** on the smallest file is real and explained: the vector engine embeds a font into
  a document that previously had none; as raster pages dominate, the ratio collapses to ~1.0.
* Two students' copies **differ in bytes** at every size (different watermark lines, different
  variant key) — never shared bytes (`pdf_worker_performance_tests.php`, P2).
* The fixtures are raster-page PDFs, so a regenerated fixture is **not byte-identical** to the
  previous one: the 10 MB class came out at 11,396,255 B / 62 pages in the first generation and
  11,229,064 B / 61 pages in the re-verification run. Byte figures for that class are therefore
  given as the measured range, and every figure is a **measured** byte count, not a nominal size.
* Every copy is written to `.part` and **atomically renamed** after validation
  (`MaterialPdfVariantService:181-203`), and registered to the requesting student only — verified
  by registry row and by path (`…/<course>/<material>/<student>/<variant>.pdf`).

---

## 5. Render cost per size (isolated, median of 3)

`.freebuff/tools/render-bench.php` calls `PdfWatermarkService::personalize()` directly, so these are
production-cost numbers without queue or worker overhead:

| Size | Pages | Median | min | max | Copy bytes | s/page |
|---|---|---|---|---|---|---|
| 100k | 1 | **0.14 s** | 0.12 | 0.15 | 230,701 | 0.1384 |
| 1m | 7 | **0.28 s** | 0.24 | 0.30 | 1,365,042 | 0.0400 |
| 5m | 31 | **0.66 s** | 0.63 | 0.72 | 5,906,363 | 0.0213 |
| 10m | 62 | **1.17 s** | 1.16 | 1.18 | 11,865,882 | 0.0188 |

Peak memory **74 MB**. The per-page cost falls with size because the fixed cost (engine load, one
font subset) dominates small documents; beyond ~10 pages the cost is roughly **0.019 s/page**.

This table is the in-process measurement on the first fixture generation (the 10 MB row is therefore
62 pages / 11.4 MB; see §4). The same suite's *end-to-end* line printed higher wall clocks on the
re-verification run (1.98 s / 2.81 s / 6.22 s / 4.43 s for 100 k→10 M, in that order) — a re-run in
the same order as the sizes is not monotonic, which is the signature of workstation contention rather
than engine cost (§11). The isolated medians above are the numbers to use for capacity arithmetic.

End-to-end through the worker (PHP boot + lock + claim + render + registry write) the same copies
took **0.42–4.66 s** of wall clock across three runs — that spread is the workstation, not the
queue (see §11); the in-process numbers above are the stable ones.

---

## 6. Are the shipped worker limits right?

`--limit=5 --max-seconds=50 --min-render-seconds=15` → the loop stops claiming once
`remaining < min-render-seconds`, i.e. a **35 s usable render budget** per run.

| Size | Render | 5 copies ≈ | Fits 35 s? | Binding constraint |
|---|---|---|---|---|
| 100k | 0.14 s | 0.7 s | yes | `--limit=5` |
| 1m | 0.28 s | 1.4 s | yes | `--limit=5` |
| 5m | 0.66 s | 3.3 s | yes | `--limit=5` |
| 10m | 1.17 s | 5.9 s (+ boot) | yes | `--limit=5` |

Measured budget behaviour (`pdf_worker_performance_tests.php` P6):

* **P6a** with `--max-seconds=5 --min-render-seconds=5` the worker claims **nothing**, reports
  `budget_stop`, and the deferred job stays `queued` — never stranded in `processing`;
* **P6b** with a budget sized for one render it completes exactly that job and finishes inside its
  own budget (2.86 s of a 9 s budget for the 62-page case).

**Conclusion:** the limits are not the constraint on this engine — the document sizes in the test
matrix are all `limit`-bound. Throughput ceiling = **`limit` copies per cron tick**; at
`--limit=5` and a one-minute cron that is ≤5/minute (~300/hour), so a 200-student class pre-generated
on upload needs ≈40 minutes of queue time. Raising `--limit` is a *host* decision (CPU/entry-process
limits), not something this audit can justify from a workstation measurement.

---

## 7. Queue concurrency, priority and fairness (measured)

`pdf_queue_concurrency_tests.php` — 1 MB / 7-page source, each request issued from a **separate
process**, drained with the shipped cron shape, one worker run at a time (as cron does):

| Students | Jobs created | Drain (run 1 → run 2) | Worker runs | Jobs/min (run 1 → run 2) | Queue wait p50 (run 1 → run 2) | p95 (run 1 → run 2) |
|---|---|---|---|---|---|---|
| 1 | 1 (exactly one per student) | 2.9 s → 1.1 s | 1 | 20 → 53 | 2.05 s → 0.27 s | 2.05 s → 0.27 s |
| 5 | 5 | 5.3 s → 6.0 s | 1 | 57 → 50 | 3.13 s → 2.82 s | 5.12 s → 5.79 s |
| 10 | 10 | 10.7 s → 10.5 s | 2 | 56 → 57 | 6.81 s → 7.04 s | 10.48 s → 9.90 s |
| 20 | 20 | 34.2 s → 23.6 s | 4 | 35 → 51 | 19.92 s → 12.59 s | 32.73 s → 21.96 s |
| 50 | 50 | 68.5 s → 75.0 s | 10 | 44 → 40 | 41.43 s → 41.61 s | 66.53 s → 72.22 s |

The two columns are the two runs of the suite (the second one is the re-verification on the current
fixtures). The single-student and 20-student stages move the most; the 50-student stage — the one the
capacity question actually rests on — is stable to within ~10 %.

Every stage also verified: `jobs == students`, **no duplicated job for the same student**, no
cross-student job, every job at the interactive priority, every copy registered to its own student,
and **nothing left in `processing`** afterwards. (39–45 jobs/min is the effective ceiling here —
`limit`-bound with a 1 s+ per-invocation cost — not a saturation of the queue.)

* **C3 — interactive overtakes background:** with ten prewarm jobs already queued, a student request
  enqueued last was the **first job the worker claimed** (verified by job id), and the run still
  processed four prewarm jobs behind it — the interactive job does not get to monopolise the batch.
* **C5 — fairness (the gap):** a prewarm job behind five interactive arrivals was still `queued`
  after five ticks; it completed only after the interactive stream stopped (**7 ticks, 24 s wait**).
  So there is **no permanent starvation**, but there is also **no aging**: if student requests keep
  arriving, pre-generation waits indefinitely. A minimal, low-risk fix would be to promote
  long-waiting prewarm jobs (age-based priority) or to claim with a small priority *bonus* for jobs
  older than N minutes — deliberately **not implemented here**, since it changes delivery ordering
  and needs its own test.

---

## 8. Locking, crashes and duplicates

| Check | Result |
|---|---|
| Two simultaneous worker launches | **exactly one claimed** the single job; the other printed `skipped: worker_locked`, `claimed: 0`, and left the row untouched |
| Job state afterwards | **0 rows in `processing`** — nothing stranded |
| Lock failure | the worker **fails closed** (exit 1) when it cannot create the lock file — never runs unlocked |
| Fatal during a render | `register_shutdown_function` releases the held job (`worker_aborted`); covered by `worker_lock_tests.php` (all checks passed) |
| Abandoned lock | a job whose `locked_at` was moved 2 h back was **requeued** by `recoverStale(3600)`; attempts bounded, `max_attempts` respected |
| Duplicate requests | five enqueues of the same copy → **1 job** |
| Ready reuse | worker reported `ready:cached` and the copy's **mtime was unchanged** — no re-render |

Caveat worth stating: `recoverStale()` (and `dropOrphanedJobs()`) act **queue-wide**, as designed.
In this local database the sweep also reclaimed two pre-existing stale test rows from an earlier
session; the suites print that rather than hiding it.

---

## 9. Live concurrency stages — prepared, NOT RUN (approval requested)

The staged HTTP test (1 → 5 → 10 → 20 → 50 virtual *students*) **was not executed**: it needs
authenticated sessions for real student accounts, and production has no disposable account —
driving it with one real student's session is forbidden. Proposed parameters:

* **Target and workflow:** `SESSION_MODE=pool` (one pre-issued token per VU for a **staging**
  install seeded by `scripts/loadtest/seed-local.php`), endpoints `/auth/me`, `/courses`,
  `/courses/{id}/lessons`, `GET /materials/pdf-status?material_id=…` (workload `pdf-availability`,
  read-only, queues nothing).
* **Stages:** 1, 5, 10, 20, 50 VUs; ramp 15 s, hold 60 s, ramp-down 10 s; `THINK_TIME_MS=1500`.
* **Stop conditions (fixed before the run):** 5xx > 0.5 %, error rate > 1 %, timeouts > 0.5 %,
  p95 > 2000 ms, p99 > 4000 ms, any DB connection-quota error, any `queue_unavailable`/503 from the
  PDF endpoints.
* **Cleanup:** drain the queue between stages, delete the staging students' copies and jobs, and do
  **not** press Download repeatedly (each press is a real job; the pool must stay bounded).
* **What it would not measure:** render capacity (the PDF-generation workload belongs to staging
  with its own worker run) and video delivery (provider CDN).

Rationale for the shape: the queue/worker numbers in §6–§7 already bound *generation*; this stage
test is about the **HTTP/DB path** of many students checking and minting at once.

---

## 10. Student waiting experience — what exists, what is missing

**Present (verified in code):** immediate acknowledgment (`preparing` state before the first poll,
localized `lesson.materialPreparing`), automatic status refresh with exponential backoff, automatic
download when the copy becomes ready, an explicit **Retry** only on permanent failure (the client
never sends `retry` automatically), and no substitution of the unwatermarked original.

**Missing: any estimated wait time.** `pendingResponse()` returns `retry_after` (a polling interval)
and `reason`, but no queue position, no jobs-ahead and no ETA — the client shows a spinner and
localized copy only.

**Measured mismatch that makes this matter:** the client polls at most 10 times with waits of
10 s then 8 s ≈ **82 s total**; with a **five-minute** cron the worst case is a student who arrives
just after a tick and waits up to ~300 s, so the app reports a preparation failure for a document
that is still happily queued. At a **one-minute** cron the worst case is ≤60 s + ~1–2 s of render,
which **fits** the current poll budget.

**Recommendation (transparent fallback first, estimate only if grounded):** expose server-side
`queue_position`, `jobs_ahead_at_priority` and `eta_seconds` (range) from realistic recent render
durations, and until then show *"طلبك في قائمة الانتظار. الوقت المتوقع غير متاح حاليًا، وسنحدّث
الحالة تلقائيًا."* — and either run the worker every minute or raise the poll budget to cover the
cron interval. No fixed "2 minutes" claim is supportable today: nothing measures the wait.

---

## 11. Limitations and environment problems encountered

* **The `D:` volume was at 99–100 % for much of this session.** Renders failed with
  `fwrite(): No space left on device` until I freed space, and drain timings varied between runs
  (5 students: 1.3 s vs 5.3 s) because of disk/CPU pressure. Every number in §5–§7 comes from a run
  that passed its checks; where a figure varies, the range is stated.
* **Sizes are synthetic.** Raster-page handouts approximate scanned material; a text-only or a
  form-heavy document has a different profile. Sizes are reported as **measured bytes**, not as the
  nominal class.
* **Ticks are sequential.** The stages simulate cron runs one at a time (the production model: one
  worker per host, `flock`). They do not model two cron hosts, multiple PHP-FPM pools, or cPanel
  entry-process limits.
* **Local CPU ≠ host CPU.** Timings are a workstation lower bound; the production host is PHP 8.2
  on shared CPU. Host-specific numbers need the staging run in §9.
* **`ready_at` is written with second precision** (`gmdate`) while `created_at` is `DATETIME(6)`, so
  sub-second queue waits read as 0 (clamped in the suite); queue latencies below 1 s are therefore
  reported as "under a second", not to the millisecond.
* **Video and PDF-delivery bandwidth are out of scope** — actual video bytes come from the
  VdoCipher CDN, and download bytes were not load tested here.

---

## 12. Tests added and results

| Suite | What it adds | Result |
|---|---|---|
| `backend/tests/material-queue/make_size_fixtures.php` | size-matrix fixture generator (raster-page PDFs, JSON metadata) | fixtures: 122,013 B / 1 p · 1,221,197 B / 7 p · 5,620,375 B / 31 p · 11,396,255 B / 62 p |
| `backend/tests/material-queue/pdf_worker_performance_tests.php` | per-size render, the real worker run, reuse, budget stop, lock overlap, duplicates, per-student isolation | **75 passed, 0 skipped, 0 failed** (run twice: 16:04 and the re-verification pass) |
| `backend/tests/material-queue/pdf_queue_concurrency_tests.php` | staged 1/5/10/20/50 simultaneous student requests from separate processes, drain with the shipped cron shape, interactive-vs-prewarm, starvation | **41 passed, 0 skipped, 0 failed** (run twice, both passes) |
| `backend/tests/material-queue/queue_tests.php` (existing) | regression check after all of the above | **ALL QUEUE CHECKS PASSED (50 checks, 0 failed)** |
| `backend/tests/material-queue/worker_lock_tests.php` (existing) | lock/fatal-shape regression check | **all checks passed** |
| `.freebuff/tools/render-bench.php` | isolated render median per size | §5 table |
| `.freebuff/tools/hold-phase-measure.php` (from the connection audit) | phase-hold measurement | see the companion report |

PHP lint: clean on every file touched. JS/TS/lint: unchanged by this task (no frontend file was
modified); the results of the project-wide suite run for the previous task are recorded in the
companion report.

---

## 13. Files created or changed

**Created (tests/tooling — not deployed):**

* `backend/tests/material-queue/make_size_fixtures.php`
* `backend/tests/material-queue/pdf_worker_performance_tests.php`
* `backend/tests/material-queue/pdf_queue_concurrency_tests.php`
* `scripts/loadtest/PDF_WORKER_PERFORMANCE_AUDIT.md` (this report)
* `.freebuff/tools/render-bench.php` (developer tool)

**No application code was modified for this task.** In particular
`MaterialPdfQueueService.php`, `MaterialPdfVariantService.php`, `PdfWatermarkService.php`,
`watermark-worker.php` and `WorkerLock.php` are unchanged — the audit found no defect in their
locking, claiming, retry or recovery behaviour, only the two design gaps in §2 (no ETA, no aging).

**Modified (docs only):** none besides this report.

---

## 14. Deployment, migration and cron requirements

* **No backend file needs uploading for this task.** The two behaviour gaps identified here
  (waiting-time estimate, prewarm aging) are **not implemented**; implementing them would change
  `MaterialDeliveryController`/`MaterialPdfQueueService` and would need its own review, tests and a
  deployment — out of scope for an audit.
* **Migration:** none required. `038_pdf_watermark_queue.sql` and `035_lesson_material_pdf_hardening.sql`
  are already applied on this environment; production's state is unchanged by this task.
* **Cron:** unchanged. The audit supports the earlier recommendation that a **one-minute** cadence
  is what makes the current client wait-experience coherent (≤60 s + render ≈ fits the ~82 s poll
  budget). It does not authorise changing it; with `--limit=5` the resource cost per tick is at most
  five renders (≈6 s of CPU at the 11 MB size measured here).
* **Production data:** untouched. No test record, copy, job or fixture was created on the live host.

---

## 15. Recommended next steps, in evidence order

1. **Decide the cron cadence with the waiting UX in hand** (§10): one minute keeps the current poll
   budget honest; five minutes needs a longer budget and an ETA, otherwise students see a false
   failure.
2. **Implement the waiting contract** — server-provided `queue_position` + `eta_seconds` (range)
   plus a transparent fallback message; this is the single highest-value change for students.
3. **Add prewarm aging** so background pre-generation cannot be deferred indefinitely.
4. **Run the staged authenticated test in §9 on a staging install** before quoting any number of
   concurrent students for PDF operations.
5. **Consider raising `--limit` only with host evidence** (cPanel Resource Usage + the staging run);
   today the limit, not the render cost, is the ceiling.
