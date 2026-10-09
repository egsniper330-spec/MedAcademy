<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuthService;
use MedAcademy\Services\AuditService;
use MedAcademy\Services\FeatureFlagService;
use MedAcademy\Services\SecurityService;

final class SecurityController
{
    public function __construct(
        private readonly SecurityService $security = new SecurityService(),
        private readonly AuthService $auth = new AuthService()
    ) {
    }

    public function config(Request $request): array
    {
        $config = $this->security->activeConfig();
        // expose only what the app needs — never internal fields
        return [
            'play_integrity_enabled' => (bool) $config['play_integrity_enabled'],
            'expected_cert_sha256' => $config['expected_cert_sha256'],
            'expected_cert_sha256s' => json_decode((string) $config['expected_cert_sha256s'], true) ?: [],
            'minimum_app_version' => $config['minimum_app_version'],
            'force_update' => (bool) $config['force_update'],
            'security_version' => (int) $config['security_version'],
            'extras' => json_decode((string) $config['extras'], true) ?: [],
        ];
    }

    public function version(Request $request): array
    {
        return $this->security->version();
    }

    /**
     * GET /security/policies — per-detection enforcement policies + VPN
     * whitelist names, from the authoritative DB tables.
     *
     * Server-side policy of record: security_policies (one row per detection
     * type) and security_vpn_whitelist. Exposed to ANY authenticated session:
     * rows contain only action/enabled/name fields — no secrets, no user data.
     * Previously the client fetched the whitelist through the generic data API,
     * which is admin-only → every Doctor/Student got a 403 and the whitelist
     * feature silently never applied.
     */
    public function policies(Request $request): array
    {
        $db = Database::instance();

        $rows = $db->select(
            'SELECT detection_type, action, enabled FROM security_policies'
        );
        $policies = [];
        foreach ($rows ?? [] as $r) {
            $policies[(string) $r['detection_type']] = [
                'action'  => (string) $r['action'],
                'enabled' => (bool) $r['enabled'],
            ];
        }

        $vpnWhitelist = array_map(
            static fn (array $r): string => strtolower((string) $r['name']),
            $db->select('SELECT name FROM security_vpn_whitelist') ?? []
        );

        return [
            'policies'      => $policies,
            'vpn_whitelist' => $vpnWhitelist,
        ];
    }

    /**
     * Valid detection-type buckets (mirror of the DB CHECK constraint on
     * security_policies.detection_type — schema.sql:1324). Server-side
     * validation; the client can never insert an unknown bucket.
     */
    private const POLICY_TYPES = [
        'root_jailbreak', 'vpn', 'proxy', 'ssl_pinning', 'debug',
        'screenshot', 'screen_recording', 'app_integrity', 'developer_options',
        'frida', 'xposed', 'magisk', 'overlay', 'tamper', 'play_integrity',
    ];

    /** Valid enforcement actions (same allowlist the client accepts). */
    private const POLICY_ACTIONS = ['log_only', 'warn_only', 'block_video', 'block_login'];

    /**
     * MANDATORY-BLOCK policy buckets (DB migration 016 — owner requirement):
     * these four debug/tamper surfaces must stay enabled + block_login. The
     * write path refuses any change that would weaken them, so the admin UI
     * cannot accidentally (or maliciously) disable mandatory security.
     */
    private const MANDATORY_BLOCK = ['developer_options', 'debug', 'tamper', 'play_integrity'];

    /**
     * GET /admin/security/policies — full policy rows + VPN whitelist for the
     * SA management UI (includes id/updated_at/added_by — unlike the public
     * /security/policies which exposes only action/enabled/name).
     */
    public function adminPolicies(Request $request): array
    {
        $db = Database::instance();
        return [
            'policies'      => $db->select(
                'SELECT id, detection_type, action, enabled, updated_by, updated_at
                 FROM security_policies ORDER BY detection_type'
            ) ?? [],
            'vpn_whitelist' => $db->select(
                'SELECT id, name, description, added_by, created_at
                 FROM security_vpn_whitelist ORDER BY created_at'
            ) ?? [],
        ];
    }

