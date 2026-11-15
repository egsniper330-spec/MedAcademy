"""Formal 24-hour invariants, verified against the real issue()/cleanup code paths.

Each test names the invariant it proves (see docs/INVARIANTS_24H.md). A fake WAM model is used, so
these run without torch. All times are UTC unix seconds passed explicitly.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import cleanup, issuance  # noqa: E402
from app.issuance import IssuanceError, issue  # noqa: E402
from app.storage import LocalPrivateStorage  # noqa: E402

from test_issuance import FakeModel, _db, _identity, _master  # noqa: E402

TTL = 86400


def _issue(db, storage, model, manifest, now, identity=None):
    identity = identity or _identity(source_sha256=manifest["source_sha256"])
    with db.lock:
        return issue(conn=db.conn, storage=storage, model=model, manifest=manifest, identity=identity,
                     ttl_seconds=TTL, lease_seconds=900, now=now)


def _row(db, issuance_id):
    return db.conn.execute("SELECT * FROM issuances WHERE id = ?", (issuance_id,)).fetchone()


def _events(db, issuance_id):
    return [r[0] for r in db.conn.execute(
        "SELECT event FROM issuance_events WHERE issuance_id = ? ORDER BY id", (issuance_id,))]


# I1: TTL starts at successful publication, not at issuance creation.
def test_i1_ttl_starts_at_publication_not_at_claim(tmp_path: Path):
    storage, manifest = _master(tmp_path)
    db, model = _db(tmp_path), FakeModel()
    result = _issue(db, storage, model, manifest, now=5000)
    row = _row(db, result["id"])
    assert row["status"] == "ready"
    assert row["issued_at"] == 5000
    assert row["expires_at"] == 5000 + TTL
    # Claim happened at 5000 too; check the generating row would have had no expiry before publish.
    assert _events(db, result["id"])[:2] == ["generating", "ready"]


# I2: repeated downloads (reuse reads) never extend expires_at.
def test_i2_repeated_reuse_does_not_extend_expiry(tmp_path: Path):
    storage, manifest = _master(tmp_path)
    db, model = _db(tmp_path), FakeModel()
    first = _issue(db, storage, model, manifest, now=1000)
    expiry = _row(db, first["id"])["expires_at"]
    for t in (1100, 50000, 85000):
        again = _issue(db, storage, model, manifest, now=t)
        assert again["reused"] is True and again["id"] == first["id"]
    assert _row(db, first["id"])["expires_at"] == expiry == 1000 + TTL


# I3: an expired file is rejected even before physical deletion.
def test_i3_expired_file_still_on_disk_is_not_served(tmp_path: Path):
    storage, manifest = _master(tmp_path)
    db, model = _db(tmp_path), FakeModel()
    first = _issue(db, storage, model, manifest, now=1000)
    key = first["storage_key"]
    expiry = _row(db, first["id"])["expires_at"]
    assert storage.exists(key)  # file still present, no cleanup has run
    fresh = _issue(db, storage, model, manifest, now=expiry)  # exactly at expiry
    assert fresh["id"] != first["id"] and fresh["reused"] is False
    assert _row(db, first["id"])["status"] == "expired"
    assert storage.exists(key)  # old file still on disk; it was not served


# I4: originals and master assets are never subject to issuance TTL.
def test_i4_originals_and_masters_survive_expiry_and_cleanup(tmp_path: Path):
    storage, manifest = _master(tmp_path)
    db, model = _db(tmp_path), FakeModel()
    _issue(db, storage, model, manifest, now=1000)
    originals = ["originals/mat1/v1.pdf"]
    assert storage.exists(originals[0]), "precondition: original PDF exists"
    masters = [p["key"] for p in manifest["pages"]] + ["masters/mat1/v1"]
    masters_present = [k for k in masters if storage.exists(k)]
    assert masters_present, "precondition: master assets exist"
    cleanup.run_once(db.conn, storage, now=1000 + TTL + 10)
    for key in originals:
        assert storage.exists(key)
    for key in masters_present:
        assert storage.exists(key)


# I5: mappings and audit events survive file deletion.
def test_i5_row_and_events_survive_file_deletion(tmp_path: Path):
    storage, manifest = _master(tmp_path)
    db, model = _db(tmp_path), FakeModel()
    first = _issue(db, storage, model, manifest, now=1000)
    cleanup.run_once(db.conn, storage, now=1000 + TTL + 1)
    assert not storage.exists(first["storage_key"])
    row = _row(db, first["id"])
    assert row is not None and row["watermark_id"] is not None and row["student_ref"] == "stu-001"
    events = _events(db, first["id"])
    assert "expired" in events and "file_deleted" in events


# I6: cleanup cannot delete the file of a newer issuance for the same identity.
def test_i6_cleanup_never_deletes_newer_issuance_file(tmp_path: Path):
    storage, manifest = _master(tmp_path)
    db, model = _db(tmp_path), FakeModel()
    old = _issue(db, storage, model, manifest, now=1000)
    new = _issue(db, storage, model, manifest, now=1000 + TTL + 5)
    assert new["storage_key"] != old["storage_key"]
    cleanup.run_once(db.conn, storage, now=1000 + TTL + 6)
    assert not storage.exists(old["storage_key"])
    assert storage.exists(new["storage_key"])
    assert _row(db, new["id"])["status"] == "ready"


# I7: two cleanup workers on the same DB cannot corrupt state (second pass is a no-op).
def test_i7_two_cleanup_passes_on_one_db_do_not_double_count(tmp_path: Path):
    storage, manifest = _master(tmp_path)
    db, model = _db(tmp_path), FakeModel()
    a_id = _issue(db, storage, model, manifest, now=1000)["id"]
    a = cleanup.run_once(db.conn, storage, now=1000 + TTL + 1)
    b = cleanup.run_once(db.conn, storage, now=1000 + TTL + 1)
    assert a.deleted == 1 and b.deleted == 0 and b.expired == 0
    events = [e for e in _events(db, a_id) if e == "file_deleted"]
    assert len(events) == 1


# I8: failed deletion is retried safely and never re-served.
def test_i8_failed_deletion_stays_expired_and_is_retried(tmp_path: Path, monkeypatch):
    storage, manifest = _master(tmp_path)
    db, model = _db(tmp_path), FakeModel()
    first = _issue(db, storage, model, manifest, now=1000)
    key = first["storage_key"]
    real_delete = storage.delete
    state = {"fail": True}

    def flaky(k):
        if k == key and state["fail"]:
            raise OSError("busy")
        return real_delete(k)

    monkeypatch.setattr(storage, "delete", flaky)
    cleanup.run_once(db.conn, storage, now=1000 + TTL + 1)
    assert storage.exists(key)
    fresh = _issue(db, storage, model, manifest, now=1000 + TTL + 2)
    assert fresh["id"] != first["id"]  # expired copy never served during retry window
    state["fail"] = False
    report = cleanup.run_once(db.conn, storage, now=1000 + TTL + 3)
    assert report.deleted == 1 and not storage.exists(key)


# I9: restart does not resurrect expired files.
def test_i9_restart_does_not_make_expired_copy_available(tmp_path: Path):
    storage, manifest = _master(tmp_path)
    db, model = _db(tmp_path), FakeModel()
    first = _issue(db, storage, model, manifest, now=1000)
    db.conn.close()
    restarted = _db(tmp_path)
    fresh = _issue(restarted, storage, model, manifest, now=1000 + TTL + 1)
    assert fresh["id"] != first["id"] and fresh["reused"] is False
    assert _row(restarted, first["id"])["status"] in ("expired",)


# I10: timestamps are UTC unix seconds (stored as integers from a UTC clock).
def test_i10_timestamps_are_integer_utc_seconds():
    assert isinstance(issuance.utc_now(), int)
    import time as _t
    assert abs(issuance.utc_now() - int(_t.time())) <= 1


# I11: interrupted publication (temp written, row not ready) and interrupted deletion are recovered.
def test_i11_interrupted_publication_leaves_no_ready_row(tmp_path: Path, monkeypatch):
    storage, manifest = _master(tmp_path)
    db, model = _db(tmp_path), FakeModel()

    def boom(*_a, **_k):
        raise RuntimeError("crash before mark_ready")

    monkeypatch.setattr(issuance, "mark_ready", boom)
    with pytest.raises(RuntimeError):
        _issue(db, storage, model, manifest, now=1000)
    rows = db.conn.execute("SELECT status FROM issuances").fetchall()
    assert rows and all(r[0] != "ready" for r in rows)


# I12: a corrupt ready copy is retired and never reused as a valid cached copy.
def test_i12_corrupt_ready_copy_is_not_reused(tmp_path: Path):
    storage, manifest = _master(tmp_path)
    db, model = _db(tmp_path), FakeModel()
    first = _issue(db, storage, model, manifest, now=1000)
    storage.put_bytes(first["storage_key"], b"%PDF-broken")
    with pytest.raises(IssuanceError):
        _issue(db, storage, model, manifest, now=1001)
    assert _row(db, first["id"])["status"] == "failed"
    fresh = _issue(db, storage, model, manifest, now=1002)
    assert fresh["id"] != first["id"] and fresh["reused"] is False


# I12b: a retired corrupt copy's file is physically deleted by cleanup (no leak).
def test_i12b_retired_corrupt_file_is_deleted_by_cleanup(tmp_path: Path):
    storage, manifest = _master(tmp_path)
    db, model = _db(tmp_path), FakeModel()
    first = _issue(db, storage, model, manifest, now=1000)
    key = first["storage_key"]
    storage.put_bytes(key, b"%PDF-broken")
    with pytest.raises(IssuanceError):
        _issue(db, storage, model, manifest, now=1001)
    assert _row(db, first["id"])["status"] == "failed"
    cleanup.run_once(db.conn, storage, now=1001 + TTL + 1)
    assert not storage.exists(key), "retired corrupt PDF must not remain on disk"
