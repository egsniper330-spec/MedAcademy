<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;

/**
 * PermissionService — the ONE source of truth for Admin RBAC.
 *
 * RESPONSIBILITIES
 *   1. Own the permission CATALOG (keys + group + human labels). The frontend
 *      renders whatever this exposes, so the two can never drift, and adding a
 *      permission later is a single edit here.
 *   2. Resolve an admin's EFFECTIVE permissions:
 *          super_admin        → every key (unrestricted; unchanged behaviour)
 *          template           → the template's keys
 *          + admin_permissions overlay (granted = 1 adds, granted = 0 removes)
 *          no template, no overlay → DENY ALL (secure default)
 *   3. Enforce (assert) server-side. Never trusts anything from the client.
 *   4. Apply DELEGATION rules so an admin can never escalate:
 *          • cannot grant a key they do not themselves hold
 *          • cannot touch a super_admin account
 *          • cannot change their own permissions
 *   5. Write an audit row (old → new) for every sensitive permission change.
 *
 * The overlay rows are stored in `admin_permissions`; templates in
 * `permission_templates`; the assignment in `profiles.permission_template_id`
 * (see migration 039). Everything here is additive — no existing table is
 * altered or dropped by the code path.
 */
final class PermissionService
{
    /**
     * The catalog. Order is the display order of the groups, and within a group
     * the display order of the checkboxes.
     *
     * @var array<string,array{label:string,description:string,permissions:array<string,array{label:string,description:string}>}>
     */
    private const CATALOG = [
        'admin_management' => [
            'label' => 'Admin Management',
            'description' => 'Control who is an administrator and what they may do.',
            'permissions' => [
                'manage_admins'      => ['label' => 'Manage Admins', 'description' => 'Create, edit, suspend and remove administrator accounts.'],
                'manage_permissions' => ['label' => 'Manage Permissions', 'description' => 'Change the permissions granted to an administrator.'],
                'manage_roles'       => ['label' => 'Manage Roles', 'description' => 'Assign and edit permission templates (roles).'],
            ],
        ],
        'content' => [
            'label' => 'Content',
            'description' => 'Academic structure used to classify courses.',
            'permissions' => [
                'manage_faculties'   => ['label' => 'Manage Faculties', 'description' => 'Create, rename and remove faculties.'],
                'manage_universities' => ['label' => 'Manage Universities', 'description' => 'Create, rename and remove universities.'],
            ],
        ],
        'courses' => [
            'label' => 'Course Management',
            'description' => 'Courses, lessons, media and publishing.',
            'permissions' => [
                'delete_any_course' => ['label' => 'Delete Any Course', 'description' => 'Permanently delete a course owned by any doctor.'],
                'edit_any_course'   => ['label' => 'Edit Any Course', 'description' => 'Edit a course owned by another doctor.'],
                'hidden_enrollment' => ['label' => 'Hidden Enrollment', 'description' => 'Enroll students without an audit-visible public enrollment.'],
                'manage_courses'    => ['label' => 'Manage Courses', 'description' => 'Create, update, archive and duplicate courses.'],
                'manage_lessons'    => ['label' => 'Manage Lessons', 'description' => 'Create, update, reorder and delete lessons.'],
                'publish_courses'   => ['label' => 'Publish/Unpublish', 'description' => 'Publish a course or take it back to draft.'],
                'upload_videos'     => ['label' => 'Upload Videos', 'description' => 'Upload, replace and import lesson videos.'],
                'view_courses'      => ['label' => 'View Courses', 'description' => 'Read the course catalogue and course details.'],
            ],
        ],
        'doctors' => [
            'label' => 'Doctor Management',
            'description' => 'Doctor accounts and their standing on the platform.',
            'permissions' => [
                'block_doctor'   => ['label' => 'Block Doctor', 'description' => 'Block a doctor account.'],
                'manage_doctors' => ['label' => 'Manage Doctors', 'description' => 'Create and update doctor accounts.'],
                'promote_doctor' => ['label' => 'Promote Doctor', 'description' => 'Promote an account to the doctor role.'],
                'remove_doctor'  => ['label' => 'Remove Doctor', 'description' => 'Remove a doctor account.'],
                'unblock_doctor' => ['label' => 'Unblock Doctor', 'description' => 'Restore a blocked doctor account.'],
                'view_doctors'   => ['label' => 'View Doctors', 'description' => 'Read the doctor directory.'],
            ],
        ],
        'enrollment_codes' => [
            'label' => 'Enrollment Codes',
            'description' => 'Activation and enrollment code administration.',
            'permissions' => [
                'bulk_generate_codes'      => ['label' => 'Bulk Generate Codes', 'description' => 'Generate many codes in one batch.'],
                'delete_codes'             => ['label' => 'Delete Codes', 'description' => 'Delete issued codes.'],
                'generate_codes'           => ['label' => 'Generate Codes', 'description' => 'Generate individual codes.'],
                'manage_activation_batches' => ['label' => 'Manage Activation Batches', 'description' => 'Create, clone and retire activation batches.'],
                'manage_enrollment_codes'  => ['label' => 'Manage Enrollment Codes', 'description' => 'Full enrollment code administration.'],
                'manage_activation_codes'  => ['label' => 'Manage Activation Codes', 'description' => 'Full activation code administration.'],
                'view_activation_history'  => ['label' => 'View Activation History', 'description' => 'Read activation code usage history.'],
            ],
        ],
        'financial' => [
            'label' => 'Financial',
            'description' => 'Money, credits and financial reporting.',
            'permissions' => [
                'edit_course_prices'       => ['label' => 'Edit Course Prices', 'description' => 'Change the price of any course.'],
                'manage_doctor_credits'    => ['label' => 'Manage Doctor Credits', 'description' => 'Allocate, refund and revoke doctor credits.'],
                'manage_financial_reports' => ['label' => 'Manage Financial Reports', 'description' => 'Access financial reports and revenue breakdowns.'],
                'view_credit_history'      => ['label' => 'View Credit History', 'description' => 'Read the credit transaction ledger.'],
            ],
        ],
        'legal' => [
            'label' => 'Legal',
            'description' => 'Public legal and contact pages.',
            'permissions' => [
                'manage_about_us' => ['label' => 'Manage About Us', 'description' => 'Edit the About Us page.'],
                'manage_contact'  => ['label' => 'Manage Contact', 'description' => 'Edit contact details and support channels.'],
                'manage_privacy'  => ['label' => 'Manage Privacy', 'description' => 'Edit the privacy policy.'],
                'manage_terms'    => ['label' => 'Manage Terms', 'description' => 'Edit the terms of service.'],
            ],
        ],
        'platform' => [
            'label' => 'Platform',
            'description' => 'Platform-wide configuration and operations.',
            'permissions' => [
                'approve_university_requests' => ['label' => 'Approve University Requests', 'description' => 'Approve or reject university join requests.'],
                'manage_platform'             => ['label' => 'Manage Platform', 'description' => 'Platform settings, feature flags and updates.'],
                'manage_system_health'        => ['label' => 'Manage System Health', 'description' => 'Read diagnostics and provider health.'],
                'manage_whatsapp'             => ['label' => 'Manage WhatsApp', 'description' => 'Configure WhatsApp integration.'],
                'send_notifications'          => ['label' => 'Notifications', 'description' => 'Send platform notifications.'],
                'site_settings'               => ['label' => 'Site Settings', 'description' => 'Edit site-wide settings and branding.'],
                'storage_management'          => ['label' => 'Storage Management', 'description' => 'Inspect and reclaim stored files.'],
            ],
        ],
        'reports' => [
            'label' => 'Reports',
            'description' => 'Analytics, statistics and audit visibility.',
            'permissions' => [
                'view_audit_logs'    => ['label' => 'View Audit Logs', 'description' => 'Read the audit trail.'],
                'view_reports'       => ['label' => 'View Reports', 'description' => 'Access the reports section.'],
                'view_revenue'       => ['label' => 'View Revenue', 'description' => 'Read revenue and earnings figures.'],
                'view_statistics'    => ['label' => 'View Statistics', 'description' => 'Read platform statistics.'],
                'view_student_counts' => ['label' => 'View Student Counts', 'description' => 'Read student and enrollment counts.'],
            ],
        ],
        'security' => [
            'label' => 'Security',
            'description' => 'Security posture and account recovery.',
            'permissions' => [
                'manage_security'  => ['label' => 'Manage Security', 'description' => 'Change security policies and device blocks.'],
                'reset_passwords'  => ['label' => 'Reset Passwords', 'description' => 'Reset another account\'s password.'],
                'unlock_accounts'  => ['label' => 'Unlock Accounts', 'description' => 'Unlock suspended or locked accounts.'],
            ],
        ],
        'users' => [
            'label' => 'User Management',
            'description' => 'Student accounts.',
            'permissions' => [
                'add_students'    => ['label' => 'Add Students', 'description' => 'Create student accounts.'],
                'block_students'  => ['label' => 'Block Students', 'description' => 'Block a student account.'],
                'delete_students' => ['label' => 'Delete Students', 'description' => 'Delete or trash a student account.'],
                'edit_students'   => ['label' => 'Edit Students', 'description' => 'Edit student profile data.'],
                'manage_students' => ['label' => 'Manage Students', 'description' => 'Full student administration.'],
                'unblock_students' => ['label' => 'Unblock Students', 'description' => 'Restore a blocked student account.'],
                'view_students'   => ['label' => 'View Students', 'description' => 'Read the student directory.'],
            ],
        ],
    ];

