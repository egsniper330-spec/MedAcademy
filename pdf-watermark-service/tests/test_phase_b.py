"""Phase B: upload-time preprocessing into versioned master page assets."""

from __future__ import annotations

import io
import json
import secrets
import sys
import time
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import auth  # noqa: E402
from app.config import Settings  # noqa: E402
from app.preprocess import PreprocessError, master_prefix, render_master  # noqa: E402
from app.storage import LocalPrivateStorage  # noqa: E402

SECRET = "s" * 40
NONCE = "abcdefghijklmnop5678"


def _pdf(pages: int, color=(0, 0, 0)) -> bytes:
    """Build a real multi-page PDF with Pillow. Each page is a solid block of colour."""
    images = [Image.new("RGB", (612, 792), color) for _ in range(pages)]
    buf = io.BytesIO()
    images[0].save(buf, format="PDF", save_all=True, append_images=images[1:], resolution=72.0)
    return buf.getvalue()


def _storage(tmp_path: Path, pdf: bytes, key: str = "originals/mat1/v1.pdf") -> LocalPrivateStorage:
    storage = LocalPrivateStorage(tmp_path / "st")
    storage.put_bytes(key, pdf)
    return storage


def test_renders_one_png_per_page_and_writes_manifest(tmp_path: Path):
    storage = _storage(tmp_path, _pdf(3))
    m = render_master(storage, material_id="mat1", version_id="v1", source_key="originals/mat1/v1.pdf",
                      dpi=72, max_pages=10, pdf_version="5.1.0")
    assert m["page_count"] == 3
    for page in m["pages"]:
        assert storage.exists(page["key"])
        img = Image.open(io.BytesIO(storage.get_bytes(page["key"])))
        assert img.format == "PNG" and img.mode == "RGB"
        assert (img.width, img.height) == (page["width"], page["height"])
    manifest = json.loads(storage.get_bytes(m["manifest_key"]))
    assert manifest["source_sha256"] and manifest["settings"]["dpi"] == 72
    assert manifest["manifest_key"].startswith("masters/mat1/v1/") and manifest["manifest_key"].endswith("/manifest.json")
    # Master assets contain no student data: manifest holds only ids, keys, hashes and settings.
    assert set(manifest) == {"schema", "material_id", "version_id", "source_key", "source_sha256",
                             "settings", "page_count", "manifest_key", "pages"}


def test_repeat_run_is_idempotent_and_does_not_rerender(tmp_path: Path):
    storage = _storage(tmp_path, _pdf(2))
    kwargs = dict(material_id="mat1", version_id="v1", source_key="originals/mat1/v1.pdf",
                  dpi=72, max_pages=10, pdf_version="5.1.0")
    first = render_master(storage, **kwargs)
    key = first["pages"][0]["key"]
    mtime_before = storage.root.joinpath(*key.split("/")).stat().st_mtime_ns
    time.sleep(0.02)
    second = render_master(storage, **kwargs)
    assert second == first
    assert storage.root.joinpath(*key.split("/")).stat().st_mtime_ns == mtime_before


def test_changed_source_rerenders_the_version(tmp_path: Path):
    storage = _storage(tmp_path, _pdf(1, color=(0, 0, 0)))
    kwargs = dict(material_id="mat1", version_id="v1", source_key="originals/mat1/v1.pdf",
                  dpi=72, max_pages=10, pdf_version="5.1.0")
    first = render_master(storage, **kwargs)
    storage.put_bytes("originals/mat1/v1.pdf", _pdf(1, color=(255, 0, 0)))
    second = render_master(storage, **kwargs)
    assert second["source_sha256"] != first["source_sha256"]
    assert second["pages"][0]["sha256"] != first["pages"][0]["sha256"]


