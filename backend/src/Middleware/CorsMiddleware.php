<?php

declare(strict_types=1);

namespace MedAcademy\Middleware;

use MedAcademy\Utils\Config;

/**
 * CORS. Native mobile apps send no Origin header and are always allowed.
 * Browser origins must be listed in CORS_ALLOWED_ORIGINS.
 */
final class CorsMiddleware
{
    public function handle(): void
    {
        $origin = $_SERVER['HTTP_ORIGIN'] ?? null;
        $allowed = Config::list('CORS_ALLOWED_ORIGINS', []);

        if ($origin === null) {
            return; // native app / curl
        }

        $allowOrigin = in_array($origin, $allowed, true) ? $origin : (in_array('*', $allowed, true) ? '*' : null);
        if ($allowOrigin === null) {
            return; // unknown origin: respond without CORS headers (browser blocks)
        }

        header('Access-Control-Allow-Origin: ' . $allowOrigin);
        header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
        header('Access-Control-Allow-Headers: Authorization, Content-Type, X-Idempotency-Key, X-Upload-Id, X-Chunk-Index, X-Total-Chunks, X-Chunk-Size, X-File-Name, X-Mime-Type');
        header('Access-Control-Max-Age: 86400');

        if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
            http_response_code(204);
            exit;
        }
    }
}
