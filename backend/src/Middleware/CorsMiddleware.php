<?php

declare(strict_types=1);

namespace MedAcademy\Middleware;

use MedAcademy\Utils\Config;

/**
 * CORS. Native mobile apps send no Origin header and are always allowed.
 *
 * Browser origins must be listed in CORS_ALLOWED_ORIGINS. In addition, the
 * exact loopback origins used by the Expo web preview are allowed by default
 * (CORS_ALLOW_DEV_ORIGINS=false disables them). They are an explicit, closed
 * list — never a pattern and never a reflected Origin — so a page served by
 * an unrelated host cannot obtain an Access-Control-Allow-Origin header.
 *
 * Authentication is bearer-token based (Authorization header) and the clients
 * use credentials: 'omit' / withCredentials = false, so
 * Access-Control-Allow-Credentials is deliberately NOT sent. Adding it would
 * only widen what a browser may attach to cross-origin requests.
 */
final class CorsMiddleware
{
    /**
     * Exact loopback origins served by the Expo web dev server / preview.
     * 8081 is the documented dev port; 8082 is the port used by the current
     * preview. Both loopback spellings are listed because the browser sends
     * whichever host the page was loaded from.
     */
    private const DEV_ORIGINS = [
        'http://localhost:8081',
        'http://127.0.0.1:8081',
        'http://localhost:8082',
        'http://127.0.0.1:8082',
    ];

    /** Methods the API actually exposes (see routes/api.php). */
    private const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';

    /**
     * Request headers the clients actually send. Custom app-identity headers
     * (X-App-Platform, X-App-Version-Code) are native-only and are therefore
     * intentionally absent: listing them would invite the web client to send
     * headers its preflight does not need.
     */
    private const ALLOWED_HEADERS = 'Authorization, Accept, Content-Type, X-Idempotency-Key, '
        . 'X-Upload-Id, X-Chunk-Index, X-Total-Chunks, X-Chunk-Size, X-File-Name, X-Mime-Type';

    public function handle(): void
    {
        $origin = $_SERVER['HTTP_ORIGIN'] ?? null;
        $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));

        // A response negotiated for one origin must never be reused for
        // another (and a shared cache must not serve a CORS-enabled body to an
        // origin that was never allowed). Vary is set on every response, not
        // only the ones that receive CORS headers.
        header('Vary: Origin');

        if ($origin === null || $origin === '') {
            // Native app / curl: CORS does not apply.
            if ($method === 'OPTIONS') {
                http_response_code(204);
                exit;
            }
            return;
        }

        $normalized = self::normalizeOrigin($origin);

        // Unknown origin: answer the preflight without CORS headers (the
        // browser blocks it) but never let OPTIONS fall through to the router,
        // which would answer "Route not found: OPTIONS …" and mask the real
        // cause during diagnosis.
        if ($normalized === null || !in_array($normalized, self::allowedOrigins(), true)) {
            if ($method === 'OPTIONS') {
                http_response_code(204);
                exit;
            }
            return;
        }

        // Echo the canonical origin from the allow-list, never the raw header.
        header('Access-Control-Allow-Origin: ' . $normalized);
        header('Access-Control-Allow-Methods: ' . self::ALLOWED_METHODS);
        header('Access-Control-Allow-Headers: ' . self::ALLOWED_HEADERS);
        // Lets the portal read Retry-After on a 429 from a cross-origin fetch.
        // Content-Length is exposed so a browser can compute REAL download progress
        // (bytes received / total). It used to be hidden cross-origin, which is why the
        // web client could not report progress and showed a fixed 15 % placeholder
        // instead (see src/lib/pdfDeliveryProgress.ts). Only sizes and the download
        // filename are revealed — no identity, no token, no document content.
        header('Access-Control-Expose-Headers: Retry-After, Content-Length, Content-Disposition, Content-Type');
        header('Access-Control-Max-Age: 86400');

        if ($method === 'OPTIONS') {
            // Preflight is answered before authentication and before routing,
            // so it can never require a token.
            http_response_code(204);
            exit;
        }
    }

    /**
     * Explicit allow-list: configured origins + the exact loopback dev origins.
     * A "*" entry is ignored on purpose — a wildcard cannot coexist with an
     * origin-echoing policy that must later support credentials, and an
     * explicit list is the only form this middleware will serve.
     *
     * @return array<int,string>
     */
    public static function allowedOrigins(): array
    {
        $origins = [];

        foreach (Config::list('CORS_ALLOWED_ORIGINS', []) as $entry) {
            $normalized = self::normalizeOrigin($entry);
            if ($normalized !== null) {
                $origins[$normalized] = true;
            }
        }

        if (Config::bool('CORS_ALLOW_DEV_ORIGINS', true)) {
            foreach (self::DEV_ORIGINS as $dev) {
                $origins[$dev] = true;
            }
        }

        return array_keys($origins);
    }

    /**
     * Canonical scheme://host[:port] form, or null when the value is not a
     * usable http(s) origin (including "*" and any wildcard/relative value).
     */
    public static function normalizeOrigin(string $origin): ?string
    {
        $origin = trim($origin);
        if ($origin === '' || $origin === '*') {
            return null;
        }

        $parts = parse_url($origin);
        if ($parts === false || !isset($parts['scheme'], $parts['host'])) {
            return null;
        }

        $scheme = strtolower($parts['scheme']);
        if ($scheme !== 'http' && $scheme !== 'https') {
            return null;
        }
        if (isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment'])) {
            return null;
        }

        $host = strtolower($parts['host']);
        // Browsers never send a trailing dot, and a path is not part of an
        // origin ("https://x/" normalises to "https://x").
        $host = rtrim($host, '.');
        if ($host === '') {
            return null;
        }

        $port = isset($parts['port']) ? (int) $parts['port'] : null;
        if ($port !== null && ($port < 1 || $port > 65535)) {
            return null;
        }
        // Drop the scheme's default port so both spellings normalise equally.
        if (($scheme === 'http' && $port === 80) || ($scheme === 'https' && $port === 443)) {
            $port = null;
        }

        $path = $parts['path'] ?? '';
        if ($path !== '' && $path !== '/') {
            return null; // an origin has no path
        }

        return $scheme . '://' . $host . ($port !== null ? ':' . $port : '');
    }
}
