<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Storage\StorageService;
use MedAcademy\Utils\Config;
use MedAcademy\Utils\Logger;
use MedAcademy\Utils\Uuid;

/**
 * MaterialForensicPdfService — decides and produces the personalized copy that the PDF
 * forensic service issues on the VPS.
 *
 * Division of responsibility:
 *   • THIS class (and its caller) decides whether a person may read a document at all.
 *     The backend re-checks access at mint time and again at stream time; a client
 *     never sends a student id.
 *   • The service only embeds an opaque 32-bit payload into the page images and reports
 *     which record it produced. It never learns a name, an e-mail or an id beyond the
 *     opaque refs we choose to send.
 *
 * Reuse and retention:
 *   • The service coalesces identical requests, so two tabs produce ONE copy.
 *   • A ready copy is reused only inside its absolute 24h window. Reads never extend it.
 *   • After expiry the service generates a fresh payload, so a leaked old file points at
 *     the old issuance only.
 *
 * Failure policy: fail closed. If the service is unreachable or the copy cannot be
 * verified, the caller must raise — never fall back to the unwatermarked original.
 */
final class MaterialForensicPdfService
{
    /** Private bucket holding lesson-material PDFs and their personalized copies. */
    public const BUCKET = 'lesson-material-pdfs';

    /** Upper bound for the in-request wait; also capped by PHP's own limits. */
    private const POLL_ATTEMPTS = 80;
    private const POLL_SLEEP_MICROSECONDS = 1500000;

    /** Where "this exact source version was published to the VPS" is remembered. */
    private const SOURCE_MARKER_DIR = '/.forensic-sources';

    /** How long a delivery waits for another one publishing the same source. */
    private const SOURCE_LOCK_WAIT_SECONDS = 20;

    /**
     * Effective wait deadline for ONE delivery request.
     *
     * The web SAPI kills the worker at its own `max_execution_time`, and that
     * value is host-controlled (there is no `.user.ini` override on this
     * account, and CLI reports `0`, which says nothing about FPM). A 120 s wait
     * on a host whose FPM limit is 60 s would be killed mid-generation and
     * surface as a generic 500 instead of the retryable `forensic_pending` the
     * client knows how to handle. So the budget is derived from the runtime
     * limit, leaving headroom for the final download/verify/write step: no
     * spawned process is ever killed by PHP, and the cap is never raised blindly.
     */
    private function pollDeadline(): int
    {
        $limit = (int) ini_get('max_execution_time');
        if ($limit <= 0) {
            $limit = self::POLL_ATTEMPTS * (int) (self::POLL_SLEEP_MICROSECONDS / 1000000);
        }
        // 15 s headroom: after the loop we still download, hash-verify and persist.
        return time() + max(20, min(self::POLL_ATTEMPTS * (int) (self::POLL_SLEEP_MICROSECONDS / 1000000), $limit - 15));
    }

    public function __construct(
        private readonly StorageService $storage = new StorageService(),
        private readonly MaterialPdfVariantService $variants = new MaterialPdfVariantService(),
        private readonly ?PdfForensicClient $client = null,
    ) {
    }

    public static function enabled(): bool
    {
        return PdfForensicClient::enabled();
    }

    private function client(): PdfForensicClient
    {
        return $this->client ?? new PdfForensicClient();
    }

    /** Current valid copy for this student, including the forensic row when present. */
    public function existing(array $material, string $studentId, ?string $variantKey = null): ?array
    {
        $copy = $this->variants->existing($material, $studentId, $variantKey);
        if ($copy === null) {
            return null;
        }
        $forensic = Database::instance()->row(
            'SELECT id, payload, expires_at, status, purged_at
               FROM pdf_forensic_issuances
              WHERE student_id = ? AND material_id = ? AND expires_at > ?
              ORDER BY issued_at DESC LIMIT 1',
            [$studentId, (string) $material['id'], gmdate('Y-m-d H:i:s')]
        );
        if ($forensic === null || ($forensic['purged_at'] ?? null) !== null) {
            // A copy without a live forensic record cannot be attributed, so it must not be
            // served: regenerate instead of delivering an unattributable document.
            return null;
        }
        return $copy + ['forensic' => $forensic];
    }

