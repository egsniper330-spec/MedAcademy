<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Auth\Password;
use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuditService;
use MedAcademy\Services\AuthService;
use MedAcademy\Services\PermissionService;
use MedAcademy\Services\PublicUserIdService;
use MedAcademy\Utils\Uuid;

/**
 * AdminRbacController — Admin Management + granular Admin RBAC.
 *
 * WHY A SEPARATE CONTROLLER
 *   Admin accounts are NOT ordinary users. They are listed, created and edited
 *   here, with their permissions, templates and delegation rules in one place,
 *   instead of being mixed into student/doctor management.
 *
 * AUTHORIZATION MODEL (defence in depth — every rule is enforced here even
 * when the route table already gates the endpoint):
 *   • manage_admins      — list/create/update/suspend administrators
 *   • manage_permissions — read/write another admin's permission set
 *   • manage_roles       — create/edit/clone permission templates
 *   • super_admin        — unrestricted on all three
 *
 * PROTECTED BOUNDARIES
 *   1. A non-super-admin can never read or modify a super_admin account.
 *   2. Nobody can change their own permission set (no self-escalation).
 *   3. A non-super-admin can only GRANT keys they hold themselves, so an
 *      admin can never delegate more authority than they were given.
 *   4. Every change to a permission set is audited with actor, target,
 *      old set, new set and timestamp (audit_logs.created_at).
 */
final class AdminRbacController
{
    // ── Reads available to the signed-in user ───────────────────────────────

    /**
     * GET /admin/permissions/me
     *
     * The client's single source of truth for UI gating. Works for EVERY role:
     * students/doctors get an empty permission list, admins get their resolved
     * set, Super Admin gets the full catalog. The client only uses this to
     * hide/disable UI — the backend never trusts it back.
     */
    public function me(Request $request): array
    {
        $userId = (string) $request->user['id'];
        $role = (string) $request->user['role'];

        $permissions = PermissionService::effectiveFor($userId, $role);
        $template = PermissionService::assignedTemplate($userId);

        return [
            'user_id' => $userId,
            'role' => $role,
            'is_super_admin' => PermissionService::isSuperAdmin($role),
            'permissions' => $permissions,
            'permission_count' => count($permissions),
            'total_permissions' => PermissionService::total(),
            'template' => $template === null ? null : [
                'id' => $template['id'],
                'slug' => $template['slug'],
                'name' => $template['name'],
            ],
        ];
    }

    /**
     * GET /admin/permissions/catalog
     *
     * Groups + keys + labels + every template. The UI renders whatever this
     * returns, so a new permission only has to be added to PermissionService.
     */
    public function catalog(Request $request): array
    {
        $this->requirePermission($request, 'manage_permissions');

        return [
            'groups' => PermissionService::catalog(),
            'total' => PermissionService::total(),
            'templates' => PermissionService::templates(),
        ];
    }

    // ── Admin directory ─────────────────────────────────────────────────────

