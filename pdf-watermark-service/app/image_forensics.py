"""Image-only forensic verification for the PDF watermark service.

WHY THIS MODULE EXISTS
──────────────────────
The original detector (/internal/detect) only ever reads a PDF: it renders each
page with PDFium at the master DPI and decodes the WAM payload from the rendered
raster. A screenshot, a crop, a WhatsApp re-encode or a photograph of a printed
page has no PDF container, a different resolution, and often only PART of a page
— so the PDF path cannot be reused as-is.

This module adds an IMAGE input path in front of the SAME model and the SAME
32-bit payload. It does not change the watermark, the payload format, the
checkpoint, or the mapping of payload -> student (which stays in PHP).

WHAT IS VERIFIED AND WHAT IS ONLY A HYPOTHESIS
──────────────────────────────────────────────
Watermark recovery from the cases below is a property of the WAM checkpoint, not
of this file. This module supplies the candidate regions and the decision rule;
whether a JPEG-recompressed photograph still yields the payload can only be
measured against the real checkpoint (see scripts/validate_image_forensics.py,
which must be run on the VPS WAM venv). The verdict thresholds here are therefore
conservative defaults that are configurable, not measured claims.

DESIGN CONSTRAINTS
──────────────────
• Pure and injectable: `extract` is any callable (3, H, W) float32 -> (payload,
  score). The real caller passes WamRuntimeClient.extract_image; tests pass
  deterministic fakes. No torch import, no model path, no network.
• Bounded work: at most `max_candidates` decode passes per upload, a hard pixel
  cap before decoding, and a single in-memory copy of the decoded image.
• No storage: the upload is processed from memory and never written to disk, so
  there is nothing to clean up and nothing suspicious is retained.
• Fail-safe: anything unexpected becomes `no_mark` with a note, never a 500 and
  never a guess.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Callable

# ── Upload limits (documented in docs/IMAGE_FORENSIC_VERIFICATION.md) ────────
MAX_UPLOAD_BYTES = 12 * 1024 * 1024      # 12 MiB: a phone photo, not a PDF
MAX_SIDE = 4096                          # decoded pixel side cap (decompression bomb guard)
MAX_PIXELS = 4096 * 4096                 # 16.7 MP
MIN_SIDE = 320                           # below this no page fragment can carry the mark
MIN_PIXELS = 320 * 320

# ── Detection thresholds (defaults; overridable from settings) ───────────────
# The measured separation on the PDF path is ~0.99 for issued copies and ~0.51
# for an unwatermarked control, so these bars sit far above the control.
CONFIRM_SCORE = 0.90
PROBABLE_SCORE = 0.75
SINGLE_STRONG_SCORE = 0.97   # one candidate this strong may conclude (as `probable`)

# ── Quality gates ────────────────────────────────────────────────────────────
# Deliberately permissive: a legitimate low-light photo must not be rejected with
# a confident "bad image". These only catch obviously unusable uploads.
MIN_BLUR_VARIANCE = 6.0      # variance of Laplacian on a <=512px grayscale copy
MIN_CONTRAST_STD = 4.0       # global standard deviation (0-255 scale)

SUPPORTED_FORMATS = ("JPEG", "PNG", "WEBP")


class ImageRejected(ValueError):
    """The upload is not a usable image. `code` is the stable API error code."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


class ModelUnavailable(RuntimeError):
    """No region could be read because the model failed — NOT because there is no mark.

    This distinction is a security property: reporting a detector outage as `no_mark`
    would tell a doctor "this image carries no watermark" when the truth is "the
    detector did not run". The endpoint turns this into 503 so the caller can say
    "try again" instead of showing a clean verdict.
    """


def sniff_format(raw: bytes) -> str:
    """Return 'JPEG' | 'PNG' | 'WEBP' from the file signature, never from a header.

    A declared Content-Type is attacker-controlled; these bytes are not. Anything
    else is rejected before Pillow sees it.
    """
    if raw.startswith(b"\xff\xd8\xff"):
        return "JPEG"
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "PNG"
    if len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "WEBP"
    raise ImageRejected("invalid_image", "unsupported image signature")


