<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Utils\Config;
use MedAcademy\Utils\Logger;

/**
 * PdfForensicClient — the ONLY caller of the PDF forensic watermark service (VPS).
 *
 * Server-to-server only. The service is never reachable by students, doctors or the
 * mobile app: this class holds the HMAC credentials, and the endpoints it uses are
 * firewall-restricted to this host.
 *
 * Transport contract:
 *   • HTTPS with peer and host verification ALWAYS on. The service uses an internal
 *     CA, so this client pins that CA file. Verification is never disabled to make a
 *     deployment work.
 *   • Every request is signed: HMAC-SHA256 over
 *         METHOD \n PATH?query \n TIMESTAMP \n NONCE \n SHA256(body)
 *     sent as X-Key-Id / X-Timestamp / X-Nonce / X-Signature. The service rejects a
 *     wrong signature, a timestamp outside the skew window, and a replayed nonce.
 *   • Bodies are bounded and responses are validated before use.
 *
 * Nothing here decides WHO may read a document — that stays in the PHP authorization
 * layer (StorageService::canAccess and the delivery controller).
 */
final class PdfForensicClient
{
    private const MAX_SOURCE_BYTES = 52428800;   // 50 MiB, matches the service body limit policy
    private const CONNECT_TIMEOUT = 10;
    private const TIMEOUT_UPLOAD = 120;
    private const TIMEOUT_RENDER = 240;

    /**
     * ONE reusable cURL handle per client instance.
     *
     * The delivery path calls this service several times per document (upload
     * the original, enqueue preprocessing, then poll `/internal/issuances`).
     * Every call used to create a handle, which means a fresh TCP connect AND a
     * fresh TLS handshake each time — hundreds of milliseconds per poll on a
     * cross-region link, repeated up to 80 times. A single easy handle keeps
     * the connection cache alive across requests; `curl_reset()` (which does
     * NOT clear live connections) restores a clean option set before each one.
     *
     * @var \CurlHandle|null
     */
    private $handle = null;

    /** Wall time of the LAST transport call (cURL's own measurement), for staging logs. */
    private float $lastRequestSeconds = 0.0;

    public function __construct(
        private readonly ?string $baseUrl = null,
        private readonly ?string $keyId = null,
        private readonly ?string $secret = null,
        private readonly ?string $caFile = null,
    ) {
    }

    /** True when the integration is switched on and has usable credentials. */
    public static function enabled(): bool
    {
        if (!Config::bool('PDF_FORENSIC_ENABLED', false)) {
            return false;
        }
        return Config::string('PDF_FORENSIC_BASE_URL', '') !== ''
            && Config::string('PDF_FORENSIC_KEY_ID', '') !== ''
            && Config::string('PDF_FORENSIC_SECRET', '') !== '';
    }

    public function baseUrl(): string
    {
        return rtrim($this->baseUrl ?? Config::string('PDF_FORENSIC_BASE_URL', ''), '/');
    }

    private function keyId(): string
    {
        return $this->keyId ?? Config::string('PDF_FORENSIC_KEY_ID', '');
    }

    private function secret(): string
    {
        return $this->secret ?? Config::string('PDF_FORENSIC_SECRET', '');
    }

    private function caFile(): string
    {
        return $this->caFile
            ?? Config::string('PDF_FORENSIC_CA', dirname(__DIR__, 2) . '/config/certs/pdf-wm-ca.crt');
    }

    /**
     * Storage key for one immutable original. The service refuses bytes whose SHA-256
     * does not match the last key segment, so a caller cannot register unchecked content.
     */
    public static function sourceKey(string $materialId, string $versionId, string $sha256): string
    {
        return 'originals/' . $materialId . '/' . $versionId . '/' . $sha256 . '.pdf';
    }

    /** Liveness only. Never throws: a false result means "do not issue through the service". */
    public function healthy(): bool
    {
        try {
            $this->request('GET', '/healthz', [], null, self::CONNECT_TIMEOUT, false);
            return true;
        } catch (\Throwable) {
            return false;
        }
    }

