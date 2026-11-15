"""Correctness across real OS processes sharing one SQLite database and one storage directory.

Each step runs `tests/mp_worker.py` in a fresh interpreter, so there is no shared memory, GIL or
connection object between the actors. Only the database file and storage directory are shared.
These are correctness checks, not performance tests.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from app.db import StateDB

WORKER = Path(__file__).resolve().parent / "mp_worker.py"
PROCESSES = 6


def _run(action: str, db: Path, storage: Path, *args: str, expect_rc: int = 0) -> dict:
    env = dict(os.environ, MP_DB=str(db), MP_STORAGE=str(storage))
    proc = subprocess.run(
        [sys.executable, str(WORKER), action, *args],
        env=env, capture_output=True, text=True, timeout=60,
    )
    if expect_rc is not None and proc.returncode != expect_rc:
        raise AssertionError(f"{action} rc={proc.returncode}\nstdout={proc.stdout}\nstderr={proc.stderr}")
    lines = [ln for ln in proc.stdout.splitlines() if ln.strip().startswith("{")]
    return json.loads(lines[-1]) if lines else {}


@pytest.fixture
def shared(tmp_path: Path):
    db = tmp_path / "state.sqlite3"
    storage = tmp_path / "storage"
    (storage / "issued").mkdir(parents=True)
    (storage / "tmp" / "issuance").mkdir(parents=True)
    StateDB(db).close()  # create schema once, as the API does at startup
    return db, storage


def test_identical_concurrent_requests_create_exactly_one_issuance(shared):
    db, storage = shared
    with ThreadPoolExecutor(PROCESSES) as pool:
        results = list(pool.map(
            lambda _: _run("claim", db, storage, "same-key", "900", "1000"), range(PROCESSES)))
    generators = [r for r in results if r["action"] == "generate"]
    waiters = [r for r in results if r["action"] == "wait"]
    assert len(generators) == 1, results
    assert len(waiters) == PROCESSES - 1
    assert {r["id"] for r in results} == {generators[0]["id"]}
    count = StateDB(db).conn.execute(
        "SELECT COUNT(*) FROM issuances WHERE cache_key = 'same-key'").fetchone()[0]
    assert count == 1


def test_distinct_concurrent_requests_get_unique_payloads(shared):
    db, storage = shared
    keys = [f"key-{i}" for i in range(PROCESSES)]
    with ThreadPoolExecutor(PROCESSES) as pool:
        results = list(pool.map(lambda k: _run("claim", db, storage, k, "900", "1000"), keys))
    assert all(r["action"] == "generate" for r in results)
    payloads = [r["payload"] for r in results]
    assert len(set(payloads)) == PROCESSES
    ids = [r["id"] for r in results]
    assert len(set(ids)) == PROCESSES
    db_payloads = [row[0] for row in StateDB(db).conn.execute("SELECT watermark_id FROM issuances")]
    assert len(db_payloads) == PROCESSES and len(set(db_payloads)) == PROCESSES


def test_crashed_holder_does_not_leave_issuance_stuck(shared):
    db, storage = shared
    crashed = _run("claim_then_crash", db, storage, "crash-key", "60", "1000", expect_rc=137)
    assert crashed["action"] == "generate"
    # Still within the lease: others must wait, not generate.
    assert _run("claim", db, storage, "crash-key", "60", "1030")["action"] == "wait"
    # After the lease expires, another process takes over the same record with a new token.
    takeover = _run("claim", db, storage, "crash-key", "60", "1100")
    assert takeover["action"] == "generate"
    assert takeover["id"] == crashed["id"]
    assert takeover["token"]
    published = _run("publish", db, storage, takeover["id"], takeover["token"],
                     f"issued/{takeover['id']}-{takeover['token']}.pdf", "1110")
    assert published["ok"] is True


def test_expired_lease_worker_cannot_publish_over_newer_attempt(shared):
    db, storage = shared
    first = _run("claim", db, storage, "race-key", "60", "1000")
    second = _run("claim", db, storage, "race-key", "900", "1100")  # reclaims after expiry
    assert second["action"] == "generate" and second["id"] == first["id"]
    assert second["token"] != first["token"]

    stale = _run("publish", db, storage, first["id"], first["token"],
                 f"issued/{first['id']}-{first['token']}.pdf", "1101")
    assert stale["ok"] is False
    fresh = _run("publish", db, storage, second["id"], second["token"],
                 f"issued/{second['id']}-{second['token']}.pdf", "1102")
    assert fresh["ok"] is True
    row = StateDB(db).conn.execute(
        "SELECT storage_key, status FROM issuances WHERE id = ?", (first["id"],)).fetchone()
    assert row[0] == f"issued/{second['id']}-{second['token']}.pdf"
    assert row[1] == "ready"


def test_stale_cleanup_process_cannot_delete_newer_published_file(shared):
    db, storage = shared
    # Attempt 1: published at t=1000 with TTL 86400, then expires. Its file is still on disk.
    first = _run("claim", db, storage, "ttl-key", "900", "1000")
    first_key = f"issued/{first['id']}-{first['token']}.pdf"
    (storage / first_key).write_bytes(b"%PDF-old")
    assert _run("publish", db, storage, first["id"], first["token"], first_key, "1000")["ok"] is True

    # Expiry passes. A new request must create a new issuance, not reuse the expired one.
    later = 1000 + 86400 + 10
    fresh = _run("claim", db, storage, "ttl-key", "900", str(later))
    assert fresh["action"] == "generate"
    assert fresh["id"] != first["id"]
    fresh_key = f"issued/{fresh['id']}-{fresh['token']}.pdf"
    (storage / fresh_key).write_bytes(b"%PDF-new")
    assert _run("publish", db, storage, fresh["id"], fresh["token"], fresh_key, str(later))["ok"] is True

    # A cleanup process that started before the new publish, with a stale view of time, runs now.
    # It deletes only the expired row's file and must leave the newer file untouched.
    _run("cleanup", db, storage, str(later))
    assert not (storage / first_key).exists()
    assert (storage / fresh_key).exists()
    assert (storage / fresh_key).read_bytes() == b"%PDF-new"

    # Running cleanup again is idempotent.
    again = _run("cleanup", db, storage, str(later))
    assert again["deleted"] == 0 and again["failed"] == 0
    assert (storage / fresh_key).exists()
