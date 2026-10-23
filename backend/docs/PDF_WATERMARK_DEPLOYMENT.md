# Personalized PDF watermarking — deployment checklist

Every lesson PDF delivered to a **student** is personalized with that student's
name and public account id (`MED-####`). There is no toggle: the decision is
made server-side from the caller's role (`student` → personalized, staff →
original). A student can download and keep their copy; a doctor or administrator
still receives the untouched original.

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
| `backend/src/Services/PdfWatermarkService.php` | **CHANGED** — the renderer (FPDI 2.x + TCPDF 6 default, opt-in raster): layered marks, seeded layout, per-page bake call, limits, status |
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

There is **no font to upload**: the default vector engine embeds TCPDF's own
bundled DejaVu Sans, subset to the glyphs used (a few KB per document). A TTF is
required only by the optional raster engine (`PDF_WATERMARK_FONT`).

The libraries are pure PHP (`ext-zlib` is the only extra extension). No
Ghostscript, ImageMagick, `proc_open` or shell access is needed for the default
engine.

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

---

## 2. Server configuration

### 2.1 `.env` (only if you want to change a default)

The defaults are correct for shared hosting. Nothing here is required:

```
PDF_WATERMARK_MODE=auto              # auto | vector | raster   (auto = pure PHP first)
PDF_WATERMARK_VECTOR_OPACITY=0.10    # BACK grid only (0.04–0.35)
PDF_WATERMARK_VECTOR_FG_OPACITY=0.30  # marks that cross the lecture (0.08–0.55)
PDF_WATERMARK_MAX_PAGES=150
PDF_WATERMARK_MAX_SOURCE_BYTES=52428800
PDF_WATERMARK_LOCK_WAIT_SECONDS=25
MATERIAL_PDF_URL_TTL_SECONDS=300
MATERIAL_PDF_MINT_PER_MINUTE=60
```

`PDF_WATERMARK_TOKEN_SECRET` is **not** required: the token signs with
`STORAGE_SIGNED_URL_SECRET`, falling back to `JWT_SECRET`, both of which are
already set.

### 2.2 PHP limits (cPanel → Select PHP Version → Options)

| Setting | Recommended | Why |
|---|---|---|
| `memory_limit` | `256M` (512M if you enable raster) | FPDI parses the whole cross-reference of the source; the raster engine needs two truecolor layers per page |
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

Expect (default configuration): `mode: auto`, `effective: vector`, `vector:
READY (FPDI 2.x + TCPDF 6.x)`. If it reports `NO ENGINE`, `backend/vendor` is
missing or not readable.

```bash
php scripts/verify-watermark.php
```

This renders a real fixture through the shipped service, then checks the page
count, that **every page** carries the identity many times, that a back layer is
drawn before the imported page and a front layer after it, that the marks are
**baked into each imported page stream**, that two identities produce different
bytes, and that the source file is untouched. Exit code `0` = pass.

`removal_attacks.py` (Python, developer machine only) is the second half of the
check: it takes a delivered file and measures what a real attacker can remove
(`backend/docs/PDF_WATERMARK_REMOVAL_RESISTANCE.md`).

Then, in the app: open a lesson as a student, **view** a PDF, and **download** the
same PDF. Both files must show `<student name> • MED-####`

* repeatedly, at several angles, **across the text and figures** (not just in
  the margins),
* on all four edges (two horizontal rails, two vertical),
* once in the **middle of the sheet** as a darker anchor line (this is the mark
  that survives "flatten, threshold, crop the margins"),
* with the complete account id — never a truncated `MED-0…`,
* plus a fine dot texture and a small 8x4 dot matrix in the bottom-right corner
  (the per-recipient trace code, `PdfWatermarkService::traceCode()`).

Open the same material as the doctor: it is watermarked with the **doctor's**
identity. Since the "watermark everything" policy change, this endpoint never
serves an unwatermarked original to anyone — so a doctor's download must show a
watermark too. If it does not, the server is still running the previous
`MaterialDeliveryController.php` (which exempted staff) and that file has not
been uploaded yet.

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

## 7. Frontend

The student lesson screen already opens PDFs through `POST /materials/pdf-url`
for **both** preview and download, and keeps signed storage URLs for every
non-PDF attachment. If the installed app build is older than this change it will
call `/storage/signed-url` for a PDF and receive `403
material_delivery_required` — a new app build is required for the in-app flow to
work. No new native permission, dependency or rebuild of `ios/` is involved.

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

* **Modern PDF structures.** The free FPDI parser cannot read a PDF whose
  cross-reference table is a compressed stream (`/Type /XRef`), which is what
  Word, InDesign and current LaTeX produce by default, nor PDFs that need the
  commercial "FPDI PDF-Parser" add-on (object streams, some filters). Such a
  document is **refused with HTTP 422** and a clear message — never delivered
  unwatermarked. If the existing collection contains many of these, the options
  are (a) re-save the source as PDF 1.4/Acrobat-compatible before upload, or
  (b) purchase the paid parser (a licensing decision, see
  `PDF_WATERMARK_LICENSING.md`). The raster engine needs Ghostscript and is
  therefore subject to the AGPL/commercial question — it is **not** enabled by
  default.
* **Vector output keeps a text layer.** The watermark is embedded in the page
  content, so the lecture text stays selectable (copy/paste works). Flattening
  is available only through the opt-in raster engine, which needs Ghostscript.
* **Baking is skipped on some pages.** `PdfWatermarkBaker` only rewrites a Form
  whose geometry it can verify: `/Rotate` must be 0, the `/BBox` must start at
  the origin, `/Length` must be direct, the stream must be uncompressed or plain
  FlateDecode, and the file must use a classic xref table. A page that fails
  these checks keeps all five page-level marks — back grid, front marks, trace
  lattice, edge rails and the interior anchor (still watermarked, just without
  the in-stream copy) — and the reason is logged. Rotated source pages always
  take this path.
* **Tone-cleaning still removes most of the tint.** A student who rasterises the
  page, maps greys to white and crops the margins removes about 91 % of the
  watermark ink — but not the interior anchor or the edge rails, and at the cost
  of the text layer and the figures. The measured cost of each attack and what
  survives it are in `PDF_WATERMARK_REMOVAL_RESISTANCE.md`. Do not describe the
  watermark to staff as impossible to remove.
* **Encrypted PDFs** are refused (`422`) with an actionable message.
* **Arabic-script names** are not shaped by the vector renderer; for such a name
  the identity line falls back to the account id, which is unique and stable and
  is the part that attributes a leaked copy. Arabic shaping is not attempted.
* **Rate limiting** is per account (`MATERIAL_PDF_MINT_PER_MINUTE`, default 60
  per minute) and protects the expensive render path; the storage route is not
  rate limited.
