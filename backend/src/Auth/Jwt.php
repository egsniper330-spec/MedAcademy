<?php

declare(strict_types=1);

namespace MedAcademy\Auth;

use MedAcademy\Http\ApiException;
use MedAcademy\Utils\Config;
use MedAcademy\Utils\Json;

/**
 * Minimal HS256 JWT implementation (RFC 7519). No external dependencies —
 * safe on shared cPanel hosting. Uses hash_hmac('sha256', ...).
 */
final class Jwt
{
    public static function encode(array $claims, int $ttlSeconds): string
    {
        $secret = self::secret();
        $now = time();
        $payload = array_merge([
            'iss' => Config::string('JWT_ISSUER', 'medacademy'),
            'aud' => Config::string('JWT_AUDIENCE', 'medacademy-app'),
            'iat' => $now,
            'nbf' => $now,
            'exp' => $now + $ttlSeconds,
            'jti' => bin2hex(random_bytes(16)),
        ], $claims);

        $header = Json::encode(['alg' => 'HS256', 'typ' => 'JWT']);
        $body = Json::encode($payload);
        $unsigned = self::base64Url($header) . '.' . self::base64Url($body);
        return $unsigned . '.' . self::sign($unsigned, $secret);
    }

    /**
     * @return array<string,mixed> verified claims
     */
    public static function decode(string $token): array
    {
        $parts = explode('.', $token);
        if (count($parts) !== 3) {
            throw new ApiException(401, 'Invalid token');
        }
        [$h, $b, $sig] = $parts;
        $unsigned = $h . '.' . $b;
        if (!hash_equals(self::sign($unsigned, self::secret()), $sig)) {
            throw new ApiException(401, 'Invalid token signature');
        }
        $payload = json_decode(self::base64UrlDecode($b), true);
        if (!is_array($payload)) {
            throw new ApiException(401, 'Invalid token payload');
        }
        $now = time();
        if (isset($payload['exp']) && $payload['exp'] <= $now) {
            throw new ApiException(401, 'Token expired');
        }
        if (isset($payload['nbf']) && $payload['nbf'] > $now) {
            throw new ApiException(401, 'Token not yet valid');
        }
        $issuer = Config::string('JWT_ISSUER', 'medacademy');
        if (isset($payload['iss']) && $payload['iss'] !== $issuer) {
            throw new ApiException(401, 'Invalid token issuer');
        }
        return $payload;
    }

    private static function secret(): string
    {
        $secret = Config::string('JWT_SECRET');
        if ($secret === '' || $secret === 'CHANGE_ME_64_HEX_CHARS' || strlen($secret) < 32) {
            throw new ApiException(500, 'JWT secret is not configured');
        }
        return $secret;
    }

    private static function sign(string $data, string $secret): string
    {
        return self::base64Url(hash_hmac('sha256', $data, $secret, true));
    }

    private static function base64Url(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    private static function base64UrlDecode(string $data): string
    {
        $remainder = strlen($data) % 4;
        if ($remainder) {
            $data .= str_repeat('=', 4 - $remainder);
        }
        $decoded = base64_decode(strtr($data, '-_', '+/'), true);
        return $decoded === false ? '' : $decoded;
    }
}
