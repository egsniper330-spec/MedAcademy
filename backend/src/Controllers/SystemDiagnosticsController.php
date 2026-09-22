<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuditService;
use MedAcademy\Services\SystemDiagnosticsService;

/**
 * Super Admin system diagnostics endpoints.
 *
 * GET  /admin/system/diagnostics          → full scan (all services)
 * GET  /admin/system/diagnostics/{id}     → single service re-check
 *
 * SECURITY:
 *  • Route middleware enforces auth + role=super_admin (see routes/api.php).
 *  • The service NEVER returns secret values — only presence metadata
 *    ("configured": true). See SystemDiagnosticsService for the redaction
 *    contract; this controller additionally strips any unexpected keys.
 *  • A safe audit entry is written (metadata only — no secrets, no raw
 *    exception text).
 */
final class SystemDiagnosticsController
{
    public function scan(Request $request): array
    {
        AuditService::write(
            $request->user['id'] ?? null,
            'system_health_check',
            ['scope' => 'full_scan'],
            $request->clientIp()
        );

        $report = (new SystemDiagnosticsService())->scanAll();
        return $this->allowOnly($report, $this->allowedKeys());
    }

    public function checkOne(Request $request): array
    {
        $id = (string) ($request->params['id'] ?? '');
        if ($id === '' || !preg_match('/^[a-z_]{1,40}$/', $id)) {
            throw new ApiException(422, 'Invalid service id');
        }

        AuditService::write(
            $request->user['id'] ?? null,
            'system_health_check',
            ['scope' => 'single', 'service' => $id],
            $request->clientIp()
        );

        $result = (new SystemDiagnosticsService())->checkOne($id);
        return $this->allowOnly($result, $this->allowedKeys());
    }

    /**
     * Defense in depth: recursively strip any key not on the allow-list so a
     * future service change can never leak an unexpected field to the client.
     */
    private function allowOnly(mixed $node, array $keys): mixed
    {
        if (is_array($node)) {
            $isList = array_is_list($node);
            $out = [];
            foreach ($node as $k => $v) {
                if ($isList) {
                    $out[] = $this->allowOnly($v, $keys);
                } elseif (is_string($k) && in_array($k, $keys, true)) {
                    $out[$k] = $this->allowOnly($v, $keys);
                }
                // Disallowed keys are dropped silently (never sent to client).
            }
            return $out;
        }
        return $node;
    }

    private function allowedKeys(): array
    {
        return [
            'id', 'name', 'category', 'status', 'message', 'errorCode',
            'httpStatus', 'latencyMs', 'lastChecked', 'checks',
            'recommendedAction', 'exceptionDetail', 'generatedAt',
            'results', 'summary', 'meta',
        ];
    }
}
