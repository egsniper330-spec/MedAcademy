<?php

declare(strict_types=1);

/**
 * cron-video-health.php — PHP CLI equivalent of the video-daily-health Edge Function.
 *
 * Cron schedule: 0 3 * * * (daily at 3 AM UTC)
 *
 * Scans all ready/failed videos, generates a daily report, sends alerts.
 *
 * Usage:
 *   php scripts/cron-video-health.php
 *   php scripts/cron-video-health.php --secret=YOUR_CRON_SECRET
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
use MedAcademy\Services\AuditService;
use MedAcademy\Utils\Config;
use MedAcademy\Utils\Uuid;

$db = Database::instance();
$today = date('Y-m-d');
$scanStart = microtime(true);

echo "[video-daily-health] Starting daily scan for {$today}\n";

try {
    // Fetch all ready/failed uploads
    $uploads = $db->select(
        "SELECT id, thumbnail_url, public_url, lesson_id, provider_video_id, status
           FROM video_uploads
          WHERE status IN ('ready', 'failed', 'verifying')
          LIMIT 2000"
    );

    if (empty($uploads)) {
        echo "[video-daily-health] No videos to scan.\n";
        exit(0);
    }

    $passed = 0;
    $failed = 0;
    $warnings = 0;
    $alertsToCreate = [];

    $apiSecret = Config::string('VDOCIPHER_API_SECRET', '');

    foreach ($uploads as $upload) {
        $errors = [];

        // Thumbnail check
        if (empty($upload['thumbnail_url'])) {
            $errors[] = 'Thumbnail missing.';
            $db->query(
                'UPDATE video_uploads SET thumbnail_missing = 1 WHERE id = ?',
                [$upload['id']]
            );
        }

        // Metadata check via VdoCipher
        if (!empty($upload['provider_video_id']) && $apiSecret !== '') {
            $videoId = $upload['provider_video_id'];
            $ch = curl_init("https://dev.vdocipher.com/api/videos/{$videoId}");
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => ["Authorization: Apisecret {$apiSecret}"],
                CURLOPT_TIMEOUT => 10,
            ]);
            $response = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);

            if ($httpCode !== 200) {
                $errors[] = "Metadata fetch failed (HTTP {$httpCode}).";
            } else {
                $meta = json_decode($response, true);
                $patch = ['last_health_check_at' => date('Y-m-d H:i:s')];
                if (!empty($meta['width']) && !empty($meta['height'])) {
                    $patch['video_resolution'] = $meta['width'] . 'x' . $meta['height'];
                }
                if (!empty($meta['length'])) {
                    $patch['video_duration_sec'] = (int) $meta['length'];
                }
                if (!empty($meta['poster']) && empty($upload['thumbnail_url'])) {
                    $patch['thumbnail_url'] = $meta['poster'];
                }
                if (count($patch) > 1) {
                    $sets = [];
                    $params = [];
                    foreach ($patch as $col => $val) {
                        $sets[] = "{$col} = ?";
                        $params[] = $val;
                    }
                    $params[] = $upload['id'];
                    $db->query('UPDATE video_uploads SET ' . implode(', ', $sets) . ' WHERE id = ?', $params);
                }
            }
        }

        $healthScore = max(0, 100 - count($errors) * 20);
        $status = count($errors) === 0 ? 'passed' : 'failed';

        $db->query(
            'UPDATE video_uploads SET health_score = ?, verification_status = ?, verification_error = ?,
                    playback_status = ? WHERE id = ?',
            [$healthScore, $status, !empty($errors) ? implode(' ', $errors) : null,
             !empty($errors) ? 'error' : 'ok', $upload['id']]
        );

        if (count($errors) === 0) {
            $passed++;
        } else {
            $failed++;
            $alertsToCreate[] = [
                'upload_id' => $upload['id'],
                'alert_type' => 'verification_failed',
                'severity' => count($errors) >= 2 ? 'critical' : 'warning',
                'title' => 'Daily Health Check Failed',
                'message' => implode(' ', $errors),
                'metadata' => json_encode(['scan_date' => $today, 'errors' => $errors]),
            ];
        }
    }

    // Create alerts (deduplicate)
    foreach ($alertsToCreate as $alert) {
        $existingAlerts = $db->value(
            'SELECT COUNT(*) FROM video_health_alerts WHERE upload_id = ? AND resolved = 0',
            [$alert['upload_id']], 0
        );
        if ($existingAlerts === 0) {
            $db->insert(
                'INSERT INTO video_health_alerts (id, upload_id, alert_type, severity, title, message, metadata, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))',
                [Uuid::v4(), $alert['upload_id'], $alert['alert_type'], $alert['severity'],
                 $alert['title'], $alert['message'], $alert['metadata']]
            );
        }
    }

    $total = count($uploads);
    $healthPct = $total > 0 ? round(($passed / $total) * 100, 2) : 100;
    $scanDuration = round(microtime(true) - $scanStart);

    // Upsert daily report
    $db->query(
        'INSERT INTO video_daily_health_reports (id, report_date, total_videos, healthy_count, broken_count, warning_count, health_pct, scan_duration_s, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))
         ON DUPLICATE KEY UPDATE
            total_videos = VALUES(total_videos), healthy_count = VALUES(healthy_count),
            broken_count = VALUES(broken_count), warning_count = VALUES(warning_count),
            health_pct = VALUES(health_pct), scan_duration_s = VALUES(scan_duration_s),
            details = VALUES(details)',
        [
            Uuid::v4(), $today, $total, $passed, $failed, $warnings,
            $healthPct, $scanDuration,
            json_encode(['scan_type' => 'daily_cron', 'alerts_created' => count($alertsToCreate)]),
        ]
    );

    // Update provider health
    $db->query(
        "UPDATE video_provider_config SET last_sync_at = UTC_TIMESTAMP(6) WHERE provider_key = 'medacademy'"
    );

    echo "[video-daily-health] Done: {$passed} passed, {$failed} failed, health: {$healthPct}%, duration: {$scanDuration}s\n";

    AuditService::write(null, 'system_health_check', [
        'type' => 'video_daily_health',
        'scanned' => $total,
        'passed' => $passed,
        'failed' => $failed,
    ]);

    exit($failed > 0 ? 1 : 0);
} catch (\Throwable $e) {
    fwrite(STDERR, "[video-daily-health] Fatal error: {$e->getMessage()}\n");
    exit(1);
}