def _load(raw: bytes):
    """Decode an upload to an RGB PIL image, applying EXIF orientation.

    The dimensions are read from the container header FIRST and compared with the
    limits, so an image that would expand to 1.5 GB is refused before any pixel
    buffer is allocated (decompression-bomb guard).
    """
    from PIL import Image, ImageOps

    if not raw:
        raise ImageRejected("invalid_image", "empty upload")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise ImageRejected("payload_too_large", "upload exceeds the image limit")
    fmt = sniff_format(raw)
    try:
        with Image.open(io.BytesIO(raw)) as probe:
            if probe.format != fmt:
                raise ImageRejected("invalid_image", "signature and container disagree")
            width, height = probe.size
    except ImageRejected:
        raise
    except Exception as exc:  # Pillow raises a family of errors for truncated files
        raise ImageRejected("invalid_image", f"undecodable image ({type(exc).__name__})") from exc
    if width < 1 or height < 1:
        raise ImageRejected("invalid_image", "image has no pixels")
    if width > MAX_SIDE or height > MAX_SIDE:
        raise ImageRejected("image_too_large", f"side exceeds {MAX_SIDE}px")
    if width * height > MAX_PIXELS:
        raise ImageRejected("image_too_large", f"more than {MAX_PIXELS} pixels")
    try:
        with Image.open(io.BytesIO(raw)) as img:
            img.load()
            oriented = ImageOps.exif_transpose(img)
            # A transparent PNG screenshot is flattened onto white: the model was
            # trained on paper-white pages, and black-filled transparency would
            # read as meaningless ink.
            if oriented.mode in ("RGBA", "LA", "P"):
                rgba = oriented.convert("RGBA")
                flat = Image.new("RGB", rgba.size, (255, 255, 255))
                flat.paste(rgba, (0, 0), rgba)
                return flat
            return oriented.convert("RGB")
    except ImageRejected:
        raise
    except Exception as exc:
        raise ImageRejected("invalid_image", f"undecodable image ({type(exc).__name__})") from exc


def _to_chw(img) -> "object":
    import numpy as np

    arr = np.asarray(img).astype(np.float32) / 255.0
    return np.transpose(arr, (2, 0, 1))


def quality_report(img) -> dict:
    """Cheap, explainable quality assessment used to answer "insufficient image".

    blur   — variance of the Laplacian over a <=512px grayscale copy. Low values
             mean no high-frequency ink edges: out of focus, over-compressed, or
             a blank/washed-out capture.
    contrast — global std. A blank page or a photo of an empty sheet scores near
             zero and cannot carry recoverable evidence.
    """
    import numpy as np

    width, height = img.size
    reasons: list[str] = []
    gray = img.convert("L")
    scale = min(1.0, 512.0 / max(1, max(gray.size)))
    if scale < 1.0:
        gray = gray.resize((max(1, int(gray.width * scale)), max(1, int(gray.height * scale))))
    g = np.asarray(gray, dtype=np.float32)
    # 5-point Laplacian, computed with array slices (no SciPy/OpenCV dependency).
    lap = (-4.0 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:])
    blur = float(lap.var()) if lap.size else 0.0
    contrast = float(g.std()) if g.size else 0.0
    if width < MIN_SIDE or height < MIN_SIDE or width * height < MIN_PIXELS:
        reasons.append("low_resolution")
    if blur < MIN_BLUR_VARIANCE:
        reasons.append("blurry")
    if contrast < MIN_CONTRAST_STD:
        reasons.append("low_contrast")
    return {
        "ok": not reasons,
        "reasons": reasons,
        "width": width,
        "height": height,
        "blur": round(blur, 3),
        "contrast": round(contrast, 2),
    }


@dataclass(frozen=True)
class Candidate:
    """One region of the upload analysed independently."""

    label: str
    image: "object"


