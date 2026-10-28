# Lesson material uploads: zero-byte incident, integrity fix, and automatic file cleanup

Status: implemented · Requires backend upload · No database migration

This document records the investigation of the zero-byte PDF incident, the
root cause, the fixes, and the exact deployment/verification steps.

---

## 1. The incident

A doctor uploaded `Biology_AR_Model_7.pdf` (~2 MB). The upload finished
instantly and the app reported success. The resulting row was:

| field | value |
| --- | --- |
| material id | `e883a3b3-a172-4f60-a11b-00f3b3159d7b` |
| lesson id | `108ba8e2-6383-45ef-b587-281aed4d3c68` |
| course id | `3a29a59e-59ef-48da-894a-b8e20d091ed1` |
| storage path | `3a29a59e-…/108ba8e2-…/1792935763223_Biology_AR_Model_7.pdf` |
| `file_hash_size` | `0` |
| `file_hash` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

That digest is the SHA-256 of **empty input**, and the object on disk is
**0 bytes**. Because pdf delivery is fail-closed, every download then failed
with `source_unreadable` — the document was gone, but the row kept claiming
it was a real file.

## 2. Root cause (confirmed from the code)

Two independent gaps combined. Neither on its own would have lost the file.

### 2.1 Client: the bytes were never read from disk

`src/lib/api.ts` → `uploadLessonMaterial()` built the multipart body like this:

```ts
const resp = await fetch(fileUri);        // fileUri = file://… or content://…
const blob = await resp.blob();
await backendClient.storage.from('lesson-materials').upload(path, blob, …);
```

On React Native that round trip **does not deliver a local file**: the request
resolves immediately with an empty body, so `blob()` yields a 0-byte Blob and
`FormData` serialises an empty file part. That is exactly why the upload felt
instantaneous — nothing was ever read from disk.

The supported representation in this project is the descriptor
`{ uri, name, type }`, which the native networking layer streams from disk
(`src/lib/uploadPart.ts` → `toUploadPart`, documented in that file). Avatar
uploads already worked that way; lesson materials and course covers were the
outliers.

### 2.2 Server: an empty body was a "successful" upload

`StorageController::upload()` only inspected `$_FILES['error']`. A transfer
that completes with **zero bytes** reports `UPLOAD_ERR_OK`, so it passed every
check:

1. `assertUploadAllowed()` checked *size > max* (0 is not too large) and the
   extension (`.pdf` is allowed),
2. `StorageService::putFile()` called `move_uploaded_file()` straight onto the
   final name — no byte-count verification, and a 0-byte move succeeds,
3. the handler answered `200 {path, url}`,
4. the app then inserted the material row with `file_size` taken from the
   **picker's claim** (≈2 MB), never from the stored object.

Result: a healthy-looking row, a zero-byte object, and a "successful" upload.

### 2.3 What could not be proven

There are no production request logs for the original upload, so the exact
byte-loss point in *that* request cannot be re-derived. What is proven is that
(a) the client code path produces a 0-byte part for a local file on native, and
(b) the server accepted a 0-byte body as success — both are pinned by tests now,
and the empty-hash/empty-size evidence matches them exactly.

## 3. Fixes

### 3.1 Client (`src/lib/api.ts`, `src/client/php.ts`, lesson editor)

* `uploadLessonMaterial()` and `uploadCourseCover()` send the
  `{ uri, name, mimeType }` descriptor — no `fetch().blob()` anywhere.
* The storage client returns `{ data: { path, size, sha256 } }` and turns a
  zero/missing `size` into an **error** (`upload_empty`) instead of a success.
* The lesson editor rejects a 0-byte pick before uploading
  (`lessonEditor.uploadEmpty`, English + Arabic) and records the
  server-measured size in `lesson_materials.file_size`.

### 3.2 Upload integrity (`backend/src/Services/UploadIntegrityService.php`)

`validate()` → `persist()` → measured result:

| check | failure code |
| --- | --- |
| `$_FILES['error']` (never ignored) | `upload_missing`, `upload_truncated`, `upload_too_large`, `upload_storage_error` |
| temp file exists | `upload_missing` |
| actual byte count > 0 | `upload_empty` |
| declared size == bytes on disk | `upload_truncated` |
| size cap (`LESSON_MATERIAL_MAX_BYTES`, 100 MB default) | `upload_too_large` |
| PDF header, `%%EOF` trailer, no `/Encrypt`, parser opens it | `pdf_invalid`, `pdf_empty`, `pdf_truncated`, `pdf_encrypted`, `source_too_large` |
| written bytes == validated bytes | `persist_mismatch` (the fragment is deleted) |

