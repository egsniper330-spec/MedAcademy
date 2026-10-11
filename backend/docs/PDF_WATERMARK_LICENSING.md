# PDF watermarking — renderer licensing decision

The flattened ("raster") watermark engine needs a program that turns PDF pages
into bitmaps. This file records what is **verified**, what is **an assumption**,
and the **decision that needs explicit approval** before the raster engine is
enabled in production. It is not legal advice.

## 1. Verified facts

- **Ghostscript is dual-licensed: AGPL v3 or a commercial license, handled
  exclusively by Artifex Software.** (`https://ghostscript.com/licensing` →
  "Licensing is handled exclusively by Artifex Software, Inc."; Artifex is the
  exclusive commercial licensing agent.)
- **AGPL v3 adds a network-use clause (section 13).** If users interact with the
  licensed Program **over a network**, the operator must offer those users the
  Corresponding Source of the Program. This is the clause that distinguishes
  AGPL from GPL.
- **Artifex has enforced Ghostscript's license in court** (Artifex Software,
  Inc. v. Hancom, Inc.), so this is not a theoretical-only concern.
- **Poppler is GPL-2.0-or-later** and ships `pdftoppm` and `pdftocairo`.
  `pdftocairo -png -transp` renders a page to a PNG with a **transparent
  background**, which is exactly what the compositing step needs. GPL has **no**
  network clause.
- **MuPDF is AGPL / commercial (also Artifex)** — same category as Ghostscript.
- **PDFium is BSD-3** and permissive, but exposes no standalone CLI renderer, so
  it would need FFI bindings or a PHP extension — not viable on shared cPanel.
- **ImageMagick is Apache-2.0, but its PDF delegate calls Ghostscript.** Using
  ImageMagick/Imagick to rasterize a PDF therefore does **not** remove the
  Ghostscript dependency.

## 2. Assumptions (must be confirmed, not assumed)

These are the points a lawyer — not this document — must decide:

1. Whether invoking `gs` (or `pdftocairo`) as a **separate subprocess** from PHP,
   without linking or modifying it, makes the MedAcademy backend a derivative or
   combined work of that program.
2. Whether offering the **already-public, unmodified** Ghostscript source
   satisfies the AGPL network clause for this deployment, or whether more is
   required.
3. The actual pricing/bundling terms of an **Artifex commercial license**.

## 3. Options

| Option | Rasterisation | Renders correctly? | License posture | Hosting | Cost |
|---|---|---|---|---|---|
| A. Ghostscript (AGPL), as implemented | `gs -sDEVICE=pngalpha` | Yes (design verified by harness) | AGPL — needs legal sign-off, or a commercial license | Needs `gs` + `proc_open` | Free (AGPL) |
| B. Artifex commercial Ghostscript | same code | Yes | Removes AGPL | same | Paid (terms from Artifex) |
| C. Poppler (`pdftocairo -png -transp`) | new backend driver | Expected equivalent; **not yet implemented or verified** | GPL — no network clause; further from the AGPL concern, still copyleft | Needs poppler-utils + `proc_open` | Free |
| D. Stay on the vector engine only | FPDI/FPDF (no raster) | Yes, but keeps a selectable text layer | Permissive | Works on plain shared cPanel | Free |
| E. Managed rendering API/microservice | external | Depends on vendor | Vendor terms | No local binary | Paid |

Notes:

- Option **C would require new backend code and its own integration tests**
  before it could replace A. It is described here as an option, not a commitment.
- Option **A/B are the only paths wired today**; switching the binary is a config
  change only for B (same `gs` interface).
- Option **D is the current safe default for a host without a renderer**: it is
  already implemented, tested structurally, and never serves the original.

## 4. Decision required

Pick exactly one before enabling `PDF_WATERMARK_MODE=raster` in production:

- [ ] **A** — accept AGPL Ghostscript, with counsel sign-off and documented
      AGPL compliance (offer the corresponding source).
- [ ] **B** — obtain an Artifex commercial Ghostscript license.
- [ ] **C** — approve adding a Poppler-backed renderer, then implement + test it.
- [ ] **D** — ship the vector engine only; keep raster disabled.

## 5. What was NOT done

No new renderer dependency was added, no binary was downloaded, and no
alternative renderer was assumed compatible. Only the already-present
Ghostscript interface is used, and it is gated behind `PDF_WATERMARK_MODE`.
