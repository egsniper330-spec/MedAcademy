"""24-hour lifecycle for personalised issued PDFs.

Rules enforced here (all times UTC unix seconds):
- A copy's `expires_at` is fixed when it is published (`ready_at + TTL`). Reads never extend it.
- An expired copy is never served: `issuance.issue()` checks expiry before reuse, and this module
  flips the row to `expired` in the database BEFORE it deletes the file.
- Only the published copy of an expired row is deleted (`issued/<id>-<token>.pdf`). Original PDFs,
  preprocessed masters, `issuances` mappings and `issuance_events` (audit/download trail) are never
  touched. A row is kept forever; only its file is removed.
- Temp files of a crashed generation (`tmp/issuance/...`) are removed only when the generation's
  lease has expired, so an active generation's temp file is never deleted.
- Deletion is idempotent. A file that is already gone counts as deleted. A failed deletion leaves
  the row 'expired' with its storage_key still set, so the next pass retries it. Once deleted, the
  storage_key is cleared; the row itself stays.
- Restart-safe: the state lives in the database, so an interrupted pass is simply resumed.

Run by `python -m app.cleanup_runner` (a supervised process, every PDF_SVC_CLEANUP_INTERVAL_SECONDS).
"""

from __future__ import annotations

import logging
import sqlite3
import time
from dataclasses import dataclass

from .storage import LocalPrivateStorage, StorageKeyError

log = logging.getLogger("pdf_watermark.cleanup")

DEFAULT_INTERVAL_SECONDS = 300
BATCH_SIZE = 200


@dataclass
class CleanupReport:
    expired: int
    deleted: int
    failed: int
    orphans_removed: int = 0
    orphans_failed: int = 0


def _utc_now() -> int:
    return int(time.time())


def mark_expired(conn: sqlite3.Connection, now: int) -> int:
    """Flip ready rows past expiry to 'expired' in one short transaction. Returns the count.

    This runs before any file is deleted, so the read path (which checks status and expiry) rejects
    them even if their file still exists.
    """
    conn.execute("BEGIN IMMEDIATE")
    try:
        ids = [r[0] for r in conn.execute(
            "SELECT id FROM issuances WHERE status = 'ready' AND expires_at IS NOT NULL AND expires_at <= ?",
            (now,)).fetchall()]
        conn.executemany(
            "UPDATE issuances SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'ready'",
            [(now, i) for i in ids],
        )
        conn.executemany(
            "INSERT INTO issuance_events (issuance_id, event, at) VALUES (?, 'expired', ?)",
            [(i, now) for i in ids],
        )
        conn.execute("COMMIT")
        return len(ids)
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def _pending_files(conn: sqlite3.Connection, now: int) -> list[sqlite3.Row]:
    """Rows whose published file may still exist: expired ones past TTL, and retired-as-broken ones.

    A 'failed' row keeps its storage_key when a stored copy is found corrupt or missing, so its file
    must be removed too. Uses storage_key, never a computed name.
    """
    return conn.execute(
        "SELECT id, storage_key FROM issuances "
        "WHERE storage_key IS NOT NULL AND ("
        "  (status = 'expired' AND expires_at <= ?) OR status = 'failed') "
        "ORDER BY expires_at LIMIT ?",
        (now, BATCH_SIZE),
    ).fetchall()


def _clear_storage_key(conn: sqlite3.Connection, issuance_id: str, now: int) -> None:
    """Record that the file is gone. The row and its mapping remain; only the storage pointer clears."""
    conn.execute(
        "UPDATE issuances SET storage_key = NULL, updated_at = ? WHERE id = ? AND status IN ('expired', 'failed')",
        (now, issuance_id),
    )
    conn.execute(
        "INSERT INTO issuance_events (issuance_id, event, at) VALUES (?, 'file_deleted', ?)",
        (issuance_id, now),
    )


ORPHAN_MIN_AGE_SECONDS = 3600
_TEMP_PREFIX = "tmp/issuance"
_ISSUED_PREFIX = "issued"


def _orphan_candidates(storage: LocalPrivateStorage, prefix: str) -> list[str]:
    """Regular files directly under one approved prefix. Never recursive, never outside `prefix`."""
    directory = storage.root.joinpath(*prefix.split("/"))
    if not directory.is_dir():
        return []
    return [f"{prefix}/{entry.name}" for entry in directory.iterdir() if entry.is_file()]


def _is_old(storage: LocalPrivateStorage, key: str, now: int) -> bool:
    return now - int(storage.mtime(key)) >= ORPHAN_MIN_AGE_SECONDS


def _sweep_orphans(conn: sqlite3.Connection, storage: LocalPrivateStorage, now: int) -> tuple[int, int]:
    """Remove orphan files under the two approved prefixes. Returns (removed, failed).

    A temp file `tmp/issuance/<id>-<token>.pdf` is kept while a generation with that exact token is
    still 'generating' under a live lease. Otherwise it is an orphan and, once older than the age
    threshold, deleted. An issued file `issued/<id>-<token>.pdf` is kept while some row still points
    at it through storage_key. Otherwise it is a leftover (for example, a reclaimed attempt whose
    cleanup was interrupted) and is deleted once it is older than the threshold. The newest published
    file of a ready row is always referenced, so it is never touched.
    """
    removed = failed = 0
    live_temp = {
        f"{_TEMP_PREFIX}/{r['id']}-{r['lease_token']}.pdf"
        for r in conn.execute(
            "SELECT id, lease_token FROM issuances WHERE status = 'generating' "
            "AND lease_token IS NOT NULL AND lease_expires_at > ?", (now,))
    }
    referenced = {
        r[0] for r in conn.execute("SELECT storage_key FROM issuances WHERE storage_key IS NOT NULL")
    }
    candidates = [(k, live_temp) for k in _orphan_candidates(storage, _TEMP_PREFIX)]
    candidates += [(k, referenced) for k in _orphan_candidates(storage, _ISSUED_PREFIX)]
    for key, protected in candidates:
        if key in protected:
            continue
        try:
            if not _is_old(storage, key, now):
                continue
            if storage.delete(key):
                removed += 1
        except (OSError, StorageKeyError) as exc:
            failed += 1
            log.warning("orphan delete failed, will retry: %s (%s)", key, type(exc).__name__)
    return removed, failed


def run_once(conn: sqlite3.Connection, storage: LocalPrivateStorage, now: int | None = None) -> CleanupReport:
    """One cleanup pass. Idempotent: running it again on a clean state changes nothing."""
    now = _utc_now() if now is None else now
    expired = mark_expired(conn, now)

    deleted = failed = 0
    for row in _pending_files(conn, now):
        try:
            storage.delete(row["storage_key"])  # idempotent: missing file is not an error
        except (OSError, StorageKeyError) as exc:
            # Keep storage_key so the next pass retries. The row is already 'expired', so it is
            # never served in the meantime.
            failed += 1
            log.warning("file delete failed for %s, will retry: %s", row["id"], type(exc).__name__)
            continue
        _clear_storage_key(conn, row["id"], now)
        deleted += 1

    orphans_removed, orphans_failed = _sweep_orphans(conn, storage, now)
    report = CleanupReport(expired=expired, deleted=deleted, failed=failed,
                           orphans_removed=orphans_removed, orphans_failed=orphans_failed)
    log.info("cleanup pass: expired=%d files_deleted=%d delete_failed=%d orphans_removed=%d orphans_failed=%d",
             report.expired, report.deleted, report.failed, report.orphans_removed, report.orphans_failed)
    return report