    /** Request-scoped cache: userId → effective keys. */
    private static array $cache = [];

    // ── Catalog ─────────────────────────────────────────────────────────────

    /** @return array<int,array{key:string,label:string,description:string,permissions:array<int,array{key:string,label:string,description:string}>}> */
    public static function catalog(): array
    {
        $out = [];
        foreach (self::CATALOG as $groupKey => $group) {
            $perms = [];
            foreach ($group['permissions'] as $key => $meta) {
                $perms[] = ['key' => $key, 'label' => $meta['label'], 'description' => $meta['description']];
            }
            $out[] = [
                'key' => $groupKey,
                'label' => $group['label'],
                'description' => $group['description'],
                'permissions' => $perms,
            ];
        }
        return $out;
    }

    /** @return array<int,string> every known permission key */
    public static function keys(): array
    {
        $keys = [];
        foreach (self::CATALOG as $group) {
            foreach (array_keys($group['permissions']) as $key) {
                $keys[] = $key;
            }
        }
        return $keys;
    }

    /** Distinct count of the catalog (the "N of TOTAL permissions" number). */
    public static function total(): int
    {
        return count(self::keys());
    }

    public static function isKnown(string $key): bool
    {
        foreach (self::CATALOG as $group) {
            if (isset($group['permissions'][$key])) {
                return true;
            }
        }
        return false;
    }

