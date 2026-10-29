# PDF watermark — removal resistance (measured)

This document records **what an attacker can actually do** to a delivered,
personalized PDF, measured on real files by
[`backend/tests/pdf-watermark/removal_attacks.py`](../tests/pdf-watermark/removal_attacks.py).
It is deliberately honest: the watermark raises the cost of removal and makes
tampering detectable. It is not, and does not claim to be, impossible to remove.

The historical vector-engine measurements in §§1–5 and the 2026-10-24
opacity comparison in §7 were produced on the development machine (PHP 8.3.35,
FPDI 2.6.8, TCPDF 6.11.4, MuPDF/pikepdf for rendering and editing). They describe
an earlier implementation, **not current student delivery**. Since 2026-10-29,
student delivery is raster-only: Ghostscript renders each page and the identity
mark is composited into the pixels. Legacy vector and renderer-free flatten
modes are refused for delivery. See §6 and
[`PDF_WATERMARK_VERIFICATION_REPORT.md`](PDF_WATERMARK_VERIFICATION_REPORT.md)
for current behavior and measured artifacts. Production enablement remains
blocked pending Ghostscript licensing and target-host review; this document is
not approval to deploy.

---

## 1. Historical vector implementation — why its watermark came off in one step

The previous implementation put every mark in ONE block of operators at the start
of the *page* content stream, while the lecture itself was a single imported Form
XObject:

```
page content stream
├── [ 27 × "Tj" identity marks ]      ← the entire watermark, one region
├── /TPL0 Do                          ← the whole lecture page (Form XObject)
└── [ 1 edge identity line ]
```

Nothing tied the mark to the lecture. A tool that keeps `/TPL0 Do` and drops the
rest of the page operators produces a **complete, unwatermarked page** — no
content lost, no repair needed, a few lines of script. Measured: **99.99 % of the
watermark ink removed, 100 % of the content preserved, identity gone from the
text layer** (`pdf_keep_page_form` / `pdf_text_strip` below).

A second, independent weakness followed from placement: because the grid was
drawn *behind* the page and only anchored on a lattice that ran off the sheet,
the marks appeared almost exclusively in white space, many of them clipped at the
page edge (that is why ids arrived as `MED-0…`).

---

## 2. Historical vector implementation (not used for current student delivery)

Per page (`PdfWatermarkService::renderWithTcpdfFpdi`), six representations:

| Layer | Where | Purpose |
|---|---|---|
| **A. Back grid** | before the imported page | legible in margins, never over a diagram |
| **B. Front marks** | after the imported page | crosses body text, tables and figures — hiding them means hiding the lecture |
| **C. Trace lattice** | after the page | ~100 non-text dots + an 8×4 **trace-code** matrix (32-bit fingerprint of the recipient) |
| **D. Rails** | after the page | complete identity on all four edges, measured so the id is never clipped |
| **E. Interior anchor** | after the page, inside the content area | one 8 pt line at alpha 0.85 / 62-grey — dark enough to survive a flatten+threshold and away from every edge so a crop cannot reach it |
| **F. Baked marks** | *inside* the imported page stream | 8 identity marks + 48 dots + a second trace matrix appended to the stream that holds the lecture |

Key structural change — **baking** (`PdfWatermarkBaker`): after TCPDF writes the
file, the marks are appended to the imported page's own content stream and the
font/alpha resources are added to that Form's `/Resources`. The stream now holds
the lecture *and* the watermark, so:

* deleting "the watermark block" no longer exists as an operation;
* removing the marks means editing the same stream as the lecture;
* deleting the whole Form XObject deletes the lecture too.

Layer E exists specifically for the *combination* attack (flatten → threshold →
crop the margins): the tinted layers are what a threshold removes and the rails
are what a crop removes, but the anchor sits in the middle of the sheet, so
after both steps the recipient id is still on the page — see
`combo_binarize_crop` in §3. It is the smallest layer (~0.1 % of the page) and
the only one drawn opaque enough to remain below a 128 threshold; it crosses at
most one line of lecture text.

