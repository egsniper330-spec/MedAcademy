<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Auth\Password;
use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuthService;
use MedAcademy\Services\AuditService;
use MedAcademy\Utils\Uuid;
use MedAcademy\Validation\Validator;

final class AuthController
{
    public function __construct(private readonly AuthService $auth = new AuthService())
    {
    }

    public function register(Request $request): array
    {
        $v = Validator::make($request->json(), [
            'password' => ['required', 'string', 'min:6'],
        ]);
        $v->throwIfInvalid();
        return $this->auth->register($request, $request->json());
    }

    public function login(Request $request): array
    {
        $v = Validator::make($request->json(), [
            'password' => ['required', 'string'],
        ]);
        $v->throwIfInvalid();
        return $this->auth->login($request, $request->json());
    }

    public function refresh(Request $request): array
    {
        return $this->auth->refresh($request);
    }

    public function logout(Request $request): array
    {
        return $this->auth->logout($request);
    }

    public function forgotPassword(Request $request): array
    {
        return $this->auth->forgotPassword($request, $request->json());
    }

    public function resetPassword(Request $request): array
    {
        return $this->auth->resetPassword($request, $request->json());
    }

    public function changePassword(Request $request): array
    {
        return $this->auth->changePassword($request, $request->json());
    }

    /**
     * POST /auth/admin/change-password — admin/super_admin changes another user's password.
     * Port of change-password Edge Function admin path.
     */
    public function adminChangePassword(Request $request): array
    {
        $body = $request->json();
        $targetUserId = (string) ($body['target_user_id'] ?? '');
        $newPassword = (string) ($body['new_password'] ?? '');
        $callerRole = $request->user['role'];

        if (strlen($newPassword) < 8) {
            throw new ApiException(422, 'Password must be at least 8 characters');
        }

        $db = Database::instance();
        $targetProfile = $db->row('SELECT id, full_name, email, role FROM profiles WHERE id = ?', [$targetUserId]);
        if ($targetProfile === null) {
            throw new ApiException(404, 'Target user not found');
        }

        $targetRole = $targetProfile['role'];
        $isSuperAdmin = $callerRole === 'super_admin';
        $adminAllowed = ['student', 'doctor'];
        $superAllowed = ['student', 'doctor', 'admin', 'super_admin'];
        $allowed = $isSuperAdmin ? $superAllowed : $adminAllowed;

        if (!in_array($targetRole, $allowed, true)) {
            throw new ApiException(403, $isSuperAdmin
                ? 'Target user role not supported.'
                : 'Only Super Admin can change passwords for Admin or Super Admin accounts.');
        }

        // Update password
        $db->query(
            'UPDATE users SET encrypted_password = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
            [Password::hash($newPassword), $targetUserId]
        );

        // Touch device rows (same as Edge Function)
        $db->query(
            "UPDATE devices SET last_active_at = UTC_TIMESTAMP(6) WHERE user_id = ? AND status <> 'blocked'",
            [$targetUserId]
        );

        (new AuthService())->bumpSecurityVersion($targetUserId, $request->user['id']);

        AuditService::write($request->user['id'], 'password_changed_by_admin', [
            'target_user_id' => $targetUserId,
            'target_name' => $targetProfile['full_name'],
            'changed_by_role' => $callerRole,
        ]);

        return ['success' => true, 'target_name' => $targetProfile['full_name']];
    }

    public function lookup(Request $request): array
    {
        $identifier = (string) ($request->json()['identifier'] ?? $request->query('identifier', ''));
        return $this->auth->lookupIdentifier($identifier);
    }

    public function preLoginCheck(Request $request): array
    {
        // Accept both the REST-style keys and the original RPC argument names
        // (p_email / p_installation_id) that the mobile app still sends.
        $json = $request->json();
        $identifier = (string) ($json['identifier'] ?? $json['p_email'] ?? $json['email'] ?? '');
        $installationId = isset($json['installation_id']) ? (string) $json['installation_id'] : (isset($json['p_installation_id']) ? (string) $json['p_installation_id'] : null);
        $account = $this->auth->resolveIdentifier($identifier);
        if ($account === null) {
            return ['allowed' => false, 'reason' => 'No account found for this email or phone number.'];
        }
        $result = $this->auth->preLoginDeviceCheck($account['id'], $installationId);
        return array_merge(['allowed' => $result['allowed'] ?? false], $result);
    }

    public function me(Request $request): array
    {
        return ['user' => $this->auth->publicUser($request->user['id'])];
    }

