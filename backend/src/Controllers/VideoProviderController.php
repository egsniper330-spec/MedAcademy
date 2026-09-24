<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuditService;
use MedAcademy\Services\VideoProviderPolicyService;
use MedAcademy\Utils\Uuid;

/**
 * VideoProviderController — Super Admin Video Provider Control Center.
 *
 * Endpoints (wired in routes/api.php):
 *   GET  /video-providers                    → global registry + doctor list
 *   PUT  /video-providers/{key}/global       → set global ON/OFF
 *   GET  /video-providers/teachers/{id}      → effective state for one doctor
 *   PUT  /video-providers/teachers/{id}      → set three-state override
 *
 * All writes are registry-validated, Super Admin only (route middleware) and
 * audited. Reads never expose secrets — only provider keys, display names and
 * the resolved availability decisions.
 */
final class VideoProviderController
{
    /**
     * GET /video-providers — global registry + the doctors (role=doctor)
     * available for overrides. Bounded default page; the console search
     * filters client-side over this page, larger fleets use ?search=.
     */
    public function index(Request $request): array
    {
        $db = Database::instance();

        // Global registry (both real providers; the policy service treats a
        // missing row as ENABLED — fail-open semantics apply everywhere).
        $globalRows = $db->select(
            'SELECT id, provider_key, display_name, is_globally_enabled, updated_at
             FROM `video_providers` ORDER BY provider_key ASC'
        ) ?? [];
        $have = [];
        foreach ($globalRows as $row) {
            if (VideoProviderPolicyService::isValidProvider((string) $row['provider_key'])) {
                $have[(string) $row['provider_key']] = $row;
            }
        }
        $providers = [];
        foreach (VideoProviderPolicyService::PROVIDERS as $key) {
            if (isset($have[$key])) {
                $r = $have[$key];
                $providers[] = [
                    'id'                  => (string) $r['id'],
                    'provider_key'        => $key,
                    'display_name'        => (string) $r['display_name'],
                    'is_globally_enabled' => (int) $r['is_globally_enabled'] === 1,
                    'updated_at'          => (string) $r['updated_at'],
                ];
            } else {
                // Registry row missing → the policy treats it as ENABLED
                // (fail open); surface that self-initialized state honestly.
                $providers[] = [
                    'id'                  => 'default-' . $key,
                    'provider_key'        => $key,
                    'display_name'        => $key === 'plyr' ? 'Plyr' : 'VdoCipher',
                    'is_globally_enabled' => true,
                    'updated_at'          => null,
                ];
            }
        }

        // Doctor directory for overrides (existing profiles architecture).
        $search = trim((string) ($request->query('search', '') ?? ''));
        $limit  = min(500, max(1, (int) ($request->query('limit', '200') ?? 200)));
        if ($search !== '') {
            $like = '%' . str_replace(['%', '_'], ['\\%', '\\_'], $search) . '%';
            $doctors = $db->select(
                'SELECT p.id, p.full_name, u.email
                 FROM `profiles` p JOIN `users` u ON u.id = p.id
                 WHERE p.role = ? AND (p.full_name LIKE ? OR u.email LIKE ?)
                 ORDER BY p.full_name ASC LIMIT ' . $limit,
                ['doctor', $like, $like]
            ) ?? [];
        } else {
            $doctors = $db->select(
                'SELECT p.id, p.full_name, u.email
                 FROM `profiles` p JOIN `users` u ON u.id = p.id
                 WHERE p.role = ?
                 ORDER BY p.full_name ASC LIMIT ' . $limit,
                ['doctor']
            ) ?? [];
        }

        return [
            'providers' => $providers,
            'doctors'   => array_map(
                static fn(array $d): array => [
                    'id'        => (string) $d['id'],
                    'full_name' => (string) ($d['full_name'] ?? ''),
                    'email'     => (string) ($d['email'] ?? ''),
                ],
                $doctors
            ),
        ];
    }

    /**
     * PUT /video-providers/{key}/global — body { enabled: bool }.
     */
    public function setGlobal(Request $request): array
    {
        $key = (string) $request->params['key'];
        if (!VideoProviderPolicyService::isValidProvider($key)) {
            throw new ApiException(422, 'Unknown video provider', ['unknown_provider']);
        }
        $enabled = (bool) ($request->json()['enabled'] ?? null);

        VideoProviderPolicyService::setGlobal($key, $enabled);

        AuditService::write(
            (string) ($request->user['id'] ?? ''),
            'video_provider_global_updated',
            ['provider' => $key, 'enabled' => $enabled],
            $request->clientIp()
        );

        return ['success' => true, 'provider_key' => $key, 'is_globally_enabled' => $enabled];
    }

    /**
     * GET /video-providers/teachers/{id} — effective three-state rows for one
     * doctor (console expand card).
     */
    public function teacher(Request $request): array
    {
        $teacherId = Uuid::normalize((string) $request->params['id']);
        if ($teacherId === '') {
            throw new ApiException(422, 'teacher id is required');
        }

        $permissions = array_map(
            static fn(array $p): array => [
                'provider_key'    => $p['provider_key'],
                'display_name'    => $p['display_name'],
                'global_enabled'  => $p['global_enabled'],
                'override'        => $p['override'],
                'teacher_enabled' => $p['teacher_enabled'],
                'final_enabled'   => $p['effective'],
            ],
            VideoProviderPolicyService::effectiveForTeacher($teacherId)
        );

        return ['permissions' => $permissions];
    }

    /**
     * PUT /video-providers/teachers/{id} — body { provider, mode } where
     * mode ∈ inherit|enabled|disabled (legacy { enabled: bool } accepted).
     */
    public function setTeacher(Request $request): array
    {
        $teacherId = Uuid::normalize((string) $request->params['id']);
        $provider  = trim((string) ($request->json()['provider'] ?? ''));
        $mode      = trim((string) ($request->json()['mode'] ?? ''));

        if ($teacherId === '' || $provider === '') {
            throw new ApiException(422, 'teacher id and provider are required');
        }
        if ($mode === '') {
            // Legacy boolean contract from the previous client.
            $mode = (bool) ($request->json()['enabled'] ?? true) ? 'enabled' : 'disabled';
        }

        // The override must target an actual doctor account.
        $exists = Database::instance()->value(
            'SELECT COUNT(*) FROM `profiles` WHERE `id` = ? AND `role` = ?',
            [$teacherId, 'doctor'],
            0
        );
        if ((int) $exists === 0) {
            throw new ApiException(404, 'Doctor not found', ['doctor_not_found']);
        }

        VideoProviderPolicyService::setOverride($teacherId, $provider, $mode);

        AuditService::write(
            (string) ($request->user['id'] ?? ''),
            'video_provider_doctor_override_updated',
            [
                'teacher_id' => $teacherId,
                'provider'   => $provider,
                'mode'       => $mode,
                'scope'      => 'console',
            ],
            $request->clientIp()
        );

        return ['success' => true, 'teacher_id' => $teacherId, 'provider' => $provider, 'mode' => $mode];
    }
}
