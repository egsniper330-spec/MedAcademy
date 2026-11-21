"""VPS validation: does each compression profile still preserve the WAM payload?

RUN THIS ON THE VPS, with the WAM venv, BEFORE enabling anything other than the
default `balanced` profile in production. There is no other way to answer the
question "does this encoding still carry the mark?" — the answer depends on the
checkpoint, and the checkpoint is not on a developer machine.

    # 1. WAM runtime must be up (127.0.0.1:8711)
    # 2. export the SAME HMAC key the service uses for the runtime
    export PDF_SVC_WAM_HMAC_KEY='wam1:<secret>'
    ./.venv-wam/bin/python scripts/validate_compression.py \
        --pdf /path/to/a/real/lecture.pdf --payload 3735928559

WHAT IT DOES, PER PROFILE
─────────────────────────
1. Renders the master pages (exactly as production preprocess does).
2. Embeds the payload with the REAL model and builds the personalised PDF.
3. Re-opens the FINAL PDF, renders each page at the master DPI (the same read the
   detector performs on a suspect copy) and decodes it.
4. Repeats the decode after realistic delivery damage:
     · JPEG q60 recompression of the rendered page (WhatsApp-style)
     · 50% downscale then re-render
     · a 60% centre crop
5. Prints size, per-page recovery, score and the damaged-view results.

Exit code 1 if any profile fails to recover the payload from the final PDF.
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
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import issuance  # noqa: E402
from app.pdf_optimize import AGGRESSIVE, BALANCED, CONSERVATIVE, LOSSLESS, PROFILES  # noqa: E402
from app.preprocess import render_master  # noqa: E402
from app.storage import LocalPrivateStorage  # noqa: E402
from app.wam_client import WamRuntimeClient  # noqa: E402


def _client() -> WamRuntimeClient:
    raw = os.environ.get("PDF_SVC_WAM_HMAC_KEY", "")
    key_id, _, secret = raw.partition(":")
    if not key_id or not secret:
        raise SystemExit("PDF_SVC_WAM_HMAC_KEY (id:secret) is required")
    url = os.environ.get("PDF_SVC_WAM_RUNTIME_URL", "http://127.0.0.1:8711")
    return WamRuntimeClient(url, key_id, secret.encode())


def _render_page(doc, index: int, dpi: int) -> Image.Image:
    page = doc[index]
    try:
        return page.render(scale=dpi / 72.0).to_pil().convert("RGB")
    finally:
        page.close()


def _chw(img: Image.Image):
    arr = np.asarray(img).astype(np.float32) / 255.0
    return np.transpose(arr, (2, 0, 1))


def _damage(img: Image.Image, kind: str) -> Image.Image:
    if kind == "jpeg60":
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=60)
        return Image.open(io.BytesIO(buf.getvalue())).convert("RGB")
    if kind == "half":
        small = img.resize((img.width // 2, img.height // 2), Image.LANCZOS)
        return small.resize(img.size, Image.LANCZOS)
    if kind == "crop60":
        w, h = int(img.width * 0.6), int(img.height * 0.6)
        left, top = (img.width - w) // 2, (img.height - h) // 2
        return img.crop((left, top, left + w, top + h))
    return img


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True, help="a real lecture PDF")
    ap.add_argument("--payload", type=int, default=0xDEADBEEF)
    ap.add_argument("--dpi", type=int, default=150)
    ap.add_argument("--damage", default="jpeg60,half,crop60")
    args = ap.parse_args()

    model = _client()
    if not model.health():
        raise SystemExit("WAM runtime is not answering /healthz — start it first")

    source = Path(args.pdf).read_bytes()
    damages = [d for d in args.damage.split(",") if d]

    failures = 0
    with tempfile.TemporaryDirectory() as tmp:
        storage = LocalPrivateStorage(Path(tmp) / "storage")
        key = "originals/val/v1.pdf"
        storage.put_bytes(key, source)
        manifest = render_master(storage, material_id="val", version_id="v1", source_key=key,
                                 dpi=args.dpi, max_pages=500, pdf_version="5.1.0")
        print(f"source={len(source)} bytes pages={len(manifest['pages'])} dpi={args.dpi}")

        for profile in (LOSSLESS, CONSERVATIVE, BALANCED, AGGRESSIVE):
            data = issuance.build_personalised_pdf(
                storage=storage, manifest=manifest, model=model, payload=args.payload,
                source_dpi=manifest["settings"]["dpi"], profile=profile)
            doc = pdfium.PdfDocument(data)
            recovered = 0
            scores: list[float] = []
            damaged: dict[str, int] = {d: 0 for d in damages}
            try:
                for index in range(min(len(doc), 12)):
                    page_img = _render_page(doc, index, args.dpi)
                    payload, score = model.extract_image(_chw(page_img))
                    if payload == args.payload:
                        recovered += 1
                        scores.append(float(score))
                    for kind in damages:
                        p2, _ = model.extract_image(_chw(_damage(page_img, kind)))
                        if p2 == args.payload:
                            damaged[kind] += 1
                    page_img.close()
            finally:
                doc.close()
            pages_checked = min(len(manifest["pages"]), 12)
            print(f"{profile.name:13s} size={len(data)/1024:8.1f} KB  "
                  f"recovered={recovered}/{pages_checked}  "
                  f"score={np.mean(scores) if scores else 0:.3f}  "
                  + "  ".join(f"{k}={v}" for k, v in damaged.items()))
            if recovered < pages_checked:
                failures += 1
                print(f"  !! {profile.name} LOST recovery on {pages_checked - recovered} page(s)")

    print("\nRESULT:", "OK — every profile recovered the payload" if failures == 0
          else f"{failures} profile(s) FAILED: do not enable them")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
