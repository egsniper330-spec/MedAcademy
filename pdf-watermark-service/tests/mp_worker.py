"""Standalone worker process for multi-process correctness tests (tests/test_multiprocess.py).

Each invocation is a separate OS process that opens its own SQLite connection to the shared state DB
and uses the shared storage directory. Output is one JSON object on stdout.

Actions:
  claim <key> <lease_seconds> <now>        -> {"action", "id", "token", "payload"}
  publish <id> <token> <storage_key> <now> -> {"ok"}  (mark_ready with a verified-looking sha)
  claim_then_crash <key> <lease_seconds> <now> -> claims, then os._exit(137) without cleanup
  cleanup <now>                            -> CleanupReport fields
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app import cleanup, issuance  # noqa: E402
from app.db import open_connection  # noqa: E402
from app.storage import LocalPrivateStorage  # noqa: E402

IDENTITY = dict(student_ref="s", doctor_ref="d", material_id="m", version_id="v", course_ref="c",
                source_sha256="a" * 64, algorithm="alg", config_version="cfg", master_fingerprint="fp")


def main() -> int:
    db_path = Path(os.environ["MP_DB"])
    storage_root = Path(os.environ["MP_STORAGE"])
    action = sys.argv[1]
    conn = open_connection(db_path)
    try:
        if action == "claim":
            key, lease, now = sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
            act, row = issuance.claim(conn, key=key, identity=IDENTITY, lease_seconds=lease, now=now)
            out = {"action": act, "id": row.id, "token": row.lease_token, "payload": row.payload}
        elif action == "claim_then_crash":
            key, lease, now = sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
            act, row = issuance.claim(conn, key=key, identity=IDENTITY, lease_seconds=lease, now=now)
            print(json.dumps({"action": act, "id": row.id}), flush=True)
            os._exit(137)  # simulate a hard crash: no cleanup, no lease release
        elif action == "publish":
            iid, token, key, now = sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
            ok = issuance.mark_ready(conn, issuance_id=iid, token=token, storage_key=key,
                                     file_sha256="b" * 64, ttl_seconds=86400, meta=IDENTITY, now=now)
            out = {"ok": ok}
        elif action == "cleanup":
            now = int(sys.argv[2])
            report = cleanup.run_once(conn, LocalPrivateStorage(storage_root), now=now)
            out = {"expired": report.expired, "deleted": report.deleted, "failed": report.failed}
        else:
            raise SystemExit(f"unknown action {action}")
    finally:
        conn.close()
    print(json.dumps(out), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
