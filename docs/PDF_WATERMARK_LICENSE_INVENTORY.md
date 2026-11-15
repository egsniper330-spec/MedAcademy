# PDF Watermarking – Licence Inventory

Status legend: **Verified** = checked against the official source in this document's review. **Unverified** = must be checked against the exact pinned version before the component is used in production.

| Component | Role | Licence (code) | Licence (model weights / data) | Source | Status |
|---|---|---|---|---|---|
| adobe/trustmark (Python package `trustmark`) | Invisible image watermark encode/decode | MIT (Copyright 2023 Adobe) | Stated as MIT in the repository README (`python/README.md`, "The MIT license covers both the code in this repo and the model files which are downloaded upon first use") and in the Adobe FAQ. Weights are not in the repository and are downloaded on first use. | https://github.com/adobe/trustmark (README, License section); https://github.com/adobe/trustmark/blob/main/python/README.md ; https://opensource.contentauthenticity.org/docs/trustmark/faq | Code and weight terms verified as MIT from Adobe's own repository README and FAQ. **Open point:** the pinned source file `python/trustmark/trustmark.py` contains the notice "Adobe permits you to use, modify, and distribute this file in accordance with the terms of the Adobe license agreement accompanying it." The agreement it refers to was not found. Resolve this with Adobe or legal before shipping. The model download host (`cai-watermark.adobe.net`) returned HTTP 403 to the checker, so its page could not be read. |
| TrustMark model checkpoints (`trustmark_C/Q/B/P.*`, `trustmark_rm_*`, `trustmark_bbox_*`) | Model weights | **BLOCKED: not conclusively verified** (Adobe states MIT; the pinned source carries an unresolved "Adobe license agreement" notice) | Downloaded from `https://cai-watermark.adobe.net/watermarking/trustmark-models/`. Each file's MD5 is in `python/trustmark/trustmark.py` (pinned commit `010a8f3bf885eec6f2aaa418380afc41d68bb3e5`). The code loads them with `check_and_download`, which checks the MD5. | https://github.com/adobe/trustmark/blob/010a8f3bf885eec6f2aaa418380afc41d68bb3e5/python/trustmark/trustmark.py | **Phase B decision: do not integrate or distribute these weights.** Adobe's README/FAQ say MIT covers the model files, but the repo LICENSE (checked) says "NOTICE: Adobe permits you to use, modify, and distribute this file in accordance with the terms of the license agreement accompanying it" and that agreement was not found. The model host returned HTTP 403 and the Hugging Face page returned HTTP 401, so no written, conclusive grant for the weights was obtained. Blocker: obtain written confirmation from Adobe. Until then TrustMark stays behind a disabled feature flag. |
| pdfium-helper (existing, in repo) | PDF rendering in current PHP pipeline | BSD-3-Clause (per prior project notes) | n/a | `pdfium-helper/` | Unverified in this review; confirm the vendored PDFium build licence. |
| OpenCV (opencv-python-headless) | Image processing | Apache-2.0 | n/a | https://opencv.org/license/ | Unverified for the pinned version |
| pypdfium2 | PDF rendering (Python binding of PDFium) | Apache-2.0 / BSD-3-Clause (binding); PDFium is BSD-style | 5.1.0 (pinned) | https://github.com/pypdfium2-team/pypdfium2 | Verified from upstream. 5.15.2 is yanked on PyPI (Nov 9, 2026), so 5.1.0 is pinned. |
| pikepdf | PDF manipulation (wraps QPDF) | MPL-2.0 | n/a | https://github.com/pikepdf/pikepdf | Unverified for the pinned version |
| pypdf | PDF operations | BSD-3-Clause | n/a | https://github.com/py-pdf/pypdf | Unverified for the pinned version |
| Pillow | Image I/O | MIT-CMU (HPND) | 12.0.0 (pinned) | https://github.com/python-pillow/Pillow | Verified from upstream LICENSE and pip metadata |
| NumPy | Arrays | BSD-3-Clause | n/a | https://github.com/numpy/numpy | Unverified for the pinned version |
| FastAPI | HTTP service | MIT | n/a | https://github.com/fastapi/fastapi | Unverified for the pinned version |
| PyTorch | Runs TrustMark models | BSD-style | n/a | https://github.com/pytorch/pytorch | Unverified for the pinned version |
| Watermark Anything, `wam_mit.pth` checkpoint (evaluated alternative, not integrated) | Invisible, localised image watermark | MIT for code and the SA-1B-trained `wam_mit.pth` checkpoint; the COCO-trained `wam_coco.pth` is CC-BY-NC | Not integrated. Would need a Python/PyTorch runtime and GPU/CPU inference cost; no benchmarks run. | https://github.com/facebookresearch/watermark-anything (README "License"/"Weights"; LICENSE, LICENSE-COCO) | Only `wam_mit.pth` is permissive. Never use `wam_coco.pth`. Not evaluated for robustness against this project's requirements. |

## Excluded

- **PyMuPDF (fitz)**: AGPL / commercial dual licence. Not used.
- **Any AGPL component**: not permitted without legal review.

## Notes

- No commercial API or paid SDK is used.
- Each component's exact version, hash and licence file must be recorded when it is pinned in the service's lock file.
- Do not assume that model weights share the code's licence. Record the weight licence separately for each checkpoint.
