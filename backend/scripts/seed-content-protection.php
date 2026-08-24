<?php

declare(strict_types=1);

/**
 * backend/scripts/seed-content-protection.php
 *
 * Seeds the content_protection_policies table with the default policy row
 * that the security/violations endpoint expects (UUID 00000000-...-0001).
 *
 * Run once on the server:
 *   php scripts/seed-content-protection.php
 *
 * Idempotent — safe to run multiple times.
 */

require dirname(__DIR__) . '/src/bootstrap.php';

use MedAcademy\Database\Database;

$db = Database::instance();

$policyId = '00000000-0000-0000-0000-000000000001';

$existing = $db->value('SELECT COUNT(*) FROM content_protection_policies WHERE id = ?', [$policyId], 0);

if ((int) $existing > 0) {
    echo "content_protection_policies policy row already exists. Skipping." . PHP_EOL;
    exit(0);
}

$db->query(
    'INSERT INTO content_protection_policies
        (id, screenshot_policy, recording_policy, violation_limit,
         warning_message, auto_logout, auto_suspend, suspension_hours,
         strike1_action, strike2_action, strike3_action,
         updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), NULL)',
    [
        $policyId,
        'strike_system',   // screenshot_policy
        'strike_system',   // recording_policy
        3,                 // violation_limit
        'Screenshots of protected educational content are prohibited. Repeated violations may result in temporary account suspension.',
        1,                 // auto_logout
        1,                 // auto_suspend
        24,                // suspension_hours
        'warning',         // strike1_action
        'logout',          // strike2_action
        'suspend',         // strike3_action
    ]
);

$verify = $db->value('SELECT COUNT(*) FROM content_protection_policies WHERE id = ?', [$policyId], 0);
if ((int) $verify > 0) {
    echo "content_protection_policies seeded (id: {$policyId})" . PHP_EOL;
} else {
    echo "ERROR: Insert appeared to succeed but row not found!" . PHP_EOL;
    exit(1);
}
