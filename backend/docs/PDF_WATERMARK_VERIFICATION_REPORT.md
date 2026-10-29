# Personalized PDF watermarking — implementation & verification report

Status: **implemented and verified in this repository. Not deployed.** Nothing in
this report was run against production: no migration was executed on a live
database, no file was uploaded, no licence was purchased and no app binary was
built.

Companion documents: [`PDF_WATERMARK_DEPLOYMENT.md`](PDF_WATERMARK_DEPLOYMENT.md)
(exact upload list + server steps), [`PDF_WATERMARK_TESTING.md`](PDF_WATERMARK_TESTING.md)
(how to reproduce the test run), [`PDF_WATERMARK_LICENSING.md`](PDF_WATERMARK_LICENSING.md)
(Ghostscript AGPL/commercial decision — required before enabling raster delivery).

---

## 1. The policy that is now enforced

Every lesson **PDF** delivered to a **student** is a personalized image-only
copy carrying that student's name and public account id (`MED-####`) on **every
page**. Each page is rasterized, composited with one horizontally centered
watermark, and assembled as one page-sized image; there is no searchable text,
vector layer, separate watermark object or annotation. The decision is made
**server-side from the caller's role** and from nothing else:

* a student **always** gets a personalized copy — there is no switch, no request
  field, no feature flag and no client-supplied name that can change it;
* the legacy `lesson_materials.watermark_enabled` column is **not read** by
  delivery (it survives only as a column older builds select);
* staff also get a copy personalized to their own authenticated identity; the original is not delivered through this endpoint;
* if the renderer cannot produce the copy, delivery is **refused** (HTTP 503 or
  422 with an actionable message) and the original is never served instead.

Both student actions — **View/Preview** and **Download** — go through the same
token-gated delivery endpoint, so there is exactly one place that can hand out
PDF bytes.

## 2. What changed

### 2.1 Backend (PHP)

| File | Change |
|---|---|
| `src/Controllers/MaterialDeliveryController.php` | Delivery endpoint: mandatory personalization, short-lived token (material + student + intent + expiry), live re-authorization at stream time, per-variant cache + `flock` serialization, source-digest cache, audit, fail-closed errors |
| `src/Services/PdfWatermarkService.php` | Student delivery is raster-only: Ghostscript + GD/Imagick + TTF + explicit licence acceptance; one centered watermark is composited into each page image; legacy vector/flatten modes fail closed; page/source limits, diagnostics, versioned cache identity, bounded-memory source page scan |
| `src/Http/Response.php` | `Response::file()` — chunked streaming with `Content-Length` (a 40 MB PDF no longer doubles memory), buffering cleared first so bytes cannot be corrupted |
| `src/Storage/StorageService.php` | `privateFilePath()` / `privateFileExists()` for personalized delivery; the legacy `lesson-pdfs` bucket is no longer authorised for students (see §5) |
| `src/Controllers/StorageController.php` | `/storage/signed-url` refuses lesson-material PDFs (`403 material_delivery_required`) **and** `/storage/signed` refuses them at redemption, so an already-issued link dies too; the legacy `lesson-pdfs` bucket is refused for students at signing |
| `routes/api.php` | `POST /materials/pdf-url`, `GET /materials/pdf?token=…` (public-by-token, like `/storage/signed`), `GET /admin/material-watermark-status` (admin/super-admin) |
| `scripts/watermark-cleanup.php` | **new** — cron cleanup: registry rows whose file vanished, orphaned files, stale variants; dry-run unless `--apply`; never touches `.part` files or anything outside the personalized bucket |
| `scripts/verify-watermark.php` | end-to-end CLI verification (renders a fixture through the shipped service) |
| `scripts/watermark-diagnostics.php` | engine/extension diagnostics |
| `composer.json`, `composer.lock` | **new** — pins `setasign/fpdi` 2.x, `technickcom/tcpdf` 6.x, `setasign/fpdf` 1.8+ |
| `database/mysql-migrations/035_lesson_material_pdf_hardening.sql` | **new** — cached source digest (`file_hash`, `file_hash_path`, `file_hash_size`, `file_hash_mtime`) + the two audit actions |
| `database/mysql-migrations/032_lesson_material_watermark.sql` | registry table `lesson_material_pdfs` (+ the legacy toggle column) — from the earlier commit, apply once if not already applied |
| `database/schema.sql` | consolidated schema kept in step (reference only — not imported on the server) |

### 2.2 Frontend (app build required)

