"""Read and validate the master manifest that issuance is built from.

The manifest is located from the caller's (material_id, version_id) only, never from a path. It is
accepted only when its own fields match that identity, its page entries are well formed, and every
page key is inside the masters/ prefix for this version.
"""

from __future__ import annotations

import json

from .preprocess import MANIFEST_SCHEMA, master_prefix
from .storage import LocalPrivateStorage, StorageKeyError


def read_master_manifest(storage: LocalPrivateStorage, material_id: str, version_id: str,
                         source_sha256: str, settings: dict) -> dict | None:
    """Return the validated manifest for (version, source bytes, render settings), or None.

    Masters live in `<version prefix>/<fingerprint>/manifest.json`, where the fingerprint is derived
    from the source hash and render settings (see preprocess.output_prefix). The caller's source hash
    and settings select exactly one directory; a missing or mismatched manifest yields None.
    """
    from .preprocess import output_prefix

    prefix = output_prefix(material_id, version_id, source_sha256, settings)
    key = f"{prefix}/manifest.json"
    try:
        if not storage.exists(key):
            return None
        manifest = json.loads(storage.get_bytes(key))
    except (ValueError, StorageKeyError, FileNotFoundError):
        return None
    return validate_manifest(manifest, prefix=prefix, material_id=material_id, version_id=version_id,
                             storage=storage)


def validate_manifest(manifest: object, *, prefix: str, material_id: str, version_id: str,
                      storage: LocalPrivateStorage) -> dict | None:
    if not isinstance(manifest, dict):
        return None
    if manifest.get("schema") != MANIFEST_SCHEMA:
        return None
    if manifest.get("material_id") != material_id or manifest.get("version_id") != version_id:
        return None
    source_sha = manifest.get("source_sha256")
    if not isinstance(source_sha, str) or len(source_sha) != 64:
        return None
    pages = manifest.get("pages")
    if not isinstance(pages, list) or not pages or manifest.get("page_count") != len(pages):
        return None
    for index, page in enumerate(pages, start=1):
        if not isinstance(page, dict) or page.get("index") != index:
            return None
        key = page.get("key")
        if not isinstance(key, str) or not key.startswith(prefix + "/"):
            return None
        if not isinstance(page.get("width"), int) or not isinstance(page.get("height"), int):
            return None
        if page["width"] <= 0 or page["height"] <= 0:
            return None
        try:
            if not storage.exists(key):
                return None
        except StorageKeyError:
            return None
    return manifest
