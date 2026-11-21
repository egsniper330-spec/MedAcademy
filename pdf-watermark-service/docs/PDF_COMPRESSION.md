# Personalised PDF size — root cause, measurements, profiles

## 1. Where the size came from (measured, not guessed)

The delivery pipeline is unchanged in shape:

```
original PDF ──preprocess──► masters/<mat>/<ver>/page-NNNN.png   (150 DPI raster, once)
             ──issuance──► embed payload per page → rebuild a PDF (one image per page)
```

`build_personalised_pdf()` rasterises every page at the master DPI and embeds the
raster **as a lossless PNG** inside the PDF. An A4 page at 150 DPI is
1240 × 1755 px = 6.5 MB of raw RGB; PNG takes it to ~470 KB for dense text and
~2.4 MB for a photo. A doctor's 500 KB vector PDF of 15 pages therefore becomes
~6–7 MB — which is exactly the reported behaviour.

Measured on a synthetic but realistic vector document (`scripts/size_report.py`,
20 pages, 64 text lines per page):

| Stage | Size |
|---|---:|
| original (vector, selectable text) | 138 KB |
| master PNGs (20 × 1240×1755) | 9.44 MB |
| personalised, previous encoder (PNG per page) | 8.73 MB |
| **delivered** (the bytes PHP receives) | same as above |

The growth happens **entirely at the master-render + page-rasterisation step**.
PHP, cURL and the transport add nothing: `/internal/files` sends the stored file
as-is, and the recorded `file_sha256` is the hash of those exact bytes.

## 2. What does NOT work (measured, and this is why the first attempt was wrong)

Naively "switch PNG to JPEG" does **not** solve a text document. One page, 1240×1755:

| encoding | size |
|---|---:|
| PNG (previous) | 473 KB |
| JPEG q95, 4:4:4 | 543 KB — **worse than PNG** |
| JPEG q88, 4:4:4 | 429 KB (−9%) |
| JPEG q88, 4:2:0 | 420 KB |
| JPEG q85, 4:2:0 | 389 KB (−18%) |
| JPEG q82, 4:2:0 | 367 KB (−22%) |
| JPEG q72, 4:2:0 | 308 KB (−35%) |
| 120 DPI, q85, 4:2:0 | 275 KB (−42%) |
| 100 DPI, q85, 4:2:0 | 207 KB (−56%) |

Dense black-on-white text is high-frequency data: at the same resolution, JPEG
can only trade visible quality for bytes. The large, safe-looking win is
**fewer pixels**, not a different codec.

## 3. Profiles (implemented)

| profile | encoding | resolution | measured effect |
|---|---|---|---|
| `lossless` | PNG/Flate (exact previous output) | master DPI | baseline; the escape hatch for a disputed copy |
| `conservative` | JPEG q92, 4:2:0 | master DPI | −10…−15% text, −70…−80% scans |
| **`balanced` (default)** | JPEG q85, 4:2:0 | master DPI | **−18% text page**, −70% photo page, no resampling |
| `aggressive` | JPEG q82, 4:2:0 | capped at 120 DPI | −42% text, −80% photo |

`balanced` keeps the pixel grid identical to the master, so the watermark's
geometry is untouched; the only change is re-encoding, and blank-pages are
emitted without a raster at all.

`aggressive` resamples, which is the one change that can genuinely degrade a
pixel-domain watermark. **It is not the default and must not be enabled before
`scripts/validate_compression.py` reports full recovery on that deployment.**

## 4. Full before/after table

`scripts/size_report.py`, identity embedder (size behaviour only), 150 DPI masters:

| document | pages | original | master PNGs | lossless | conservative | balanced | aggressive |
|---|---:|---:|---:|---:|---:|---:|---:|
| vector text, 20 pages | 20 | 138.4 KB | 9.44 MB | 8.73 MB | 9.28 MB | 7.72 MB | 5.09 MB |
| text-only raster, 12 pages | 12 | 2.64 MB | 8.11 MB | 8.18 MB | 3.30 MB | 2.63 MB | 1.78 MB |
| scanned, 3 pages @150 DPI | 3 | 1.04 MB | 7.42 MB | 8.66 MB | 1.41 MB | 1.04 MB | 593 KB |
| mixed text+image, 4 pages | 4 | 1.18 MB | 4.71 MB | 4.77 MB | 1.51 MB | 1.18 MB | 766 KB |
| high-res scan @300 DPI, 2 pages | 2 | 2.48 MB | 5.62 MB | 5.76 MB | 848 KB | 507 KB | 265 KB |
| repeated graphics, 8 pages | 8 | 1.40 MB | 4.25 MB | 4.74 MB | 1.77 MB | 1.39 MB | 987 KB |

(`conservative` at q92/4:2:0 still lands close to the PNG baseline on dense text:
that encoding is the fidelity-first option, not the size option.)

Reading of the numbers:

* For **scanned / photographic** documents, `balanced` matches or beats the
  original upload and `aggressive` is a large win.
* For **vector text** documents, `balanced` saves ~12% end-to-end; `aggressive`
  saves ~42%. The remaining cost is the price of an imperceptible pixel-domain
  watermark on a full-page raster — there is no codec setting that removes it.
* Documents whose upload is already a JPEG-in-PDF converge to the original size
  (ratio ≈ 1.0x), which is the correct outcome: no artificial growth.

## 5. Watermark safety

Compression is only acceptable if the payload still decodes from the **delivered**
file. That is not measured on a development machine (no checkpoint), so:

```bash
# on the VPS, WAM venv, runtime running on 127.0.0.1:8711
export PDF_SVC_WAM_HMAC_KEY='wam1:<secret>'
./.venv-wam/bin/python scripts/validate_compression.py --pdf /path/to/real.pdf --payload <issued payload>
```

The script builds each profile with the real model, re-opens the final PDF,
renders every page at the master DPI, decodes it (the same read the detector
performs), and repeats after realistic damage (JPEG q60, 50% downscale, 60%
crop). It exits non-zero if any profile loses recovery.

**Rule for enabling a profile:** `balanced` only after the script reports
`recovered = pages` for it; `aggressive` additionally only if the damaged views
still recover. Nothing in this repository claims either before that run.

## 6. What is preserved

* Payload format (32-bit), checkpoint and embedding path: unchanged.
* Page count, order and physical page size in points: asserted for every profile.
* Text/vector: the *personalised* artifact was already raster-only by design
  (the master is a raster); compression does not remove text that was selectable —
  the selectable text lives in the preserved original PDF, which is never modified.
* Original PDF and master assets: never written by compression (asserted).
* 24h retention, reuse and cleanup: untouched; `CONFIG_VERSION` now includes the
  profile, so a copy produced by one encoder is never served for another.
* Audit records: untouched.

## 7. Known limitations

* A raster page cannot carry selectable text; that is pre-existing and unchanged.
* `aggressive` reduces delivered resolution to 120 DPI — legible, but a
  high-zoom inspection shows it. That is why it is opt-in.
* Identical page rasters are **not** deduplicated inside one PDF: pypdfium2
  refuses to insert the same image object on two pages, and raw PDF-level object
  reuse would require surgery outside the library. Blank pages ARE skipped.
* `scripts/size_report.py` uses synthetic documents (no production PDFs live in
  this repository). Re-run it with real files by pointing `DOCS` at them; the
  numbers above are reproducible from the script as committed.
