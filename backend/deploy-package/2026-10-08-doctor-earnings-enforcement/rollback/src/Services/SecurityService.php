<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Utils\Uuid;

/**
 * Security layer — PHP equivalent of get-security-config, security-logger,
 * process-violation and the device block/unblock flows.
 *
 * Violation policy (port of process-violation + 00054 content protection):
 *   - record the violation (content_protection_violations)
 *   - increment profiles.violation_count and strike_count
 *   - look up the action from content_protection_policies for the violation
 *     type (warn_only | strike_system | auto_logout | auto_suspend)
 *   - escalate: repeated strikes escalate the action
 */
final class SecurityService
{
    public function activeConfig(): array
    {
        $config = Database::instance()->row(
            'SELECT * FROM security_config WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1'
        );
        if ($config === null) {
            throw new ApiException(500, 'Security configuration missing');
        }
        return $config;
    }

    public function version(): array
    {
        $config = $this->activeConfig();
        return [
            'security_version' => (int) $config['security_version'],
            'minimum_app_version' => $config['minimum_app_version'],
            'minimum_supported_version' => $config['minimum_supported_version'],
            'latest_version' => $config['latest_version'],
            'force_update' => (bool) $config['force_update'],
            'update_title' => $config['update_title'],
            'update_message' => $config['update_message'],
            'android_store_url' => $config['android_store_url'],
            'ios_store_url' => $config['ios_store_url'],
        ];
    }

    /**
     * security-logger port: insert into security_events.
     */
    public function logEvent(string $userId, array $data): void
    {
        $allowed = ['event_type', 'detection_method', 'policy_action', 'risk_score', 'device_id', 'platform', 'app_version', 'ip_address', 'metadata'];
        $row = array_intersect_key($data, array_flip($allowed));
        try {
            Database::instance()->insert(
                'INSERT INTO security_events (id, user_id, event_type, detection_method, policy_action, risk_score, device_id, platform, app_version, ip_address, metadata, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
                [
                    Uuid::v4(),
                    $userId,
                    (string) ($row['event_type'] ?? 'screenshot_detected'),
                    $row['detection_method'] ?? null,
                    $row['policy_action'] ?? null,
                    isset($row['risk_score']) ? (int) $row['risk_score'] : null,
                    $row['device_id'] ?? null,
                    $row['platform'] ?? null,
                    $row['app_version'] ?? null,
                    $row['ip_address'] ?? null,
                    isset($row['metadata']) && is_array($row['metadata']) ? json_encode($row['metadata'], JSON_UNESCAPED_SLASHES) : null,
                ]
            );
        } catch (\PDOException $e) {
            // Surface the actual DB error safely — no secrets, no credentials.
            $sqlState = $e->getCode();
            $msg = $e->getMessage();
            // Redact any accidental credential leaks in the message
            $msg = preg_replace('/password[:=]\s*\S+/i', 'password=[REDACTED]', $msg);
            $msg = preg_replace('/user[:=]\s*\S+/i', 'user=[REDACTED]', $msg);
            throw new ApiException(500, 'DB error [' . $sqlState . ']: ' . $msg);
        }
    }

