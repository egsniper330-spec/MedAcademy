# Personalized PDF watermarking — deployment checklist

Every lesson PDF delivered to a **student** is personalized with that student's
name and public account id (`MED-####`). There is no toggle: every role receives
a personalized copy, determined server-side from the authenticated account. A
student, doctor or administrator can download and keep their own copy; the
unwatermarked source is never served by the material-delivery endpoint.

This file lists **exactly what must be uploaded** and the checks to run after the
upload. Nothing here is executed automatically — the backend is deployed by
uploading files, as the host is ordinary shared cPanel hosting.

> Delivery is **fail-closed**. If the rendering engine is not installed, the
> request is refused (HTTP 503/422) and the unwatermarked original is never
> served. `/storage/signed-url` and `/storage/signed` refuse lesson-material
> PDFs for every role, so the token-gated endpoint is the only way those bytes
> can leave the server.

---

## 1. Backend files to upload

Only these files changed. Paths are relative to the repository root and map
1:1 onto the server's copy of the backend.

### 1a. PHP code (must be uploaded)

| File | Why |
|---|---|
| `backend/src/Controllers/MaterialDeliveryController.php` | The delivery endpoint: mandatory personalization, token mint/verify, cache + lock, live re-authorization, audit |
| `backend/src/Controllers/StorageController.php` | Refuses `lesson-materials` PDFs on `/storage/signed-url` **and** on redemption (`material_delivery_required`); refuses the legacy `lesson-pdfs` bucket for students |
| `backend/src/Services/PdfWatermarkService.php` | **CHANGED** — raster-only student delivery; one centered mark baked into each page image; legacy vector/flatten choices fail closed; Ghostscript/licensing prerequisites and versioned cache identity |
| `backend/src/Services/PdfWatermarkBaker.php` | **NEW** — appends marks INSIDE each imported page stream so "delete the watermark block" is no longer possible. Pure PHP, no dependency |
| `backend/src/Http/Response.php` | `Response::file()` — chunked streaming so a large PDF is never loaded into memory |
| `backend/src/Storage/StorageService.php` | `privateFilePath()` / `privateFileExists()` used by personalized delivery; students no longer authorise `lesson-pdfs` (§7.1) |
| `backend/routes/api.php` | `POST /materials/pdf-url`, `GET /materials/pdf`, `GET /admin/material-watermark-status` |
| `backend/scripts/watermark-cleanup.php` | **NEW** — cron cleanup (orphans, missing rows, stale variants) |
| `backend/scripts/verify-watermark.php` | Updated end-to-end verification script |
| `backend/scripts/watermark-diagnostics.php` | Engine/extension diagnostics (no code change required if already present) |

### 1b. Dependencies (must be uploaded — the engine does not exist without them)

| Path | Why |
|---|---|
| `backend/composer.json` + `backend/composer.lock` | **NEW** — pins `setasign/fpdi` 2.x, `tecnickcom/tcpdf` 6.x, `setasign/fpdf` 1.8+ |
| `backend/vendor/` | **NEW** — the installed libraries (`autoload.php`, `setasign/fpdi`, `setasign/fpdf`, `tecnickcom/tcpdf`, `composer/`) |

`backend/vendor/` is ~28 MB, mostly TCPDF's font pack. Build it locally (or on
any machine with Composer) and upload the directory as-is:

```bash
cd backend
composer install --no-dev --classmap-authoritative --no-interaction
# vendor/ is now ready to upload (FTP / cPanel File Manager / zip + extract)
```

#### No Composer on the host? Upload the prepared bundle

Shared cPanel hosting usually has no `composer` binary (and the deploy window
should not depend on one). `backend/deploy-package/2026-10-23-pdf-watermark-mandatory/vendor-pdf-engine.zip`
is that same `vendor/` directory, built from the pinned lock file and verified to
autoload FPDI 2.x + TCPDF 6.x. Upload it to `backend/`, then extract it there so
the tree becomes `backend/vendor/autoload.php`, `backend/vendor/setasign/...`,
`backend/vendor/tecnickcom/...`. Do **not** extract it one level up (that would
produce `backend/vendor-pdf-engine/vendor/...`, which the autoloader never sees)
and do not rename the folder: the loader looks for `backend/vendor`.

A TTF font is required for the raster watermark (`PDF_WATERMARK_FONT`); the
service can use an installed font path on the host. Raster delivery also requires
Ghostscript, PHP `proc_open`, GD with FreeType or Imagick, and the FPDF writer.
Separately, FPDI/FPDF/TCPDF remain required for PDF parsing/output. These are
runtime prerequisites, not optional enhancements.

