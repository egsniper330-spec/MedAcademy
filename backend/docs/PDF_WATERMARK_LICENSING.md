# PDF watermarking — renderer licensing, cost and the decision taken

The enforced delivery contract requires each page to be rasterized and emitted
as one image, with the authenticated identity composited into the page pixels.
This file records the renderer licence constraints and the production blocker;
it is engineering evidence, not legal advice. The legacy pure-PHP vector and
flatten engines remain for compatibility/policy tests but are refused for
student delivery.

## 1. What the pipeline actually uses (verified in the repository, 2026-10-29)

| Component | Version | How it runs | Licence (from installed metadata) | Cost |
|---|---|---|---|---|
| `setasign/fpdf` | 1.9.0 | PHP library, in-process | MIT | none |
| `setasign/fpdi` | 2.6.8 (test harness lock) | PHP library, in-process | MIT | none |
| `tecnickcom/tcpdf` | 6.11.4 | PHP library, in-process | LGPL-3.0-or-later | none |
| PHP GD (+ FreeType) | bundled with PHP | PHP extension | PHP licence (BSD-style) | none |
| ImageMagick / Imagick | optional | PHP extension | ImageMagick licence (Apache-like) | none |
| **Ghostscript** | 10.08.0 (required by delivery) | separate `gs` process | **AGPL-3.0 or Artifex commercial** | **free only if you comply with the AGPL** |

`composer.json` declares exactly three dependencies (`ext-zlib`, `setasign/fpdf`,
`setasign/fpdi`, `tecnickcom/tcpdf`) and the application itself has no other
runtime dependency. The test harness run used the exact versions listed; production package versions
should be confirmed from `backend/vendor/composer/installed.json` after building.

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

## 3. Decision and production blocker (implemented)

**D1 — raster is the only permitted delivery engine.** `PDF_WATERMARK_MODE`
defaults to `raster`; legacy `auto` also resolves to raster. Explicit `vector`
and `flatten` modes are refused for student delivery because they preserve
searchable source objects and do not satisfy the one-image-per-page contract.
If raster rendering is unavailable or not explicitly licence-acknowledged,
delivery fails closed with HTTP 503; the original is never a fallback.

**D2 — Ghostscript use is explicitly gated, but the gate is not legal approval.**
Raster delivery requires Ghostscript plus the compositor/font/output prerequisites
and `PDF_WATERMARK_ACCEPT_AGPL_RENDERER=1`. Production must not set that flag
until the operator has obtained an Artifex commercial licence or documented an
AGPL compliance position with qualified counsel. Setting the environment flag
merely records the operator's decision; it does not grant rights or establish
compliance. Artifex's published licensing position and the potential scope of
AGPL obligations require a case-specific legal review.

**D3 — production deployment remains blocked.** The local Windows harness
acknowledged Ghostscript solely to verify the raster implementation. No legal
opinion, Artifex quote or purchase, cPanel compatibility check, or production
configuration was obtained. Do not deploy/enable delivery until those decisions
and host prerequisites are resolved.

**D4 — alternatives are not a workaround already approved.** PDFium (BSD) on
infrastructure with a supported binding, or pdf.js + `@napi-rs/canvas` on a Node
host, could be separately evaluated. Neither is integrated or verified for the
current shared-hosting deployment; adopting one would require an approved
infrastructure change and a new compatibility/security review.

## 4. Recurring cost of the current design

| Item | Recurring cost |
|---|---|
| FPDF, FPDI, TCPDF, GD, Imagick | **0** |
| External APIs / subscriptions / per-document fees | **0** — nothing is sent off the machine |
| Ghostscript | Required by the implemented delivery path; commercial pricing was not requested and any AGPL use requires an independently reviewed compliance position |
| Extra infrastructure | **0** — no VPS, no queue, no object store beyond the existing private bucket |

The MIT notices for FPDF/FPDI and LGPL notice for TCPDF must also be preserved;
confirm the exact shipped versions and applicable obligations when building
`backend/vendor/`.

## 5. What was NOT verified

- Artifex's commercial price for Ghostscript (not requested).
- Legal advice or whether the intended service can comply with AGPL obligations.
- Whether the target cPanel host supplies Ghostscript, `proc_open`, GD/FreeType
  or Imagick, an appropriate TTF font, and sufficient resource limits.
- Arabic-script watermark rendering and representative production PDFs.
- Whether PDFium or a Node-based renderer could be supported on an approved
  alternative host.
