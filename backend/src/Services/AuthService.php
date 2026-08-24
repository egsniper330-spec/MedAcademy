<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Auth\Password;
use MedAcademy\Auth\SessionManager;
use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Notifications\EmailService;
use MedAcademy\Utils\Config;
use MedAcademy\Utils\Uuid;

/**
 * AuthService — the PHP equivalent of the Supabase Auth (GoTrue) flows plus
 * the pre-login / device-binding RPCs the app depends on:
 *
 *   pre_login_device_check (00156)  -> self::preLoginDeviceCheck()
 *   register_device_for_user (00172)-> self::registerDevice()
 *   get_email_by_phone / lookup_user_by_identifier -> self::resolveIdentifier()
 *
 * Business rules preserved: blocked-device-first check, max_devices limits,
 * allow_multiple/allow_unlimited overrides, revoked-row resurrection,
 * account status enforcement, security_version session revocation.
 */
final class AuthService
{
    private SessionManager $sessions;

    public function __construct(?SessionManager $sessions = null)
    {
        $this->sessions = $sessions ?? new SessionManager();
    }

    // -----------------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------------
    public function register(Request $request, array $data): array
    {
        $this->rateLimit('register:' . $request->clientIp(), Config::int('RATE_LIMIT_REGISTER_PER_HOUR', 10), 3600);

        $email = strtolower(trim((string) ($data['email'] ?? '')));
        $phone = trim((string) ($data['phone'] ?? ''));
        $password = (string) ($data['password'] ?? '');
        $fullName = trim((string) ($data['full_name'] ?? ''));
        $role = (string) ($data['role'] ?? 'student');
        $meta = is_array($data['metadata'] ?? null) ? $data['metadata'] : [];

        if ($email === '' && $phone === '') {
            throw new ApiException(422, 'An email or phone number is required');
        }
        if (strlen($password) < 6) {
            throw new ApiException(422, 'Password must be at least 6 characters');
        }
        if (!in_array($role, ['student', 'doctor'], true)) {
            throw new ApiException(422, 'Invalid role for self-registration');
        }

        $db = Database::instance();

        // identifier uniqueness (mirrors users_email_key / users_phone_key)
        if ($email !== '') {
            $exists = $db->value('SELECT COUNT(*) FROM users WHERE LOWER(email) = ?', [$email], 0);
            if ($exists > 0) {
                throw new ApiException(409, 'An account with this email already exists', 'email_taken');
            }
        }
        if ($phone !== '') {
            $phoneE164 = $this->normalizePhone($phone);
            $exists = $db->value('SELECT COUNT(*) FROM users WHERE phone = ?', [$phoneE164], 0);
            if ($exists > 0) {
                throw new ApiException(409, 'An account with this phone number already exists', 'phone_taken');
            }
        }

        $userId = Uuid::v4();
        $autoConfirm = Config::bool('AUTH_AUTO_CONFIRM', true);
        $confirmedAt = $autoConfirm ? 'UTC_TIMESTAMP(6)' : 'NULL';

        try {
            $db->transaction(function (Database $db) use ($userId, $email, $phone, $password, $fullName, $role, $meta, $confirmedAt) {
                // NOTE: `phone` is intentionally NOT part of this INSERT. MySQL
                // forbids a trigger from updating the table used by the invoking
                // statement (Error 1442): inserting users.phone would fire
                // trg_sync_auth_phone_on_new_user → UPDATE profiles → fires
                // trg_sync_auth_phone_on_profile_update → UPDATE users → 1442 → 500.
                // The UPDATE profiles below (same transaction) performs the sync
                // legally: its profile-update trigger writes users.phone back,
                // so the end state (users.phone + profiles.phone_e164) is identical.
                $db->insert(
                    'INSERT INTO users
                       (id, email, encrypted_password, raw_user_meta_data, email_confirmed_at, phone_confirmed_at, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ' . $confirmedAt . ', ' . $confirmedAt . ', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))',
                    [
                        $userId,
                        $email !== '' ? $email : null,
                        Password::hash($password),
                        json_encode(array_merge(['full_name' => $fullName, 'role' => $role], $meta), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
                    ]
                );

                // profiles row is created by trg_on_auth_user_created trigger;
                // UPDATE it to fill fields the trigger doesn't set.
                $db->query(
                    'UPDATE profiles
                        SET email = ?, full_name = ?, phone = ?, phone_e164 = ?,
                            role = ?, status = ?, watermark_id = ?,
                            created_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)
                      WHERE id = ?',
                    [
                        $email !== '' ? $email : '',
                        $fullName,
                        $phone !== '' ? $phone : null,
                        $phone !== '' ? $this->normalizePhone($phone) : null,
                        $role,
                        'active',
                        $this->nextWatermarkId(),
                        $userId,
                    ]
                );
            });
        } catch (\PDOException $e) {
            if ($e->getCode() === '23000') {
                throw new ApiException(409, 'An account with this email or phone already exists', 'identifier_taken');
            }
            throw $e;
        }