def test_changed_render_settings_rerender(tmp_path: Path):
    storage = _storage(tmp_path, _pdf(1))
    base = dict(material_id="mat1", version_id="v1", source_key="originals/mat1/v1.pdf",
                max_pages=10, pdf_version="5.1.0")
    low = render_master(storage, dpi=72, **base)
    high = render_master(storage, dpi=144, **base)
    assert high["settings"]["dpi"] == 144
    assert high["pages"][0]["width"] > low["pages"][0]["width"]


def test_rejects_too_many_pages_and_corrupt_pdf(tmp_path: Path):
    storage = _storage(tmp_path, _pdf(3))
    with pytest.raises(PreprocessError, match="limit"):
        render_master(storage, material_id="mat1", version_id="v1", source_key="originals/mat1/v1.pdf",
                      dpi=72, max_pages=2, pdf_version="5.1.0")
    storage.put_bytes("originals/mat1/bad.pdf", b"not a pdf at all")
    with pytest.raises(PreprocessError, match="not a readable PDF"):
        render_master(storage, material_id="mat1", version_id="v2", source_key="originals/mat1/bad.pdf",
                      dpi=72, max_pages=2, pdf_version="5.1.0")


def test_rejects_bad_ids_and_non_original_source(tmp_path: Path):
    storage = _storage(tmp_path, _pdf(1))
    with pytest.raises(PreprocessError):
        master_prefix("../etc", "v1")
    with pytest.raises(PreprocessError, match="originals"):
        render_master(storage, material_id="mat1", version_id="v1", source_key="masters/mat1/v1/page-0001.png",
                      dpi=72, max_pages=10, pdf_version="5.1.0")


def _signed(client, method: str, path: str, body: bytes = b""):
    # Fresh nonce per request: the server rejects replayed nonces.
    ts = int(time.time())
    nonce = secrets.token_hex(12)
    sig = auth.sign(SECRET.encode(), method, path, str(ts), nonce, body)
    return {"X-Key-Id": "k1", "X-Timestamp": str(ts), "X-Nonce": nonce, "X-Signature": sig,
            "Content-Type": "application/json"}


def test_endpoint_enqueues_idempotent_preprocess_job(tmp_path: Path):
    from fastapi.testclient import TestClient

    from app.main import create_app

    settings = Settings(hmac_keys=f"k1:{SECRET}", storage_root=tmp_path / "st",
                        state_db_path=tmp_path / "st.sqlite3", worker_count=1)
    app = create_app(settings)
    body = json.dumps({"material_id": "mat1", "version_id": "v1", "source_key": "originals/mat1/v1.pdf"}).encode()
    with TestClient(app) as client:
        client.app.state.storage.put_bytes("originals/mat1/v1.pdf", _pdf(2))
        # Pool may process the job in the background; stop it so the queue state is deterministic.
        client.app.state.pool.stop()
        r1 = client.post("/internal/masters/preprocess", content=body,
                         headers=_signed(client, "POST", "/internal/masters/preprocess", body))
        assert r1.status_code == 202 and r1.json()["created"] is True
        r2 = client.post("/internal/masters/preprocess", content=body,
                         headers=_signed(client, "POST", "/internal/masters/preprocess", body))
        assert r2.status_code == 202 and r2.json() == {"job_id": r1.json()["job_id"], "created": False}
        assert client.post("/internal/masters/preprocess", content=b"{}",
                           headers=_signed(client, "POST", "/internal/masters/preprocess", b"{}")).status_code == 422
        bad = json.dumps({"material_id": "mat1", "version_id": "v1", "source_key": "../x"}).encode()
        assert client.post("/internal/masters/preprocess", content=bad,
                           headers=_signed(client, "POST", "/internal/masters/preprocess", bad)).status_code == 422


def test_endpoint_requires_signature(tmp_path: Path):
    from fastapi.testclient import TestClient

    from app.main import create_app

    settings = Settings(hmac_keys=f"k1:{SECRET}", storage_root=tmp_path / "st",
                        state_db_path=tmp_path / "st.sqlite3", worker_count=1)
    with TestClient(create_app(settings)) as client:
        r = client.post("/internal/masters/preprocess", content=b"{}")
        assert r.status_code == 401