    /**
     * Produce (or reuse) this student's copy through the forensic service.
     *
     * @return array{storage_path:string,page_count:int,variant_key:string,file_size:int,forensic:array}
     */
    public function ensure(array $material, string $studentId): array
    {
        $identity = $this->variants->identity($material, $studentId);
        $sourceAbs = $this->variants->sourcePath($material);
        if (!is_file($sourceAbs)) {
            throw new ApiException(404, 'The source PDF is missing.');
        }
        // ── NO FULL-FILE MEMORY READ ────────────────────────────────────────
        // `file_get_contents($sourceAbs)` used to pull the entire document into
        // PHP heap (18 MB per concurrent delivery) only to hash it and hand it to
        // cURL — which copied it again. The digest now comes from the STREAMED,
        // hash-and-cache path the variant registry already uses (`hash_file()`
        // under the hood, cached per path/size/mtime on the material row), and
        // the upload streams the file from disk. Peak extra memory is one read
        // buffer, whatever the document size.
        $size = (int) @filesize($sourceAbs);
        if ($size <= 0) {
            throw new ApiException(422, 'The source PDF could not be read.');
        }
        $sourceHash = $this->variants->sourceHashFor($material, $sourceAbs);
        if (preg_match('/^[0-9a-f]{64}$/', $sourceHash) !== 1) {
            throw new ApiException(422, 'The source PDF could not be read.');
        }
        $materialId = (string) $material['id'];
        $courseId = (string) ($material['course_id'] ?? '');
        if ($courseId === '') {
            throw new ApiException(422, 'This material is not linked to a course.');
        }
        $versionId = substr($sourceHash, 0, 32);
        $doctorId = $this->doctorForCourse($courseId, (string) ($material['uploaded_by'] ?? ''));
        $studentRef = $this->opaqueRef('student', $studentId);
        $doctorRef = $doctorId !== '' ? $this->opaqueRef('doctor', $doctorId) : 'doctor-unknown';
        // The course is part of the cache identity: the same document opened through two
        // courses yields two issuances, so the source course is never lost.
        $courseRef = $this->opaqueRef('course', $courseId);

        $client = $this->client();
        // ── REUSE A READY MASTER INSTEAD OF RE-UPLOADING THE SOURCE ────────
        // Both requests below are idempotent on the service side, but they are
        // not FREE: the upload pushes the whole document again and the preprocess
        // request makes the service re-hash it. Nothing about that work depends
        // on the student, so it is done once per (material, version, source hash)
        // and only repeated when the service proves the pages are gone.
        $result = $this->issueWithReusableMaster($client, [
            'student_ref' => $studentRef,
            'doctor_ref' => $doctorRef,
            'material_id' => $materialId,
            'version_id' => $versionId,
            'course_ref' => $courseRef,
            'source_sha256' => $sourceHash,
        ], $materialId, $versionId, $sourceHash, $sourceAbs);

        $pdf = $client->download((string) $result['storage_key']);
        if (hash('sha256', $pdf) !== (string) $result['file_sha256']) {
            throw new ApiException(503, 'The personalized copy failed verification.', 'forensic_hash_mismatch');
        }
        $rel = $this->variants->relativePath($material, $studentId, (string) $identity['variant_key']);
        $this->storage->writeFile(self::BUCKET, $rel, $pdf, false);
        $pages = (int) ($result['page_count'] ?? 0);
        $this->variants->registerVariant($material, $studentId, $sourceHash,
            (string) $identity['variant_key'], $rel, strlen($pdf), $pages);
        $this->recordIssuance($result, [
            'student_id' => $studentId,
            'doctor_id' => $doctorId,
            'material_id' => $materialId,
            'version_id' => $versionId,
            'course_id' => $courseId,
            'source_sha256' => $sourceHash,
            'storage_path' => $rel,
        ]);

        Logger::instance()->info('pdf-forensic', [
            'event' => !empty($result['reused']) ? 'reused' : 'issued',
            'material_id' => $materialId,
            'issuance_id' => (string) ($result['id'] ?? ''),
            'pages' => $pages,
            'bytes' => strlen($pdf),
        ]);

        return [
            'storage_path' => $rel,
            'page_count' => $pages,
            'variant_key' => (string) $identity['variant_key'],
            'file_size' => strlen($pdf),
            'forensic' => [
                'id' => (string) ($result['id'] ?? ''),
                'payload' => (int) ($result['payload'] ?? 0),
                'expires_at' => gmdate('Y-m-d H:i:s', (int) ($result['expires_at'] ?? 0)),
                'status' => 'ready',
                'purged_at' => null,
            ],
        ];
    }