Baking is skipped (never on a best-effort basis) when the page does not match the
expected shape: a Form `/BBox` that is neither the page size nor its width/height
swap, a non-identity page-level `cm`, an unparseable or singular Form `/Matrix`,
an indirect `/Length`, an exotic filter chain, or an xref-stream/object-stream
file. **Rotated source pages (`/Rotate` 90/180/270) DO bake**: FPDI carries the
rotation in the Form's `/Matrix`, and the baker pre-multiplies that matrix's
inverse into the appended block so the marks land upright in page coordinates —
asserted for every rotated page by `run_real_test.php` (the scan decodes
FlateDecode streams first; a raw-byte scan would report zero bakes on
compressed output). In any skip case the five page-level layers (A–E) are still
applied — a weaker hardening level, **never an unwatermarked document**. Every
skip is logged with a per-page reason (`[pdf-watermark] content bake skipped:
page N: …`).

Layout is seeded from `sha256(layers-version | identity | page | page-size)`, so
the same document always renders identically while two recipients get completely
different mark positions — there is no fixed mask to prepare.

Reasons for the chosen parameters:

* **readability** — front marks are 30 % opacity of a mid grey: black body text
  becomes ≈ 33/255 (contrast ≈ 6:1 against the 213/255 it leaves on paper);
* **no clipping** — every text mark is measured with `GetStringWidth()` and its
  rotated bounding box is shifted inside the page (`fittedOrigin`);
* **no space wasted on branding** — the repeated text is the recipient identity
  (`Name • MED-####`); the old `MedAcademy — do not share` line is gone, so the
  id no longer competes for the space it needed.

---

## 3. Historical vector-engine measurements

Fixture: `fixtures/source.pdf` — 4 pages (A4 text + vector chart, landscape
table, US-Letter page, dense reference table). Compare the **old** delivered file
(preserved at `.freebuff/pdf-watermark-tests/removal/baseline/student-a.pdf`) with
the **new** one, both rendered at 150 dpi against the unwatermarked source.

`removed` = share of watermark ink that no longer differs from the source render.
`content` = share of the source's dark ink that is still dark afterwards.
`id in text` = pages whose extractable text still contains the identity.

| Attack | removed (old → new) | content kept (old → new) | id in text (old → new) |
|---|---|---|---|
| `pdf_text_strip` — delete every text operator | **99.99 → 73.58 %** | 100 → 99.74 % | 0/4 → **4/4** |
| `pdf_keep_page_form` — keep only `/TPLn Do` | **99.99 → 74.52 %** | 100 → 99.74 % | 0/4 → **4/4** |
| `pdf_identity_redact` — delete only identity runs | 87.79 → 56.04 % | 100 → 99.74 % | 4/4 → 4/4 |
| `pdf_image_strip` — remove page-level images | 0 → 0 % | 100 → 99.75 % | 4/4 → 4/4 |
| `pdf_white_boxes` — white out every identity match | 47.23 → 84.22 % | **54.80 → 43.02 %** | 4/4 → 4/4 |
| `pdf_edge_strips` — white bands over the margins | 19.19 → 11.63 % | 99.65 → 99.45 % | 4/4 → 4/4 |
| `pdf_fullpage_wash` — 60 % white sheet | 97.29 → 50.00 % | **0.01 → 0.01 %** | 4/4 → 4/4 |
| `pdf_crop_inset` — crop 36 pt off each edge | 0.00 → 0.01 % | 99.98 → 99.76 % | 4/4 → 4/4 |
| `img_tone_window` — flatten, map grey 150–250 to white | 97.99 → 91.85 % | 98.22 → 97.97 % | 0/4 → 0/4 |
| `img_binarize_190` — flatten, threshold 190 | 97.52 → 90.83 % | 98.61 → 98.35 % | 0/4 → 0/4 |
| `img_binarize_128` — flatten, threshold 128 | 98.44 → 92.44 % | 97.89 → 97.61 % | 0/4 → 0/4 |
| `combo_binarize_crop` — flatten + threshold 190 + crop 36 pt | n/a → 91.49 % | 98.32 % | 0/4 → 0/4 (visible anchor + rail remain) |

Coverage and cost:

| Metric | Old | New |
|---|---|---|
| watermark ink (% of page area) | 2.05 % | 3.90 % |
| watermark ink inside the content area | 45.03 % | **51.70 %** |
| lecture text blocks touched by a mark | 98.39 % | **100 %** |
| watermark ink painted directly over lecture ink | ~0 % | **0.74 %** |
| lecture ink still dark (< 140) | 100 % | **100 %** |
| lecture ink mean luminance (0 = black) | 0 | 11–20 |
| pages | 4 | 4 |
| delivered file size | 115,071 B | 133,190 B (+15.7 %) |
| generation time (4 pages) | ~0.4 s | 0.23 s warm / 2.5 s with cold font setup |