    /**
     * PUT /admin/security/policies/{type} — update one detection bucket.
     *
     * Validated (type + action allowlists), Super-Admin-only (route gate AND
     * the role middleware above), audited via AuditService, and stamped with
     * updated_by. Mandatory-block buckets refuse weakening changes (422).
     * Route registration lives in routes/api.php.
     */
    public function updatePolicy(Request $request): array
    {
        $type   = (string) ($request->params['type'] ?? '');
        $body   = $request->json();

        if (!in_array($type, self::POLICY_TYPES, true)) {
            throw new ApiException(422, "Unknown detection type '{$type}'");
        }
        $action  = $body['action'] ?? null;
        $enabled = $body['enabled'] ?? null;
        if ($action !== null && !in_array($action, self::POLICY_ACTIONS, true)) {
            throw new ApiException(422, "Invalid action '{$action}'");
        }
        if ($enabled !== null && !is_bool($enabled)) {
            throw new ApiException(422, "'enabled' must be a boolean");
        }
        if ($action === null && $enabled === null) {
            throw new ApiException(422, 'Nothing to update: provide action and/or enabled');
        }

        // Mandatory protection: fail-closed buckets cannot be weakened.
        if (in_array($type, self::MANDATORY_BLOCK, true)) {
            $weakened =
                ($action !== null && $action !== 'block_login')
                || ($enabled === false);
            if ($weakened) {
                throw new ApiException(422,
                    "Policy '{$type}' is a mandatory security block and cannot be weakened");
            }
        }

        $db = Database::instance();
        $sets = ['updated_by = ?', 'updated_at = CURRENT_TIMESTAMP(6)'];
        $params = [$request->user['id'] ?? null];
        if ($action !== null)  { $sets[] = 'action = ?';  $params[] = $action; }
        if ($enabled !== null) { $sets[] = 'enabled = ?'; $params[] = $enabled ? 1 : 0; }
        $params[] = $type;

        $db->transaction(function (Database $db) use ($sets, $params, $type, $action, $enabled, $request): void {
            $db->insert(
                'UPDATE security_policies SET ' . implode(', ', $sets) . ' WHERE detection_type = ?',
                $params
            );
            AuditService::write($request->user['id'] ?? null, 'security_policy_update', [
                'detection_type' => $type,
                'action'         => $action,
                'enabled'        => $enabled,
            ]);
        });

        $row = $db->row(
            'SELECT id, detection_type, action, enabled, updated_by, updated_at
             FROM security_policies WHERE detection_type = ?', [$type]
        );
        return ['policy' => $row];
    }

    /**
     * POST /admin/security/vpn-whitelist — add a trusted VPN name.
     * Validated (length, charset), audited, stamped with added_by.
     */
    public function addVpnWhitelist(Request $request): array
    {
        $body = $request->json();
        $name = trim((string) ($body['name'] ?? ''));
        $description = array_key_exists('description', $body)
            ? trim((string) $body['description']) : null;
        if ($name === '' || mb_strlen($name) > 191) {
            throw new ApiException(422, 'VPN name must be 1-191 characters');
        }
        if ($description !== null && $description === '') $description = null;

        $db = Database::instance();
        $id = null;
        $db->transaction(function (Database $db) use (&$id, $name, $description, $request): void {
            $id = Uuid::v4();
            $db->insert(
                'INSERT INTO security_vpn_whitelist (id, name, description, added_by)
                 VALUES (?, ?, ?, ?)',
                [$id, $name, $description, $request->user['id'] ?? null]
            );
            AuditService::write($request->user['id'] ?? null, 'security_vpn_whitelist_add', ['name' => $name]);
        });

        return ['entry' => $db->row(
            'SELECT id, name, description, added_by, created_at FROM security_vpn_whitelist WHERE id = ?', [$id]
        )];
    }

