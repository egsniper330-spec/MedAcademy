"""Private storage abstraction with separated prefixes.

Prefixes (each its own class, so lifecycle and retention can differ):
    originals/   immutable source PDFs (never expire)
    masters/     preprocessed master page assets, no student data (never expire per 24h policy)
    tmp/         temporary processing files (swept aggressively)
    issued/      personalized student PDFs (24h retention, enforced by the application)
    forensic/    uploaded suspect PDFs for detection (separate retention)

Keys are relative, validated, and never accept absolute paths, '..', backslashes or NUL bytes.
Writes are atomic (temp file + os.replace), so readers never see a partial object.
"""

from __future__ import annotations

import os
import re
import secrets
import time
from pathlib import Path

PREFIXES = ("originals", "masters", "tmp", "issued", "forensic")
_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class StorageKeyError(ValueError):
    pass


def validate_key(key: str) -> tuple[str, ...]:
    """Validate a relative storage key and return its segments."""
    if not key or "\\" in key or "\x00" in key or key.startswith("/"):
        raise StorageKeyError("invalid storage key")
    parts = tuple(key.split("/"))
    if parts[0] not in PREFIXES:
        raise StorageKeyError("storage key must start with a known prefix")
    for seg in parts:
        if seg in ("", ".", "..") or not _SEGMENT.match(seg):
            raise StorageKeyError("invalid storage key segment")
    return parts


class LocalPrivateStorage:
    """Filesystem-backed storage. The root must be outside any public web directory."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        for prefix in PREFIXES:
            (self.root / prefix).mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        parts = validate_key(key)
        path = self.root.joinpath(*parts).resolve()
        if self.root not in path.parents:
            raise StorageKeyError("storage key escapes root")
        return path

    def put_bytes(self, key: str, data: bytes) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{secrets.token_hex(8)}.part")
        with open(tmp, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        # os.replace can fail on Windows while another thread holds the target open; retry briefly.
        for attempt in range(20):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if attempt == 19:
                    tmp.unlink(missing_ok=True)
                    raise
                time.sleep(0.02 * (attempt + 1))

    def rename(self, src: str, dst: str) -> None:
        """Atomically move `src` to `dst` within the store (same filesystem). Used to publish a verified
        temp file so the final key never holds partial bytes."""
        src_path = self._path(src)
        dst_path = self._path(dst)
        dst_path.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(20):
            try:
                os.replace(src_path, dst_path)
                return
            except PermissionError:
                if attempt == 19:
                    raise
                time.sleep(0.02 * (attempt + 1))

    def get_bytes(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    def mtime(self, key: str) -> float:
        return self._path(key).stat().st_mtime

    def size(self, key: str) -> int:
        return self._path(key).stat().st_size

    def delete(self, key: str) -> bool:
        """Idempotent delete. Returns True if a file was removed, False if it was already absent."""
        path = self._path(key)
        try:
            path.unlink()
            return True
        except FileNotFoundError:
            return False
