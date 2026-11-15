"""Queue worker pool. A fixed number of threads (PDF_SVC_WORKER_COUNT) lease jobs from StateDB.

Handlers are registered by job kind. Processing stays bounded by the pool size, so an
incoming burst of requests waits in the queue instead of starting unlimited CPU work.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections.abc import Callable

from .db import StateDB

log = logging.getLogger("pdf_watermark.worker")

Handler = Callable[[dict], dict]


class WorkerPool:
    def __init__(
        self,
        db: StateDB,
        handlers: dict[str, Handler],
        *,
        worker_count: int,
        lease_seconds: int,
        retry_delay_seconds: int,
        idle_sleep_seconds: float = 0.5,
    ) -> None:
        self._db = db
        self._handlers = handlers
        self._count = worker_count
        self._lease = lease_seconds
        self._retry = retry_delay_seconds
        self._idle = idle_sleep_seconds
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    def start(self) -> None:
        for i in range(self._count):
            t = threading.Thread(target=self._loop, name=f"pdf-worker-{i}", daemon=True)
            t.start()
            self._threads.append(t)

    def stop(self, timeout: float = 10.0) -> None:
        self._stop.set()
        for t in self._threads:
            t.join(timeout)

    def run_once(self) -> bool:
        """Process a single job if one is runnable. Returns True if a job was handled. Used by tests."""
        job = self._db.claim(self._lease)
        if job is None:
            return False
        self._process(job)
        return True

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                if not self.run_once():
                    self._stop.wait(self._idle)
            except Exception:  # never let one bad iteration kill the worker thread
                log.exception("worker loop error")
                self._stop.wait(self._idle)

    def _process(self, job) -> None:
        kind = job["kind"]
        handler = self._handlers.get(kind)
        started = time.monotonic()
        try:
            if handler is None:
                raise RuntimeError(f"no handler registered for job kind '{kind}'")
            result = handler(json.loads(job["payload"]))
            self._db.complete(job["id"], job["lease_token"], json.dumps(result, separators=(",", ":")))
            log.info("job succeeded kind=%s id=%s seconds=%.3f", kind, job["id"], time.monotonic() - started)
        except Exception as exc:
            state = self._db.fail(job["id"], job["lease_token"], type(exc).__name__, self._retry)
            log.warning("job failed kind=%s id=%s state=%s error=%s", kind, job["id"], state, type(exc).__name__)
