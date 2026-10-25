<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Http\ApiException;
use MedAcademy\Storage\StorageService;
use MedAcademy\Utils\Config;
use MedAcademy\Utils\Logger;
use Throwable;

/**
 * UploadIntegrityService — "a successful upload means the bytes are on disk".
 *
 * ── WHY THIS EXISTS (the zero-byte PDF incident) ────────────────────────────
 * A doctor uploaded a ~2 MB PDF. The request finished instantly, the app said
 * it worked, `lesson_materials` gained a row … and the stored object was 0
 * bytes (`file_hash = e3b0c442…`, the SHA-256 of empty input). The app's PDF
 * delivery endpoint then refused it with `source_unreadable`, so the document
 * was simply gone.
 *
 * Two independent gaps made that possible:
 *
 *   1. CLIENT — the upload body was built from `fetch(localFileUri).blob()`.
 *      On React Native that does not read a local file: it resolves at once
 *      with an empty body, so the multipart part carried 0 bytes. (Fixed in
 *      `src/lib/api.ts` by sending the `{ uri, name, type }` descriptor that
 *      the native layer streams from disk.)
 *
 *   2. SERVER — nothing checked what actually arrived. `$_FILES['error']` was
 *      inspected, but a *successful* transfer of zero bytes (UPLOAD_ERR_OK with
 *      an empty temp file) passed straight through, `move_uploaded_file()`
 *      happily created a 0-byte object, and the handler answered 200. The app
 *      then recorded whatever size the picker had claimed.
 *
 * This service closes gap 2 for every upload and gives the handlers one place
 * to ask the three questions that matter:
 *
 *   • is this really the file the client says it sent?   → validate()
 *   • was every byte persisted, atomically?              → persist()
 *   • what is actually on disk now?                      → inspectStored()
 *
 * It never trusts a client-declared size, MIME type or hash: sizes come from
 * `filesize()`, digests from `hash_file()`, and PDF validity from the SAME
 * parser the watermark renderer uses (`PdfWatermarkService::inspect`), so a
 * file that would fail at a student's download is refused at upload instead.
 *
 * Diagnostics are structured and privacy-safe: an operation id, a stage, a
 * stable reason code, byte counts and a storage path. Never document content,
 * never credentials, never a student identity.
 */
final class UploadIntegrityService
{
    /** Buckets whose contents are served back to students inside the app. */
    public const MATERIAL_BUCKETS = ['lesson-materials', 'lesson-pdfs'];

    private string $opId;

    public function __construct(
        private readonly StorageService $storage = new StorageService(),
        private readonly PdfWatermarkService $pdf = new PdfWatermarkService(),
    ) {
        $this->opId = 'up_' . bin2hex(random_bytes(6));
    }

    /** Correlation id for every log line of THIS upload (safe to return/log). */
    public function opId(): string
    {
        return $this->opId;
    }

    /** Effective cap for lesson attachments (same config the policy check uses). */
    public function maxBytes(): int
    {
        return max(1, Config::int('LESSON_MATERIAL_MAX_BYTES', 100 * 1024 * 1024));
    }

