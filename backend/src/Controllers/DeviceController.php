<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuditService;
use MedAcademy\Services\AuthService;
use MedAcademy\Services\SecurityService;
use MedAcademy\Utils\Uuid;

/**
 * DeviceController — PHP equivalent of the device-binding Edge Function.
 *
 * Handles all 12 device management actions:
 *   register, status, get_devices, logout_device, block_device, unblock_device,
 *   delete_device, rename_device, set_limit, admin_reset, force_logout,
 *   logout_all, check_authorization, get_login_history, update_push_token,
 *   record_failure
 */
final class DeviceController
{
    private AuthService $authService;

    public function __construct(?AuthService $authService = null)
    {
        $this->authService = $authService ?? new AuthService();
    }

    /**
     * POST /device-binding — unified action dispatcher.
     * Matches the Edge Function's action-based routing.
     */
    public function handle(Request $request): array
    {
        $body = $request->json();
        $action = (string) ($body['action'] ?? '');
        $userId = $request->user['id'];
        $role = $request->user['role'];

        return match ($action) {
            'register' => $this->register($request, $body, $userId),
            'status' => $this->status($userId),
            'get_devices' => $this->getDevices($body, $role),
            'logout_device' => $this->logoutDevice($body, $userId, $role),
            'block_device' => $this->blockDevice($body, $userId, $role),
            'unblock_device' => $this->unblockDevice($body, $userId, $role),
            'delete_device' => $this->deleteDevice($body, $userId, $role),
            'rename_device' => $this->renameDevice($body, $userId),
            'set_limit' => $this->setLimit($body, $userId, $role),
            'admin_reset' => $this->adminReset($body, $userId, $role),
            'force_logout' => $this->forceLogout($body, $userId, $role),
            'logout_all' => $this->logoutAll($body, $userId, $role),
            'check_authorization' => $this->checkAuthorization($body, $userId),
            'get_login_history' => $this->getLoginHistory($body, $userId, $role),
            'update_push_token' => $this->updatePushToken($body, $userId),
            'record_failure' => $this->recordFailure($body, $userId, $request),
            default => throw new ApiException(400, "Unknown action: {$action}"),
        };
    }

    private function register(Request $request, array $body, string $userId): array
    {
        $fingerprint = (string) ($body['fingerprint'] ?? '');
        if ($fingerprint === '') {
            throw new ApiException(400, 'fingerprint is required');
        }

        $device = [
            'fingerprint' => $fingerprint,
            'device_name' => $body['device_name'] ?? 'Unknown Device',
            'platform' => $body['platform'] ?? 'unknown',
            'ip_address' => $request->clientIp(),
            'device_model' => $body['device_model'] ?? null,
            'os' => $body['os'] ?? null,
            'os_version' => $body['os_version'] ?? null,
            'app_version' => $body['app_version'] ?? null,
            'manufacturer' => $body['manufacturer'] ?? null,
            'installation_id' => $body['installation_id'] ?? null,
        ];

        $result = $this->authService->registerDevice($userId, $device, false);

        // Record login history
        if (empty($result['error'])) {
            try {
                Database::instance()->insert(
                    'INSERT INTO login_history (id, user_id, device_fingerprint, device_name, platform, ip_address, success, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(6))',
                    [Uuid::v4(), $userId, $fingerprint, $device['device_name'], $device['platform'], $request->clientIp()]
                );
            } catch (\Throwable) {
                // Non-fatal
            }
        }

        return $result;
    }

    private function status(string $userId): array
    {
        $db = Database::instance();
        $devices = $db->select(
            "SELECT id, device_name, device_model, platform, os, os_version, app_version, manufacturer,
                    ip_address, status, block_reason, registered_at, last_active_at, device_fingerprint,
                    installation_id, trust_level, revoked_at
               FROM devices WHERE user_id = ? ORDER BY last_active_at DESC",
            [$userId]
        );

        $profile = $db->row(
            'SELECT max_devices, role FROM profiles WHERE id = ?',
            [$userId]
        );

        $isUnlimited = ($profile['role'] ?? '') === 'super_admin' || $profile['max_devices'] === null;

        return [
            'devices' => $devices ?? [],
            'max_devices' => $isUnlimited ? null : ((int) ($profile['max_devices'] ?? 1)),
        ];
    }

