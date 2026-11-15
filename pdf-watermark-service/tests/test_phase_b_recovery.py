"""Phase B verification: failure, recovery, idempotency and concurrency."""

from __future__ import annotations

import io
import json
import sys
import threading
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.preprocess import PreprocessError, fingerprint, output_prefix, render_master  # noqa: E402
from app.storage import LocalPrivateStorage  # noqa: E402

KW = dict(material_id="mat1", version_id="v1", source_key="originals/mat1/v1.pdf",
          dpi=72, max_pages=10, pdf_version="5.1.0")


def _pdf(pages: int, color=(0, 0, 0)) -> bytes:
    images = [Image.new("RGB", (612, 792), color) for _ in range(pages)]
    buf = io.BytesIO()
    images[0].save(buf, format="PDF", save_all=True, append_images=images[1:], resolution=72.0)
    return buf.getvalue()


def _storage(tmp_path: Path, pdf: bytes) -> LocalPrivateStorage:
    storage = LocalPrivateStorage(tmp_path / "st")
    storage.put_bytes("originals/mat1/v1.pdf", pdf)
    return storage


class FailingStorage(LocalPrivateStorage):
    """Storage that fails on the Nth write whose key matches a fragment. Models a crash mid-run."""

    def __init__(self, root: Path, fail_on: str, after: int = 0) -> None:
        super().__init__(root)
        self._fail_on = fail_on
        self._remaining = after

    def put_bytes(self, key: str, data: bytes) -> None:
        if self._fail_on in key:
            if self._remaining == 0:
                raise OSError("simulated write failure")
            self._remaining -= 1
        super().put_bytes(key, data)


def _manifest_key(storage, pdf_bytes: bytes, settings_dpi: int = 72) -> str:
    import hashlib
    sha = hashlib.sha256(pdf_bytes).hexdigest()
    settings = {"dpi": settings_dpi, "renderer": "pypdfium2", "renderer_version": "5.1.0"}
    return f"{output_prefix('mat1', 'v1', sha, settings)}/manifest.json"


def test_failure_mid_page_write_leaves_no_manifest_and_retry_succeeds(tmp_path: Path):
    pdf = _pdf(3)
    storage = _storage(tmp_path, pdf)
    flaky = FailingStorage(tmp_path / "st", fail_on="page-0002", after=0)
    with pytest.raises(OSError, match="simulated"):
        render_master(flaky, **KW)
    key = _manifest_key(storage, pdf)
    assert not storage.exists(key), "manifest must not exist after a partial run"
    manifest = render_master(storage, **KW)  # clean retry
    assert storage.exists(manifest["manifest_key"])
    assert manifest["page_count"] == 3


def test_failure_immediately_before_manifest_publish_is_not_complete(tmp_path: Path):
    pdf = _pdf(2)
    storage = _storage(tmp_path, pdf)
    flaky = FailingStorage(tmp_path / "st", fail_on="manifest.json", after=0)
    with pytest.raises(OSError):
        render_master(flaky, **KW)
    key = _manifest_key(storage, pdf)
    assert not storage.exists(key)
    # Pages exist but are not reported complete; a rerun must re-render and publish.
    manifest = render_master(storage, **KW)
    assert json.loads(storage.get_bytes(key))["page_count"] == manifest["page_count"]


def test_manifest_with_missing_page_is_not_reused(tmp_path: Path):
    pdf = _pdf(2)
    storage = _storage(tmp_path, pdf)
    manifest = render_master(storage, **KW)
    storage.delete(manifest["pages"][1]["key"])  # simulate lost/corrupt asset
    again = render_master(storage, **KW)
    assert storage.exists(again["pages"][1]["key"])


def test_changed_dpi_writes_separate_output_and_keeps_old_assets(tmp_path: Path):
    pdf = _pdf(1)
    storage = _storage(tmp_path, pdf)
    low = render_master(storage, **KW)
    high = render_master(storage, **{**KW, "dpi": 144})
    assert low["manifest_key"] != high["manifest_key"]
    assert storage.exists(low["pages"][0]["key"]), "old assets must not be overwritten"
    assert storage.exists(high["pages"][0]["key"])
    assert low["pages"][0]["sha256"] != high["pages"][0]["sha256"]


def test_changed_source_gets_new_fingerprint_and_keeps_old_assets(tmp_path: Path):
    storage = _storage(tmp_path, _pdf(1, color=(0, 0, 0)))
    old = render_master(storage, **KW)
    storage.put_bytes("originals/mat1/v1.pdf", _pdf(1, color=(255, 0, 0)))
    new = render_master(storage, **KW)
    assert old["manifest_key"] != new["manifest_key"]
    assert storage.exists(old["pages"][0]["key"])
    assert json.loads(storage.get_bytes(old["manifest_key"]))["source_sha256"] == old["source_sha256"]


def test_fingerprint_depends_on_source_and_settings():
    s = {"dpi": 150, "renderer": "pypdfium2", "renderer_version": "5.1.0"}
    assert fingerprint("a" * 64, s) == fingerprint("a" * 64, dict(s))
    assert fingerprint("a" * 64, s) != fingerprint("b" * 64, s)
    assert fingerprint("a" * 64, s) != fingerprint("a" * 64, {**s, "dpi": 300})


