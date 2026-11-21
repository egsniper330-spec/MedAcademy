"""Stage-by-stage PDF size report (runs WITHOUT the WAM checkpoint).

WHAT THIS MEASURES
──────────────────
The real pipeline (preprocess -> master PNG pages -> personalised PDF), with the
model replaced by an identity embedder. The EMBED itself does not change the file
size materially (it returns pixels in the same shape), so every number below is a
true measurement of the pipeline's size behaviour. What it does NOT measure is
watermark recoverability — that needs the checkpoint and is scripted separately
in scripts/validate_compression.py.

Usage (service venv):
    python scripts/size_report.py [--pages N] [--json out.json]
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import issuance  # noqa: E402
from app.pdf_optimize import AGGRESSIVE, BALANCED, CONSERVATIVE, LOSSLESS  # noqa: E402
from app.preprocess import render_master  # noqa: E402
from app.storage import LocalPrivateStorage  # noqa: E402


class IdentityModel:
    """Same tensor in, same tensor out: isolates ENCODING size from model effects."""

    def embed_image(self, image_chw, payload: int):
        return np.asarray(image_chw, dtype=np.float32)


def _vector_text_pdf(pages: int, lines: int = 64, width: float = 595.0, height: float = 842.0) -> bytes:
    """A REAL vector PDF: Type-1 Helvetica, no embedded font, no raster at all.

    This is the shape of a typical doctor upload (text, selectable, small). Written
    by hand so the measurement does not depend on a PDF library's own compression
    choices — the point is to show what happens when such a document is turned into
    per-page rasters.
    """
    contents: list[bytes] = []
    for page in range(pages):
        parts = ["BT", "/F1 7 Tf", f"10 {height - 12:.0f} Td", "10.5 TL"]
        for line in range(lines):
            parts.append(f"(Page {page + 1} line {line + 1}: clinical pharmacology, therapeutic "
                         f"index and dosing considerations for the reader) Tj T*")
        parts.append("ET")
        contents.append("\n".join(parts).encode("latin-1"))

    out = bytearray(b"%PDF-1.4\n")
    offsets: dict[int, int] = {}

    def add(num: int, body: bytes) -> None:
        offsets[num] = len(out)
        out.extend(f"{num} 0 obj\n".encode())
        out.extend(body)
        out.extend(b"\nendobj\n")

    page_ids = [(4 + i * 2, 5 + i * 2) for i in range(len(contents))]
    add(1, b"<< /Type /Catalog /Pages 2 0 R >>")
    add(2, (f"<< /Type /Pages /Count {len(page_ids)} /Kids ["
             + " ".join(f"{pid} 0 R" for pid, _ in page_ids) + "] >>").encode())
    add(3, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    for (page_id, content_id), content in zip(page_ids, contents):
        add(page_id, (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width:.0f} {height:.0f}] "
                      f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>").encode())
        add(content_id, f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream")
    xref_pos = len(out)
    count = max(offsets) + 1
    out.extend(f"xref\n0 {count}\n".encode())
    out.extend(b"0000000000 65535 f \n")
    for num in range(1, count):
        out.extend(f"{offsets[num]:010d} 00000 n \n".encode())
    out.extend(f"trailer\n<< /Size {count} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode())
    return bytes(out)


def _save_pdf(images: list[Image.Image], resolution: float) -> bytes:
    buf = io.BytesIO()
    images[0].save(buf, format="PDF", save_all=True, append_images=images[1:], resolution=resolution)
    return buf.getvalue()


def text_page(n: int, width=1240, height=1754) -> Image.Image:
    img = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    try:
        from PIL import ImageFont

        font = ImageFont.load_default(size=17)
        small = ImageFont.load_default(size=13)
    except Exception:
        font = small = None
    draw.text((90, 80), f"Chapter {n}: Clinical pharmacology", fill=(10, 10, 10), font=font)
    for line in range(45):
        y = 150 + line * 33
        draw.text((90, y), f"{line:02d}  " + "Therapeutic index and dosing considerations " * 2,
                  fill=(25, 25, 30), font=small)
    return img


def scanned_page(seed: int, width=1240, height=1754) -> Image.Image:
    rng = np.random.default_rng(seed)
    base = rng.normal(232, 10, (height, width, 3)).clip(0, 255).astype(np.uint8)
    img = Image.fromarray(base, "RGB")
    draw = ImageDraw.Draw(img)
    for line in range(40):
        draw.line((80, 90 + line * 38, width - 90, 90 + line * 38), fill=(35, 35, 40), width=4)
    return img


def mixed_page(n: int, width=1240, height=1754) -> Image.Image:
    img = text_page(n, width, height)
    draw = ImageDraw.Draw(img)
    rng = np.random.default_rng(n + 100)
    block = rng.normal(190, 35, (420, 520, 3)).clip(0, 255).astype(np.uint8)
    img.paste(Image.fromarray(block, "RGB"), (620, 1000))
    draw.rectangle((620, 1000, 1140, 1420), outline=(60, 60, 60), width=3)
    return img


def graphics_page(n: int, width=1240, height=1754) -> Image.Image:
    """Repeated logo/vector-ish blocks — the 'same graphic on every page' case."""
    img = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    for row in range(6):
        for col in range(4):
            x, y = 90 + col * 280, 140 + row * 240
            draw.rounded_rectangle((x, y, x + 240, y + 200), radius=18, outline=(20, 90, 160), width=5)
            draw.ellipse((x + 60, y + 40, x + 180, y + 160), outline=(160, 60, 40), width=5)
            draw.text((x + 20, y + 170), f"Logo {row}-{col}", fill=(20, 20, 20))
    return img


DOCS = {
    "vector text (20 pages, selectable)": lambda: _vector_text_pdf(20),
    "text-only raster (12 pages)": lambda: _save_pdf([text_page(i) for i in range(12)], 150.0),
    "scanned (3 pages @150dpi)": lambda: _save_pdf([scanned_page(i) for i in range(3)], 150.0),
    "mixed text+image (4 pages)": lambda: _save_pdf([mixed_page(i) for i in range(4)], 150.0),
    "high-resolution scan (2 pages @300dpi)": lambda: _save_pdf(
        [scanned_page(i, 2480, 3508) for i in range(2)], 300.0),
    "repeated graphics (8 pages)": lambda: _save_pdf([graphics_page(i) for i in range(8)], 150.0),
}


def measure(name: str, source: bytes, workdir: Path) -> dict:
    storage = LocalPrivateStorage(workdir / "storage")
    key = "originals/mat/v1.pdf"
    storage.put_bytes(key, source)

    t0 = time.perf_counter()
    manifest = render_master(storage, material_id="mat", version_id="v1", source_key=key,
                             dpi=150, max_pages=200, pdf_version="5.1.0")
    master_seconds = time.perf_counter() - t0
    master_bytes = sum(storage.size(p["key"]) for p in manifest["pages"])

    row = {
        "document": name,
        "pages": len(manifest["pages"]),
        "original": len(source),
        "master": master_bytes,
        "master_seconds": round(master_seconds, 2),
        "page_px": f'{manifest["pages"][0]["width"]}x{manifest["pages"][0]["height"]}',
        "profiles": {},
    }
    for profile in (LOSSLESS, CONSERVATIVE, BALANCED, AGGRESSIVE):
        t0 = time.perf_counter()
        data = issuance.build_personalised_pdf(storage=storage, manifest=manifest,
                                               model=IdentityModel(), payload=0x1234ABCD,
                                               source_dpi=manifest["settings"]["dpi"],
                                               profile=profile)
        seconds = time.perf_counter() - t0
        # "Delivered" = the bytes PHP receives from /internal/files, i.e. exactly these.
        row["profiles"][profile.name] = {
            "bytes": len(data),
            "seconds": round(seconds, 2),
            "ratio_vs_original": round(len(data) / len(source), 2),
            "dct": b"/DCTDecode" in data,
        }
    return row


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", default="")
    args = parser.parse_args()

    rows = []
    with tempfile.TemporaryDirectory() as tmp:
        for index, (name, builder) in enumerate(DOCS.items()):
            workdir = Path(tmp) / f"doc{index}"
            workdir.mkdir(parents=True, exist_ok=True)
            source = builder()
            rows.append(measure(name, source, workdir))
            print(f"measured: {name}", file=sys.stderr)

    print("\n| document | pages | original | master PNGs | personalised (lossless) | conservative | balanced (default) | aggressive | balanced vs original |")
    print("|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for row in rows:
        p = row["profiles"]
        print("| {doc} | {pages} | {orig} | {master} | {lossless} | {cons} | {bal} | {aggr} | {ratio}x |".format(
            doc=row["document"], pages=row["pages"],
            orig=_human(row["original"]), master=_human(row["master"]),
            lossless=_human(p["lossless"]["bytes"]),
            cons=_human(p["conservative"]["bytes"]),
            bal=_human(p["balanced"]["bytes"]),
            aggr=_human(p["aggressive"]["bytes"]),
            ratio=p["balanced"]["ratio_vs_original"]))

    print("\n| document | page px | original | balanced | increase vs original | ratio | build s (balanced) |")
    print("|---|---|---:|---:|---:|---:|---:|")
    for row in rows:
        bal = row["profiles"]["balanced"]
        delta = bal["bytes"] - row["original"]
        print(f'| {row["document"]} | {row["page_px"]} | {_human(row["original"])} | {_human(bal["bytes"])} '
              f'| {_signed(delta)} | {bal["ratio_vs_original"]}x | {bal["seconds"]} |')

    payload = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "note": "size measured with an identity embedder; watermark recovery NOT measured here",
               "rows": rows}
    if args.json:
        Path(args.json).write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return 0


def _human(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / (1024 * 1024):.2f} MB"
    return f"{n / 1024:.1f} KB"


def _signed(n: int) -> str:
    return ("+" if n >= 0 else "-") + _human(abs(n))


if __name__ == "__main__":
    raise SystemExit(main())
