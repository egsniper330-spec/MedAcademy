"""Phase A tests: authentication, replay protection, queue leases, storage safety, HTTP surface."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import auth  # noqa: E402
from app.config import parse_hmac_keys  # noqa: E402
from app.db import StateDB  # noqa: E402
from app.nonce_store import NonceStore  # noqa: E402
from app.storage import LocalPrivateStorage, StorageKeyError, validate_key  # noqa: E402

SECRET = "s" * 40
KEYS = {"k1": SECRET.encode()}
NONCE = "abcdefghijklmnop1234"


def _sig(path: str, ts: int, body: bytes = b"{}", secret: str = SECRET, nonce: str = NONCE) -> str:
    return auth.sign(secret.encode(), "POST", path, str(ts), nonce, body)


def test_valid_signature_accepted():
    now = int(time.time())
    v = auth.verify(keys=KEYS, method="POST", path_with_query="/internal/x", key_id="k1",
                    timestamp=str(now), nonce=NONCE, signature=_sig("/internal/x", now),
                    body=b"{}", skew_seconds=300)
    assert v.key_id == "k1"


def test_wrong_body_rejected():
    now = int(time.time())
    with pytest.raises(auth.AuthError):
        auth.verify(keys=KEYS, method="POST", path_with_query="/internal/x", key_id="k1",
                    timestamp=str(now), nonce=NONCE, signature=_sig("/internal/x", now, b"{}"),
                    body=b'{"tampered":1}', skew_seconds=300)


def test_wrong_path_rejected():
    now = int(time.time())
    with pytest.raises(auth.AuthError):
        auth.verify(keys=KEYS, method="POST", path_with_query="/internal/other", key_id="k1",
                    timestamp=str(now), nonce=NONCE, signature=_sig("/internal/x", now),
                    body=b"{}", skew_seconds=300)


def test_stale_timestamp_rejected():
    old = int(time.time()) - 3600
    with pytest.raises(auth.AuthError, match="window"):
        auth.verify(keys=KEYS, method="POST", path_with_query="/internal/x", key_id="k1",
                    timestamp=str(old), nonce=NONCE, signature=_sig("/internal/x", old),
                    body=b"{}", skew_seconds=300)


def test_unknown_key_and_bad_nonce_rejected():
    now = int(time.time())
    with pytest.raises(auth.AuthError, match="unknown key"):
        auth.verify(keys=KEYS, method="POST", path_with_query="/x", key_id="nope",
                    timestamp=str(now), nonce=NONCE, signature="00", body=b"", skew_seconds=300)
    with pytest.raises(auth.AuthError, match="nonce"):
        auth.verify(keys=KEYS, method="POST", path_with_query="/x", key_id="k1",
                    timestamp=str(now), nonce="short", signature="00", body=b"", skew_seconds=300)


def test_secret_too_short_rejected():
    with pytest.raises(ValueError):
        parse_hmac_keys("k1:short")


def test_nonce_replay_blocked(tmp_path: Path):
    db = StateDB(tmp_path / "s.sqlite3")
    nonces = NonceStore(db.conn, db.lock)
    now = int(time.time())
    assert nonces.claim("k1", NONCE, now, 600, now) is True
    assert nonces.claim("k1", NONCE, now, 600, now) is False
    db.close()


def test_queue_idempotent_enqueue_and_single_claim(tmp_path: Path):
    db = StateDB(tmp_path / "s.sqlite3")
    a, created_a = db.enqueue(kind="k", idempotency_key="same", payload="{}", max_attempts=3)
    b, created_b = db.enqueue(kind="k", idempotency_key="same", payload="{}", max_attempts=3)
    assert a == b and created_a is True and created_b is False
    first = db.claim(lease_seconds=60)
    second = db.claim(lease_seconds=60)
    assert first is not None and second is None
    db.close()


def test_expired_lease_is_reclaimed(tmp_path: Path):
    db = StateDB(tmp_path / "s.sqlite3")
    job_id, _ = db.enqueue(kind="k", idempotency_key="j", payload="{}", max_attempts=3, now=1000)
    job = db.claim(lease_seconds=10, now=1000)
    assert job is not None and job["id"] == job_id
    assert db.claim(lease_seconds=10, now=1005) is None  # lease still held
    again = db.claim(lease_seconds=10, now=1011)  # lease expired
    assert again is not None and again["attempts"] == 2
    db.close()


def test_failure_retries_then_terminal(tmp_path: Path):
    db = StateDB(tmp_path / "s.sqlite3")
    db.enqueue(kind="k", idempotency_key="f", payload="{}", max_attempts=2, now=1000)
    job = db.claim(lease_seconds=60, now=1000)
    assert db.fail(job["id"], job["lease_token"], "boom", retry_delay=0, now=1000) == "queued"
    job = db.claim(lease_seconds=60, now=1001)
    assert db.fail(job["id"], job["lease_token"], "boom", retry_delay=0, now=1001) == "failed"
    db.close()


def test_storage_rejects_traversal_and_unknown_prefix(tmp_path: Path):
    for bad in ["../etc/passwd", "issued/../../x", "/abs/x", "issued\\x", "unknown/x", "issued/.", "issued/a\x00b"]:
        with pytest.raises(StorageKeyError):
            validate_key(bad)


def test_storage_atomic_roundtrip_and_idempotent_delete(tmp_path: Path):
    st = LocalPrivateStorage(tmp_path / "root")
    st.put_bytes("issued/a/b.pdf", b"%PDF-1.7")
    assert st.get_bytes("issued/a/b.pdf") == b"%PDF-1.7"
    assert st.delete("issued/a/b.pdf") is True
    assert st.delete("issued/a/b.pdf") is False  # idempotent


def test_storage_inside_web_root_is_refused(tmp_path: Path):
    from app.config import Settings

    web = tmp_path / "public"
    web.mkdir()
    inside = Settings(hmac_keys=f"k1:{SECRET}", storage_root=web / "storage",
                      state_db_path=tmp_path / "state.sqlite3", web_roots=str(web))
    with pytest.raises(ValueError, match="web-served"):
        inside.check_private_paths()

    state_inside = Settings(hmac_keys=f"k1:{SECRET}", storage_root=tmp_path / "storage",
                            state_db_path=web / "state.sqlite3", web_roots=str(web))
    with pytest.raises(ValueError, match="state_db_path"):
        state_inside.check_private_paths()

    outside = Settings(hmac_keys=f"k1:{SECRET}", storage_root=tmp_path / "private" / "storage",
                       state_db_path=tmp_path / "private" / "state.sqlite3", web_roots=str(web))
    outside.check_private_paths()  # does not raise


def test_entrypoint_refuses_weak_config(monkeypatch, tmp_path: Path):
    from app import server

    monkeypatch.setenv("PDF_SVC_HMAC_KEYS", "k1:short")
    monkeypatch.setenv("PDF_SVC_STORAGE_ROOT", str(tmp_path / "st"))
    monkeypatch.setenv("PDF_SVC_STATE_DB_PATH", str(tmp_path / "st.sqlite3"))
    with pytest.raises(SystemExit) as exc:
        server.build_app()
    assert exc.value.code == 2


def test_entrypoint_refuses_storage_in_web_root(monkeypatch, tmp_path: Path):
    from app import server

    web = tmp_path / "public"
    monkeypatch.setenv("PDF_SVC_HMAC_KEYS", f"k1:{SECRET}")
    monkeypatch.setenv("PDF_SVC_WEB_ROOTS", str(web))
    monkeypatch.setenv("PDF_SVC_STORAGE_ROOT", str(web / "storage"))
    monkeypatch.setenv("PDF_SVC_STATE_DB_PATH", str(tmp_path / "st.sqlite3"))
    with pytest.raises(SystemExit):
        server.build_app()


def test_entrypoint_builds_app_with_valid_config(monkeypatch, tmp_path: Path):
    from app import server

    monkeypatch.setenv("PDF_SVC_HMAC_KEYS", f"k1:{SECRET}")
    monkeypatch.setenv("PDF_SVC_STORAGE_ROOT", str(tmp_path / "st"))
    monkeypatch.setenv("PDF_SVC_STATE_DB_PATH", str(tmp_path / "st.sqlite3"))
    assert server.build_app() is not None


def test_http_requires_signature(tmp_path: Path, monkeypatch):
    from fastapi.testclient import TestClient

    from app.config import Settings
    from app.main import create_app

    settings = Settings(hmac_keys=f"k1:{SECRET}", storage_root=tmp_path / "st",
                        state_db_path=tmp_path / "st.sqlite3", worker_count=1)
    app = create_app(settings, handlers={})
    with TestClient(app) as client:
        assert client.get("/healthz").json() == {"status": "ok"}
        assert client.get("/internal/queue/stats").status_code == 401
        ts = int(time.time())
        headers = {"X-Key-Id": "k1", "X-Timestamp": str(ts), "X-Nonce": NONCE,
                   "X-Signature": auth.sign(SECRET.encode(), "GET", "/internal/queue/stats", str(ts), NONCE, b"")}
        ok = client.get("/internal/queue/stats", headers=headers)
        assert ok.status_code == 200
        assert client.get("/internal/queue/stats", headers=headers).status_code == 401  # replay
