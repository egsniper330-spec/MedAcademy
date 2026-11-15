"""Separate WAM model-serving process (Option B).

Why a separate process: WAM needs PyTorch and the upstream package. The web-facing service venv does
not install them, so loading WAM inside the FastAPI process fails on the first issuance. This module
runs in the WAM environment only. The API talks to it over loopback HTTP with HMAC-signed requests.

Start (on the VPS and locally, from the service root, with the WAM venv):

    PDF_SVC_WAM_HMAC_KEY=... PDF_SVC_WAM_HOST=127.0.0.1 PDF_SVC_WAM_PORT=8711 \\
    python -m app.wam_runtime

It loads the checkpoint ONCE at startup (SHA-256 verified; see wam_adapter.verify_checkpoint), then
serves requests from memory. It accepts no model paths from requests. Bind it to loopback only, and
supervise it with systemd (Restart=always), with a single worker process. Shutdown is SIGTERM, which
uvicorn handles by finishing in-flight requests.

Endpoints (all HMAC-signed with the same canonical scheme as app/auth.py):
    GET  /healthz              liveness, no model data
    POST /embed                body: JSON {"payload": int, "image_b64": base64 PNG RGB}
                               returns JSON {"image_b64": base64 PNG RGB} with the marked page
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import threading
import time
from pathlib import Path

from fastapi import Request

log = logging.getLogger("wam_runtime")

MAX_BODY_BYTES = 16 * 1024 * 1024  # base64 of one 150-dpi A4 PNG page fits well below this
MAX_IMAGE_SIDE = 4096
MAX_IMAGE_PIXELS = 4096 * 4096
MAX_DECODED_BYTES = MAX_IMAGE_PIXELS * 3


class RuntimeConfigError(RuntimeError):
    pass


def build_app(*, keys: dict[str, bytes], model, nonce_store, skew_seconds: int = 300):
    """Create the FastAPI app around an already-loaded model object.

    `model` must provide embed_image(chw_float32, payload) -> chw_float32. Tests pass a fake model
    here; production passes a WamModel that has been loaded from the approved checkpoint.
    """
    import numpy as np
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse
    from PIL import Image

    from . import auth

    if nonce_store is None:
        raise RuntimeConfigError("a persistent nonce store is required")

    def claim_nonce(key_id: str, nonce: str, ts: int) -> bool:
        return nonce_store.claim(key_id, nonce, ts, skew_seconds * 2, int(time.time()))

    model_lock = threading.Lock()  # one embed at a time on the single CPU model instance

    app = FastAPI(title="WAM model runtime", docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/healthz")
    async def healthz() -> dict:
        return {"status": "ok"}

    @app.post("/embed")
    async def embed(request: Request):
        declared = request.headers.get("content-length")
        if declared is not None and (not declared.isdigit() or int(declared) > MAX_BODY_BYTES):
            return JSONResponse({"error": "payload_too_large"}, status_code=413)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_BODY_BYTES:
                return JSONResponse({"error": "payload_too_large"}, status_code=413)
        body = bytes(body)
        try:
            verified = auth.verify(
                keys=keys, method=request.method, path_with_query=request.url.path,
                key_id=request.headers.get("x-key-id"), timestamp=request.headers.get("x-timestamp"),
                nonce=request.headers.get("x-nonce"), signature=request.headers.get("x-signature"),
                body=body, skew_seconds=skew_seconds,
            )
        except auth.AuthError:
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not claim_nonce(verified.key_id, verified.nonce, verified.timestamp):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        try:
            data = json.loads(body)
            payload = data["payload"]
            if type(payload) is not int or not 0 <= payload < (1 << 32):
                return JSONResponse({"error": "invalid_request"}, status_code=422)
            raw = base64.b64decode(data["image_b64"], validate=True)
            if len(raw) > MAX_BODY_BYTES:
                return JSONResponse({"error": "payload_too_large"}, status_code=413)
            rgb = _decode_png_rgb(raw)
        except _ImageRejected:
            return JSONResponse({"error": "invalid_image"}, status_code=422)
        except Exception:
            return JSONResponse({"error": "invalid_request"}, status_code=422)

        arr = np.asarray(rgb).astype(np.float32) / 255.0
        chw = np.transpose(arr, (2, 0, 1))
        with model_lock:
            try:
                marked = np.asarray(model.embed_image(chw, payload), dtype=np.float32)
            except Exception:
                log.exception("embed failed")
                return JSONResponse({"error": "embed_failed"}, status_code=500)
        out = (np.clip(np.transpose(marked, (1, 2, 0)), 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
        buf = io.BytesIO()
        Image.fromarray(out, mode="RGB").save(buf, format="PNG")
        return {"image_b64": base64.b64encode(buf.getvalue()).decode("ascii")}

    @app.post("/extract")
    async def extract(request: Request):
        """Read the forensic payload from one page image.

        Returns the raw 32-bit payload plus an uncalibrated confidence score. This is EVIDENCE,
        not a verdict: the caller compares the payload to its own issuance records and decides.
        """
        declared = request.headers.get("content-length")
        if declared is not None and (not declared.isdigit() or int(declared) > MAX_BODY_BYTES):
            return JSONResponse({"error": "payload_too_large"}, status_code=413)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_BODY_BYTES:
                return JSONResponse({"error": "payload_too_large"}, status_code=413)
        body = bytes(body)
        try:
            verified = auth.verify(
                keys=keys, method=request.method, path_with_query=request.url.path,
                key_id=request.headers.get("x-key-id"), timestamp=request.headers.get("x-timestamp"),
                nonce=request.headers.get("x-nonce"), signature=request.headers.get("x-signature"),
                body=body, skew_seconds=skew_seconds,
            )
        except auth.AuthError:
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not claim_nonce(verified.key_id, verified.nonce, verified.timestamp):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        try:
            raw = base64.b64decode(json.loads(body)["image_b64"], validate=True)
            if len(raw) > MAX_BODY_BYTES:
                return JSONResponse({"error": "payload_too_large"}, status_code=413)
            rgb = _decode_png_rgb(raw)
        except _ImageRejected:
            return JSONResponse({"error": "invalid_image"}, status_code=422)
        except Exception:
            return JSONResponse({"error": "invalid_request"}, status_code=422)

        arr = np.asarray(rgb).astype(np.float32) / 255.0
        chw = np.transpose(arr, (2, 0, 1))
        with model_lock:
            try:
                payload, score = model.extract_image(chw)
            except Exception:
                log.exception("extract failed")
                return JSONResponse({"error": "extract_failed"}, status_code=500)
        return {"payload": int(payload), "score": float(score)}

    return app


class _ImageRejected(ValueError):
    pass


def _decode_png_rgb(raw: bytes):
    """Accept only PNG, and only within the side and pixel limits. The size is read from the header
    before any pixel decoding, so an oversized image is never decompressed."""
    from PIL import Image

    if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
        raise _ImageRejected("not a PNG")
    try:
        with Image.open(io.BytesIO(raw)) as probe:
            if probe.format != "PNG":
                raise _ImageRejected("not a PNG")
            width, height = probe.size
    except _ImageRejected:
        raise
    except Exception as exc:
        raise _ImageRejected("undecodable image") from exc
    if width < 1 or height < 1 or width > MAX_IMAGE_SIDE or height > MAX_IMAGE_SIDE:
        raise _ImageRejected("image dimensions out of range")
    if width * height > MAX_IMAGE_PIXELS:
        raise _ImageRejected("image pixel count out of range")
    try:
        with Image.open(io.BytesIO(raw)) as img:
            rgb = img.convert("RGB")
    except Exception as exc:
        raise _ImageRejected("undecodable image") from exc
    if rgb.width * rgb.height * 3 > MAX_DECODED_BYTES:
        raise _ImageRejected("decoded size out of range")
    return rgb


class SqliteNonceStore:
    """Persistent replay guard for the WAM runtime. Survives restarts, so a captured request cannot
    be replayed after the WAM process is restarted within the timestamp skew window.

    Uses its own SQLite file under the WAM state directory (never a path from a request).
    Rows older than `window_seconds` are pruned on each claim."""

    def __init__(self, path: Path) -> None:
        import sqlite3

        path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, timeout=5.0, isolation_level=None, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS wam_nonces (key_id TEXT NOT NULL, nonce TEXT NOT NULL, "
            "seen_at INTEGER NOT NULL, PRIMARY KEY (key_id, nonce))"
        )
        self._lock = threading.Lock()

    def claim(self, key_id: str, nonce: str, ts: int, window_seconds: int, now: int) -> bool:
        import sqlite3

        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                self._conn.execute("DELETE FROM wam_nonces WHERE seen_at < ?", (now - window_seconds,))
                try:
                    self._conn.execute(
                        "INSERT INTO wam_nonces (key_id, nonce, seen_at) VALUES (?, ?, ?)", (key_id, nonce, now)
                    )
                except sqlite3.IntegrityError:
                    self._conn.execute("ROLLBACK")
                    return False
                self._conn.execute("COMMIT")
                return True
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise


def main() -> None:
    import uvicorn

    from .config import parse_hmac_keys
    from .wam_adapter import WamModel

    repo = Path(os.environ.get("PDF_SVC_WAM_REPO_DIR", "./wam"))
    checkpoint = Path(os.environ.get("PDF_SVC_WAM_CHECKPOINT", "./wam/checkpoints/wam_mit.pth"))
    params = Path(os.environ.get("PDF_SVC_WAM_PARAMS_JSON", "./wam/checkpoints/params.json"))
    host = os.environ.get("PDF_SVC_WAM_HOST", "127.0.0.1")
    port = int(os.environ.get("PDF_SVC_WAM_PORT", "8711"))
    raw_keys = os.environ.get("PDF_SVC_WAM_HMAC_KEY", "")
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise RuntimeConfigError("the WAM runtime must bind to loopback only")
    if not raw_keys:
        raise RuntimeConfigError("PDF_SVC_WAM_HMAC_KEY is required")
    keys = parse_hmac_keys(raw_keys)

    state_dir = Path(os.environ.get("PDF_SVC_WAM_STATE_DIR", "./wam-state"))
    nonce_store = SqliteNonceStore(state_dir / "nonces.sqlite3")
    model = WamModel(repo, checkpoint, params)
    model.load()  # hash-verified; raises WamError on mismatch, so the process never serves
    log.info("WAM model loaded once; serving on %s:%s", host, port)
    app = build_app(keys=keys, model=model, nonce_store=nonce_store)
    uvicorn.run(app, host=host, port=port, workers=1, log_level="info")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
