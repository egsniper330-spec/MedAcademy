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

    public static function raw(string $body, int $status = 200, string $contentType = 'application/octet-stream'): never
    {
        http_response_code($status);
        header('Content-Type: ' . $contentType);
        echo $body;
        exit;
    }

    /**
     * Consistent error envelope: {"error": {"message": ..., "code": ..., "errors": [...]}}
     */
    public static function error(string $message, int $status = 400, string $code = 'error', array $errors = []): never
    {
        $payload = ['error' => ['message' => $message, 'code' => $code]];
        if ($errors !== []) {
            $payload['error']['errors'] = $errors;
        }
        self::json($payload, $status);
    }
}