    /** Keep only catalog keys, de-duplicated, in catalog order (stable UI). */
    public static function normalize(array $keys): array
    {
        $given = [];
        foreach ($keys as $k) {
            if (is_string($k)) {
                $given[$k] = true;
            }
        }
        return array_values(array_filter(self::keys(), static fn (string $k): bool => isset($given[$k])));
    }

    // ── Resolution ──────────────────────────────────────────────────────────

    public static function isSuperAdmin(?string $role): bool
    {
        return $role === 'super_admin';
    }

    /**
     * Effective permission keys for a user.
     *
     * @return array<int,string>
     */
    public static function effectiveFor(?string $userId, ?string $role): array
    {
        if ($userId === null || $userId === '') {
            return [];
        }
        if (self::isSuperAdmin($role)) {
            return self::keys();
        }
        if (isset(self::$cache[$userId])) {
            return self::$cache[$userId];
        }

        $db = Database::instance();
        $profile = $db->row(
            'SELECT permission_template_id, role FROM profiles WHERE id = ?',
            [$userId]
        );
        $role = $profile['role'] ?? $role;
        if (self::isSuperAdmin($role)) {
            return self::$cache[$userId] = self::keys();
        }

        $granted = [];
        $templateId = $profile['permission_template_id'] ?? null;
        if (is_string($templateId) && $templateId !== '') {
            $json = $db->value('SELECT permissions FROM permission_templates WHERE id = ?', [$templateId], null);
            $decoded = is_string($json) ? json_decode($json, true) : null;
            if (is_array($decoded)) {
                $granted = self::normalize($decoded);
            }
        }

        $overlay = $db->select(
            'SELECT permission_key, granted FROM admin_permissions WHERE admin_id = ?',
            [$userId]
        ) ?? [];
        $set = array_fill_keys($granted, true);
        foreach ($overlay as $row) {
            $key = (string) ($row['permission_key'] ?? '');
            if ($key === '' || !self::isKnown($key)) {
                continue;
            }
            if ((int) ($row['granted'] ?? 0) === 1) {
                $set[$key] = true;
            } else {
                unset($set[$key]);
            }
        }

        // Return in catalog order so two admins with the same set always
        // serialise identically (stable audit diffs and stable UI counts).
        return self::$cache[$userId] = array_values(array_filter(
            self::keys(),
            static fn (string $k): bool => isset($set[$k])
        ));
    }

