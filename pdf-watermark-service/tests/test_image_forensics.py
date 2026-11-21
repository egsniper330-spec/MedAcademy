"""Image-only forensic verification: pipeline contracts, quality gates, decision rule.

WHAT IS AND IS NOT PROVEN HERE
──────────────────────────────
These tests exercise the CONTAINER: format sniffing, EXIF orientation, size and
decoded-pixel limits, quality gating, bounded candidate regions, the agreement
rule, and the four outcome states. The extractor is a deterministic fake, because
the real WAM checkpoint lives only in the VPS WAM venv (see
scripts/validate_image_forensics.py for the measurement that does use it).

So: a passing test here proves the pipeline behaves correctly for a given reading
pattern. It does NOT prove that WAM recovers a payload from a photographed page.
That claim is never made anywhere in this repository without that script's output.
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import image_forensics as fx  # noqa: E402


# ── Fixtures ─────────────────────────────────────────────────────────────────

def page_image(width: int = 1000, height: int = 1414, ink: bool = True) -> Image.Image:
    """A page-like RGB image: white paper with text rules (enough high-frequency ink)."""
    img = Image.new("RGB", (width, height), (255, 255, 255))
    if ink:
        draw = ImageDraw.Draw(img)
        for line in range(40):
            y = 60 + line * 30
            draw.line((70, y, width - 70 - (line % 3) * 40, y), fill=(20, 20, 25), width=3)
    return img


def to_bytes(img: Image.Image, fmt: str = "PNG", quality: int = 85) -> bytes:
    buf = io.BytesIO()
    if fmt.upper() == "JPEG":
        img.save(buf, format="JPEG", quality=quality)
    else:
        img.save(buf, format=fmt)
    return buf.getvalue()


class FixedExtractor:
    """Returns the same (payload, score) for every region, and counts the calls."""

    def __init__(self, payload: int = 123456, score: float = 0.95):
        self.payload = payload
        self.score = score
        self.calls = 0

    def __call__(self, chw):
        self.calls += 1
        return self.payload, self.score


class RegionExtractor:
    """Reads the payload only from regions whose short side matches `min_side`.

    Lets a test model 'only this crop contains recoverable evidence' without
    depending on image content heuristics.
    """

    def __init__(self, payload: int = 98765, score: float = 0.99, min_side: int = 0, max_side: int = 10**9):
        self.payload = payload
        self.score = score
        self.min_side = min_side
        self.max_side = max_side
        self.calls = 0

    def __call__(self, chw):
        self.calls += 1
        side = min(chw.shape[1], chw.shape[2])
        if self.min_side <= side <= self.max_side:
            return self.payload, self.score
        return None, 0.0


class NoMarkExtractor:
    """A different low-confidence guess per region — what an unmarked page looks like."""

    def __init__(self):
        self.calls = 0

    def __call__(self, chw):
        self.calls += 1
        return 1000 + self.calls * 7919 % 65536, 0.51


# ── Format and validation ────────────────────────────────────────────────────

def test_accepts_png_jpeg_and_webp_by_signature():
    img = page_image()
    for fmt in ("PNG", "JPEG", "WEBP"):
        raw = to_bytes(img, fmt)
        assert fx.sniff_format(raw) == fmt
        result = fx.verify_image_bytes(raw, FixedExtractor())
        assert result["verdict"] in ("confirmed", "probable"), fmt
        assert result["quality"]["ok"] is True


def test_rejects_unknown_signature_before_decoding():
    with pytest.raises(fx.ImageRejected) as exc:
        fx.sniff_format(b"GIF89a....")
    assert exc.value.code == "invalid_image"


def test_rejects_truncated_image():
    raw = to_bytes(page_image(), "JPEG")[: 200]
    with pytest.raises(fx.ImageRejected):
        fx.verify_image_bytes(raw, FixedExtractor())


def test_rejects_oversized_pixels_before_allocating():
    # Header says 5000 px wide: refused from the metadata, never decoded.
    img = Image.new("RGB", (5000, 32), (255, 255, 255))
    with pytest.raises(fx.ImageRejected) as exc:
        fx.verify_image_bytes(to_bytes(img, "PNG"), FixedExtractor())
    assert exc.value.code == "image_too_large"


def test_rejects_empty_upload():
    with pytest.raises(fx.ImageRejected):
        fx.verify_image_bytes(b"", FixedExtractor())


def test_applies_exif_orientation():
    """A phone photo stored landscape with EXIF orientation 6 must be read portrait."""
    img = page_image(1200, 800)
    exif = img.getexif()
    exif[274] = 6  # rotate 90 CW on display
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90, exif=exif)
    loaded = fx._load(buf.getvalue())
    assert loaded.height > loaded.width, "EXIF orientation was not applied"
    loaded.close()


# ── Quality gate ─────────────────────────────────────────────────────────────

def test_low_resolution_is_insufficient_quality_not_no_mark():
    raw = to_bytes(page_image(200, 200), "PNG")
    result = fx.verify_image_bytes(raw, FixedExtractor())
    assert result["verdict"] == "insufficient_quality"
    assert result["payload"] is None
    assert "low_resolution" in result["quality"]["reasons"]
    # Distinct from a readable image with no mark: the caller must not say "unwatermarked".
    assert result["candidates_analyzed"] == 0


def test_blank_image_is_insufficient_quality():
    raw = to_bytes(Image.new("RGB", (900, 1200), (255, 255, 255)), "PNG")
    result = fx.verify_image_bytes(raw, FixedExtractor())
    assert result["verdict"] == "insufficient_quality"
    assert "low_contrast" in result["quality"]["reasons"]


def test_quality_gate_can_be_bypassed_for_diagnostics():
    raw = to_bytes(Image.new("RGB", (900, 1200), (255, 255, 255)), "PNG")
    result = fx.verify_image_bytes(raw, FixedExtractor(), skip_quality_gate=True)
    assert result["verdict"] in ("confirmed", "probable")


# ── Candidate regions and crops ──────────────────────────────────────────────

def test_candidate_list_is_bounded_and_ordered():
    img = page_image(1000, 1414)
    regions = fx.candidate_regions(img, max_candidates=7)
    assert len(regions) == 7
    assert regions[0].label == "full"
    assert len({r.label for r in regions}) == 7
    # Every crop is smaller than the frame and none is degenerate.
    for region in regions[1:]:
        assert 0 < region.image.width <= img.width
        assert 0 < region.image.height <= img.height


def test_max_candidates_is_respected():
    img = page_image(1000, 1414)
    assert len(fx.candidate_regions(img, max_candidates=1)) == 1
    assert len(fx.candidate_regions(img, max_candidates=3)) == 3


def test_partial_page_crop_is_still_verified():
    """Only one quadrant carries the mark: the upload is verified, not rejected."""
    raw = to_bytes(page_image(1200, 1600), "JPEG")
    # Only the small corner crops are readable — mimics a crop of part of a page.
    extractor = RegionExtractor(payload=4242, score=0.985, max_side=700)
    result = fx.verify_image_bytes(raw, extractor)
    # The four 55% corner regions are readable, the wider ones are not: the mark is
    # recovered from PART of the page and corroborated, so this is `confirmed`.
    assert result["verdict"] == "confirmed"
    assert result["payload"] == 4242
    assert result["candidates_readable"] >= 2
    assert result["candidates_total"] == 7


def test_decisive_full_frame_stops_the_scan():
    """A near-certain first reading must not spend CPU on the remaining regions."""
    raw = to_bytes(page_image(1000, 1414), "PNG")
    extractor = FixedExtractor(payload=7, score=0.995)
    result = fx.verify_image_bytes(raw, extractor)
    assert extractor.calls == 1
    assert result["candidates_total"] == 7
    assert result["verdict"] == "probable"  # single region: honest label
    assert result["payload"] == 7


def test_confirmed_requires_agreement_between_regions():
    raw = to_bytes(page_image(1000, 1414), "PNG")
    extractor = FixedExtractor(payload=7, score=0.94)
    result = fx.verify_image_bytes(raw, extractor)
    assert extractor.calls > 1
    assert result["verdict"] == "confirmed"
    assert result["agreement"] >= 0.5


# ── Decision rule (pure) ─────────────────────────────────────────────────────

def test_decide_no_mark_when_regions_disagree():
    reads = [{"label": "full", "payload": 11, "score": 0.51},
             {"label": "center-85", "payload": 22, "score": 0.52},
             {"label": "quad-tl", "payload": 33, "score": 0.50}]
    result = fx.decide(reads, total_candidates=3)
    assert result["verdict"] == "no_mark"
    assert result["payload"] is None


def test_decide_ambiguous_for_two_equally_strong_payloads():
    reads = [{"label": "full", "payload": 11, "score": 0.80},
             {"label": "quad-tl", "payload": 22, "score": 0.79}]
    result = fx.decide(reads, total_candidates=2)
    assert result["verdict"] == "ambiguous"
    assert result["payload"] is None


def test_decide_ignores_unreadable_regions_for_agreement():
    reads = [{"label": "full", "payload": 5, "score": 0.95},
             {"label": "center-85", "payload": 5, "score": 0.93},
             {"label": "quad-br", "payload": None, "score": 0.0}]
    result = fx.decide(reads, total_candidates=3)
    assert result["verdict"] == "confirmed"
    assert result["payload"] == 5
    assert result["candidates_readable"] == 2


def test_decide_reports_zero_readable_without_crashing():
    result = fx.decide([], total_candidates=0)
    assert result["verdict"] == "no_mark"
    assert result["payload"] is None
    assert result["score"] == 0.0


def test_region_failure_does_not_abort_verification():
    raw = to_bytes(page_image(1000, 1414), "PNG")

    class ExplodingThenGood:
        def __init__(self):
            self.calls = 0

        def __call__(self, chw):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("model hiccup on this crop")
            return 31337, 0.93

    extractor = ExplodingThenGood()
    result = fx.verify_image_bytes(raw, extractor)
    assert extractor.calls > 1
    assert result["payload"] == 31337


# ── Honest outcomes ─────────────────────────────────────────────────────────

def test_unmarked_control_image_is_no_mark_not_a_guess():
    raw = to_bytes(page_image(1000, 1414), "JPEG")
    result = fx.verify_image_bytes(raw, NoMarkExtractor())
    assert result["verdict"] == "no_mark"
    assert result["payload"] is None
    assert result["payload_groups"] >= 2


def test_result_carries_no_identity_fields():
    raw = to_bytes(page_image(1000, 1414), "PNG")
    result = fx.verify_image_bytes(raw, FixedExtractor())
    assert set(result).isdisjoint({"student", "student_id", "issuance", "profile"})


def test_module_never_writes_anything():
    """The upload must not be persisted: no storage import, no pathlib, no file writes."""
    source = (Path(__file__).resolve().parents[1] / "app" / "image_forensics.py").read_text(encoding="utf-8")
    code = "\n".join(line for line in source.splitlines() if not line.strip().startswith("#"))
    assert "from .storage" not in code and "import storage" not in code
    assert "pathlib" not in code
    assert "open(" not in code.replace("Image.open(", "")
    assert ".write" not in code and "os." not in code
