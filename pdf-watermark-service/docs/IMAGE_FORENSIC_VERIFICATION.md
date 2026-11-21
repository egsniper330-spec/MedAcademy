# Image-only forensic verification

A doctor can now verify a leaked page from a **picture of it** — a screenshot, a
crop, a WhatsApp-compressed image, or a photograph of a printed page — with no
PDF upload, no page set, and no student identifier. The payload inside the page
pixels is the only input, exactly as in the PDF workflow.

## What was added (and what was not)

| Component | Change |
|---|---|
| `app/image_forensics.py` (new) | Format sniffing, EXIF orientation, quality gates, bounded candidate regions, agreement rule, four outcome states. Pure and injectable. |
| `app/main.py` → `POST /internal/detect-image` | New internal endpoint: same HMAC + nonce auth, its own body limit, a concurrency semaphore, in-memory processing. |
| `app/config.py` | `image_max_bytes`, `image_max_candidates`, `image_max_concurrency`, three score thresholds. |
| `backend/.../PdfForensicClient.php` | `detectImageFile()` — signed, streamed from disk, `Content-Type: image/jpeg|png|webp`. |
| `backend/.../PdfForensicController.php` | `checkImage()` — staff-only, rate-limited, audited, signature-validated, unlinks the upload, reuses `findIssuance()`. |
| `backend/routes/api.php` | `POST /pdf-forensic/check-image`, same `role` guard as `/pdf-forensic/check`. |
| `portal/src/pages/PdfChecker.tsx` | PDF / image mode switch, image picker, quality + confidence display. |

**Not changed:** the WAM checkpoint and its pinned SHA-256, the 32-bit payload
format, the watermark embedding path, the payload → issuance mapping, the 24h
retention/caching, the PDF workflow, and every existing authorization rule.

## Supported inputs

| Input | Accepted | Notes |
|---|---|---|
| Screenshot of a full page | yes | PNG or JPEG; best case |
| Screenshot of part of a page | yes | analysed as overlapping regions |
| Crop containing partial content | yes | down to ~55% of the page in one dimension |
| Photograph of a printed page | yes | perspective/lighting are handled only by the region search, not by a geometric rectification (see boundaries) |
| WhatsApp/Telegram recompressed image | yes | JPEG q≈50 is inside the format envelope |
| Resized image | yes | minimum 320 px side and 102 400 px² |
| WebP | yes | decoded by Pillow, re-encoded to PNG for the model |
| PDF | **no** (by design) | use the existing PDF endpoint |

## Pipeline

```
upload ─► signature sniff (JPEG/PNG/WebP)      ─► reject 422 invalid_image
       ─► header dimension check (≤4096/side)  ─► reject 422 image_too_large
       ─► decode + EXIF orient + flatten alpha on white
       ─► quality gate (resolution, blur, contrast) ─► insufficient_quality
       ─► candidate regions (≤7): full, centre 85%, centre 70%, 4 corner 55%
       ─► WAM extract per region (bounded by a semaphore, 2 concurrent)
       ─► agreement rule ─► confirmed | probable | ambiguous | no_mark
```

**Why regions instead of one pass:** a crop or an angled photo may cut the page
anywhere. The model reads whatever region it is given, so the same upload is
decoded at several scales. The scan stops early when the full frame reads the
payload at ≥ `image_single_strong_score` (0.97) — that reading is then reported as
`probable`, never `confirmed`, because one region is not corroboration.

**Why `confirmed` needs agreement:** an unmarked page still produces *a* payload
guess (measured ≈0.51 on the PDF path); the payload always exists, only its
reliability varies. Two or more regions agreeing at ≥0.90 is the bar.

## Outcomes (must stay distinct)

| State | Meaning | Identity resolved? |
|---|---|---|
| `identified` | mark recovered and an issuance in the caller's scope matches | yes |
| `unmatched_payload` | a mark was read but no record matches it (includes corrupted/foreign tokens) | **no** — never |
| `no_mark` | image was readable, no region carried a recoverable mark | no |
| `insufficient_quality` | image could not carry evidence (low_resolution / blurry / low_contrast) | no |

`insufficient_quality` is **not** "unwatermarked". A detector outage is a fifth,
separate case: `ModelUnavailable` → HTTP 503, so an infrastructure failure can
never be shown to a doctor as a clean verdict.

## Limits (VPS: 4 vCPU, 3.8 GB, no GPU)

| Limit | Value | Why |
|---|---|---|
| Upload bytes | 12 MiB | phone photo, not a PDF |
| Decoded side / pixels | 4096 / 16.7 MP | decompression-bomb guard, read from the header before decoding |
| Candidate regions | 7 | 7 model passes worst case (~1–2 s each on CPU) |
| Concurrent verifications | 2 | the WAM runtime serves one extract at a time |
| Processing time | bounded by the above | no unbounded loops, no retries |
| Disk | **zero** | the upload is processed in memory and never written |

## Security

* Type by file signature, never by filename or `Content-Type`.
* Staff-only (`doctor`/`admin`/`super_admin`), the same material scoping as the PDF path.
* Rate limited per account (30/min) and per IP (60/min).
* Audit events: `pdf_forensic_image_check`, `_denied`, `_failed` (reason only, never the image).
* `pdf_forensic_checks` records the verdict, score, agreement, region counts and a
  short `image_input;candidates=…;readable=…;quality=…` note. `verdict` is stored as
  `insufficient` (the column is `VARCHAR(16)`).
* The upload is `@unlink`ed after forwarding; nothing suspicious is retained.
* The service is unchanged in exposure: loopback + internal CA, never public.

## Verification status

| Capability | Status |
|---|---|
| Format validation, EXIF, limits, quality gates, region search, agreement rule, four outcomes, auth, rate limit, audit, cleanup | **implemented and verified** by automated tests (22 pipeline + 10 endpoint + 36 backend/portal contract assertions) |
| Payload recovery from a real screenshot / crop / photo with the real checkpoint | **implemented but NOT measured here** — no checkpoint on the development machine. Run `scripts/validate_image_forensics.py --pdf <issued.pdf> --payload <issued payload>` on the VPS; it walks: full PNG, JPEG q75, JPEG q50, 50% resize, 60% centre crop, 40% corner crop, 8° rotation, simulated photo (perspective + lighting gradient + blur + noise + JPEG), and an unmarked control. |
| Geometric rectification of a photographed page (corner detection + perspective warp) | **investigated, not implemented**: it needs OpenCV in the API venv and, more importantly, a WAM measurement showing it helps. The region search already recovers from moderate perspective; a warp that guesses the page boundary wrongly would be worse than none. |
| Detecting a tool that removed the watermark | out of scope (that is what `no_mark` + the evidence trail is for) |
| Renamed/unknown tools, off-device interception | not applicable to this feature |

### Minimum image size — what is known and what is not

The gate rejects below **320 px** on the short side and **102 400 px²**
(320×320), and the region search analyses a **55% corner region** at minimum. So
the smallest page piece this pipeline will *attempt* is ~55% of a page at 320 px.
Whether WAM actually recovers the payload from that piece is a property of the
checkpoint and is exactly what the validation script measures; until it is run,
no such claim is made.
