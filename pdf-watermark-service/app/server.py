"""Uvicorn entrypoint: python -m app.server

Startup refuses to run unless configuration passes load_settings() (strong HMAC secrets,
storage and state outside web-served directories). The app factory is only called after
those checks, so no route is served with weak config.

Run behind a firewall that allows only the PHP server. Bind to 127.0.0.1 unless a reverse
proxy on the same host needs to reach it.
"""

from __future__ import annotations

import os
import sys

import uvicorn

from .config import load_settings
from .main import create_app


def build_app():
    try:
        settings = load_settings()
    except Exception as exc:  # pydantic ValidationError or ValueError
        sys.stderr.write(f"pdf-watermark: refusing to start: invalid configuration: {exc}\n")
        raise SystemExit(2) from exc
    return create_app(settings)


def _tls_kwargs() -> dict:
    """Optional TLS for the internal endpoint.

    Only used when PHP runs on a DIFFERENT host: the service then listens on a private,
    firewall-restricted port with this certificate, and PHP pins the issuing CA (never
    disables verification). With both variables unset the service speaks plain HTTP on
    loopback, which is the default and the only correct mode for same-host calls.
    """
    cert = os.environ.get("PDF_SVC_TLS_CERT", "").strip()
    key = os.environ.get("PDF_SVC_TLS_KEY", "").strip()
    if not cert and not key:
        return {}
    if not cert or not key:
        sys.stderr.write("pdf-watermark: refusing to start: PDF_SVC_TLS_CERT and PDF_SVC_TLS_KEY must be set together\n")
        raise SystemExit(2)
    for label, path in (("PDF_SVC_TLS_CERT", cert), ("PDF_SVC_TLS_KEY", key)):
        if not os.path.isfile(path):
            sys.stderr.write(f"pdf-watermark: refusing to start: {label} not readable\n")
            raise SystemExit(2)
    return {"ssl_certfile": cert, "ssl_keyfile": key}


def main() -> None:
    host = os.environ.get("PDF_SVC_BIND_HOST", "127.0.0.1")
    port = int(os.environ.get("PDF_SVC_BIND_PORT", "8787"))
    uvicorn.run(build_app(), host=host, port=port, proxy_headers=False, server_header=False,
                **_tls_kwargs())


if __name__ == "__main__":
    main()