def _center_crop(img, fraction: float, label: str) -> Candidate:
    width, height = img.size
    w = max(1, int(width * fraction))
    h = max(1, int(height * fraction))
    left = (width - w) // 2
    top = (height - h) // 2
    return Candidate(label, img.crop((left, top, left + w, top + h)))


def candidate_regions(img, *, max_candidates: int = 7) -> list[Candidate]:
    """Regions worth decoding, ordered by how much page area they carry.

    WHY OVERLAPPING REGIONS: a crop, a screenshot of a paragraph, or an angled
    photo may cut the page anywhere. The model reads the mark from whatever
    region it is given, so the same upload is analysed at several scales instead
    of only whole. The order matters — the full frame is analysed first, and a
    decisive reading there stops the scan (see verify_image_bytes).

    The list is bounded (default 7): full frame, two centered zooms, four
    overlapping corner quadrants. A page fragment smaller than one quadrant is
    not recoverable by this design and is reported as such rather than guessed.
    """
    width, height = img.size
    regions: list[Candidate] = [Candidate("full", img)]
    if max_candidates <= 1:
        return regions

    # Downscale the WHOLE frame only when it is very large: the model works at
    # the resolution it was trained on and 4096px costs memory without adding
    # recoverable information. Crops are never upscaled.
    regions.append(_center_crop(img, 0.85, "center-85"))
    if max_candidates <= 2:
        return regions[:max_candidates]
    regions.append(_center_crop(img, 0.70, "center-70"))

    quadrant = [
        ("quad-tl", (0.0, 0.0)),
        ("quad-tr", (1.0, 0.0)),
        ("quad-bl", (0.0, 1.0)),
        ("quad-br", (1.0, 1.0)),
    ]
    for label, (fx, fy) in quadrant:
        if len(regions) >= max_candidates:
            break
        w = int(width * 0.55)
        h = int(height * 0.55)
        left = 0 if fx == 0.0 else max(0, width - w)
        top = 0 if fy == 0.0 else max(0, height - h)
        regions.append(Candidate(label, img.crop((left, top, left + w, top + h))))
    return regions[:max_candidates]


def _group(reads: list[dict]) -> list[dict]:
    """Collapse per-candidate payloads into ranked payload groups."""
    groups: dict[int, dict] = {}
    for read in reads:
        payload = read.get("payload")
        if payload is None:
            continue
        entry = groups.setdefault(int(payload), {"payload": int(payload), "votes": 0,
                                                 "scores": [], "labels": []})
        entry["votes"] += 1
        entry["scores"].append(float(read.get("score") or 0.0))
        entry["labels"].append(read["label"])
    ranked = sorted(groups.values(), key=lambda g: (g["votes"], max(g["scores"])), reverse=True)
    for entry in ranked:
        entry["best_score"] = round(max(entry["scores"]), 4)
        entry["mean_score"] = round(sum(entry["scores"]) / len(entry["scores"]), 4)
    return ranked