    /** Count a delivery against the issuance row (does NOT extend expiry). */
    public function recordDownload(string $issuanceId): void
    {
        if ($issuanceId === '') {
            return;
        }
        Database::instance()->query(
            'UPDATE pdf_forensic_issuances
                SET download_count = download_count + 1, last_download_at = ?, updated_at = ?
              WHERE id = ?',
            [gmdate('Y-m-d H:i:s'), gmdate('Y-m-d H:i:s'), $issuanceId]
        );
    }

    /** Opaque, stable, non-reversible reference. No name, e-mail or public id is ever sent. */
    private function opaqueRef(string $kind, string $value): string
    {
        return $kind . '-' . substr(hash('sha256', 'pdf-forensic|' . $kind . '|' . $value), 0, 24);
    }

    private function doctorForCourse(string $courseId, string $fallback): string
    {
        try {
            $row = Database::instance()->row('SELECT doctor_id FROM courses WHERE id = ? LIMIT 1', [$courseId]);
            $doctor = (string) ($row['doctor_id'] ?? '');
            return $doctor !== '' ? $doctor : $fallback;
        } catch (\Throwable) {
            return $fallback;
        }
    }

    /**
     * Publish this exact source version to the service ONCE, then issue.
     *
     * WHY A MARKER AND NOT JUST THE DATABASE ROW
     * ─────────────────────────────────────────
     * `pdf_forensic_issuances` proves a copy was issued — it does NOT prove the
     * service still holds the reusable master pages. They are two different
     * objects with different lifetimes (the master never expires; a personalized
     * copy expires after 24 h), and a wiped/redeployed service volume removes
     * masters while the issuance rows remain. So the marker is only a CACHE of
     * "we published these exact bytes", and it is always re-verified by asking
     * for the issuance: if the service answers `master_not_ready`, the marker is
     * dropped and the full upload + preprocess path runs again.
     *
     * The marker names the material, the version AND the full source SHA-256, and
     * its `source_key` is re-derived from those three values. A replaced source
     * gets a new hash → a new version → a different marker, so an old master can
     * never satisfy a new document.
     *
     * @param array<string,string> $identity
     * @return array{status:string,id?:string,storage_key?:string,file_sha256?:string,expires_at?:int,reused?:bool,page_count?:int}
     */
    private function issueWithReusableMaster(
        PdfForensicClient $client,
        array $identity,
        string $materialId,
        string $versionId,
        string $sourceHash,
        string $sourceAbs
    ): array {
        $marker = $this->sourceMarkerPath($materialId, $versionId, $sourceHash);

        if ($this->sourcePublished($marker, $materialId, $versionId, $sourceHash)) {
            try {
                // Fail fast (do not poll) when the master is unexpectedly gone: the
                // right reaction is to re-publish, not to wait out the deadline.
                return $this->awaitIssuance($client, $identity, true);
            } catch (ApiException $e) {
                if (!in_array('forensic_master_missing', $e->errors, true)) {
                    throw $e;
                }
                Logger::instance()->info('pdf-forensic-master', [
                    'event' => 'marker_stale',
                    'material_id' => $materialId,
                    'version_id' => $versionId,
                ]);
                $this->clearSourceMarker($marker);
            }
        }

        $this->publishSource($client, $materialId, $versionId, $sourceHash, $sourceAbs, $marker);

        return $this->awaitIssuance($client, $identity);
    }

