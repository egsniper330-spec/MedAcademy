"""24h lifecycle: expired copies are rejected before deletion, deletion is idempotent and retried,
and originals, masters and mappings are never removed."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import cleanup, issuance  # noqa: E402
from app.db import StateDB  # noqa: E402
from app.storage import LocalPrivateStorage  # noqa: E402


def _ready_row(conn, storage, *, issuance_id: str, expires_at: int, watermark: int) -> str:
    key = f"issued/{issuance_id}-tok.pdf"
    storage.put_bytes(key, b"%PDF-1.4 copy")
    conn.execute(
        """INSERT INTO issuances (id, watermark_id, cache_key, student_ref, doctor_ref, material_id,
           version_id, course_ref, source_sha256, master_fingerprint, algorithm, config_version,
           status, storage_key, file_sha256, issued_at, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, 's', 'd', 'm', 'v', 'c', ?, 'fp', 'alg', 'cfg', 'ready', ?, 'x', 1, ?, 1, 1)""",
        (issuance_id, watermark, f"k-{issuance_id}", "a" * 64, key, expires_at),
    )
    return key


@pytest.fixture()
def env(tmp_path: Path):
    db = StateDB(tmp_path / "state.sqlite3")
    storage = LocalPrivateStorage(tmp_path / "st")
    storage.put_bytes("originals/m/v.pdf", b"original")
    storage.put_bytes("masters/m/v/fp/manifest.json", b"{}")
    return db, storage


def test_expired_copy_is_deleted_and_row_kept(env):
    db, storage = env
    key = _ready_row(db.conn, storage, issuance_id="e1", expires_at=1000, watermark=10)
    report = cleanup.run_once(db.conn, storage, now=1000)
    assert report.deleted == 1
    assert not storage.exists(key)
    row = db.conn.execute("SELECT status, storage_key FROM issuances WHERE id = 'e1'").fetchone()
    assert row["status"] == "expired" and row["storage_key"] is None  # mapping kept


def test_non_expired_copy_is_preserved(env):
    db, storage = env
    key = _ready_row(db.conn, storage, issuance_id="n1", expires_at=2000, watermark=11)
    report = cleanup.run_once(db.conn, storage, now=1999)
    assert report.deleted == 0 and report.expired == 0
    assert storage.exists(key)


def test_originals_and_masters_are_never_deleted(env):
    db, storage = env
    _ready_row(db.conn, storage, issuance_id="e2", expires_at=1000, watermark=12)
    cleanup.run_once(db.conn, storage, now=5000)
    assert storage.exists("originals/m/v.pdf")
    assert storage.exists("masters/m/v/fp/manifest.json")


def test_repeated_cleanup_is_idempotent(env):
    db, storage = env
    _ready_row(db.conn, storage, issuance_id="e3", expires_at=1000, watermark=13)
    first = cleanup.run_once(db.conn, storage, now=1000)
    second = cleanup.run_once(db.conn, storage, now=1001)
    assert first.deleted == 1
    assert second.deleted == 0 and second.failed == 0 and second.expired == 0


def test_expired_copy_is_rejected_before_physical_deletion(env):
    """Between marking expired and deleting the file, the row must not be served."""
    db, storage = env
    key = _ready_row(db.conn, storage, issuance_id="e4", expires_at=1000, watermark=14)
    cleanup.mark_expired(db.conn, now=1000)  # file still on disk at this point
    assert storage.exists(key)
    row = db.conn.execute("SELECT status FROM issuances WHERE id = 'e4'").fetchone()
    assert row["status"] == "expired"
    assert issuance._live(issuance._row(db.conn.execute(
        "SELECT * FROM issuances WHERE id = 'e4'").fetchone()), now=1000) is False


def test_interrupted_cleanup_resumes_after_restart(tmp_path: Path):
    """Crash after rows are marked expired but before files are deleted; a new process finishes."""
    db = StateDB(tmp_path / "state.sqlite3")
    storage = LocalPrivateStorage(tmp_path / "st")
    key = _ready_row(db.conn, storage, issuance_id="r1", expires_at=1000, watermark=20)
    cleanup.mark_expired(db.conn, now=1000)  # ...process dies here
    db.conn.close()

    restarted = StateDB(tmp_path / "state.sqlite3")
    report = cleanup.run_once(restarted.conn, storage, now=1200)
    assert report.deleted == 1 and not storage.exists(key)
    row = restarted.conn.execute("SELECT status, storage_key FROM issuances WHERE id = 'r1'").fetchone()
    assert row["status"] == "expired" and row["storage_key"] is None


def test_failed_deletion_is_retried_on_next_pass(env, monkeypatch):
    db, storage = env
    key = _ready_row(db.conn, storage, issuance_id="e5", expires_at=1000, watermark=15)
    real_delete = storage.delete
    calls = {"n": 0}

    def flaky(k):
        if k == key and calls["n"] == 0:
            calls["n"] += 1
            raise OSError("disk busy")
        return real_delete(k)

    monkeypatch.setattr(storage, "delete", flaky)
    first = cleanup.run_once(db.conn, storage, now=1000)
    assert first.failed == 1 and storage.exists(key)
    # Still 'expired', so never served, and storage_key is retained for the retry.
    assert db.conn.execute("SELECT storage_key FROM issuances WHERE id = 'e5'").fetchone()[0] == key
    second = cleanup.run_once(db.conn, storage, now=1100)
    assert second.deleted == 1 and not storage.exists(key)
