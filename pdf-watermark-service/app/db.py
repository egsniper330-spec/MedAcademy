"""SQLite state store: job queue with atomic leases, and nonce table.

Job states: queued -> processing -> succeeded | failed (retry returns to queued).
A processing job whose lease has expired is reclaimed by the next claim.
"""

from __future__ import annotations

import sqlite3
import threading
import time
import uuid
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS nonces (
    key_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    seen_at INTEGER NOT NULL,
    PRIMARY KEY (key_id, nonce)
);
CREATE INDEX IF NOT EXISTS idx_nonces_seen ON nonces (seen_at);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued','processing','succeeded','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL,
    run_after INTEGER NOT NULL,
    lease_token TEXT,
    lease_expires_at INTEGER,
    last_error TEXT,
    result TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs (state, run_after);

-- Personalised issuance. One row per generated copy. The opaque watermark id is unique.
-- Retention: expires_at is fixed at successful generation and never extended by downloads.
CREATE TABLE IF NOT EXISTS issuances (
    id TEXT PRIMARY KEY,
    watermark_id INTEGER NOT NULL UNIQUE,
    cache_key TEXT NOT NULL,
    student_ref TEXT NOT NULL,
    doctor_ref TEXT NOT NULL,
    material_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    course_ref TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    master_fingerprint TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    config_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('generating','ready','failed','expired')),
    storage_key TEXT,
    file_sha256 TEXT,
    issued_at INTEGER,
    expires_at INTEGER,
    lease_token TEXT,
    lease_expires_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
-- Only one live (generating or ready) issuance per cache key. Failed/expired rows fall out of the index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_issuance_live_cache
    ON issuances (cache_key) WHERE status IN ('generating','ready');
-- Payload uniqueness across ALL retained rows, whatever their status. A 32-bit payload is never
-- reused while its mapping exists (forensic lookups must stay unambiguous). Also created by
-- migrate_payload_uniqueness() for databases whose table predates this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS uq_issuance_payload_all
    ON issuances (watermark_id);