    /**
     * Upload the original (streamed from disk) and request preprocessing — once.
     *
     * Concurrent deliveries of the SAME source version are coordinated with an
     * advisory `flock` so N students opening a never-published document do not
     * each push 18 MB and each enqueue the same job. The lock covers ONLY this
     * short publication step, never the personalized generation, so different
     * students of the same material still generate in parallel and each gets its
     * own copy. The VPS enqueue stays idempotent, which is why a lock timeout
     * degrades to "just do it" instead of failing the delivery.
     */
    private function publishSource(
        PdfForensicClient $client,
        string $materialId,
        string $versionId,
        string $sourceHash,
        string $sourceAbs,
        string $marker
    ): void {
        $publish = function () use ($client, $materialId, $versionId, $sourceHash, $sourceAbs, $marker): void {
            // Re-check under the lock: another delivery may have published while
            // this one waited, which is exactly the work we are avoiding.
            if ($this->sourcePublished($marker, $materialId, $versionId, $sourceHash)) {
                return;
            }
            $sourceKey = $client->uploadOriginalFile($materialId, $versionId, $sourceHash, $sourceAbs);
            $client->enqueuePreprocess($materialId, $versionId, $sourceKey);
            $this->markSourcePublished($marker, $materialId, $versionId, $sourceHash, $sourceKey);
            Logger::instance()->info('pdf-forensic-master', [
                'event' => 'published',
                'material_id' => $materialId,
                'version_id' => $versionId,
            ]);
        };

        $dir = $this->storage->privateDir() . '/.watermark-locks';
        $handle = false;
        if (is_dir($dir) || @mkdir($dir, 0775, true) || is_dir($dir)) {
            $handle = @fopen($dir . '/forensic-source-' . hash('sha256', $materialId . '|' . $versionId) . '.lock', 'c');
        }
        if ($handle === false) {
            // No lock available: correctness does not depend on it (both upstream
            // calls are idempotent), so the delivery proceeds instead of failing.
            $publish();
            return;
        }
        $deadline = microtime(true) + max(1, Config::int('PDF_WATERMARK_LOCK_WAIT_SECONDS', self::SOURCE_LOCK_WAIT_SECONDS));
        $locked = false;
        while (true) {
            if (flock($handle, LOCK_EX | LOCK_NB)) {
                $locked = true;
                break;
            }
            if (microtime(true) >= $deadline) {
                break;
            }
            usleep(120000);
        }
        if (!$locked) {
            Logger::instance()->info('pdf-forensic-master', ['event' => 'lock_timeout', 'material_id' => $materialId]);
        }
        try {
            $publish();
        } finally {
            // Released on success, on exception AND on timeout; if the process dies
            // the descriptor closes and the kernel drops the lock, so no stale lock
            // can outlive a request.
            @flock($handle, LOCK_UN);
            fclose($handle);
        }
    }

    /** Absolute path of the publication marker for one exact source version. */
    private function sourceMarkerPath(string $materialId, string $versionId, string $sourceHash): string
    {
        $safeMaterial = preg_replace('/[^A-Za-z0-9-]/', '', $materialId) ?? '';
        return $this->storage->privateDir() . self::SOURCE_MARKER_DIR
            . '/' . $safeMaterial . '/' . $versionId . '/' . $sourceHash . '.json';
    }