    /**
     * GET /admin/admins?search=&status=
     *
     * Lists administrator accounts (admin + super_admin) with the assigned
     * template and the resolved permission count. Ordinary users are never
     * included — this endpoint is not a substitute for user management.
     */
    public function index(Request $request): array
    {
        $this->requirePermission($request, 'manage_admins');

        $search = trim((string) ($request->query('search') ?? ''));
        $status = trim((string) ($request->query('status') ?? ''));
        $role = trim((string) ($request->query('role') ?? ''));

        $sql = "SELECT p.id, p.full_name, p.email, p.role, p.status, p.created_at,
                       p.permission_template_id, p.max_devices,
                       t.name AS template_name, t.slug AS template_slug
                  FROM profiles p
             LEFT JOIN permission_templates t ON t.id = p.permission_template_id
                 WHERE p.role IN ('admin', 'super_admin')
                   AND p.status NOT IN ('trashed', 'deleted')";
        $params = [];

        if ($search !== '') {
            $sql .= ' AND (p.full_name LIKE ? OR p.email LIKE ?)';
            $params[] = '%' . $search . '%';
            $params[] = '%' . $search . '%';
        }
        if ($status !== '' && in_array($status, ['active', 'suspended', 'blocked'], true)) {
            $sql .= ' AND p.status = ?';
            $params[] = $status;
        }
        if ($role !== '' && in_array($role, ['admin', 'super_admin'], true)) {
            $sql .= ' AND p.role = ?';
            $params[] = $role;
        }
        $sql .= ' ORDER BY p.role DESC, p.full_name ASC';

        $rows = Database::instance()->select($sql, $params) ?? [];

        $overrides = Database::instance()->select(
            'SELECT admin_id, COUNT(*) AS total FROM admin_permissions GROUP BY admin_id'
        ) ?? [];
        $overrideCounts = [];
        foreach ($overrides as $o) {
            $overrideCounts[(string) $o['admin_id']] = (int) $o['total'];
        }

        $admins = array_map(function (array $row) use ($overrideCounts): array {
            $role = (string) $row['role'];
            $permissionCount = count(PermissionService::effectiveFor((string) $row['id'], $role));
            return [
                'id' => $row['id'],
                'full_name' => $row['full_name'],
                'email' => $row['email'],
                'role' => $role,
                'status' => $row['status'],
                'created_at' => $row['created_at'],
                'is_super_admin' => PermissionService::isSuperAdmin($role),
                'template' => $row['permission_template_id'] === null ? null : [
                    'id' => $row['permission_template_id'],
                    'name' => $row['template_name'],
                    'slug' => $row['template_slug'],
                ],
                'permission_count' => $permissionCount,
                'custom_override_count' => $overrideCounts[(string) $row['id']] ?? 0,
            ];
        }, $rows);

        return [
            'admins' => $admins,
            'total' => count($admins),
            'catalog_total' => PermissionService::total(),
        ];
    }

    /** GET /admin/admins/{id} — one administrator with resolved permissions. */
    public function show(Request $request): array
    {
        $this->requirePermission($request, 'manage_admins');

        $id = (string) ($request->params['id'] ?? '');
        $profile = $this->adminRow($id);

        return [
            'admin' => $this->serialize($profile),
            'permissions' => PermissionService::effectiveFor($id, (string) $profile['role']),
            'catalog_total' => PermissionService::total(),
            'templates' => PermissionService::templates(),
        ];
    }

    // ── Admin lifecycle ─────────────────────────────────────────────────────

    /**
     * POST /admin/admins — create an administrator.
     *
     * Mirrors the account-creation pipeline used by /admin/user-management
     * (users row + trigger-created profile row + credits row) so the new
     * account behaves exactly like every other one; the role is pinned to
     * 'admin' here, and the permission template is assigned in the same
     * transaction so the admin is never briefly unrestricted.
     */
    public function create(Request $request): array
    {
        $this->requirePermission($request, 'manage_admins');

        $body = $request->json();
        $email = strtolower(trim((string) ($body['email'] ?? '')));
        $fullName = trim((string) ($body['full_name'] ?? ''));
        $password = (string) ($body['password'] ?? '');
        $templateId = (string) ($body['template_id'] ?? '');

        if ($email === '' || $fullName === '') {
            throw new ApiException(422, 'email and full_name are required');
        }
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new ApiException(422, 'A valid email address is required');
        }
        if (strlen($password) < 8) {
            throw new ApiException(422, 'Password must be at least 8 characters');
        }

        $template = $templateId !== '' ? PermissionService::template($templateId) : null;
        if ($templateId !== '' && $template === null) {
            throw new ApiException(422, 'Unknown permission template');
        }
        if ($template === null) {
            // Default to the empty Custom preset: a new admin starts with no
            // authority until permissions are deliberately granted.
            $template = PermissionService::template('custom');
        }

        $db = Database::instance();
        $existing = $db->value(
            "SELECT COUNT(*) FROM profiles WHERE email = ? AND status NOT IN ('trashed','deleted')",
            [$email],
            0
        );
        if ($existing > 0) {
            throw new ApiException(409, 'An account with this email already exists');
        }

        $userId = Uuid::v4();
        $hashedPassword = Password::hash($password);
        $templateId = (string) ($template['id'] ?? '');
        $actorId = (string) $request->user['id'];

