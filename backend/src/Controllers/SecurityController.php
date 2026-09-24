<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuthService;
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