def test_concurrent_same_version_publishes_one_consistent_manifest(tmp_path: Path):
    pdf = _pdf(4)
    storage = _storage(tmp_path, pdf)
    results, errors = [], []

    def run():
        try:
            results.append(render_master(storage, **KW))
        except Exception as exc:  # noqa: BLE001 - record any failure for assertion
            errors.append(exc)

    threads = [threading.Thread(target=run) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors, errors
    assert len({r["manifest_key"] for r in results}) == 1
    assert len({json.dumps(r, sort_keys=True) for r in results}) == 1
    final = json.loads(storage.get_bytes(results[0]["manifest_key"]))
    assert final["page_count"] == 4
    assert all(storage.exists(p["key"]) for p in final["pages"])
    assert not any(p.name.endswith(".part") for p in (tmp_path / "st" / "masters").rglob("*"))


def test_expired_lease_is_reclaimed_and_stale_worker_cannot_complete(tmp_path: Path):
    from app.db import StateDB
    db = StateDB(tmp_path / "state.db")
    job_id, created = db.enqueue(kind="preprocess_master", idempotency_key="k1", payload="{}",
                                 max_attempts=3, now=1000)
    first = db.claim(lease_seconds=30, now=1000)
    assert first is not None and first["id"] == job_id
    # Worker dies; lease expires and another worker reclaims the job.
    second = db.claim(lease_seconds=30, now=1100)
    assert second is not None and second["attempts"] == 2
    assert second["lease_token"] != first["lease_token"]
    # The stale worker's late completion must be rejected by the lease fence.
    assert db.complete(job_id, first["lease_token"], "{}", now=1101) is False
    assert db.complete(job_id, second["lease_token"], "{}", now=1102) is True
    assert db.get(job_id)["state"] == "succeeded"


def test_job_exhausts_attempts_then_fails_and_is_not_reported_succeeded(tmp_path: Path):
    from app.db import StateDB
    db = StateDB(tmp_path / "state.db")
    job_id, _ = db.enqueue(kind="preprocess_master", idempotency_key="k2", payload="{}",
                           max_attempts=2, now=1000)
    t = 1000
    for _ in range(2):
        job = db.claim(lease_seconds=30, now=t)
        assert job is not None
        state = db.fail(job_id, job["lease_token"], "Simulated", retry_delay=0, now=t)
        t += 100
    assert state == "failed"
    assert db.get(job_id)["state"] == "failed"
    assert db.claim(lease_seconds=30, now=t) is None


def test_worker_crash_after_partial_render_then_reprocess_publishes_complete_manifest(tmp_path: Path):
    """Models a worker killed after writing some pages: no manifest exists, so a retry must
    re-render every page and publish only once all are complete."""
    pdf = _pdf(3)
    storage = _storage(tmp_path, pdf)
    crashing = FailingStorage(tmp_path / "st", fail_on="page-0002", after=0)
    with pytest.raises(OSError):
        render_master(crashing, **KW)
    assert not any((tmp_path / "st" / "masters").rglob("manifest.json"))
    manifest = render_master(storage, **KW)
    assert json.loads(storage.get_bytes(manifest["manifest_key"]))["page_count"] == 3
    assert all(storage.exists(p["key"]) for p in manifest["pages"])


def test_endpoint_key_changes_with_source_and_dpi_but_repeats_reuse(tmp_path: Path):
    from app.config import Settings
    from app.main import create_app
    from fastapi.testclient import TestClient
    from tests.test_phase_b import _signed

    root = tmp_path / "st"
    settings = Settings(hmac_keys="k1:" + "s" * 40, storage_root=root, state_db_path=tmp_path / "state.db",
                        master_render_dpi=72)
    app = create_app(settings, handlers={})  # no worker: keep jobs queued, inspect the keys
    storage = LocalPrivateStorage(root)
    storage.put_bytes("originals/mat1/v1.pdf", _pdf(1, color=(0, 0, 0)))
    with TestClient(app) as client:
        def post():
            body = json.dumps({"material_id": "mat1", "version_id": "v1",
                               "source_key": "originals/mat1/v1.pdf"}).encode()
            path = "/internal/masters/preprocess"
            return client.post(path, content=body, headers=_signed(client, "POST", path, body))

        first = post().json()
        assert first["created"] is True
        again = post().json()
        assert again == {"job_id": first["job_id"], "created": False}

        storage.put_bytes("originals/mat1/v1.pdf", _pdf(1, color=(255, 0, 0)))
        changed = post().json()
        assert changed["created"] is True and changed["job_id"] != first["job_id"]


def test_corrupt_source_never_publishes_manifest(tmp_path: Path):
    storage = _storage(tmp_path, b"%PDF-1.4 truncated garbage")
    with pytest.raises(PreprocessError):
        render_master(storage, **KW)
    assert not any((tmp_path / "st" / "masters").rglob("manifest.json"))