def decide(reads: list[dict], *, total_candidates: int,
           confirm_score: float = CONFIRM_SCORE,
           probable_score: float = PROBABLE_SCORE,
           single_strong_score: float = SINGLE_STRONG_SCORE) -> dict:
    """Turn per-region readings into a verdict. Pure: same input, same output.

    The rule deliberately requires CORROBORATION for `confirmed`. A single
    region's reading is never enough to call a copy identified, because an
    unwatermarked control image still produces a payload guess (measured 0.51 on
    the PDF path) — the payload always exists, only its reliability varies.
    """
    readable = [r for r in reads if r.get("payload") is not None]
    groups = _group(reads)
    analyzed = len(reads)
    if not groups:
        return {
            "verdict": "no_mark", "payload": None, "score": 0.0, "agreement": 0.0,
            "payload_groups": 0, "candidates_analyzed": analyzed,
            "candidates_readable": 0, "candidates_total": total_candidates,
            "note": "no region produced a readable payload",
        }
    winner = groups[0]
    votes = winner["votes"]
    best = winner["best_score"]
    agreement = votes / analyzed if analyzed else 0.0

    if votes >= 2 and agreement >= 0.5 and best >= confirm_score:
        verdict = "confirmed"
    elif votes >= 2 and best >= probable_score:
        verdict = "probable"
    elif votes == 1 and best >= single_strong_score:
        # One decisive region: reported as PROBABLE, never CONFIRMED — the caller
        # may still resolve identity, but the evidence is labelled honestly.
        verdict = "probable"
    elif (len(groups) >= 2
          and groups[1]["votes"] >= winner["votes"]
          # AMBIGUOUS means two STRONG, conflicting readings. Disagreement among
          # weak readings is simply `no_mark`: an unmarked page produces a
          # different low-confidence guess in every region, and calling that
          # "ambiguous" would overstate what was seen.
          and groups[1]["best_score"] >= probable_score * 0.9
          and abs(groups[1]["best_score"] - best) < 0.05):
        verdict = "ambiguous"
    else:
        verdict = "no_mark"

    return {
        "verdict": verdict,
        # Only an identified reading may name a payload. `ambiguous` deliberately
        # carries none: identifying somebody from conflicting evidence would be a
        # guess, and the caller must never resolve an identity from one.
        "payload": winner["payload"] if verdict in ("confirmed", "probable") else None,
        "score": best,
        "agreement": round(agreement, 4),
        "payload_groups": len(groups),
        "candidates_analyzed": analyzed,
        "candidates_readable": len(readable),
        "candidates_total": total_candidates,
        "regions": [{"label": r["label"], "payload": r.get("payload"), "score": r.get("score")}
                    for r in reads],
    }


def verify_image_bytes(
    raw: bytes,
    extract: Callable[["object"], tuple[int, float]],
    *,
    max_candidates: int = 7,
    confirm_score: float = CONFIRM_SCORE,
    probable_score: float = PROBABLE_SCORE,
    single_strong_score: float = SINGLE_STRONG_SCORE,
    skip_quality_gate: bool = False,
) -> dict:
    """Verify one uploaded image and return EVIDENCE (never an identity).

    Returned keys:
      verdict            confirmed | probable | ambiguous | no_mark | insufficient_quality
      payload            the recovered 32-bit value, or None
      score, agreement   evidence strength
      quality            {ok, reasons, width, height, blur, contrast}
      candidates_*       how many regions were analysed
      regions            per-region readings (diagnostics; no image data)

    `insufficient_quality` is a distinct outcome from `no_mark`: it says the
    upload could not carry evidence, NOT that the copy is unmarked. The caller
    must keep that distinction in its response, because the two mean very
    different things to a doctor.
    """
    img = _load(raw)
    try:
        quality = quality_report(img)
        if not quality["ok"] and not skip_quality_gate:
            return {
                "verdict": "insufficient_quality",
                "payload": None,
                "score": 0.0,
                "agreement": 0.0,
                "payload_groups": 0,
                "candidates_analyzed": 0,
                "candidates_readable": 0,
                "candidates_total": 0,
                "quality": quality,
                "regions": [],
            }
        regions = candidate_regions(img, max_candidates=max_candidates)
        reads: list[dict] = []
        failures = 0
        for candidate in regions:
            try:
                payload, score = extract(_to_chw(candidate.image))
            except Exception:
                # One failed region must not abort the verification: the model
                # can legitimately reject a degenerate crop. If EVERY region
                # fails, the model itself is down (see below).
                failures += 1
                continue
            reads.append({
                "label": candidate.label,
                "payload": None if payload is None else int(payload),
                "score": round(float(score or 0.0), 4),
            })
            # Decisive early exit: the full frame already reads the payload with
            # near-certainty, so further regions only cost CPU.
            if (len(reads) == 1 and reads[0]["payload"] is not None
                    and reads[0]["score"] >= single_strong_score):
                break
        if not reads and failures:
            # The detector never ran. Never degrade this to `no_mark`.
            raise ModelUnavailable("every candidate region failed to decode")
        result = decide(reads, total_candidates=len(regions), confirm_score=confirm_score,
                        probable_score=probable_score, single_strong_score=single_strong_score)
        result["quality"] = quality
        return result
    finally:
        img.close()