---

## 4. Historical vector-engine attack analysis (not current delivery behavior)

* **Flatten → clean by tone/binarise** (`img_*`) is a historical attack on the
  vector output above: a threshold or a "grey → white" filter separates its
  overlay from mostly black-on-white page content. That loses the text layer,
  destroys colour figures and tables (page 2 of that fixture kept only 87.7 % of
  its content), and cannot restore anything the marks changed inside glyphs.
  Those results do not describe current delivery. Current delivery is already
  rasterized; its measured image-domain attacks and content-loss trade-offs are
  in §6. Rasterization does not make a watermark impossible to remove.
* **White boxes over the marks** still hide most of the ink (84 %), but they now
  cover the lecture as well (content kept falls to 43 %). A student who does it
  hands in a visibly damaged document.
* **Crop** no longer helps: marks exist on all four edges and across the middle,
  so a crop either keeps a rail, keeps the interior anchor, or removes content.
* **The combination** (`combo_binarize_crop`): flattening and thresholding the
  page removes 91.5 % of the tinted ink, and cropping 36 pt drops the edge rails
  — but the interior anchor survives both, and so does part of one vertical rail.
  Measured on the real file: after the full sequence page 1 still shows
  `Test Student Alpha • MED-0042` in the middle of the page. Removing that means
  painting over lecture content, which is the visible-damage trade-off above.
* **The dot lattice and trace matrix survive text deletion.** Removing them is
  not a text operation; it requires editing the page/Form streams and repainting
  the region, and the code in the matrix (`PdfWatermarkService::traceCode()`) is
  what lets support staff prove a copy was issued to a given account.

**Historical residual risk of the vector output:** a person willing to rasterise
and clean by tone could produce a damaged/OCR-only copy without a visible mark.
That old output also retained the recipient in its text layer, baked stream,
rails and trace matrix. Current raster output has no searchable identity/text
layer; do not apply those historical evidence claims to it. Image-domain
removal remains possible at the content-quality cost measured in §6.

---

## 5. Reproducing the historical vector-engine measurements

The harness is a developer tool; it needs packages the product never uses:

```bash
python -m pip install pikepdf pymupdf numpy pillow
python backend/tests/pdf-watermark/removal_attacks.py \
    --pdf  <delivered.pdf> \
    --source <original.pdf> \
    --identity "Test Student Alpha • MED-0042" --id MED-0042 \
    --outdir /tmp/removal
```

`--outdir` receives one PDF per attack plus `removal-report.json`. Tools used:
pikepdf (content-stream editing, the same operations qpdf/mutool expose), MuPDF
(rendering, text extraction, flattening), Pillow/NumPy (image-domain attacks).
None of them is installed on the production host and none is needed there.

---

## 6. Current student delivery — raster-only, measured on the delivered file

This section describes the **current** delivery engine; the preceding vector
measurements are historical. Student PDFs are raster-only: each page is rendered
to a bitmap, ONE large centered mark is composited into that bitmap, and the
result is embedded as a single full-page image. There is no separate watermark
object or text layer to remove. Current fixture structure:

| Structure of a current raster copy (4-page fixture, measured) | Count |
|---|---|
| embedded image XObjects | 4 (one per page) |
| `/Type /Font` objects | 0 |
| annotations / widgets | 0 |
| Form XObjects (imported original pages) | 0 |
| optional-content groups (watermark layers) | 0 |
| extractable text characters | 0 |
| page content stream | 53 bytes: `q … cm /I1 Do Q` |

So the object-level attacks that editors expose ("remove watermark", delete the
watermark layer, delete the watermark text, delete the annotation) have **no
target**. Image-domain edits remain possible, as the measurements below show.

Measured with `raster_attacks.py` (PyMuPDF + NumPy; each attack applied to BOTH
the delivered copy and the unwatermarked source, then differenced at the engine's
own 200 DPI so glyph edges cancel):

| Attack | Mark ink surviving | Lecture ink kept | Delivered page kept |
|---|---|---|---|
| delete every text-showing operator | **97.9 %** | 16.6 % | 100 % |
| delete annotations / widgets | **100 %** | 100 % | 100 % |
| delete image draw operators | mark gone **because the page is gone** | 100 % (source untouched) | **0.0 %** |
| flatten + threshold < 190 | **64.2 %** | 175 %\* | 89.8 % |
| flatten + threshold < 128 | **0.34 %** | 152 %\* | 49.9 % |
| whiten the mid-grey band (90-235) | **0.57 %** | 100 % | 36.9 % |
| opaque white box over the mark bbox | **0.0 %** | 2.1 % | 0.8 % |
| crop 36 pt off every edge | **2.4 %** of the remaining area | 100 % | — |

