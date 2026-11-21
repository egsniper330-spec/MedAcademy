"""Objective output checks for the rebuilt PDF: page count, point dimensions, embedded image resolution,
readability and page order. Raster-only output means no text layer, so text search is not checked.
Watermark extraction from the rebuilt page images is covered by the real-WAM test (WAM venv only)."""

from __future__ import annotations

import io
import sys
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import issuance  # noqa: E402
from app.preprocess import render_master  # noqa: E402
from app.storage import LocalPrivateStorage  # noqa: E402


class FakeModel:
    def embed_image(self, image_chw, payload: int):
        return np.asarray(image_chw, dtype=np.float32)


def _text_pdf(pages: int, width_pt: float = 595.0, height_pt: float = 842.0) -> bytes:
    """A synthetic vector PDF with small body text on each page, created with Pillow at 72 DPI."""
    from PIL import ImageDraw, ImageFont

    images = []
    for n in range(pages):
        img = Image.new("RGB", (int(width_pt), int(height_pt)), (255, 255, 255))
        draw = ImageDraw.Draw(img)
        try:
            font = ImageFont.load_default(size=11)
        except TypeError:
            font = ImageFont.load_default()
        for line in range(20):
            draw.text((40, 40 + line * 18), f"Page {n + 1} line {line}: lecture text", fill=(0, 0, 0), font=font)
        images.append(img)
    buf = io.BytesIO()
    images[0].save(buf, format="PDF", save_all=True, append_images=images[1:], resolution=72.0)
    return buf.getvalue()


@pytest.fixture()
def master(tmp_path: Path):
    storage = LocalPrivateStorage(tmp_path / "st")
    source_key = "originals/mat/v1.pdf"
    storage.put_bytes(source_key, _text_pdf(2))
    manifest = render_master(storage, material_id="mat", version_id="v1", source_key=source_key,
                             dpi=150, max_pages=10, pdf_version="5.1.0")
    return storage, manifest


def test_page_count_order_and_point_size_match_master(master):
    storage, manifest = master
    data = issuance.build_personalised_pdf(storage=storage, manifest=manifest, model=FakeModel(),
                                           payload=1, source_dpi=manifest["settings"]["dpi"])
    doc = pdfium.PdfDocument(data)
    assert len(doc) == len(manifest["pages"])
    for i, page_meta in enumerate(manifest["pages"]):
        w_pt, h_pt = doc[i].get_size()
        expected_w = page_meta["width"] * 72.0 / manifest["settings"]["dpi"]
        expected_h = page_meta["height"] * 72.0 / manifest["settings"]["dpi"]
        assert abs(w_pt - expected_w) < 0.5 and abs(h_pt - expected_h) < 0.5
        # Orientation: landscape stays landscape, portrait stays portrait.
        assert (w_pt > h_pt) == (page_meta["width"] > page_meta["height"])


def test_embedded_image_resolution_equals_master_pixels(master):
    storage, manifest = master
    data = issuance.build_personalised_pdf(storage=storage, manifest=manifest, model=FakeModel(),
                                           payload=1, source_dpi=manifest["settings"]["dpi"])
    doc = pdfium.PdfDocument(data)
    for i, page_meta in enumerate(manifest["pages"]):
        bitmap = doc[i].render(scale=manifest["settings"]["dpi"] / 72.0).to_pil()
        assert abs(bitmap.width - page_meta["width"]) <= 1
        assert abs(bitmap.height - page_meta["height"]) <= 1


def test_rebuilt_pages_are_readable_at_master_dpi(master):
    """Body text (11 pt on a 150 DPI master) must still show dark ink after reconstruction."""
    storage, manifest = master
    data = issuance.build_personalised_pdf(storage=storage, manifest=manifest, model=FakeModel(),
                                           payload=1, source_dpi=manifest["settings"]["dpi"])
    doc = pdfium.PdfDocument(data)
    page = doc[0].render(scale=manifest["settings"]["dpi"] / 72.0).to_pil().convert("L")
    ink_rebuilt = (np.asarray(page) < 128).mean()
    # Compare with the master page's own ink fraction: the rebuild must keep essentially all of it.
    master_page = Image.open(io.BytesIO(storage.get_bytes(manifest["pages"][0]["key"]))).convert("L")
    ink_master = (np.asarray(master_page) < 128).mean()
    assert ink_master > 0.005  # the source really contains text ink
    assert abs(ink_rebuilt - ink_master) < 0.002  # reconstruction keeps the ink, no washed-out text


def test_original_pdf_bytes_are_not_modified_by_rebuild(master):
    storage, manifest = master
    before = storage.get_bytes("originals/mat/v1.pdf")
    issuance.build_personalised_pdf(storage=storage, manifest=manifest, model=FakeModel(),
                                    payload=1, source_dpi=manifest["settings"]["dpi"])
    assert storage.get_bytes("originals/mat/v1.pdf") == before


def test_master_assets_are_not_student_specific(master):
    """Rebuilding with two different payloads must not write into the master page assets."""
    storage, manifest = master
    first_masters = [storage.get_bytes(p["key"]) for p in manifest["pages"]]
    issuance.build_personalised_pdf(storage=storage, manifest=manifest, model=FakeModel(), payload=1,
                                    source_dpi=manifest["settings"]["dpi"])
    issuance.build_personalised_pdf(storage=storage, manifest=manifest, model=FakeModel(), payload=2,
                                    source_dpi=manifest["settings"]["dpi"])
    assert [storage.get_bytes(p["key"]) for p in manifest["pages"]] == first_masters
