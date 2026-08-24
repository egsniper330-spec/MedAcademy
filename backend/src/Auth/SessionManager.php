<?php

declare(strict_types=1);

namespace MedAcademy\Auth;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Utils\Config;
use MedAcademy\Utils\Uuid;

/**
 * Session lifecycle.
 *
 * Access token: short-lived HS256 JWT carrying sub/role/sv/device_id.
 * Refresh token: opaque random value stored ONLY as a sha256 hash in
 * `refresh_tokens`. Rotated on every refresh (the presented token is
 * revoked). Revoking a device or bumping security_version kills the
 * device's sessions.
 */
final class SessionManager
{
    public function issue(string $userId, string $role, int $securityVersion, ?string $deviceId): array
    {
        $accessTtl = Config::int('JWT_ACCESS_TTL_SECONDS', 900);
        $accessToken = Jwt::encode([
            'sub' => $userId,
            'role' => $role,
            'sv' => $securityVersion,
            'device_id' => $deviceId,
        ], $accessTtl);

        $refreshToken = bin2hex(random_bytes(48));
        $refreshTtl = Config::int('JWT_REFRESH_TTL_SECONDS', 2592000);

        Database::instance()->insert(
            'INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at, created_at)
             VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND), UTC_TIMESTAMP(6))',
            [Uuid::v4(), $userId, $deviceId, $this->hash($refreshToken), $refreshTtl]
        );

        return [
            'access_token' => $accessToken,
            'refresh_token' => $refreshToken,
            'expires_in' => $accessTtl,
            'token_type' => 'bearer',
        ];
    }

    /**
     * Rotate: verify presented refresh token, revoke it, issue a new pair.
     */
    public function rotate(string $refreshToken, ?string $deviceId = null): array
    {
        $hash = $this->hash($refreshToken);
        $db = Database::instance();

        $row = $db->row(
            'SELECT id, user_id, device_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ?',
            [$hash]
        );
        if ($row === null) {
            throw new ApiException(401, 'Invalid refresh token', 'invalid_refresh_token');
        }
        if ($row['revoked_at'] !== null) {
            throw new ApiException(401, 'Refresh token has been revoked', 'refresh_token_revoked');
        }
        if (strtotime((string) $row['expires_at']) < time()) {
            throw new ApiException(401, 'Refresh token expired', 'refresh_token_expired');
        }

        $profile = $db->row(
            'SELECT id, role, status, security_version FROM profiles WHERE id = ?',
            [$row['user_id']]
        );
        if ($profile === null || in_array($profile['status'], ['trashed', 'deleted'], true)) {
            throw new ApiException(401, 'Account not found');
        }
        if (in_array($profile['status'], ['suspended', 'blocked'], true)) {
            throw new ApiException(403, 'This account has been suspended. Please contact support.');
        }

        // revoke presented token (rotation)
        $db->query(
            'UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP(6), revoked_reason = ?, last_used_at = UTC_TIMESTAMP(6) WHERE id = ?',
            ['rotated', $row['id']]
        );

        return $this->issue(
            $profile['id'],
            $profile['role'],
            (int) $profile['security_version'],
            $deviceId ?? $row['device_id']
        );
    }

    public function revokeToken(string $refreshToken, string $reason): void
    {
        Database::instance()->query(
            'UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP(6), revoked_reason = ? WHERE token_hash = ?',
            [$reason, $this->hash($refreshToken)]
        );
    }

    public function revokeDeviceSessions(string $deviceId, string $reason): void
    {
        Database::instance()->query(
            'UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP(6), revoked_reason = ? WHERE device_id = ? AND revoked_at IS NULL',
            [$reason, $deviceId]
        );
    }

    public function revokeAllForUser(string $userId, string $reason): void
    {
        Database::instance()->query(
            'UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP(6), revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
            [$reason, $userId]
        );
    }

    private function hash(string $token): string
    {
        return hash('sha256', $token);
    }
}