### 1c. Database migration (must be run once)

| File | Why |
|---|---|
| `backend/database/mysql-migrations/032_lesson_material_watermark.sql` | Original registry table `lesson_material_pdfs` + legacy `watermark_enabled` column (skip if already applied) |
| `backend/database/mysql-migrations/035_lesson_material_pdf_hardening.sql` | **NEW** — cached source digest (`file_hash`, `file_hash_path`, `file_hash_size`, `file_hash_mtime`) and the two audit actions |

Both are **additive**: no column is dropped, no data is rewritten. Apply with
phpMyAdmin → Import (see §3). Do **not** run them against production from a
script; run them once, by hand, as part of the deploy window.

### 1d. Documentation (optional, no runtime effect)

`backend/NAMECHEAP_DEPLOYMENT.md`, `backend/docs/PDF_WATERMARK_LICENSING.md`,
`backend/docs/PDF_WATERMARK_TESTING.md`, this file.

### 1e. Raster-only delivery change (2026-10-29)

Student PDF delivery now accepts only raster output. The service renders each
source page, composites one centered identity mark into the page bitmap, and
writes a one-image-per-page PDF. Legacy vector and renderer-free flatten modes
remain in the service for diagnostics and policy regression tests, but
`personalize()` rejects them; there is no automatic fallback. The renderer/cache
identity was versioned so stale vector/flatten copies are not reused.

This changes production prerequisites and licensing exposure. Raster delivery
requires Ghostscript, PHP `proc_open`, GD with FreeType or Imagick, a TTF font,
FPDF, and explicit Ghostscript licence acknowledgement. Student delivery fails
closed with HTTP 503 when a required capability is absent. Resolve the AGPL /
commercial decision before configuring the production acknowledgement flag.
No production configuration, licence or host was changed in local verification.

---

## 2. Server configuration

### 2.1 `.env` (production raster prerequisites)

The mode defaults to raster (`auto` also resolves to raster). The licence flag
below is intentionally commented: enable it only after the production legal /
licensing decision is documented and the host prerequisites are verified.

```
PDF_WATERMARK_MODE=raster            # auto also resolves to raster; vector/flatten fail closed
# PDF_WATERMARK_ACCEPT_AGPL_RENDERER=1  # set only after documented legal/licence approval
PDF_WATERMARK_FONT=/path/to/font.ttf   # required TTF path
PDF_WATERMARK_DPI=200
PDF_WATERMARK_IMAGE_FORMAT=png
PDF_WATERMARK_OPACITY=0.12
PDF_WATERMARK_MAX_PAGES=150
PDF_WATERMARK_MAX_SOURCE_BYTES=52428800
PDF_WATERMARK_LOCK_WAIT_SECONDS=25
PDF_WATERMARK_TIME_LIMIT_SECONDS=90
MATERIAL_PDF_URL_TTL_SECONDS=300
MATERIAL_PDF_MINT_PER_MINUTE=60
```

`PDF_WATERMARK_TIME_LIMIT_SECONDS` (default 90, minimum 30) bounds the raster
render. Local measurements were 3.18 seconds for 4 pages and 31.09 seconds for
40 pages on the pinned Windows test host; production input PDFs and hardware can
differ substantially. Validate realistic scans and page sizes on the target
host, and set PHP execution/memory limits with headroom. The service restores
the worker's previous time limit after rendering and reports named failure
stages (see §2.3).

### 2.3 Diagnosing a failed delivery (stage codes)

A refused mint now names its stage. The code is the response `code` field, the
`stage` in the `material_pdf_failed` audit row, and the reason logged by
`ErrorHandler`:

| code | meaning | fix |
|---|---|---|
| `engine_unavailable` | raster delivery prerequisites incomplete, renderer unlicensed/unacknowledged, or PDF writer unavailable | `php scripts/watermark-diagnostics.php`; verify Ghostscript, `proc_open`, GD/FreeType or Imagick, TTF, FPDF, and the reviewed production acknowledgement |
| `pdf_parse` | FPDI cannot read this document (compressed xref / unsupported structure) | source-side problem; re-export the PDF |
| `render_failed` | the engine threw while drawing | `cause` in the audit row / `error_log` names the class + message |
| `output_missing` | render produced no file | usually memory or disk; check the PHP error log |
| `publish_failed` | the finished file could not be renamed into place | permissions on `storage/private` |
| `storage_unwritable` | a directory could not be created | permissions |
| `schema` | `lesson_material_pdfs` is missing a column | apply the migration for this feature |
| `source_*` | the stored source file is missing/empty/not a PDF/encrypted/oversized | re-upload the material |
| `watermark_busy` | another worker is rendering the same variant | retry (short-lived) |

