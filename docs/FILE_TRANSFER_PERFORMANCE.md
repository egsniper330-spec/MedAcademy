# File-transfer performance — upload and download

Scope: why uploading and downloading files through MedAcademy feels slow even on
a fast link, and what was changed. Everything below is either **measured** (with
the command that produced it) or explicitly marked **not measured**. No phone
timing is claimed anywhere: no build was produced and no device was driven.

---

## 1. Architecture map (verified in source)

### Upload — one multipart request, streamed from disk

| Layer | Code | What it does |
|---|---|---|
| Picker | `expo-document-picker` / `expo-image-picker` → `{ uri, name, mimeType, size }` | no bytes in JS |
| Progress | `src/lib/uploadProgress.ts` (tracker) | preparing → uploading → verifying |
| Transport | `src/lib/uploadTransport.ts` → **XMLHttpRequest** | `xhr.upload.onprogress` (real bytes), `xhr.abort()`, `upload.onload` = body sent |
| Wire | `src/client/php.ts` `createStorageBucket().upload()` | `FormData` part `{ uri, name, type }` — the RN descriptor, so the **native networking layer streams the file from disk** (no Blob, no Base64, no ArrayBuffer) |
| API | `POST /storage/upload` → `StorageController::upload()` | `assertUploadAllowed()` (size + extension denylist) → `UploadIntegrityService::validate()` → `persist()` |
| Validation | `UploadIntegrityService` | empty-body refusal, truncation/substitution checks against `declared_size`, PDF inspection (head + tail only) |
| Store | `StorageService::putFile()` | `move_uploaded_file()` → sibling `.part` → `filesize` compare → `rename` (atomic) |
| Response | `upload()` | measured `size` + `sha256` + `op` correlation id |

There is **no Base64 upload path, no chunked-loop upload for materials and no
JS-side buffering**. Images/avatars go through the same transport.

### Download — two different routes

| Content | Client | Endpoint | Server |
|---|---|---|---|
| Lesson **PDF** (personalized) | `getMaterialPdfUrl()` → `createDownloadResumable()` | `POST /materials/pdf-url` then `GET /materials/pdf?token=` | `MaterialDeliveryController`: authorize → **generate the personalized copy if no valid 24 h copy exists** → `Response::file()` |
| Any other attachment (pptx, zip, images, audio, apk, …) | `getMaterialSignedUrl()` → `createDownloadResumable()` | `POST /storage/signed-url` then `GET /storage/signed?…&sig=` | `StorageController::signedFile()` → HMAC + expiry → `Response::file()` |
| Public object (avatar, cover, thumbnail) | `<Image>` / link | `GET /storage/public/{bucket}/{path}` | `StorageController::publicFile()` → `Response::file()` |

Native downloads write **straight to the file system** (`expo-file-system`
`createDownloadResumable`); the file is size-verified before "complete" is shown.
The web path reads the body as a stream (`res.body.getReader()`), not a Blob.

---

## 2. Measurements

### 2.1 Live host — per-request network stages (this workstation, `curl -w`)

| Target | TCP connect | TLS done | TTFB |
|---|---:|---:|---:|
| `api.medacademy.site/` (PHP) ×8 | 0.28–0.31 s | 0.55–0.66 s | 0.82–0.94 s |
| `api.medacademy.site/` over :80 ×5 | 0.27–0.29 s | — | 0.53–0.57 s |
| `portal.medacademy.site/` (static) ×5 | 0.28–0.40 s | 0.58–0.69 s | 0.86–0.97 s |
| `medacademy.site/` (static) ×3 | — | — | 0.87–1.02 s |

Reading: **application time ≈ 0.28 s** (PHP TTFB minus static TTFB), and the
remaining ~0.6 s is this link's TCP+TLS path. Two handshakes were observed at
**4.6 s and 7.2 s** during the same session — transient host/network stalls, not
reproducible in the next 8 samples.

Therefore a *large* transfer cannot be limited by request overhead. Per-request
costs only explain slowness in flows that make **many sequential requests**
(boot, screens) — not in moving a 10 MB file.

Throughput of this workstation's link, measured on a 474 KB static asset:
**203 KB/s (1.6 Mbit/s)**, TTFB 0.86 s, total 2.33 s. This is the limiting factor
for any live throughput test run from here — see §5.

### 2.2 Server-side download stages (`node scripts/bench/transfer-stages.cjs`)

Real PHP child processes, 256 KiB streaming vs `file_get_contents` + echo,
measured from the parent over a pipe, on this machine's disk:

| size | buffered: read before first byte | buffered peak PHP memory | streamed peak PHP memory |
|---|---:|---:|---:|
| 2 MB | 2 ms | 6.0 MB | 2.0 MB |
| 10 MB | 7 ms | 14.0 MB | 2.0 MB |
| 25 MB | 16 ms | 28.0 MB | 2.0 MB |

The page cache is warm here, so the read is fast; **the memory number is the
decisive one and it is exact: buffering costs the file's own size per concurrent
download** (50 students × 8 MB PDFs = 400 MB of PHP heap on a shared account
whose `memory_limit` is 1024 MB). On a cold cache or the host's disk the
read-before-send also delays the first byte.

### 2.3 Server-side upload stages (same script)

| size | `hash_file('sha256')` | two hashes | `copy()` (cross-device-ish move) |
|---|---:|---:|---:|
| 2 MB | 124 ms | 145 ms | 98 ms |
| 10 MB | 219 ms | 316 ms | 101 ms |
| 25 MB | 366 ms | 705 ms | 139 ms |

A material upload hashes the stored object **once** in `persist()`; the
`material-create` request then hashes it **again** in
`UploadIntegrityService::inspectStored()` (this digest feeds the watermark
variant key, so it is deliberately not taken from the client).

---

