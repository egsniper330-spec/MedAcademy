<?php

declare(strict_types=1);

namespace MedAcademy\Utils;

use MedAcademy\Http\ApiException;

final class Json
{
    public static function encode(mixed $value, int $flags = 0): string
    {
        $flags |= JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE;
        $json = json_encode($value, $flags);
        if ($json === false) {
            throw new ApiException(500, 'json_encode failed: ' . json_last_error_msg());
        }
        return $json;
    }

    /**
     * Decode a JSON request body. Throws 400 on malformed JSON.
     */
    public static function decode(string $raw): array
    {
        if (trim($raw) === '') {
            return [];
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            throw new ApiException(400, 'Invalid JSON body');
        }
        return $data;
    }
}