    /**
     * Upload (idempotent) the original PDF FROM DISK. Returns the storage key.
     *
     * The buffered variant below (`uploadOriginal`) needs the whole document as a
     * PHP string: for an 18 MB source that is 18 MB of heap per concurrent
     * delivery, plus a copy inside cURL. This variant streams the file instead —
     * the SHA-256 is computed by `hash_file()` (streamed by PHP, constant memory)
     * and cURL reads the body straight off disk, so the peak extra memory is one
     * cURL read buffer regardless of document size.
     *
     * Integrity is unchanged: the size is bounded, the file must hash to
     * `$sha256` BEFORE a byte is sent, and the service independently refuses any
     * body whose hash does not match the last segment of the key.
     */
    public function uploadOriginalFile(string $materialId, string $versionId, string $sha256, string $path): string
    {
        if (preg_match('/^[0-9a-f]{64}$/', $sha256) !== 1) {
            throw new PdfForensicException('invalid_hash', 'the source hash is not a SHA-256 digest');
        }
        if (!is_file($path) || !is_readable($path)) {
            throw new PdfForensicException('source_unreadable', 'the source PDF is not readable');
        }
        $size = (int) @filesize($path);
        if ($size <= 0) {
            throw new PdfForensicException('source_empty', 'the source PDF is empty');
        }
        if ($size > self::MAX_SOURCE_BYTES) {
            throw new PdfForensicException('source_too_large', 'source PDF exceeds the service limit');
        }
        // Verified by streaming the file, never by loading it into memory.
        if ((string) hash_file('sha256', $path) !== $sha256) {
            throw new PdfForensicException('hash_mismatch', 'source bytes do not match their SHA-256');
        }
        $key = self::sourceKey($materialId, $versionId, $sha256);
        $this->request(
            'POST', '/internal/sources', ['key' => $key], null, self::TIMEOUT_UPLOAD, true,
            ['path' => $path, 'size' => $size, 'sha256' => $sha256]
        );
        return $key;
    }

    /** Upload (idempotent) the original PDF. Returns the storage key the service assigned. */
    public function uploadOriginal(string $materialId, string $versionId, string $sha256, string $bytes): string
    {
        if (strlen($bytes) > self::MAX_SOURCE_BYTES) {
            throw new PdfForensicException('source_too_large', 'source PDF exceeds the service limit');
        }
        if (hash('sha256', $bytes) !== $sha256) {
            throw new PdfForensicException('hash_mismatch', 'source bytes do not match their SHA-256');
        }
        $key = self::sourceKey($materialId, $versionId, $sha256);
        $this->request('POST', '/internal/sources', ['key' => $key], $bytes, self::TIMEOUT_UPLOAD);
        return $key;
    }

    /** Enqueue (idempotent) master-page rendering for an already uploaded original. */
    public function enqueuePreprocess(string $materialId, string $versionId, string $sourceKey): array
    {
        $body = json_encode([
            'material_id' => $materialId,
            'version_id' => $versionId,
            'source_key' => $sourceKey,
        ], JSON_UNESCAPED_SLASHES);
        return $this->json('POST', '/internal/masters/preprocess', [], (string) $body, self::TIMEOUT_RENDER);
    }

    /**
     * Request one personalized copy. The service coalesces identical requests, reuses a live
     * copy without extending its expiry, and returns 202 while an identical generation runs.
     *
     * @param array{student_ref:string,doctor_ref:string,material_id:string,version_id:string,course_ref:string,source_sha256:string} $identity
     * @return array{status:string,id?:string,reused?:bool,expires_at?:int,storage_key?:string,file_sha256?:string,retry_after_seconds?:int}
     */
    public function issue(array $identity): array
    {
        $body = json_encode($identity, JSON_UNESCAPED_SLASHES);
        $response = $this->request('POST', '/internal/issuances', [], (string) $body, self::TIMEOUT_RENDER, true);
        if ($response['status'] === 202) {
            return ['status' => 'pending', 'retry_after_seconds' => (int) ($response['json']['retry_after_seconds'] ?? 5)];
        }
        $json = $response['json'] ?? [];
        if (!is_array($json) || ($json['status'] ?? '') !== 'ready' || !isset($json['storage_key'])) {
            throw new PdfForensicException('invalid_response', 'issuance response is not usable');
        }
        return $json;
    }

    /**
     * Ask the service to read the forensic payload from a suspect PDF.
     *
     * @return array{verdict:string,payload:?int,score:float,agreement:float,pages_analyzed:int,pages_total:int,payload_votes:int}
     */
    public function detect(string $pdfBytes): array
    {
        if (!str_starts_with($pdfBytes, '%PDF-')) {
            throw new PdfForensicException('not_a_pdf', 'the uploaded file is not a PDF');
        }
        $response = $this->request('POST', '/internal/detect', [], $pdfBytes, self::TIMEOUT_RENDER, true);
        $json = $response['json'];
        if (!is_array($json) || !isset($json['verdict'])) {
            throw new PdfForensicException('invalid_response', 'detection returned no verdict');
        }
        return $json;
    }

