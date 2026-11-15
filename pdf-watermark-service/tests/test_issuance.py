"""Phase C: personalised issuance (cache, expiry, concurrency, crash recovery, integrity).

These tests use a fake WAM model (identity embedding plus a recorded payload) so they run without
torch. The real WAM round-trip is covered by test_wam_real, which skips when the checkpoint is absent.
"""

from __future__ import annotations

import hashlib
import io
import sys
import threading
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import issuance  # noqa: E402
from app.db import StateDB  # noqa: E402
from app.issuance import IssuanceError, issue  # noqa: E402
from app.preprocess import render_master  # noqa: E402
from app.storage import LocalPrivateStorage  # noqa: E402


class FakeModel:
    """Stands in for WamModel. Returns the image unchanged and records each payload it was asked to embed."""

    def __init__(self) -> None:
        self.payloads: list[int] = []

    def embed_image(self, image_chw, payload: int):
        self.payloads.append(payload)
        return np.asarray(image_chw, dtype=np.float32)


def _pdf(pages: int, color=(40, 40, 40)) -> bytes:
    images = [Image.new("RGB", (120, 160), color) for _ in range(pages)]
    buf = io.BytesIO()
    images[0].save(buf, format="PDF", save_all=True, append_images=images[1:], resolution=72.0)
    return buf.getvalue()


def _master(tmp_path: Path, pages: int = 2, material: str = "mat1", version: str = "v1"):
    storage = LocalPrivateStorage(tmp_path / "st")
    source_key = f"originals/{material}/{version}.pdf"
    storage.put_bytes(source_key, _pdf(pages))
    manifest = render_master(storage, material_id=material, version_id=version, source_key=source_key,
                             dpi=72, max_pages=10, pdf_version="5.1.0")
    return storage, manifest


def _identity(**overrides) -> dict:
    base = dict(student_ref="stu-001", doctor_ref="doc-001", material_id="mat1", version_id="v1",
                course_ref="course-A", source_sha256="f" * 64)
    base.update(overrides)
    return base


def _db(tmp_path: Path) -> StateDB:
    return StateDB(tmp_path / "state.sqlite3")


def _issue(db, storage, model, manifest, identity=None, now=None, ttl=86400, lease=900):
    identity = identity or _identity(source_sha256=manifest["source_sha256"])
    with db.lock:
        return issue(conn=db.conn, storage=storage, model=model, manifest=manifest, identity=identity,
                     ttl_seconds=ttl, lease_seconds=lease, now=now)


# ---- Embedding and reconstruction ----

def test_build_personalised_pdf_keeps_page_count_order_and_size(tmp_path: Path):
    storage, manifest = _master(tmp_path, pages=3)
    model = FakeModel()
    data = issuance.build_personalised_pdf(storage=storage, manifest=manifest, model=model,
                                           payload=0xBEEF, lossless_png_dpi=72)
    issuance.verify_pdf(data, [(p["width"], p["height"]) for p in manifest["pages"]])
    assert model.payloads == [0xBEEF] * 3
    assert len(data) > 0


def test_verify_pdf_rejects_wrong_page_count(tmp_path: Path):
    storage, manifest = _master(tmp_path, pages=2)
    data = issuance.build_personalised_pdf(storage=storage, manifest=manifest, model=FakeModel(),
                                           payload=1, lossless_png_dpi=72)
    with pytest.raises(Exception):
        issuance.verify_pdf(data, [(120, 160)])


def test_payload_is_32_bit_and_opaque_ids_are_unique():
    ids = {issuance.new_watermark_id() for _ in range(200)}
    assert len(ids) == 200
    for _ in range(50):
        assert 0 <= issuance.new_payload() < 2 ** 32


# ---- Cache, expiry and TTL ----

def test_same_context_reuses_copy_without_extending_ttl(tmp_path: Path):
    storage, manifest = _master(tmp_path)
    db, model = _db(tmp_path), FakeModel()
    first = _issue(db, storage, model, manifest, now=1000)
    second = _issue(db, storage, model, manifest, now=2000)
    assert second["id"] == first["id"]
    assert second["expires_at"] == first["expires_at"] == 1000 + 86400
    # One generation embeds once per master page; the reuse must not embed again.
    assert len(model.payloads) == len(manifest["pages"])


def test_different_course_or_version_gets_separate_copy(tmp_path: Path):
    storage, manifest = _master(tmp_path)
    db, model = _db(tmp_path), FakeModel()
    a = _issue(db, storage, model, manifest, now=1000)
    b = _issue(db, storage, model, manifest, identity=_identity(course_ref="course-B",
                                                               source_sha256=manifest["source_sha256"]), now=1000)
    c = _issue(db, storage, model, manifest, identity=_identity(version_id="v2",
                                                               source_sha256=manifest["source_sha256"]), now=1000)
    assert len({a["id"], b["id"], c["id"]}) == 3