| File | Change |
|---|---|
| `src/lib/api.ts` | `getMaterialPdfUrl(materialId, forDownload)`; the legacy watermark toggle helper is gone; `watermark_enabled` documented as ignored |
| `src/client/php.ts` | maps `materials/pdf-url` → `/materials/pdf-url` |
| `src/lib/lessonMaterials.ts` | `isPdfMaterial()` — PDFs take the delivery endpoint, every other attachment keeps the signed-URL flow |
| `src/app/(app)/lesson/[id].tsx` | preview **and** download of a PDF material use `getMaterialPdfUrl`; a watermark failure gets its own message; legacy `lesson_pdfs` rows are no longer offered to students |
| `src/app/(app)/lesson-editor/[id].tsx` | the "Personalized Student Watermark" toggle is removed (there is nothing to toggle) |
| `src/lib/i18n/resources.ts` | `lesson.materialWatermarkUnavailable` in English and Arabic |

## 3. Test results (all run just now, on the current working tree)

| Check | Command | Result |
|---|---|---|
| Required PHP watermark suites (real raster pipeline, integration verification, error handling, authorization, delivery/queue/cache/concurrency/cleanup, legacy-engine policy) | `powershell -NoProfile -ExecutionPolicy Bypass -File backend/tests/pdf-watermark/run.ps1 -SkipBootstrap -AcceptGhostscriptLicense` | **PASS** — 232 passed, 0 failed, 2 skipped of 234; all six required suite commands exited 0 |
| Optional gallery artifact | `backend/tests/pdf-watermark/make_gallery.php` (run by the harness) | **PASS** — gallery generated; not counted among required suite checks |
| Real raster pipeline | `out/real_pipeline.json` from the run above | **32 passed, 1 not applicable**; 4-page, rotated/mixed geometry and per-page centered watermark/pixel checks passed |
| Delivery and queue integration | `out/delivery.json` from the run above | **128 passed, 1 not applicable** |
| Legacy vector/flatten fail-closed policy | `out/flatten_engine.json` from the run above | **12/12 passed** |
| Other required suites | `repo_verify.json`, `error_handling.json`, `authorization.json` | **14/14, 8/8, and 37/37 passed** |

The two skipped checks are deliberately inapplicable to this output contract:
one expects a separate foreground vector watermark layer, while raster pages
have the watermark composited into the page image; the other expects a repeated
vector grid while raster delivery intentionally emits a single centered mark.
The harness maps `-AcceptGhostscriptLicense` to the explicit test-only
`PDF_WATERMARK_ACCEPT_AGPL_RENDERER=1` acknowledgement; this is not a legal
licensing determination or authorization for production use.

Both skipped checks are explicitly inapplicable to the raster contract, not
blocked by a missing renderer: this run had Ghostscript 10.08.0 available. The
optional gallery succeeded, but it is excluded from the required-suite total.
To reproduce on this Windows workspace, use the pinned PHP runtime and the
`-AcceptGhostscriptLicense` test-harness acknowledgement shown in the table.
That option only configures this local test process and is not production
licensing approval.

## 4. Visual verification of the delivered bytes

The suite personalized deterministic fixtures through the real PHP service for
two distinct identities, rendered source and output pages with Ghostscript, and
compared pixel differences page by page:

* The 4-page fixture covers A4 portrait, A4 landscape, US-Letter portrait and a
  dense reference-table page. Every page passed the one-centered-band/no-grid
  check; the two output copies have different bytes and their watermarks match
  their respective test identities.
* Each output page is one raster image. Checks found no extractable source text,
  fonts, vector Form XObjects or annotations; the watermark is baked into the
  pixels. Source hashes remain unchanged.
* Rasterized lecture text remains visually dark/readable under the mark. Unlike
  vector delivery, selectable/copyable source text is intentionally absent.

### Measured performance (Windows test runner)

Freshly measured by the required real-pipeline suite on PHP 8.3.35, Ghostscript
10.08.0, GD/FreeType, FPDF 1.9.0, and the configured Arial Bold TTF. These are
single-run timings on deterministic fixtures, not cross-host performance claims:

| Fixture | Source | Pages | Render time | Output | PHP peak memory |
|---|---:|---:|---:|---:|---:|
| Small | 6,781 B | 4 | 3.18 s | 549,076 B | 109 MiB |
| Large | 11,472 B | 40 | 31.09 s | 5,486,511 B | 113 MiB |

Artifacts and machine-readable measurements remain in the git-ignored test
workspace (`.freebuff/pdf-watermark-tests/out/real_pipeline.json`,
`out/summary.json`, rendered-page PNGs, and `out/gallery.html`).

## 5. Root cause, residual risks and decisions taken