    /**
     * Same as detect(), but the PDF is STREAMED from the uploaded temporary file.
     *
     * `detect()` needs the whole document in PHP memory: the body string is hashed for the
     * HMAC and then handed to cURL. For a 25 MB inspector upload that is 25 MB of PHP heap
     * plus a copy inside cURL — per concurrent check. This variant never loads the document:
     * the magic header is checked from the first 5 bytes, the SHA-256 comes from hash_file()
     * (streamed by PHP), and cURL reads the body straight off disk with an upload stream.
     *
     * The signature is IDENTICAL to the buffered path (same canonical string, same payload
     * hash), so the service cannot tell the two apart — only memory and copies change.
     *
     * @return array{verdict:string,payload:?int,score:float,agreement:float,pages_analyzed:int,pages_total:int,payload_votes:int}
     */
    public function detectFile(string $path, ?string $sha256 = null): array
    {
        if (!is_file($path) || !is_readable($path)) {
            throw new PdfForensicException('not_a_pdf', 'the uploaded file is not readable');
        }
        $handle = @fopen($path, 'rb');
        if ($handle === false) {
            throw new PdfForensicException('not_a_pdf', 'the uploaded file is not readable');
        }
        $magic = (string) fread($handle, 5);
        fclose($handle);
        if ($magic !== '%PDF-') {
            throw new PdfForensicException('not_a_pdf', 'the uploaded file is not a PDF');
        }
        $size = (int) filesize($path);
        if ($size <= 0) {
            throw new PdfForensicException('not_a_pdf', 'the uploaded file is empty');
        }
        // The caller may already have hashed this exact file (the controller does,
        // for its audit record). Reusing that digest avoids a SECOND full read of
        // an 18 MB upload; when it is absent we stream the file ourselves.
        $sha = $sha256 !== null && preg_match('/^[0-9a-f]{64}$/', $sha256) === 1
            ? $sha256
            : hash_file('sha256', $path);
        if (!is_string($sha) || $sha === '') {
            throw new PdfForensicException('not_a_pdf', 'the uploaded file could not be hashed');
        }
        $response = $this->request(
            'POST', '/internal/detect', [], null, self::TIMEOUT_RENDER, true,
            ['path' => $path, 'size' => $size, 'sha256' => $sha]
        );
        $json = $response['json'];
        if (!is_array($json) || !isset($json['verdict'])) {
            throw new PdfForensicException('invalid_response', 'detection returned no verdict');
        }
        return $json;
    }

    /** Fetch the issued PDF bytes for a key the service handed back. */
    public function download(string $storageKey): string
    {
        if (!str_starts_with($storageKey, 'issued/')) {
            throw new PdfForensicException('invalid_key', 'only issued/ keys can be downloaded');
        }
        $response = $this->request('GET', '/internal/files', ['key' => $storageKey], null, self::TIMEOUT_UPLOAD);
        $bytes = $response['body'];
        $expected = $response['headers']['x-file-sha256'] ?? null;
        if (!is_string($bytes) || $bytes === '' || !str_starts_with($bytes, '%PDF-')) {
            throw new PdfForensicException('invalid_response', 'download did not return a PDF');
        }
        if (is_string($expected) && hash('sha256', $bytes) !== $expected) {
            throw new PdfForensicException('hash_mismatch', 'downloaded PDF does not match its SHA-256');
        }
        return $bytes;
    }

    /** Seconds the most recent transport call took end-to-end (PHP → service). */
    public function lastRequestSeconds(): float
    {
        return $this->lastRequestSeconds;
    }

    /**
     * The instance's reusable handle, created on first use.
     *
     * Returns null only when cURL is unavailable. Every option is set per request
     * after `curl_reset()`, so a handle shared between an upload and a JSON poll
     * cannot inherit the wrong body or method.
     *
     * @return \CurlHandle|null
     */
    private function curlHandle()
    {
        if ($this->handle === null) {
            $created = curl_init();
            $this->handle = $created === false ? null : $created;
        }
        return $this->handle;
    }

    /** Release the pooled connection with the client. */
    public function __destruct()
    {
        if ($this->handle !== null) {
            @curl_close($this->handle);
            $this->handle = null;
        }
    }

    /** JSON helper that requires a 2xx and decodes the body. */
    private function json(string $method, string $path, array $query, ?string $body, int $timeout): array
    {
        $response = $this->request($method, $path, $query, $body, $timeout, true);
        $json = $response['json'] ?? null;
        if (!is_array($json)) {
            throw new PdfForensicException('invalid_response', 'service returned no JSON');
        }
        return $json;
    }

