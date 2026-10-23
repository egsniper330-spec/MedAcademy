#!/usr/bin/env python3
"""removal_attacks.py — real removal-resistance tests for a delivered PDF.

This is a DEVELOPER/VALIDATION tool, not part of the product. It needs Python
packages that the backend never uses (pikepdf for PDF-level editing, PyMuPDF for
rendering/text, numpy/Pillow for image-domain attacks):

    python -m pip install pikepdf pymupdf numpy pillow

It answers one question with numbers instead of opinions: *given these delivered
bytes, how easily can an ordinary attacker make the visible watermark go away,
and what does that cost the document?*

Attacks (each one is what a real person would try, in increasing effort):

  pdf_text_strip        delete every text-showing operator from the page content
  pdf_keep_page_form    keep ONLY the lecture Form XObject, drop everything else
  pdf_identity_redact   delete only text runs that carry the identity string
  pdf_image_strip       delete page-level image XObject invocations
  pdf_white_boxes       paint white rectangles over every visible identity match
  pdf_edge_strips       paint white bands over the page margins/edge rails
  pdf_fullpage_wash     ­60%-opaque white sheet over the whole page
  pdf_crop_inset        crop 36pt off every edge
  img_tone_window       flatten, then map the watermark's grey band to white
  img_binarize_190      flatten, then binarise at 190 (keeps dark ink only)
  img_binarize_128      flatten, then binarise at 128 (aggressive)
  combo_binarize_crop   flatten + binarise at 190, then crop 36pt off every edge

Metrics are measured on REAL renders: the watermarked PDF is rendered next to the
unwatermarked source at the same DPI, so "watermark ink" is the set of pixels the
watermark changed, and "content preserved" is the share of source dark ink that
survives the attack.

    python removal_attacks.py --pdf out/student-a.pdf --source fixtures/source.pdf \
        --identity "Test Student Alpha • MED-0042" --id MED-0042 \
        --outdir out/removal --dpi 150
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
import pikepdf
import pymupdf
from PIL import Image

# ── PDF helpers ──────────────────────────────────────────────────────────────

TEXT_OP = re.compile(
    rb"\((?:\\.|[^()\\])*\)\s*(?:Tj|'|\")"  # (str) Tj / ' / "
    rb"|\[(?:[^\[\]\\]|\\.)*\]\s*TJ"          # [ ... ] TJ
    rb"|<\w+>\s*Tj",                          # <hex> Tj
    re.S,
)
DO_OP = re.compile(rb"/([A-Za-z0-9#_.+-]+)\s+Do")


def page_content(page_obj) -> bytes:
    contents = page_obj.get("/Contents")
    if isinstance(contents, pikepdf.Array):
        return b"".join(bytes(s.read_bytes()) for s in contents)
    if contents is None:
        return b""
    return bytes(contents.read_bytes())


def write_page_content(pdf, page_obj, data: bytes) -> None:
    page_obj["/Contents"] = pdf.make_stream(data)


def iter_pages(pdf):
    return [pdf.pages[i] for i in range(len(pdf.pages))]


def page_size_pt(page) -> tuple[float, float]:
    box = page.obj.get("/MediaBox")
    return float(box[2]) - float(box[0]), float(box[3]) - float(box[1])


def form_bbox(obj):
    box = obj.get("/BBox")
    if box is None:
        return None
    return tuple(float(v) for v in box)


def utf16_needles(identity: str) -> list[bytes]:
    """The identity can be stored as plain PDFDocEncoding or UTF-16BE bytes."""
    out = [identity.encode("latin-1", "ignore")]
    out.append(identity.encode("utf-16-be"))
    # PDF literal strings escape parentheses/backslash
    escaped = []
    for needle in out:
        escaped.append(needle.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)"))
    return [n for n in out + escaped if n]


def save(pdf, path: Path) -> None:
    # Object streams disabled so the saved file is easy to re-inspect; this does
    # not change what the attack does to the drawing operators.
    pdf.save(path, object_stream_mode=pikepdf.ObjectStreamMode.disable, compress_streams=True)


# ── Rendering / metrics ──────────────────────────────────────────────────────


def render(doc: pymupdf.Document, index: int, dpi: int, clip=None) -> np.ndarray:
    page = doc[index]
    kwargs = {"dpi": dpi, "colorspace": pymupdf.csGRAY, "alpha": False}
    if clip is not None:
        kwargs["clip"] = pymupdf.Rect(clip)
    pix = page.get_pixmap(**kwargs)
    arr = np.frombuffer(pix.samples, dtype=np.uint8)
    return arr.reshape(pix.height, pix.width)


def same_shape(a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    h = min(a.shape[0], b.shape[0])
    w = min(a.shape[1], b.shape[1])
    return a[:h, :w], b[:h, :w]


def measure(src_path: Path, delivered_path: Path, attacked_path: Path, identity: str,
            identity_id: str, dpi: int, clip_by_page: dict[int, tuple] | None = None,
            attacked_has_crop: bool = False) -> dict:
    """Compare source -> delivered -> attacked, page by page.

    "Watermark ink" is the set of pixels the delivery changed relative to the
    unwatermarked source. An attack SUCCEEDS on a pixel when the attacked render
    is back to the source value. Content is the source's own dark ink; it is
    "preserved" when the attacked render still has it dark.
    """
    src = pymupdf.open(src_path)
    tgt = pymupdf.open(delivered_path)
    att = pymupdf.open(attacked_path)
    pages = min(len(src), len(tgt), len(att))
    wm_before_total = wm_after_total = content_total = content_kept = wm_on_content = 0
    wm_in_content_area = wm_total_in_area = blocks_total = blocks_touched = 0
    page_pixels = 0
    identity_pages_before = identity_pages_after = 0
    per_page = []

    for i in range(pages):
        clip = (clip_by_page or {}).get(i)
        s = render(src, i, dpi, clip)
        d = render(tgt, i, dpi, clip)
        # A cropped PDF already renders only its CropBox; clipping it AGAIN would
        # shrink the comparison to a different region.
        a = render(att, i, dpi, None if attacked_has_crop else clip)
        s, d = same_shape(s, d)
        s, a = same_shape(s, a)
        page_pixels += int(s.size)

        wm_ink = np.abs(s.astype(np.int16) - d.astype(np.int16)) > 10
        still_there = np.abs(s.astype(np.int16) - a.astype(np.int16)) > 10
        content = s < 110          # ink that belongs to the lecture
        kept = a < 150             # still reasonably dark after the attack
        overlapped = wm_ink & content

        wm_before_total += int(wm_ink.sum())
        wm_after_total += int((wm_ink & still_there).sum())
        wm_on_content += int(overlapped.sum())
        content_total += int(content.sum())
        content_kept += int((content & kept).sum())

        # Does the watermark reach the CONTENT AREA (not just the margins)?
        # Measured two ways: ink inside the source's non-white bounding box, and
        # the share of the source's text blocks that a mark touches.
        rows_cols = np.where(s < 245)
        if rows_cols[0].size:
            r0, r1 = int(rows_cols[0].min()), int(rows_cols[0].max())
            c0, c1 = int(rows_cols[1].min()), int(rows_cols[1].max())
            area = np.zeros_like(wm_ink)
            area[r0:r1 + 1, c0:c1 + 1] = True
            wm_in_content_area += int((wm_ink & area).sum())
            wm_total_in_area += int(wm_ink.sum())
            scale = dpi / 72.0
            for block in src[i].get_text("blocks"):
                bx0, by0, bx1, by1 = block[:4]
                blocks_total += 1
                br0 = max(0, int(by0 * scale))
                br1 = min(wm_ink.shape[0] - 1, int(by1 * scale))
                bc0 = max(0, int(bx0 * scale))
                bc1 = min(wm_ink.shape[1] - 1, int(bx1 * scale))
                if br1 <= br0 or bc1 <= bc0:
                    continue
                if wm_ink[br0:br1, bc0:bc1].any():
                    blocks_touched += 1

        has_delivered = identity in tgt[i].get_text() or identity_id in tgt[i].get_text()
        has_after = identity in att[i].get_text() or identity_id in att[i].get_text()
        identity_pages_before += int(has_delivered)
        identity_pages_after += int(has_after)
        per_page.append({
            "page": i + 1,
            "watermark_ink_pct": round(100.0 * float(wm_ink.mean()), 3),
            "watermark_removed_pct": round(
                100.0 * float((wm_ink & ~still_there).sum()) / float(wm_ink.sum()), 2
            ) if wm_ink.sum() else 0.0,
            "watermark_over_content_pct": round(
                100.0 * (float(overlapped.sum()) / float(wm_ink.sum())) if wm_ink.sum() else 0.0, 2
            ),
            "content_preserved_pct": round(100.0 * float((content & kept).sum()) / float(content.sum()), 2)
            if content.sum() else 100.0,
            "identity_in_text": has_after,
        })

    removal = 0.0
    if wm_before_total:
        removal = 100.0 * (wm_before_total - wm_after_total) / wm_before_total

    return {
        "pages": pages,
        # Share of page AREA the watermark changed (render diff vs the source).
        "watermark_ink_pct": round(100.0 * wm_before_total / max(1, page_pixels), 3),
        "watermark_ink_remaining_pct": round(100.0 * wm_after_total / max(1, page_pixels), 3),
        "watermark_on_content_pct": round(100.0 * wm_on_content / max(1, wm_before_total), 2),
        "watermark_in_content_area_pct": round(100.0 * wm_in_content_area / max(1, wm_total_in_area), 2),
        "content_blocks_touched_pct": round(100.0 * blocks_touched / max(1, blocks_total), 2),
        "removal_pct": round(removal, 2),
        "content_preserved_pct": round(100.0 * content_kept / max(1, content_total), 2),
        "identity_pages_before": identity_pages_before,
        "identity_pages_after": identity_pages_after,
        "per_page": per_page,
    }


def describe_render(attacked_path: Path, source_path: Path, page_count: int,
                    dpi: int) -> dict:
    """Structural facts about the attacked file (text layer, fonts, images)."""
    data = attacked_path.read_bytes()
    doc = pymupdf.open(attacked_path)
    return {
        "bytes": len(data),
        "page_count": len(doc),
        "has_font_objects": bool(re.search(rb"/Type\s*/Font", data)),
        "has_image_xobjects": bool(re.search(rb"/Subtype\s*/Image", data)),
        "has_form_xobjects": bool(re.search(rb"/Subtype\s*/Form", data)),
        "extractable_text_chars": sum(len(doc[i].get_text()) for i in range(min(page_count, len(doc)))),
    }


# ── Attacks ──────────────────────────────────────────────────────────────────


def attack_pdf_text_strip(src: Path, dst: Path) -> None:
    pdf = pikepdf.open(src)
    for page in iter_pages(pdf):
        data = page_content(page.obj)
        write_page_content(pdf, page.obj, TEXT_OP.sub(b"", data))
    save(pdf, dst)


def attack_pdf_keep_page_form(src: Path, dst: Path) -> None:
    """Keep only `q ... /TPLn Do ... Q` groups that paint the lecture page."""
    pdf = pikepdf.open(src)
    for page in iter_pages(pdf):
        data = page_content(page.obj)
        w, h = page_size_pt(page)
        xobj = page.obj.get("/Resources", {}).get("/XObject", {})
        keep = bytearray()
        for m in DO_OP.finditer(data):
            name = b"/" + m.group(1)
            ref = xobj.get(name.decode("latin-1")) or xobj.get(name.decode("latin-1")).get_object()
            if ref is None or str(ref.get("/Subtype")) != "/Form":
                continue
            bbox = form_bbox(ref)
            if bbox is None or abs((bbox[2] - bbox[0]) - w) > 1 or abs((bbox[3] - bbox[1]) - h) > 1:
                continue
            start = data.rfind(b"q", 0, m.start())
            end = data.find(b"Q", m.end())
            if start == -1 or end == -1:
                continue
            keep += data[start:end + 1] + b"\n"
        write_page_content(pdf, page.obj, b"q\n" + bytes(keep) + b"\nQ\n")
    save(pdf, dst)


def attack_pdf_identity_redact(src: Path, dst: Path, identity: str) -> None:
    pdf = pikepdf.open(src)
    needles = utf16_needles(identity)
    for page in iter_pages(pdf):
        data = page_content(page.obj)
        for op in TEXT_OP.finditer(data):
            chunk = op.group(0)
            if any(n in chunk for n in needles):
                data = data[: op.start()] + data[op.end():]
        write_page_content(pdf, page.obj, data)
    save(pdf, dst)


def attack_pdf_image_strip(src: Path, dst: Path) -> None:
    pdf = pikepdf.open(src)
    for page in iter_pages(pdf):
        data = page_content(page.obj)
        xobj = page.obj.get("/Resources", {}).get("/XObject", {})
        for m in DO_OP.finditer(data):
            ref = xobj.get("/" + m.group(1).decode("latin-1"))
            if ref is not None and str(ref.get("/Subtype")) == "/Image":
                start = data.rfind(b"q", 0, m.start())
                end = data.find(b"Q", m.end())
                if start != -1 and end != -1:
                    data = data[:start] + data[end + 1:]
        write_page_content(pdf, page.obj, data)
    # Also neutralise every page-level image stream, in case it is referenced
    # again from elsewhere in the page.
    for page in iter_pages(pdf):
        xobj = page.obj.get("/Resources", {}).get("/XObject", {})
        for _name, ref in list(xobj.items()):
            if str(ref.get("/Subtype")) == "/Image":
                ref.write(b"")
    save(pdf, dst)


def _match_rects(src: Path, identity: str, identity_id: str) -> dict[int, list]:
    doc = pymupdf.open(src)
    out = {}
    for i in range(len(doc)):
        hits = doc[i].search_for(identity) or doc[i].search_for(identity_id) or []
        if hits:
            out[i] = [(r.x0, r.y0, r.x1, r.y1) for r in hits]
    return out


def attack_pdf_white_boxes(src: Path, dst: Path, identity: str, identity_id: str) -> None:
    rects = _match_rects(src, identity, identity_id)
    pdf = pikepdf.open(src)
    for i, page in enumerate(iter_pages(pdf)):
        w, h = page_size_pt(page)
        ops = [b"q 1 g\n"]
        for (x0, y0, x1, y1) in rects.get(i, []):
            x0, x1 = max(0.0, x0 - 2), min(w, x1 + 2)
            y0, y1 = max(0.0, h - y1 - 2), min(h, h - y0 + 2)
            if x1 - x0 < 0.5 or y1 - y0 < 0.5:
                continue
            ops.append(b"%.2f %.2f %.2f %.2f re f\n" % (x0, y0, x1 - x0, y1 - y0))
        ops.append(b"Q\n")
        write_page_content(pdf, page.obj, page_content(page.obj) + b"\n" + b"".join(ops))
    save(pdf, dst)


def attack_pdf_edge_strips(src: Path, dst: Path, band: float = 30.0) -> None:
    pdf = pikepdf.open(src)
    for page in iter_pages(pdf):
        w, h = page_size_pt(page)
        ops = (
            b"q 1 g\n"
            + b"0 0 %.2f %.2f re f\n" % (w, band)
            + b"0 %.2f %.2f %.2f re f\n" % (h - band, w, band)
            + b"0 0 %.2f %.2f re f\n" % (band, h)
            + b"%.2f 0 %.2f %.2f re f\n" % (w - band, band, h)
            + b"Q\n"
        )
        write_page_content(pdf, page.obj, page_content(page.obj) + b"\n" + ops)
    save(pdf, dst)


def attack_pdf_fullpage_wash(src: Path, dst: Path, alpha: float = 0.6) -> None:
    pdf = pikepdf.open(src)
    gs = pdf.make_indirect(pikepdf.Dictionary(
        {"/Type": pikepdf.Name("/ExtGState"), "/ca": alpha, "/CA": alpha}
    ))
    for page in iter_pages(pdf):
        w, h = page_size_pt(page)
        res = page.obj.get("/Resources")
        if res is None:
            res = pdf.make_indirect(pikepdf.Dictionary())
            page.obj["/Resources"] = res
        egs = res.get("/ExtGState")
        if egs is None:
            egs = pdf.make_indirect(pikepdf.Dictionary())
            res["/ExtGState"] = egs
        egs["/WMwash"] = gs
        ops = b"q /WMwash gs 1 g 0 0 %.2f %.2f re f Q\n" % (w, h)
        write_page_content(pdf, page.obj, page_content(page.obj) + b"\n" + ops)
    save(pdf, dst)


def attack_pdf_crop_inset(src: Path, dst: Path, inset: float = 36.0) -> tuple[Path, dict[int, tuple]]:
    pdf = pikepdf.open(src)
    clips = {}
    for i, page in enumerate(iter_pages(pdf)):
        box = page.obj.get("/CropBox") or page.obj.get("/MediaBox")
        x0, y0, x1, y1 = (float(v) for v in box)
        crop = [x0 + inset, y0 + inset, x1 - inset, y1 - inset]
        page.obj["/CropBox"] = pikepdf.Array(crop)
        clips[i] = (crop[0], crop[1], crop[2], crop[3])
    save(pdf, dst)
    return dst, clips


def _flatten(src: Path, out: Path, dpi: int, transform) -> dict[int, tuple]:
    """Render every page, apply `transform(array) -> array`, write an image-only PDF."""
    src_doc = pymupdf.open(src)
    out_doc = pymupdf.open()
    for i in range(len(src_doc)):
        page = src_doc[i]
        pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY, alpha=False)
        arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
        cleaned = transform(arr.copy())
        img = Image.fromarray(cleaned.astype(np.uint8), mode="L")
        rect = page.rect
        new_page = out_doc.new_page(width=rect.width, height=rect.height)
        png = Path(out).with_suffix(f".p{i + 1}.png")
        img.save(png)
        new_page.insert_image(new_page.rect, filename=str(png))
    out_doc.save(out)
    return {}


def attack_img_tone_window(src: Path, dst: Path, dpi: int) -> dict[int, tuple]:
    def transform(arr: np.ndarray) -> np.ndarray:
        # "Everything that is neither near-black nor pure white is the
        # watermark" — the classic screenshot clean-up.
        mid = (arr >= 150) & (arr <= 250)
        arr[mid] = 255
        return arr

    return _flatten(src, dst, dpi, transform)


def attack_img_binarize(src: Path, dst: Path, dpi: int, threshold: int) -> dict[int, tuple]:
    def transform(arr: np.ndarray) -> np.ndarray:
        arr[arr >= threshold] = 255
        arr[arr < threshold] = np.minimum(arr[arr < threshold], threshold - 1)
        return arr

    return _flatten(src, dst, dpi, transform)


def attack_combo_binarize_crop(src: Path, dst: Path, dpi: int) -> tuple[Path, dict[int, tuple]]:
    """The cheap FULL sequence: flatten, binarise at 190, then crop 36pt off.

    This is the attack a real redistributor reaches for once the single-step
    ones stop working: one image pass removes the tinted layers, one crop removes
    the edge rails. Whatever is still visible afterwards is the part that cannot
    be removed without repainting lecture content.
    """
    tmp = dst.with_suffix(".flatten.pdf")
    attack_img_binarize(src, tmp, dpi, 190)
    _, clips = attack_pdf_crop_inset(tmp, dst)
    tmp.unlink(missing_ok=True)
    return dst, clips


ATTACKS = {
    "pdf_text_strip": "delete all text-showing operators on the page",
    "pdf_keep_page_form": "keep only the lecture Form XObject, drop all other page ops",
    "pdf_identity_redact": "delete only the text runs that carry the identity",
    "pdf_image_strip": "delete page-level image XObject invocations",
    "pdf_white_boxes": "white rectangles over every identity match",
    "pdf_edge_strips": "white bands over all four page margins",
    "pdf_fullpage_wash": "60%-opaque white sheet over the page",
    "pdf_crop_inset": "crop 36pt off every edge",
    "img_tone_window": "flatten, map the watermark's grey band (150..250) to white",
    "img_binarize_190": "flatten, binarise at 190",
    "img_binarize_128": "flatten, binarise at 128",
    "combo_binarize_crop": "flatten + binarise at 190, then crop 36pt off every edge",
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pdf", required=True, help="delivered/watermarked PDF to attack")
    ap.add_argument("--source", required=True, help="the unwatermarked original (for measurement)")
    ap.add_argument("--identity", required=True, help='full identity line, e.g. "Ann Lee • MED-0042"')
    ap.add_argument("--id", dest="identity_id", default="", help="the account id substring, e.g. MED-0042")
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--dpi", type=int, default=150)
    ap.add_argument("--only", nargs="*", default=None, help="run only these attacks")
    args = ap.parse_args()

    pdf = Path(args.pdf)
    source = Path(args.source)
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    results = {}
    before = measure(source, pdf, pdf, args.identity, args.identity_id, args.dpi)
    print(f"baseline watermark ink: {before['watermark_ink_pct']}% of page, "
          f"{before['watermark_on_content_pct']}% of it over content")

    for name, doc in ATTACKS.items():
        if args.only and name not in args.only:
            continue
        dst = outdir / f"{name}.pdf"
        clips = None
        cropped = False
        try:
            if name == "pdf_text_strip":
                attack_pdf_text_strip(pdf, dst)
            elif name == "pdf_keep_page_form":
                attack_pdf_keep_page_form(pdf, dst)
            elif name == "pdf_identity_redact":
                attack_pdf_identity_redact(pdf, dst, args.identity)
            elif name == "pdf_image_strip":
                attack_pdf_image_strip(pdf, dst)
            elif name == "pdf_white_boxes":
                attack_pdf_white_boxes(pdf, dst, args.identity, args.identity_id)
            elif name == "pdf_edge_strips":
                attack_pdf_edge_strips(pdf, dst)
            elif name == "pdf_fullpage_wash":
                attack_pdf_fullpage_wash(pdf, dst)
            elif name == "pdf_crop_inset":
                _, clips = attack_pdf_crop_inset(pdf, dst)
                cropped = True
            elif name == "img_tone_window":
                clips = attack_img_tone_window(pdf, dst, args.dpi)
            elif name == "img_binarize_190":
                clips = attack_img_binarize(pdf, dst, args.dpi, 190)
            elif name == "img_binarize_128":
                clips = attack_img_binarize(pdf, dst, args.dpi, 128)
            elif name == "combo_binarize_crop":
                _, clips = attack_combo_binarize_crop(pdf, dst, args.dpi)
                cropped = True
            m = measure(source, pdf, dst, args.identity, args.identity_id, args.dpi, clips, cropped)
            m["structure"] = describe_render(dst, source, m["pages"], args.dpi)
            m["description"] = doc
            results[name] = m
            print(f"{name:22s} removes {m['removal_pct']:6.2f}% of watermark ink, "
                  f"content kept {m['content_preserved_pct']:6.2f}%, "
                  f"identity still in text: {m['identity_pages_after']}/{m['pages']}")
        except Exception as exc:  # noqa: BLE001 - a failed attack is a result
            results[name] = {"error": f"{type(exc).__name__}: {exc}", "description": doc}
            print(f"{name:22s} FAILED: {type(exc).__name__}: {exc}")

    report = {
        "pdf": str(pdf),
        "source": str(source),
        "identity": args.identity,
        "dpi": args.dpi,
        "baseline": before,
        "attacks": results,
    }
    (outdir / "removal-report.json").write_text(json.dumps(report, indent=2))
    print(f"\nreport: {outdir / 'removal-report.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