    /**
     * DELETE /admin/security/vpn-whitelist/{id} — remove a whitelist entry. Audited.
     */
    public function deleteVpnWhitelist(Request $request): array
    {
        $id = \MedAcademy\Utils\Uuid::normalize((string) ($request->params['id'] ?? ''));
        if (!preg_match('/^[0-9a-fA-F-]{36}$/', $id)) {
            throw new ApiException(422, 'Invalid whitelist id');
        }
        $db = Database::instance();
        $row = $db->row('SELECT id, name FROM security_vpn_whitelist WHERE id = ?', [$id]);
        if ($row === null) {
            throw new ApiException(404, 'Whitelist entry not found');
        }
        $db->transaction(function (Database $db) use ($id, $row, $request): void {
            $db->insert('DELETE FROM security_vpn_whitelist WHERE id = ?', [$id]);
            AuditService::write($request->user['id'] ?? null, 'security_vpn_whitelist_remove', [
                'id' => $id, 'name' => (string) $row['name'],
            ]);
        });
        return ['ok' => true];
    }

    public function reportEvent(Request $request): array
    {
        try {
            $body = $request->json();

            // Batch support: the app's logThreats() posts an ARRAY of events (one
            // per detected threat) in a single request. Accept both shapes so the
            // batched evidence pipeline actually persists every event — previously
            // the array was coerced to a string and every batch failed at the DB.
            $events = [];
            if (array_is_list($body)) {
                foreach ($body as $item) {
                    if (is_array($item)) {
                        $events[] = $item;
                    }
                }
            } else {
                $events[] = $body;
            }

            foreach ($events as $event) {
                $this->security->logEvent($request->user['id'], $event);
            }

            return ['success' => true, 'recorded' => count($events)];
        } catch (\PDOException $e) {
            $sqlState = $e->getCode();
            $msg = $e->getMessage();
            $msg = preg_replace('/password[:=]\s*\S+/i', 'password=[REDACTED]', $msg);
            throw new \MedAcademy\Http\ApiException(500, 'DB error [' . $sqlState . ']: ' . $msg);
        } catch (\Throwable $e) {
            $cls = get_class($e);
            throw new \MedAcademy\Http\ApiException(500, 'Exception [' . $cls . ']: ' . $e->getMessage());
        }
    }

    public function reportViolation(Request $request): array
    {
        try {
            return $this->security->processViolation($request->user['id'], $request->json());
        } catch (\PDOException $e) {
            $sqlState = $e->getCode();
            $msg = $e->getMessage();
            $msg = preg_replace('/password[:=]\s*\S+/i', 'password=[REDACTED]', $msg);
            throw new \MedAcademy\Http\ApiException(500, 'DB error [' . $sqlState . ']: ' . $msg);
        } catch (\Throwable $e) {
            $cls = get_class($e);
            throw new \MedAcademy\Http\ApiException(500, 'Exception [' . $cls . ']: ' . $e->getMessage());
        }
    }

    public function bumpVersion(Request $request): array
    {
        $userId = \MedAcademy\Utils\Uuid::normalize((string) $request->params['id']);
        return $this->auth->bumpSecurityVersion($userId, $request->user['id']);
    }

    public function blockDevice(Request $request): array
    {
        // Device-management kill switch (same policy as the admin reset path).
        (new FeatureFlagService())->assertEnabled('device_management', $request);

        $deviceId = \MedAcademy\Utils\Uuid::normalize((string) $request->params['id']);
        $reason = isset($request->json()['reason']) ? (string) $request->json()['reason'] : null;
        $this->security->blockDevice($deviceId, $request->user['id'], $reason);
        return ['success' => true];
    }

    public function unblockDevice(Request $request): array
    {
        $deviceId = \MedAcademy\Utils\Uuid::normalize((string) $request->params['id']);
        $this->security->unblockDevice($deviceId, $request->user['id']);
        return ['success' => true];
    }
}