**Root cause:** the former `auto` default preferred the pure-PHP vector engine.
That renderer preserved searchable source text and drew layered/repeated marks,
so it did not satisfy the required image-only, one-centered-mark delivery
contract. The old renderer-free `flatten` option also preserved source text. The
change therefore makes raster the only delivery engine, resolves legacy `auto`
to raster, refuses vector/flatten explicitly, and fails closed when raster
prerequisites are absent. A new cache identity prevents previously generated
vector/flatten variants from being reused. The source page-count scanner now
reads bounded chunks rather than loading the entire source PDF into PHP memory.

1. **Raster rendering is now a hard production prerequisite.** The default and
   legacy `auto` setting resolve to raster only; explicit `vector` and `flatten`
   modes are refused for student delivery. If Ghostscript, `proc_open`, GD with
   FreeType (or Imagick), a TTF, FPDF, or the recorded licence acknowledgement
   is missing, the request fails closed with HTTP 503; the original is not
   served as fallback. This deliberately replaces the prior pure-PHP default.
2. **Ghostscript licensing must be resolved before production enablement.**
   The test run used the harness's explicit acknowledgement to exercise its
   isolated installed Ghostscript; that is not legal advice, a paid licence, or
   approval to configure the production environment. See
   [`PDF_WATERMARK_LICENSING.md`](PDF_WATERMARK_LICENSING.md); confirm with your
   licensing counsel or Artifex before setting the production acceptance flag.
3. **Performance/output trade-off:** the measured 40-page render took 31.09 s
   and produced a 5.49 MB PDF from an 11.5 KB fixture. Scanned/photo-heavy
   sources may render larger; production capacity and timeout/memory settings
   need validation on the actual host.
4. **Modern PDF structures:** Ghostscript renders the test fixture containing a
   compressed cross-reference stream; this is a practical benefit over the
   legacy FPDI path. Encrypted, malformed, oversized and page-limit inputs still
   fail closed (covered by error-handling suite).
5. **Legacy lecture notes (`lesson_pdfs`, bucket `lesson-pdfs`) are staff-only
   now.** Those objects cannot be personalized (there is no `lesson_materials`
   row to key a copy on) and `/storage/signed-url` used to sign them for any
   authenticated user without enrollment checks. Students are now refused
   (`403 material_delivery_required`); the app no longer lists those rows to a
   student; staff retain access. Check production row counts and re-upload
   material through the lesson editor where needed (§7.1 deployment checklist).
6. **Arabic-script names:** the test suite uses Latin-script names; Arabic
   shaping/rendering was not verified for the raster watermark. Confirm it on
   representative devices/fonts before claiming Arabic-script watermark support.
7. The service still loads bundled FPDI/FPDF/TCPDF libraries for PDF output and
   legacy policy tests; `backend/vendor/` must be built and uploaded. That does
   not supply Ghostscript, a compositor, a font, the required PHP capabilities,
   or licensing approval for raster delivery.

## 6. Deployment requirements (nothing here was executed)

This verification does not deploy or resolve the licensing decision. Do not
switch production to raster delivery until Ghostscript licensing and target-host
compatibility have been explicitly approved. A production deployment must
provision all raster prerequisites before the code is uploaded; the code fails
closed if any are absent.

1. Resolve Ghostscript AGPL/commercial terms and document the production
   decision; only then set `PDF_WATERMARK_ACCEPT_AGPL_RENDERER=1`.
2. Verify target hosting supplies Ghostscript, `proc_open`, GD with FreeType or
   Imagick, an installed TTF font, and enough memory/time for real documents.
   Validate representative PDFs, including scans and large page counts.
3. Build/upload `backend/vendor/` (`cd backend && composer install --no-dev
   --classmap-authoritative`) and the exact backend files in
   [`PDF_WATERMARK_DEPLOYMENT.md`](PDF_WATERMARK_DEPLOYMENT.md) §1a.
4. Apply migrations 032 (if absent) and 035 in the planned maintenance window.
5. Run `php scripts/watermark-diagnostics.php`; expect `effective: raster`,
   `raster: READY`, the expected Ghostscript version/compositor/font, and the
   licence gate accepted. Then run `php scripts/verify-watermark.php`.
6. Add and dry-run the cleanup cron before enabling `--apply`.
7. Ship the app build that uses the token-gated PDF delivery route; old builds
   receive `403 material_delivery_required` through signed storage URLs.
8. Check production `lesson_pdfs` row counts and migrate any student material
   that exists only in the now staff-only legacy bucket.

No deployment, production licence acceptance, migration, file upload, or app
release was performed for this report.
