<?php

declare(strict_types=1);

namespace MedAcademy\Http;

use MedAcademy\Utils\Json;

final class Request
{
    private array $body;
    private array $query;
    private string $path;
    private string $method;
    private array $headers;

    /** @var array<string,mixed> resolved route params ({id} etc.) */
    public array $params = [];

    /** @var array<string,mixed> authenticated user context (set by AuthMiddleware) */
    public array $user = [];

    private function __construct()
    {
        $this->method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
        $rawPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
        // Strip front-controller filename (e.g. /index.php/courses → /courses)
        // so routes always match against the clean path.
        if (preg_match('#/[^/]+\.php(/.*)$#', $rawPath, $m)) {
            $rawPath = $m[1] ?: '/';
        }
        $this->path = $rawPath;
        $this->query = $_GET;
        $this->headers = self::extractHeaders();
        $raw = file_get_contents('php://input') ?: '';
        $this->body = Json::decode($raw);
        if ($this->body === []) {
            // allow form-encoded for tooling convenience
            if (($this->headers['content-type'] ?? '') === 'application/x-www-form-urlencoded') {
                $this->body = $_POST;
            }
        }
    }

    public static function capture(): self
    {
        return new self();
    }

    private static function extractHeaders(): array
    {
        $headers = [];
        foreach ($_SERVER as $key => $value) {
            if (str_starts_with($key, 'HTTP_')) {
                $name = strtolower(str_replace('_', '-', substr($key, 5)));
                $headers[$name] = (string) $value;
            }
        }
        $headers['content-type'] = $_SERVER['CONTENT_TYPE'] ?? '';
        return $headers;
    }

    public function method(): string
    {
        return $this->method;
    }

    public function path(): string
    {
        return $this->path;
    }

    public function header(string $name, ?string $default = null): ?string
    {
        return $this->headers[strtolower($name)] ?? $default;
    }

    public function bearerToken(): ?string
    {
        $auth = $this->header('authorization');
        if ($auth !== null && preg_match('/^Bearer\s+(.+)$/i', $auth, $m)) {
            return trim($m[1]);
        }
        return null;
    }

    public function json(): array
    {
        return $this->body;
    }

    public function input(string $key, mixed $default = null): mixed
    {
        return $this->body[$key] ?? $default;
    }

    public function has(string $key): bool
    {
        return array_key_exists($key, $this->body);
    }

    public function query(string $key, mixed $default = null): mixed
    {
        return $this->query[$key] ?? $default;
    }

    public function clientIp(): string
    {
        // trusted proxy headers must only be honoured behind a known proxy;
        // for cPanel direct-PHP this is safe enough.
        return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    }

    public function userAgent(): string
    {
        return (string) ($_SERVER['HTTP_USER_AGENT'] ?? '');
    }

    public function platform(): string
    {
        $ua = $this->userAgent();
        if (stripos($ua, 'android') !== false) {
            return 'android';
        }
        if (stripos($ua, 'iphone') !== false || stripos($ua, 'ipad') !== false || stripos($ua, 'ios') !== false) {
            return 'ios';
        }
        return 'web';
    }

    /**
     * Read a raw uploaded file (multipart).
     */
    public function file(string $key): ?array
    {
        return $_FILES[$key] ?? null;
    }
}
