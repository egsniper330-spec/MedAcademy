"""Internal WAM (Watermark Anything) adapter. CPU only.

Only the MIT checkpoint `wam_mit.pth` is accepted, and only at a path configured by the operator.
The file is hash-checked against a pinned SHA-256 before it is loaded. Users never supply a
checkpoint or a model path. The `wam_coco.pth` weights are CC BY-NC and are refused by name and hash.

Upstream: https://github.com/facebookresearch/watermark-anything (archived, MIT code licence).
The repo's loader calls torch.load(..., weights_only=False). This adapter loads the file as a
state dict only after the hash check; see docs/PDF_WATERMARK_SECURITY_REVIEW.md for the residual risk.
"""

from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path

import numpy as np

WAM_MIT_SHA256 = "90ef232384e023bd63245eb0c131abd69d2afc7b8f17a71ccedceb542bf009e2"
WAM_MIT_FILENAME = "wam_mit.pth"
WAM_UPSTREAM_COMMIT = "2c08af04d037d5667c02f6ddebbda9ff04581c3e"
MESSAGE_BITS = 32


class WamError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_checkpoint(path: Path) -> None:
    """Raise WamError unless the file is exactly the approved MIT checkpoint."""
    if path.name != WAM_MIT_FILENAME:
        raise WamError("only the approved wam_mit.pth checkpoint is accepted")
    if not path.is_file():
        raise WamError("WAM checkpoint is missing")
    if sha256_file(path) != WAM_MIT_SHA256:
        raise WamError("WAM checkpoint SHA-256 does not match the approved value")


def int_to_bits(value: int) -> list[int]:
    if not 0 <= value < (1 << MESSAGE_BITS):
        raise WamError("payload must fit in 32 bits")
    return [(value >> i) & 1 for i in range(MESSAGE_BITS)]


def bits_to_int(bits: list[int]) -> int:
    if len(bits) != MESSAGE_BITS:
        raise WamError("expected 32 bits")
    return sum((int(b) & 1) << i for i, b in enumerate(bits))


class WamModel:
    """Loads WAM once per process. Import of torch and the upstream package is deferred to load()."""

    def __init__(self, repo_dir: Path, checkpoint: Path, params_json: Path) -> None:
        self.repo_dir = repo_dir
        self.checkpoint = checkpoint
        self.params_json = params_json
        self._model = None
        self._torch = None

    def load(self) -> None:
        verify_checkpoint(self.checkpoint)
        if not self.params_json.is_file():
            raise WamError("WAM params.json is missing")
        loader_dir = self.repo_dir / "notebooks"
        if not (loader_dir / "inference_utils.py").is_file():
            raise WamError("WAM source tree is missing")
        # Upstream params.json references configs relatively, so the loader runs from the repo root.
        previous_cwd = os.getcwd()
        sys.path.insert(0, str(loader_dir))
        sys.path.insert(0, str(self.repo_dir))
        try:
            import torch  # type: ignore
            import inference_utils  # type: ignore
            os.chdir(self.repo_dir)
            torch.set_num_threads(1)
            model = inference_utils.load_model_from_checkpoint(
                str(self.params_json.resolve()), str(self.checkpoint.resolve()))
        except WamError:
            raise
        except Exception as exc:  # pragma: no cover - depends on the VPS environment
            raise WamError(f"WAM load failed: {type(exc).__name__}") from exc
        finally:
            os.chdir(previous_cwd)
            for entry in (str(loader_dir), str(self.repo_dir)):
                if entry in sys.path:
                    sys.path.remove(entry)
        model.eval()
        self._torch = torch
        self._model = model

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def embed_image(self, image_chw: "object", payload: int) -> "object":
        """Embed a 32-bit payload into a float tensor in [0, 1], shape (3, H, W). Returns (3, H, W) in [0, 1]."""
        if self._model is None:
            raise WamError("WAM model is not loaded")
        torch = self._torch
        if not torch.is_tensor(image_chw):
            image_chw = torch.from_numpy(image_chw)
        bits = torch.tensor([int_to_bits(payload)], dtype=torch.float32)
        with torch.no_grad():
            out = self._model.embed(image_chw.unsqueeze(0), bits)
        return out["imgs_w"].clamp(0, 1)[0]

    def extract_image(self, image_chw: "object") -> tuple[int, float]:
        """Return (payload, bit_accuracy_proxy). Bits are the per-channel mean of the detector logits.

        The accuracy proxy is the fraction of bits whose sign is positive; it is a raw score, not a
        calibrated probability. Calibration happens in the detection step, not here.
        """
        if self._model is None:
            raise WamError("WAM model is not loaded")
        torch = self._torch
        # Accept a numpy array exactly like embed_image() does: the runtime client has no torch.
        if not torch.is_tensor(image_chw):
            image_chw = torch.from_numpy(np.asarray(image_chw, dtype=np.float32))
        with torch.no_grad():
            preds = self._model.detect(image_chw.unsqueeze(0).clamp(0, 1))["preds"]
        logits = preds[:, 1:, :, :].mean(dim=(2, 3))[0]
        bits = [1 if float(v) > 0 else 0 for v in logits]
        margin = float(torch.sigmoid(logits.abs()).mean())
        return bits_to_int(bits), margin