    public function revokeDevice(Request $request): array
    {
        $deviceId = (string) ($request->json()['device_id'] ?? '');
        $reason = (string) ($request->json()['reason'] ?? 'user_request');
        return $this->auth->revokeDevice($request->user['id'], $deviceId, $reason, $request->user['id']);
    }

    public function devices(Request $request): array
    {
        return [
            'devices' => Database::instance()->select(
                'SELECT id, device_name, platform, device_model, os_version, app_version, status, trust_level,
                        last_active_at, registered_at, first_login_at, installation_id
                   FROM devices WHERE user_id = ? ORDER BY last_active_at DESC',
                [$request->user['id']]
            ),
        ];
    }

    /**
     * POST /auth/trash-user — soft-delete user (trash-user Edge Function).
     */
    public function trashUser(Request $request): array
    {
        $body = $request->json();
        $targetUserId = (string) ($body['target_user_id'] ?? $request->params['id'] ?? '');
        $reason = (string) ($body['reason'] ?? 'Trashed by administrator');
        $actorId = $request->user['id'];

        if ($targetUserId === '') {
            throw new ApiException(422, 'target_user_id is required');
        }

        $db = Database::instance();
        $profile = $db->row('SELECT id, role, status FROM profiles WHERE id = ?', [$targetUserId]);
        if ($profile === null) {
            throw new ApiException(404, 'User not found');
        }

        if ($profile['status'] === 'trashed') {
            throw new ApiException(409, 'User is already trashed');
        }

        $retentionDays = (int) $db->value('SELECT retention_days FROM trash_config LIMIT 1', [], 30);
        $previousStatus = $profile['status'];

        // Store previous status in pre_trash_status if column exists,
        // otherwise store it only in the audit log for restore reference.
        $db->query(
            "UPDATE profiles SET
                status = 'trashed',
                trashed_at = UTC_TIMESTAMP(6),
                trash_expires_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? DAY),
                trashed_by = ?,
                trash_reason = ?,
                updated_at = UTC_TIMESTAMP(6)
              WHERE id = ?",
            [$retentionDays, $actorId, $reason, $targetUserId]
        );
        // Best-effort: write pre_trash_status if column exists (non-fatal if missing)
        try {
            $db->query('UPDATE profiles SET pre_trash_status = ? WHERE id = ?',
                [$previousStatus, $targetUserId]);
        } catch (\Throwable $e) {
            // Column does not exist — previous status preserved in audit log
        }

        // Tombstone the email in the users table to free it for reuse.
        // The original email is preserved in profiles.email for restore reference.
        $tombstone = 'trashed-' . substr($targetUserId, 0, 8) . '@deleted.medacademy';
        $db->query('UPDATE users SET email = ? WHERE id = ?', [$tombstone, $targetUserId]);

        // Bump security version to invalidate sessions
        (new AuthService())->bumpSecurityVersion($targetUserId, $actorId);

        AuditService::write($actorId, 'user_trashed', [
            'target_user_id' => $targetUserId,
            'target_role' => $profile['role'],
            'previous_status' => $previousStatus,
            'reason' => $reason,
        ]);

        return ['success' => true, 'status' => 'trashed'];
    }

    /**
     * POST /auth/impersonate — super_admin generates impersonation token.
     */
    public function impersonate(Request $request): array
    {
        $body = $request->json();
        $targetUserId = (string) ($body['target_user_id'] ?? '');
        $actorId = $request->user['id'];
        $actorRole = $request->user['role'];

        if ($actorRole !== 'super_admin') {
            throw new ApiException(403, 'Only Super Admin can impersonate');
        }

        if ($targetUserId === '') {
            throw new ApiException(422, 'target_user_id is required');
        }

        $db = Database::instance();
        $target = $db->row('SELECT id, email, role, full_name FROM profiles WHERE id = ?', [$targetUserId]);
        if ($target === null) {
            throw new ApiException(404, 'User not found');
        }

        if ($target['role'] === 'super_admin') {
            throw new ApiException(403, 'Cannot impersonate Super Admin accounts');
        }
        if ($actorId === $targetUserId) {
            throw new ApiException(400, 'Cannot impersonate yourself');
        }

        // Generate a temporary session token for the target user
        $session = (new \MedAcademy\Auth\SessionManager())->issue($targetUserId, $target['role'], 0);

        AuditService::write($actorId, 'impersonation_started', [
            'target_user_id' => $targetUserId,
            'target_name' => $target['full_name'],
            'target_email' => $target['email'],
            'target_role' => $target['role'],
        ]);

        return [
            'session' => $session,
            'target' => $target,
        ];
    }
}
