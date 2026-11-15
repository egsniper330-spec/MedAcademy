"""Supervised cleanup process: python -m app.cleanup_runner

Runs `cleanup.run_once` every PDF_SVC_CLEANUP_INTERVAL_SECONDS (default 300, bounds 60-900).

- Single instance: an exclusive lock file in the state directory prevents a second cleanup loop,
  so several API workers or accidental double starts never run duplicate passes.
- Graceful stop: SIGTERM/SIGINT finish the current pass, then exit 0.
- Crash-safe: all state lives in SQLite, so restarting simply resumes with the next pass.
"""

from __future__ import annotations

import logging
import os
import signal
import sys
import threading
from pathlib import Path

from .cleanup import run_once
from .config import load_settings
from .db import StateDB
from .storage import LocalPrivateStorage

log = logging.getLogger("pdf_watermark.cleanup_runner")

ENV_INTERVAL = "PDF_SVC_CLEANUP_INTERVAL_SECONDS"
DEFAULT_INTERVAL = 300


class AlreadyRunning(RuntimeError):
    pass


def _acquire_lock(path: Path):
    """Hold an exclusive, non-blocking lock for the life of the process. Returns the open handle."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a+b")
    handle.seek(0)
    try:
        if os.name == "nt":
            import msvcrt

            # Locks byte 0 at the current position; the handle is positioned at 0 above.
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        handle.close()
        raise AlreadyRunning(f"another cleanup process holds {path}") from exc
    # Informational only: the lock is the authority, not the file contents.
    handle.seek(0)
    handle.truncate()
    handle.write(str(os.getpid()).encode("ascii"))
    handle.flush()
    handle.seek(0)
    return handle


def _interval() -> int:
    raw = os.environ.get(ENV_INTERVAL, str(DEFAULT_INTERVAL))
    value = int(raw)
    if not 60 <= value <= 900:
        raise ValueError(f"{ENV_INTERVAL} must be between 60 and 900 seconds")
    return value


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        settings = load_settings()
        interval = _interval()
    except Exception as exc:
        sys.stderr.write(f"pdf-watermark cleanup: refusing to start: invalid configuration: {exc}\n")
        return 2

    lock_path = settings.state_db_path.parent / "cleanup.lock"
    try:
        lock = _acquire_lock(lock_path)
    except AlreadyRunning as exc:
        sys.stderr.write(f"pdf-watermark cleanup: {exc}\n")
        return 3

    stop = threading.Event()

    def _request_stop(signum, _frame):
        log.info("signal %s received; stopping after the current pass", signum)
        stop.set()

    signal.signal(signal.SIGTERM, _request_stop)
    signal.signal(signal.SIGINT, _request_stop)

    storage = LocalPrivateStorage(settings.storage_root)
    db = StateDB(settings.state_db_path)
    conn = db.conn
    log.info("cleanup started: interval=%ss", interval)
    try:
        while not stop.is_set():
            try:
                run_once(conn, storage)
            except Exception:
                log.exception("cleanup pass failed; retrying next interval")
            stop.wait(interval)
    finally:
        db.close()
        lock.close()
        log.info("cleanup stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
