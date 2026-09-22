<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuditService;
use MedAcademy\Services\MaintenanceService;

/**
 * Maintenance Mode — status read (public) + Super-Admin-only management.
 *
 * Route table (registered in routes/api.php):
 *   GET  /maintenance           — public status: { enabled, message, retryAfter }
 *   GET  /admin/maintenance     — SA only: status + whitelist count
 *   POST /admin/maintenance     — SA only: { enabled, message? } → toggle
 *
 * The toggle is the ONLY sanctioned write path for maintenance_enabled /
 * maintenance_message (the generic Data API no longer accepts writes to
 * system_config — see DataController::WRITE_ADMIN_ONLY_TABLES). It flushes
 * the MaintenanceService cache so the new state is visible immediately.
 */
final class MaintenanceController
{
    public function __construct(
        private readonly MaintenanceService $maintenance = new MaintenanceService()
    ) {
    }

    /**
     * GET /maintenance — the client's bootstrap probe. Public so a blocked-
     * out user's app can render the correct maintenance screen (and recover
     * automatically when maintenance ends).
     */
    public function status(Request $request): array
    {
        $cfg = $this->maintenance->config();
        return [
            'enabled'    => $cfg['enabled'],
            'message'    => $cfg['message'],
            'retryAfter' => MaintenanceService::DEFAULT_RETRY_AFTER,
        ];
    }

    /** GET /admin/maintenance — SA management view. */
    public function adminStatus(Request $request): array
    {
        $cfg = $this->maintenance->config();
        $whitelistCount = (int) \MedAcademy\Database\Database::instance()->value(
            'SELECT COUNT(*) FROM `maintenance_whitelist`',
            [],
            0
        );
        return [
            'enabled'         => $cfg['enabled'],
            'message'         => $cfg['message'],
            'retryAfter'      => MaintenanceService::DEFAULT_RETRY_AFTER,
            'whitelist_count' => $whitelistCount,
        ];
    }

    /**
     * POST /admin/maintenance — enable/disable + optional message.
     * Super Admin only (enforced at the router AND re-checked here).
     */
    public function update(Request $request): array
    {
        if (($request->user['role'] ?? '') !== 'super_admin') {
            throw new ApiException(403, 'Only Super Admin can change maintenance mode');
        }

        $body = $request->json();
        if (!is_array($body) || !array_key_exists('enabled', $body)) {
            throw new ApiException(422, 'Field "enabled" (boolean) is required');
        }
        $enabled = filter_var($body['enabled'], FILTER_VALIDATE_BOOLEAN);
        $message = array_key_exists('message', $body) && is_string($body['message'])
            ? trim($body['message'])
            : null;
        if ($message !== null && mb_strlen($message) > 500) {
            throw new ApiException(422, 'message must be 500 characters or fewer');
        }

        $db = \MedAcademy\Database\Database::instance();
        $actorId = (string) ($request->user['id'] ?? '');
        $this->writeConfigKey($db, MaintenanceService::KEY_ENABLED, $enabled, $actorId);
        if ($message !== null) {
            $this->writeConfigKey($db, MaintenanceService::KEY_MESSAGE, $message, $actorId);
        }

        MaintenanceService::flushCache();

        AuditService::write($actorId, 'platform_settings_changed', [
            'setting'  => 'maintenance_mode',
            'enabled'  => $enabled,
        ]);

        $cfg = $this->maintenance->config();
        return [
            'enabled'    => $cfg['enabled'],
            'message'    => $cfg['message'],
            'retryAfter' => MaintenanceService::DEFAULT_RETRY_AFTER,
        ];
    }

    /**
     * Upsert one system_config row with a JSON-encoded value (the column is
     * JSON — MaintenanceService::config() decodes both encoded and raw forms).
     */
    private function writeConfigKey(\MedAcademy\Database\Database $db, string $key, mixed $value, string $actorId): void
    {
        $encoded = json_encode($value);
        $db->query(
            'INSERT INTO `system_config` (`key`, `value`, `updated_by`, `updated_at`)
             VALUES (?, ?, ?, UTC_TIMESTAMP(6))
             ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), `updated_by` = VALUES(`updated_by`), `updated_at` = UTC_TIMESTAMP(6)',
            [$key, $encoded, $actorId]
        );
    }
}
