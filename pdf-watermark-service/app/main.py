"""FastAPI application for the PDF watermark processing service.

Only /internal/* routes are for PHP. They require HMAC authentication with replay protection.
/healthz is unauthenticated and returns no internal data. Deploy behind a firewall that allows
only the PHP server's IP. Do not expose this service to students or doctors.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

import hashlib
import json

from . import auth
from .pdf_optimize import resolve_profile
from .config import Settings, load_settings
from .db import StateDB, open_connection
from .issuance import _HEX64, IssuanceError, check_ref, issue
from .nonce_store import NonceStore
from .master_manifest import read_master_manifest
from .preprocess import (
    PREPROCESS_KIND,
    RENDERER,
    PreprocessError,
    fingerprint,
    handle_preprocess_job,
    master_prefix,
    pdf_renderer_version,
)
from . import image_forensics
from .image_forensics import ImageRejected
from .wam_client import WamRuntimeClient
from .storage import LocalPrivateStorage, StorageKeyError, validate_key
from .worker import WorkerPool

log = logging.getLogger("pdf_watermark")

_POLL_SECONDS = 0.25
_RETRY_AFTER_SECONDS = 5

# ── Forensic page scanning thresholds ────────────────────────────────────────
# Identical to the verdict thresholds below: a page can only END the scan when it
# alone would already be enough to call the result `confirmed`.
EARLY_EXIT_SCORE = 0.90
CONFIRM_AGREEMENT = 0.75
CONFIRM_SCORE = 0.90
PROBABLE_AGREEMENT = 0.50
PROBABLE_SCORE = 0.75


def scan_pages(total: int, render_page, extract, early_score: float = EARLY_EXIT_SCORE) -> dict:
    """Read pages 1, 2, 3 … in order and stop as soon as identification is COMPLETE.

    A scan stops early only when every page read so far agrees on the same payload and
    that payload's confidence already clears the `confirmed` score bar. That is what
    "complete and valid" means for this detector: the watermark carries no per-field
    data that could arrive partially — the payload IS the identification — so the only
    thing further pages can add is CORROBORATION, and beyond the confirm threshold it
    would not change the verdict.

    Deliberately conservative:
      • every READABLE page must agree on the payload — one page reading a different
        value, or two different strong payloads, keeps the scan going;
      • a page that yields nothing readable is a page we simply could not read (blank,
        vector-only, image too degraded): it does not vote and cannot block completion,
        which is what lets a suspect copy whose first pages are unreadable still be
        identified on the first page that CAN be read;
      • low-confidence reads keep the scan going to the end of the document;
      • pages after the exiting page are never rendered, decoded or kept.

    Verdicts are computed over READABLE pages (`readable`), while `agreement` keeps its
    original documented meaning — the share of all analysed pages voting for the winner —
    so diagnostics recorded before and after this change stay comparable.

    The function is pure orchestration — it never touches PDF internals — so the page
    accounting can be tested without the model or a real document.
    """
    votes: dict[int, int] = {}
    scores: dict[int, float] = {}
    analysed = 0
    readable = 0
    best: int | None = None

    for index in range(total):
        payload, score = extract(render_page(index))
        analysed += 1
        if payload is not None:
            readable += 1
            votes[payload] = votes.get(payload, 0) + 1
            scores[payload] = max(scores.get(payload, 0.0), float(score))
        if not votes:
            continue
        candidate = max(votes, key=lambda p: (votes[p], scores.get(p, 0.0)))
        # Complete = every READABLE page so far votes the same payload.
        # Valid = that payload alone clears the confirm score.
        if votes[candidate] == readable and scores.get(candidate, 0.0) >= early_score:
            best = candidate
            break

    stopped_early = best is not None and analysed < total
    if best is None and votes:  # scan finished without an early exit
        best = max(votes, key=lambda p: (votes[p], scores.get(p, 0.0)))

    agreement = votes[best] / analysed if (best is not None and analysed) else 0.0
    readable_agreement = votes[best] / readable if (best is not None and readable) else 0.0
    score = scores.get(best, 0.0) if best is not None else 0.0
    if best is not None and readable_agreement >= CONFIRM_AGREEMENT and score >= CONFIRM_SCORE:
        verdict = "confirmed"
    elif best is not None and readable_agreement >= PROBABLE_AGREEMENT and score >= PROBABLE_SCORE:
        verdict = "probable"
    elif readable_agreement < PROBABLE_AGREEMENT and readable > 1:
        verdict = "ambiguous"
    else:
        verdict = "no_mark"

    return {
        "verdict": verdict,
        "payload": best if verdict != "no_mark" else None,
        "score": round(score, 4),
        "agreement": round(agreement, 4),
        "pages_analyzed": analysed,
        "pages_readable": readable,
        "pages_total": total,
        "payload_votes": len(votes),
        "stopped_early": stopped_early,
    }



def _wam_client(settings: Settings) -> WamRuntimeClient:
    """Client for the separate WAM model process (app/wam_runtime.py). This process never loads torch.

    The model is loaded once inside that process, which verifies the approved checkpoint's SHA-256.
    Requests never supply a model path.
    """
    key_id, _, secret = settings.wam_hmac_key.partition(":")
    if not key_id or not secret:
        raise RuntimeError("PDF_SVC_WAM_HMAC_KEY must be set as id:secret")
    return WamRuntimeClient(settings.wam_runtime_url, key_id, secret.encode("utf-8"))


def create_app(settings: Settings | None = None, handlers: dict | None = None) -> FastAPI:
    settings = settings or load_settings()
    keys = settings.hmac_key_map()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        db = StateDB(settings.state_db_path)
        storage = LocalPrivateStorage(settings.storage_root)
        nonces = NonceStore(db.conn, db.lock)
        default_handlers = {
            PREPROCESS_KIND: handle_preprocess_job(
                storage, dpi=settings.master_render_dpi, max_pages=settings.master_max_pages),
        }
        pool = WorkerPool(
            db,
            handlers if handlers is not None else default_handlers,
            worker_count=settings.worker_count,
            lease_seconds=settings.job_lease_seconds,
            retry_delay_seconds=settings.job_retry_delay_seconds,
        )
        app.state.db = db
        app.state.storage = storage
        app.state.nonces = nonces
        app.state.settings = settings
        # Built on first issuance, so the service still starts (and serves preprocess jobs) without
        # the WAM runtime configured.
        wam_cache: dict[str, WamRuntimeClient] = {}

        def _get_wam() -> WamRuntimeClient:
            if "client" not in wam_cache:
                wam_cache["client"] = _wam_client(settings)
            return wam_cache["client"]

        app.state.wam_model = _get_wam
        # Bounded image verification concurrency (see Settings.image_max_concurrency).
        app.state.image_semaphore = asyncio.Semaphore(settings.image_max_concurrency)
        pool.start()
        app.state.pool = pool
        try:
            yield
        finally:
            pool.stop()
            db.close()

    app = FastAPI(
        title="MedAcademy PDF Watermark Service",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )

    @app.middleware("http")
    async def limit_body_and_security_headers(request: Request, call_next):
        # The image endpoint has its own (larger) limit: a phone photo is bigger than
        # any JSON request this service otherwise accepts. Every other route keeps the
        # small limit, so raising one door does not widen the others.
        limit = (max(settings.max_request_bytes, settings.image_max_bytes)
                 if request.url.path == "/internal/detect-image"
                 else settings.max_request_bytes)
        length = request.headers.get("content-length")
        if length is not None and length.isdigit() and int(length) > limit:
            return JSONResponse({"error": "payload_too_large"}, status_code=413)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get("/healthz")
    async def healthz() -> dict:
        return {"status": "ok"}

    @app.get("/readyz")
    async def readyz():
        """Issuance readiness. Reports whether the WAM runtime answers its liveness probe. Returns no
        model or internal data. The API stays live (/healthz) when WAM is down."""
        try:
            wam_ok = await run_in_threadpool(app.state.wam_model().health)
        except RuntimeError:  # WAM client not configured: report unavailable, never a 500
            wam_ok = False
        body = {"status": "ready" if wam_ok else "degraded",
                "issuance": "available" if wam_ok else "unavailable"}
        return JSONResponse(body, status_code=200 if wam_ok else 503)

    async def require_hmac(request: Request, max_bytes: int | None = None) -> bytes:
        """Verify HMAC and nonce for an internal request. Returns the raw body on success."""
        limit = settings.max_request_bytes if max_bytes is None else max_bytes
        buf = bytearray()
        async for chunk in request.stream():
            buf.extend(chunk)
            if len(buf) > limit:
                raise _Reject(413, "payload_too_large")
        body = bytes(buf)
        path_with_query = request.url.path
        if request.url.query:
            path_with_query += "?" + request.url.query
        try:
            verified = auth.verify(
                keys=keys,
                method=request.method,
                path_with_query=path_with_query,
                key_id=request.headers.get("x-key-id"),
                timestamp=request.headers.get("x-timestamp"),
                nonce=request.headers.get("x-nonce"),
                signature=request.headers.get("x-signature"),
                body=body,
                skew_seconds=settings.clock_skew_seconds,
            )
        except auth.AuthError as exc:
            log.warning("internal auth rejected: %s", exc)
            raise _Reject(401, "unauthorized") from exc
        now = int(time.time())
        if not app.state.nonces.claim(verified.key_id, verified.nonce, verified.timestamp,
                                      settings.clock_skew_seconds * 2, now):
            log.warning("internal auth rejected: replayed nonce")
            raise _Reject(401, "unauthorized")
        return body


    @app.exception_handler(_Reject)
    async def _reject_handler(_request: Request, exc: "_Reject"):
        return JSONResponse({"error": exc.code}, status_code=exc.status)

    @app.post("/internal/detect")
    async def detect(request: Request) -> dict:
        """Read the forensic payload from a suspect PDF.

        The body is the PDF itself. Pages are rendered at the master DPI and each page is read
        independently; the answer is the payload most pages agree on. The service returns EVIDENCE
        (payload + agreement + score), never an identity: mapping a payload to a student happens in
        the caller, against its own issuance records, with its own permission checks.

        Verdict thresholds are calibrated against the measured separation on this deployment
        (issued copies read 0.99+, an unwatermarked control 0.51): agreement is the share of
        analysed pages that voted for the winning payload.
        """
        body = await require_hmac(request)
        if not body.startswith(b"%PDF-"):
            raise _Reject(422, "not_a_pdf")

        def _analyze() -> dict:
            import numpy as np
            import pypdfium2 as pdfium

            try:
                doc = pdfium.PdfDocument(body)
            except Exception as exc:
                raise _Reject(422, "unsupported") from exc

            def render_page(index: int):
                page = doc[index]
                try:
                    bitmap = page.render(scale=settings.master_render_dpi / 72.0, rev_byteorder=False)
                    pil = bitmap.to_pil().convert("RGB")
                finally:
                    # The bitmap is copied into a float32 array below and the page is
                    # released immediately: memory stays at ONE page, not one per page.
                    page.close()
                arr = np.asarray(pil).astype(np.float32) / 255.0
                return np.transpose(arr, (2, 0, 1))

            try:
                total = len(doc)
                if total == 0:
                    raise _Reject(422, "unsupported")
                model = app.state.wam_model()
                return scan_pages(total, render_page, model.extract_image)
            finally:
                doc.close()

        return await run_in_threadpool(_analyze)

    @app.post("/internal/detect-image")
    async def detect_image(request: Request) -> dict:
        """Read the forensic payload from ONE uploaded IMAGE (screenshot, crop, photo).

        Body: the image bytes (JPEG, PNG or WebP; the signature is checked, not a header).
        Auth: the same internal HMAC + nonce scheme as every other /internal route.

        Difference from /internal/detect: there is no PDF container and no page loop. The
        image is analysed at several bounded regions (`candidate_regions`), the SAME WAM
        model decodes each one, and the answer is the payload the regions agree on. The
        service returns EVIDENCE (payload + score + agreement + quality + how many regions
        were readable), never an identity and never an accession number.

        Distinctions the caller must preserve:
          • verdict `no_mark`             — regions were readable, none was a mark;
          • verdict `insufficient_quality`— the upload could not carry evidence (too small,
                                            blurry, blank). This is NOT "unwatermarked";
          • a payload that matches no issuance in the caller's scope — the caller's
                                            business, never decided here.

        The upload is never written to storage: `verify_image_bytes()` works on an in-memory
        buffer, so nothing suspicious is retained and there is no temporary file to clean up.
        """
        body = await require_hmac(request, max_bytes=settings.image_max_bytes)
        try:
            image_forensics.sniff_format(body)
        except ImageRejected as exc:
            raise _Reject(422, exc.code) from exc
        if len(body) > settings.image_max_bytes:
            raise _Reject(413, "payload_too_large")

        def _analyze() -> dict:
            model = app.state.wam_model()
            return image_forensics.verify_image_bytes(
                body,
                model.extract_image,
                max_candidates=settings.image_max_candidates,
                confirm_score=settings.image_confirm_score,
                probable_score=settings.image_probable_score,
                single_strong_score=settings.image_single_strong_score,
            )

        try:
            async with app.state.image_semaphore:
                result = await run_in_threadpool(_analyze)
        except ImageRejected as exc:
            raise _Reject(422, exc.code) from exc
        except Exception as exc:  # model/runtime failure: never a 500 with internals
            log.warning("image verification failed: %s", type(exc).__name__)
            raise _Reject(503, "extract_failed") from exc
        # Diagnostics only: bytes, verdict, timing. Never the image, never an identity.
        log.info("detect-image bytes=%s verdict=%s candidates=%s readable=%s",
                 len(body), result.get("verdict"), result.get("candidates_total"),
                 result.get("candidates_readable"))
        return result

    @app.get("/internal/queue/stats")
    async def queue_stats(request: Request) -> dict:
        await require_hmac(request)
        return {"jobs": app.state.db.queue_depth(), "workers": settings.worker_count}

    @app.post("/internal/sources")
    async def upload_source(request: Request) -> dict:
        """Store one immutable original PDF for later preprocessing.

        The key must live under `originals/` and end in the SHA-256 of the body, so a caller cannot
        register bytes under a hash they did not send. The original is never served to a client and
        never expires; only personalized copies have a 24h lifecycle.
        """
        body = await require_hmac(request)
        key = request.query_params.get("key") or ""
        try:
            validate_key(key)
        except StorageKeyError as exc:
            raise _Reject(422, "invalid_request") from exc
        parts = key.split("/")
        if parts[0] != "originals" or len(parts) != 4 or not parts[3].endswith(".pdf"):
            raise _Reject(422, "invalid_request")
        digest = hashlib.sha256(body).hexdigest()
        if parts[3] != f"{digest}.pdf":
            raise _Reject(422, "hash_mismatch")
        if not body.startswith(b"%PDF-"):
            raise _Reject(422, "not_a_pdf")
        try:
            app.state.storage.put_bytes(key, body)
        except (StorageKeyError, OSError) as exc:
            raise _Reject(500, "storage_write_failed") from exc
        return {"key": key, "size": len(body), "sha256": digest}

    @app.get("/internal/files")
    async def download_file(request: Request) -> Response:
        """Stream one personalized PDF back to PHP. Only the `issued/` prefix is addressable."""
        await require_hmac(request)
        key = request.query_params.get("key") or ""
        try:
            validate_key(key)
        except StorageKeyError as exc:
            raise _Reject(422, "invalid_request") from exc
        if key.split("/")[0] != "issued":
            raise _Reject(422, "invalid_request")
        try:
            data = app.state.storage.get_bytes(key)
        except (FileNotFoundError, StorageKeyError, OSError) as exc:
            raise _Reject(404, "not_found") from exc
        return Response(
            content=data,
            media_type="application/pdf",
            headers={"X-File-Sha256": hashlib.sha256(data).hexdigest(),
                     "Cache-Control": "no-store",
                     "Content-Disposition": "attachment"},
        )

    @app.post("/internal/masters/preprocess", status_code=202)
    async def enqueue_preprocess(request: Request) -> dict:
        body = await require_hmac(request)
        try:
            data = json.loads(body)
            material_id = str(data["material_id"])
            version_id = str(data["version_id"])
            source_key = str(data["source_key"])
            validate_key(source_key)
            master_prefix(material_id, version_id)  # validates the id segments
        except (ValueError, KeyError, TypeError, StorageKeyError, PreprocessError) as exc:
            raise _Reject(422, "invalid_request") from exc
        payload = json.dumps({"material_id": material_id, "version_id": version_id, "source_key": source_key},
                             sort_keys=True, separators=(",", ":"))
        # Key on the source bytes and render settings too. The same version with a changed source
        # or DPI must not return an old completed job; the output directory is keyed the same way.
        try:
            source_sha = hashlib.sha256(app.state.storage.get_bytes(source_key)).hexdigest()
        except (FileNotFoundError, StorageKeyError) as exc:
            raise _Reject(422, "source_not_found") from exc
        settings_view = {"dpi": settings.master_render_dpi, "renderer": RENDERER,
                         "renderer_version": pdf_renderer_version()}
        fp = fingerprint(source_sha, settings_view)
        job_id, created = app.state.db.enqueue(
            kind=PREPROCESS_KIND,
            idempotency_key=f"preprocess:{material_id}:{version_id}:{fp}",
            payload=payload,
            max_attempts=settings.job_max_attempts,
        )
        return {"job_id": job_id, "created": created}

    @app.post("/internal/issuances")
    async def create_issuance(request: Request) -> dict:
        body = await require_hmac(request)
        try:
            data = json.loads(body)
            identity = {
                "student_ref": check_ref("student_ref", data["student_ref"]),
                "doctor_ref": check_ref("doctor_ref", data["doctor_ref"]),
                "material_id": check_ref("material_id", data["material_id"]),
                "version_id": check_ref("version_id", data["version_id"]),
                "course_ref": check_ref("course_ref", data["course_ref"]),
                "source_sha256": str(data["source_sha256"]),
            }
            if not _HEX64.match(identity["source_sha256"]):
                raise ValueError("source_sha256")
        except (ValueError, KeyError, TypeError, IssuanceError) as exc:
            raise _Reject(422, "invalid_request") from exc
        settings_view = {"dpi": settings.master_render_dpi, "renderer": RENDERER,
                         "renderer_version": pdf_renderer_version()}
        manifest = read_master_manifest(app.state.storage, identity["material_id"], identity["version_id"],
                                        identity["source_sha256"], settings_view)
        if manifest is None:
            raise _Reject(422, "master_not_ready")
        # Identical requests: wait a bounded time for the generation already in progress. issue()
        # raises in_progress without starting a second generation, so polling here never duplicates
        # work. If still generating at the deadline, return 202 pending; the client retries the same
        # request. The 24h expiry is set only at publication, so waiting does not extend it.
        deadline = time.monotonic() + settings.issuance_wait_seconds
        while True:
            try:
                return await run_in_threadpool(_issue_with_db, app, identity, manifest)
            except IssuanceError as exc:
                if exc.code != "in_progress":
                    status = {"generation_failed": 500, "lease_lost": 409}.get(exc.code, 500)
                    raise _Reject(status, exc.code) from exc
                if time.monotonic() >= deadline or await request.is_disconnected():
                    if await request.is_disconnected():
                        raise _Reject(499, "client_closed") from exc
                    return JSONResponse(
                        {"status": "pending", "retry_after_seconds": _RETRY_AFTER_SECONDS},
                        status_code=202, headers={"Retry-After": str(_RETRY_AFTER_SECONDS)})
                await asyncio.sleep(_POLL_SECONDS)

    def _issue_with_db(app_: FastAPI, identity: dict, manifest: dict) -> dict:
        # Each generation gets its own SQLite connection. The DB is only locked inside short
        # BEGIN IMMEDIATE transactions (claim, renew, publish), not while the model runs.
        conn = open_connection(settings.state_db_path)
        try:
            return issue(
                conn=conn, storage=app_.state.storage, model=app_.state.wam_model(),
                manifest=manifest, identity=identity, ttl_seconds=settings.issuance_ttl_seconds,
                lease_seconds=settings.issuance_lease_seconds,
                profile=resolve_profile(settings.pdf_compression_profile),
            )
        finally:
            conn.close()

    return app


class _Reject(Exception):
    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code

