<?php

declare(strict_types=1);

namespace MedAcademy\Http;

use MedAcademy\Utils\Json;

final class Response
{
    public static function json(mixed $data, int $status = 200, array $headers = []): never
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        foreach ($headers as $k => $v) {
            header($k . ': ' . $v);
        }
        echo Json::encode($data);
        exit;
    }

    public static function raw(string $body, int $status = 200, string $contentType = 'application/octet-stream', array $headers = []): never
    {
        http_response_code($status);
        header('Content-Type: ' . $contentType);
        foreach ($headers as $k => $v) {
            header($k . ': ' . $v);
        }
        echo $body;
        exit;
    }

    /**
     * Parse a single-range byte request.
     *
     * Returns NULL when there is nothing to honour (absent header, several
     * ranges, a syntactically broken header): the whole file is then served, which
     * is always a valid HTTP answer. Returns FALSE when the range is a syntactically
     * valid request that cannot be satisfied (start beyond the end) — that must be a
     * 416, never a silent full body. Otherwise `[startInclusive, endInclusive]`.
     *
     * Pure and side-effect free so it can be tested without a response.
     *
     * @return array{0:int,1:int}|false|null
     */
    public static function parseRange(string $header, int $size): array|false|null
    {
        $header = trim($header);
        if ($header === '' || $size <= 0) {
            return null;
        }
        if (preg_match('/^bytes\s*=\s*(.+)$/i', $header, $m) !== 1) {
            return null;
        }
        $spec = trim($m[1]);
        // Multiple ranges would need a multipart/byteranges body. Serving the whole
        // file instead is correct and is what every client tolerates.
        if (str_contains($spec, ',')) {
            return null;
        }
        if (preg_match('/^(\d*)\s*-\s*(\d*)$/', $spec, $r) !== 1) {
            return null;
        }
        $startRaw = $r[1];
        $endRaw = $r[2];
        if ($startRaw === '' && $endRaw === '') {
            return null;
        }

        if ($startRaw === '') {
            // Suffix range: the LAST n bytes.
            $suffix = (int) $endRaw;
            if ($suffix <= 0) {
                return false;
            }
            $start = max(0, $size - $suffix);
            return [$start, $size - 1];
        }

        $start = (int) $startRaw;
        if ($start >= $size) {
            return false;
        }
        $end = $endRaw === '' ? $size - 1 : (int) $endRaw;
        if ($end < $start) {
            return null;
        }
        return [$start, min($end, $size - 1)];
    }

    /**
     * Stream a file from disk without loading it into memory.
     *
     * `raw()` takes the whole body as a string, which doubles the peak memory of
     * every download (a 40 MB PDF became 80 MB+ of PHP memory) and — more
     * importantly for perceived speed — makes TIME TO FIRST BYTE equal to the time
     * needed to read the WHOLE file: nothing is sent until the last byte is in
     * the PHP heap. Streaming starts answering immediately, which is what makes a
     * transfer feel like it is progressing (measured in
     * `backend/tests/http/byte_range_tests.php`).
     *
     * Range support is what turns a 25 MB download into something a client can
     * resume, retry a failed piece of, or preview partially. Without
     * `Accept-Ranges` a mobile file-system download has to start over from zero
     * after any interruption.
     *
     * @param array<string,string> $headers
     */
    public static function file(
        string $path,
        string $contentType = 'application/octet-stream',
        array $headers = [],
        bool $allowRanges = true
    ): never {
        $size = @filesize($path);
        $mtime = @filemtime($path);
        $handle = @fopen($path, 'rb');
        if ($handle === false) {
            self::error('File not found', 404, 'not_found');
        }

        $bytes = $size === false ? null : (int) $size;
        $start = 0;
        $end = $bytes !== null ? $bytes - 1 : null;
        $partial = false;

        if ($allowRanges && $bytes !== null && $bytes > 0) {
            $range = self::parseRange((string) ($_SERVER['HTTP_RANGE'] ?? ''), $bytes);
            if ($range === false) {
                fclose($handle);
                header('Content-Range: bytes */' . $bytes);
                header('Accept-Ranges: bytes');
                self::error('Requested range not satisfiable', 416, 'range_not_satisfiable');
            }
            if (is_array($range)) {
                [$start, $end] = $range;
                $partial = true;
            }
        }

        http_response_code($partial ? 206 : 200);
        header('Content-Type: ' . $contentType);
        // Advertised on EVERY response so a client knows it may retry a piece
        // instead of re-downloading the document.
        header('Accept-Ranges: bytes');
        if ($start > 0 || $partial) {
            header('Content-Range: bytes ' . $start . '-' . $end . '/' . $bytes);
        }
        if ($partial) {
            header('Content-Length: ' . ($end - $start + 1));
        } elseif ($bytes !== null) {
            header('Content-Length: ' . $bytes);
        }
        if ($mtime !== false) {
            header('Last-Modified: ' . gmdate('D, d M Y H:i:s', (int) $mtime) . ' GMT');
            // Weak-free strong validator: identical bytes for identical (size, mtime).
            header('ETag: "' . dechex((int) $bytes) . '-' . dechex((int) $mtime) . '"');
        }
        foreach ($headers as $k => $v) {
            header($k . ': ' . $v);
        }

        // Anything already buffered would be prepended to the binary body.
        while (ob_get_level() > 0) {
            @ob_end_clean();
        }
        if ($start > 0) {
            @fseek($handle, $start);
        }
        $remaining = $end === null ? null : ($end - $start + 1);
        while (!feof($handle)) {
            $want = 262144;
            if ($remaining !== null) {
                if ($remaining <= 0) {
                    break;
                }
                $want = min($want, $remaining);
            }
            $chunk = fread($handle, $want);
            if ($chunk === false || $chunk === '') {
                break;
            }
            echo $chunk;
            if ($remaining !== null) {
                $remaining -= strlen($chunk);
            }
            flush();
        }
        fclose($handle);
        exit;
    }

    /**
     * Consistent error envelope: {"error": {"message": ..., "code": ..., "errors": [...]}}
     *
     * $meta merges extra key/value pairs into the error object (used in debug
     * mode to surface exception class/file/line without changing the envelope).
     */
    public static function error(string $message, int $status = 400, string $code = 'error', array $errors = [], array $meta = []): never
    {
        $payload = ['error' => ['message' => $message, 'code' => $code]];
        if ($errors !== []) {
            $payload['error']['errors'] = $errors;
        }
        foreach ($meta as $k => $v) {
            $payload['error'][$k] = $v;
        }
        self::json($payload, $status);
    }
}
