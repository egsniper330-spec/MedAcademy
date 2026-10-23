# Personalized PDF watermarking — implementation & verification report

Status: **implemented and verified in this repository. Not deployed.** Nothing in
this report was run against production: no migration was executed on a live
database, no file was uploaded, no licence was purchased and no app binary was
built.

Companion documents: [`PDF_WATERMARK_DEPLOYMENT.md`](PDF_WATERMARK_DEPLOYMENT.md)
(exact upload list + server steps), [`PDF_WATERMARK_TESTING.md`](PDF_WATERMARK_TESTING.md)
(how to reproduce the test run), [`PDF_WATERMARK_LICENSING.md`](PDF_WATERMARK_LICENSING.md)
(Ghostscript AGPL/commercial decision — only relevant to the opt-in raster engine).

---

## 1. The policy that is now enforced

Every lesson **PDF** delivered to a **student** is a personalized copy carrying
that student's name and public account id (`MED-####`) on **every page** — a
background grid, foreground marks across the content, a non-text dot lattice, an
identity rail on all four edges and one darker anchor line inside the content
area, plus a baked copy inside the page's own stream. The decision is made **server-side from
the caller's role** and from nothing else:

* a student **always** gets a personalized copy — there is no switch, no request
  field, no feature flag and no client-supplied name that can change it;
* the legacy `lesson_materials.watermark_enabled` column is **not read** by
  delivery (it survives only as a column older builds select);
* a doctor / admin / super-admin gets the **original**, unwatermarked file;
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
| `src/Services/PdfWatermarkService.php` | Renderer: FPDI 2.x + TCPDF 6 vector engine (default), opt-in raster engine, per-page geometry (portrait/landscape/rotated/mixed page sizes), grid + edge identity line, size/page/source limits, `status()` diagnostics, `variantKey()` |
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
| Real PHP engine + integration + error handling + authorization + delivery + gallery | `bash backend/tests/pdf-watermark/run.sh --skip-bootstrap` | **PASS** — 188 passed, 0 failed, 2 skipped of 190 |
| End-to-end delivery suite (part of the above) | `out/delivery.json` | **103/103 checks passed** |
| JavaScript regression suites | `node scripts/run-all-tests.cjs` | **99 suites, 0 failed** |
| Watermark JS suite | `node tests/materialWatermark.test.cjs` | **132 passed, 0 failed** |
| Lesson materials delivery JS suite | `node tests/lessonMaterialsDelivery.test.cjs` | **45 passed, 0 failed** |
| State/maintenance suites | `node scripts/run-state-tests.cjs` | **79 passed, 0 failed** |
| TypeScript | `npx tsc --noEmit` | **exit 0** |
| ESLint (changed TS/TSX files) | `npx eslint src/lib/api.ts src/client/php.ts "src/app/(app)/lesson/[id].tsx" …` | **0 errors** (31 warnings, all pre-existing in untouched code) |
| PHP syntax | `php -l` on all 16 changed/added PHP files | **clean** |

The two skips are the raster-engine pixel proofs: they need Ghostscript, which is
not installed here. They do **not** affect the default vector engine, and the
visual check in §4 covers the same question by rendering the pages directly.

Reproduce note: the harness needs a PHP build with `curl`, `gd`, `zlib` and
`openssl`. On this machine the bootstrapped runtime
(`.freebuff/pdf-watermark-tests/runtime/php`) is the one to put on `PATH`;
`--skip-bootstrap` with a PHP lacking `curl` fails inside the fixture download,
which is an environment problem, not a code problem.

## 4. Visual verification of the delivered bytes

The PDFs inspected were produced by the **real controller path**
(`MaterialDeliveryController::pdfUrl` → `ensurePersonalizedCopy`) for two
different students, then rendered to PNG page by page:

* 4 pages, mixed geometry (A4 portrait, A4 landscape, US-Letter portrait, A4).
* Student A ("Alpha One", `MED-0042`) and student B ("Beta Two", `MED-0099`):
  each copy carries **only its own** identity, repeated across the full page and
  in the footer line; the two files differ byte-for-byte.
* Every page is watermarked — including the landscape page and the dense
  40-row reference-table page — and body text, tables, print-size (6 pt) notes
  and vector diagrams remain readable.
* The source file is untouched (same hash before/after).

Artifacts stay in the git-ignored test workspace
(`.freebuff/pdf-watermark-tests/render-delivered/`, `out/gallery.html`).

## 5. Residual risks and decisions taken

1. **Legacy lecture notes (`lesson_pdfs`, bucket `lesson-pdfs`) are staff-only
   now.** Those objects cannot be personalized (there is no `lesson_materials`
   row to key a copy on) and `/storage/signed-url` used to sign them for **any
   authenticated user**, with no enrollment check — a way to obtain an
   unwatermarked student PDF. Students are now refused (`403
   material_delivery_required`); the app no longer lists those rows to a
   student; doctors/admins keep access and their existing links still stream.
   **If `SELECT COUNT(*) FROM lesson_pdfs;` is not zero in production, those
   notes must be re-uploaded through the lesson editor** (§7.1 of the deployment
   checklist). This is the one change that can remove content a student could
   previously see, and it is deliberate.
2. **Modern PDF structures are refused, not degraded.** FPDI's free parser cannot
   read PDFs whose cross-reference table is a compressed stream (`/Type /XRef`) —
   what Word/InDesign/current LaTeX emit by default. Such a document returns
   **422** with a clear message; it is never delivered unwatermarked. Re-saving
   the source as PDF 1.4/Acrobat-compatible or buying the commercial parser are
   the two options (licensing decision, `PDF_WATERMARK_LICENSING.md`).
3. **The vector engine keeps a text layer** — the lecture stays selectable, so a
   determined reader can copy text out (the watermark is drawn behind it).
   Flattening needs the opt-in raster engine and therefore Ghostscript.
4. **Arabic-script names** are not shaped by the vector renderer; the identity
   line falls back to the account id for such a name (still unique and
   attributable).
5. `backend/vendor/` is now git-ignored (28 MB, 164 PHP files, mostly TCPDF's
   font pack). It must be **built and uploaded**; a checkout alone is not
   deployable.

## 6. Deployment steps (nothing here was executed)

1. Build and upload `backend/vendor/` (`cd backend && composer install --no-dev
   --classmap-authoritative`).
2. Upload the backend PHP files listed in
   [`PDF_WATERMARK_DEPLOYMENT.md`](PDF_WATERMARK_DEPLOYMENT.md) §1a, keeping the
   paths.
3. Apply `035_lesson_material_pdf_hardening.sql` in phpMyAdmin (additive; safe to
   re-run, "duplicate column" errors are expected on a second run). Apply
   `032_lesson_material_watermark.sql` first if it was never applied.
4. `php scripts/watermark-diagnostics.php` → expect `effective: vector`,
   `vector: READY`.
5. `php scripts/verify-watermark.php` → exit 0.
6. Add the daily cron job for `scripts/watermark-cleanup.php --apply` (dry run
   first).
7. Set `memory_limit` ≥ 256M and `max_execution_time` ≥ 120 for the site.
8. Ship an app build that contains the client change; an older build asks for a
   signed storage URL and now receives `403 material_delivery_required` instead
   of a PDF.
9. Run the §7.1 check on `lesson_pdfs` and re-upload any notes that only exist
   there.

No font needs installing for the default engine: TCPDF's bundled DejaVu Sans is
embedded and subset. A TTF matters only for the optional raster engine.
