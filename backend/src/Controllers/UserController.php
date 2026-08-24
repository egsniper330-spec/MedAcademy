<?php

declare(strict_types=1);

namespace MedAcademy\Controllers;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Services\AuditService;
use MedAcademy\Utils\Uuid;

final class UserController
{
    private const PUBLIC_COLS = 'id, email, full_name, phone, phone_e164, role, status, avatar_url, watermark_id,
        university_id, faculty_id, academic_level_id, contact_whatsapp, contact_telegram, contact_phone,
        created_at';

    public function me(Request $request): array
    {
        $row = Database::instance()->row(
            'SELECT ' . self::PUBLIC_COLS . ' FROM profiles WHERE id = ?',
            [$request->user['id']]
        );
        if ($row === null) {
            throw new ApiException(404, 'User not found');
        }
        return ['user' => $row];
    }

    public function updateMe(Request $request): array
    {
        $userId = $request->user['id'];
        $data = $request->json();
        $allowed = ['full_name', 'avatar_url', 'contact_whatsapp', 'contact_telegram', 'contact_phone', 'university_id', 'faculty_id', 'academic_level_id'];

        $sets = [];
        $params = [];
        foreach ($allowed as $col) {
            if (array_key_exists($col, $data)) {
                $sets[] = '`' . $col . '` = ?';
                $params[] = $data[$col] === '' ? null : $data[$col];
            }
        }
        if ($sets === []) {
            throw new ApiException(422, 'No updatable fields provided');
        }
        $sets[] = 'updated_at = UTC_TIMESTAMP(6)';
        $params[] = $userId;

        Database::instance()->query(
            'UPDATE profiles SET ' . implode(', ', $sets) . ' WHERE id = ?',
            $params
        );
        AuditService::write($userId, 'permission_changed', ['updated_profile' => true]);
        return ['user' => Database::instance()->row('SELECT ' . self::PUBLIC_COLS . ' FROM profiles WHERE id = ?', [$userId])];
    }

    public function show(Request $request): array
    {
        $id = Uuid::normalize((string) $request->params['id']);
        $row = Database::instance()->row('SELECT ' . self::PUBLIC_COLS . ' FROM profiles WHERE id = ?', [$id]);
        if ($row === null) {
            throw new ApiException(404, 'User not found');
        }
        // role-based visibility: students see only doctor profiles (matches RLS)
        $viewerRole = $request->user['role'];
        if ($viewerRole === 'student' && !in_array($row['role'], ['doctor', 'admin', 'super_admin'], true) && $row['id'] !== $request->user['id']) {
            throw new ApiException(403, 'Not authorized');
        }
        return ['user' => $row];
    }

    /**
     * get_doctor_students port (migration 00057 + 00128 + 00143).
     * Doctors see their enrolled students with pricing fields.
     */
    public function doctorStudents(Request $request): array
    {
        $doctorId = $request->user['id'];
        $search = trim((string) $request->query('search', ''));
        $sql = "SELECT p.id, p.full_name, p.email, p.phone, p.phone_e164, p.watermark_id,
                       p.credit_selling_price, p.doctor_global_price, p.doctor_pricing_mode,
                       e.course_id, e.enrolled_at, e.assigned_price, e.progress_percent
                  FROM enrollments e
                  JOIN courses c ON c.id = e.course_id
                  JOIN profiles p ON p.id = e.student_id
                 WHERE c.doctor_id = ?";
        $params = [$doctorId];
        if ($search !== '') {
            $sql .= " AND (p.full_name LIKE ? OR p.email LIKE ? OR p.phone_e164 LIKE ?)";
            $like = '%' . $search . '%';
            array_push($params, $like, $like, $like);
        }
        $sql .= ' ORDER BY e.enrolled_at DESC LIMIT 500';
        return ['students' => Database::instance()->select($sql, $params)];
    }
}