CREATE INDEX IF NOT EXISTS idx_issuance_expiry ON issuances (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_issuance_material ON issuances (material_id, version_id);

CREATE TABLE IF NOT EXISTS issuance_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issuance_id TEXT NOT NULL,
    event TEXT NOT NULL,
    at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issuance_events ON issuance_events (issuance_id);

-- Forensic investigations. Stores evidence summary only, never the uploaded file itself.
CREATE TABLE IF NOT EXISTS detections (
    id TEXT PRIMARY KEY,
    document_sha256 TEXT NOT NULL,
    material_id TEXT,
    outcome TEXT NOT NULL,
    recovered_watermark_id INTEGER,
    matched_issuance_id TEXT,
    evidence TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    model_sha256 TEXT NOT NULL,
    detected_at INTEGER NOT NULL,
    upload_expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_detections_doc ON detections (document_sha256);
"""


def migrate_payload_uniqueness(conn: sqlite3.Connection) -> None:
    """Ensure payload uniqueness over all issuance rows (idempotent).

    `CREATE INDEX IF NOT EXISTS` in SCHEMA is a no-op on databases created earlier, and their old
    partial index only covered live rows. The unique index is created here. If duplicate payloads
    already exist, creation fails and the service refuses to start: rows are never deleted to fix it.
    """
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_issuance_payload_all ON issuances (watermark_id)"
    )
    conn.execute("DROP INDEX IF EXISTS uq_issuance_payload_live")


def open_connection(path: Path) -> sqlite3.Connection:
    """A separate connection for one issuance worker. Safe across threads and processes.

    Short write transactions use BEGIN IMMEDIATE; busy_timeout makes contending connections wait
    briefly instead of failing. The schema is created by StateDB at startup, not here.
    """
    conn = sqlite3.connect(str(path), timeout=5, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


class StateDB:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA busy_timeout=5000")
        self.conn.executescript(SCHEMA)
        migrate_payload_uniqueness(self.conn)
        self.lock = threading.Lock()

    def close(self) -> None:
        self.conn.close()

    def enqueue(
        self, *, kind: str, idempotency_key: str, payload: str, max_attempts: int, now: int | None = None
    ) -> tuple[str, bool]:
        """Insert a job. Returns (job_id, created). A repeated idempotency key returns the existing job."""
        ts = int(now if now is not None else time.time())
        job_id = uuid.uuid4().hex
        with self.lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                row = self.conn.execute(
                    "SELECT id FROM jobs WHERE idempotency_key = ?", (idempotency_key,)
                ).fetchone()
                if row is not None:
                    self.conn.execute("COMMIT")
                    return row["id"], False
                self.conn.execute(
                    "INSERT INTO jobs (id, kind, idempotency_key, payload, state, attempts, max_attempts,"
                    " run_after, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)",
                    (job_id, kind, idempotency_key, payload, max_attempts, ts, ts, ts),
                )
                self.conn.execute("COMMIT")
                return job_id, True
            except Exception:
                self.conn.execute("ROLLBACK")
                raise

    def claim(self, lease_seconds: int, now: int | None = None) -> sqlite3.Row | None:
        """Atomically lease the oldest runnable job. Returns the row or None."""
        ts = int(now if now is not None else time.time())
        token = uuid.uuid4().hex
        with self.lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                row = self.conn.execute(
                    "SELECT id FROM jobs WHERE (state = 'queued' AND run_after <= ?)"
                    " OR (state = 'processing' AND lease_expires_at < ?)"
                    " ORDER BY run_after, created_at LIMIT 1",
                    (ts, ts),
                ).fetchone()
                if row is None:
                    self.conn.execute("COMMIT")
                    return None
                self.conn.execute(
                    "UPDATE jobs SET state='processing', attempts = attempts + 1, lease_token=?,"
                    " lease_expires_at=?, updated_at=? WHERE id=?",
                    (token, ts + lease_seconds, ts, row["id"]),
                )
                job = self.conn.execute("SELECT * FROM jobs WHERE id=?", (row["id"],)).fetchone()
                self.conn.execute("COMMIT")
                return job
            except Exception:
                self.conn.execute("ROLLBACK")
                raise

    def complete(self, job_id: str, lease_token: str, result: str, now: int | None = None) -> bool:
        ts = int(now if now is not None else time.time())
        with self.lock:
            cur = self.conn.execute(
                "UPDATE jobs SET state='succeeded', result=?, lease_token=NULL, lease_expires_at=NULL,"
                " updated_at=? WHERE id=? AND lease_token=? AND state='processing'",
                (result, ts, job_id, lease_token),
            )
            return cur.rowcount == 1

    def fail(
        self, job_id: str, lease_token: str, error: str, retry_delay: int, now: int | None = None
    ) -> str | None:
        """Record a failed attempt. Returns the new state ('queued' or 'failed'), or None if the lease was lost."""
        ts = int(now if now is not None else time.time())
        with self.lock:
            row = self.conn.execute(
                "SELECT attempts, max_attempts FROM jobs WHERE id=? AND lease_token=? AND state='processing'",
                (job_id, lease_token),
            ).fetchone()
            if row is None:
                return None
            new_state = "failed" if row["attempts"] >= row["max_attempts"] else "queued"
            self.conn.execute(
                "UPDATE jobs SET state=?, last_error=?, run_after=?, lease_token=NULL,"
                " lease_expires_at=NULL, updated_at=? WHERE id=?",
                (new_state, error[:500], ts + retry_delay, ts, job_id),
            )
            return new_state

    def get(self, job_id: str) -> sqlite3.Row | None:
        with self.lock:
            return self.conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()

    def queue_depth(self) -> dict[str, int]:
        with self.lock:
            rows = self.conn.execute("SELECT state, COUNT(*) AS n FROM jobs GROUP BY state").fetchall()
        return {r["state"]: r["n"] for r in rows}