        $db->transaction(function (Database $db) use ($userId, $email, $fullName, $hashedPassword, $templateId) {
            $db->insert(
                'INSERT INTO users (id, email, encrypted_password, raw_user_meta_data, created_at, updated_at)
                 VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))',
                [
                    $userId,
                    $email,
                    $hashedPassword,
                    json_encode([
                        'full_name' => $fullName,
                        'role' => 'admin',
                        'public_user_id' => PublicUserIdService::allocate(),
                    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
                ]
            );

            $watermarkId = (new AuthService())->nextWatermarkId();
            $db->query(
                'UPDATE profiles
                    SET email = ?, full_name = ?, role = ?, status = ?, watermark_id = ?,
                        permission_template_id = ?, updated_at = UTC_TIMESTAMP(6)
                  WHERE id = ?',
                [$email, $fullName, 'admin', 'active', $watermarkId,
                 $templateId !== '' ? $templateId : null, $userId]
            );

            $db->query(
                'INSERT INTO credits (doctor_id, allocated, consumed, remaining, updated_at)
                 VALUES (?, 0, 0, 0, UTC_TIMESTAMP(6))
                 ON DUPLICATE KEY UPDATE updated_at = updated_at',
                [$userId]
            );
        });

        PermissionService::forget($userId);

        AuditService::write($actorId, 'admin_created', [
            'new_admin_id' => $userId,
            'email' => $email,
            'template_id' => $templateId,
            'description' => 'Administrator account created',
        ], $request->clientIp());

