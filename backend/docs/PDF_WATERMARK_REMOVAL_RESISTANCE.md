# PDF watermark — removal resistance (measured)

This document records **what an attacker can actually do** to a delivered,
personalized PDF, measured on real files by
[`backend/tests/pdf-watermark/removal_attacks.py`](../tests/pdf-watermark/removal_attacks.py).
It is deliberately honest: the watermark raises the cost of removal and makes
tampering detectable. It is not, and does not claim to be, impossible to remove.

Everything below was produced on the development machine (PHP 8.3.35, FPDI 2.6.8,
TCPDF 6.11.4, MuPDF/pikepdf for rendering and editing). The production host runs
the same pure-PHP pipeline; **no new dependency is required to ship the fix**.

---

## 1. Why the old watermark came off in one step

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

## 2. What the implementation does now

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
expected shape: `/Rotate` ≠ 0, a Form `/BBox` offset, an indirect `/Length`, an
exotic filter chain, or an xref-stream/object-stream file. In that case the five
page-level layers (A–E) are still applied — a weaker hardening level, **never an
unwatermarked document**. Every skip is logged (`[pdf-watermark] content bake
skipped: …`).

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

## 3. Measured results

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

## 4. What still works, and why

* **Flatten → clean by tone/binarise** (`img_*`): the visible marks are a grey
  overlay on a page whose content is mostly black-on-white, so a threshold or a
  "grey → white" filter separates them. It costs the text layer (no selection, no
  search, OCR needed for accessibility), it destroys colour figures and tables
  (page 2 of the fixture keeps only 87.7 % of its content), and it cannot restore
  anything the marks changed inside glyphs — but on a plain text page it is a
  clean removal. **This is the remaining limitation; it cannot be fixed with an
  overlay.** The only counter is rasterising the page and flattening the mark
  into the pixel data (the opt-in engine B, which needs Ghostscript), and even
  that leaves the same grey-vs-black separation.
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

**Residual risk, stated clearly:** anyone who is willing to rasterise, clean by
tone and accept a damaged/OCR-only copy can produce a document without a visible
mark. The delivered PDF still identifies the recipient in its text layer, in the
baked stream, in four rails and in the trace matrix, so a leaked copy usually
survives *as evidence* even when the visible ink does not survive *as a mark*.

---

## 5. Reproducing the measurements

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
