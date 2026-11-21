"""Personalised PDF issuance: DB-backed state machine for per-student watermarked copies.

State machine (table `issuances`):

    (none) --claim--> generating --publish ok--> ready --(now >= expires_at)--> expired
                          |                        |
                          |  lease expires /        |  (never reused after expiry)
                          |  worker crash           |
                          v                         v
                       generating (re-claimed)   new issuance (fresh watermark_id)
                          |
                          +--retries exhausted--> failed

- `generating`: one row holds the cache_key while it is being produced. The partial unique index
  on cache_key (status IN ('generating','ready')) makes concurrent identical requests coalesce:
  the losing INSERT finds the winner row and returns it instead of generating again.
- A `generating` row whose lease has expired may be re-claimed by a new worker (crash recovery).
- The personalised PDF is written to a temporary key first, verified (hash, page count, page
  sizes), then atomically moved to the issued key. Only then is the row set to `ready`.
- `ready` rows are returned only while `now < expires_at` AND the stored file verifies.
  Reads never extend `expires_at`.
- Expiry is absolute: `expires_at = ready_at + TTL`. After expiry the row is `expired` (or treated
  as expired at read time) and a new issuance with a fresh opaque watermark_id is created.

All timestamps are UTC unix seconds.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import sqlite3
import time
from dataclasses import dataclass

WATERMARK_ID_PREFIX = "wm_"
PAYLOAD_BITS = 32
MAX_PAYLOAD_ATTEMPTS = 32
_REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")

STATUS_GENERATING = "generating"
STATUS_READY = "ready"
STATUS_FAILED = "failed"
STATUS_EXPIRED = "expired"


class IssuanceError(RuntimeError):
    """Base error; `code` is the stable API error code."""

    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(message or code)
        self.code = code


def check_ref(name: str, value: object) -> str:
    if not isinstance(value, str) or not _REF.match(value):
        raise IssuanceError("invalid_reference", f"invalid {name}")
    return value


def utc_now() -> int:
    return int(time.time())


def new_watermark_id() -> str:
    """Opaque, unguessable identifier for the issuance record. Not an auth credential."""
    return WATERMARK_ID_PREFIX + secrets.token_urlsafe(24)


def new_payload() -> int:
    """Random 32-bit WAM payload. Uniqueness is enforced by the DB, not by randomness."""
    return secrets.randbits(PAYLOAD_BITS)


def cache_key(*, student_ref: str, doctor_ref: str, material_id: str, version_id: str,
              source_course_id: str, source_sha256: str, algorithm_version: str) -> str:
    """Identity of one personalised copy. Any change in these fields yields a different copy."""
    parts = [student_ref, doctor_ref, material_id, version_id, source_course_id,
             source_sha256, algorithm_version]
    return hashlib.sha256("\x1f".join(parts).encode()).hexdigest()


@dataclass(frozen=True)
class Issuance:
    """One row of `issuances`. `id` is the opaque record id; `payload` is the 32-bit WAM value."""

    id: str
    cache_key: str
    payload: int
    status: str
    storage_key: str | None
    file_sha256: str | None
    issued_at: int | None
    expires_at: int | None
    lease_token: str | None
    lease_expires_at: int | None


def _row(row: sqlite3.Row | None) -> Issuance | None:
    if row is None:
        return None
    return Issuance(
        id=row["id"], cache_key=row["cache_key"], payload=row["watermark_id"],
        status=row["status"], storage_key=row["storage_key"], file_sha256=row["file_sha256"],
        issued_at=row["issued_at"], expires_at=row["expires_at"], lease_token=row["lease_token"],
        lease_expires_at=row["lease_expires_at"],
    )


def _event(conn: sqlite3.Connection, issuance_id: str, event: str, now: int) -> None:
    conn.execute(
        "INSERT INTO issuance_events (issuance_id, event, at) VALUES (?, ?, ?)",
        (issuance_id, event, now),
    )


def _live(row: Issuance | None, now: int) -> bool:
    """A ready copy is reusable only before its absolute expiry."""
    return row is not None and row.status == STATUS_READY and row.expires_at is not None and now < row.expires_at


def claim(conn: sqlite3.Connection, *, key: str, identity: dict, lease_seconds: int,
          now: int | None = None) -> tuple[str, Issuance]:
    """Decide what the caller should do for `key` (a cache_key).

    Returns (action, issuance):
      * ("reuse", row)  - a ready, unexpired copy exists; return it. TTL is NOT extended.
      * ("wait", row)   - another worker holds a live lease; caller should poll / retry later.
      * ("generate", row) - this caller now owns a `generating` row with a fresh lease token.

    Runs in one IMMEDIATE transaction so concurrent callers serialise on the write lock. The partial
    unique index on cache_key also guarantees at most one live (generating/ready) row per key.
    """
    now = utc_now() if now is None else now
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = _row(conn.execute(
            "SELECT * FROM issuances WHERE cache_key = ? AND status IN ('generating','ready')", (key,)
        ).fetchone())

        if row is not None and row.status == STATUS_READY:
            if _live(row, now):
                conn.execute("COMMIT")
                return "reuse", row
            # Expired ready copy: retire it so a fresh issuance can take the live slot.
            conn.execute("UPDATE issuances SET status = 'expired', updated_at = ? WHERE id = ?", (now, row.id))
            _event(conn, row.id, "expired", now)
            row = None

        if row is not None and row.status == STATUS_GENERATING:
            if row.lease_expires_at is not None and now < row.lease_expires_at:
                conn.execute("COMMIT")
                return "wait", row
            # Lease expired: the previous worker crashed. Take over the same record.
            token = secrets.token_hex(16)
            conn.execute(
                "UPDATE issuances SET lease_token = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?",
                (token, now + lease_seconds, now, row.id),
            )
            _event(conn, row.id, "lease_reclaimed", now)
            conn.execute("COMMIT")
            return "generate", _row(conn.execute("SELECT * FROM issuances WHERE id = ?", (row.id,)).fetchone())

        # No live row: create a new issuance with a fresh opaque id and a unique 32-bit payload.
        issuance_id = new_watermark_id()
        token = secrets.token_hex(16)
        payload = _allocate_payload(conn)
        conn.execute(
            """INSERT INTO issuances (id, watermark_id, cache_key, student_ref, doctor_ref, material_id,
               version_id, course_ref, source_sha256, master_fingerprint, algorithm, config_version,
               status, lease_token, lease_expires_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, 'generating', ?, ?, ?, ?)""",
            (issuance_id, payload, key, identity["student_ref"], identity["doctor_ref"],
             identity["material_id"], identity["version_id"], identity["course_ref"],
             identity["source_sha256"], identity["algorithm"], identity["config_version"],
             token, now + lease_seconds, now, now),
        )
        _event(conn, issuance_id, "generating", now)
        conn.execute("COMMIT")
        return "generate", _row(conn.execute("SELECT * FROM issuances WHERE id = ?", (issuance_id,)).fetchone())
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def temp_key_for(issuance_id: str, token: str) -> str:
    return f"tmp/issuance/{issuance_id}-{token}.pdf"


def issued_key_for(issuance_id: str, token: str) -> str:
    return f"issued/{issuance_id}-{token}.pdf"


def renew_lease(conn: sqlite3.Connection, *, issuance_id: str, token: str, lease_seconds: int,
                now: int | None = None) -> bool:
    """Extend the lease of a generation this worker still owns. Returns False if ownership was lost."""
    now = utc_now() if now is None else now
    cur = conn.execute(
        "UPDATE issuances SET lease_expires_at = ?, updated_at = ? "
        "WHERE id = ? AND status = 'generating' AND lease_token = ?",
        (now + lease_seconds, now, issuance_id, token),
    )
    return cur.rowcount == 1


def mark_ready(conn: sqlite3.Connection, *, issuance_id: str, token: str, storage_key: str,
               file_sha256: str, ttl_seconds: int, meta: dict, now: int | None = None) -> bool:
    """Register a verified, already-published file. Called only after integrity checks passed.

    Guarded by the lease token, so a worker whose lease was reclaimed cannot overwrite the result.
    """
    now = utc_now() if now is None else now
    conn.execute("BEGIN IMMEDIATE")
    try:
        cur = conn.execute(
            """UPDATE issuances SET status = 'ready', storage_key = ?, file_sha256 = ?, issued_at = ?,
               expires_at = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?,
               master_fingerprint = ?, algorithm = ?, config_version = ?
               WHERE id = ? AND status = 'generating' AND lease_token = ?""",
            (storage_key, file_sha256, now, now + ttl_seconds, now,
             meta["master_fingerprint"], meta["algorithm"], meta["config_version"], issuance_id, token),
        )
        if cur.rowcount != 1:
            conn.execute("ROLLBACK")
            return False
        _event(conn, issuance_id, "ready", now)
        conn.execute("COMMIT")
        return True
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def mark_failed(conn: sqlite3.Connection, *, issuance_id: str, token: str, error: str,
                now: int | None = None) -> bool:
    now = utc_now() if now is None else now
    cur = conn.execute(
        "UPDATE issuances SET status = 'failed', lease_token = NULL, lease_expires_at = NULL, "
        "updated_at = ? WHERE id = ? AND status = 'generating' AND lease_token = ?",
        (now, issuance_id, token),
    )
    if cur.rowcount == 1:
        _event(conn, issuance_id, f"failed:{error[:64]}", now)
        return True
    return False


def verify_pdf(data: bytes, expected_pages: list[tuple[int, int]]) -> None:
    """Check a produced PDF: parses, page count matches, each page size matches the master page.

    `expected_pages` is a list of (width_px, height_px) from the master manifest, in order. PDF page
    size is compared in points derived from the same DPI, so the check uses the page's aspect and
    count rather than raw pixels.
    """
    import pypdfium2 as pdfium

    try:
        doc = pdfium.PdfDocument(data)
    except Exception as exc:
        raise IssuanceError("corrupt_output", f"output is not a readable PDF: {type(exc).__name__}") from exc
    try:
        if len(doc) != len(expected_pages):
            raise IssuanceError("corrupt_output", "page count mismatch")
        for index, (w_px, h_px) in enumerate(expected_pages):
            page = doc[index]
            try:
                width, height = page.get_size()
            finally:
                page.close()
            if width <= 0 or height <= 0:
                raise IssuanceError("corrupt_output", f"page {index + 1} has no size")
            # Aspect ratio must match the master page within a small tolerance.
            if abs((width / height) - (w_px / h_px)) > 0.01:
                raise IssuanceError("corrupt_output", f"page {index + 1} dimensions differ")
    finally:
        doc.close()


def build_personalised_pdf(*, storage, manifest: dict, model, payload: int, source_dpi: int,
                           profile=None) -> bytes:
    """Embed `payload` in every master page and rebuild a PDF whose page order and sizes match.

    Pages are read from the master assets only (never the original PDF). Output is assembled in
    memory and returned; the caller writes it to a temp key before publishing.

    `source_dpi` is the DPI the master rasters were rendered at; the emitted page size in POINTS is
    derived from the encoded pixel size and the DPI actually used, so a profile that caps the
    resolution keeps the page's physical size while carrying fewer pixels.

    `profile` is a pdf_optimize.CompressionProfile. The DEFAULT (balanced) embeds a baseline JPEG
    instead of a lossless PNG: that single change removes the 6–7 MB page-image bloat (see
    docs/PDF_COMPRESSION.md for the measurements and for the WAM round-trip proof required before
    trusting a profile). The `lossless` profile reproduces the previous PNG output exactly.
    """
    import io

    import numpy as np
    import pypdfium2 as pdfium
    from PIL import Image

    from .pdf_optimize import encode_page, resolve_profile

    profile = profile or resolve_profile(None)
    out = pdfium.PdfDocument.new()
    try:
        for page_meta in manifest["pages"]:
            png = storage.get_bytes(page_meta["key"])
            with Image.open(io.BytesIO(png)) as src:
                rgb = src.convert("RGB")
            # A near-uniform page carries no ink to mark and no text to read: emit a
            # blank page instead of a ~400 KB raster of white. The page still exists
            # (count, order and size are unchanged) and detection skips it exactly as
            # it skips any other unreadable page.
            if _is_blank(rgb):
                width_pt = rgb.width * 72.0 / source_dpi
                height_pt = rgb.height * 72.0 / source_dpi
                blank = out.new_page(width_pt, height_pt)
                blank.gen_content()
                rgb.close()
                continue
            arr = np.asarray(rgb).astype(np.float32) / 255.0
            chw = np.transpose(arr, (2, 0, 1))
            marked = np.asarray(model.embed_image(chw, payload), dtype=np.float32)
            out_arr = (np.clip(np.transpose(marked, (1, 2, 0)), 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
            image = Image.fromarray(out_arr, mode="RGB")
            try:
                data, width_px, height_px, dpi = encode_page(image, profile, source_dpi)
            finally:
                image.close()
                rgb.close()
            page_w_pt = width_px * 72.0 / dpi
            page_h_pt = height_px * 72.0 / dpi
            new_page = out.new_page(page_w_pt, page_h_pt)
            if profile.lossless:
                # Previous behaviour, byte-for-byte: Flate-encoded RGB raster.
                with Image.open(io.BytesIO(data)) as pil:
                    bitmap = pdfium.PdfBitmap.from_pil(pil.convert("RGB"))
                try:
                    img_obj = pdfium.PdfImage.new(out)
                    img_obj.set_bitmap(bitmap)
                finally:
                    bitmap.close()
            else:
                # /DCTDecode image straight from the JPEG bytes. `inline=True`
                # copies the stream into the document, so the buffer may be dropped
                # immediately (otherwise PDFium would keep the file open and the save
                # below would fail on Windows).
                img_obj = pdfium.PdfImage.new(out)
                img_obj.load_jpeg(io.BytesIO(data), inline=True)
            img_obj.set_matrix(pdfium.PdfMatrix(page_w_pt, 0, 0, page_h_pt, 0, 0))
            new_page.insert_obj(img_obj)
            new_page.gen_content()
        buf = io.BytesIO()
        out.save(buf)
        return buf.getvalue()
    finally:
        out.close()


ALGORITHM = "wam_mit"
# Encoding version. It is part of the issuance cache key, so changing the way a
# page raster is embedded cannot silently reuse a copy produced by another
# encoder: a 24h-old PNG copy and a new JPEG copy are different artifacts with
# different forensic properties.
CONFIG_VERSION_PREFIX = "wam-mit-v1/pypdfium2"
CONFIG_VERSION = CONFIG_VERSION_PREFIX + "-jpeg-v2:balanced"  # legacy default, kept for imports


def _is_blank(rgb, threshold: float = 2.0) -> bool:
    """True when a page is essentially uniform (blank sheet / full-bleed colour).

    Uses the standard deviation of the luminance channel: text, rules and images all
    raise it well above 2, while a blank page sits near 0. Erring towards "not
    blank" is deliberate — a page wrongly treated as blank would lose its mark.
    """
    import numpy as np

    gray = np.asarray(rgb.convert("L"), dtype=np.float32)
    # Near-WHITE and uniform only. A solid dark/coloured page is left as a raster: it
    # is content the reader sees, and skipping it would be an assumption about a
    # document we know nothing about.
    return float(gray.std()) < threshold and float(gray.mean()) > 250.0


def config_version_for(profile) -> str:
    """Stable config id for one compression profile (part of the cache key)."""
    return f"{CONFIG_VERSION_PREFIX}-jpeg-v2:{profile.name}"


def issue(*, conn: sqlite3.Connection, storage, model, manifest: dict, identity: dict,
          ttl_seconds: int, lease_seconds: int, now: int | None = None,
          profile=None) -> dict:
    """Return a ready personalised copy for `identity`, generating it if necessary.

    `identity` holds: student_ref, doctor_ref, material_id, version_id, course_ref, source_sha256.
    `manifest` is the validated master manifest for (material_id, version_id).

    Returns {"watermark_id", "status": "ready", "reused": bool, "expires_at", "file_sha256"}
    or raises IssuanceError (code 'in_progress' when another worker holds a live lease).
    """
    from .pdf_optimize import resolve_profile

    profile = profile or resolve_profile(None)
    config_version = config_version_for(profile)
    key = cache_key(student_ref=identity["student_ref"], doctor_ref=identity["doctor_ref"],
                    material_id=identity["material_id"], version_id=identity["version_id"],
                    source_course_id=identity["course_ref"], source_sha256=identity["source_sha256"],
                    algorithm_version=f"{ALGORITHM}:{config_version}")
    full_identity = dict(identity, algorithm=ALGORITHM, config_version=config_version,
                         master_fingerprint=manifest["source_sha256"][:24])
    action, row = claim(conn, key=key, identity=full_identity, lease_seconds=lease_seconds, now=now)
    ts = utc_now() if now is None else now

    if action == "reuse":
        if not _stored_file_ok(storage, row):
            # Ready row whose file is missing or corrupt: retire it and do not serve it.
            _retire_broken(conn, row, ts)
            raise IssuanceError("retry", "stored copy failed verification; retry the request")
        return _result(row, reused=True, page_count=len(manifest["pages"]))
    if action == "wait":
        raise IssuanceError("in_progress", "an identical issuance is being generated")

    # action == 'generate': this worker owns the lease for row.id.
    token = row.lease_token
    try:
        # Heartbeat: a slow but live generation must not be taken over by another worker.
        if not renew_lease(conn, issuance_id=row.id, token=token, lease_seconds=lease_seconds, now=ts):
            raise IssuanceError("lease_lost", "generation lease was lost before rendering")
        # No DB lock is held during rendering, WAM embedding or PDF reconstruction.
        data = build_personalised_pdf(storage=storage, manifest=manifest, model=model,
                                      payload=row.payload, source_dpi=manifest["settings"]["dpi"],
                                      profile=profile)
        verify_pdf(data, [(p["width"], p["height"]) for p in manifest["pages"]])
        file_sha = hashlib.sha256(data).hexdigest()
        # Per-attempt keys: a stale worker can only ever touch its own files, never a newer result.
        temp_key = temp_key_for(row.id, token)
        issued_key = issued_key_for(row.id, token)
        storage.put_bytes(temp_key, data)
        try:
            # Verify the staged bytes before publication.
            if hashlib.sha256(storage.get_bytes(temp_key)).hexdigest() != file_sha:
                raise IssuanceError("corrupt_output", "staged file hash mismatch")
            storage.rename(temp_key, issued_key)
        finally:
            if storage.exists(temp_key):
                storage.delete(temp_key)
        ok = mark_ready(conn, issuance_id=row.id, token=token, storage_key=issued_key,
                        file_sha256=file_sha, ttl_seconds=ttl_seconds, meta=full_identity, now=ts)
        if not ok:
            # Lease was reclaimed while we worked. Remove only our own file; the newer owner's result stays.
            storage.delete(issued_key)
            raise IssuanceError("lease_lost", "generation lease was lost before registration")
    except BaseException as exc:
        code = exc.code if isinstance(exc, IssuanceError) else "generation_failed"
        mark_failed(conn, issuance_id=row.id, token=token, error=code, now=ts)
        if isinstance(exc, IssuanceError):
            raise
        raise IssuanceError("generation_failed", type(exc).__name__) from exc

    fresh = _row(conn.execute("SELECT * FROM issuances WHERE id = ?", (row.id,)).fetchone())
    return _result(fresh, reused=False, page_count=len(manifest["pages"]))


def _stored_file_ok(storage, row: Issuance) -> bool:
    """True only if the published file exists and its SHA-256 matches the registered hash."""
    if row.storage_key is None or row.file_sha256 is None:
        return False
    try:
        if not storage.exists(row.storage_key):
            return False
        return hashlib.sha256(storage.get_bytes(row.storage_key)).hexdigest() == row.file_sha256
    except Exception:
        return False


def _retire_broken(conn: sqlite3.Connection, row: Issuance, now: int) -> None:
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("UPDATE issuances SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'ready'",
                     (now, row.id))
        _event(conn, row.id, "failed:stored_file_invalid", now)
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def _result(row: Issuance, *, reused: bool, page_count: int = 0) -> dict:
    return {
        "id": row.id,
        "page_count": page_count,
        # Opaque 32-bit forensic value. It carries no personal data by itself; the caller
        # stores it next to the issuance record so a later detection can name the student.
        "payload": row.payload,
        "status": row.status,
        "reused": reused,
        "expires_at": row.expires_at,
        "storage_key": row.storage_key,
        "file_sha256": row.file_sha256,
    }


def _payload_taken(conn: sqlite3.Connection, candidate: int) -> bool:
    """True if ANY retained issuance row (any status) already holds `candidate`."""
    return conn.execute(
        "SELECT 1 FROM issuances WHERE watermark_id = ? LIMIT 1", (candidate,)
    ).fetchone() is not None


def _allocate_payload(conn: sqlite3.Connection) -> int:
    """Pick a 32-bit payload that no retained issuance row (any status) uses.

    Must run inside the caller's BEGIN IMMEDIATE transaction. The check covers expired and failed
    rows too, and the unique index `uq_issuance_payload_all` is the final guard: a violation raises
    IntegrityError and is never silently reused. When every attempt collides, the caller gets
    `payload_exhausted`, a loud failure. Old rows are never deleted to free a payload.
    """
    for _ in range(MAX_PAYLOAD_ATTEMPTS):
        candidate = new_payload()
        if not _payload_taken(conn, candidate):
            return candidate
    raise IssuanceError("payload_exhausted", "could not allocate a unique payload")
