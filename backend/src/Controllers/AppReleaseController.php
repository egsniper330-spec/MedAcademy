<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AppReleaseService;

/**
 * AppReleaseController — Super Admin production version management.
 *
 * Every action is Super Admin-only (route-level role gate + explicit check).
 * Releases are DRAFT/READY/PUBLISHED/ARCHIVED; ONLY publish()/rollback()
 * change Current Production — creating or editing a draft never does.
 */
final class AppReleaseController
{
    public function __construct(
        private readonly AppReleaseService $releases = new AppReleaseService()
    ) {
    }

    /** GET /admin/app-releases — overview: current production + history. */
    public function index(Request $request): array
    {
        $this->assertSuperAdmin($request);
        $overview = $this->releases->overview();
        return [
            'platforms' => [
                'android' => $overview['android'],
                'ios' => $overview['ios'],
            ],
        ];
    }

    /** POST /admin/app-releases — create a draft/ready release (never publishes). */
    public function create(Request $request): array
    {
        $this->assertSuperAdmin($request);
        return $this->releases->createRelease(
            $request->json(),
            (string) $request->user['id']
        );
    }

    /** PUT /admin/app-releases/{id} — edit a draft/ready release (never publishes). */
    public function update(Request $request): array
    {
        $this->assertSuperAdmin($request);
        $id = (string) ($request->params['id'] ?? '');
        if ($id === '') {
            throw new ApiException(422, 'Release id is required');
        }
        return $this->releases->updateRelease($id, $request->json(), (string) $request->user['id']);
    }

    /** POST /admin/app-releases/{id}/publish — THE production-changing action. */
    public function publish(Request $request): array
    {
        $this->assertSuperAdmin($request);
        $id = (string) ($request->params['id'] ?? '');
        if ($id === '') {
            throw new ApiException(422, 'Release id is required');
        }
        return $this->releases->publish($id, (string) $request->user['id']);
    }

    /** POST /admin/app-releases/{id}/rollback — re-activate a previous production release. */
    public function rollback(Request $request): array
    {
        $this->assertSuperAdmin($request);
        $id = (string) ($request->params['id'] ?? '');
        if ($id === '') {
            throw new ApiException(422, 'Release id is required');
        }
        return $this->releases->rollback($id, (string) $request->user['id']);
    }

    /** POST /admin/app-releases/{id}/archive — archive a draft/ready release. */
    public function archive(Request $request): array
    {
        $this->assertSuperAdmin($request);
        $id = (string) ($request->params['id'] ?? '');
        if ($id === '') {
            throw new ApiException(422, 'Release id is required');
        }
        return $this->releases->archive($id, (string) $request->user['id']);
    }

    private function assertSuperAdmin(Request $request): void
    {
        if (($request->user['role'] ?? '') !== 'super_admin') {
            throw new ApiException(403, 'Super Admin authorization required');
        }
    }
}
