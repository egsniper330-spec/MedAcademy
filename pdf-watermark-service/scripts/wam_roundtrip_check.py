"""Small synthetic WAM round-trip check through the production adapter (app/wam_adapter.py).

Loads the approved checkpoint once, embeds one 32-bit payload into a synthetic 256x256 image,
extracts it again, and reports checkpoint verification, load time and bit accuracy.
Runs on CPU. Not a benchmark. Run it in the WAM virtualenv, not the service venv.

Usage: python scripts/wam_roundtrip_check.py <repo_dir> <checkpoint> <params_json>
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.wam_adapter import WamModel, sha256_file, WAM_MIT_SHA256  # noqa: E402


def main() -> int:
    repo, ckpt, params = (Path(a) for a in sys.argv[1:4])
    digest = sha256_file(ckpt)
    print(f"checkpoint sha256 matches approved value: {digest == WAM_MIT_SHA256}")

    model = WamModel(repo, ckpt, params)
    t0 = time.perf_counter()
    model.load()
    print(f"loaded once in {time.perf_counter() - t0:.2f}s device=cpu threads={torch.get_num_threads()}")

    rng = np.random.default_rng(0)
    base = rng.random((3, 256, 256)).astype(np.float32) * 0.6 + 0.2
    img = torch.tensor(base, dtype=torch.float32)

    payload = 0xA5C3F00D
    wm = model.embed_image(img, payload)
    got, margin = model.extract_image(wm)
    psnr = 10 * torch.log10(1 / ((wm - img) ** 2).mean()).item()
    print(f"payload sent=0x{payload:08X} recovered=0x{got:08X} exact={got == payload}")
    print(f"output shape={tuple(wm.shape)} range=[{float(wm.min()):.3f},{float(wm.max()):.3f}] psnr={psnr:.2f}dB")

    control, _ = model.extract_image(img)
    print(f"unwatermarked control matches payload: {control == payload}")
    return 0 if got == payload else 1


if __name__ == "__main__":
    raise SystemExit(main())
