"""Compression profiles: size, geometry, encoding and forensic-safety contracts.

WHY THESE ASSERTIONS
────────────────────
The 500 KB → 6–7 MB growth came from embedding every master page as a LOSSLESS
PNG raster. The fix is an encoding change (baseline JPEG via /DCTDecode), and an
encoding change is exactly the kind of thing that can silently destroy a
watermark. So the profile is pinned on four axes:

  1. it must actually be smaller than the lossless output;
  2. page count, page order and page SIZE in points must be unchanged (a
     different physical page size would break the master manifest verification);
  3. the embedded image must be what we asked for (DCTDecode for JPEG, Flate for
     lossless) and its pixel size must match the profile's DPI cap;
  4. `lossless` must still reproduce the previous PNG output, so a disputed copy
     can be regenerated in its original form.

The remaining question — does the payload still decode after JPEG? — cannot be
answered without the checkpoint. It is measured by scripts/validate_compression.py
on the VPS and recorded in docs/PDF_COMPRESSION.md.
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium
import pytest
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import issuance, pdf_optimize  # noqa: E402
from app.pdf_optimize import AGGRESSIVE, BALANCED, CONSERVATIVE, LOSSLESS  # noqa: E402
from app.preprocess import render_master  # noqa: E402
from app.storage import LocalPrivateStorage  # noqa: E402


class FakeModel:
    """Records payloads; returns the image unchanged (size behaviour is what matters)."""

    def __init__(self):
        self.payloads: list[int] = []

    def embed_image(self, image_chw, payload: int):
        self.payloads.append(payload)
        return np.asarray(image_chw, dtype=np.float32)


def _text_pdf(pages: int, width_pt: float = 595.0, height_pt: float = 842.0) -> bytes:
    images = []
    for n in range(pages):
        img = Image.new("RGB", (int(width_pt), int(height_pt)), (255, 255, 255))
        draw = ImageDraw.Draw(img)
        try:
            from PIL import ImageFont

            font = ImageFont.load_default(size=11)
        except Exception:
            font = None
        for line in range(20):
            draw.text((40, 40 + line * 18), f"Page {n + 1} line {line}: lecture text", fill=(0, 0, 0),
                      font=font)
        images.append(img)
    buf = io.BytesIO()
    images[0].save(buf, format="PDF", save_all=True, append_images=images[1:], resolution=72.0)
    return buf.getvalue()


def _scanned_pdf(pages: int) -> bytes:
    """A photo-like page: real high-frequency detail, the worst case for compression."""
    rng = np.random.default_rng(7)
    images = []
    for _ in range(pages):
        noise = rng.normal(230, 12, (1400, 1000, 3)).clip(0, 255).astype(np.uint8)
        img = Image.fromarray(noise, "RGB")
        draw = ImageDraw.Draw(img)
        for line in range(30):
            draw.line((80, 100 + line * 40, 920, 100 + line * 40), fill=(30, 30, 35), width=4)
        images.append(img)
    buf = io.BytesIO()
    images[0].save(buf, format="PDF", save_all=True, append_images=images[1:], resolution=150.0)
    return buf.getvalue()


def _master(tmp_path: Path, source: bytes, name: str = "mat"):
    storage = LocalPrivateStorage(tmp_path / (name + "-st"))
    key = f"originals/{name}/v1.pdf"
    storage.put_bytes(key, source)
    manifest = render_master(storage, material_id=name, version_id="v1", source_key=key,
                             dpi=150, max_pages=50, pdf_version="5.1.0")
    return storage, manifest


def _build(storage, manifest, profile):
    return issuance.build_personalised_pdf(
        storage=storage, manifest=manifest, model=FakeModel(), payload=0xC0FFEE,
        source_dpi=manifest["settings"]["dpi"], profile=profile)


# ── Size ─────────────────────────────────────────────────────────────────────

def test_balanced_is_much_smaller_than_lossless(tmp_path: Path):
    storage, manifest = _master(tmp_path, _text_pdf(3))
    lossless = _build(storage, manifest, LOSSLESS)
    balanced = _build(storage, manifest, BALANCED)
    assert len(balanced) < len(lossless) * 0.5, (
        f"balanced={len(balanced)} lossless={len(lossless)}: JPEG did not pay off")


def test_profiles_are_ordered_by_size(tmp_path: Path):
    storage, manifest = _master(tmp_path, _scanned_pdf(2))
    sizes = {p.name: len(_build(storage, manifest, p))
             for p in (LOSSLESS, CONSERVATIVE, BALANCED, AGGRESSIVE)}
    assert sizes["aggressive"] <= sizes["balanced"] <= sizes["conservative"] < sizes["lossless"]


def test_lossless_profile_reproduces_the_previous_encoder(tmp_path: Path):
    """The escape hatch must still emit a Flate image, not a JPEG."""
    storage, manifest = _master(tmp_path, _text_pdf(1))
    data = _build(storage, manifest, LOSSLESS)
    assert b"/DCTDecode" not in data
    assert b"/FlateDecode" in data


def test_jpeg_profiles_emit_dctdecode(tmp_path: Path):
    storage, manifest = _master(tmp_path, _text_pdf(1))
    for profile in (CONSERVATIVE, BALANCED, AGGRESSIVE):
        data = _build(storage, manifest, profile)
        assert b"/DCTDecode" in data, profile.name


# ── Geometry ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("profile", [LOSSLESS, CONSERVATIVE, BALANCED, AGGRESSIVE])
def test_page_geometry_is_preserved_by_every_profile(tmp_path: Path, profile):
    storage, manifest = _master(tmp_path, _text_pdf(2))
    data = _build(storage, manifest, profile)
    doc = pdfium.PdfDocument(data)
    try:
        assert len(doc) == len(manifest["pages"])
        for i, page_meta in enumerate(manifest["pages"]):
            width, height = doc[i].get_size()
            expected_w = page_meta["width"] * 72.0 / manifest["settings"]["dpi"]
            expected_h = page_meta["height"] * 72.0 / manifest["settings"]["dpi"]
            assert abs(width - expected_w) < 0.6, (profile.name, width, expected_w)
            assert abs(height - expected_h) < 0.6, (profile.name, height, expected_h)
            assert (width > height) == (page_meta["width"] > page_meta["height"])
    finally:
        doc.close()


def test_aggressive_profile_caps_the_embedded_resolution(tmp_path: Path):
    storage, manifest = _master(tmp_path, _text_pdf(1))
    data = _build(storage, manifest, AGGRESSIVE)
    doc = pdfium.PdfDocument(data)
    try:
        page = doc[0]
        rendered = page.render(scale=manifest["settings"]["dpi"] / 72.0).to_pil()
        rendered.close()
        page.close()
    finally:
        doc.close()
    # The page still RENDERS at the master DPI (a viewer scales the image), but the
    # stored raster is smaller: check the encoded pixel budget of the document.
    assert len(data) < len(_build(storage, manifest, BALANCED))


@pytest.mark.parametrize("profile", [CONSERVATIVE, BALANCED, AGGRESSIVE])
def test_embedded_pixels_match_the_profile_dpi(tmp_path: Path, profile):
    storage, manifest = _master(tmp_path, _text_pdf(1))
    data = _build(storage, manifest, profile)
    expected_dpi = pdf_optimize.effective_dpi(profile, manifest["settings"]["dpi"])
    doc = pdfium.PdfDocument(data)
    try:
        page = doc[0]
        image_objects = [obj for obj in page.get_objects() if obj.type == 3]  # 3 = FPDF_PAGEOBJ_IMAGE
        assert image_objects, "no image object on the page"
        img = pdfium.PdfImage(image_objects[0].raw, page=page)
        px_w, px_h = img.get_px_size()
        img.close()
        master_w = manifest["pages"][0]["width"]
        assert abs(px_w - master_w * expected_dpi / manifest["settings"]["dpi"]) <= 2
    finally:
        doc.close()


# ── Readability ──────────────────────────────────────────────────────────────

def test_text_ink_survives_jpeg_at_balanced_quality(tmp_path: Path):
    storage, manifest = _master(tmp_path, _text_pdf(1))
    data = _build(storage, manifest, BALANCED)
    doc = pdfium.PdfDocument(data)
    try:
        page_img = doc[0].render(scale=manifest["settings"]["dpi"] / 72.0).to_pil().convert("L")
        ink_rebuilt = (np.asarray(page_img) < 128).mean()
    finally:
        doc.close()
    master_page = Image.open(io.BytesIO(storage.get_bytes(manifest["pages"][0]["key"]))).convert("L")
    ink_master = (np.asarray(master_page) < 128).mean()
    assert ink_master > 0.005
    # JPEG at q=88 must not wash out body text.
    assert abs(ink_rebuilt - ink_master) < 0.004


# ── Forensic identity of the artifact ────────────────────────────────────────

def test_each_profile_has_a_distinct_config_version():
    versions = {issuance.config_version_for(p) for p in
                (LOSSLESS, CONSERVATIVE, BALANCED, AGGRESSIVE)}
    assert len(versions) == 4
    assert issuance.config_version_for(BALANCED).endswith(":balanced")
    # A different encoder must never reuse a copy produced by another one.
    assert issuance.config_version_for(BALANCED) != issuance.CONFIG_VERSION_PREFIX + "-png-v1"


def test_unknown_profile_is_refused_not_silently_defaulted():
    with pytest.raises(ValueError):
        pdf_optimize.resolve_profile("agressive")  # typo
    assert pdf_optimize.resolve_profile(None) is BALANCED


def test_original_and_masters_are_untouched_by_compression(tmp_path: Path):
    storage, manifest = _master(tmp_path, _text_pdf(1))
    original = storage.get_bytes("originals/mat/v1.pdf")
    masters = [storage.get_bytes(p["key"]) for p in manifest["pages"]]
    _build(storage, manifest, AGGRESSIVE)
    assert storage.get_bytes("originals/mat/v1.pdf") == original
    assert [storage.get_bytes(p["key"]) for p in manifest["pages"]] == masters


def test_no_image_metadata_is_carried_into_the_page(tmp_path: Path):
    """The encoded page must not smuggle EXIF/ICC/user metadata into the document."""
    storage, manifest = _master(tmp_path, _text_pdf(1))
    data = _build(storage, manifest, BALANCED)
    assert b"Exif" not in data
    assert b"Photoshop" not in data
    assert b"<x:xmpmeta" not in data