        AuditService::write($userId, 'register', ['email' => $email, 'phone' => $phone !== ''], $request->clientIp());

        // Auto-login on registration (matches the app's current UX where the
        // account is usable immediately).
        if ($autoConfirm) {
            $device = $this->devicePayload($request, $data);
            $deviceId = null;
            // Device registration is optional during sign-up — the client may
            // not have fingerprint info yet. If it fails, we still return a
            // usable session so the user is not locked out.
            if (!empty($device['fingerprint'])) {
                try {
                    $registered = $this->registerDevice($userId, $device, true);
                    $deviceId = $registered['device_id'] ?? null;
                } catch (\Throwable) {
                    // Device registration failed — session is still valid.
                }
            }
            return [
                'user' => $this->publicUser($userId),
                'session' => $this->sessions->issue($userId, $role, 0, $deviceId),
            ];
        }

        return ['user' => $this->publicUser($userId), 'session' => null, 'requires_email_confirmation' => true];
    }

    // -----------------------------------------------------------------------
    // Login
    // -----------------------------------------------------------------------
    public function login(Request $request, array $data): array
    {
        $this->rateLimit('login:' . $request->clientIp(), Config::int('RATE_LIMIT_LOGIN_PER_MINUTE', 10), 60);

        $identifier = trim((string) ($data['identifier'] ?? $data['email'] ?? ''));
        $password = (string) ($data['password'] ?? '');
        if ($identifier === '' || $password === '') {
            throw new ApiException(422, 'Identifier and password are required');
        }

        $account = $this->resolveIdentifier($identifier);
        if ($account === null) {
            $this->recordLogin(null, $request, false, 'no_account');
            throw new ApiException(401, 'Invalid login credentials');
        }
        $userId = $account['id'];
        $hash = $account['encrypted_password'] ?? '';
        if (!Password::verify($password, $hash)) {
            $this->recordLogin($userId, $request, false, 'wrong_password');
            throw new ApiException(401, 'Invalid login credentials');
        }

        // transparent re-hash (upgrades Supabase $2a$ hashes to $2y$)
        if (Password::needsRehash($hash)) {
            Database::instance()->query(
                'UPDATE users SET encrypted_password = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
                [Password::hash($password), $userId]
            );
        }

        // account status checks (mirrors the RLS + login guards)
        if (in_array($account['status'], ['suspended', 'blocked'], true)) {
            $this->recordLogin($userId, $request, false, 'suspended');
            throw new ApiException(403, 'This account has been suspended. Please contact support.', 'account_suspended');
        }
        if (in_array($account['status'], ['trashed', 'deleted'], true)) {
            $this->recordLogin($userId, $request, false, 'deleted');
            throw new ApiException(401, 'Invalid login credentials');
        }

        // device pre-login check (pre_login_device_check port)
        $deviceData = $this->devicePayload($request, $data);
        $installationId = $deviceData['installation_id'] ?? null;
        $preCheck = $this->preLoginDeviceCheck($userId, $installationId);
        if (($preCheck['allowed'] ?? false) !== true) {
            $this->recordLogin($userId, $request, false, 'device_check');
            throw new ApiException(403, (string) ($preCheck['reason'] ?? 'Device not allowed'), 'device_blocked');
        }

        // Register / update the device row ONLY when the client supplied the
        // device payload. The original Supabase flow registers the device AFTER
        // login via the device-binding endpoint (the app computes its fingerprint
        // post-login), so a missing fingerprint here must never hard-fail a valid
        // credential login. Blocked-device enforcement still runs above via
        // preLoginDeviceCheck whenever the client sends installation_id.
        $device = null;
        if (($deviceData['fingerprint'] ?? '') !== '' || ($deviceData['installation_id'] ?? null) !== null) {
            $device = $this->registerDevice($userId, $deviceData, true);
        }
        if (isset($device['error'])) {
            $this->recordLogin($userId, $request, false, 'device_registration');
            throw new ApiException(403, (string) $device['error'], 'device_blocked');
        }

        $this->recordLogin($userId, $request, true);
        AuditService::write($userId, 'login', ['device_id' => $device['id']], $request->clientIp());

        return [
            'user' => $this->publicUser($userId),
            'session' => $this->sessions->issue($userId, $account['role'], (int) $account['security_version'], $device['id']),
            'device' => $device,
        ];
    }

    public function refresh(Request $request): array
    {
        $token = (string) ($request->json()['refresh_token'] ?? '');
        if ($token === '') {
            throw new ApiException(422, 'refresh_token is required');
        }
        return ['session' => $this->sessions->rotate($token)];
    }

    public function logout(Request $request): array
    {
        $userId = $request->user['id'] ?? null;
        $token = (string) ($request->json()['refresh_token'] ?? '');
        if ($token !== '') {
            $this->sessions->revokeToken($token, 'logout');
        }
        AuditService::write($userId, 'logout', [], $request->clientIp());
        return ['success' => true];
    }

    // -----------------------------------------------------------------------
    // Password flows
    // -----------------------------------------------------------------------
    public function forgotPassword(Request $request, array $data): array
    {
        $identifier = trim((string) ($data['identifier'] ?? ''));
        $account = $this->resolveIdentifier($identifier);
        // Always return success (do not leak which identifiers exist).
        if ($account === null) {
            return ['success' => true];
        }

        $token = bin2hex(random_bytes(32));
        $ttl = Config::int('PASSWORD_RESET_TTL_SECONDS', 1800);
        Database::instance()->insert(
            'INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, ip_address, created_at)
             VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND), ?, UTC_TIMESTAMP(6))',
            [Uuid::v4(), $account['id'], hash('sha256', $token), $ttl, $request->clientIp()]
        );

        $email = (string) ($account['email'] ?? $account['profile_email'] ?? '');
        if ($email !== '') {
            $resetUrl = Config::string('APP_URL') . '/reset-password?token=' . $token;
            EmailService::send(
                $email,
                'Reset your MedAcademy password',
                '<p>Use this link to reset your password (valid 30 minutes):</p>'
                . '<p><a href="' . htmlspecialchars($resetUrl, ENT_QUOTES) . '">' . htmlspecialchars($resetUrl) . '</a></p>'
            );
        }
        AuditService::write($account['id'], 'password_reset', ['requested' => true], $request->clientIp());
        return ['success' => true];
    }

    public function resetPassword(Request $request, array $data): array
    {
        $token = (string) ($data['token'] ?? '');
        $password = (string) ($data['password'] ?? '');
        if (strlen($password) < 6) {
            throw new ApiException(422, 'Password must be at least 6 characters');
        }
        $db = Database::instance();
        $row = $db->row(
            'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?',
            [hash('sha256', $token)]
        );
        if ($row === null || $row['used_at'] !== null || strtotime((string) $row['expires_at']) < time()) {
            throw new ApiException(400, 'Invalid or expired reset token');
        }

        $db->transaction(function () use ($db, $row, $password) {
            $db->query(
                'UPDATE users SET encrypted_password = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
                [Password::hash($password), $row['user_id']]
            );
            $db->query(
                'UPDATE password_reset_tokens SET used_at = UTC_TIMESTAMP(6) WHERE id = ?',
                [$row['id']]
            );
        });

        $this->sessions->revokeAllForUser($row['user_id'], 'password_reset');
        AuditService::write($row['user_id'], 'password_reset', ['completed' => true], $request->clientIp());
        return ['success' => true];
    }

    public function changePassword(Request $request, array $data): array
    {
        $userId = $request->user['id'] ?? null;
        if ($userId === null) {
            throw new ApiException(401, 'Authentication required');
        }
        $current = (string) ($data['current_password'] ?? '');
        $new = (string) ($data['new_password'] ?? '');
        if (strlen($new) < 6) {
            throw new ApiException(422, 'New password must be at least 6 characters');
        }

        // The original Supabase change-password flow is session-authenticated:
        // the $auth middleware has already validated the access token, so the
        // current password is an EXTRA check, not a requirement. Only verify it
        // when the caller actually supplies it (self-service UI sends only the
        // new password). Admin changes go through /auth/admin/change-password.
        if ($current !== '') {
            $hash = Database::instance()->value(
                'SELECT encrypted_password FROM users WHERE id = ?',
                [$userId],
                ''
            );
            if (!Password::verify($current, (string) $hash)) {
                throw new ApiException(400, 'Current password is incorrect');
            }
        }

        Database::instance()->transaction(function (Database $db) use ($userId, $new) {
            $db->query(
                'UPDATE users SET encrypted_password = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
                [Password::hash($new), $userId]
            );
            $db->query(
                'UPDATE profiles SET force_password_change = 0 WHERE id = ?',
                [$userId]
            );
        });

        $this->sessions->revokeAllForUser($userId, 'password_changed');
        AuditService::write($userId, 'password_reset', ['changed' => true], $request->clientIp());
        return ['success' => true];
    }

    // -----------------------------------------------------------------------
    // Identifier resolution (get_email_by_phone / lookup_user_by_identifier)
    // -----------------------------------------------------------------------
    public function resolveIdentifier(string $identifier): ?array
    {
        $identifier = trim($identifier);
        if ($identifier === '') {
            return null;
        }
        $db = Database::instance();
        $email = strtolower($identifier);

        $row = $db->row(
            "SELECT u.id, u.email, u.phone, u.encrypted_password,
                    p.role, p.status, p.security_version, p.email AS profile_email
               FROM users u
               JOIN profiles p ON p.id = u.id
              WHERE LOWER(u.email) = ? OR u.phone = ? OR LOWER(p.email) = ? OR p.phone_e164 = ? OR p.phone = ?
              LIMIT 1",
            [$email, $identifier, $email, $identifier, $identifier]
        );
        return $row;
    }

    /**
     * Public-facing lookup used by the pre-login "is this identifier known"
     * flow. Returns only existence + resolved email (no credentials).
     */
    public function lookupIdentifier(string $identifier): array
    {
        $account = $this->resolveIdentifier($identifier);
        if ($account === null) {
            return ['found' => false];
        }
        return ['found' => true, 'email' => $account['email']];
    }

    // -----------------------------------------------------------------------
    // pre_login_device_check — port of 00156 (blocked-device-first!)
    // -----------------------------------------------------------------------
    public function preLoginDeviceCheck(string $userId, ?string $installationId): array
    {
        $db = Database::instance();
        $profile = $db->row(
            'SELECT id, max_devices, role, status FROM profiles WHERE id = ?',
            [$userId]
        );
        if ($profile === null) {
            return ['allowed' => false, 'reason' => 'No account found for this email or phone number.'];
        }
        if (in_array($profile['status'], ['trashed', 'deleted'], true)) {
            return ['allowed' => false, 'deleted' => true, 'reason' => 'No account found for this email or phone number.'];
        }

        // SECURITY: blocked device check FIRST — a blocked device must never
        // be allowed, even if known or under the device limit.
        if ($installationId !== null && $installationId !== '') {
            $blocked = $db->value(
                "SELECT id FROM devices
                  WHERE user_id = ? AND installation_id = ? AND status = 'blocked' LIMIT 1",
                [$userId, $installationId]
            );
            if ($blocked !== null) {
                return [
                    'allowed' => false,
                    'device_blocked' => true,
                    'reason' => 'This device has been blocked by the administrator. Please contact support.',
                ];
            }
        }

        // Unlimited: super_admin OR max_devices IS NULL
        if ($profile['role'] === 'super_admin' || $profile['max_devices'] === null) {
            return ['allowed' => true, 'unlimited' => true];
        }

        // Known non-blocked installation → always allow (same-device re-login)
        if ($installationId !== null && $installationId !== '') {
            $known = $db->value(
                "SELECT id FROM devices
                  WHERE user_id = ? AND installation_id = ? AND status <> 'blocked' LIMIT 1",
                [$userId, $installationId]
            );
            if ($known !== null) {
                return ['allowed' => true, 'known_device' => true];
            }
        }

        $count = (int) $db->value(
            "SELECT COUNT(*) FROM devices WHERE user_id = ? AND status <> 'blocked'",
            [$userId],
            0
        );
        if ($count >= (int) $profile['max_devices']) {
            return [
                'allowed' => false,
                'limit_reached' => true,
                'reason' => 'This account is already active on another authorized device.',
                'current_count' => $count,
                'max_devices' => (int) $profile['max_devices'],
            ];
        }

        return ['allowed' => true];
    }

    // -----------------------------------------------------------------------
    // register_device_for_user — port of 00172 (idempotent upsert)
    // -----------------------------------------------------------------------
    public function registerDevice(string $userId, array $device, bool $touchFirstLogin = true): array
    {
        $fingerprint = (string) ($device['fingerprint'] ?? '');
        $installationId = $device['installation_id'] ?? null;
        if ($fingerprint === '') {
            throw new ApiException(422, 'device fingerprint is required');
        }

        $db = Database::instance();
        $profile = $db->row('SELECT max_devices, role FROM profiles WHERE id = ?', [$userId]);
        if ($profile === null) {
            throw new ApiException(404, 'User profile not found');
        }

        // blocked device (by installation_id, then by fingerprint)
        $blockedId = null;
        if ($installationId !== null && $installationId !== '') {
            $blockedId = $db->value(
                "SELECT id FROM devices WHERE user_id = ? AND installation_id = ? AND status = 'blocked' LIMIT 1",
                [$userId, $installationId]
            );
        }
        if ($blockedId === null) {
            $blockedId = $db->value(
                "SELECT id FROM devices WHERE user_id = ? AND device_fingerprint = ? AND status = 'blocked' LIMIT 1",
                [$userId, $fingerprint]
            );
        }
        if ($blockedId !== null) {
            return [
                'error' => 'This device has been blocked by the administrator. Please contact support.',
                'device_blocked' => true,
                'device_id' => $blockedId,
            ];
        }

        // find existing device (installation_id first, then fingerprint)
        $existing = null;
        $wasRevoked = false;
        if ($installationId !== null && $installationId !== '') {
            $existing = $db->row(
                "SELECT id, trust_level, status FROM devices
                  WHERE user_id = ? AND installation_id = ? AND status <> 'blocked' LIMIT 1",
                [$userId, $installationId]
            );
        }
        if ($existing === null) {
            $existing = $db->row(
                "SELECT id, trust_level, status FROM devices
                  WHERE user_id = ? AND device_fingerprint = ? AND status <> 'blocked' LIMIT 1",
                [$userId, $fingerprint]
            );
        }
        if ($existing !== null) {
            $wasRevoked = in_array($existing['trust_level'], ['revoked'], true)
                || $existing['status'] === 'logged_out';

            $db->query(
                "UPDATE devices SET
                    status = 'active',
                    trust_level = 'trusted',
                    last_active_at = UTC_TIMESTAMP(6),
                    device_fingerprint = ?,
                    app_version = COALESCE(?, app_version),
                    os_version = COALESCE(?, os_version),
                    ip_address = COALESCE(?, ip_address),
                    device_name = COALESCE(NULLIF(?, 'Unknown Device'), device_name),
                    installation_id = COALESCE(?, installation_id),
                    revoked_at = NULL,
                    revoked_reason = NULL
                  WHERE id = ?",
                [
                    $fingerprint,
                    $device['app_version'] ?? null,
                    $device['os_version'] ?? null,
                    $device['ip_address'] ?? null,
                    $device['device_name'] ?? null,
                    $installationId,
                    $existing['id'],
                ]
            );
            return [
                'device_id' => $existing['id'],
                'status' => 'updated',
                'is_new' => false,
                'was_revoked' => $wasRevoked,
            ];
        }

        // device limit (super_admin and NULL max_devices are unlimited)
        if ($profile['role'] !== 'super_admin' && $profile['max_devices'] !== null) {
            $count = (int) $db->value(
                "SELECT COUNT(*) FROM devices
                  WHERE user_id = ? AND status NOT IN ('blocked','logged_out') AND trust_level <> 'revoked'",
                [$userId],
                0
            );
            if ($count >= (int) $profile['max_devices']) {
                return [
                    'error' => 'This account is already active on another authorized device.',
                    'limit_reached' => true,
                    'current_count' => $count,
                    'max_devices' => (int) $profile['max_devices'],
                ];
            }
        }

        $deviceId = Uuid::v4();
        // registered_at / last_active_at / first_login_at come from column
        // defaults (CURRENT_TIMESTAMP) — never pass SQL expressions as values.
        $db->insert(
            'INSERT INTO devices
               (id, user_id, device_fingerprint, installation_id, device_name, platform, ip_address,
                device_model, os, os_version, app_version, manufacturer,
                status, trust_level)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                $deviceId,
                $userId,
                $fingerprint,
                $installationId,
                $device['device_name'] ?? 'Unknown Device',
                $device['platform'] ?? 'unknown',
                $device['ip_address'] ?? null,
                $device['device_model'] ?? null,
                $device['os'] ?? null,
                $device['os_version'] ?? null,
                $device['app_version'] ?? null,
                $device['manufacturer'] ?? null,
                'active',
                'trusted',
            ]
        );

        return ['device_id' => $deviceId, 'status' => 'created', 'is_new' => true];
    }

    public function revokeDevice(string $userId, string $deviceId, string $reason, ?string $actorId = null): array
    {
        $db = Database::instance();
        $device = $db->row('SELECT id, user_id FROM devices WHERE id = ?', [$deviceId]);
        if ($device === null) {
            throw new ApiException(404, 'Device not found');
        }
        $isSelf = $device['user_id'] === $userId;
        $isAdmin = $this->isAdmin($actorId ?? $userId);
        if (!$isSelf && !$isAdmin) {
            throw new ApiException(403, 'Not authorized to revoke this device');
        }

        $db->query(
            "UPDATE devices SET status = 'logged_out', trust_level = 'revoked', revoked_at = UTC_TIMESTAMP(6), revoked_reason = ?
              WHERE id = ?",
            [$reason, $deviceId]
        );
        $this->sessions->revokeDeviceSessions($deviceId, 'device_revoked:' . $reason);
        AuditService::write($userId, 'device_force_logout', ['device_id' => $deviceId, 'reason' => $reason]);
        return ['success' => true];
    }

    /**
     * Admin bump: invalidates every session for a user by incrementing
     * profiles.security_version (matches bump_security_version RPC).
     */
    public function bumpSecurityVersion(string $userId, string $actorId): array
    {
        Database::instance()->query(
            'UPDATE profiles SET security_version = security_version + 1, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
            [$userId]
        );
        $this->sessions->revokeAllForUser($userId, 'security_version_bump');
        AuditService::write($actorId, 'security_event', ['action' => 'bump_security_version', 'user_id' => $userId]);
        return ['success' => true];
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------
    public function publicUser(string $userId): array
    {
        $row = Database::instance()->row(
            'SELECT id, email, phone, phone_e164, full_name, role, status, avatar_url, watermark_id
               FROM profiles WHERE id = ?',
            [$userId]
        );
        if ($row === null) {
            throw new ApiException(404, 'User not found');
        }
        return $row;
    }

    public function devicePayload(Request $request, array $data): array
    {
        return [
            'fingerprint' => trim((string) ($data['device_fingerprint'] ?? '')),
            'installation_id' => isset($data['installation_id']) && $data['installation_id'] !== '' ? (string) $data['installation_id'] : null,
            'device_name' => trim((string) ($data['device_name'] ?? 'Unknown Device')),
            'platform' => (string) ($data['platform'] ?? $request->platform()),
            'device_model' => isset($data['device_model']) ? (string) $data['device_model'] : null,
            'os' => isset($data['os']) ? (string) $data['os'] : null,
            'os_version' => isset($data['os_version']) ? (string) $data['os_version'] : null,
            'app_version' => isset($data['app_version']) ? (string) $data['app_version'] : null,
            'manufacturer' => isset($data['manufacturer']) ? (string) $data['manufacturer'] : null,
            'ip_address' => $request->clientIp(),
        ];
    }

    public function normalizePhone(string $phone): string
    {
        $phone = preg_replace('/[^\d+]/', '', $phone) ?? '';
        return $phone;
    }

    public function nextWatermarkId(): string
    {
        // sequential hex watermark (00173 made watermark_id sequential)
        $db = Database::instance();
        $db->query('UPDATE watermark_seq SET next_val = next_val + 1 WHERE id = 1');
        $n = (int) $db->value('SELECT next_val - 1 FROM watermark_seq WHERE id = 1', [], 0);
        return strtoupper(dechex($n));
    }

    private function isAdmin(string $userId): bool
    {
        $role = Database::instance()->value('SELECT role FROM profiles WHERE id = ?', [$userId]);
        return in_array($role, ['admin', 'super_admin'], true);
    }

    private function recordLogin(?string $userId, Request $request, bool $success, ?string $failureReason = null): void
    {
        // login_history.user_id is NOT NULL with an FK to profiles. A failed
        // login for an unknown identifier has no user row to reference, so we
        // cannot write the audit row without violating the constraint (which
        // turned a 401 into a 500). Mirrors Supabase, where failed logins for
        // unknown identifiers were not written by the auth service. The
        // attempt is still rate-limited + recorded in the rate_limits table.
        if ($userId === null) {
            return;
        }
        $device = $this->devicePayload($request, $request->json());
        Database::instance()->insert(
            'INSERT INTO login_history (id, user_id, device_fingerprint, device_name, platform, ip_address, success, failure_reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
            [
                Uuid::v4(),
                $userId,
                $device['fingerprint'],
                $device['device_name'],
                $device['platform'],
                $request->clientIp(),
                $success ? 1 : 0,
                $failureReason,
            ]
        );
    }

    private function rateLimit(string $identifier, int $max, int $windowSeconds): void
    {
        $db = Database::instance();
        $windowStart = gmdate('Y-m-d H:i:s', intdiv(time(), $windowSeconds) * $windowSeconds);
        $db->query(
            'INSERT INTO rate_limits (id, identifier, operation, window_start, request_count)
             VALUES (?, ?, ?, ?, 1)
             ON DUPLICATE KEY UPDATE request_count = request_count + 1',
            [Uuid::v4(), $identifier, 'auth', $windowStart]
        );
        $count = (int) $db->value(
            'SELECT request_count FROM rate_limits WHERE identifier = ? AND operation = ? AND window_start = ?',
            [$identifier, 'auth', $windowStart],
            0
        );
        if ($count > $max) {
            throw new ApiException(429, 'Too many attempts. Please try again later.', 'rate_limited');
        }
    }
}
