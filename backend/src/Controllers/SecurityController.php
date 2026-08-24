<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuthService;
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

    public function reportEvent(Request $request): array
    {
        try {
            $this->security->logEvent($request->user['id'], $request->json());
            return ['success' => true];
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