End-to-end probe — walks the same stages the controller walks and stops at the
first failure, printing the stage, exception class and API code:

```
php backend/scripts/diagnose-pdf-delivery.php                 # environment + engine only
php backend/scripts/diagnose-pdf-delivery.php <material_id>   # full pipeline incl. a real render
```

Exit code 0 = every exercised stage passed. It prints no document bytes, no
token, no student name and no id.



`PDF_WATERMARK_TOKEN_SECRET` is **not** required: the token signs with
`STORAGE_SIGNED_URL_SECRET`, falling back to `JWT_SECRET`, both of which are
already set.

### 2.2 PHP limits (cPanel → Select PHP Version → Options)

| Setting | Recommended | Why |
|---|---|---|
| `memory_limit` | `256M` or more; validate on representative PDFs | rasterization uses truecolor image buffers; scans/high-resolution pages can need additional memory |
| `max_execution_time` | `120` | a large document is parsed page by page; the result is cached, so this is paid once per student per document |

### 2.3 Storage and permissions

* Source PDFs stay in `backend/storage/private/lesson-materials/` (private).
* Personalized copies go to `backend/storage/private/lesson-material-pdfs/`
  (created automatically; **no** public route and **no** `/storage/signed`
  access).
* The web user must be able to write both directories (usually `0755`).
* Nothing else is created outside those two directories except a
  `storage/private/.watermark-locks/` directory holding advisory lock files.

---

## 3. Deployment order

1. **Upload** the PHP files (§1a) and `backend/vendor/` (§1b).
2. **Run** `035_lesson_material_pdf_hardening.sql` in phpMyAdmin (§4). The new
   code also runs without it (it falls back to hashing the source on every
   request), so the order is not critical — only the speed differs.
3. **Verify** with the two CLI scripts (§5).
4. **Add the cron job** (§6).
5. **Check the legacy lecture notes** (§7.1): any document that still lives only
   in the old `lesson_pdfs` table is now staff-only and must be uploaded as a
   lesson material to reach students.
6. **Release the app build** only if the student app predates the delivery
   screen (§7).

---

## 4. Applying migration 035

phpMyAdmin → select the MedAcademy database → **Import** → choose
`035_lesson_material_pdf_hardening.sql` → Go.

Re-running it reports harmless "already applied" errors that can be ignored:

* `#1060 Duplicate column name 'file_hash'` (and the other three columns)
* `#3820/#3821` the `chk_audit_logs_action` constraint already exists / was
  already dropped

The file contains no `information_schema` query on purpose: cPanel's MySQL user
often cannot read `information_schema` (`#1044`), which would abort the import
before the real statements ran.

**Expected result:** `lesson_materials` has `file_hash`, `file_hash_path`,
`file_hash_size`, `file_hash_mtime`; `audit_logs` accepts the actions
`material_pdf_delivered` and `material_pdf_failed`.

---

## 5. Post-upload verification

Run these over SSH (or cPanel → Terminal), from the backend directory:

```bash
php scripts/watermark-diagnostics.php
```

Expect only after the approved host configuration is installed: `mode: raster`,
`effective: raster`, `raster: READY`, Ghostscript version present, compositor/font
available, and the licence gate accepted. If any raster requirement is missing,
the service intentionally reports unavailable and refuses delivery (HTTP 503);
there is no vector/flatten fallback.

```bash
php scripts/verify-watermark.php
```

This renders a real fixture through the shipped service and checks page count,
that each output page is a single raster image, every page carries one centered
watermark, the PDF has no extractable source text/font/Form/annotation layer,
two identities produce different bytes, and the source file remains untouched.
Exit code `0` = pass. The tool runs locally; it does not validate the target
production host.

Then, in the app, open a lesson as a student, **view** and **download** a PDF.
Confirm the student's identity mark appears centered on every page and text is
visually readable. Text is intentionally rasterized and is no longer selectable
or searchable.

Open the same material as a doctor: it should be watermarked with the doctor's
authenticated identity as well. The material-delivery endpoint does not serve
the unwatermarked original to staff or students.

> The ways the mark can and cannot be removed — with measured before/after
> numbers — are in `PDF_WATERMARK_REMOVAL_RESISTANCE.md`. Do not promise staff
> that a screenshot cannot be cleaned; the document says exactly what survives.

---

## 6. Scheduled cleanup (cron)

