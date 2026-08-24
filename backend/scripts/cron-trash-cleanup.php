<?php

declare(strict_types=1);

/**
 * cron-trash-cleanup.php — PHP CLI equivalent of the trash-cleanup Edge Function.
 *
 * Cron schedule: 0 2 * * * (daily at 2 AM UTC)
 *
 * Permanently deletes all trashed users whose retention period has expired.
 *
 * Usage:
 *   php scripts/cron-trash-cleanup.php
 *   php scripts/cron-trash-cleanup.php --secret=YOUR_CRON_SECRET
 */

// Load environment
$envFile = __DIR__ . '/../.env';
if (file_exists($envFile)) {
    foreach (file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#') continue;
        $pos = strpos($line, '=');
        if ($pos === false) continue;
        $key = trim(substr($line, 0, $pos));
        $value = trim(substr($line, $pos + 1));
        if (!isset($_ENV[$key]) && getenv($key) === false) {
            putenv("{$key}={$value}");
            $_ENV[$key] = $value;
        }
    }
}

// Verify cron secret if provided
$cronSecret = getenv('CRON_SECRET');
$providedSecret = null;
foreach ($argv as $arg) {
    if (str_starts_with($arg, '--secret=')) {
        $providedSecret = substr($arg, 9);
    }
}
if ($cronSecret !== '' && $providedSecret !== $cronSecret) {
    fwrite(STDERR, "ERROR: Invalid or missing cron secret\n");
    exit(1);
}

require_once __DIR__ . '/../src/bootstrap.php';

use MedAcademy\Database\Database;
use MedAcademy\Services\AuthService;
use MedAcademy\Services\AuditService;
use MedAcademy\Utils\Uuid;

$db = Database::instance();
$deleted = 0;
$failed = 0;
$now = date('Y-m-d H:i:s');

echo "[trash-cleanup] Starting at {$now}\n";

try {
    // Find trashed users whose retention period has expired
    $trashedUsers = $db->select(
        "SELECT id, trashed_at, trash_expires_at FROM profiles
          WHERE status = 'trashed' AND trash_expires_at IS NOT NULL
            AND trash_expires_at <= UTC_TIMESTAMP(6)"
    );

    echo "[trash-cleanup] Found " . count($trashedUsers) . " expired trashed users\n";

    foreach ($trashedUsers as $user) {
        try {
            $userId = $user['id'];

            // Delete dependent records
            $db->query('DELETE FROM devices WHERE user_id = ?', [$userId]);
            $db->query('DELETE FROM login_history WHERE user_id = ?', [$userId]);
            $db->query('DELETE FROM notifications WHERE user_id = ?', [$userId]);
            $db->query('DELETE FROM content_protection_violations WHERE user_id = ?', [$userId]);
            $db->query('DELETE FROM security_events WHERE user_id = ?', [$userId]);

            // Delete credits
            $db->query('DELETE FROM credits WHERE doctor_id = ?', [$userId]);
            $db->query('DELETE FROM credit_transactions WHERE doctor_id = ?', [$userId]);

            // Delete enrollments
            $db->query('DELETE FROM enrollments WHERE student_id = ?', [$userId]);

            // Delete audit logs (anonymize instead of delete for compliance)
            $db->query(
                'UPDATE audit_logs SET user_id = NULL, actor_id = NULL, details = ? WHERE user_id = ? OR actor_id = ?',
                [json_encode(['anonymized' => true, 'reason' => 'trash_cleanup']), $userId, $userId]
            );

            // Delete profile
            $db->query('DELETE FROM profiles WHERE id = ?', [$userId]);

            // Delete user
            $db->query('DELETE FROM users WHERE id = ?', [$userId]);

            $deleted++;
        } catch (\Throwable $e) {
            $failed++;
            fwrite(STDERR, "[trash-cleanup] Failed to delete user {$user['id']}: {$e->getMessage()}\n");
        }
    }

    // Also recover stale upload sessions
    $staleSessions = $db->value(
        "SELECT COUNT(*) FROM upload_sessions
          WHERE status = 'uploading' AND updated_at < DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 24 HOUR)",
        [], 0
    );

    if ($staleSessions > 0) {
        $db->query(
            "UPDATE upload_sessions SET status = 'expired', error_message = 'Expired by cron cleanup'
              WHERE status = 'uploading' AND updated_at < DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 24 HOUR)"
        );
        echo "[trash-cleanup] Recovered {$staleSessions} stale upload sessions\n";
    }

    echo "[trash-cleanup] Completed: {$deleted} deleted, {$failed} failed\n";
    AuditService::write(null, 'trash_emptied', [
        'deleted' => $deleted,
        'failed' => $failed,
        'ran_at' => $now,
    ]);

    exit($failed > 0 ? 1 : 0);
} catch (\Throwable $e) {
    fwrite(STDERR, "[trash-cleanup] Fatal error: {$e->getMessage()}\n");
    exit(1);
}
