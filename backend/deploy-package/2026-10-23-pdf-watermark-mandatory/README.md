# Deploy package — lesson-PDF watermarking that actually runs on the live host

**Created:** 2026-10-23
**Target:** `https://api.medacademy.site` (document root `backend/public`)
**Database changes:** **none required** (migration 035 is an optional performance cache)
**Production deployment performed by this package:** **none** — nothing was uploaded, no database was touched

---

## 1. The two failures reported from the live app

| Symptom | Cause | Fix in this package |
|---|---|---|
| Chrome: *"Could not generate a download link"* with the console line *"PDF watermarking is not available on this server: no compatible engine is installed"* | The live server has **no `backend/vendor` directory**, so FPDI + TCPDF are not installed and the service fails closed with **HTTP 503** — by design, it refuses to hand out the unwatermarked original. | `vendor-pdf-engine.zip` (§3) |
| The downloaded `file-sample_150kB.pdf` opened with **no watermark** (142,786 bytes — byte-identical to the uploaded original) | The delivered account was a **doctor**. The previously deployed controller exempted staff (`shouldWatermark()` returned `$role === 'student'`), so a doctor — including a doctor previewing a course as a student — received the raw original. | `src/Controllers/MaterialDeliveryController.php` (§4) |

Both must be fixed together. Uploading only the controller turns the doctor's
download into a 503; uploading only the vendor leaves the doctor unwatermarked.

---

## 2. Layout

The package mirrors the server tree, so the mapping is unambiguous:

```
src/Controllers/MaterialDeliveryController.php  →  backend/src/Controllers/MaterialDeliveryController.php
src/Services/PdfWatermarkService.php            →  backend/src/Services/PdfWatermarkService.php
src/Services/PdfWatermarkBaker.php              →  backend/src/Services/PdfWatermarkBaker.php
vendor-pdf-engine.zip                           →  upload to backend/, then extract there
```

---

## 3. File 1 (mandatory) — the PDF engine

`vendor-pdf-engine.zip` (14.8 MB, 405 files) is the Composer `vendor/` tree built
from the pinned `composer.lock`: `autoload.php`, `composer/`, `setasign/fpdi`,
`setasign/fpdf`, `tecnickcom/tcpdf` (including the bundled DejaVu Sans font pack).

It is **pure PHP**; no Composer, shell access, Ghostscript or Imagick is needed
on the host. `ext-zlib` (enabled by default on cPanel PHP) is the only extra
requirement.

1. cPanel → File Manager → `backend/` → **Upload** → `vendor-pdf-engine.zip`
2. Right-click the uploaded zip → **Extract** → extract into `backend/`
3. Confirm the tree is exactly `backend/vendor/autoload.php`,
   `backend/vendor/setasign/fpdi/…`, `backend/vendor/tecnickcom/tcpdf/…`
   (a nested `backend/vendor-pdf-engine/vendor/…` or
   `backend/vendor/vendor/…` will not be found), then delete the zip.

`backend/vendor/` stays excluded from git (`.gitignore`), exactly as the client
build expects.

---

## 4. File 2 (mandatory) — the delivery policy

| Local path | Server path |
|---|---|
| `src/Controllers/MaterialDeliveryController.php` | `backend/src/Controllers/MaterialDeliveryController.php` |

Change: `shouldWatermark()` no longer exempts staff. Every delivery from
`GET /materials/pdf` is now a personalized copy carrying the **caller's** name and
public id, so a doctor reviewing/previewing a course receives the same bytes a
student receives, and the unwatermarked original is no longer reachable through
this endpoint by anyone. Nothing else about the endpoint changed (same routes,
same token, same permission and enrollment re-checks).

| Local path | Server path | Needed? |
|---|---|---|
| `src/Services/PdfWatermarkService.php` | `backend/src/Services/PdfWatermarkService.php` | Yes — same change set; the 503 message now names the remediation |
| `src/Services/PdfWatermarkBaker.php` | `backend/src/Services/PdfWatermarkBaker.php` | Yes — **new file**. Appends the marks to each imported page's own content stream, which is what stops "keep the page, delete the watermark" |

### Removal resistance (this package)

