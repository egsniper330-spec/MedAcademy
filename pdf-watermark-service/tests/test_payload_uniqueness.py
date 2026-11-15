"""Global payload uniqueness: a 32-bit payload is never reused while any issuance row for it is retained."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import issuance  # noqa: E402
from app.db import StateDB  # noqa: E402
from app.issuance import IssuanceError  # noqa: E402


def _insert_row(conn, *, issuance_id: str, payload: int, status: str) -> None:
    conn.execute(
        """INSERT INTO issuances (id, watermark_id, cache_key, student_ref, doctor_ref,
           material_id, version_id, course_ref, source_sha256, master_fingerprint, algorithm,
           config_version, status, created_at, updated_at)
           VALUES (?, ?, ?, 's', 'd', 'm', 'v', 'c', ?, 'fp', 'alg', 'cfg', ?, 1, 1)""",
        (issuance_id, payload, f"key-{issuance_id}", "a" * 64, status),
    )


@pytest.mark.parametrize("status", ["expired", "failed", "ready", "generating"])
def test_payload_of_any_retained_status_is_not_allocated_again(tmp_path: Path, status: str, monkeypatch):
    db = StateDB(tmp_path / "state.sqlite3")
    _insert_row(db.conn, issuance_id="old1", payload=0x1234ABCD, status=status)
    # Force the allocator to propose the retained payload first, then a free one.
    candidates = iter([0x1234ABCD, 0x0000BEEF])
    monkeypatch.setattr(issuance, "new_payload", lambda: next(candidates))
    db.conn.execute("BEGIN IMMEDIATE")
    try:
        assert issuance._allocate_payload(db.conn) == 0x0000BEEF
    finally:
        db.conn.execute("ROLLBACK")


def test_database_rejects_a_duplicate_payload_even_for_expired_rows(tmp_path: Path):
    db = StateDB(tmp_path / "state.sqlite3")
    _insert_row(db.conn, issuance_id="old1", payload=77, status="expired")
    with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
        _insert_row(db.conn, issuance_id="new1", payload=77, status="ready")


def test_exhausted_namespace_fails_safely_without_reusing(tmp_path: Path, monkeypatch):
    db = StateDB(tmp_path / "state.sqlite3")
    _insert_row(db.conn, issuance_id="old1", payload=5, status="expired")
    monkeypatch.setattr(issuance, "new_payload", lambda: 5)
    db.conn.execute("BEGIN IMMEDIATE")
    try:
        with pytest.raises(IssuanceError) as err:
            issuance._allocate_payload(db.conn)
        assert err.value.code == "payload_exhausted"
    finally:
        db.conn.execute("ROLLBACK")
    # The retained mapping is untouched.
    assert db.conn.execute("SELECT COUNT(*) FROM issuances WHERE watermark_id = 5").fetchone()[0] == 1
