"""Replay protection: each (key id, nonce) pair is accepted once inside the clock-skew window.

Stored in SQLite so that several worker processes share one view. Expired rows are pruned
on each insert, which keeps the table bounded by the request rate times the window.
"""

from __future__ import annotations

import sqlite3
import threading


class NonceStore:
    def __init__(self, conn: sqlite3.Connection, lock: threading.Lock) -> None:
        self._conn = conn
        self._lock = lock

    def claim(self, key_id: str, nonce: str, timestamp: int, window_seconds: int, now: int) -> bool:
        """Return True if the nonce is new. False means it was already used (replay)."""
        with self._lock:
            self._conn.execute("DELETE FROM nonces WHERE seen_at < ?", (now - window_seconds,))
            try:
                self._conn.execute(
                    "INSERT INTO nonces (key_id, nonce, seen_at) VALUES (?, ?, ?)",
                    (key_id, nonce, max(timestamp, now)),
                )
            except sqlite3.IntegrityError:
                self._conn.commit()
                return False
            self._conn.commit()
            return True