    private function getDevices(array $body, string $role): array
    {
        $this->requireRole($role, ['admin', 'super_admin']);

        $targetUserId = (string) ($body['target_user_id'] ?? '');
        if ($targetUserId === '') {
            throw new ApiException(400, 'target_user_id is required');
        }

        $db = Database::instance();
        $devices = $db->select(
            "SELECT id, device_name, device_model, platform, os, os_version, app_version, manufacturer,
                    ip_address, status, block_reason, registered_at, last_active_at, device_fingerprint,
                    installation_id, trust_level, blocked_at
               FROM devices WHERE user_id = ? ORDER BY last_active_at DESC",
            [$targetUserId]
        );

        $profile = $db->row(
            'SELECT max_devices, full_name, email, role FROM profiles WHERE id = ?',
            [$targetUserId]
        );

        return ['devices' => $devices ?? [], 'profile' => $profile];
    }

    private function logoutDevice(array $body, string $userId, string $role): array
    {
        $deviceId = (string) ($body['device_id'] ?? '');
        if ($deviceId === '') {
            throw new ApiException(400, 'device_id is required');
        }

        // Users can logout their own devices; admins can logout any
        $db = Database::instance();
        $device = $db->row('SELECT user_id FROM devices WHERE id = ?', [$deviceId]);
        if ($device === null) {
            throw new ApiException(404, 'Device not found');
        }

        if ($device['user_id'] !== $userId && !in_array($role, ['admin', 'super_admin'], true)) {
            throw new ApiException(403, 'Not authorized');
        }

        return $this->authService->revokeDevice($device['user_id'], $deviceId, 'user_request', $userId);
    }

    private function blockDevice(array $body, string $userId, string $role): array
    {
        $this->requireRole($role, ['admin', 'super_admin']);

        $deviceId = (string) ($body['device_id'] ?? '');
        $reason = (string) ($body['block_reason'] ?? null);
        if ($deviceId === '') {
            throw new ApiException(400, 'device_id is required');
        }

        $db = Database::instance();
        $device = $db->row('SELECT user_id FROM devices WHERE id = ?', [$deviceId]);
        if ($device === null) {
            throw new ApiException(404, 'Device not found');
        }

        (new SecurityService())->blockDevice($deviceId, $userId, $reason);

        // Bump security version to invalidate sessions
        $this->authService->bumpSecurityVersion($device['user_id'], $userId);

        // Notify the account owner
        try {
            Database::instance()->insert(
                "INSERT INTO notifications (id, user_id, title, body, notification_type, is_read, created_at)
                 VALUES (?, ?, ?, ?, 'security', 0, UTC_TIMESTAMP(6))",
                [
                    Uuid::v4(),
                    $device['user_id'],
                    'Device Blocked',
                    'A device on your account has been blocked by an administrator.' . ($reason !== '' ? " Reason: {$reason}" : ''),
                ]
            );
        } catch (\Throwable) {
            // Non-fatal
        }

        return ['success' => true];
    }

    private function unblockDevice(array $body, string $userId, string $role): array
    {
        $this->requireRole($role, ['admin', 'super_admin']);

        $deviceId = (string) ($body['device_id'] ?? '');
        if ($deviceId === '') {
            throw new ApiException(400, 'device_id is required');
        }

        (new SecurityService())->unblockDevice($deviceId, $userId);
        return ['success' => true];
    }

    private function deleteDevice(array $body, string $userId, string $role): array
    {
        $this->requireRole($role, ['admin', 'super_admin']);

        $deviceId = (string) ($body['device_id'] ?? '');
        if ($deviceId === '') {
            throw new ApiException(400, 'device_id is required');
        }

        Database::instance()->query('DELETE FROM devices WHERE id = ?', [$deviceId]);
        AuditService::write($userId, 'device_removed', ['device_id' => $deviceId]);
        return ['success' => true];
    }

    private function renameDevice(array $body, string $userId): array
    {
        $deviceId = (string) ($body['device_id'] ?? '');
        $newName = (string) ($body['new_name'] ?? '');
        if ($deviceId === '' || $newName === '') {
            throw new ApiException(400, 'device_id and new_name are required');
        }

        Database::instance()->query(
            'UPDATE devices SET device_name = ? WHERE id = ? AND user_id = ?',
            [$newName, $deviceId, $userId]
        );
        return ['success' => true];
    }