    /**
     * True only when the marker names THIS material, version and full hash, and
     * its recorded storage key is the one those three values produce.
     */
    private function sourcePublished(string $marker, string $materialId, string $versionId, string $sourceHash): bool
    {
        if (!is_file($marker)) {
            return false;
        }
        $raw = @file_get_contents($marker);
        if (!is_string($raw) || trim($raw) === '') {
            return false;
        }
        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            return false;
        }
        return ($decoded['material_id'] ?? null) === $materialId
            && ($decoded['version_id'] ?? null) === $versionId
            && ($decoded['source_sha256'] ?? null) === $sourceHash
            && ($decoded['source_key'] ?? null) === PdfForensicClient::sourceKey($materialId, $versionId, $sourceHash);
    }

    /** Write the marker atomically (temp + rename): a reader never sees half a file. */
    private function markSourcePublished(
        string $marker,
        string $materialId,
        string $versionId,
        string $sourceHash,
        string $sourceKey
    ): void {
        $dir = dirname($marker);
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            return; // no cache: the next delivery simply publishes again
        }
        $body = json_encode([
            'material_id' => $materialId,
            'version_id' => $versionId,
            'source_sha256' => $sourceHash,
            'source_key' => $sourceKey,
            'published_at' => gmdate('Y-m-d\TH:i:s\Z'),
        ], JSON_UNESCAPED_SLASHES);
        if ($body === false) {
            return;
        }
        $tmp = $marker . '.' . bin2hex(random_bytes(6)) . '.tmp';
        if (@file_put_contents($tmp, $body . "\n") === false) {
            return;
        }
        if (!@rename($tmp, $marker)) {
            @unlink($tmp);
        }
    }

    private function clearSourceMarker(string $marker): void
    {
        if (is_file($marker)) {
            @unlink($marker);
        }
    }

    /**
     * Poll the service while it reports the same generation in progress.
     *
     * `$reuseOnly` is set when the source was NOT uploaded by this request: a
     * `master_not_ready` answer then means the remembered master is gone, and the
     * caller must re-publish instead of polling a state that will not change.
     */
    private function awaitIssuance(PdfForensicClient $client, array $identity, bool $reuseOnly = false): array
    {
        $last = null;
        $deadline = $this->pollDeadline();
        $attempt = 0;
        while (time() < $deadline) {
            $attempt++;
            try {
                $result = $client->issue($identity);
            } catch (PdfForensicException $e) {
                // master_not_ready: preprocessing is still running for a first request.
                if (in_array($e->code(), ['master_not_ready', 'in_progress'], true)) {
                    if ($e->code() === 'master_not_ready' && $reuseOnly) {
                        throw new ApiException(409, 'The reusable master is missing.', 'forensic_master_missing');
                    }
                    $last = $e->code();
                    usleep(self::POLL_SLEEP_MICROSECONDS);
                    continue;
                }
                throw new ApiException(503, 'The personalized copy could not be prepared.', 'forensic_' . $e->code());
            }
            if (($result['status'] ?? '') === 'ready' && isset($result['storage_key'])) {
                return $result;
            }
            usleep(self::POLL_SLEEP_MICROSECONDS);
        }
        Logger::instance()->warning('pdf-forensic-timeout', ['last' => $last]);
        throw new ApiException(503, 'The personalized copy is still being generated.', 'forensic_pending');
    }

    private function recordIssuance(array $result, array $ctx): void
    {
        $now = gmdate('Y-m-d H:i:s');
        $expires = gmdate('Y-m-d H:i:s', (int) ($result['expires_at'] ?? (time() + 86400)));
        $db = Database::instance();
        try {
            // One live row per (student, material, version, course): refresh it on reuse.
            $db->query(
                'INSERT INTO pdf_forensic_issuances
                    (id, service_issuance_id, payload, student_id, doctor_id, material_id, version_id,
                     course_id, source_sha256, algorithm, config_version, storage_path, file_sha256,
                     status, issued_at, expires_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    service_issuance_id = VALUES(service_issuance_id),
                    payload = VALUES(payload),
                    storage_path = VALUES(storage_path),
                    file_sha256 = VALUES(file_sha256),
                    status = VALUES(status),
                    issued_at = VALUES(issued_at),
                    expires_at = VALUES(expires_at),
                    purged_at = NULL,
                    updated_at = VALUES(updated_at)',
                [
                    Uuid::v4(),
                    (string) ($result['id'] ?? ''),
                    (int) ($result['payload'] ?? 0),
                    $ctx['student_id'],
                    $ctx['doctor_id'] !== '' ? $ctx['doctor_id'] : null,
                    $ctx['material_id'],
                    $ctx['version_id'],
                    $ctx['course_id'],
                    $ctx['source_sha256'],
                    'wam_mit',
                    'wam-mit-v1/pypdfium2-png-v1',
                    $ctx['storage_path'],
                    (string) ($result['file_sha256'] ?? ''),
                    'ready',
                    $now,
                    $expires,
                    $now,
                    $now,
                ]
            );
        } catch (\Throwable $e) {
            // The bytes are already published; losing the mapping would make them
            // unattributable, so surface it loudly instead of serving an orphan copy.
            Logger::instance()->error('pdf-forensic-record-failed', ['error' => get_class($e)]);
            throw new ApiException(503, 'The personalized copy could not be registered.', 'forensic_record_failed');
        }
    }
}
