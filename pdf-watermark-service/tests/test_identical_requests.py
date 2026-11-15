"""Identical-request contract and WAM readiness (HTTP level, fake model and fake WAM client)."""

from __future__ import annotations

import json
import secrets
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import auth, main  # noqa: E402
from app.config import Settings  # noqa: E402
from app.issuance import IssuanceError  # noqa: E402
from app.wam_client import WamRuntimeClient  # noqa: E402

SECRET = "test-secret-identical-0123456789abcdef"
WAM_SECRET = "test-secret-wam-0123456789abcdef-x"
PATH = "/internal/issuances"
BODY = json.dumps({
    "student_ref": "stu-001", "doctor_ref": "doc-001", "material_id": "mat1",
    "version_id": "v1", "course_ref": "course-A", "source_sha256": "a" * 64,
}).encode()


def _settings(tmp_path: Path, wait: int = 0, max_bytes: int = 1_048_576) -> Settings:
    return Settings(hmac_keys=f"k1:{SECRET}", storage_root=tmp_path / "st",
                    state_db_path=tmp_path / "state.sqlite3", worker_count=1,
                    issuance_wait_seconds=wait, max_request_bytes=max_bytes,
                    wam_hmac_key=f"wam:{WAM_SECRET}")


def _signed_post(client, body: bytes = BODY):
    ts = str(int(time.time()))
    nonce = secrets.token_hex(12)
    headers = {"X-Key-Id": "k1", "X-Timestamp": ts, "X-Nonce": nonce,
               "X-Signature": auth.sign(SECRET.encode(), "POST", PATH, ts, nonce, body),
               "Content-Type": "application/json"}
    return client.post(PATH, content=body, headers=headers)


def _patch_issue(monkeypatch, outcomes: list):
    """Each call to _issue_with_db pops the next outcome: an exception to raise or a dict to return."""
    calls = {"n": 0}

    def fake(**kwargs):
        calls["n"] += 1
        item = outcomes.pop(0) if len(outcomes) > 1 else outcomes[0]
        if isinstance(item, Exception):
            raise item
        return item

    monkeypatch.setattr(main, "read_master_manifest", lambda *a, **k: {"pages": []})
    monkeypatch.setattr(main, "issue", fake)
    return calls


def _client(tmp_path: Path, wait: int = 0, max_bytes: int = 1_048_576):
    from fastapi.testclient import TestClient

    return TestClient(main.create_app(_settings(tmp_path, wait, max_bytes)))


def test_in_progress_past_wait_returns_202_pending_with_retry(tmp_path: Path, monkeypatch):
    calls = _patch_issue(monkeypatch, [IssuanceError("in_progress", "busy")])
    with _client(tmp_path, wait=0) as client:
        r = _signed_post(client)
    assert r.status_code == 202
    assert r.json()["status"] == "pending"
    assert r.json()["retry_after_seconds"] >= 1
    assert r.headers["Retry-After"] == str(r.json()["retry_after_seconds"])
    assert calls["n"] == 1  # the wait does not start a second generation


def test_waiting_request_returns_ready_copy_when_generation_finishes(tmp_path: Path, monkeypatch):
    ready = {"id": "x", "status": "ready", "reused": True, "expires_at": 1}
    calls = _patch_issue(monkeypatch, [IssuanceError("in_progress", "busy"),
                                       IssuanceError("in_progress", "busy"), ready])
    monkeypatch.setattr(main, "_POLL_SECONDS", 0.01)
    with _client(tmp_path, wait=5) as client:
        r = _signed_post(client)
    assert r.status_code == 200
    assert r.json()["id"] == "x"
    assert calls["n"] == 3


def test_generation_failure_is_reported_without_retry_loop(tmp_path: Path, monkeypatch):
    calls = _patch_issue(monkeypatch, [IssuanceError("generation_failed", "boom")])
    with _client(tmp_path, wait=5) as client:
        r = _signed_post(client)
    assert r.status_code == 500
    assert r.json() == {"error": "generation_failed"}
    assert calls["n"] == 1
    assert "boom" not in r.text


def test_oversized_request_is_rejected_with_413(tmp_path: Path, monkeypatch):
    _patch_issue(monkeypatch, [{"id": "x"}])
    with _client(tmp_path, max_bytes=1024) as client:
        r = _signed_post(client, body=b"{" + b" " * 4096 + b"}")
    assert r.status_code == 413


def test_readyz_reports_wam_unavailable_while_healthz_stays_live(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(WamRuntimeClient, "health", lambda self: False)
    with _client(tmp_path) as client:
        assert client.get("/healthz").status_code == 200
        r = client.get("/readyz")
    assert r.status_code == 503
    assert r.json() == {"status": "degraded", "issuance": "unavailable"}


def test_readyz_reports_available_when_wam_answers(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(WamRuntimeClient, "health", lambda self: True)
    with _client(tmp_path) as client:
        r = client.get("/readyz")
    assert r.status_code == 200
    assert r.json() == {"status": "ready", "issuance": "available"}


def test_wam_health_probe_returns_false_when_unreachable():
    client = WamRuntimeClient("http://127.0.0.1:1", "wam", WAM_SECRET.encode())
    assert client.health() is False
