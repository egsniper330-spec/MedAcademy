<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Http\Request;
use MedAcademy\Services\AppUpdateService;

/**
 * App update configuration endpoints.
 *
 *   GET  /app/version                    — PUBLIC. Platform resolved from
 *       X-App-Platform (fallback: ?platform= or android). Never blocked by the
 *       update gate (an old client must always be able to learn the update URL).
 *       Serves { platform, enabled:false } when the feature is off/table
 *       missing so clients fail-open gracefully.
 *
 *   GET  /admin/app-updates              — Super Admin only. All platforms.
 *   PUT  /admin/app-updates/{platform}   — Super Admin only. Validated upsert.
 *
 * Authorization model mirrors the existing conventions: the route table
 * declares auth + role ['super_admin'] for the admin pair; this controller
 * never trusts client input for authorization.
 */
final class UpdateConfigController
{
    public function __construct(
        private readonly AppUpdateService $updates = new AppUpdateService()
    ) {
    }

    public function version(Request $request): array
    {
        $header = $request->header('x-app-platform');
        $platform = $header !== null && trim($header) !== ''
            ? strtolower(trim($header))
            : 'android';

        return $this->updates->publicPayload($platform);
    }

    public function adminIndex(Request $request): array
    {
        $all = $this->updates->allConfigs();
        // mig028 integration: app_releases.publish() promotes its values into
        // app_update_config, so this admin view reflects the PUBLISHED
        // production release — a draft/ready release never appears here.
        // (Rows without a release history keep their manually-set values.)
        $out = [];
        foreach (AppUpdateService::PLATFORMS as $p) {
            $row = $all !== null ? ($all[$p] ?? null) : null;
            $out[] = $row !== null ? $this->updates->publicPayload($p) : [
                'platform' => $p,
                'enabled'  => false,
                'exists'   => false,
            ];
        }
        return ['platforms' => $out];
    }

    public function adminUpdate(Request $request): array
    {
        // Route token is {platform} (routes/api.php). Accept 'id' too so a
        // future {id} route rename cannot silently 422 every save again
        // (the deployed build failed here with "Unsupported platform" because
        // the controller read a token name the route never produces).
        $platform = strtolower(trim((string) (
            $request->params['platform'] ?? $request->params['id'] ?? ''
        )));
        return $this->updates->upsert(
            $platform,
            $request->json(),
            (string) $request->user['id']
        );
    }
}