    private function setLimit(array $body, string $userId, string $role): array
    {
        $this->requireRole($role, ['admin', 'super_admin']);

        $targetUserId = (string) ($body['target_user_id'] ?? '');
        if ($targetUserId === '') {
            throw new ApiException(400, 'target_user_id is required');
        }

        $maxDevices = isset($body['max_devices']) ? (int) $body['max_devices'] : null;
        if ($maxDevices !== null && $maxDevices < 1) {
            $maxDevices = 1;
        }

        Database::instance()->query(
            'UPDATE profiles SET max_devices = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
            [$maxDevices, $targetUserId]
        );

        AuditService::write($userId, 'device_limit_changed', [
            'target_user_id' => $targetUserId,
            'max_devices' => $maxDevices,
        ]);

        return ['success' => true];
    }

    private function adminReset(array $body, string $userId, string $role): array
    {
        $this->requireRole($role, ['admin', 'super_admin']);

        $targetUserId = (string) ($body['target_user_id'] ?? '');
        $reason = (string) ($body['reason'] ?? 'Admin device reset');
        if ($targetUserId === '') {
            throw new ApiException(400, 'target_user_id is required');
        }

        Database::instance()->query(
            "UPDATE devices SET status = 'logged_out', trust_level = 'revoked',
                    revoked_at = UTC_TIMESTAMP(6), revoked_reason = ?
              WHERE user_id = ?",
            [$reason, $targetUserId]
        );

        $this->authService->bumpSecurityVersion($targetUserId, $userId);

        // Notify
        try {
            Database::instance()->insert(
                "INSERT INTO notifications (id, user_id, title, body, notification_type, is_read, created_at)
                 VALUES (?, ?, ?, ?, 'security', 0, UTC_TIMESTAMP(6))",
                [Uuid::v4(), $targetUserId, 'Device Reset', 'Your registered device has been reset by an administrator. Please sign in again.']
            );
        } catch (\Throwable) {
        }

        AuditService::write($userId, 'device_reset', ['target_user_id' => $targetUserId, 'reason' => $reason]);
        return ['success' => true];
    }

    private function forceLogout(array $body, string $userId, string $role): array
    {
        $this->requireRole($role, ['admin', 'super_admin']);

        $deviceId = (string) ($body['device_id'] ?? '');
        $reason = (string) ($body['reason'] ?? 'Admin force logout');
        if ($deviceId === '') {
            throw new ApiException(400, 'device_id is required');
        }

        $db = Database::instance();
        $device = $db->row('SELECT user_id FROM devices WHERE id = ?', [$deviceId]);
        if ($device === null) {
            throw new ApiException(404, 'Device not found');
        }

        $this->authService->revokeDevice($device['user_id'], $deviceId, $reason, $userId);

        try {
            Database::instance()->insert(
                "INSERT INTO notifications (id, user_id, title, body, notification_type, is_read, created_at)
                 VALUES (?, ?, ?, ?, 'security', 0, UTC_TIMESTAMP(6))",
                [Uuid::v4(), $device['user_id'], 'Device Logged Out', 'A device on your account has been remotely logged out by an administrator.']
            );
        } catch (\Throwable) {
        }

        return ['success' => true];
    }

    private function logoutAll(array $body, string $userId, string $role): array
    {
        $this->requireRole($role, ['admin', 'super_admin']);

        $targetUserId = (string) ($body['target_user_id'] ?? '');
        $excludeFingerprint = $body['exclude_fingerprint'] ?? null;
        $reason = (string) ($body['reason'] ?? 'Admin logout all');
        if ($targetUserId === '') {
            throw new ApiException(400, 'target_user_id is required');
        }

        $db = Database::instance();
        $where = 'user_id = ?';
        $params = [$targetUserId];

        if ($excludeFingerprint !== null && $excludeFingerprint !== '') {
            $where .= ' AND device_fingerprint <> ?';
            $params[] = $excludeFingerprint;
        }

        $db->query(
            "UPDATE devices SET status = 'logged_out', trust_level = 'revoked',
                    revoked_at = UTC_TIMESTAMP(6), revoked_reason = ?
              WHERE {$where}",
            array_merge([$reason], $params)
        );

        $this->authService->bumpSecurityVersion($targetUserId, $userId);

        try {
            Database::instance()->insert(
                "INSERT INTO notifications (id, user_id, title, body, notification_type, is_read, created_at)
                 VALUES (?, ?, ?, ?, 'security', 0, UTC_TIMESTAMP(6))",
                [Uuid::v4(), $targetUserId, 'All Devices Logged Out', 'All devices on your account have been remotely logged out by an administrator.']
            );
        } catch (\Throwable) {
        }

        AuditService::write($userId, 'device_logout_all', ['target_user_id' => $targetUserId, 'reason' => $reason]);
        return ['success' => true];
    }