Baseline: the centred mark is 110 669 px = 2.86 % of a 1654×2339 page.

\* "Lecture ink kept" above 100 % is not a gain: thresholding turns every
antialiased glyph edge into solid black, so the count of dark pixels rises while
the rendering is destroyed (colours and grey images are gone).

Reading the table honestly:

* **No non-destructive edit removes the mark.** Deleting text operators,
  deleting annotations and cropping all leave 97-100 % of the mark ink; the only
  way to drop the page image is to delete the page.
* **Destructive "cleaning" does work, and is visible.** Thresholding at 128 or
  whitening the grey band erases the mark, but leaves 37-50 % of the page's
  pixels: every colour, every grey image, every antialiased edge and the whole
  photographic content of a slide deck are gone. Covering the mark with a white
  box (0 % mark) also destroys the content under it (2 % kept).
* **The invisible-information attack is gone.** On the historical vector output,
  a colour-preserving re-save could strip the mark while keeping lecture text
  selectable (see §4). Current raster output has no text layer to retain; this
  removes that specific trade-off, not all possible pixel-level removal.

Reproduce:

```bash
python backend/tests/pdf-watermark/../../.freebuff/pdf-watermark-tests/raster_attacks.py \
    --delivered <delivered.pdf> --source <original.pdf> \
    --outdir /tmp/raster-attacks --dpi 200
```

It needs only `pymupdf` and `numpy` (no pikepdf, no Pillow) and writes
`raster-attacks.json` next to one PDF per attack.

---

## 7. Historical 12% opacity comparison (measured 2026-10-24; not current policy)

In the historical implementation, the single centred mark composited at
**`PDF_WATERMARK_OPACITY` = 0.12** in ONE pass, over a 107-grey face. Measured on
blank paper (the only non-white pixel on the sheet is the mark, so its luminance
*is* the result):

| Historical engine | mark core luminance | measured effective opacity | mark vs white paper |
|---|---|---|---|
| `flatten` (legacy, refused for delivery) | 237 / 255 | **0.122** | 1.17 : 1 |
| `raster` (Ghostscript 10.08.0) | 237 / 255 | **0.122** | 1.17 : 1 |

In that historical comparison, body text under the mark measured **mean 9.2**
(`flatten`) and **3.6** (`raster`) of 255, i.e. a **17 : 1** contrast ratio
against the marked paper. Before that change the same setting produced a face
at `0.55 + 1.5 × 0.15 = 0.775` alpha (≈ 132 luminance) with an eight-times-
dilated white halo — the reason the delivered page read as a grey banner.

### What that costs (attacks applied to the delivered page itself)

Percentages are of the mark's OWN pixels (from the matching blank-page render),
so no cross-render subtraction is involved:

| Attack | mark survives (`flatten`) | mark survives (`raster`) | page content kept |
|---|---|---|---|
| binarize, threshold < 226 | 6.2 % | 16.0 % | greys/colour destroyed |
| binarize, threshold < 190 | **0.6 %** | 13.2 % | greys/colour destroyed |
| binarize, threshold < 128 | 0.2 % | 10.4 % | greys/colour destroyed |
| whiten the 225–245 band | 3.5 % | 18.5 % | text kept, tint removed |
| crop 36 pt off every edge | 100 % | 100 % | centred mark unaffected |

**Conclusion, stated plainly:** a 12 % mark is comfortable to read under and easy
to see, but it does **not** survive binarization or a narrow grey-window
whitening — both of which destroy the document's colour, greys and photographic
content. The heavier 0.78-alpha mark of the previous build survived the <190
threshold (it came back as black ink); it did not survive <128 either. So the
deterrence lost is one threshold step, and the readability gained is roughly a
six-fold reduction in ink.

This opacity comparison was measured on the prior implementation and is
historical evidence only. The suggestion to use the layered vector engine is
obsolete: vector and renderer-free flatten modes are refused for current student
delivery. Current raster settings and the verified 2026-10-29 measurements are
documented in [`PDF_WATERMARK_VERIFICATION_REPORT.md`](PDF_WATERMARK_VERIFICATION_REPORT.md).
