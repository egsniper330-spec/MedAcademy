<?php

declare(strict_types=1);

/**
 * Seed a LOCAL or STAGING database with dedicated load-test fixtures.
 *
 * WHAT IT CREATES (all prefixed `loadtest.` so they are easy to find/remove):
 *   - 1 student account  (loadtest.student@example.invalid)
 *   - 1 doctor account   (loadtest.doctor@example.invalid)
 *   - 1 admin account    (loadtest.admin@example.invalid)
 *   - 12 published courses owned by the doctor
 *   - 4 sections + 12 lessons per course (published, no video provider calls)
 *   - 12 enrollments for the student, with lesson_progress rows
 *   - 20 notifications for the student
 *
 * SAFETY
 *   - Refuses to run when APP_ENV=production (a load-test fixture must never
 *     touch the live database).
 *   - Idempotent: re-running updates the same rows instead of duplicating.
 *   - Only creates data owned by the loadtest.* accounts; it never deletes
 *     existing user data.
 *
 * USAGE (local stack; see scripts/loadtest/README.md):
 *   php scripts/loadtest/seed-local.php --password 'LoadTest!2026'
 *
 *   # a POOL of students, for a test that needs one session per virtual user
 *   php scripts/loadtest/seed-local.php --students=200 --password 'LoadTest!2026'
 *
 * With `--students=N` the first account keeps the `.student@` address and the
 * rest are `loadtest.student02..NN@example.invalid`, all with the same password.
 * `issue-tokens.php` then mints one access token per account, which is how a
 * 200-VU run gets 200 DISTINCT sessions without 200 logins (the login endpoint
 * is rate-limited per IP, and measuring that limiter is not the goal).
 *
 * The password is not stored in the repository: pass it in, or set
 * LOADTEST_PASSWORD in the environment of the shell that runs k6.
 */

require dirname(__DIR__, 2) . '/backend/src/bootstrap.php';

use MedAcademy\Auth\Password;
use MedAcademy\Database\Database;
use MedAcademy\Utils\Config;

$isCli = PHP_SAPI === 'cli';
if (!$isCli) {
    fwrite(STDERR, "This script is CLI-only.\n");
    exit(1);
}

if (Config::string('APP_ENV', 'production') === 'production') {
    fwrite(STDERR, "Refusing to seed: APP_ENV=production. Point this at a local/staging database.\n");
    exit(2);
}

$options = getopt('', ['password::', 'students::', 'help']);
$studentCount = max(1, min(500, (int) ($options['students'] ?? 1)));
if (isset($options['help'])) {
    fwrite(STDOUT, "Usage: php scripts/loadtest/seed-local.php [--password=<plain>] [--students=<n>]\n");
    fwrite(STDOUT, "  --students=N  create N student accounts (default 1) so each VU needs its own session\n");
    fwrite(STDOUT, "If --password is omitted, LOADTEST_PASSWORD is used, else a random one is generated\n");
    fwrite(STDOUT, "and printed once so you can export it for k6.\n");
    exit(0);
}

$password = (string) ($options['password'] ?? getenv('LOADTEST_PASSWORD') ?: '');
if ($password === '') {
    $password = 'Lt-' . bin2hex(random_bytes(9)) . '!7';
    fwrite(STDOUT, "Generated load-test password (export it for k6): {$password}\n");
}

$db = Database::instance();
$hash = Password::hash($password);

function uuid(): string
{
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
}

/**
 * Insert-or-update an account (users row + profiles row).
 */
function upsertAccount(Database $db, string $email, string $fullName, string $role, string $hash, int $seq): string
{
    $existing = $db->row('SELECT id FROM users WHERE email = ?', [$email]);
    $id = $existing['id'] ?? uuid();

    if ($existing === null) {
        $db->query(
            'INSERT INTO users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at)
             VALUES (?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))',
            [$id, $email, $hash]
        );
    } else {
        $db->query(
            'UPDATE users SET encrypted_password = ?, email_confirmed_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
            [$hash, $id]
        );
    }

    $profile = $db->row('SELECT id FROM profiles WHERE id = ?', [$id]);
    if ($profile === null) {
        $db->query(
            'INSERT INTO profiles (id, email, full_name, role, status, watermark_id, public_user_id, security_version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))',
            [$id, $email, $fullName, $role, 'active', 'LT-' . strtoupper(substr($id, 0, 8)), '9' . str_pad((string) (900001 + $seq), 8, '0', STR_PAD_LEFT)]
        );
    } else {
        $db->query(
            'UPDATE profiles SET role = ?, status = ?, security_version = 1, updated_at = UTC_TIMESTAMP(6) WHERE id = ?',
            [$role, 'active', $id]
        );
    }

    return $id;
}

$studentId = upsertAccount($db, 'loadtest.student@example.invalid', 'Loadtest Student', 'student', $hash, 1);
$doctorId  = upsertAccount($db, 'loadtest.doctor@example.invalid', 'Loadtest Doctor', 'doctor', $hash, 2);
$adminId   = upsertAccount($db, 'loadtest.admin@example.invalid', 'Loadtest Admin', 'admin', $hash, 3);

