<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuditService;
use MedAcademy\Services\AuthService;
use MedAcademy\Services\IntegrityService;
use MedAcademy\Services\SecurityEvidenceService;
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
    /**
     * ── DEVICE PRESENCE POLICY ──────────────────────────────────────────────
     * Shared contract with the client (src/lib/devicePresence.ts):
     *
     *   HEARTBEAT_SECONDS = 60   a foreground app posts one beat per interval.
     *   ONLINE_WINDOW_SECONDS = 150  2 beats + jitter. A device is "online" ONLY
     *                     while a backend-confirmed beat is inside this window.
     *   FUTURE_TOLERANCE_SECONDS = 300  a stored timestamp further in the future
     *                     than this cannot come from a real beat (legacy rows
     *                     written with the server's local zone, or a clock
     *                     jump). It is reported as "unknown" and re-anchored by
     *                     the next heartbeat instead of being displayed.
     *
     * NO OFFLINE EVENT EXISTS. iOS and Android may suspend or kill the process
     * without letting it send anything, so `last_confirmed_offline_at` is always
     * null: the UI shows the last CONFIRMED ONLINE time plus an inferred
     * "offline" state derived from the window above. It never invents a moment
     * at which the device went offline.
     */
    private const PRESENCE_HEARTBEAT_SECONDS = 60;
    private const PRESENCE_ONLINE_WINDOW_SECONDS = 150;
    private const PRESENCE_FUTURE_TOLERANCE_SECONDS = 300;

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

        // ── SERVER-SIDE APP-INTEGRITY POLICY (device binding claim) ──────
        // (Re-)registering a device binding is a protected operation: a
        // tampered APK must not refresh its binding unchallenged. The
        // enforcement tier is operator-controlled via security_config.
        if ($action === 'register') {
            IntegrityService::assertActionAllowed(
                (string) $userId,
                'device_bind',
                $request->header(IntegrityService::HEADER),
                $request->clientIp()
            );

            // ── SERVER-SIDE DEVICE-EVIDENCE POLICY (independent second gate) ──
     // Keystore-signed, challenge-bound evidence (SecurityEvidenceService).
     SecurityEvidenceService::assertEvidenceAllowed(
         (string) $userId,
         'device_bind',
         $request->header(SecurityEvidenceService::EVIDENCE_HEADER),
         $request->clientIp()
     );
        }

        return match ($action) {
            'register' => $this->register($request, $body, $userId),
            'heartbeat' => $this->heartbeat($request, $userId),
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
        $nowMs = self::nowMs();

        return [
            'devices' => array_map(
                static fn (array $d): array => self::withPresence($d, $nowMs),
                $devices ?? []
            ),
            'max_devices' => $isUnlimited ? null : ((int) ($profile['max_devices'] ?? 1)),
        ] + self::presenceMeta($nowMs);
    }

    /**
     * POST /device-binding { action: 'heartbeat' }
     *
     * Records a backend-confirmed presence event for the device THIS SESSION is
     * bound to. Authorization is the access token's `device_id` claim — the body
     * cannot name another device, so a client can never mark someone else's
     * device online.
     *
     * MONOTONIC: the UPDATE only moves the timestamp forward. A delayed or
     * duplicated request therefore cannot overwrite a newer beat (the guard is
     * inside the statement, not a read-then-write race). Implausibly-future
     * values (legacy local-zone rows) are the one exception — they are re-anchored
     * to now, otherwise a row 3 hours ahead could never be corrected.
     *
     * IDEMPOTENT: one UPDATE per call, no rows created, no audit rows written.
     */
    private function heartbeat(Request $request, string $userId): array
    {
        $deviceId = $request->user['device_id'] ?? null;
        if (!is_string($deviceId) || $deviceId === '') {
            throw new ApiException(400, 'This session is not bound to a device', 'device_unbound');
        }

        $db = Database::instance();
        $db->query(
            "UPDATE devices SET last_active_at = UTC_TIMESTAMP(6)
              WHERE id = ? AND user_id = ? AND status = 'active'
                AND (last_active_at IS NULL
                     OR last_active_at <= UTC_TIMESTAMP(6)
                     OR last_active_at > DATE_ADD(UTC_TIMESTAMP(6), INTERVAL " . self::PRESENCE_FUTURE_TOLERANCE_SECONDS . ' SECOND))',
            [$deviceId, $userId]
        );

        $row = $db->row(
            "SELECT id, device_name, device_model, platform, os, os_version, app_version, manufacturer,
                    ip_address, status, block_reason, registered_at, last_active_at, device_fingerprint,
                    installation_id, trust_level, revoked_at
               FROM devices WHERE id = ? AND user_id = ?",
            [$deviceId, $userId]
        );
        if ($row === null) {
            throw new ApiException(404, 'Device not found');
        }

        $nowMs = self::nowMs();
        return array_merge(
            ['device' => self::withPresence($row, $nowMs)],
            self::presenceMeta($nowMs)
        );
    }

    /** Current epoch milliseconds (server clock — the only trusted "now"). */
    private static function nowMs(): int
    {
        return (int) round(microtime(true) * 1000);
    }

    /**
     * Normalize a `devices` row into the presence contract.
     *
     * The raw `last_active_at` DATETIME is UTC by policy (Database pins the
     * session zone) and has NO zone suffix, so it must never reach the client as
     * a naive string: `new Date('2026-10-21 10:00:00')` is parsed in the VIEWER's
     * local zone, which is what turned a 1-minute-old beat into "3h ago" for a
     * UTC+3 admin. Both an ISO-8601 `…Z` string and epoch ms are returned.
     */
    private static function withPresence(array $row, int $nowMs): array
    {
        $seenMs = self::utcToMs($row['last_active_at'] ?? null);
        $status = (string) ($row['status'] ?? 'active');

        if ($seenMs === null) {
            $presence = 'unknown';
        } elseif ($status !== 'active') {
            $presence = 'offline';
        } elseif ($seenMs > $nowMs + self::PRESENCE_FUTURE_TOLERANCE_SECONDS * 1000) {
            // Cannot be a real beat (legacy local-zone write or a clock jump).
            $presence = 'unknown';
        } elseif ($nowMs - $seenMs <= self::PRESENCE_ONLINE_WINDOW_SECONDS * 1000) {
            $presence = 'online';
        } else {
            $presence = 'offline';
        }

        $row['last_active_at'] = $row['last_active_at'] ?? null;   // legacy field, untouched
        $row['last_seen_at'] = self::utcIso($row['last_active_at']);
        $row['last_seen_epoch_ms'] = $seenMs;
        $row['presence'] = $presence;
        $row['is_online'] = $presence === 'online';
        // No reliable offline event exists on mobile OSes — never fabricate one.
        $row['last_confirmed_offline_at'] = null;
        return $row;
    }

    /** Response-level presence metadata (server clock + the documented policy). */
    private static function presenceMeta(int $nowMs): array
    {
        return [
            'server_time' => gmdate('Y-m-d\TH:i:s\Z', intdiv($nowMs, 1000)),
            'server_epoch_ms' => $nowMs,
            'presence_policy' => [
                'heartbeat_seconds' => self::PRESENCE_HEARTBEAT_SECONDS,
                'online_window_seconds' => self::PRESENCE_ONLINE_WINDOW_SECONDS,
                'offline_is_inferred' => true,
            ],
        ];
    }

    /**
     * Parse a MySQL DATETIME (naive, UTC by policy) into epoch ms.
     * A string that already carries a zone/offset is honoured as-is.
     */
    private static function utcToMs(?string $naive): ?int
    {
        if ($naive === null || trim($naive) === '') {
            return null;
        }
        try {
            $dt = new \DateTimeImmutable(trim($naive), new \DateTimeZone('UTC'));
        } catch (\Throwable) {
            return null;
        }
        return $dt->getTimestamp() * 1000 + (int) $dt->format('u') / 1000;
    }

    /** Format a naive-UTC DATETIME as ISO-8601 with an explicit `Z`. */
    private static function utcIso(?string $naive): ?string
    {
        if ($naive === null || trim($naive) === '') {
            return null;
        }
        try {
            $dt = new \DateTimeImmutable(trim($naive), new \DateTimeZone('UTC'));
        } catch (\Throwable) {
            return null;
        }
        return $dt->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.v\Z');
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

        $nowMs = self::nowMs();
        return [
            'devices' => array_map(
                static fn (array $d): array => self::withPresence($d, $nowMs),
                $devices ?? []
            ),
            'profile' => $profile,
        ] + self::presenceMeta($nowMs);
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

        // -------------------------------------------------------------------
        // Reset All = SESSION RESET + DEVICE-REGISTRATION RESET (atomic).
        //
        // Soft-marking devices (status='logged_out', trust_level='revoked') is
        // NOT enough: the device rows survive and keep counting against the
        // device limit / "already active on another authorized device" check,
        // so a new device cannot register after a reset. Hard delete is the
        // architecture's own semantics for clearing a registration (the
        // single-device `delete_device` action does exactly that), and it
        // guarantees the authoritative count query returns 0 for the target
        // user regardless of which status filters it applies.
        //
        // Historical/audit data is preserved: login_history, audit_logs and
        // notifications are separate tables and are not touched here.
        // -------------------------------------------------------------------
        $db = Database::instance();
        $db->beginTransaction();
        try {
            // A. Revoke every active refresh token so old devices cannot
            //    refresh after the reset (do this explicitly — do not rely
            //    on the FK ON DELETE SET NULL, which only detaches the
            //    device_id without revoking the token).
            $db->query(
                "UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP(6), revoked_reason = ?
                  WHERE user_id = ? AND revoked_at IS NULL",
                ['admin_device_reset', $targetUserId]
            );

            // B. Remove ALL device registrations for the target user.
            //    Scope: user_id = target only. push_tokens rows cascade via
            //    fk_push_tokens_device_id; refresh_tokens.device_id is set
            //    NULL via fk_refresh_tokens_device_id.
            $stmt = $db->query('DELETE FROM devices WHERE user_id = ?', [$targetUserId]);
            $devicesDeleted = $stmt->rowCount();

            // C. Bump the target user's security version: invalidates every
            //    still-circulating JWT for that user and revokes any refresh
            //    tokens missed above. Scoped to profiles.id = targetUserId.
            $this->authService->bumpSecurityVersion($targetUserId, $userId);

            // D. Notify
            try {
                $db->insert(
                    "INSERT INTO notifications (id, user_id, title, body, notification_type, is_read, created_at)
                     VALUES (?, ?, ?, ?, 'security', 0, UTC_TIMESTAMP(6))",
                    [Uuid::v4(), $targetUserId, 'Device Reset', 'Your registered device has been reset by an administrator. Please sign in again.']
                );
            } catch (\Throwable) {
            }

            // E. Audit (inside the transaction so it commits atomically)
            AuditService::write($userId, 'device_reset', [
                'target_user_id' => $targetUserId,
                'reason' => $reason,
                'devices_deleted' => $devicesDeleted,
            ]);

            $db->commit();
        } catch (\Throwable $e) {
            $db->rollBack();
            throw $e;
        }

        return ['success' => true, 'devices_deleted' => $devicesDeleted];
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
        $profile = $db->row('SELECT security_version, status, role FROM profiles WHERE id = ?', [$userId]);
        if ($profile === null) {
            return ['authorized' => false, 'reason' => 'user_not_found', 'security_version' => 0];
        }

        $currentVersion = (int) ($profile['security_version'] ?? 0);
        $clientVersion = (int) ($body['stored_security_version'] ?? 0);

        if (in_array($profile['status'], ['blocked', 'suspended'], true)) {
            // account_blocked/suspended = server-authoritative stop. The client
            // maps 'account_blocked' to the account-suspended screen (session
            // preserved; Logout there performs the real sign-out).
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

                // device_not_found is a DATA-CONSISTENCY gap, not an authorized
                // revocation: the devices row can be missing because admin_reset
                // deleted ALL rows for the user (the user re-logged in on another
                // device but this device's re-registration failed), because a
                // login-time registerDevice() failed transiently, or because the
                // stored fingerprint drifted (OS/app update). None of those is a
                // security decision, so it must NOT force a logout — the caller
                // self-heals by re-registering. Genuinely revoked devices still
                // stop here when the row EXISTS with status='blocked' or
                // trust_level='revoked' (handled below), so enforcement is intact.
                if ($device === null) {
                    return ['authorized' => true, 'reason' => 'device_not_registered_self_heal', 'security_version' => $currentVersion];
                }

                if ($device['status'] === 'blocked' || $device['trust_level'] === 'revoked') {
                    return ['authorized' => false, 'reason' => 'device_revoked', 'security_version' => $currentVersion];
                }
            }
        }

        // Server-authoritative ROLE drift: the client's session token may carry
        // a stale role claim (access tokens live JWT_ACCESS_TTL_SECONDS). The
        // client reconciles by refreshing its profile (accountRefresh) WITHOUT
        // a logout — so include the fresh role in every verdict (the profile
        // row was already read above; no extra query needed).
        return ['authorized' => true, 'security_version' => $currentVersion, 'role' => (string) ($profile['role'] ?? '')];
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
