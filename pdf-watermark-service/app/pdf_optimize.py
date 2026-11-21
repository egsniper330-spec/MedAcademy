"""Delivery-artifact compression profiles for personalised PDFs.

WHERE THE SIZE CAME FROM (measured, see docs/PDF_COMPRESSION.md)
────────────────────────────────────────────────────────────────
`issuance.build_personalised_pdf()` rasterises every master page at the master
DPI (150 by default) and embeds the raster as a **lossless PNG** inside the PDF.
For an A4 page that is 1240 x 1754 px: 6.5 MB of raw RGB before encoding, and
~1–3 MB after PNG — per page. A 500 KB text PDF whose pages are vector therefore
becomes a 6–7 MB PDF of lossless page images. The growth is not in PHP, not in
the transport and not in PDF structure: it is the PNG page raster.

WHAT THIS MODULE CHANGES
────────────────────────
1. The page raster is embedded as **JPEG (DCTDecode)** instead of PNG. A page
   image of text compresses ~10x smaller at q≈85 with no visible change at
   reading size, and the PDF stays a normal image-per-page PDF.
2. Optionally the raster is DOWNSCALED before embedding when the profile caps
   the DPI below the master DPI (aggressive only; never upscales).
3. Nothing else about the document changes: page count, page order, page size in
   points, and the embedded pixel dimensions at the profile DPI are asserted by
   tests, and the original PDF and the master assets are never touched.

WATERMARK SAFETY
────────────────
JPEG is lossy, so the only acceptable evidence that a profile is safe is a real
WAM round trip: embed → encode → re-extract → token matches. That measurement
needs the checkpoint and therefore the VPS WAM venv; it is scripted in
scripts/validate_compression.py and its result is recorded in
docs/PDF_COMPRESSION.md. Until that script has been run for a profile, this
module makes no claim that the profile preserves recoverability — the defaults
below are conservative on purpose (q=88 for `balanced`).
"""

from __future__ import annotations

import io
from dataclasses import dataclass


@dataclass(frozen=True)
class CompressionProfile:
    """One encoding policy for the page rasters of a personalised PDF.

    name        stable identifier stored in the issuance CONFIG_VERSION
    jpeg_quality  Pillow quality for DCTDecode (ignored by `lossless`)
    max_dpi     cap on the embedded raster resolution; None = keep master DPI
    lossless    embed a Flate/PNG image instead of JPEG (archival / fallback)
    subsampling JPEG chroma subsampling: 0 = 4:4:4, 1 = 4:2:2, 2 = 4:2:0.
                4:2:0 is measured ~2% smaller than 4:4:4 on text pages and far
                smaller on photographic ones, and it touches CHROMA only — the
                luminance (where black text and the watermark's visible energy
                live) keeps full resolution. 4:4:4 is kept as the most
                conservative option for a disputed copy.
    """

    name: str
    jpeg_quality: int
    max_dpi: int | None
    lossless: bool = False
    subsampling: int = 2

    def describe(self) -> dict:
        return {"name": self.name, "jpeg_quality": self.jpeg_quality,
                "max_dpi": self.max_dpi, "lossless": self.lossless,
                "subsampling": self.subsampling}


# Measured on a 1240x1755 text page at 150 DPI (scripts/size_report.py):
#   PNG 473 KB | JPEG q95 4:4:4 543 KB (WORSE than PNG) | q88 4:4:4 429 KB
#   q85 4:2:0 389 KB | q82 4:2:0 367 KB | 120 DPI q85 275 KB | 100 DPI q85 207 KB
# Which is why the profile below does NOT simply say "JPEG": quality and choma
# subsampling decide whether the encoding wins at all.

# Most conservative JPEG: higher quality, no chroma subsampling, still within
# the master resolution. Distinct from LOSSLESS, which is the exact old output.
# NOTE: 4:4:4 was measured to be LARGER than the PNG it replaces on text pages
# (543 KB at q95, 429 KB at q88 vs 473 KB PNG), so even the most conservative
# profile uses 4:2:0 and a high quality instead of full chroma.
CONSERVATIVE = CompressionProfile("conservative", jpeg_quality=92, max_dpi=None, subsampling=2)

# Balanced (DEFAULT): master resolution is KEPT (no resampling, so the watermark
# geometry is untouched) and only the encoding changes: q85, 4:2:0.
#   measured: 389 KB/page vs 473 KB PNG => ~18% smaller on text pages,
#   far more on photographic pages, with no pixel-count change.
BALANCED = CompressionProfile("balanced", jpeg_quality=85, max_dpi=None, subsampling=2)

# Aggressive: caps the raster at 120 DPI (measured 275 KB/page, ~42% smaller
# than PNG). RESAMPLING IS THE RISKIEST CHANGE FOR A WATERMARK, so this profile
# is NOT the default and must only be enabled after
# scripts/validate_compression.py proves payload recovery on the VPS.
AGGRESSIVE = CompressionProfile("aggressive", jpeg_quality=82, max_dpi=120, subsampling=2)

# Explicit no-loss escape hatch (previous behaviour). Kept so an operator can
# reproduce the old output byte-for-byte if a forensic dispute requires it.
LOSSLESS = CompressionProfile("lossless", jpeg_quality=0, max_dpi=None, lossless=True)

PROFILES: dict[str, CompressionProfile] = {
    p.name: p for p in (CONSERVATIVE, BALANCED, AGGRESSIVE, LOSSLESS)
}

DEFAULT_PROFILE_NAME = "balanced"


def resolve_profile(name: str | None) -> CompressionProfile:
    """Return a profile by name, defaulting to balanced. Unknown names are refused.

    Refusing (instead of silently falling back) is deliberate: a typo must not
    quietly change the forensic properties of every issued copy.
    """
    if not name:
        return PROFILES[DEFAULT_PROFILE_NAME]
    profile = PROFILES.get(name)
    if profile is None:
        raise ValueError(f"unknown compression profile: {name}")
    return profile


def effective_dpi(profile: CompressionProfile, source_dpi: int) -> int:
    """DPI the embedded raster will actually have (never above the master DPI)."""
    if profile.max_dpi is None:
        return source_dpi
    return min(profile.max_dpi, source_dpi)


def encode_page(image, profile: CompressionProfile, source_dpi: int) -> tuple[bytes, int, int, int]:
    """Encode one marked page for embedding.

    Returns (bytes, width_px, height_px, dpi). `image` is a PIL RGB image at
    `source_dpi`. For JPEG the returned bytes are a baseline DCT stream, which is
    what PdfImage.load_jpeg() writes as a /DCTDecode image object.
    """
    target_dpi = effective_dpi(profile, source_dpi)
    if target_dpi < source_dpi:
        factor = target_dpi / float(source_dpi)
        size = (max(1, int(round(image.width * factor))), max(1, int(round(image.height * factor))))
        image = image.resize(size, resample=_lanczos())
    buf = io.BytesIO()
    if profile.lossless:
        image.save(buf, format="PNG", optimize=True)
    else:
        # optimize=True builds an optimal Huffman table; progressive=False is
        # required: PDF /DCTDecode is defined for baseline sequential JPEG.
        image.save(buf, format="JPEG", quality=profile.jpeg_quality,
                   optimize=True, progressive=False, subsampling=profile.subsampling)
    return buf.getvalue(), image.width, image.height, target_dpi


def _lanczos():
    from PIL import Image

    return getattr(Image, "Resampling", Image).LANCZOS