PDF validation reuses `PdfWatermarkService::inspect()`, i.e. the **same parser
the renderer uses**, so a document that would fail at a student's download is
refused at upload, where the doctor can act on it.

`StorageService::putFile()` now writes a sibling `.part`, compares its size with
the validated count, and only then renames — atomic, and unable to publish a
short write.

`POST /storage/upload` answers with the **measured** `size` and `sha256`.

### 3.3 A material row cannot point at nothing (`DataController`)

Both the INSERT and the UPDATE path for `lesson_materials` verify the named
object (exists, non-empty, valid PDF when applicable) and **overwrite**
`file_size` with the measured byte count. When migration 035 is applied, the
source-hash cache (`file_hash`, `file_hash_path`, `file_size`, `file_hash_mtime`)
is filled in from the stored bytes, so the first delivery does not re-digest a
multi-megabyte file.

A write that names a missing/empty object is refused with
`material_file_missing` / `material_file_empty`.

### 3.4 Delete / replace are now server-side

New endpoints (doctor must own the material's course; admins exempt):

```
POST /materials/{id}/delete
POST /materials/{id}/replace   { storage_path, file_name?, file_type? }
```

Order is fixed in both: **validate → commit the row → reclaim files**.

* `delete` snapshots the material's generated copies *before* the cascade
  (their rows disappear with the material), deletes the rows, then removes the
  source object and every watermarked copy.
* `replace` requires the new object to live under
  `<courseId>/<lessonId>/`, refuses a path already used by another material,
  verifies it, updates the row (clearing the hash cache), and only then retires
  the previous source plus the stale copies. A failure before the commit leaves
  the old document fully usable.
* The client no longer deletes the old object before updating the row (that
  ordering is what turned a failed replacement into "download: file not found").

### 3.5 Centralised cleanup (`backend/src/Services/MaterialFileCleanupService.php`)

Every deletion path — these endpoints, `deleteLesson`, `deleteSection`,
`deleteCourse`, `permanentlyDeleteCourse` — goes through one service that:

* refuses `..`, any resolved directory outside the storage root, and symlinked
  objects (`StorageService::absolutePath`);
* **retains** a source still referenced by another `lesson_materials` row;
* deletes the `lesson_material_pdfs` registry rows together with their files;
* is idempotent (a missing file is not an error);
* queues a failure to `storage/private/.cleanup/queue.jsonl` instead of losing
  it — there is no queue worker on shared cPanel, so the retry is a CLI command.

Previously `deleteLesson` collected the paths into `$storagePaths` and **never
used the variable**: deleting a lesson/course left every attachment and every
watermarked copy on disk forever.

### 3.6 Diagnostics

`php backend/scripts/diagnose-pdf-delivery.php <material_id>` now reports, stage
by stage: stored path + byte count, whether the file parses, recorded vs actual
size, the hash-cache consistency (path/size/mtime/digest), the personalized-copy
registry (present vs missing files), and cleanup health (queue depth + orphan
scan). A 0-byte source now says plainly that the upload never persisted bytes
and how to fix it.

### 3.6.1 "Upload failed." — diagnosing a REFUSED upload

The doctor-facing sentence is the app's generic fallback, not the server's
answer. The upload path answers with a stable code, and the exact failing stage is
named by one command (read-only; it stores and deletes one tiny sample PDF):

```bash
cd /home/USER/medacademy-api
php scripts/diagnose-upload.php                       # environment + full round trip
php scripts/diagnose-upload.php --file=/path/doc.pdf   # also gate the doctor's own file
php scripts/diagnose-upload.php --json                 # machine-readable
```

It prints one verdict per stage — `php.*` (limits), `storage.*` (roots, perms,
free space), `engine.*`, `db.*` (migrations, and any NOT NULL column the app does
not send), then the real pipeline: `upload.validate` → `upload.persist` →
`upload.verify_stored`. The first `FAIL` is the cause; later stages depend on it.

| code | meaning | what the doctor must do |
| --- | --- | --- |
| `pdf_unsupported_format` | the file uses a compressed cross-reference stream the bundled FPDI parser cannot read (common in Word/Acrobat exports) | re-export as a standard PDF ("Print to PDF", or PDF 1.4 compatibility) |
| `pdf_invalid` | damaged / unreadable | upload a different copy |
| `pdf_encrypted` | password-protected | remove the protection |
| `pdf_truncated` | the transfer stopped early | upload again |
| `upload_too_large` | above the host's `upload_max_filesize`/`post_max_size` (the message states the effective limit) | shrink or split the file, or raise the host limit |
| `material_file_missing` / `material_file_empty` | the bytes were not where the row expected them | upload again (the diagnostic above says why) |
| `material_write_failed` | the row could not be written after a good upload | retry; quote the `mw_…` reference from the message and the `[material-write]` log line |

The server-side evidence is already structured — no document content, no user
identity:

```bash
grep 'storage-upload' storage/logs/app.log | tail -20   # op/stage/result/reason per upload
grep 'material-write' storage/logs/app.log | tail -20   # row-insert failures with a reference
grep 'pdf-inspect'   storage/logs/app.log | tail -20   # which PDFs the engine refused, and why
```

`php backend/scripts/storage-cleanup.php` (CLI only):

```
--list                    report queue + orphan summary (default, changes nothing)
--retry                   retry queued deletions
--orphans                 list unreferenced files (grace 3600 s by default)
--delete-orphans --yes    delete them (requires --yes; --grace=N to widen)
```

## 4. Deployment

### Backend files that MUST be uploaded

| file | kind |
| --- | --- |
| `backend/src/Services/UploadIntegrityService.php` | **new** |
| `backend/src/Services/MaterialFileCleanupService.php` | **new** |
| `backend/src/Controllers/LessonMaterialController.php` | **new** |
| `backend/src/Controllers/StorageController.php` | changed (upload integrity) |
| `backend/src/Storage/StorageService.php` | changed (atomic putFile, containment) |
| `backend/src/Controllers/DataController.php` | changed (material row verification) |
| `backend/src/Controllers/CourseController.php` | changed (file cleanup on delete) |
| `backend/src/Controllers/RpcController.php` | changed (file cleanup on hard delete) |
| `backend/src/Services/PdfWatermarkService.php` | changed (`inspect()`) |
| `backend/routes/api.php` | changed (two new routes) |
| `backend/scripts/diagnose-pdf-delivery.php` | changed (operator tool) |
| `backend/scripts/storage-cleanup.php` | **new** (operator tool) |

Upload all of them together: `routes/api.php` registers
`LessonMaterialController`, and the Router answers `handler_unavailable` if the
controller is missing (a partial upload fails only the new routes).

### 4.1 Files for the refused-upload fix (see §3.6.1)

| file | why |
| --- | --- |
| `backend/src/Services/PdfWatermarkService.php` | distinguishes an unsupported container (`pdf_unsupported_format`) from a damaged PDF, and only parses when FPDI is the renderer |
| `backend/src/Services/UploadIntegrityService.php` | the attachment cap becomes `min(configured, upload_max_filesize)` |
| `backend/src/Controllers/StorageController.php` | uses that cap, states `post_max_size` on 413, and adds `discardUpload()` (409 `object_referenced`) |
| `backend/src/Controllers/DataController.php` | a refused material insert returns `material_write_failed` + an `mw_…` reference; the SQLSTATE stays in the log |
| `backend/routes/api.php` | registers `POST /storage/discard-upload` |
| `backend/scripts/diagnose-upload.php` | **new** operator tool |

No migration, no cron change and no new configuration variable. The client half
(the localized messages and the guarded reclaim call) needs a normal app build;
until it is installed, refusals still work — they are just reported with the old
generic sentence.

### Frontend

The client change is part of the normal app build (EAS / Expo). Until a build
carrying it is installed, uploads from an OLD build still send a 0-byte body —
they now fail loudly with a clear message instead of silently storing nothing.

### Database

**No migration is required.** The new code degrades exactly like the delivery
controller: without migration 035 the hash-cache columns are skipped; without
migration 032 the variant registry is skipped. Nothing in this change alters an
existing schema object.

### Configuration

| variable | default | meaning |
| --- | --- | --- |
| `LESSON_MATERIAL_MAX_BYTES` | `104857600` (100 MB) | upload cap, unchanged |
| `LOG_DIR` | `storage/logs` | where `storage-upload` / `material-cleanup` lines go |

No new required variable. PHP requirements are unchanged (zlib + mbstring for
PDF validation; FPDI/TCPDF already vendored). `upload_max_filesize` /
`post_max_size` still bound a real upload and are reported as their own errors.

## 5. Verification

On the server (SSH, CLI only — the scripts refuse a web SAPI):

```bash
# 1. Syntax of every uploaded file (PHP >= 8.2)
php -l backend/src/Services/UploadIntegrityService.php
php -l backend/src/Services/MaterialFileCleanupService.php
php -l backend/src/Controllers/LessonMaterialController.php

# 2. End-to-end suite (real filesystem + SQLite; no production data)
bash backend/tests/material-lifecycle/run.sh

# 3. A known-good material: expect every stage to pass
php backend/scripts/diagnose-pdf-delivery.php <material_id>

# 4. The affected record: expect source_unreadable with the 0-byte explanation
php backend/scripts/diagnose-pdf-delivery.php e883a3b3-a172-4f60-a11b-00f3b3159d7b

# 5. Cleanup machinery
php backend/scripts/storage-cleanup.php --list
php backend/scripts/storage-cleanup.php --retry
```

Then, from the app: upload a multi-megabyte PDF, confirm the toast appears only
after the bytes are stored, and confirm the document opens (watermarked) as a
student.

Acceptance for the fix: any upload whose body arrives empty or short is
**refused** with a specific message, and no `lesson_materials` row or storage
object is created for it.

## 6. Rollback

The change is additive except for four touched files, which are independent of
each other:

* restore `StorageController.php`, `StorageService.php`, `DataController.php`,
  `CourseController.php`, `RpcController.php`, `PdfWatermarkService.php` and
  `routes/api.php` from the previous commit → the old behaviour returns
  (uploads no longer validated, no lifecycle endpoints). The two new services,
  the new controller and the two scripts become unreferenced and can stay on
  disk harmlessly.
* Nothing in the database changes, so there is no data migration to undo.
* Files already deleted by the new cleanup remain deleted — that is the
  intended effect of a doctor's delete; the old code simply never did it.

Do **not** roll back by deleting the new service files first: `routes/api.php`
would then reference a missing controller and only the new routes would fail
(with `handler_unavailable`), which is why the route file and the controller
ship together.

## 7. Known limitations

* The exact 0-byte moment of the original request cannot be proven without
  production request logs (see §2.3). The server half is reproduced and pinned
  by tests; the client half is fixed and pinned by a source-level regression
  check.
* `backend/tests/material-lifecycle/` needs PHP 8.2+ with `pdo_sqlite`. It has
  since been **executed** against a portable PHP 8.2.35 CLI (pdo_sqlite, gd,
  curl, openssl, fileinfo, mbstring, zip): **33 passed, 0 failed, 0 skipped**
  (`bash backend/tests/material-lifecycle/run.sh`).
* Orphan reconciliation is CLI-driven by design (no cron worker on shared
  hosting). Run `storage-cleanup.php --retry` periodically (e.g. monthly) or
  after any filesystem incident.
* The pre-existing 0-byte record and its file are left untouched: they are
  evidence. Re-upload that document from the lesson editor; the new upload path
  will store real bytes.

## 8. Byte-level upload progress and cancellation (follow-up)

The incident above was about *correctness* (0 bytes stored). This section is
about the doctor's *visibility* while the bytes move, which failed in a different
way: the Materials tab showed a spinner and the single word "Uploading…" for the
whole request.

### 8.1 Why it looked hung

`uploadLessonMaterial()` went through `backendClient.storage…upload()`, which is
implemented with `fetch()`. **`fetch` has no upload-progress event**, so no code
in the app could know how many bytes had been sent. A 40 MB scanned PDF on a
slow mobile connection therefore produced one static label for minutes: the
screen could not be distinguished from a dead request, the doctor could not
cancel, and a drop was only discovered at the end as "Upload failed."

There is a second, subtler problem this section fixes: **bytes transferred is
not the same as success**. The last byte leaving the phone says nothing about
whether PHP stored the file, measured its size, or computed its digest, and the
old UI had no vocabulary for that difference.

### 8.2 What was built

| File | Role |
|---|---|
| `src/lib/uploadProgress.ts` | **Pure** helpers — percentage, smoothed speed, ETA, the stage vocabulary, and failure→message mapping. Dependency-free so the tests execute it for real. |
| `src/lib/uploadTransport.ts` | Multipart `XMLHttpRequest` transport: real `xhr.upload.onprogress`, abort, timeout. The XHR constructor is injectable so all paths are testable off-device. |
| `src/client/php.ts` | One contract, two transports: the XHR path only when a progress callback is passed, then the **same** body parsing, status mapping and zero-byte check as before. |
| `src/lib/api.ts` | `uploadLessonMaterial(..., { onProgress, signal })`; wraps raw counters in a tracker and reports `verifying` after the response. |
| `src/components/MaterialUploadProgress.tsx` | The card: file name, percentage, transferred/total, speed, ETA, real stage, cancel, actionable error. RTL-aware. |
| `src/app/(app)/lesson-editor/[id].tsx` | Owns the transfer: one at a time, `AbortController` per transfer, cancel aborts only that transfer, button disabled while active. |

Stages are deliberately distinct:

```
preparing → uploading → verifying → saving → done
                 └──────────┬──────────┘
                    failure/cancelled → failed | cancelled
```

`uploading` is the only measured part. 100 % on the bar means *sent*, not
*saved*; `verifying` covers the server's measured size/digest, `saving` covers
the `lesson_materials` insert.

### 8.3 Failure handling

| Condition | What the doctor sees |
|---|---|
| `413` (host request limit) | "This file is larger than the server accepts…" |
| `429` | "Too many uploads at once…" (retryable) |
| `401` / `403` | "Your session expired…" (sign in, then re-attach) |
| `408` / `504` / transport timeout | "The upload timed out…" (retryable) |
| dropped connection (`NETWORK`) | "The connection dropped…" (retryable) |
| `5xx` | "The server could not accept the file right now…" |
| `200` with 0 stored bytes | the existing `upload_empty` failure, never a success |
| explicit cancel | "Upload cancelled." — **not** an error toast |

### 8.4 Verification (executed)

| Check | Command | Result |
|---|---|---|
| Progress maths + failure mapping + transport + wiring | `node tests/materialUploadProgress.test.cjs` | **111 passed, 0 failed** |
| Material upload/lifecycle PHP suite | `bash backend/tests/material-lifecycle/run.sh` | **33 passed, 0 failed** |
| Whole JS regression set | `node scripts/run-all-tests.cjs` | see the audit report |
| Types | `npx tsc --noEmit` | exit 0 |

The transport tests drive a fake XHR through: progress forwarding, header
application, non-2xx resolve, pre-aborted signal, mid-flight abort (asserting
`xhr.abort()` really ran and the listener was removed), network failure, and
timeout.

### 8.5 Deployment

**Frontend-only.** Every file above ships in the app bundle; no backend file
changes and no database migration is required for this section. The server
contract (`POST /storage/upload`, multipart `file`/`bucket`/`path`, bearer auth,
measured `size` + `sha256`) is unchanged, so an older client keeps working.

### 8.6 Known limitations (this section)

* **The transfer is still screen-bound.** Leaving the lesson editor does not
  cancel it (the request belongs to the app process, not the component), but
  the progress card lives on that screen. Videos already use the registered
  queue (`lib/uploadQueueStore`, `lib/backgroundUploadService`,
  `lib/nativeUploadBridge`); materials do **not** have an OS-managed background
  transfer. On Android a single multipart XHR continues while the foreground
  service keeps the process alive; on iOS it is suspended ~30 s after
  backgrounding and resumes when the app returns. A registered, resumable
  material transfer is not implemented and must not be claimed.
* **Speed/ETA are estimates.** The first sample yields no ETA, and the value is
  smoothed (EMA) so it does not jitter; a stalled socket shows the last known
  speed until the request fails.
* **No real-device verification** was performed for this change (no device was
  attached in this environment); the behaviour is pinned by executed unit tests
  plus source-contract tests, not by a physical-device run.
