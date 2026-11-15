"""HMAC-SHA256 request authentication for server-to-server calls from PHP.

Canonical string (newline separated):
    METHOD
    PATH (including query string, exactly as sent)
    TIMESTAMP (unix seconds, integer)
    NONCE (random, unique per request, 16-128 url-safe chars)
    SHA256_HEX(body)

Headers: X-Key-Id, X-Timestamp, X-Nonce, X-Signature (hex HMAC-SHA256 of the canonical string).
Requests outside the clock-skew window are rejected. A nonce is accepted once within the
window (replay protection) using the nonce store.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import time
from dataclasses import dataclass

NONCE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{16,128}$")


class AuthError(Exception):
    """Raised when a request fails authentication. The message is safe to log, never the secret."""


def body_sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def canonical_string(method: str, path_with_query: str, timestamp: str, nonce: str, body: bytes) -> str:
    return "\n".join([method.upper(), path_with_query, timestamp, nonce, body_sha256(body)])


def sign(secret: bytes, method: str, path_with_query: str, timestamp: str, nonce: str, body: bytes) -> str:
    message = canonical_string(method, path_with_query, timestamp, nonce, body).encode("utf-8")
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


@dataclass(frozen=True)
class VerifiedRequest:
    key_id: str
    nonce: str
    timestamp: int


def verify(
    *,
    keys: dict[str, bytes],
    method: str,
    path_with_query: str,
    key_id: str | None,
    timestamp: str | None,
    nonce: str | None,
    signature: str | None,
    body: bytes,
    skew_seconds: int,
    now: float | None = None,
) -> VerifiedRequest:
    """Check the signature and timestamp. Does not check the nonce store (the caller does that)."""
    if not key_id or not timestamp or not nonce or not signature:
        raise AuthError("missing authentication headers")
    secret = keys.get(key_id)
    if secret is None:
        raise AuthError("unknown key id")
    if not timestamp.isdigit():
        raise AuthError("invalid timestamp")
    if not NONCE_PATTERN.match(nonce):
        raise AuthError("invalid nonce")
    ts = int(timestamp)
    current = int(now if now is not None else time.time())
    if abs(current - ts) > skew_seconds:
        raise AuthError("timestamp outside allowed window")
    expected = sign(secret, method, path_with_query, timestamp, nonce, body)
    if not hmac.compare_digest(expected, signature.strip().lower()):
        raise AuthError("signature mismatch")
    return VerifiedRequest(key_id=key_id, nonce=nonce, timestamp=ts)