The delivered file no longer contains one deletable block of watermark text. Per
page it carries a background grid, foreground marks across the content, a
non-text dot lattice with a 32-bit recipient code, an identity rail on all four
edges and a darker anchor line inside the content area — plus a second copy
**baked into the lecture page's own stream** by `PdfWatermarkBaker`. Deleting the
page text operators now removes ~73 % of the watermark ink instead of all of it
(measured; `backend/docs/PDF_WATERMARK_REMOVAL_RESISTANCE.md`). No configuration
switch is needed: this is the behaviour of the files in this package.

---

## 5. Everything else in this package

These belong to the same feature and are already reachable from the live API
(the 503 response proves the delivery controller is deployed). Upload them only
if the live server predates the feature; they are all backwards-compatible.

| Local path | Server path |
|---|---|
| `src/Controllers/StorageController.php` | `backend/src/Controllers/StorageController.php` |
| `src/Storage/StorageService.php` | `backend/src/Storage/StorageService.php` |
| `src/Http/Request.php`, `src/Http/Response.php` | `backend/src/Http/…` |
| `routes/api.php` | `backend/routes/api.php` |
| `composer.json`, `composer.lock` | `backend/` (reference only — not executed at runtime) |
| `scripts/watermark-diagnostics.php`, `scripts/verify-watermark.php`, `scripts/watermark-cleanup.php` | `backend/scripts/…` |
| `database/mysql-migrations/035_lesson_material_pdf_hardening.sql` | optional, see §6 |

---

## 6. Database

**No migration is required for this fix.** The delivery code tolerates the 035
columns being absent (it hashes the source on every request instead of using the
cache), and migration 032 created the registry table that is already in use.

Migration 035 only adds the source-digest cache columns plus two audit actions.
Apply it (phpMyAdmin → Import, once) if you want the cache; it is additive and
rewrites no data. **This package did not run it.**

---

## 7. Reading the 503 if it still happens

Since 2026-10-23 the API says exactly which piece is missing, e.g.:

```
no compatible engine is installed (autoload=NOT FOUND in backend/vendor, FPDI=missing, TCPDF=missing, zlib=yes, mbstring=yes)
```

| Field | Meaning | Fix |
|---|---|---|
| `autoload=NOT FOUND in backend/vendor` | No `backend/vendor/autoload.php` on the server — the zip was not uploaded, not extracted, or extracted one level too deep (e.g. `backend/vendor-pdf-engine/vendor/…`). | Upload + extract so the file is literally `backend/vendor/autoload.php`. |
| `autoload=<path>` but `FPDI=missing` / `TCPDF=missing` | `autoload.php` is there but the package tree is incomplete (a partial extraction, or only `vendor/composer/` was copied). | Re-upload the whole zip and extract with overwrite. |
| `zlib=NO` | The host's PHP lacks zlib, which TCPDF needs to read its compressed font metrics. | cPanel → Select PHP Version → enable `zlib`. |
| `mbstring=NO` | Missing `mbstring` (TCPDF's Unicode handling). | Enable `mbstring` for the domain's PHP version. |
| `FPDI=loaded, TCPDF=loaded` and it still 503s | Not an install problem — send this file's §7 output. | — |

## 7. Verify after upload

1. Engine present (cPanel → Terminal, from `backend/`):

   ```bash
   php scripts/watermark-diagnostics.php
   ```

   Expect `"available": true`, `"effective_mode": "vector"`,
   `"vector": { "ready": true, "engine": "tcpdf", … }`.
   `"available": false` means the zip was extracted to the wrong level.

2. Real render check (builds its own fixture, touches no stored file):

   ```bash
   php scripts/verify-watermark.php
   ```

   Exit code `0` = pass.

3. In the app, sign in **as a doctor**: open a lesson with a PDF material and
   press Download. The file must now contain `<name> • MED-####` on every page —
   diagonally across the text, on all four edges, and once in the middle of the
   sheet. Repeat as a **student**: same result with the student's identity.

4. Negative check: with `backend/vendor` temporarily renamed, a student download
   must return **503** (`watermark_unavailable`) and must **not** download a PDF.
   Rename it back afterwards.

---

## 8. Rollback

Restore the previous `MaterialDeliveryController.php` (staff exemption) and/or
remove `backend/vendor/`. Removing the engine makes every PDF delivery fail with
503 — it never falls back to the original, which is the intended fail-closed
behaviour but blocks students entirely, so do not leave the host in that state.
