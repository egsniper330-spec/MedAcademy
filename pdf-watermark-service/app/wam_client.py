"""Client for the separate WAM model process (app/wam_runtime.py).

The API process imports this module only; it never imports torch. It exposes `embed_image` with the
same signature as WamModel, so build_personalised_pdf() works unchanged.
"""

from __future__ import annotations

import base64
import io
import json
import secrets
import time
import urllib.error
import urllib.request

import numpy as np
from PIL import Image

from . import auth

_TIMEOUT_SECONDS = 120
_HEALTH_TIMEOUT_SECONDS = 3


class WamRuntimeError(RuntimeError):
    pass


class WamRuntimeClient:
    def __init__(self, base_url: str, key_id: str, secret: bytes) -> None:
        if not base_url.startswith(("http://127.0.0.1", "http://localhost")):
            raise WamRuntimeError("WAM runtime URL must be loopback")
        self.base_url = base_url.rstrip("/")
        self.key_id = key_id
        self.secret = secret

    def _post(self, path: str, body: bytes) -> bytes:
        timestamp = str(int(time.time()))
        nonce = secrets.token_urlsafe(24)
        signature = auth.sign(self.secret, "POST", path, timestamp, nonce, body)
        req = urllib.request.Request(
            self.base_url + path, data=body, method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Key-Id": self.key_id,
                "X-Timestamp": timestamp,
                "X-Nonce": nonce,
                "X-Signature": signature,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            raise WamRuntimeError(f"WAM runtime returned HTTP {exc.code}") from exc
        except OSError as exc:
            raise WamRuntimeError(f"WAM runtime unreachable: {type(exc).__name__}") from exc

    def health(self) -> bool:
        """Probe the WAM runtime's unauthenticated liveness endpoint. Never raises; returns False when
        the runtime is down, slow or answers with an error. The model state is not exposed."""
        try:
            with urllib.request.urlopen(self.base_url + "/healthz", timeout=_HEALTH_TIMEOUT_SECONDS) as resp:
                return resp.status == 200 and json.loads(resp.read()).get("status") == "ok"
        except (OSError, ValueError, urllib.error.URLError):
            return False

    def embed_image(self, image_chw, payload: int) -> np.ndarray:
        """Embed a 32-bit payload in a (3, H, W) float array in [0, 1]. Returns (3, H, W) float32."""
        arr = np.asarray(image_chw, dtype=np.float32)
        rgb = (np.clip(np.transpose(arr, (1, 2, 0)), 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
        buf = io.BytesIO()
        Image.fromarray(rgb, mode="RGB").save(buf, format="PNG")
        body = json.dumps({"payload": int(payload),
                           "image_b64": base64.b64encode(buf.getvalue()).decode("ascii")},
                          separators=(",", ":")).encode("utf-8")
        reply = json.loads(self._post("/embed", body))
        marked = Image.open(io.BytesIO(base64.b64decode(reply["image_b64"]))).convert("RGB")
        out = np.asarray(marked).astype(np.float32) / 255.0
        return np.transpose(out, (2, 0, 1))

    def extract_image(self, image_chw) -> tuple[int, float]:
        """Read (payload, score) from a (3, H, W) float array. The score is uncalibrated."""
        arr = np.asarray(image_chw, dtype=np.float32)
        rgb = (np.clip(np.transpose(arr, (1, 2, 0)), 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
        buf = io.BytesIO()
        Image.fromarray(rgb, mode="RGB").save(buf, format="PNG")
        body = json.dumps({"image_b64": base64.b64encode(buf.getvalue()).decode("ascii")},
                          separators=(",", ":")).encode("utf-8")
        reply = json.loads(self._post("/extract", body))
        return int(reply["payload"]), float(reply["score"])