    /**
     * process-violation port — the real Edge Function logic:
     *   - single policy row (id 00000000-0000-0000-0000-000000000001) with
     *     strike1_action / strike2_action / strike3_action
     *   - non-student roles are EXEMPT (no penalties)
     *   - strike count caps at 3; action escalates 1→2→3
     *   - suspend/ban sets is_suspended + status + suspension_device
     *   - violation + security_event rows are recorded
     */
    public function processViolation(string $userId, array $data): array
    {
        $violationType = (string) ($data['violation_type'] ?? '');
        if ($violationType === '') {
            throw new ApiException(400, 'user_id and violation_type are required');
        }
        $db = Database::instance();

        $policy = $db->row(
            "SELECT * FROM content_protection_policies WHERE id = '00000000-0000-0000-0000-000000000001' LIMIT 1"
        );

        // If the policy row doesn't exist, use safe defaults.
        // The original Supabase DB had this row seeded by migration.
        $strikeActions = [
            1 => ($policy['strike1_action'] ?? null) ?? 'warning',
            2 => ($policy['strike2_action'] ?? null) ?? 'logout',
            3 => ($policy['strike3_action'] ?? null) ?? 'suspend',
        ];

        $profile = $db->row(
            'SELECT violation_count, strike_count, is_suspended, role FROM profiles WHERE id = ?',
            [$userId]
        );
        if ($profile === null) {
            throw new ApiException(404, 'User not found');
        }

        // Role guard: content protection applies to students only
        if ($profile['role'] !== 'student') {
            return ['action' => 'exempt', 'role' => $profile['role'], 'strike_count' => 0, 'violation_count' => 0];
        }

        if ((bool) $profile['is_suspended']) {
            return ['action' => 'suspend', 'already_suspended' => true];
        }

        $newViolationCount = ((int) $profile['violation_count']) + 1;
        $newStrikeCount = min(((int) $profile['strike_count']) + 1, 3);
        $actionKey = min($newStrikeCount, 3);
        $actionTaken = $strikeActions[$actionKey] ?? 'warning';

        $isSuspend = in_array($actionTaken, ['suspend', 'ban'], true);
        $deviceId = isset($data['device_id']) ? (string) $data['device_id'] : null;

        // Map content_protection strike actions to security_events policy_action values.
        // security_events.policy_action CHECK constraint allows:
        //   log_only, warn_only, block_video, block_login
        // content_protection_policies strike actions are:
        //   warning, logout, suspend, ban
        $policyActionMap = [
            'warning' => 'warn_only',
            'logout'  => 'block_login',
            'suspend' => 'block_login',
            'ban'     => 'block_login',
        ];
        $policyAction = $policyActionMap[$actionTaken] ?? 'log_only';

        $db->transaction(function (Database $db) use ($userId, $violationType, $data, $profile, $newViolationCount, $newStrikeCount, $actionTaken, $policyAction, $isSuspend, $deviceId) {
            if ($isSuspend) {
                $db->query(
                    "UPDATE profiles SET
                        violation_count = ?, strike_count = ?,
                        is_suspended = 1, status = 'suspended',
                        suspension_reason = 'Content Protection Violation',
                        suspension_at = UTC_TIMESTAMP(6),
                        suspension_device = ?,
                        updated_at = UTC_TIMESTAMP(6)
                      WHERE id = ?",
                    [
                        $newViolationCount,
                        $newStrikeCount,
                        json_encode([
                            'device_id' => $deviceId,
                            'device_name' => $data['device_name'] ?? null,
                            'platform' => $data['platform'] ?? null,
                            'installation_id' => $data['installation_id'] ?? null,
                        ], JSON_UNESCAPED_SLASHES),
                        $userId,
                    ]
                );
            } else {
                $db->query(
                    'UPDATE profiles SET violation_count = ?, strike_count = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
                    [$newViolationCount, $newStrikeCount, $userId]
                );
            }

            $db->insert(
                'INSERT INTO content_protection_violations
                   (id, user_id, violation_type, strike_count, action_taken, device_id, device_name,
                    platform, installation_id, session_id, ip_address, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
                [
                    Uuid::v4(),
                    $userId,
                    $violationType,
                    $newStrikeCount,
                    $actionTaken,
                    $deviceId,
                    $data['device_name'] ?? null,
                    $data['platform'] ?? null,
                    $data['installation_id'] ?? null,
                    $data['session_id'] ?? null,
                    $data['ip_address'] ?? null,
                ]
            );

            $db->insert(
                'INSERT INTO security_events
                   (id, user_id, device_id, event_type, detection_method, policy_action, risk_score,
                    ip_address, platform, app_version, metadata, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
                [
                    Uuid::v4(),
                    $userId,
                    $deviceId,
                    $violationType,
                    'device_detector',
                    $policyAction,
                    null,
                    $data['ip_address'] ?? null,
                    $data['platform'] ?? null,
                    $data['app_version'] ?? null,
                    json_encode(['violation_type' => $violationType], JSON_UNESCAPED_SLASHES),
                ]
            );
        });

        // force-logout the device on logout/suspend/ban actions
        if (in_array($actionTaken, ['logout', 'suspend', 'ban'], true) && $deviceId !== null) {
            (new \MedAcademy\Auth\SessionManager())->revokeDeviceSessions($deviceId, 'content_protection_violation');
        }

        AuditService::write($userId, 'security_event', [
            'event' => 'content_protection_violation',
            'violation_type' => $violationType,
            'action' => $actionTaken,
        ]);

        return ['success' => true, 'action' => $actionTaken, 'strike_count' => $newStrikeCount, 'violation_count' => $newViolationCount];
    }

    public function blockDevice(string $deviceId, string $actorId, ?string $reason = null): void
    {
        Database::instance()->query(
            "UPDATE devices SET status = 'blocked', block_reason = ?, blocked_at = UTC_TIMESTAMP(6), blocked_by = ?
              WHERE id = ?",
            [$reason ?? 'Blocked by administrator', $actorId, $deviceId]
        );
        (new \MedAcademy\Auth\SessionManager())->revokeDeviceSessions($deviceId, 'device_blocked');
        AuditService::write($actorId, 'security_event', ['device_id' => $deviceId, 'action' => 'block_device']);
    }

    public function unblockDevice(string $deviceId, string $actorId): void
    {
        Database::instance()->query(
            "UPDATE devices SET status = 'active', block_reason = NULL, blocked_at = NULL, blocked_by = NULL
              WHERE id = ?",
            [$deviceId]
        );
        AuditService::write($actorId, 'security_event', ['device_id' => $deviceId, 'action' => 'unblock_device']);
    }
}