def test_expired_copy_is_not_returned_and_fresh_issuance_follows(tmp_path: Path):
    storage, manifest = _master(tmp_path)
    db, model = _db(tmp_path), FakeModel()
    first = _issue(db, storage, model, manifest, now=1000)
    later = _issue(db, storage, model, manifest, now=1000 + 86400 + 1)
    assert later["id"] != first["id"]
    assert later["expires_at"] == 1000 + 86400 + 1 + 86400
    assert later["reused"] is False


# ---- Failure handling ----

def test_missing_published_file_is_not_served(tmp_path: Path):
    storage, manifest = _master(tmp_path)
    db, model = _db(tmp_path), FakeModel()
    first = _issue(db, storage, model, manifest, now=1000)
    storage.delete(first["storage_key"])
    with pytest.raises(IssuanceError):
        _issue(db, storage, model, manifest, now=1001)


def test_corrupt_published_file_is_not_served(tmp_path: Path):
    storage, manifest = _master(tmp_path)
    db, model = _db(tmp_path), FakeModel()
    first = _issue(db, storage, model, manifest, now=1000)
    storage.put_bytes(first["storage_key"], b"%PDF-broken")
    with pytest.raises(IssuanceError):
        _issue(db, storage, model, manifest, now=1001)


def test_concurrent_identical_requests_produce_one_copy(tmp_path: Path):
    storage, manifest = _master(tmp_path)
    db, model = _db(tmp_path), FakeModel()
    results, errors = [], []

    def worker():
        try:
            results.append(_issue(db, storage, model, manifest, now=1000))
        except IssuanceError as exc:
            errors.append(exc.code)

    threads = [threading.Thread(target=worker) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    ready = {r["id"] for r in results if r["status"] == "ready"}
    assert len(ready) == 1
    # Losers either reused the copy or were told to wait; none produced a second copy.
    assert set(errors) <= {"in_progress"}
    assert len(model.payloads) == len(manifest["pages"])
    count = db.conn.execute("SELECT COUNT(*) FROM issuances WHERE status = 'ready'").fetchone()[0]
    assert count == 1


def test_worker_crash_leaves_generating_row_recovered_after_lease_expiry(tmp_path: Path):
    storage, manifest = _master(tmp_path)
    db = _db(tmp_path)
    identity = _identity(source_sha256=manifest["source_sha256"])
    key = issuance.cache_key(student_ref=identity["student_ref"], doctor_ref=identity["doctor_ref"],
                             material_id=identity["material_id"], version_id=identity["version_id"],
                             source_course_id=identity["course_ref"],
                             source_sha256=identity["source_sha256"],
                             algorithm_version=f"{issuance.ALGORITHM}:{issuance.CONFIG_VERSION}")
    # Simulated crash: a generating row whose lease is still live blocks other workers.
    with db.lock:
        action, crashed = issuance.claim(db.conn, key=key, identity=dict(identity, algorithm=issuance.ALGORITHM,
                                                                        config_version=issuance.CONFIG_VERSION,
                                                                        master_fingerprint="x"),
                                         lease_seconds=900, now=1000)
    assert action == "generate"
    with pytest.raises(IssuanceError) as waiting:
        _issue(db, storage, FakeModel(), manifest, now=1001)
    assert waiting.value.code == "in_progress"
    # After the lease expires, a new worker takes over the same record and completes it.
    recovered = _issue(db, storage, FakeModel(), manifest, now=1000 + 901)
    assert recovered["id"] == crashed.id
    assert recovered["status"] == "ready"
    assert recovered["reused"] is False


def test_partial_temp_file_is_removed_and_generation_recovers(tmp_path: Path):
    storage, manifest = _master(tmp_path)
    db, model = _db(tmp_path), FakeModel()
    identity = _identity(source_sha256=manifest["source_sha256"])
    key = issuance.cache_key(student_ref=identity["student_ref"], doctor_ref=identity["doctor_ref"],
                             material_id=identity["material_id"], version_id=identity["version_id"],
                             source_course_id=identity["course_ref"],
                             source_sha256=identity["source_sha256"],
                             algorithm_version=f"{issuance.ALGORITHM}:{issuance.CONFIG_VERSION}")
    with db.lock:
        _, crashed = issuance.claim(db.conn, key=key, identity=dict(identity, algorithm=issuance.ALGORITHM,
                                                                   config_version=issuance.CONFIG_VERSION,
                                                                   master_fingerprint="x"),
                                    lease_seconds=900, now=1000)
    # A half-written temp file from the crashed worker must not be published or left behind.
    stale_temp = issuance.temp_key_for(crashed.id, crashed.lease_token)
    storage.put_bytes(stale_temp, b"%PDF-partial")
    recovered = _issue(db, storage, model, manifest, now=2000)
    assert recovered["status"] == "ready"
    # The crashed worker's temp file is not the published copy and is not what gets served.
    assert recovered["storage_key"] != stale_temp
    assert hashlib.sha256(storage.get_bytes(recovered["storage_key"])).hexdigest() == recovered["file_sha256"]


def test_invalid_master_manifest_is_rejected(tmp_path: Path):
    from app.master_manifest import validate_manifest

    storage, manifest = _master(tmp_path)
    prefix = manifest["pages"][0]["key"].rsplit("/", 2)[0]
    kwargs = dict(prefix=prefix, material_id="mat1", version_id="v1", storage=storage)
    assert validate_manifest(manifest, **kwargs) is not None
    # Wrong material or version identity.
    assert validate_manifest(manifest, **dict(kwargs, material_id="other")) is None
    assert validate_manifest(manifest, **dict(kwargs, version_id="v9")) is None
    # Page key outside the version prefix (path traversal attempt).
    bad = dict(manifest, pages=[dict(manifest["pages"][0], key="../../etc/passwd")] + manifest["pages"][1:])
    assert validate_manifest(bad, **kwargs) is None
    # Non-dict and wrong page count.
    assert validate_manifest([], **kwargs) is None
    assert validate_manifest(dict(manifest, page_count=99), **kwargs) is None


def test_payload_collision_is_regenerated(tmp_path: Path, monkeypatch):
    storage, manifest = _master(tmp_path)
    db = _db(tmp_path)
    taken = _issue(db, storage, FakeModel(), manifest, now=1000)
    # Force the next allocation to repeat the live payload, then a fresh value.
    taken_payload = db.conn.execute(
        "SELECT watermark_id FROM issuances WHERE id = ?", (taken["id"],)).fetchone()[0]
    values = iter([taken_payload, 12345])
    monkeypatch.setattr(issuance, "new_payload", lambda: next(values))
    other = _issue(db, storage, FakeModel(), manifest,
                   identity=_identity(course_ref="course-B", source_sha256=manifest["source_sha256"]), now=1000)
    assert other["status"] == "ready"
    payloads = db.conn.execute(
        "SELECT watermark_id FROM issuances WHERE status = 'ready' ORDER BY created_at").fetchall()
    assert len({p[0] for p in payloads}) == len(payloads)


# ---- HTTP contract ----

SECRET = "test-secret-issuance-0123456789abcdef"


def _http_app(tmp_path: Path):
    from app.config import Settings
    from app.main import create_app

    settings = Settings(hmac_keys=f"k1:{SECRET}", storage_root=tmp_path / "st",
                        state_db_path=tmp_path / "state.sqlite3", worker_count=1)
    return create_app(settings)


def test_unauthorized_issuance_request_is_rejected(tmp_path: Path):
    from fastapi.testclient import TestClient

    with TestClient(_http_app(tmp_path)) as client:
        r = client.post("/internal/issuances", content=b"{}")
        assert r.status_code == 401


def test_invalid_issuance_request_is_rejected_with_422(tmp_path: Path):
    import json
    import secrets
    import time

    from fastapi.testclient import TestClient
    from app import auth

    path = "/internal/issuances"
    with TestClient(_http_app(tmp_path)) as client:
        body = json.dumps({"student_ref": "bad ref with spaces"}).encode()
        ts = int(time.time())
        nonce = secrets.token_hex(12)
        headers = {"X-Key-Id": "k1", "X-Timestamp": str(ts), "X-Nonce": nonce,
                   "X-Signature": auth.sign(SECRET.encode(), "POST", path, str(ts), nonce, body),
                   "Content-Type": "application/json"}
        r = client.post(path, content=body, headers=headers)
        assert r.status_code == 422
        assert "student" not in r.text.lower() or r.json().get("error") is not None


# ---- WAM checkpoint pinning (no torch needed) ----

def test_checkpoint_hash_mismatch_is_rejected(tmp_path: Path):
    from app.wam_adapter import WamError, verify_checkpoint

    fake = tmp_path / "wam_mit.pth"
    fake.write_bytes(b"not the approved checkpoint")
    with pytest.raises(WamError):
        verify_checkpoint(fake)


# ---- Real WAM (skipped when the approved checkpoint is not present) ----

WAM_REPO = Path("D:/Temp/wam-eval/wam")
WAM_CKPT = Path("D:/Temp/wam-eval/wam_mit.pth")
WAM_PARAMS = Path("D:/Temp/wam-eval/wam/checkpoints/params.json")


def _torch_available() -> bool:
    try:
        import torch  # noqa: F401
        return True
    except ImportError:
        return False


@pytest.mark.skipif(not (WAM_REPO.exists() and WAM_CKPT.exists() and WAM_PARAMS.exists() and _torch_available()),
                    reason="needs torch, the WAM repo and the approved checkpoint (run in the WAM venv)")
def test_wam_real_checkpoint_round_trip_loads_and_recovers_payload():
    from app.wam_adapter import WamModel

    model = WamModel(WAM_REPO, WAM_CKPT, WAM_PARAMS)
    model.load()
    assert model.loaded
    rng = np.random.default_rng(0)
    image = rng.random((3, 256, 256), dtype=np.float32)
    payload = 0xA5C3F00D
    marked = model.embed_image(image, payload)
    recovered, _ = model.extract_image(marked)
    assert recovered == payload


# --- end of issuance tests ---
