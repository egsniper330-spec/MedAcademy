# Deploy package — subtle single watermark + a renderer-free flattened engine

Two files. No migration, no new dependency, no required environment variable.

```
backend/src/Services/PdfWatermarkService.php
backend/src/Services/PdfWatermarkBaker.php
```

Upload them to the same paths on the server (overwrite). Nothing else changes:
`routes/api.php`, the controllers, the storage layout and the database are
untouched.

## 1. What these two files change

**a. The single centred mark is now actually subtle.**
`PDF_WATERMARK_OPACITY` is used **verbatim** (default `0.12`). Before, the setting
was mapped through `0.55 + 1.5 × x`, so the old default 0.15 rendered a **0.775**
alpha face and the compositor drew the white halo **eight times** (one per
dilation offset), compounding it. Measured on blank paper now: **0.122** effective
opacity on both engines, text underneath at 17 : 1 contrast.

**b. New engine: `flatten` — flattened page, no renderer binary.**
`PDF_WATERMARK_MODE=flatten` writes **one** centred 35° mark into each imported
page's own content stream (FPDI + TCPDF only). No Ghostscript, no shell, no
network, no TTF upload. It is the free/commercially-safe way to get the single
centred mark — see `backend/docs/PDF_WATERMARK_LICENSING.md`.

**c. The Ghostscript engine is licence-gated.**
`PDF_WATERMARK_MODE=raster` now requires **both** the mode and
`PDF_WATERMARK_ACCEPT_AGPL_RENDERER=1`. Without the second switch the engine
reports unavailable and the download fails closed with **503** — it will not run
AGPL software on a commercial install by accident. `auto` never selects it, so
the default path is unchanged.

**d. Two real bugs fixed.**
- `decodeStream()` stripped `\r`/`\n` bytes from the *compressed* stream, which
  corrupted deflate data whenever the payload legitimately started or ended with
  `0x0A`/`0x0D`. Such a page was reported "not appendable" and **silently lost
  its content bake** — including, on the rotated fixture, the /Rotate 90 page. It
  now takes the payload from `/Length`.
- Ghostscript can exit non-zero *after* writing some pages; that used to deliver
  a truncated PDF. A non-zero exit or a page-count shortfall now refuses the
  document with 422 (logged as `[pdf-watermark] rendered N of M page(s)`).

## 2. After uploading

Verify from the deploy root:

```
php scripts/verify-watermark.php          # real end-to-end, writes nothing to DB
php scripts/watermark-diagnostics.php     # what the host can actually run
```

Then download one lesson PDF as a student and confirm the mark is one faint
diagonal line across the middle of each page, not a grid.

## 3. Choosing an engine (optional)

Nothing here is required — the defaults are correct for shared hosting:

```
PDF_WATERMARK_MODE=auto              # auto | vector | flatten | raster
PDF_WATERMARK_OPACITY=0.12           # the single centred mark (0.08–0.25 sensible)
# PDF_WATERMARK_ACCEPT_AGPL_RENDERER=1   # raster ONLY; see the licensing doc
```

If you want the single centred mark instead of the layered vector grid, set
`PDF_WATERMARK_MODE=flatten`. If you want one image per page (no text layer at
all), that is `raster` — which needs Ghostscript on the host **and** the licence
position recorded with the second switch above.

## 4. Rollback

Restore the two files from the previous package
(`2026-10-24-pdf-watermark-centered-raster/`). Cached copies are keyed by an
engine token: switching back regenerates them on the next download, so there is
nothing to purge. No schema or data changes are involved.