// One student per virtual user: a shared account would share ONE session, which
// is exactly what the old suite did wrong (50 VUs, 1 device).
$studentIds = [$studentId];
for ($s = 2; $s <= $studentCount; $s++) {
    $studentIds[] = upsertAccount(
        $db,
        sprintf('loadtest.student%02d@example.invalid', $s),
        sprintf('Loadtest Student %02d', $s),
        'student',
        $hash,
        100 + $s
    );
}

// ---------------------------------------------------------------------------
// Content: 12 published courses, each with 4 sections and 12 lessons.
// ---------------------------------------------------------------------------
$courseIds = [];
for ($c = 1; $c <= 12; $c++) {
    $title = sprintf('Loadtest Course %02d', $c);
    $course = $db->row('SELECT id FROM courses WHERE title = ? AND doctor_id = ?', [$title, $doctorId]);
    $courseId = $course['id'] ?? uuid();
    $courseIds[] = $courseId;

    if ($course === null) {
        $db->query(
            // chk_courses_c0 requires a contact channel once a course is published.
            'INSERT INTO courses (id, doctor_id, title, description, short_description, language, status, phone,
                                  total_lessons, total_sections, credits_required, price_egp, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 12, 4, 0, 0, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))',
            [
                $courseId, $doctorId, $title,
                'Load-test fixture course. Safe to delete.',
                'Load-test fixture course',
                'en', 'published', '+201000000000',
            ]
        );
    }

    for ($s = 1; $s <= 4; $s++) {
        $sectionTitle = sprintf('Section %d-%d', $c, $s);
        $section = $db->row('SELECT id FROM sections WHERE course_id = ? AND title = ?', [$courseId, $sectionTitle]);
        $sectionId = $section['id'] ?? uuid();
        if ($section === null) {
            $db->query(
                'INSERT INTO sections (id, course_id, title, order_index, created_at, updated_at)
                 VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))',
                [$sectionId, $courseId, $sectionTitle, $s]
            );
        }

        for ($l = 1; $l <= 3; $l++) {
            $lessonTitle = sprintf('Lesson %d-%d-%d', $c, $s, $l);
            $lesson = $db->row('SELECT id FROM lessons WHERE course_id = ? AND title = ?', [$courseId, $lessonTitle]);
            if ($lesson === null) {
                $db->query(
                    'INSERT INTO lessons (id, section_id, course_id, title, description, duration_seconds, status, order_index, video_type, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, 600, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))',
                    [
                        uuid(), $sectionId, $courseId, $lessonTitle,
                        'Load-test fixture lesson.', 'published', $l, 'coming_soon',
                    ]
                );
            }
        }
    }

    // Enrollment + progress for every seeded student (no purchase, no
    // notification). One row per (student, course) so each VU's /courses call
    // returns a realistic list AND the per-student queries do real work.
    $lessons = $db->select('SELECT id FROM lessons WHERE course_id = ? ORDER BY order_index', [$courseId]);
    foreach ($studentIds as $sid) {
        $enrollment = $db->row('SELECT id FROM enrollments WHERE student_id = ? AND course_id = ?', [$sid, $courseId]);
        if ($enrollment === null) {
            $db->query(
                'INSERT INTO enrollments (id, student_id, course_id, enrolled_by, enrollment_method, status, progress_percent, visibility_level, enrolled_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
                [uuid(), $sid, $courseId, $doctorId, 'doctor_created', 'active', 35, 'all']
            );
        }

        foreach (array_slice($lessons, 0, 4) as $i => $lesson) {
            $progress = $db->row('SELECT id FROM lesson_progress WHERE student_id = ? AND lesson_id = ?', [$sid, $lesson['id']]);
            if ($progress === null) {
                $db->query(
                    'INSERT INTO lesson_progress (id, student_id, lesson_id, course_id, watch_position_seconds, completed, last_watched_at)
                     VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
                    [uuid(), $sid, $lesson['id'], $courseId, 120 + ($i * 30), $i < 2 ? 1 : 0]
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Notifications (read-only list endpoint; nothing is sent anywhere).
// ---------------------------------------------------------------------------
$existingNotifications = (int) $db->value('SELECT COUNT(*) FROM notifications WHERE user_id = ?', [$studentId], 0);
for ($n = $existingNotifications; $n < 20; $n++) {
    $db->query(
        'INSERT INTO notifications (id, user_id, title, body, notification_type, is_read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
        [uuid(), $studentId, 'Load-test notification', 'Fixture row for the notifications endpoint.', 'info', 0]
    );
}

fwrite(STDOUT, "Seeded load-test fixtures.\n");
fwrite(STDOUT, "  students: " . count($studentIds) . " (loadtest.student@example.invalid + loadtest.studentNN@…)\n");
fwrite(STDOUT, "  doctor:  loadtest.doctor@example.invalid\n");
fwrite(STDOUT, "  admin:   loadtest.admin@example.invalid\n");
fwrite(STDOUT, "  courses: " . count($courseIds) . " (published, 4 sections / 12 lessons each)\n");
fwrite(STDOUT, "  enrollments: " . count($courseIds) * count($studentIds) . " rows\n");
fwrite(STDOUT, "Export for k6:  export LOADTEST_PASSWORD='<the password you passed or generated>'\n");
fwrite(STDOUT, "Next:           php scripts/loadtest/issue-tokens.php --students=" . count($studentIds) . "\n");
