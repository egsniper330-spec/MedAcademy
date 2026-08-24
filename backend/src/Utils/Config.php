<?php

declare(strict_types=1);

namespace MedAcademy\Utils;

/**
 * Central configuration accessor. All values come from the environment
 * (.env on the server, or real env vars). Never hard-code secrets here.
 */
final class Config
{
    private static array $cache = [];

    public static function init(): void
    {
        self::$cache = [];
    }

    public static function get(string $key, mixed $default = null): mixed
    {
        if (array_key_exists($key, self::$cache)) {
            return self::$cache[$key];
        }
        $value = $_ENV[$key] ?? getenv($key);
        if ($value === false) {
            $value = null;
        }
        $value ??= $default;
        self::$cache[$key] = $value;
        return $value;
    }

    public static function string(string $key, string $default = ''): string
    {
        $v = self::get($key, $default);
        return is_scalar($v) ? (string) $v : $default;
    }

    public static function int(string $key, int $default = 0): int
    {
        $v = self::get($key, $default);
        return is_numeric($v) ? (int) $v : $default;
    }

    public static function bool(string $key, bool $default = false): bool
    {
        $v = self::get($key, $default);
        if (is_bool($v)) {
            return $v;
        }
        return in_array(strtolower((string) $v), ['1', 'true', 'yes', 'on'], true);
    }

    public static function list(string $key, array $default = []): array
    {
        $v = self::get($key, null);
        if (!is_string($v) || $v === '') {
            return $default;
        }
        return array_values(array_filter(array_map('trim', explode(',', $v))));
    }

    public static function isProduction(): bool
    {
        return self::string('APP_ENV', 'production') === 'production';
    }
}