    private function checkAuthorization(array $body, string $userId): array
    {
        $db = Database::instance();
        $profile = $db->row('SELECT security_version, status FROM profiles WHERE id = ?', [$userId]);
        if ($profile === null) {
            return ['authorized' => false, 'reason' => 'user_not_found', 'security_version' => 0];
        }

        $currentVersion = (int) ($profile['security_version'] ?? 0);
        $clientVersion = (int) ($body['stored_security_version'] ?? 0);

        if ($profile['status'] === 'blocked') {
            return ['authorized' => false, 'reason' => 'account_blocked', 'security_version' => $currentVersion];
        }

        if ($currentVersion !== $clientVersion) {
            return ['authorized' => false, 'reason' => 'security_version_changed', 'security_version' => $currentVersion];
        }

        $fingerprint = $body['fingerprint'] ?? null;
        if ($fingerprint !== null && $fingerprint !== '') {
            $device = $db->row(
                "SELECT id, status, trust_level FROM devices
                  WHERE user_id = ? AND device_fingerprint = ? LIMIT 1",
                [$userId, $fingerprint]
            );

            if ($device !== null) {
                if ($device['status'] === 'blocked' || $device['trust_level'] === 'revoked') {
                    return ['authorized' => false, 'reason' => 'device_revoked', 'security_version' => $currentVersion];
                }
            } else {
                // Try installation_id fallback
                $installationId = $body['installation_id'] ?? null;
                if ($installationId !== null && $installationId !== '') {
                    $device = $db->row(
                        "SELECT id, status, trust_level FROM devices
                          WHERE user_id = ? AND installation_id = ? AND status <> 'blocked' LIMIT 1",
                        [$userId, $installationId]
                    );
                }

                if ($device === null) {
                    return ['authorized' => false, 'reason' => 'device_not_found', 'security_version' => $currentVersion];
                }

                if ($device['status'] === 'blocked' || $device['trust_level'] === 'revoked') {
                    return ['authorized' => false, 'reason' => 'device_revoked', 'security_version' => $currentVersion];
                }
            }
        }

        return ['authorized' => true, 'security_version' => $currentVersion];
    }

    private function getLoginHistory(array $body, string $userId, string $role): array
    {
        $target = $userId;
        if (in_array($role, ['admin', 'super_admin'], true) && isset($body['target_user_id'])) {
            $target = (string) $body['target_user_id'];
        }

        $history = Database::instance()->select(
            'SELECT * FROM login_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 100',
            [$target]
        );

        return ['history' => $history ?? []];
    }

    private function updatePushToken(array $body, string $userId): array
    {
        $pushToken = $body['push_token'] ?? null;
        $installationId = (string) ($body['installation_id'] ?? '');
        if ($installationId === '') {
            throw new ApiException(400, 'installation_id is required');
        }

        // Validate token format
        if ($pushToken !== null && $pushToken !== undefined) {
            if (!is_string($pushToken) || !str_starts_with($pushToken, 'ExponentPushToken[')) {
                throw new ApiException(400, 'Invalid push_token: must be an Expo Push Token');
            }
        }

        $db = Database::instance();
        $device = $db->row(
            'SELECT id FROM devices WHERE user_id = ? AND installation_id = ? LIMIT 1',
            [$userId, $installationId]
        );

        if ($device === null) {
            throw new ApiException(404, 'Device not found for this installation_id');
        }

        $db->query(
            'UPDATE devices SET push_token = ? WHERE id = ? AND user_id = ?',
            [$pushToken, $device['id'], $userId]
        );

        return ['success' => true];
    }

    private function recordFailure(array $body, string $userId, Request $request): array
    {
        $fingerprint = $body['fingerprint'] ?? null;
        $deviceName = $body['device_name'] ?? null;
        $platform = $body['platform'] ?? null;
        $reason = (string) ($body['reason'] ?? 'unknown');

        try {
            Database::instance()->insert(
                'INSERT INTO login_history (id, user_id, device_fingerprint, device_name, platform, ip_address, success, failure_reason, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, 0, ?, UTC_TIMESTAMP(6))',
                [Uuid::v4(), $userId, $fingerprint, $deviceName, $platform, $request->clientIp(), $reason]
            );
        } catch (\Throwable) {
            // Non-fatal
        }

        return ['success' => true];
    }

    private function requireRole(string $role, array $allowed): void
    {
        if (!in_array($role, $allowed, true)) {
            throw new ApiException(403, 'Forbidden: requires ' . implode(' or ', $allowed));
        }
    }
}