Personalized copies accumulate: one file per (student, material, variant). The
cleanup script removes

* registry rows whose file disappeared (so the next request regenerates instead
  of failing closed forever),
* orphaned `.pdf` files with no registry row (a crash between publication and
  the row write), and
* stale variants whose source PDF was replaced.

It never touches `.part` files, directories, or files outside the
`lesson-material-pdfs` bucket, and it is a **dry run** unless `--apply` is given.

cPanel → **Cron Jobs** → add (daily, 03:30):

```
30 3 * * * /usr/local/bin/php /home/USERNAME/medacademy-api/scripts/watermark-cleanup.php --apply >> /home/USERNAME/medacademy-api/storage/logs/watermark-cleanup.log 2>&1
```

Adjust the PHP path (`which php`) and the backend path. The script honours
`PDF_WATERMARK_CLEANUP_GRACE_SECONDS` (default `86400`) so a file written in the
last day is never removed. Run it once by hand without `--apply` first and read
the plan it prints.

---

## 6b. Pre-generation queue (cron worker)

Generation no longer happens in the student request. A durable queue
(`lesson_material_pdf_jobs`, migration **038**) and a bounded CLI worker produce
copies in the background; the student's first open either finds a ready copy or
is told `preparing` and polls.

* Migration: `backend/database/mysql-migrations/038_pdf_watermark_queue.sql`
  (additive; rollback in `…_down.sql`). **Not applied by this change.**
* Worker: `backend/scripts/watermark-worker.php` — bounded by `--limit` and
  `--max-seconds`, claims atomically, re-checks authorization, retries with
  backoff and reclaims locks from a killed run. It also runs the 24-hour
  retention sweep with `--retention --apply`.
* Cron entries are **NOT configured**. The two lines and the schedule rationale
  are in **`PDF_WATERMARK_QUEUE.md` §4**, together with the storage/retention
  maths and the client contract.

Run one batch by hand after deploying and applying 038:

```
php backend/scripts/watermark-worker.php --limit=3 --pretty
```

---

## 7. Frontend

The student lesson screen opens PDFs through `POST /materials/pdf-url` for
both preview and download, and keeps signed storage URLs for non-PDF attachments.
An older installed app build that requests a signed storage URL for a PDF receives
`403 material_delivery_required`; release the app build containing the token-
gated delivery flow. No new native permission or `ios/` rebuild is required.

---

### 7.1 Legacy lecture notes (`lesson_pdfs`) are staff-only now

The old `lesson_pdfs` table (bucket `lesson-pdfs`) predates lesson materials and
is no longer written to by this codebase. Its objects **cannot** be
personalized — there is no `lesson_materials` row to key a copy on — and until
the release that accompanies this change `/storage/signed-url` handed a signed
link for them to **any authenticated user**, i.e. an unwatermarked student PDF
with no enrollment check. That route is now refused for students (`403
material_delivery_required`) and the lesson screen no longer offers those rows to
a student; doctors and administrators keep access.

**Action required if the table still has rows in production.** Check:

```sql
SELECT COUNT(*) FROM lesson_pdfs;
```

If it is not zero, those notes are not reachable by students from this release
on. Re-upload them through the lesson editor (**Lecture Materials → Upload**),
which stores them as `lesson_materials` and delivers them as personalized
copies. `lesson_pdfs` rows themselves may be left in place: the course-deletion
and analytics code still reads them, and dropping the table is a destructive
migration with no benefit.

## 8. Known limitations

* **Host prerequisites and licensing.** Raster delivery depends on Ghostscript,
  `proc_open`, GD/FreeType or Imagick, a TTF font, the FPDF writer and explicit
  acceptance of the Ghostscript licence position. Production use remains blocked
  until legal/licensing review and actual-host compatibility checks are complete.
* **Source readability/quality.** The local suite verifies a compressed-xref
  fixture renders and malformed, encrypted, over-limit and oversized fixtures
  fail closed. Unusual real-world filters, damaged documents, scanned page
  sizes and photographic output still need representative target-host review.
* **Raster trade-off.** The watermark is baked into one image per page and source
  text cannot be selected or copied. Watermark visibility/readability was
  measured on the fixtures; this does not establish universal readability.
* **Arabic-script names** were not validated in this run; confirm glyph coverage
  and rendering with representative names and the actual production TTF.
* **Encrypted PDFs** are refused (`422`) with an actionable message.
* **Rate limiting** is per account (`MATERIAL_PDF_MINT_PER_MINUTE`, default 60
  per minute) and protects the expensive render path; the storage route is not
  rate limited.