    /**
     * Validate a `$_FILES` entry BEFORE anything is written to storage.
     *
     * Checks, in order: the PHP upload error, the temp file's existence, the
     * real byte count, the client-declared size (truncation detector), the size
     * cap for attachment buckets, and — for PDFs — the document itself.
     *
     * @param array<string,mixed> $file $_FILES entry
     * @return array{tmp:string,size:int}
     */
    public function validate(array $file, string $dest, string $bucket): array
    {
        $error = (int) ($file['error'] ?? UPLOAD_ERR_NO_FILE);
        if ($error !== UPLOAD_ERR_OK) {
            // Named for the operator; the handler maps these to friendly text.
            $this->log('validate', 'fail', ['reason' => 'php_upload_error', 'upload_error' => $error, 'bucket' => $bucket]);

            if ($error === UPLOAD_ERR_INI_SIZE || $error === UPLOAD_ERR_FORM_SIZE) {
                throw new ApiException(
                    413,
                    'File exceeds the server upload size limit. Reduce the file size or ask the host to raise upload_max_filesize.',
                    'upload_too_large'
                );
            }
            if ($error === UPLOAD_ERR_NO_TMP_DIR || $error === UPLOAD_ERR_CANT_WRITE) {
                throw new ApiException(
                    500,
                    'The server could not prepare storage for this upload. Please contact support.',
                    'upload_storage_error'
                );
            }
            if ($error === UPLOAD_ERR_PARTIAL) {
                throw new ApiException(
                    400,
                    'The upload was interrupted before it finished. Please try again.',
                    'upload_truncated'
                );
            }
            throw new ApiException(400, 'file is required', 'upload_missing');
        }

        $tmp = (string) ($file['tmp_name'] ?? '');
        if ($tmp === '' || !is_file($tmp)) {
            $this->log('validate', 'fail', ['reason' => 'tmp_missing', 'bucket' => $bucket]);
            throw new ApiException(400, 'The upload did not arrive completely. Please try again.', 'upload_missing');
        }

        $size = (int) @filesize($tmp);
        $declared = (int) ($file['size'] ?? 0);

        // THE incident: UPLOAD_ERR_OK with an empty temp file. Reject it here so
        // it can never become a stored object or a database row.
        if ($size <= 0) {
            $this->log('validate', 'fail', [
                'reason' => 'empty_body',
                'bucket' => $bucket,
                'declared_bytes' => $declared,
                'actual_bytes' => $size,
            ]);
            throw new ApiException(
                422,
                'The uploaded file is empty (0 bytes). Please choose the file again.',
                'upload_empty'
            );
        }

        // A declared size that disagrees with the bytes on disk means the
        // transfer stopped early — the classic truncated multipart body.
        if ($declared > 0 && $declared !== $size) {
            $this->log('validate', 'fail', [
                'reason' => 'size_mismatch',
                'bucket' => $bucket,
                'declared_bytes' => $declared,
                'actual_bytes' => $size,
            ]);
            throw new ApiException(
                400,
                'The upload did not complete (' . $size . ' of ' . $declared . ' bytes arrived). Please try again.',
                'upload_truncated'
            );
        }

        if (in_array($bucket, self::MATERIAL_BUCKETS, true) && $size > $this->maxBytes()) {
            $this->log('validate', 'fail', [
                'reason' => 'too_large',
                'bucket' => $bucket,
                'actual_bytes' => $size,
                'limit_bytes' => $this->maxBytes(),
            ]);
            throw new ApiException(
                413,
                'File is too large. Maximum size is ' . (int) round($this->maxBytes() / 1048576) . ' MB.',
                'upload_too_large'
            );
        }

        if ($this->looksLikePdf($file, $dest, $tmp)) {
            $this->assertPdf($tmp, $bucket);
        }

        $this->log('validate', 'ok', ['bucket' => $bucket, 'actual_bytes' => $size]);
        return ['tmp' => $tmp, 'size' => $size];
    }

    /**
     * Move the validated temp file into storage and measure what landed.
     *
     * The write itself is atomic (`StorageService::putFile` writes a sibling
     * `.part` then renames), and the result is verified against the bytes we
     * validated — so the caller can only ever see a complete object.
     *
     * @return array{path:string,size:int,sha256:string}
     */
    public function persist(string $tmp, int $expectedSize, string $bucket, string $dest, bool $public): array
    {
        try {
            $this->storage->putFile($bucket, $dest, $tmp, $public, $expectedSize);
        } catch (Throwable $e) {
            $this->log('persist', 'fail', [
                'reason' => 'write_failed',
                'bucket' => $bucket,
                'path' => $dest,
                'actual_bytes' => $expectedSize,
                'error' => $e->getMessage(),
            ]);
            throw $e instanceof ApiException
                ? $e
                : new ApiException(500, 'The file could not be stored. Please try again.', 'storage_write_failed', $e);
        }

        $stored = $public
            ? $this->storage->publicFilePath($bucket, $dest)
            : $this->storage->privateFilePath($bucket, $dest);
        $bytes = is_file($stored) ? (int) @filesize($stored) : 0;

        if ($bytes !== $expectedSize || $bytes <= 0) {
            // Never report success for a partial write: remove the fragment so a
            // retry starts clean and no reader can ever see it.
            @unlink($stored);
            $this->log('verify', 'fail', [
                'reason' => 'persist_mismatch',
                'bucket' => $bucket,
                'path' => $dest,
                'actual_bytes' => $bytes,
                'expected_bytes' => $expectedSize,
            ]);
            throw new ApiException(500, 'The file could not be stored completely. Please try again.', 'persist_mismatch');
        }

        $sha = (string) @hash_file('sha256', $stored);
        $this->log('verify', 'ok', [
            'bucket' => $bucket,
            'path' => $dest,
            'actual_bytes' => $bytes,
            'sha256' => $sha,
        ]);

        return ['path' => $dest, 'size' => $bytes, 'sha256' => $sha];
    }