## 3. Root causes, ranked by impact

1. **A student's first download of a lesson PDF includes server-side
   personalized-copy generation** (`MaterialForensicPdfService::ensure()` runs
   inside `POST /materials/pdf-url`). It is CPU-bound per page on a 4-vCPU VPS
   with no GPU, and it happens while the student is waiting for "the download".
   Only a live copy younger than 24 h is instant. Measured locally in the
   issuance work: 0.55–4.57 s for 20 pages with an identity embedder — the real
   WAM embedding is slower. **Not measured on production** (needs an
   authenticated session).
2. **The generic download routes buffered the whole object in PHP**
   (`Response::raw(file_get_contents(...))`) → peak memory = file size ×
   concurrent downloads, and time-to-first-byte = full read.
   **Fixed.**
3. **Those routes sent no `Content-Length` and no `Accept-Ranges`** → the app
   could not show a determinate bar (it correctly fell back to a spinner, which
   reads as "stuck"), could not detect truncation against a declared size, and
   could not resume an interrupted transfer: a dropped 25 MB download restarted
   from zero. **Fixed.**
4. **Two full-file SHA-256 passes per material upload** (persist + material
   create): ~0.7 s per 25 MB, ~2.8 s per 100 MB on this disk. Not removed (the
   second digest is a security boundary); optimisation path in §6.
5. **Per-request network floor (~0.9 s cold / ~0.3 s PHP from this link)** —
   relevant to screens and to flows with sequential calls, not to bulk transfer.
   Not a code defect.

Not found (checked, absent): Base64 in any upload/download path; `fetch().blob()`
for local files; full-file reads in the upload validation; redirects on the
upload URL (`POST …/index.php/storage/upload` answers 401 directly, 0
redirects); gzip on binary bodies (`zlib.output_compression` empty,
`output_buffering` 0); low PHP limits (`upload_max_filesize`/`post_max_size`
1024 M, `max_execution_time` 0).

---

## 4. What was changed

| File | Change |
|---|---|
| `backend/src/Http/Response.php` | `file()` now advertises `Accept-Ranges`, sends `ETag`/`Last-Modified`, and honours a single byte range with `206` + `Content-Range` (or `416`). New pure `parseRange()` (unit-tested). Still streams in 256 KiB chunks with `Content-Length`; buffering is still cleared first. |
| `backend/src/Controllers/StorageController.php` | `publicFile()` and `signedFile()` stream via `Response::file()` instead of `file_get_contents()` + `Response::raw()`. Authorization, HMAC validation, expiry, the lesson-PDF refusal, `Content-Disposition` and `nosniff` are unchanged and still run **before** the first byte. |
| `backend/src/Middleware/CorsMiddleware.php` | Exposes `Accept-Ranges`, `Content-Range`, `ETag` so a browser can resume/partially fetch. |
| `backend/tests/http/byte_range_tests.php` (new) | 25 executed checks: range parsing (single/open/suffix/clamped/reversed/multi/416) and the wiring (both routes stream, no buffering, guard order, `Accept-Ranges`). |
| `tests/fileTransferStreaming.test.cjs` (new) | 25 cross-layer assertions: upload is a `{uri}` part with real XHR progress and abort semantics; downloads go straight to the file system with verification; server streams with a length; authorization/forensic policy untouched. |
| `scripts/bench/transfer-stages.cjs` (new) | Reproducible measurement of the two download implementations and the upload's hashing/copy cost. |

Mobile code: **no change was justified.** The upload transport is already the
native streaming `{uri}` multipart with real byte progress and cancellation, and
downloads already use the native file-system task with size verification. The
arithmetic that made the generic route show an indeterminate bar is fixed on the
server, which is where it belonged.

---

## 5. What is NOT measured (and why)

* **Device upload/download throughput.** Needs the physical device with a
  reproducible test file. No APK/AAB/IPA may be built in this task, and the
  installed build predates these changes, so any device number would describe the
  old code. Not claimed.
* **Live download throughput of a real material.** Needs an authenticated
  session and a real file; the read-only probes above are the limit of what was
  authorized.
* **Production personalized-PDF generation time.** Needs `POST /materials/pdf-url`
  with a student token.
* **Host disk speed under concurrency.** The bench numbers are this machine's
  NVMe with a warm page cache; the host's disk and the CloudLinux LVE limits are
  different.
* **HTTP/2.** The installed `curl` cannot negotiate it, so the protocol in use by
  the app was not verified; the server answers `HTTP/1.1` on every probe.

---

## 6. Remaining recommendations (not implemented)

1. **Move PDF generation out of the download request** (prewarm on upload, or a
   short "preparing" state with a real progress contract). This is the single
   biggest remaining wait, and it is an architecture decision, not a tweak.
2. **One hash per upload**: have `material-create` accept the digest *and* size of
   the upload receipt the server itself produced in `persist()`, verified against
   the stored object's size/mtime, instead of re-reading the file.
3. **Set `upload_tmp_dir` inside the account's storage volume** so
   `move_uploaded_file()` is a rename rather than a cross-filesystem copy of the
   whole file. Server configuration, not code.
4. **Background download sessions on iOS** (`FileSystemSessionType.BACKGROUND`)
   so a download survives app backgrounding; needs device validation.
5. **Serve `/storage/public/*` from the web server** rather than PHP if the host
   ever allows an alias outside the document root — every public image currently
   costs a full PHP request (~0.28 s of application time).
6. **Investigate the 4–7 s TLS stalls** with the host if they recur; nothing in
   the application can cause them.

---

## 7. Reproduce

```bash
php backend/tests/http/byte_range_tests.php      # 25 checks
node tests/fileTransferStreaming.test.cjs        # 25 assertions
node scripts/bench/transfer-stages.cjs --sizes=2,10,25
```
