# PDF watermarking — renderer licensing, cost and the decision taken

Flattening a watermark into a page has two possible shapes:

- **write it into the page's own content stream** (pure PHP, no external program), or
- **rasterise the page** (render it to a bitmap), which needs a *renderer*.

Only the second needs a third-party program. This file records which programs were
evaluated, what their licences actually require, what the running system uses
today, and the decision that follows from it. It is engineering evidence, not
legal advice.

## 1. What the pipeline actually uses (verified in the repository, 2026-10-24)

| Component | Version | How it runs | Licence (from installed metadata) | Cost |
|---|---|---|---|---|
| `setasign/fpdf` | 1.9.0 | PHP library, in-process | MIT | none |
| `setasign/fpdi` | 2.6.9 | PHP library, in-process | MIT | none |
| `tecnickcom/tcpdf` | 6.11.4 | PHP library, in-process | LGPL-3.0-or-later | none |
| PHP GD (+ FreeType) | bundled with PHP | PHP extension | PHP licence (BSD-style) | none |
| ImageMagick / Imagick | optional | PHP extension | ImageMagick licence (Apache-like) | none |
| **Ghostscript** | 10.08.0 *(only if raster mode is enabled)* | separate `gs` process | **AGPL-3.0 or Artifex commercial** | **free only if you comply with the AGPL** |

`composer.json` declares exactly three dependencies (`ext-zlib`, `setasign/fpdf`,
`setasign/fpdi`, `tecnickcom/tcpdf`) and the application itself has no other
runtime dependency. Versions above are read from `backend/vendor/composer/installed.json`.

**No external service is involved.** A search of
`backend/src/Services/PdfWatermarkService.php`,
`backend/src/Services/PdfWatermarkBaker.php` and
`backend/src/Controllers/MaterialDeliveryController.php` finds no `curl_*`,
no `file_get_contents('http…')`, no SDK client, no API endpoint and no
credential: the pipeline never leaves the machine, and needs no internet
connection to watermark a document.

## 2. Renderer licence findings (checked against the publishers)

| Renderer | Licence | Closed-source commercial server use | Installable on shared cPanel |
|---|---|---|---|
| **Ghostscript** | AGPL-3.0 **or** Artifex commercial | Artifex's own licensing page says you may not deploy its open-source build as part of a server-based application or service without disclosing that application's source under the AGPL; otherwise a commercial licence is required (`https://artifex.com/licensing`, `https://ghostscript.com/licensing/`) | only if the host provides the binary and allows `proc_open` |
| **MuPDF** (`mutool`) | AGPL-3.0 or Artifex commercial | same category as Ghostscript (`https://mupdf.readthedocs.io/en/1.27.0/license.html`) | no |
| **Poppler** (`pdftoppm`, `pdftocairo`) | GPL-2.0-or-later | GPL has **no** network clause; invoking a separate, unmodified binary on your own server is not distribution. Shipping or linking it would be (`https://poppler.freedesktop.org/`) | no (needs `poppler-utils` installed by the host) |
| **PDFium** | BSD-style (the repo `LICENSE` is BSD-3-Clause plus Apache-2.0 text) | yes | no: no supported prebuilt CLI; needs FFI bindings or a compiled `pdfium_test`, plus `php-ffi` |
| **ImageMagick** | ImageMagick licence (Apache-like) | yes for ImageMagick itself | the *PDF delegate calls Ghostscript*, and its security policy often blocks PDF entirely (`https://imagemagick.org/formats/`, `/security-policy/`) — so it does **not** remove the Ghostscript dependency |
| **pdf.js** (Node) | Apache-2.0 (+ `@napi-rs/canvas`, MIT) | yes | needs Node **and** a native canvas build on the host; unverified for this deployment |

Ghostscript publishes **no price list**: commercial terms are use-case specific
and quoted by Artifex sales. We did not request a quote and did not buy anything.

## 3. Decision (implemented)

The product needs a flattened, single-centred-mark page. Rasterisation is the only
way to also remove the text layer, but every renderer that could run on this
hosting is copyleft-or-paid, and none of the permissively licensed ones can be
installed and verified on shared cPanel. So:

**D1 — the shipped flattened engine needs no renderer at all.**
`PDF_WATERMARK_MODE=flatten` writes ONE centred diagonal mark as PDF operators into
each imported page's own content stream (`PdfWatermarkBaker`). It executes nothing
outside the vendored MIT/LGPL PHP libraries: no `gs`, no shell, no network, no
extra font file. This is the free, commercially safe flattening path, and it is
the one this task recommends for production.

**D2 — the raster engine stays, but is double-gated.**
`PDF_WATERMARK_MODE=raster` now needs BOTH the mode *and*
`PDF_WATERMARK_ACCEPT_AGPL_RENDERER=1`. Without the second switch the engine
reports itself unavailable and delivery fails closed with **503** — it never runs
AGPL software on a commercial install by accident. Set that switch only with an
Artifex licence or a documented AGPL position (Artifex has enforced this licence in
court: *Artifex Software, Inc. v. Hancom, Inc.*).

`PDF_WATERMARK_MODE=auto` never selects raster, so the default product path has
no licence exposure and no binary requirement.

**D3 — this was not silently decided.** If a fully rasterised page is required
later, the licence-safe candidates are PDFium (BSD) on a VPS with `php-ffi`, or
pdf.js + `@napi-rs/canvas` on a host running Node. Both are infrastructure
changes that must be approved and verified on the target host first; neither is
claimed here to work on the current shared hosting.

## 4. Recurring cost of the current design

| Item | Recurring cost |
|---|---|
| FPDF, FPDI, TCPDF, GD, Imagick | **0** |
| External APIs / subscriptions / per-document fees | **0** — nothing is sent off the machine |
| Ghostscript | **0** while raster mode stays disabled; a paid Artifex licence if it is enabled commercially |
| Extra infrastructure | **0** — no VPS, no queue, no object store beyond the existing private bucket |

The only obligations that are not monetary: keep the MIT notices for FPDF/FPDI and
the LGPL notice for TCPDF (they ship inside `backend/vendor`, unmodified, which is
what LGPL-3.0 requires for a dynamically loaded PHP library).

## 5. What was NOT verified

- Artifex's commercial price for Ghostscript (not requested).
- Whether any specific cPanel host ships `gs`, `pdftoppm` or Node. The code
  detects each at runtime and fails closed when it is missing.
- Legal advice. D2 encodes a conservative engineering position; a lawyer may
  take a different view of subprocess use of GPL software.