    /**
     * Measure an object that is ALREADY in storage (used when a material row is
     * written, so `file_size` / the hash cache describe the real bytes rather
     * than whatever the client claimed).
     *
     * THROWS when the object is missing or empty: a row must never be created
     * pointing at nothing — that is the state the incident left behind.
     *
     * @return array{size:int,sha256:string}
     */
    public function inspectStored(string $bucket, string $rel, bool $requirePdf): array
    {
        $abs = $this->absPath($bucket, $rel, $public = in_array($bucket, ['course-images', 'course-covers', 'lesson-thumbnails', 'user-avatars', 'avatars', 'video-thumbnails', 'app-assets'], true));

        if (!is_file($abs)) {
            $this->log('inspect', 'fail', ['reason' => 'missing', 'bucket' => $bucket, 'path' => $rel]);
            throw new ApiException(
                422,
                'The uploaded file could not be found in storage. Please upload it again.',
                'material_file_missing'
            );
        }

        $size = (int) @filesize($abs);
        if ($size <= 0) {
            $this->log('inspect', 'fail', ['reason' => 'empty', 'bucket' => $bucket, 'path' => $rel]);
            throw new ApiException(
                422,
                'The uploaded file is empty (0 bytes) and cannot be attached. Please upload it again.',
                'material_file_empty'
            );
        }

        if ($requirePdf) {
            $this->assertPdf($abs, $bucket);
        }

        unset($public);
        return ['size' => $size, 'sha256' => (string) @hash_file('sha256', $abs)];
    }

    /** Absolute path of a stored object (public or private root). */
    private function absPath(string $bucket, string $rel, bool $public): string
    {
        return $public
            ? $this->storage->publicFilePath($bucket, $rel)
            : $this->storage->privateFilePath($bucket, $rel);
    }

    /**
     * Is this upload meant to be a PDF?
     *
     * Extension, declared MIME and the actual first bytes are all considered, so
     * a PDF uploaded without an extension is still validated and an HTML file
     * *named* `.pdf` is still caught.
     *
     * @param array<string,mixed> $file
     */
    private function looksLikePdf(array $file, string $dest, string $tmp): bool
    {
        $name = strtolower((string) ($dest !== '' ? $dest : ($file['name'] ?? '')));
        if (str_ends_with($name, '.pdf')) {
            return true;
        }
        $mime = strtolower((string) ($file['type'] ?? ''));
        if ($mime === 'application/pdf' || str_contains($mime, 'pdf')) {
            return true;
        }
        $head = (string) @file_get_contents($tmp, false, null, 0, 5);
        return $head === '%PDF-';
    }

    /** Validate PDF structure + parseability; rethrows with a stable code. */
    private function assertPdf(string $abs, string $bucket): void
    {
        try {
            $this->pdf->inspect($abs);
            $this->log('pdf', 'ok', ['bucket' => $bucket, 'bytes' => (int) @filesize($abs)]);
        } catch (ApiException $e) {
            $this->log('pdf', 'fail', [
                'reason' => (string) ($e->errors[0] ?? 'pdf_invalid'),
                'bucket' => $bucket,
                'bytes' => (int) @filesize($abs),
            ]);
            throw $e;
        } catch (Throwable $e) {
            $this->log('pdf', 'fail', [
                'reason' => 'pdf_validate_error',
                'bucket' => $bucket,
                'error' => $e->getMessage(),
            ]);
            throw new ApiException(422, 'This PDF could not be validated.', 'pdf_invalid', $e);
        }
    }

    /**
     * One structured line per stage. Sanitised by the logger (no credentials
     * ever reach disk) and deliberately free of document content.
     *
     * @param array<string,mixed> $context
     */
    public function log(string $stage, string $result, array $context = []): void
    {
        try {
            Logger::instance()->info('storage-upload', [
                'op' => $this->opId,
                'stage' => $stage,
                'result' => $result,
            ] + $context);
        } catch (Throwable) {
            // Diagnostics must never fail an upload.
        }
    }
}
