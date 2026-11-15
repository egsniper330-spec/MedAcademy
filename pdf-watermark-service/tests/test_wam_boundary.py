"""Lightweight test of the API <-> WAM runtime boundary, with a controlled fake model (no torch).

Runs the real WamRuntimeClient against the real runtime app over loopback HTTP, the same path the
issuance endpoint takes. The real-checkpoint smoke test is separate (test_issuance.py, WAM venv only).
"""

from __future__ import annotations

import base64
import io
import json
import socket
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import auth, wam_runtime  # noqa: E402
from app.wam_client import WamRuntimeClient  # noqa: E402

KEY = b"boundary-secret"


class RecordingModel:
    def __init__(self) -> None:
        self.calls: list[int] = []

    def embed_image(self, image_chw, payload: int):
        self.calls.append(payload)
        return np.asarray(image_chw, dtype=np.float32)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture()
def runtime(tmp_path):
    import uvicorn

    model = RecordingModel()
    store = wam_runtime.SqliteNonceStore(tmp_path / "nonces.sqlite3")
    app = wam_runtime.build_app(keys={"k1": KEY}, model=model, nonce_store=store)
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while not server.started and time.time() < deadline:
        time.sleep(0.02)
    assert server.started, "loopback runtime did not start"
    yield model, f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(timeout=10)


def test_client_round_trip_reaches_model_once_per_request(runtime):
    model, url = runtime
    client = WamRuntimeClient(url, "k1", KEY)
    image = np.full((3, 8, 8), 0.5, dtype=np.float32)
    out = client.embed_image(image, 0xDEADBEEF)
    assert out.shape == (3, 8, 8)
    assert model.calls == [0xDEADBEEF]


def test_wrong_secret_is_rejected_before_model(runtime):
    model, url = runtime
    client = WamRuntimeClient(url, "k1", b"wrong-secret")
    with pytest.raises(Exception):
        client.embed_image(np.zeros((3, 4, 4), dtype=np.float32), 1)
    assert model.calls == []


def test_unknown_key_id_is_rejected_before_model(runtime):
    model, url = runtime
    client = WamRuntimeClient(url, "nope", KEY)
    with pytest.raises(Exception):
        client.embed_image(np.zeros((3, 4, 4), dtype=np.float32), 1)
    assert model.calls == []


def test_replayed_nonce_is_rejected(runtime):
    model, url = runtime
    from urllib.error import HTTPError
    from urllib.request import Request, urlopen

    body = json.dumps({"payload": 9, "image_b64": base64.b64encode(_png()).decode()}).encode()
    nonce = "replay-nonce-0123456789abcdef"  # must match NONCE_PATTERN (16-128 url-safe chars)
    ts = str(int(time.time()))
    sig = auth.sign(KEY, "POST", "/embed", ts, nonce, body)
    headers = {"Content-Type": "application/json", "X-Key-Id": "k1", "X-Timestamp": ts,
               "X-Nonce": nonce, "X-Signature": sig}
    with urlopen(Request(url + "/embed", data=body, method="POST", headers=headers), timeout=10) as r:
        assert r.status == 200
    with pytest.raises(HTTPError) as err:
        urlopen(Request(url + "/embed", data=body, method="POST", headers=headers), timeout=10)
    assert err.value.code == 401
    assert model.calls == [9]


def _png() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (4, 4), (10, 20, 30)).save(buf, format="PNG")
    return buf.getvalue()


def _signed_post(url: str, body: bytes, nonce: str = "bnd-nonce-0123456789abcdef"):
    from urllib.request import Request, urlopen

    ts = str(int(time.time()))
    sig = auth.sign(KEY, "POST", "/embed", ts, nonce, body)
    headers = {"Content-Type": "application/json", "X-Key-Id": "k1", "X-Timestamp": ts,
               "X-Nonce": nonce, "X-Signature": sig}
    req = Request(url + "/embed", data=body, method="POST", headers=headers)
    try:
        with urlopen(req, timeout=10) as r:
            return r.status, r.read()
    except Exception as exc:  # HTTPError carries the status
        return exc.code, b""


def test_oversized_body_is_rejected_before_model(runtime, monkeypatch):
    model, url = runtime
    monkeypatch.setattr(wam_runtime, "MAX_BODY_BYTES", 1024)
    status, _ = _signed_post(url, b"{" + b"x" * 4096 + b"}", nonce="big-nonce-0123456789abcdef")
    assert status == 413
    assert model.calls == []


def test_non_png_and_malformed_base64_are_rejected(runtime):
    model, url = runtime
    jpeg_like = base64.b64encode(b"\xff\xd8\xff\xe0 not png").decode()
    bad_b64 = "!!!not-base64!!!"
    for n, img in enumerate([jpeg_like, bad_b64]):
        body = json.dumps({"payload": 1, "image_b64": img}).encode()
        status, _ = _signed_post(url, body, nonce=f"fmt-nonce-{n}-0123456789abcdef")
        assert status == 422
    assert model.calls == []


def test_image_over_pixel_limit_is_rejected_before_decode(runtime, monkeypatch):
    model, url = runtime
    monkeypatch.setattr(wam_runtime, "MAX_IMAGE_PIXELS", 8)
    body = json.dumps({"payload": 1, "image_b64": base64.b64encode(_png()).decode()}).encode()
    status, _ = _signed_post(url, body, nonce="pix-nonce-0123456789abcdef")
    assert status == 422
    assert model.calls == []


def test_payload_out_of_range_or_non_int_is_rejected(runtime):
    model, url = runtime
    for n, payload in enumerate([-1, 1 << 32, "7", 1.5]):
        body = json.dumps({"payload": payload, "image_b64": base64.b64encode(_png()).decode()}).encode()
        status, _ = _signed_post(url, body, nonce=f"pay-nonce-{n}-0123456789abcdef")
        assert status == 422
    assert model.calls == []


def test_nonce_store_survives_restart(tmp_path):
    path = tmp_path / "nonces.sqlite3"
    store = wam_runtime.SqliteNonceStore(path)
    now = int(time.time())
    assert store.claim("k1", "n-restart-0123456789abcdef", now, 600, now) is True
    reopened = wam_runtime.SqliteNonceStore(path)  # simulated process restart
    assert reopened.claim("k1", "n-restart-0123456789abcdef", now, 600, now) is False


def test_nonce_store_prunes_outside_window(tmp_path):
    store = wam_runtime.SqliteNonceStore(tmp_path / "nonces.sqlite3")
    store.claim("k1", "old", 0, 600, 0)
    assert store.claim("k1", "fresh", 5000, 600, 5000) is True
    assert store.claim("k1", "old", 5000, 600, 5000) is True  # pruned, so reusable after window
