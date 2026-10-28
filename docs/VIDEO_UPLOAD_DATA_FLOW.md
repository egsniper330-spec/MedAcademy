# Video upload data flow (doctor → app → PHP → VdoCipher)

**Verified against the code on 2026-10-27.** This document answers one question
that decides how much capacity the video feature needs: **do video bytes pass
through the shared PHP host, or do they go straight to VdoCipher?**

**Answer: they pass through PHP.** The shipped app slices the file and POSTs
every slice to the MedAcademy backend, which stores the slices on the server's
temp disk, concatenates them, and only then hands the assembled file to
VdoCipher. A direct-to-VdoCipher uploader exists in the repository but **no code
calls it** — see §5.

---

## 1. The path the app actually runs

| Step | Where | Code |
|---|---|---|
| 1. Doctor picks a video | app | `src/lib/useVideoUploader.ts` → `uploadVideoInChunks()` (`src/lib/vdoCipherUpload.ts:80`) |
| 2. Client creates an upload record | app → PHP | `createUploadRecord()` (`src/lib/videoUploadEngine.ts`) → table `video_uploads`; the PHP backend is reached through `src/client/php.ts` |
| 3. File is sliced on device | app | `CHUNK_SIZE_BYTES` default **8 MB**; native reads base64 slices with `expo-file-system`, web slices an `ArrayBuffer` |
| 4. **Each slice is POSTed to PHP** | app → PHP | `uploadVideoChunkWithProgress()` → `POST /video/chunk` with `x-upload-id`, `x-chunk-index`, `x-total-chunks` (`src/lib/api.ts:2132`, `src/lib/uploadVideoChunkXhr.ts:39`) |
| 5. PHP stores the slice | server disk | `VideoController::uploadChunk()` (`backend/src/Controllers/VideoController.php:736`) writes `sys_get_temp_dir()/medacademy_chunks/{uploadId}/chunk_{i}` and increments `video_uploads.chunks_completed` |
| 6. Last slice triggers assembly | PHP | same handler; when `chunks_completed` reaches `total_chunks` it responds `assembly_triggered: true` |
| 7. Assembly | server disk | `VideoController::assembleUpload()` → the controller streams chunk files into `tempnam(sys_get_temp_dir(), 'vdoasm_')` one slice at a time (`fopen`/`fwrite` loop, **not** one big string) |
| 8. Transfer to VdoCipher | server → VdoCipher | `VdoCipherService::uploadToS3()` posts the assembled file to VdoCipher's API with the platform credentials; VdoCipher returns the `video_id` |
| 9. Local record + status | PHP → DB | `video_assets` row (`doctor_id` = the authenticated uploader), then `POST /video/sync`/`/video/upload-status` reconcile `processing → ready` |

Authorization on every hop is server-side: `/video/chunk` and
`/video/assemble` require a JWT and compare the upload row's `doctor_id` with the
caller (`role: doctor|admin|super_admin`). The client never chooses the owner.

**There is no direct presigned upload in this path**, so the VdoCipher
`clientPayload.uploadLink` is not used by the shipped flow.

## 2. What that costs the shared host

Per upload of a file of size **S**:

| Resource | Cost |
|---|---|
| Disk (`/tmp`, i.e. `sys_get_temp_dir()`) | up to **2 × S** while assembling (all chunks + the assembled copy), then 1 × S until the chunks are deleted |
| Network in | **S** (the whole file, in 8 MB POSTs) |
| Network out | **S** again (server → VdoCipher) |
| PHP memory | one chunk at a time (~8 MB plus request overhead) — assembly is streamed, so it does not load the whole file |
| Wall-clock per request | one request per 8 MB slice (a 1 GB file = 128 requests), plus one long `assemble` request that uploads S to VdoCipher |
| Entry processes | each in-flight slice occupies an entry process; on a plan with **20 entry processes** (Namecheap/Spaceship Stellar) ten doctors uploading in parallel can consume half of them before any other request is served |
| `max_execution_time` | the `assemble` request is the risk: uploading 1 GB to VdoCipher inside one PHP request can exceed a 30–120 s limit depending on the outbound link |

That is the honest capacity picture: **video upload bandwidth, temp disk and
entry processes are shared between teachers' uploads and students' normal API
traffic.** Playback is unaffected (VdoCipher serves the media from its own CDN).

## 3. Failure modes that matter operationally

* **Chunks left on disk.** If an upload is abandoned between chunk 40 and 41 the
  files stay in `sys_get_temp_dir()/medacademy_chunks/{uploadId}`. There is no
  scheduled sweep of that directory in this repository — a provider-side `/tmp`
  cleanup is the only reclamation today. This is a known gap, not a leak the
  code fixes.
* **Assembly timeout.** A slow outbound link plus a large file can hit
  `max_execution_time` mid-transfer; the upload stays `processing` and must be
  retried. Nothing deletes the remote VdoCipher video in that case.
* **Duplicate uploads.** The client records each attempt in `video_uploads` and
  `/video/assemble` is idempotent per `upload_id`, but a retried *device* upload
  creates a new `upload_id` and therefore a new remote video. Only the explicit
  Import/Sync flows reconcile remote assets (see §4).

## 4. Sync and Import are separate, and neither is a cleanup tool

* `POST /video/sync` → `VideoLibrarySyncService::syncLibrary()` reconciles
  **local** rows against the remote listing. It never imports an unknown remote
  video and never deletes a remote video; a listing failure leaves the local
  library untouched (`backend/src/Services/VideoLibrarySyncService.php:66`).
* `POST /video/import` → `VideoController::importAsset()`
  (`backend/src/Controllers/VideoController.php:312`) imports one **known id**
  after: shape validation, a local ownership check (own row → idempotent
  success; another doctor's row → 409), a *complete* remote listing that must
  contain the id (`status: Ready`), and an explicit `confirm_ownership`
  acknowledgement. The row is inserted with `doctor_id` = the authenticated
  caller under `INSERT … WHERE NOT EXISTS` so a race cannot duplicate it.

## 5. Dead code that must not be mistaken for the shipped path

| Symbol | Status |
|---|---|
| `uploadToVdoCipherS3()` (`src/lib/vdoCipherUpload.ts:250`) — presigned direct POST to VdoCipher's S3 | **exported, never called** |
| `uploadVideoChunk()` (`src/lib/api.ts:2132`) — plain fetch flavour of the chunk POST | superseded by `uploadVideoChunkWithProgress()` in `src/lib/uploadVideoChunkXhr.ts` |
| `POST /video/upload-init` | still routed and used for the upload record/credentials, but the bytes do not use a presigned link in the shipped flow |

If the direct-upload path is ever wanted (it would remove the 2 × S disk cost and
the bandwidth from the shared host), the work is: call `uploadToVdoCipherS3()`
from `useVideoUploader` behind a flag, keep `/video/chunk` as the fallback, and
verify on a real device that the presigned POST succeeds with VdoCipher's
`success_action_status`.

## 6. What to measure if uploads become the bottleneck

Nothing in this repository measures it yet. If doctors report slow uploads:

1. `du -sh /tmp/medacademy_chunks` on the host (cPanel Terminal) — abandoned
   chunks, and how much disk they hold.
2. cPanel → *Metrics → Resource Usage* during a test upload: CPU, physical
   memory, **entry processes**, and disk I/O.
3. One synthetic upload of a 50 MB and a 300 MB file from the same network,
   timing each 8 MB slice (`upload_audit_logs` has one `chunk_received` row per
   slice, so the server-side timing is already recorded).
