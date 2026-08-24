<?php

declare(strict_types=1);

namespace MedAcademy\Utils;

final class Uuid
{
    /**
     * RFC 4122 v4 UUID (lowercase hex string — matches CHAR(36) storage).
     */
    public static function v4(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
        $hex = bin2hex($bytes);
        return sprintf(
            '%s-%s-%s-%s-%s',
            substr($hex, 0, 8),
            substr($hex, 8, 4),
            substr($hex, 12, 4),
            substr($hex, 16, 4),
            substr($hex, 20, 12)
        );
    }

    public static function isValid(string $uuid): bool
    {
        return (bool) preg_match(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i',
            $uuid
        );
    }

    /**
     * Normalise a UUID to lowercase; throws 400 if malformed.
     */
    public static function normalize(string $uuid): string
    {
        $uuid = strtolower(trim($uuid));
        if (!self::isValid($uuid)) {
            throw new \MedAcademy\Http\ApiException(400, 'Invalid UUID: ' . $uuid);
        }
        return $uuid;
    }
}
