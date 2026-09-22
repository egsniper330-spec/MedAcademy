<?php

declare(strict_types=1);

namespace MedAcademy\Middleware;

use MedAcademy\Http\Request;
use MedAcademy\Services\MaintenanceService;

/**
 * Centralized MAINTENANCE GATE — runs before routing for EVERY request
 * (see public/index.php). When a Super Admin enables Maintenance Mode, all
 * non-exempt callers receive HTTP 503 { error: { code: 'maintenance_mode',
 * maintenance: { enabled, message, retryAfter } } }.
 *
 * Server-authorized exemptions (never client-declared):
 *   - route-level `['maintenance' => false]` options (public auth, health,
 *     the maintenance status read, and the SA's own management endpoints)
 *   - the authenticated Super Admin role / maintenance_whitelist rows
 *     (the middleware instance that reaches exemptions carries the verified
 *     identity from AuthMiddleware; anonymous callers are never exempt)
 *
 * NOTE on evaluation order: this gate runs BEFORE the router dispatches, so
 * the route's own options are not yet resolved. Route exemption is expressed
 * with a static prefix list here — the same list documents itself in
 * routes/api.php (every exempt route is annotated with a comment).
 */
final class MaintenanceMiddleware
{
    /**
     * Route-path prefixes that REMAIN reachable during maintenance:
     * health/system status, the public auth set needed to sign in/out and
     * refresh, the maintenance status endpoint itself, and the Super Admin's
     * own management routes (defense in depth — those are already
     * super_admin-only at the router level).
     */
    private const EXEMPT_PREFIXES = [
        '/',                       // HealthController::root (bare /)
        '/health', '/api/health', '/system-health', '/provider-health',
        '/auth/login', '/auth/refresh', '/auth/logout', '/auth/lookup',
        '/auth/pre-login-check', '/auth/forgot-password', '/auth/reset-password',
        '/auth/register',
        '/maintenance',            // status read + SA management (POST/PUT/DELETE under it)
        '/admin/app-updates',      // SA can fix a bad update config while maintenance is on
        '/app/version',            // update discovery must keep working
    ];

    public function handle(Request $request): void
    {
        $path = '/' . ltrim($request->path(), '/');
        foreach (self::EXEMPT_PREFIXES as $prefix) {
            if ($prefix === '/') {
                if ($path === '/') return;
                continue;
            }
            if ($path === $prefix || str_starts_with($path, $prefix . '/')) {
                return;
            }
        }

        // Identity: only what the AUTH LAYER has already verified for this
        // request. AuthMiddleware runs later (inside the router), so at this
        // point the bearer token is decoded WITHOUT trusting any client header
        // for the role — the profile row is read from the database here.
        $svc = MaintenanceService::tracked(...$this->verifiedIdentity($request));

        if (!$svc->blocks()) {
            return;
        }

        $cfg = $svc->config();
        $retryAfter = MaintenanceService::DEFAULT_RETRY_AFTER;

        // 503 with the maintenance contract: Retry-After header for well-behaved
        // HTTP clients + the structured body the RN client keys on (same
        // envelope convention as the 426 UPDATE_REQUIRED gate).
        \MedAcademy\Http\Response::error(
            $cfg['message'],
            503,
            'maintenance_mode',
            [],
            [
                'retryAfter'  => $retryAfter,
                'maintenance' => [
                    'enabled'    => true,
                    'message'    => $cfg['message'],
                    'retryAfter' => $retryAfter,
                ],
            ]
        );
    }

    /**
     * Resolve { role, id } from the bearer token by reading the profiles row —
     * identical trust level to AuthMiddleware (DB is the authority), but kept
     * independent so the gate works for BOTH authenticated and anonymous
     * requests. Anonymous → ['', ''] → never exempt.
     *
     * @return array{0: string, 1: string}
     */
    private function verifiedIdentity(Request $request): array
    {
        $token = $request->bearerToken();
        if ($token === null || $token === '') {
            return ['', ''];
        }
        try {
            $claims = \MedAcademy\Auth\Jwt::decode($token);
            $userId = (string) ($claims['sub'] ?? '');
            if ($userId === '') {
                return ['', ''];
            }
            $row = \MedAcademy\Database\Database::instance()->row(
                'SELECT id, role FROM profiles WHERE id = ?',
                [$userId]
            );
            if ($row === null) {
                return ['', ''];
            }
            return [(string) $row['role'], (string) $row['id']];
        } catch (\Throwable) {
            return ['', ''];
        }
    }
}
