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

    /**
     * Admin-only diagnostics (route is gated to admin / super_admin).
     * Each subsystem reports status and latency only. Errors are generic codes:
     * raw exception text, SQL, hosts and paths are never returned.
     */
    public function systemHealth(Request $request): array
    {
        $subsystems = [];

        $start = microtime(true);
        try {
            Database::instance()->value('SELECT 1');
            $subsystems['database'] = [
                'name' => 'Database',
                'status' => 'ok',
                'latencyMs' => (int) round((microtime(true) - $start) * 1000),
            ];
        } catch (\Throwable $e) {
            $subsystems['database'] = [
                'name' => 'Database',
                'status' => 'error',
                'latencyMs' => (int) round((microtime(true) - $start) * 1000),
                'error' => 'database_unavailable',
            ];
        }

        $storageWritable = is_writable(MEDACADEMY_BASE . '/storage');
        $subsystems['storage'] = [
            'name' => 'Local storage',
            'status' => $storageWritable ? 'ok' : 'error',
            'latencyMs' => 0,
            'error' => $storageWritable ? '' : 'storage_not_writable',
        ];

        $overall = 'ok';
        foreach ($subsystems as $s) {
            if ($s['status'] !== 'ok') {
                $overall = 'degraded';
                break;
            }
        }

        return [
            'status' => $overall,
            'version' => '1.0.0',
            'subsystems' => $subsystems,
            'timestamp' => gmdate('Y-m-d\TH:i:s\Z'),
        ];
    }

    /**
     * Admin-only provider status. Internal fields (status_message, version)
     * are excluded: they can contain provider account or error details.
     */
    public function providerHealth(Request $request): array
    {
        $providers = Database::instance()->select(
            'SELECT provider_key, display_name, category, is_active, is_default, status, last_health_check
               FROM provider_registry ORDER BY display_name'
        );
        return ['providers' => $providers];
    }
}
