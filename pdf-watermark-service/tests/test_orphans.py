"""Orphan temp/issued file cleanup: active leases and newer published files are never removed."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import cleanup  # noqa: E402
from app.db import StateDB  # noqa: E402
from app.storage import LocalPrivateStorage  # noqa: E402

NOW = 10_000_000
OLD = NOW - cleanup.ORPHAN_MIN_AGE_SECONDS - 10


@pytest.fixture()
def env(tmp_path: Path):
    db = StateDB(tmp_path / "state.sqlite3")
    storage = LocalPrivateStorage(tmp_path / "st")
    return db, storage


def _set_mtime(storage: LocalPrivateStorage, key: str, when: int) -> None:
    import os

    path = storage.root.joinpath(*key.split("/"))
    os.utime(path, (when, when))


def _generating(conn, *, issuance_id: str, token: str, lease_expires_at: int) -> None:
    conn.execute(
        """INSERT INTO issuances (id, watermark_id, cache_key, student_ref, doctor_ref, material_id,
           version_id, course_ref, source_sha256, master_fingerprint, algorithm, config_version,
           status, lease_token, lease_expires_at, created_at, updated_at)
           VALUES (?, ?, ?, 's', 'd', 'm', 'v', 'c', ?, 'fp', 'alg', 'cfg', 'generating', ?, ?, 1, 1)""",
        (issuance_id, 100_000 + len(issuance_id) * 7 + sum(map(ord, issuance_id)), f"k-{issuance_id}", "a" * 64, token, lease_expires_at),
    )


def test_active_generation_temp_file_is_preserved(env):
    db, storage = env
    key = f"tmp/issuance/a1-{'t' * 32}.pdf"
    storage.put_bytes(key, b"partial")
    _set_mtime(storage, key, OLD)
    _generating(db.conn, issuance_id="a1", token="t" * 32, lease_expires_at=NOW + 600)
    report = cleanup.run_once(db.conn, storage, now=NOW)
    assert storage.exists(key)
    assert report.orphans_removed == 0


def test_stale_temp_file_of_expired_lease_is_deleted(env):
    db, storage = env
    key = f"tmp/issuance/s1-{'u' * 32}.pdf"
    storage.put_bytes(key, b"partial")
    _set_mtime(storage, key, OLD)
    _generating(db.conn, issuance_id="s1", token="u" * 32, lease_expires_at=NOW - 1)
    report = cleanup.run_once(db.conn, storage, now=NOW)
    assert not storage.exists(key)
    assert report.orphans_removed == 1


def test_temp_file_younger_than_threshold_is_kept(env):
    db, storage = env
    key = f"tmp/issuance/y1-{'v' * 32}.pdf"
    storage.put_bytes(key, b"partial")
    _set_mtime(storage, key, NOW - 5)
    cleanup.run_once(db.conn, storage, now=NOW)
    assert storage.exists(key)


def test_orphan_is_deleted_only_after_restart_pass(env):
    db, storage = env
    key = f"tmp/issuance/r1-{'w' * 32}.pdf"
    storage.put_bytes(key, b"partial")
    _set_mtime(storage, key, OLD)
    # Simulated crash: the pass never ran. A later pass (new process) recovers the same state.
    cleanup.run_once(db.conn, storage, now=NOW)
    assert not storage.exists(key)
    again = cleanup.run_once(db.conn, storage, now=NOW)
    assert again.orphans_removed == 0  # idempotent


def test_referenced_issued_file_is_never_an_orphan(env):
    db, storage = env
    key = f"issued/ref1-{'x' * 32}.pdf"
    storage.put_bytes(key, b"%PDF copy")
    _set_mtime(storage, key, OLD)
    db.conn.execute(
        """INSERT INTO issuances (id, watermark_id, cache_key, student_ref, doctor_ref, material_id,
           version_id, course_ref, source_sha256, master_fingerprint, algorithm, config_version,
           status, storage_key, file_sha256, issued_at, expires_at, created_at, updated_at)
           VALUES ('ref1', 1, 'k-ref1', 's', 'd', 'm', 'v', 'c', ?, 'fp', 'alg', 'cfg', 'ready', ?, 'x', 1, ?, 1, 1)""",
        ("a" * 64, key, NOW + 86_400),
    )
    cleanup.run_once(db.conn, storage, now=NOW)
    assert storage.exists(key)


def test_unreferenced_old_issued_file_is_removed(env):
    db, storage = env
    key = f"issued/gone-{'y' * 32}.pdf"
    storage.put_bytes(key, b"%PDF leftover")
    _set_mtime(storage, key, OLD)
    report = cleanup.run_once(db.conn, storage, now=NOW)
    assert not storage.exists(key)
    assert report.orphans_removed == 1


def test_delete_failure_is_counted_and_retried(env, monkeypatch):
    db, storage = env
    key = f"tmp/issuance/f1-{'z' * 32}.pdf"
    storage.put_bytes(key, b"partial")
    _set_mtime(storage, key, OLD)

    real_delete = storage.delete

    def failing_delete(k):
        if k == key:
            raise PermissionError("locked")
        return real_delete(k)

    monkeypatch.setattr(storage, "delete", failing_delete)
    first = cleanup.run_once(db.conn, storage, now=NOW)
    assert first.orphans_failed == 1 and storage.exists(key)

    monkeypatch.setattr(storage, "delete", real_delete)
    second = cleanup.run_once(db.conn, storage, now=NOW)
    assert second.orphans_removed == 1 and not storage.exists(key)
