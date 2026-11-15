"""Live end-to-end check against a RUNNING app.server (uvicorn) process.

Usage (server must already be running with the same PDF_SVC_* env):
    python scripts/e2e_preprocess.py --base http://127.0.0.1:8787 --storage <root> --db <state.db>

It signs real HTTP requests, submits a preprocessing job, waits for the worker pool to reach a
terminal state, then checks the database row, every page file, its SHA-256 and the manifest.
Secrets are read from PDF_SVC_HMAC_KEYS and never printed.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import secrets
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import auth  # noqa: E402


def make_pdf(pages: int) -> bytes:
    imgs = []
    for i in range(pages):
        img = Image.new("RGB", (612, 792), (255, 255, 255))
        ImageDraw.Draw(img).text((72, 72), f"Test page {i + 1}", fill=(0, 0, 0))
        imgs.append(img)
    buf = io.BytesIO()
    imgs[0].save(buf, format="PDF", save_all=True, append_images=imgs[1:], resolution=72.0)
    return buf.getvalue()


def signed_post(base: str, key_id: str, secret: bytes, path: str, body: bytes) -> tuple[int, dict]:
    ts = str(int(time.time()))
    nonce = secrets.token_hex(12)
    sig = auth.sign(secret, "POST", path, ts, nonce, body)
    req = urllib.request.Request(base + path, data=body, method="POST", headers={
        "Content-Type": "application/json", "X-Key-Id": key_id, "X-Timestamp": ts,
        "X-Nonce": nonce, "X-Signature": sig})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8787")
    ap.add_argument("--storage", required=True)
    ap.add_argument("--db", required=True)
    ap.add_argument("--pages", type=int, default=3)
    ap.add_argument("--material", default="e2e-mat")
    ap.add_argument("--version", default="v1")
    ap.add_argument("--timeout", type=int, default=60)
    args = ap.parse_args()

    raw = os.environ["PDF_SVC_HMAC_KEYS"]
    key_id, secret_str = raw.split(",")[0].split(":", 1)
    secret = secret_str.encode()

    storage = Path(args.storage)
    source_key = f"originals/{args.material}/{args.version}.pdf"
    pdf = make_pdf(args.pages)
    (storage / "originals" / args.material).mkdir(parents=True, exist_ok=True)
    (storage / source_key).write_bytes(pdf)
    source_sha = hashlib.sha256(pdf).hexdigest()

    body = json.dumps({"material_id": args.material, "version_id": args.version,
                       "source_key": source_key}).encode()
    status, resp = signed_post(args.base, key_id, secret, "/internal/masters/preprocess", body)
    print(f"POST preprocess -> {status} {json.dumps(resp)}")
    if status != 202:
        return 1
    job_id = resp["job_id"]

    deadline = time.time() + args.timeout
    row = None
    while time.time() < deadline:
        con = sqlite3.connect(args.db)
        con.row_factory = sqlite3.Row
        row = con.execute("SELECT state, attempts, result, last_error FROM jobs WHERE id=?", (job_id,)).fetchone()
        con.close()
        if row and row["state"] in ("succeeded", "failed"):
            break
        time.sleep(0.25)
    if row is None:
        print("job row not found")
        return 1
    print(f"job {job_id} terminal state={row['state']} attempts={row['attempts']} error={row['last_error']}")
    if row["state"] != "succeeded":
        return 1

    result = json.loads(row["result"])
    manifest_key = result["manifest_key"]
    manifest = json.loads((storage / manifest_key).read_bytes())
    print(f"manifest {manifest_key} page_count={manifest['page_count']} source_sha256 match="
          f"{manifest['source_sha256'] == source_sha}")
    ok = manifest["source_sha256"] == source_sha and manifest["page_count"] == args.pages
    for page in manifest["pages"]:
        data = (storage / page["key"]).read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        img = Image.open(io.BytesIO(data))
        page_ok = digest == page["sha256"] and img.format == "PNG" and img.size == (page["width"], page["height"])
        ok = ok and page_ok
        print(f"  page {page['index']:>3} {page['key']} bytes={len(data)} sha_ok={digest == page['sha256']} "
              f"png={img.format} size={img.size} ok={page_ok}")
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
