"""VPS validation: does the image-only path recover the payload from realistic images?

Run with the WAM venv, from the service root:

    export PDF_SVC_WAM_HMAC_KEY='wam1:<secret>'
    # (a) synthesize every image category from a REAL issued PDF:
    ./.venv-wam/bin/python scripts/validate_image_forensics.py \
        --pdf /path/to/issued-copy.pdf --payload 3735928559
    # (b) or measure your own collected images (screenshots / photos):
    ./.venv-wam/bin/python scripts/validate_image_forensics.py \
        --dir /path/to/images --payload 3735928559

WHY A SCRIPT
────────────
Whether WAM recovers its 32-bit payload from a JPEG-recompressed photograph is a
property of the checkpoint, not of the pipeline. This runs the REAL model through
`app.image_forensics.verify_image_bytes()` and prints the verdict for each case,
so the numbers in docs/IMAGE_FORENSIC_VERIFICATION.md are measured, not assumed.

Case list per page: full PNG, full JPEG q75 (screenshot), JPEG q50 (WhatsApp-like),
50% resize, 60% centre crop, 40% corner crop, 8-degree rotation, "photo" (perspective
warp + uneven lighting + blur + JPEG), and an unmarked control.
"""

from __future__ import annotations

import argparse
import io
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import image_forensics, issuance  # noqa: E402
from app.pdf_optimize import BALANCED  # noqa: E402
from app.preprocess import render_master  # noqa: E402
from app.storage import LocalPrivateStorage  # noqa: E402
from app.wam_client import WamRuntimeClient  # noqa: E402


def _client() -> WamRuntimeClient:
    raw = os.environ.get("PDF_SVC_WAM_HMAC_KEY", "")
    key_id, _, secret = raw.partition(":")
    if not key_id or not secret:
        raise SystemExit("PDF_SVC_WAM_HMAC_KEY (id:secret) is required")
    return WamRuntimeClient(os.environ.get("PDF_SVC_WAM_RUNTIME_URL", "http://127.0.0.1:8711"),
                            key_id, secret.encode())


def _page_image(pdf_bytes: bytes, dpi: int = 150) -> Image.Image:
    doc = pdfium.PdfDocument(pdf_bytes)
    try:
        page = doc[0]
        try:
            return page.render(scale=dpi / 72.0).to_pil().convert("RGB")
        finally:
            page.close()
    finally:
        doc.close()


def _png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _jpeg(img: Image.Image, quality: int) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def _photo(img: Image.Image) -> bytes:
    """Approximate a hand-held photograph of a printed page.

    Perspective (a slight trapezoid), uneven lighting (a brightness gradient),
    soft focus, sensor noise, and JPEG at phone-camera quality.
    """
    w, h = img.size
    jitter = int(w * 0.03)
    quad = (jitter, jitter, w - jitter // 2, 0, 0, h - jitter // 2, w, h)
    warped = img.transform((w, h), Image.QUAD, quad, resample=Image.BICUBIC)
    grad = np.linspace(1.05, 0.72, h, dtype=np.float32)[:, None, None]
    arr = (np.asarray(warped).astype(np.float32) * grad).clip(0, 255)
    rng = np.random.default_rng(11)
    arr = (arr + rng.normal(0, 3.5, arr.shape)).clip(0, 255)
    photo = Image.fromarray(arr.astype(np.uint8), "RGB").filter(ImageFilter.GaussianBlur(0.7))
    return _jpeg(photo, 80)


def _cases(img: Image.Image) -> dict[str, bytes]:
    w, h = img.size
    cases = {
        "full-png": _png(img),
        "screenshot-jpeg75": _jpeg(img, 75),
        "whatsapp-jpeg50": _jpeg(img, 50),
        "resized-50%": _png(img.resize((w // 2, h // 2), Image.LANCZOS)),
        "crop-60%-center": _png(img.crop((int(w * 0.2), int(h * 0.2), int(w * 0.8), int(h * 0.8)))),
        "crop-40%-corner": _png(img.crop((int(w * 0.55), int(h * 0.55), w, h))),
        "rotated-8deg": _png(img.rotate(8, expand=True, fillcolor=(255, 255, 255))),
        "photo-print": _photo(img),
    }
    return cases


def _control(w: int, h: int) -> bytes:
    img = Image.new("RGB", (w, h), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    for line in range(40):
        draw.line((60, 60 + line * 30, w - 60, 60 + line * 30), fill=(25, 25, 30), width=3)
    return _png(img)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", help="a REAL issued (watermarked) PDF")
    ap.add_argument("--dir", help="a directory of images to test")
    ap.add_argument("--payload", type=int, required=True)
    ap.add_argument("--dpi", type=int, default=150)
    args = ap.parse_args()
    if not args.pdf and not args.dir:
        raise SystemExit("--pdf or --dir is required")

    model = _client()
    if not model.health():
        raise SystemExit("WAM runtime is not answering /healthz — start it first")

    results: list[tuple[str, dict]] = []

    if args.pdf:
        source = Path(args.pdf).read_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            storage = LocalPrivateStorage(Path(tmp) / "st")
            key = "originals/val/v1.pdf"
            storage.put_bytes(key, source)
            manifest = render_master(storage, material_id="val", version_id="v1", source_key=key,
                                     dpi=args.dpi, max_pages=50, pdf_version="5.1.0")
            issued = issuance.build_personalised_pdf(
                storage=storage, manifest=manifest, model=model, payload=args.payload,
                source_dpi=manifest["settings"]["dpi"], profile=BALANCED)
        page_img = _page_image(issued, args.dpi)
        for name, raw in _cases(page_img).items():
            results.append((name, image_forensics.verify_image_bytes(raw, model.extract_image)))
        results.append(("UNMARKED control", image_forensics.verify_image_bytes(
            _control(page_img.width, page_img.height), model.extract_image)))
        page_img.close()

    if args.dir:
        for path in sorted(Path(args.dir).iterdir()):
            if path.suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp"):
                continue
            raw = path.read_bytes()
            try:
                results.append((path.name, image_forensics.verify_image_bytes(raw, model.extract_image)))
            except image_forensics.ImageRejected as exc:
                results.append((path.name, {"verdict": f"rejected:{exc.code}"}))

    ok = 0
    print(f"\n{'case':22s} {'verdict':22s} {'payload':>10s} {'score':>6s} {'regions':>8s}  match")
    for name, res in results:
        payload = res.get("payload")
        match = "YES" if payload == args.payload else ("-" if payload is None else "no")
        if match == "YES":
            ok += 1
        readable = f'{res.get("candidates_readable", 0)}/{res.get("candidates_total", 0)}'
        reasons = ",".join(res.get("quality", {}).get("reasons", []) or [])
        print(f"{name:22s} {res.get('verdict', '?'):22s} {str(payload):>10s} "
              f"{res.get('score', 0):6.3f} {readable:>8s}  {match}{('  [' + reasons + ']') if reasons else ''}")

    print(f"\nrecovered {ok}/{len(results)} cases")
    print("NOTE: the unmarked control must NOT match; if it does, the thresholds are too low.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
