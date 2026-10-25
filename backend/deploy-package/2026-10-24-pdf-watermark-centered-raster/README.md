# Deploy package — centred flattened watermark (+ bake skip reasons)

**Created:** 2026-10-24
**Target:** `https://api.medacademy.site` (document root `backend/public`)
**Database changes:** **none**
**New dependencies:** **none** (the vector engine still needs only the
`backend/vendor` tree deployed on 2026-10-23)
**Deployment performed by this package:** **none** — nothing was uploaded

---

## 1. What this changes

| File | Server path | Change |
|---|---|---|
| `src/Services/PdfWatermarkService.php` | `backend/src/Services/PdfWatermarkService.php` | The **flattened** engine (`PDF_WATERMARK_MODE=raster`) now draws **ONE large centred diagonal mark per page** instead of a repeated/tiled grid. The mark is scaled to ~86 % of the usable page width, capped to the page height, centred on the page, and drawn as a grey face inside a white halo so it stays legible over both light and dark content. Cache token bumped to `flatten-v3-center`. |
| `src/Services/PdfWatermarkBaker.php` | `backend/src/Services/PdfWatermarkBaker.php` | Every skipped page now records a concrete **reason** (`report['reason']`, e.g. `page 2: form /Matrix is singular`, `page 3: form stream not appendable`). The bake logic itself is unchanged from the 2026-10-23 package — this only makes a skip diagnosable. |

Behaviour change worth reading before you upload: the flattened pipeline is now
**strictly fail-closed on partial renders**. Ghostscript can exit non-zero
*after* writing some pages (one damaged page in an otherwise good file); those
pages used to be assembled into a delivered PDF with content silently missing.
Now a non-zero exit, or a rendered page count lower than the source's, refuses
the whole document with **422** (`A page of this PDF could not be rendered…`), and
the reason is logged (`[pdf-watermark] rendered 3 of 4 page(s)`). An unknown
source page count skips only the count check; the exit-code check always applies.

The **default engine and the default behaviour are otherwise identical to
2026-10-23**: vector output, no binaries, no configuration. The centred layout
only appears when the operator opts into the flattened engine.

---

## 2. Why the token bump matters

`flatten-v3-center` is part of the per-copy cache identity (`variant_key`).
Uploading this package therefore **regenerates** every flattened copy on first
request instead of serving a tiled copy produced by the previous role. Do not
"fix" the mismatch by editing the token back: that silently keeps serving the
old layout.

Vector copies are unaffected — their token (`vector-v4:<engine>` + `layers-v4`)
did not change.

---

## 3. Deploying

1. Upload the two files, keeping the `src/Services/` structure, into `backend/`
   (cPanel → File Manager → `backend/src/Services/` → Upload → Overwrite).
2. No migration, no `composer install`, no restart needed — PHP has no opcode
   cache to flush on cPanel by default; if OPcache is enabled, wait for its
   `revalidate_freq` or restart PHP-FPM from cPanel.
3. Verify (cPanel → Terminal, from `backend/`):

   ```bash
   php scripts/watermark-diagnostics.php     # engine present, mode as configured
   php scripts/verify-watermark.php          # exit 0 = real render passed
   ```

   `verify-watermark.php` exercises the vector path. It does **not** prove the
   flattened path works — that needs Ghostscript on the host; the diagnostics
   script reports `raster_ready`, `ghostscript_version`, `font_present` and
   `pdf_writer_present` for it.

---

## 4. Enabling the flattened (centred) mode — optional

Only if the host has **Ghostscript**, a TTF and a Ghostscript licence position
that is acceptable (AGPL v3 or commercial — see
`backend/docs/PDF_WATERMARK_LICENSING.md`; this package makes no licensing
decision):

```ini
PDF_WATERMARK_MODE=raster
GHOSTSCRIPT_BIN=/usr/bin/gs
PDF_WATERMARK_FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
PDF_WATERMARK_DPI=200
PDF_WATERMARK_IMAGE_FORMAT=png     ; jpeg + PDF_WATERMARK_JPEG_QUALITY for size
```

Measured on the 4-page fixture: **1,135,965 bytes / 9.1 s** per document
(PNG, 200 DPI) versus **133,190 bytes / 0.7 s** for the vector engine. Every page
of the result is one full-page image: no `/Type /Font`, no annotation, no Form
XObject, 0 extractable characters.

Do **not** enable it on a host without Ghostscript: the delivery fails closed
with **503** (`watermark_unavailable`) and students get nothing — it never falls
back to the unwatermarked original.

---

## 5. What the flattened output resists (measured, not claimed)

| Attack | Mark ink surviving | Page kept |
|---|---|---|
| delete every text-showing operator | 97.9 % | 100 % |
| delete annotations / widgets | 100 % | 100 % |
| delete image draw operators | page destroyed | 0.0 % |
| flatten + threshold < 190 | 64.2 % | 89.8 % |
| flatten + threshold < 128 | 0.34 % | 49.9 % |
| whiten the mid-grey band | 0.57 % | 36.9 % |
| white box over the mark | 0.0 % | 0.8 % |
| crop 36 pt off every edge | 2.4 % of the remainder | — |

Read it as: **no non-destructive edit removes the mark**; the only working
attacks destroy the page's colours, images and antialiasing. Full method and
reproduction command: `backend/docs/PDF_WATERMARK_REMOVAL_RESISTANCE.md` §6.

---

## 6. Rollback

Restore the previous `PdfWatermarkService.php` and `PdfWatermarkBaker.php` from
`backend/deploy-package/2026-10-23-pdf-watermark-mandatory/src/Services/`.
Flattened copies regenerated under `flatten-v3-center` remain on disk until the
cleanup cron reclaims them (they are unreferenced once the token stops being
requested), and the vector copies are untouched either way.
