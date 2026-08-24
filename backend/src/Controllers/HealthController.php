<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Utils\Config;

/**
 * Ports of the system-health / provider-health Edge Functions.
 */
final class HealthController
{
    /**
     * Root route — service identity only, no internals.
     */
    public function root(Request $request): array
    {
        return [
            'name' => 'MedAcademy API',
            'version' => '1.0.0',
            'health' => '/api/health',
        ];
    }

    public function health(Request $request): array
    {
        $dbOk = true;
        $dbError = null;
        try {
            Database::instance()->value('SELECT 1');
        } catch (\Throwable $e) {
            $dbOk = false;
            $dbError = 'database_unavailable';
        }
        return [
            'status' => $dbOk ? 'ok' : 'degraded',
            'services' => [
                'database' => $dbOk ? 'ok' : 'error',
                'api' => 'ok',
            ],
            'timestamp' => gmdate('Y-m-d\TH:i:s\Z'),
            // deliberately abstract — never surface the underlying exception
            'error' => $dbError,
            'version' => '1.0.0',
        ];
    }

    public function systemHealth(Request $request): array
    {
        return [
            'status' => 'ok',
            'database' => 'ok',
            'storage_writable' => is_writable(MEDACADEMY_BASE . '/storage'),
            'timestamp' => gmdate('Y-m-d\TH:i:s\Z'),
        ];
    }

    public function providerHealth(Request $request): array
    {
        $providers = Database::instance()->select(
            'SELECT id, provider_key, display_name, category, is_active, is_default, status, status_message,
                    last_health_check, version
               FROM provider_registry ORDER BY display_name'
        );
        return ['providers' => $providers];
    }
}
