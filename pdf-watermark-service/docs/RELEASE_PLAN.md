# Release candidate work plan (working notes)

Scope: finish the issuance service RC. No Detection Engine, no PHP/MedAcademy changes, no VPS deploy, no commit.

Status legend: DONE, TODO, VERIFY-LOCAL (Windows), PENDING-VPS (Linux/VPS only).

1. Preserve existing implementation: DONE (inspected; no rewrite planned).
2. A. Issuance lifecycle: mostly present in `app/issuance.py` (claim, lease, per-attempt keys, verify, publish, mark_ready). TODO: confirm cache key covers student, doctor, material, version, source course, algorithm and config version (present: `cache_key` plus `ALGORITHM`/`CONFIG_VERSION`).
3. B. WAM runtime: present (`wam_runtime.py`, `wam_client.py`, `wam_adapter.verify_checkpoint`). TODO: confirm checkpoint hash check happens before load; confirm no path override from requests.
4. C. 24 h lifecycle: present. TODO: UTC audit of every stored timestamp.
5. D. Concurrency: present (short transactions, leases). No code gap identified in review so far.
6. E. PDF quality: GAP. Current `build_personalised_pdf` rebuilds from raster PNG images, so the text layer is lost. Vector-overlay evaluation (scratch only) showed:
   - a full-page image overlay that is opaque hides the text;
   - a 50 % alpha composite of the mark was not tested for extraction across the real model;
   Decision pending: see section E-decision.
7. Security hardening: review pending.
8. Deployment package: TODO (requirements per runtime, env templates, install script, migration procedure, backup/rollback doc).
9. Linux readiness: `scripts/linux_verify.sh` exists (PENDING-VPS). TODO: add real WAM round-trip and storage checks to the VPS checklist.
10. Testing: full suite run once at the end. Real-WAM smoke in WAM venv if practical.

## E-decision (RESOLVED)
Real-WAM test (scratch, WAM venv, synthetic 256x256 page):
- direct mark image: payload recovered exactly (True);
- mark composited with alpha = |delta| over the clean page (overlay path): payload NOT recovered (False).
Conclusion: a text-preserving overlay breaks WAM extraction with the approved checkpoint. Option (b) is rejected.
Shipped behaviour: raster-only rebuild (option a) with the text-layer loss documented as a known limitation.
Option (c) rejected. Do not claim text-preserving output.

## E-decision (original options)
Options considered:
- (a) Keep raster-only and document it: safe, but loses the lecture text layer.
- (b) Vector overlay with a separately stored mark image on each page: needs proof that extraction still works after the composite and that the text stays selectable.
- (c) Recreate the original vector content with the mark embedded in the image XObject: rejected; it requires rewriting source content.

Chosen direction is to be decided after testing (b) with the real WAM model on a synthetic page. If (b) fails extraction, ship (a) with an explicit limitation.