    public static function has(?string $userId, ?string $role, string $key): bool
    {
        return in_array($key, self::effectiveFor($userId, $role), true);
    }

    /** Throw 403 unless the caller holds $key. Super Admin always passes. */
    public static function assert(?string $userId, ?string $role, string $key): void
    {
        if (self::has($userId, $role, $key)) {
            return;
        }
        throw new ApiException(403, 'Missing permission: ' . $key, ['missing_permission', 'permission:' . $key]);
    }

    /**
     * Assert ANY of the keys (used where several permissions legitimately grant
     * read access to the same screen).
     */
    public static function assertAny(?string $userId, ?string $role, array $keys): void
    {
        if (self::isSuperAdmin($role)) {
            return;
        }
        $held = self::effectiveFor($userId, $role);
        foreach ($keys as $key) {
            if (in_array($key, $held, true)) {
                return;
            }
        }
        throw new ApiException(403, 'Missing permission: ' . implode(' or ', $keys), ['missing_permission']);
    }

    // ── Templates ───────────────────────────────────────────────────────────

    /** @return array<int,array<string,mixed>> */
    public static function templates(): array
    {
        $rows = Database::instance()->select(
            'SELECT id, slug, name, description, permissions, is_system, created_at, updated_at
               FROM permission_templates ORDER BY is_system DESC, name ASC'
        ) ?? [];

        return array_map(static function (array $row): array {
            $decoded = is_string($row['permissions'] ?? null) ? json_decode((string) $row['permissions'], true) : null;
            $keys = is_array($decoded) ? PermissionService::normalize($decoded) : [];
            return [
                'id' => $row['id'],
                'slug' => $row['slug'],
                'name' => $row['name'],
                'description' => $row['description'] ?? '',
                'permissions' => $keys,
                'permission_count' => count($keys),
                'is_system' => (bool) (int) ($row['is_system'] ?? 0),
                'created_at' => $row['created_at'] ?? null,
                'updated_at' => $row['updated_at'] ?? null,
            ];
        }, $rows);
    }

    public static function template(?string $id): ?array
    {
        if ($id === null || $id === '') {
            return null;
        }
        $row = Database::instance()->row(
            'SELECT id, slug, name, description, permissions, is_system
               FROM permission_templates WHERE id = ? OR slug = ?',
            [$id, $id]
        );
        if ($row === null) {
            return null;
        }
        $decoded = is_string($row['permissions'] ?? null) ? json_decode((string) $row['permissions'], true) : null;
        $row['permissions'] = is_array($decoded) ? self::normalize($decoded) : [];
        $row['is_system'] = (bool) (int) ($row['is_system'] ?? 0);
        return $row;
    }

    /** The template assigned to an admin (null when unassigned). */
    public static function assignedTemplate(?string $userId): ?array
    {
        if ($userId === null || $userId === '') {
            return null;
        }
        $id = Database::instance()->value(
            'SELECT permission_template_id FROM profiles WHERE id = ?',
            [$userId],
            null
        );
        return is_string($id) ? self::template($id) : null;
    }

    /** Invalidate the request cache (after a write in the same request). */
    public static function forget(?string $userId = null): void
    {
        if ($userId === null) {
            self::$cache = [];
        } else {
            unset(self::$cache[$userId]);
        }
    }
}
