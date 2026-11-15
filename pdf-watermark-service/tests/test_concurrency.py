"""Multi-connection correctness: separate SQLite connections (one per worker) must not create duplicate
payloads or duplicate live issuances. Threads with separate connections stand in for separate workers;
a true multi-process run is a VPS test item."""

from __future__ import annotations

import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import issuance  # noqa: E402
from app.db import StateDB, open_connection  # noqa: E402


def test_concurrent_payload_allocation_creates_no_duplicates(tmp_path: Path):
    db_path = tmp_path / "state.sqlite3"
    StateDB(db_path)  # creates schema
    results: list[int] = []
    errors: list[BaseException] = []
    lock = threading.Lock()

    def worker(n: int) -> None:
        conn = open_connection(db_path)
        try:
            for i in range(n):
                conn.execute("BEGIN IMMEDIATE")
                try:
                    payload = issuance._allocate_payload(conn)
                    conn.execute(
                        """INSERT INTO issuances (id, watermark_id, cache_key, student_ref, doctor_ref,
                           material_id, version_id, course_ref, source_sha256, master_fingerprint, algorithm,
                           config_version, status, created_at, updated_at)
                           VALUES (?, ?, ?, 's', 'd', 'm', 'v', 'c', ?, 'fp', 'alg', 'cfg', 'failed', 1, 1)""",
                        (f"{threading.get_ident()}-{i}", payload, f"k-{threading.get_ident()}-{i}", "a" * 64),
                    )
                    conn.execute("COMMIT")
                    with lock:
                        results.append(payload)
                except BaseException:
                    conn.execute("ROLLBACK")
                    raise
        except BaseException as exc:  # surfaced below, never swallowed
            with lock:
                errors.append(exc)
        finally:
            conn.close()

    threads = [threading.Thread(target=worker, args=(10,)) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, errors
    assert len(results) == 60
    assert len(set(results)) == 60  # no duplicate payloads across connections
    count = StateDB(db_path).conn.execute("SELECT COUNT(*) FROM issuances").fetchone()[0]
    assert count == 60


def test_stale_worker_cannot_publish_over_newer_result(tmp_path: Path):
    """Worker A's lease expires; worker B reclaims it. A's late mark_ready must be rejected."""
    db_path = tmp_path / "state.sqlite3"
    StateDB(db_path)
    a, b = open_connection(db_path), open_connection(db_path)
    identity = dict(student_ref="s", doctor_ref="d", material_id="m", version_id="v", course_ref="c",
                    source_sha256="a" * 64, algorithm="alg", config_version="cfg", master_fingerprint="fp")
    _, row = issuance.claim(a, key="k", identity=identity, lease_seconds=10, now=100)
    stale_token = row.lease_token
    _, reclaimed = issuance.claim(b, key="k", identity=identity, lease_seconds=900, now=200)
    assert reclaimed.lease_token != stale_token

    ok_b = issuance.mark_ready(b, issuance_id=row.id, token=reclaimed.lease_token,
                               storage_key="issued/x-new.pdf", file_sha256="b" * 64,
                               ttl_seconds=86400, meta=identity, now=300)
    ok_a = issuance.mark_ready(a, issuance_id=row.id, token=stale_token,
                               storage_key="issued/x-old.pdf", file_sha256="c" * 64,
                               ttl_seconds=86400, meta=identity, now=301)
    assert ok_b is True and ok_a is False
    final = a.execute("SELECT storage_key, file_sha256 FROM issuances WHERE id = ?", (row.id,)).fetchone()
    assert final[0] == "issued/x-new.pdf" and final[1] == "b" * 64
    a.close()
    b.close()


def test_identical_requests_converge_on_one_live_row(tmp_path: Path):
    """Two connections claiming the same cache_key: the partial unique index lets only one win."""
    db_path = tmp_path / "state.sqlite3"
    StateDB(db_path)
    a, b = open_connection(db_path), open_connection(db_path)
    identity = dict(student_ref="s", doctor_ref="d", material_id="m", version_id="v", course_ref="c",
                    source_sha256="a" * 64, algorithm="alg", config_version="cfg", master_fingerprint="fp")
    action_a, row_a = issuance.claim(a, key="same-key", identity=identity, lease_seconds=900, now=100)
    action_b, row_b = issuance.claim(b, key="same-key", identity=identity, lease_seconds=900, now=101)
    assert action_a == "generate"
    assert action_b == "wait" and row_b.id == row_a.id
    assert a.execute("SELECT COUNT(*) FROM issuances WHERE cache_key = 'same-key'").fetchone()[0] == 1
    a.close()
    b.close()