        return [
            'success' => true,
            'admin' => $this->serialize($this->adminRow($userId)),
            'permissions' => PermissionService::effectiveFor($userId, 'admin'),
        ];
    }

    /**
     * PATCH /admin/admins/{id} — update name / status / template.
     *
     * Template changes move the admin onto that template's baseline; existing
     * per-key overrides are preserved so an operator's deliberate customisation
     * is not silently discarded.
     */
    public function update(Request $request): array
    {
        $this->requirePermission($request, 'manage_admins');

        $body = $request->json();
        $id = (string) ($request->params['id'] ?? '');
        $target = $this->adminRow($id);
        $this->assertTargetEditable($request, $target);

        $sets = [];
        $params = [];

        if (array_key_exists('full_name', $body)) {
            $name = trim((string) $body['full_name']);
            if ($name === '') {
                throw new ApiException(422, 'full_name cannot be empty');
            }
            $sets[] = 'full_name = ?';
            $params[] = $name;
        }

        if (array_key_exists('status', $body)) {
            $status = (string) $body['status'];
            if (!in_array($status, ['active', 'suspended'], true)) {
                throw new ApiException(422, 'status must be active or suspended');
            }
            if ($status === 'suspended' && (string) $target['role'] === 'super_admin') {
                throw new ApiException(403, 'A Super Admin account cannot be suspended from here');
            }
            $sets[] = 'status = ?';
            $params[] = $status;
        }

        if (array_key_exists('template_id', $body)) {
            $templateId = (string) ($body['template_id'] ?? '');
            $template = $templateId !== '' ? PermissionService::template($templateId) : null;
            if ($templateId !== '' && $template === null) {
                throw new ApiException(422, 'Unknown permission template');
            }
            $sets[] = 'permission_template_id = ?';
            $params[] = $templateId !== '' ? (string) $template['id'] : null;
        }

        if ($sets !== []) {
            $params[] = $id;
            Database::instance()->query(
                'UPDATE profiles SET ' . implode(', ', $sets) . ', updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
                $params
            );
        }

        PermissionService::forget($id);

        AuditService::write((string) $request->user['id'], 'admin_updated', [
            'target_admin_id' => $id,
            'changed' => array_keys(array_intersect_key($body, array_flip(['full_name', 'status', 'template_id']))),
            'target_name' => $target['full_name'] ?? null,
        ], $request->clientIp());

        return [
            'success' => true,
            'admin' => $this->serialize($this->adminRow($id)),
            'permissions' => PermissionService::effectiveFor($id, (string) $this->adminRow($id)['role']),
        ];
    }

    // ── Permissions ─────────────────────────────────────────────────────────

    /** GET /admin/admins/{id}/permissions — editor payload. */
    public function permissions(Request $request): array
    {
        $this->requirePermission($request, 'manage_permissions');

        $id = (string) ($request->params['id'] ?? '');
        $target = $this->adminRow($id);
        $this->assertReadable($request, $target);

        $overrides = Database::instance()->select(
            'SELECT permission_key, granted FROM admin_permissions WHERE admin_id = ?',
            [$id]
        ) ?? [];

        $map = [];
        foreach ($overrides as $row) {
            $map[(string) $row['permission_key']] = (int) $row['granted'] === 1;
        }

        $effective = PermissionService::effectiveFor($id, (string) $target['role']);
        $template = PermissionService::assignedTemplate($id);

        return [
            'admin' => $this->serialize($target),
            'permissions' => $effective,
            'permission_count' => count($effective),
            'catalog_total' => PermissionService::total(),
            'template' => $template === null ? null : [
                'id' => $template['id'],
                'slug' => $template['slug'],
                'name' => $template['name'],
                'permissions' => $template['permissions'],
            ],
            'overrides' => $map,
            'groups' => PermissionService::catalog(),
            'templates' => PermissionService::templates(),
            'can_edit' => $this->canEditPermissions($request, $target),
        ];
    }

    /**
     * PUT /admin/admins/{id}/permissions
     *
     * Body: { permissions: string[], template_id?: string }
     * The submitted list is the COMPLETE desired set. Anything the template
     * already provides needs no overlay row; only the delta is stored, so
     * switching templates later behaves predictably.
     *
     * DELEGATION: a non-super-admin may only add keys they hold, and may never
     * remove a key they do not hold (that would be a blind privilege change on
     * capabilities they cannot reason about).
     */
    public function updatePermissions(Request $request): array
    {
        $this->requirePermission($request, 'manage_permissions');

        $body = $request->json();
        $id = (string) ($request->params['id'] ?? '');
        $target = $this->adminRow($id);
        $actor = $request->user;
        $actorId = (string) $actor['id'];
        $actorRole = (string) $actor['role'];

        if ($actorId === $id) {
            throw new ApiException(403, 'You cannot change your own permissions', ['self_escalation']);
        }
        $this->assertTargetEditable($request, $target);

        $requestedRaw = $body['permissions'] ?? null;
        if (!is_array($requestedRaw)) {
            throw new ApiException(422, 'permissions must be an array of permission keys');
        }
        $requested = PermissionService::normalize($requestedRaw);
        $unknown = array_values(array_diff(
            array_filter($requestedRaw, 'is_string'),
            PermissionService::keys()
        ));
        if ($unknown !== []) {
            throw new ApiException(422, 'Unknown permission key(s): ' . implode(', ', $unknown));
        }

        $before = PermissionService::effectiveFor($id, (string) $target['role']);
        $held = PermissionService::effectiveFor($actorId, $actorRole);

        if (!PermissionService::isSuperAdmin($actorRole)) {
            $adding = array_diff($requested, $before);
            $removing = array_diff($before, $requested);
            foreach ($adding as $key) {
                if (!in_array($key, $held, true)) {
                    throw new ApiException(403, 'You cannot grant a permission you do not hold: ' . $key, ['delegation_exceeded']);
                }
            }
            foreach ($removing as $key) {
                if (!in_array($key, $held, true)) {
                    throw new ApiException(403, 'You cannot revoke a permission you do not hold: ' . $key, ['delegation_exceeded']);
                }
            }
        }

        // Optional simultaneous template change.
        $templateId = array_key_exists('template_id', $body)
            ? (string) ($body['template_id'] ?? '')
            : (string) ($target['permission_template_id'] ?? '');

        $template = $templateId !== '' ? PermissionService::template($templateId) : null;
        if ($templateId !== '' && $template === null) {
            throw new ApiException(422, 'Unknown permission template');
        }
        $templateKeys = $template === null ? [] : PermissionService::normalize((array) $template['permissions']);

        $db = Database::instance();
        $db->transaction(function (Database $db) use ($id, $templateId, $templateKeys, $requested, $actorId) {
            $db->query(
                'UPDATE profiles SET permission_template_id = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
                [$templateId !== '' ? $templateId : null, $id]
            );

            // Rebuild the overlay as an exact delta against the template.
            $db->query('DELETE FROM admin_permissions WHERE admin_id = ?', [$id]);
            foreach (PermissionService::keys() as $key) {
                $inTemplate = in_array($key, $templateKeys, true);
                $inRequested = in_array($key, $requested, true);
                if ($inTemplate === $inRequested) {
                    continue;
                }
                $db->insert(
                    'INSERT INTO admin_permissions (id, admin_id, permission_key, granted, granted_by)
                     VALUES (?, ?, ?, ?, ?)',
                    [Uuid::v4(), $id, $key, $inRequested ? 1 : 0, $actorId]
                );
            }
        });

        PermissionService::forget($id);
        $after = PermissionService::effectiveFor($id, (string) $target['role']);

        AuditService::write($actorId, 'permission_changed', [
            'target_admin_id' => $id,
            'target_name' => $target['full_name'] ?? null,
            'template_id' => $templateId !== '' ? $templateId : null,
            'old_permissions' => $before,
            'new_permissions' => $after,
            'added' => array_values(array_diff($after, $before)),
            'removed' => array_values(array_diff($before, $after)),
            'description' => 'Administrator permissions updated',
        ], $request->clientIp());

        return [
            'success' => true,
            'permissions' => $after,
            'permission_count' => count($after),
            'catalog_total' => PermissionService::total(),
            'added' => array_values(array_diff($after, $before)),
            'removed' => array_values(array_diff($before, $after)),
        ];
    }

    /**
     * POST /admin/admins/{id}/clone-permissions
     *
     * Body: { source_admin_id: string }
     * Copies the SOURCE's resolved set onto the target as an independent
     * snapshot (explicit overlay on the Custom template). Later edits to either
     * admin never affect the other.
     */
    public function clonePermissions(Request $request): array
    {
        $this->requirePermission($request, 'manage_permissions');

        $body = $request->json();
        $id = (string) ($request->params['id'] ?? '');
        $sourceId = (string) ($body['source_admin_id'] ?? '');

        if ($sourceId === '') {
            throw new ApiException(422, 'source_admin_id is required');
        }
        if ($sourceId === $id) {
            throw new ApiException(422, 'Cannot clone permissions from the same administrator');
        }

        $target = $this->adminRow($id);
        $source = $this->adminRow($sourceId);
        $actorId = (string) $request->user['id'];
        $actorRole = (string) $request->user['role'];

        if ($actorId === $id) {
            throw new ApiException(403, 'You cannot change your own permissions', ['self_escalation']);
        }
        $this->assertTargetEditable($request, $target);
        $this->assertReadable($request, $source);

        $sourceKeys = PermissionService::effectiveFor($sourceId, (string) $source['role']);
        if (!PermissionService::isSuperAdmin($actorRole)) {
            $held = PermissionService::effectiveFor($actorId, $actorRole);
            foreach (array_diff($sourceKeys, $held) as $key) {
                throw new ApiException(
                    403,
                    'The source administrator holds a permission you do not: ' . $key,
                    ['delegation_exceeded']
                );
            }
        }

        $custom = PermissionService::template('custom');
        $customId = (string) ($custom['id'] ?? '');
        $before = PermissionService::effectiveFor($id, (string) $target['role']);

        $db = Database::instance();
        $db->transaction(function (Database $db) use ($id, $customId, $sourceKeys, $actorId) {
            $db->query(
                'UPDATE profiles SET permission_template_id = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
                [$customId !== '' ? $customId : null, $id]
            );
            $db->query('DELETE FROM admin_permissions WHERE admin_id = ?', [$id]);
            foreach ($sourceKeys as $key) {
                $db->insert(
                    'INSERT INTO admin_permissions (id, admin_id, permission_key, granted, granted_by)
                     VALUES (?, ?, ?, 1, ?)',
                    [Uuid::v4(), $id, $key, $actorId]
                );
            }
        });

        PermissionService::forget($id);

        AuditService::write($actorId, 'permission_changed', [
            'target_admin_id' => $id,
            'target_name' => $target['full_name'] ?? null,
            'source_admin_id' => $sourceId,
            'source_admin_name' => $source['full_name'] ?? null,
            'old_permissions' => $before,
            'new_permissions' => $sourceKeys,
            'description' => 'Permissions cloned from another administrator',
        ], $request->clientIp());

        return [
            'success' => true,
            'permissions' => $sourceKeys,
            'permission_count' => count($sourceKeys),
            'catalog_total' => PermissionService::total(),
        ];
    }

    // ── Templates ───────────────────────────────────────────────────────────

    /** GET /admin/permission-templates */
    public function templates(Request $request): array
    {
        $this->requirePermission($request, 'manage_roles');
        return ['templates' => PermissionService::templates(), 'total' => PermissionService::total()];
    }

    /** POST /admin/permission-templates — create a custom template. */
    public function createTemplate(Request $request): array
    {
        $this->requirePermission($request, 'manage_roles');

        $body = $request->json();
        $name = trim((string) ($body['name'] ?? ''));
        if ($name === '') {
            throw new ApiException(422, 'name is required');
        }
        $keys = PermissionService::normalize(is_array($body['permissions'] ?? null) ? $body['permissions'] : []);
        $this->assertTemplateDelegation($request, $keys);

        $id = Uuid::v4();
        $slug = $this->uniqueSlug($name);

        Database::instance()->insert(
            'INSERT INTO permission_templates (id, slug, name, description, permissions, is_system, created_by)
             VALUES (?, ?, ?, ?, ?, 0, ?)',
            [
                $id,
                $slug,
                $name,
                (string) ($body['description'] ?? ''),
                json_encode($keys, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
                (string) $request->user['id'],
            ]
        );

        AuditService::write((string) $request->user['id'], 'permission_changed', [
            'template_id' => $id,
            'template_name' => $name,
            'new_permissions' => $keys,
            'description' => 'Permission template created',
        ], $request->clientIp());

        return ['success' => true, 'template' => PermissionService::template($id)];
    }

    /** PATCH /admin/permission-templates/{id} — edit a template. */
    public function updateTemplate(Request $request): array
    {
        $this->requirePermission($request, 'manage_roles');

        $id = (string) ($request->params['id'] ?? '');
        $existing = PermissionService::template($id);
        if ($existing === null) {
            throw new ApiException(404, 'Template not found');
        }

        $body = $request->json();
        $isSuper = PermissionService::isSuperAdmin((string) $request->user['role']);
        if ($existing['is_system'] && !$isSuper) {
            throw new ApiException(403, 'System templates can only be edited by a Super Admin');
        }

        $sets = [];
        $params = [];
        if (array_key_exists('name', $body)) {
            $name = trim((string) $body['name']);
            if ($name === '') {
                throw new ApiException(422, 'name cannot be empty');
            }
            $sets[] = 'name = ?';
            $params[] = $name;
        }
        if (array_key_exists('description', $body)) {
            $sets[] = 'description = ?';
            $params[] = (string) $body['description'];
        }
        if (array_key_exists('permissions', $body)) {
            if (!is_array($body['permissions'])) {
                throw new ApiException(422, 'permissions must be an array');
            }
            $keys = PermissionService::normalize($body['permissions']);
            $this->assertTemplateDelegation($request, $keys);
            $params[] = json_encode($keys, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            $sets[] = 'permissions = ?';
        }

        if ($sets !== []) {
            $params[] = (string) $existing['id'];
            Database::instance()->query(
                'UPDATE permission_templates SET ' . implode(', ', $sets) . ' WHERE id = ?',
                $params
            );
        }

        AuditService::write((string) $request->user['id'], 'permission_changed', [
            'template_id' => (string) $existing['id'],
            'template_name' => $existing['name'],
            'old_permissions' => (array) $existing['permissions'],
            'new_permissions' => isset($keys) ? $keys : (array) $existing['permissions'],
            'description' => 'Permission template updated',
        ], $request->clientIp());

        return ['success' => true, 'template' => PermissionService::template((string) $existing['id'])];
    }

    /** POST /admin/permission-templates/{id}/clone — copy into a custom template. */
    public function cloneTemplate(Request $request): array
    {
        $this->requirePermission($request, 'manage_roles');

        $id = (string) ($request->params['id'] ?? '');
        $source = PermissionService::template($id);
        if ($source === null) {
            throw new ApiException(404, 'Template not found');
        }

        $body = $request->json();
        $name = trim((string) ($body['name'] ?? '')) ?: ($source['name'] . ' (copy)');
        $keys = (array) $source['permissions'];
        $this->assertTemplateDelegation($request, $keys);

        $newId = Uuid::v4();
        Database::instance()->insert(
            'INSERT INTO permission_templates (id, slug, name, description, permissions, is_system, created_by)
             VALUES (?, ?, ?, ?, ?, 0, ?)',
            [
                $newId,
                $this->uniqueSlug($name),
                $name,
                (string) ($source['description'] ?? ''),
                json_encode($keys, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
                (string) $request->user['id'],
            ]
        );

        AuditService::write((string) $request->user['id'], 'permission_changed', [
            'template_id' => $newId,
            'template_name' => $name,
            'source_template_id' => (string) $source['id'],
            'new_permissions' => $keys,
            'description' => 'Permission template cloned',
        ], $request->clientIp());

        return ['success' => true, 'template' => PermissionService::template($newId)];
    }

    // ── Internals ───────────────────────────────────────────────────────────

    /** Route-level gate + in-controller gate (defence in depth). */
    private function requirePermission(Request $request, string $key): void
    {
        PermissionService::assert(
            (string) ($request->user['id'] ?? ''),
            (string) ($request->user['role'] ?? ''),
            $key
        );
    }

    /** @return array<string,mixed> */
    private function adminRow(string $id): array
    {
        $row = Database::instance()->row(
            "SELECT id, full_name, email, role, status, created_at, permission_template_id
               FROM profiles
              WHERE id = ? AND role IN ('admin', 'super_admin')",
            [$id]
        );
        if ($row === null) {
            throw new ApiException(404, 'Administrator not found');
        }
        return $row;
    }

    /** A non-super-admin can never act on a super_admin account. */
    private function assertTargetEditable(Request $request, array $target): void
    {
        if (PermissionService::isSuperAdmin((string) $request->user['role'])) {
            return;
        }
        if (PermissionService::isSuperAdmin((string) $target['role'])) {
            throw new ApiException(403, 'Super Admin accounts are protected', ['protected_account']);
        }
    }

    /** Same boundary for reads (permission sets, profiles). */
    private function assertReadable(Request $request, array $target): void
    {
        $this->assertTargetEditable($request, $target);
    }

    private function canEditPermissions(Request $request, array $target): bool
    {
        $actorId = (string) $request->user['id'];
        if ($actorId === (string) $target['id']) {
            return false;
        }
        $role = (string) $request->user['role'];
        if (PermissionService::isSuperAdmin($role)) {
            return true;
        }
        if (PermissionService::isSuperAdmin((string) $target['role'])) {
            return false;
        }
        return PermissionService::has($actorId, $role, 'manage_permissions');
    }

    /** A non-super-admin may only template keys they hold themselves. */
    private function assertTemplateDelegation(Request $request, array $keys): void
    {
        $role = (string) $request->user['role'];
        if (PermissionService::isSuperAdmin($role)) {
            return;
        }
        $held = PermissionService::effectiveFor((string) $request->user['id'], $role);
        foreach ($keys as $key) {
            if (!in_array($key, $held, true)) {
                throw new ApiException(
                    403,
                    'You cannot include a permission you do not hold: ' . $key,
                    ['delegation_exceeded']
                );
            }
        }
    }

    private function uniqueSlug(string $name): string
    {
        $base = strtolower(preg_replace('/[^a-zA-Z0-9]+/', '_', $name) ?? 'template');
        $base = trim($base, '_') ?: 'template';
        $slug = $base;
        $n = 1;
        while (Database::instance()->value('SELECT COUNT(*) FROM permission_templates WHERE slug = ?', [$slug], 0) > 0) {
            $slug = $base . '_' . (++$n);
        }
        return $slug;
    }

    /** @return array<string,mixed> */
    private function serialize(array $row): array
    {
        $role = (string) $row['role'];
        $template = $row['permission_template_id'] !== null
            ? PermissionService::template((string) $row['permission_template_id'])
            : null;
        $count = count(PermissionService::effectiveFor((string) $row['id'], $role));

        return [
            'id' => $row['id'],
            'full_name' => $row['full_name'],
            'email' => $row['email'],
            'role' => $role,
            'status' => $row['status'],
            'created_at' => $row['created_at'] ?? null,
            'is_super_admin' => PermissionService::isSuperAdmin($role),
            'template' => $template === null ? null : [
                'id' => $template['id'],
                'name' => $template['name'],
                'slug' => $template['slug'],
            ],
            'permission_count' => $count,
            'catalog_total' => PermissionService::total(),
        ];
    }
}
