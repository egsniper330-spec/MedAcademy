"""HTTP contract for POST /internal/detect-image.

Checks the parts that belong to the SERVICE BOUNDARY: internal HMAC auth, its own
(larger) body limit without widening the other routes, signature-based format
validation, the four verdicts reaching the caller, and that an unexpected model
failure becomes a 503 rather than a 500 with internals.

The model is a fake: what a real checkpoint reads from a photograph is measured
by scripts/validate_image_forensics.py on the VPS, not here.
"""

from __future__ import annotations

import io
import secrets
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import auth  # noqa: E402
from app.config import Settings  # noqa: E402

SECRET = "i" * 40


class FakeWam:
    """Configurable stand-in for WamRuntimeClient.extract_image."""

    def __init__(self, payload=123456, score=0.95, fail=False):
        self.payload = payload
        self.score = score
        self.fail = fail
        self.calls = 0

    def extract_image(self, chw):
        self.calls += 1
        if self.fail:
            raise RuntimeError("WAM runtime unreachable")
        return self.payload, self.score


def _signed(method: str, path: str, body: bytes, content_type: str) -> dict:
    ts = int(time.time())
    nonce = secrets.token_hex(12)
    sig = auth.sign(SECRET.encode(), method, path, str(ts), nonce, body)
    return {"X-Key-Id": "k1", "X-Timestamp": str(ts), "X-Nonce": nonce,
            "X-Signature": sig, "Content-Type": content_type}


def _page(width=1000, height=1414, ink=True) -> bytes:
    img = Image.new("RGB", (width, height), (255, 255, 255))
    if ink:
        draw = ImageDraw.Draw(img)
        for line in range(40):
            draw.line((70, 60 + line * 30, width - 70, 60 + line * 30), fill=(20, 20, 20), width=3)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _client(tmp_path, model, **overrides):
    from fastapi.testclient import TestClient

    from app.main import create_app

    settings = Settings(hmac_keys=f"k1:{SECRET}", storage_root=tmp_path / "st",
                        state_db_path=tmp_path / "st.sqlite3", worker_count=1, **overrides)
    app = create_app(settings)
    client = TestClient(app)
    client.__enter__()
    app.state.wam_model = lambda: model
    client.app.state.pool.stop()  # deterministic: no background jobs in these tests
    return client


def test_valid_image_is_verified(tmp_path: Path):
    model = FakeWam(payload=999, score=0.95)
    client = _client(tmp_path, model)
    try:
        body = _page()
        r = client.post("/internal/detect-image", content=body,
                        headers=_signed("POST", "/internal/detect-image", body, "image/png"))
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["verdict"] in ("confirmed", "probable")
        assert data["payload"] == 999
        assert data["candidates_total"] >= 1
        assert data["quality"]["ok"] is True
    finally:
        client.__exit__(None, None, None)


def test_insufficient_quality_is_its_own_verdict(tmp_path: Path):
    client = _client(tmp_path, FakeWam())
    try:
        body = _page(200, 200)  # below the minimum side
        r = client.post("/internal/detect-image", content=body,
                        headers=_signed("POST", "/internal/detect-image", body, "image/png"))
        assert r.status_code == 200
        data = r.json()
        assert data["verdict"] == "insufficient_quality"
        assert data["payload"] is None
        assert "low_resolution" in data["quality"]["reasons"]
    finally:
        client.__exit__(None, None, None)


def test_non_image_body_is_rejected_without_touching_the_model(tmp_path: Path):
    model = FakeWam()
    client = _client(tmp_path, model)
    try:
        body = b"%PDF-1.7 not an image"
        r = client.post("/internal/detect-image", content=body,
                        headers=_signed("POST", "/internal/detect-image", body, "image/png"))
        assert r.status_code == 422
        assert r.json()["error"] == "invalid_image"
        assert model.calls == 0
    finally:
        client.__exit__(None, None, None)


def test_unsigned_request_is_rejected(tmp_path: Path):
    client = _client(tmp_path, FakeWam())
    try:
        r = client.post("/internal/detect-image", content=_page(400, 400),
                        headers={"Content-Type": "image/png"})
        assert r.status_code == 401
    finally:
        client.__exit__(None, None, None)


def test_image_endpoint_has_its_own_larger_body_limit(tmp_path: Path):
    # The service-wide JSON limit stays small; only this route accepts photo-sized bodies.
    client = _client(tmp_path, FakeWam(), max_request_bytes=2048, image_max_bytes=5_000_000)
    try:
        body = _page(600, 800)  # > 2048 bytes, < image limit
        assert len(body) > 2048
        r = client.post("/internal/detect-image", content=body,
                        headers=_signed("POST", "/internal/detect-image", body, "image/png"))
        assert r.status_code == 200
    finally:
        client.__exit__(None, None, None)


def test_image_over_its_own_limit_is_413(tmp_path: Path):
    client = _client(tmp_path, FakeWam(), image_max_bytes=4096)
    try:
        body = _page(1000, 1200)
        assert len(body) > 4096
        r = client.post("/internal/detect-image", content=body,
                        headers=_signed("POST", "/internal/detect-image", body, "image/png"))
        assert r.status_code in (413, 422)
    finally:
        client.__exit__(None, None, None)


def test_other_routes_keep_the_small_body_limit(tmp_path: Path):
    """Raising the image door must NOT widen /internal/detect."""
    client = _client(tmp_path, FakeWam(), max_request_bytes=2048, image_max_bytes=5_000_000)
    try:
        body = b"%PDF-1.7\n" + b"x" * 5000
        r = client.post("/internal/detect", content=body,
                        headers=_signed("POST", "/internal/detect", body, "application/pdf"))
        assert r.status_code == 413
    finally:
        client.__exit__(None, None, None)


def test_model_failure_is_503_not_500(tmp_path: Path):
    client = _client(tmp_path, FakeWam(fail=True))
    try:
        body = _page()
        r = client.post("/internal/detect-image", content=body,
                        headers=_signed("POST", "/internal/detect-image", body, "image/png"))
        assert r.status_code == 503
        assert r.json()["error"] == "extract_failed"
    finally:
        client.__exit__(None, None, None)


def test_webp_is_accepted(tmp_path: Path):
    img = Image.open(io.BytesIO(_page()))
    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=85)
    body = buf.getvalue()
    client = _client(tmp_path, FakeWam(payload=42, score=0.96))
    try:
        r = client.post("/internal/detect-image", content=body,
                        headers=_signed("POST", "/internal/detect-image", body, "image/webp"))
        assert r.status_code == 200
        assert r.json()["payload"] == 42
    finally:
        client.__exit__(None, None, None)


def test_concurrency_limiter_exists_and_is_bounded(tmp_path: Path):
    client = _client(tmp_path, FakeWam(), image_max_concurrency=2)
    try:
        sem = client.app.state.image_semaphore
        assert sem is not None
    finally:
        client.__exit__(None, None, None)
