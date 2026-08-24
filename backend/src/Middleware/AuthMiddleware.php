<?php

declare(strict_types=1);

namespace MedAcademy\Middleware;

use MedAcademy\Auth\Jwt;
use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;

/**
 * Authenticates the request from the Bearer access token and enforces:
 *   - token validity (Jwt::decode)
 *   - account still exists and is 'active' (suspended/trashed/deleted rejected)
 *   - profiles.security_version matches the token's sv claim (session revocable)
 *   - role allow-list (option 'role')
 *   - assistant permission key (option 'permission')
 *
 * Sets Request::$user: { id, role, status, security_version, device_id, sub }.
 */
final class AuthMiddleware
{
    public function handle(Request $request, array $options = []): void
    {
        $token = $request->bearerToken();
        if ($token === null) {
            throw new ApiException(401, 'Missing Authorization header');
        }

        $claims = Jwt::decode($token);
        $userId = (string) ($claims['sub'] ?? '');
        if ($userId === '') {
            throw new ApiException(401, 'Invalid token subject');
        }

        $profile = Database::instance()->row(
            'SELECT id, email, phone, phone_e164, role, status, security_version
               FROM profiles WHERE id = ?',
            [$userId]
        );
        if ($profile === null) {
            throw new ApiException(401, 'Account not found');
        }

        // Account status enforcement (mirrors the RLS + RPC guards)
        if (in_array($profile['status'], ['suspended', 'blocked'], true)) {
            throw new ApiException(403, 'This account has been suspended. Please contact support.', 'account_suspended');
        }
        if (in_array($profile['status'], ['trashed', 'deleted'], true)) {
            throw new ApiException(401, 'Account not found');
        }

        // security_version: admin can bump it to force re-login everywhere.
        $tokenSv = (int) ($claims['sv'] ?? 0);
        $profileSv = (int) $profile['security_version'];
        if ($profileSv > $tokenSv) {
            throw new ApiException(401, 'Session revoked — please sign in again', 'session_revoked');
        }

        $request->user = [
            'id' => $profile['id'],
            'role' => $profile['role'],
            'status' => $profile['status'],
            'security_version' => $profileSv,
            'device_id' => $claims['device_id'] ?? null,
        ];

        // Role enforcement
        if (!empty($options['role']) && !in_array($profile['role'], $options['role'], true)) {
            throw new ApiException(403, 'Forbidden: requires role ' . implode(' or ', $options['role']));
        }

        // Assistant permission enforcement
        if (!empty($options['permission'])) {
            $allowed = Database::instance()->value(
                'SELECT enabled FROM assistant_permissions
                  WHERE assistant_id = ? AND permission_key = ?',
                [$profile['id'], $options['permission']],
                false
            );
            if (!$allowed) {
                throw new ApiException(403, 'Missing permission: ' . $options['permission']);
            }
        }
    }
}