    /**
     * Signed request. Throws PdfForensicException on transport or protocol failure; never
     * logs the secret, the signature or document bytes.
     */
    private function request(
        string $method,
        string $path,
        array $query,
        ?string $body,
        int $timeout,
        bool $signed = true,
        ?array $stream = null,
    ): array {
        $base = $this->baseUrl();
        if ($base === '') {
            throw new PdfForensicException('not_configured', 'PDF_FORENSIC_BASE_URL is not set');
        }
        $queryString = $query === [] ? '' : '?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986);
        $pathWithQuery = $path . $queryString;
        $payload = $body ?? '';

        $headers = ['Accept: application/json'];
        if ($body !== null || $stream !== null) {
            $headers[] = 'Content-Type: application/pdf';
        }
        if ($signed) {
            $keyId = $this->keyId();
            $secret = $this->secret();
            if ($keyId === '' || strlen($secret) < 32) {
                throw new PdfForensicException('not_configured', 'forensic HMAC credentials are missing');
            }
            $timestamp = (string) time();
            $nonce = bin2hex(random_bytes(16));
            $canonical = implode("\n", [
                strtoupper($method),
                $pathWithQuery,
                $timestamp,
                $nonce,
                $stream['sha256'] ?? hash('sha256', $payload),
            ]);
            $headers[] = 'X-Key-Id: ' . $keyId;
            $headers[] = 'X-Timestamp: ' . $timestamp;
            $headers[] = 'X-Nonce: ' . $nonce;
            $headers[] = 'X-Signature: ' . hash_hmac('sha256', $canonical, $secret);
        }

        $ch = $this->curlHandle();
        if ($ch === null) {
            throw new PdfForensicException('transport', 'could not initialise HTTP client');
        }
        // A clean option set on the KEPT handle: options never leak between
        // calls (an upload stream from a previous request cannot become the body
        // of the next one), while the connection cache survives.
        curl_reset($ch);
        curl_setopt($ch, CURLOPT_URL, $base . $pathWithQuery);
        $responseHeaders = [];
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST => strtoupper($method),
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_CONNECTTIMEOUT => self::CONNECT_TIMEOUT,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_FOLLOWLOCATION => false,
            // Keep the TCP connection pooled for the next call in this request
            // (the issue/poll loop makes several); the body read below is a
            // stream, so reuse never interacts with a rewritten request.
            CURLOPT_TCP_KEEPALIVE => 1,
            // TLS verification stays ON; the internal CA is pinned by file.
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_CAINFO => $this->caFile(),
            CURLOPT_HEADERFUNCTION => static function ($handle, string $line) use (&$responseHeaders): int {
                $parts = explode(':', $line, 2);
                if (count($parts) === 2) {
                    $responseHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
                }
                return strlen($line);
            },
        ]);
        $readHandle = null;
        if ($stream !== null) {
            // POST with the body read straight off disk: cURL streams the file, so the
            // document is never copied into PHP memory or into a cURL buffer.
            $readHandle = @fopen((string) $stream['path'], 'rb');
            if ($readHandle === false) {
                // The handle stays open for reuse; only the options are stale.
                throw new PdfForensicException('not_a_pdf', 'the uploaded file is not readable');
            }
            curl_setopt($ch, CURLOPT_UPLOAD, true);
            curl_setopt($ch, CURLOPT_INFILE, $readHandle);
            curl_setopt($ch, CURLOPT_INFILESIZE, (int) $stream['size']);
            curl_setopt($ch, CURLOPT_CUSTOMREQUEST, 'POST');
        } elseif ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }
        $raw = curl_exec($ch);
        $errno = curl_errno($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $this->lastRequestSeconds = (float) curl_getinfo($ch, CURLINFO_TOTAL_TIME);
        if (is_resource($readHandle)) {
            fclose($readHandle);
        }

        if ($errno !== 0 || !is_string($raw)) {
            Logger::instance()->warning('pdf-forensic-transport', [
                'path' => $path, 'curl_errno' => $errno, 'status' => $status,
            ]);
            throw new PdfForensicException('transport', 'forensic service is unreachable (' . $errno . ')');
        }
        if ($status >= 400) {
            $decoded = json_decode($raw, true);
            $code = is_array($decoded) ? (string) ($decoded['error'] ?? 'http_' . $status) : 'http_' . $status;
            throw new PdfForensicException($code, 'forensic service rejected the request (' . $status . ')');
        }
        return [
            'status' => $status,
            'body' => $raw,
            'headers' => $responseHeaders,
            'json' => $status === 202 || $status === 200 ? json_decode($raw, true) : null,
        ];
    }
}
