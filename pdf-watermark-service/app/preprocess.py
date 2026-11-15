"""Upload-time preprocessing: render an original PDF into versioned master page assets.

Master assets contain NO student data. They are written once per material version and reused
by every personalised issuance. Layout in private storage:

    masters/<material_id>/<version_id>/page-0001.png ...
    masters/<material_id>/<version_id>/manifest.json   (written LAST; its presence marks completion)

Idempotency: the manifest records the SHA-256 of the source PDF and the render settings. A repeat
run with the same source and settings returns the existing manifest without re-rendering. If the
source or settings differ, the version is re-rendered and the manifest is replaced atomically.
Page files are written atomically before the manifest, so a partial run is never reported complete.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import threading
import threading
from importlib.metadata import version as _pkg_version

import pypdfium2 as pdfium
from PIL import Image

from .storage import LocalPrivateStorage

RENDERER = "pypdfium2"
MANIFEST_SCHEMA = 1
PREPROCESS_KIND = "preprocess_master"
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class PreprocessError(RuntimeError):
    pass


def _check_id(name: str, value: str) -> str:
    if not isinstance(value, str) or not _ID.match(value):
        raise PreprocessError(f"invalid {name}")
    return value


def master_prefix(material_id: str, version_id: str) -> str:
    return f"masters/{_check_id('material_id', material_id)}/{_check_id('version_id', version_id)}"


def pdf_renderer_version() -> str:
    """Installed pypdfium2 version. The endpoint and the worker must derive the same value."""
    return _pkg_version("pypdfium2")


def fingerprint(source_sha256: str, settings: dict) -> str:
    """Stable id for one (source bytes, render settings) combination. Each combination gets its own
    directory, so a changed source or DPI never overwrites the assets of another combination."""
    canonical = json.dumps({"source_sha256": source_sha256, "settings": settings}, sort_keys=True,
                           separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()[:24]


def output_prefix(material_id: str, version_id: str, source_sha256: str, settings: dict) -> str:
    return f"{master_prefix(material_id, version_id)}/{fingerprint(source_sha256, settings)}"


_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def _lock_for(prefix: str) -> threading.Lock:
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(prefix, threading.Lock())


def render_master(
    storage: LocalPrivateStorage,
    *,
    material_id: str,
    version_id: str,
    source_key: str,
    dpi: int,
    max_pages: int,
    pdf_version: str,
) -> dict:
    """Render a version's master pages. Returns the manifest (dict).

    Concurrent calls for the same output are serialised in-process: the first call renders and
    publishes the manifest, and the others return that manifest without re-rendering.
    """
    if not source_key.startswith("originals/"):
        raise PreprocessError("source must be in the originals/ prefix")
    source = storage.get_bytes(source_key)
    source_sha = hashlib.sha256(source).hexdigest()
    settings = {"dpi": dpi, "renderer": RENDERER, "renderer_version": pdf_version}
    prefix = output_prefix(material_id, version_id, source_sha, settings)
    with _lock_for(prefix):
        return _render_locked(storage, source, source_sha, settings, prefix,
                              material_id=material_id, version_id=version_id, source_key=source_key,
                              dpi=dpi, max_pages=max_pages)


def _render_locked(storage, source, source_sha, settings, prefix, *, material_id, version_id,
                   source_key, dpi, max_pages) -> dict:
    existing = _read_manifest(storage, f"{prefix}/manifest.json")
    if existing is not None and existing.get("source_sha256") == source_sha and existing.get("settings") == settings:
        if all(storage.exists(p["key"]) for p in existing["pages"]):
            return existing  # already processed with identical inputs

    try:
        doc = pdfium.PdfDocument(source)
    except Exception as exc:  # pdfium raises PdfiumError for corrupt or encrypted files
        raise PreprocessError(f"source is not a readable PDF: {type(exc).__name__}") from exc

    try:
        page_count = len(doc)
        if page_count < 1:
            raise PreprocessError("source PDF has no pages")
        if page_count > max_pages:
            raise PreprocessError(f"source PDF has {page_count} pages; limit is {max_pages}")
        pages = []
        scale = dpi / 72.0
        for index in range(page_count):
            page = doc[index]
            try:
                bitmap = page.render(scale=scale)
                rendered = bitmap.to_pil()
                # Flatten onto white so transparent page areas are not stored as black pixels.
                image = Image.new("RGB", rendered.size, (255, 255, 255))
                image.paste(rendered.convert("RGBA"), (0, 0), rendered.convert("RGBA"))
                rendered.close()
                buf = io.BytesIO()
                image.save(buf, format="PNG", optimize=False)
                data = buf.getvalue()
                key = f"{prefix}/page-{index + 1:04d}.png"
                storage.put_bytes(key, data)
                pages.append({
                    "index": index + 1,
                    "key": key,
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "width": image.width,
                    "height": image.height,
                })
                image.close()
                bitmap.close()
            finally:
                page.close()
    finally:
        doc.close()

    manifest = {
        "schema": MANIFEST_SCHEMA,
        "material_id": material_id,
        "version_id": version_id,
        "source_key": source_key,
        "source_sha256": source_sha,
        "settings": settings,
        "page_count": page_count,
        "manifest_key": f"{prefix}/manifest.json",
        "pages": pages,
    }
    storage.put_bytes(f"{prefix}/manifest.json", json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode())
    return manifest


def _read_manifest(storage: LocalPrivateStorage, key: str) -> dict | None:
    if not storage.exists(key):
        return None
    try:
        return json.loads(storage.get_bytes(key))
    except (ValueError, json.JSONDecodeError):
        return None


def handle_preprocess_job(storage: LocalPrivateStorage, *, dpi: int, max_pages: int):
    """Build the worker handler for kind 'preprocess_master'."""
    renderer_version = pdf_renderer_version()

    def handler(payload: dict) -> dict:
        manifest = render_master(
            storage,
            material_id=payload["material_id"],
            version_id=payload["version_id"],
            source_key=payload["source_key"],
            dpi=dpi,
            max_pages=max_pages,
            pdf_version=renderer_version,
        )
        return {"manifest_key": manifest["manifest_key"], "page_count": manifest["page_count"]}

    return handler
