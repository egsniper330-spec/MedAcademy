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
        public_user_id, university_id, faculty_id, academic_level_id, contact_whatsapp, contact_telegram, contact_phone,
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
     *
     * Contract note: the original Supabase RPC returned a BARE jsonb ARRAY of
     * enrollment rows with nested `student` and `course` objects; the frontend
     * (getDoctorStudentEnrollments → students.tsx / dr-overview / dr-profile)
     * still expects exactly that shape — e.student.*, e.course.*, e.status,
     * e.id. The earlier port returned flat rows under {students:[…]}, which
     * failed Array.isArray() and silently emptied every doctor's My Students
     * list — including students enrolled via the Add-Student Credits flow.
     * This handler restores the authoritative RPC contract.
     */
    public function doctorStudents(Request $request): array
    {
        $doctorId = $request->user['id'];
        $search = trim((string) $request->query('search', ''));
        $sql = "SELECT e.id, e.status, e.enrolled_at, e.progress_percent, e.assigned_price,
                       e.enrollment_method, e.activation_method,
                       p.id AS student_id, p.full_name, p.email, p.profile_email, p.phone,
                       p.phone_e164, p.phone_national, p.phone_country_code,
                       p.watermark_id, p.public_user_id, p.avatar_url, p.status AS student_status,
                       p.created_at AS student_created_at,
                       u.name  AS university_name, f.name AS faculty_name, al.name AS academic_level_name,
                       c.id AS course_id, c.title AS course_title
                  FROM enrollments e
                  JOIN courses c ON c.id = e.course_id
                  JOIN profiles p ON p.id = e.student_id
             LEFT JOIN universities u      ON u.id = p.university_id
             LEFT JOIN faculties f         ON f.id = p.faculty_id
             LEFT JOIN academic_levels al  ON al.id = p.academic_level_id
                 WHERE c.doctor_id = ?";
        $params = [$doctorId];
        if ($search !== '') {
            $sql .= " AND (p.full_name LIKE ? OR p.email LIKE ? OR p.phone_e164 LIKE ?)";
            $like = '%' . $search . '%';
            array_push($params, $like, $like, $like);
        }
        $sql .= ' ORDER BY e.enrolled_at DESC LIMIT 500';
        $rows = Database::instance()->select($sql, $params);

        // Reshape flat JOIN rows into the RPC's nested row objects. Object values
        // are emitted as {} (never null) so frontend optional-chaining stays safe.
        $students = array_map(static function (array $r): array {
            return [
                'id'                => $r['id'],
                'status'            => $r['status'],
                'enrolled_at'       => $r['enrolled_at'],
                'progress_percent'  => $r['progress_percent'],
                'assigned_price'    => $r['assigned_price'],
                'enrollment_method' => $r['enrollment_method'],
                'activation_method' => $r['activation_method'],
                // Legacy alias: dr-overview computes "today's activations" from
                // e.created_at; the enrollments table only has enrolled_at.
                'created_at'        => $r['enrolled_at'],
                'student' => [
                    'id'                  => $r['student_id'],
                    'full_name'           => $r['full_name'],
                    'email'               => $r['email'],
                    'profile_email'       => $r['profile_email'],
                    'phone'               => $r['phone'],
                    'phone_e164'          => $r['phone_e164'],
                    'phone_national'      => $r['phone_national'],
                    'phone_country_code'  => $r['phone_country_code'],
                    'watermark_id'        => $r['watermark_id'],
                    'public_user_id'      => $r['public_user_id'],
                    'avatar_url'          => $r['avatar_url'],
                    'status'              => $r['student_status'],
                    'created_at'          => $r['student_created_at'],
                    'university'          => $r['university_name'] !== null ? ['name' => $r['university_name']] : [],
                    'faculty'             => $r['faculty_name'] !== null ? ['name' => $r['faculty_name']] : [],
                    'academic_level'      => $r['academic_level_name'] !== null ? ['name' => $r['academic_level_name']] : [],
                ],
                'course' => [
                    'id'    => $r['course_id'],
                    'title' => $r['course_title'],
                ],
            ];
        }, $rows);

        return $students;
    }
}
