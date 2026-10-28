<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Database\Database;
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

    /**
     * Effective cap for lesson attachments.
     *
     * The configured value (LESSON_MATERIAL_MAX_BYTES, default 100 MB) is an
     * INTENT, not a promise: PHP refuses the file part above `upload_max_filesize`
     * before any of this code runs. On shared cPanel that ini value is commonly
     * 2–64 MB, so a 100 MB "allowed" size meant the doctor picked a lecture PDF
     * the host would never accept and got a failure instead of a limit. The
     * effective cap is therefore the SMALLER of the two, and every 413 message
     * states it — so the number the doctor reads is the number the host enforces.
     *
     * An unlimited (`0`/`-1`) or unparseable host value leaves the configured cap
     * in charge.
     */
    public function maxBytes(): int
    {
        $configured = max(1, Config::int('LESSON_MATERIAL_MAX_BYTES', 100 * 1024 * 1024));
        $host = self::iniBytes((string) ini_get('upload_max_filesize'));
        return $host > 0 ? min($configured, $host) : $configured;
    }

    /** Host byte limit from a php.ini shorthand value (0 = unknown/unlimited). */
    private static function iniBytes(string $value): int
    {
        $value = trim($value);
        if ($value === '' || $value === '0' || $value === '-1') {
            return 0;
        }
        $unit = strtolower($value[strlen($value) - 1]);
        $amount = (float) $value;
        $bytes = match ($unit) {
            'g' => $amount * 1024 * 1024 * 1024,
            'm' => $amount * 1024 * 1024,
            'k' => $amount * 1024,
            default => $amount,
        };
        return (int) $bytes;
    }

    /**
     * Validate a `$_FILES` entry BEFORE anything is written to storage.
     *
     * Checks, in order: the PHP upload error, the temp file's existence, the
     * real byte count, the client-declared size (truncation detector), the size
     * cap for attachment buckets, and — for PDFs — the document itself.
     *
     * @param array<string,mixed> $file $_FILES entry
     * @param int $clientDeclaredBytes the size reported for the SELECTED file
     *        (form field `declared_size`), 0 when the client did not send one.
     *        This is the only independent number about "which file was
     *        selected": `$_FILES['size']` is filled by PHP from the received
     *        bytes, so it always equals the temp file and can prove nothing.
     * @param string $declaredSource how the client obtained that number
     *        (`declared_size_source`): 'stat' = measured from the file itself,
     *        'picker' = provider metadata / unknown = a hint. See the size
     *        comparison below — the difference decides whether a divergence
     *        refuses the upload or is only logged.
     * @return array{tmp:string,size:int}
     */
    public function validate(array $file, string $dest, string $bucket, int $clientDeclaredBytes = 0, string $declaredSource = ''): array
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

        // ── THE SELECTED FILE vs THE RECEIVED FILE ────────────────────────────
        // Two questions, and conflating them broke real uploads:
        //
        //   1. TRUNCATION — fewer bytes arrived than the selected file has. The
        //      multipart body stopped early, so the document cannot be complete.
        //      Refused ALWAYS, whatever the declared number's provenance.
        //   2. DIFFERENT FILE — MORE bytes arrived than a MEASURED file has: a
        //      stale cache/`content://` URI, a substituted asset, or a
        //      duplicated/appending transfer (the documented 200 KB → 9.5 MB
        //      shape). Refused only when `declared_size_source=stat`.
        //
        // Why the asymmetry: the declared number used to be the picker's
        // metadata, which is a HINT — Android providers report placeholder,
        // pre-conversion or simply wrong values. Production produced both
        // shapes: a <200 KB pick logged `bytes=9563250`, and a ~140 KB PDF whose
        // refusal quoted 679 bytes. Neither is possible for the file the doctor
        // chose, so refusing on that number alone rejected genuine documents.
        // A hint is now only logged; the bytes are still validated below (empty
        // body, size cap, and the PDF itself), so a substituted file cannot slip
        // through just because its size hint was wrong.
        //
        // Same tolerance as the client's own post-upload check (2 % or 4 KB):
        // some Android providers report a slightly rounded size, and refusing a
        // legitimate 3 MB document over 200 bytes would be worse than useless.
        $declaredSource = $declaredSource === 'stat' ? 'stat' : ($clientDeclaredBytes > 0 ? 'picker' : 'none');

        if ($clientDeclaredBytes > 0 && $size < $clientDeclaredBytes
            && $this->sizeDiverges($clientDeclaredBytes, $size)) {
            $this->log('validate', 'fail', [
                'reason' => 'upload_truncated',
                'bucket' => $bucket,
                'declared_bytes' => $clientDeclaredBytes,
                'actual_bytes' => $size,
                'declared_source' => $declaredSource,
            ] + $this->clientContext($file));
            throw new ApiException(
                400,
                'The upload stopped early (' . $size . ' of ' . $clientDeclaredBytes
                . ' bytes arrived). Please try again.',
                'upload_truncated'
            );
        }

        if ($clientDeclaredBytes > 0 && $declaredSource === 'stat'
            && $size > $clientDeclaredBytes && $this->sizeDiverges($clientDeclaredBytes, $size)) {
            $this->log('validate', 'fail', [
                'reason' => 'client_size_mismatch',
                'bucket' => $bucket,
                'declared_bytes' => $clientDeclaredBytes,
                'actual_bytes' => $size,
                'declared_source' => $declaredSource,
            ] + $this->clientContext($file));
            throw new ApiException(
                400,
                'The file that reached the server (' . $size . ' bytes) is not the file that was selected ('
                . $clientDeclaredBytes . ' bytes). Please pick the document again.',
                'upload_size_mismatch'
            );
        }

        if ($clientDeclaredBytes > 0 && $declaredSource === 'picker'
            && $this->sizeDiverges($clientDeclaredBytes, $size)) {
            // The provider's metadata was wrong and the bytes are what the
            // doctor picked: keep the upload, but leave the evidence in the log
            // so "why did the size say 679?" is answerable.
            $this->log('validate', 'warn', [
                'reason' => 'picker_size_inaccurate',
                'bucket' => $bucket,
                'declared_bytes' => $clientDeclaredBytes,
                'actual_bytes' => $size,
                'declared_source' => $declaredSource,
            ] + $this->clientContext($file));
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
            // `source=upload` + `declared_bytes` on the failure line is what makes
            // an incident answerable: it proves whether the bytes PHP actually
            // received match the size the picker reported, in the SAME request.
            // (The stored-object check below logs `source=stored` instead.)
            $this->assertPdf($tmp, $bucket, 'upload', $clientDeclaredBytes > 0 ? $clientDeclaredBytes : $declared, $file);
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
        // Nothing in this method touches the database: it stats, parses and
        // SHA-256s the stored object. Those are the slowest part of a material
        // write (a hash reads every byte, a parse reads the whole document), and
        // the caller has already finished its own reads — so the connection slot
        // is handed back here and re-opened lazily when the row is written.
        Database::instance()->release();

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
            $this->assertPdf($abs, $bucket, 'stored');
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

    /**
     * Validate PDF structure + parseability; rethrows with a stable code.
     *
     * `$source` says WHICH bytes were inspected, because the two call sites mean
     * very different things and the log line alone could not tell them apart:
     *   • `upload` — the temp file PHP just received (a refusal means the request's
     *     own body was refused; `declared_bytes` shows what the picker claimed);
     *   • `stored` — the object a material row points at (a refusal here means the
     *     upload had SUCCEEDED earlier and the row is what got refused).
     * Without that distinction an operator cannot tell a 9.5 MB rejected upload
     * apart from a 9.5 MB document already in storage that the row check rejected.
     *
     * @param int $declaredBytes what the client said it was sending (0 = unknown)
     */
    private function assertPdf(
        string $abs,
        string $bucket,
        string $source = 'upload',
        int $declaredBytes = 0,
        array $client = [],
    ): void {
        $bytes = is_file($abs) ? (int) @filesize($abs) : 0;
        try {
            $this->pdf->inspect($abs);
            $this->log('pdf', 'ok', ['bucket' => $bucket, 'bytes' => $bytes, 'source' => $source]);
        } catch (ApiException $e) {
            // A bare `bytes` count cannot answer "which document was that?". The
            // failing line therefore also carries the client's filename and MIME
            // type (both already trusted enough to store in the row) and a
            // SHA-256 prefix of the RECEIVED bytes, which the operator can
            // compare with the doctor's local file without exposing content.
            $this->log('pdf', 'fail', [
                'reason' => (string) ($e->errors[0] ?? 'pdf_invalid'),
                'bucket' => $bucket,
                'bytes' => $bytes,
                'source' => $source,
                'declared_bytes' => $declaredBytes,
                'received_sha256' => $this->digestPrefix($abs),
            ] + $this->clientContext($client));
            throw $e;
        } catch (Throwable $e) {
            $this->log('pdf', 'fail', [
                'reason' => 'pdf_validate_error',
                'bucket' => $bucket,
                'bytes' => $bytes,
                'source' => $source,
                'declared_bytes' => $declaredBytes,
                'received_sha256' => $this->digestPrefix($abs),
                'error' => $e->getMessage(),
            ] + $this->clientContext($client));
            throw new ApiException(422, 'This PDF could not be validated.', 'pdf_invalid', $e);
        }
    }

    /**
     * Do a picker-reported size and the received byte count describe the same
     * file?
     *
     * The tolerance is deliberately generous in absolute terms and useless for a
     * wrong-file case: 2 % or 4 KB, whichever is larger. That absorbs provider
     * metadata that is a few KB off (an Android provider rounding a size, a
     * picker reporting the pre-conversion length) while a duplicated, appended
     * or substituted transfer — the 200 KB → 9.5 MB shape — always fails it.
     */
    private function sizeDiverges(int $declared, int $actual): bool
    {
        if ($declared <= 0 || $actual <= 0) {
            return false;
        }
        $tolerance = max(4096, (int) round($declared * 0.02));
        return abs($actual - $declared) > $tolerance;
    }

    /** First 16 hex chars of the object's SHA-256 (never its content). */
    private function digestPrefix(string $abs): string
    {
        if (!is_file($abs)) {
            return '';
        }
        $sha = (string) @hash_file('sha256', $abs);
        return $sha === '' ? '' : substr($sha, 0, 16);
    }

    /**
     * Safe client-supplied descriptors for a diagnostic line: the original
     * filename as a BASENAME (never a path, so no `content://` authority or
     * temporary directory leaks), truncated to a sane length, and the declared
     * MIME type. Neither is trusted for any decision; they exist so an operator
     * can recognise which document a byte count belongs to.
     *
     * @param array<string,mixed> $file
     * @return array<string,string>
     */
    private function clientContext(array $file): array
    {
        $rawName = (string) ($file['name'] ?? '');
        $name = basename(str_replace('\\', '/', $rawName));
        $type = (string) ($file['type'] ?? '');
        return [
            'client_name' => mb_substr($name, 0, 80),
            'client_type' => mb_substr(strtolower($type), 0, 80),
        ];
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
