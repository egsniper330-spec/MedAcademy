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
     * Stream a file from disk without loading it into memory.
     *
     * `raw()` takes the whole body as a string, which doubles the peak memory of
     * every download (a 40 MB PDF became 80 MB+ of PHP memory). Lesson PDFs can
     * be large and several students may fetch them at once, so the response is
     * written in chunks with a Content-Length, and any output buffering is
     * discarded first so partially echoed bytes cannot corrupt the PDF.
     *
     * @param array<string,string> $headers
     */
    public static function file(string $path, string $contentType = 'application/octet-stream', array $headers = []): never
    {
        $size = @filesize($path);
        $handle = @fopen($path, 'rb');
        if ($handle === false) {
            self::error('File not found', 404, 'not_found');
        }

        http_response_code(200);
        header('Content-Type: ' . $contentType);
        if ($size !== false) {
            header('Content-Length: ' . $size);
        }
        foreach ($headers as $k => $v) {
            header($k . ': ' . $v);
        }

        // Anything already buffered would be prepended to the binary body.
        while (ob_get_level() > 0) {
            @ob_end_clean();
        }
        while (!feof($handle)) {
            $chunk = fread($handle, 262144);
            if ($chunk === false || $chunk === '') {
                break;
            }
            echo $chunk;
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
