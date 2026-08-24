<?php

declare(strict_types=1);

/**
 * backend/scripts/seed-security-config.php
 *
 * Seeds the security_config table with a default active row.
 * Run once on the server after importing the schema:
 *
 *   php scripts/seed-security-config.php
 *
 * Idempotent — safe to run multiple times.
 * Column order matches schema.sql exactly (18 columns).
 */

require dirname(__DIR__) . '/src/bootstrap.php';

use MedAcademy\Database\Database;
use MedAcademy\Utils\Uuid;

$db = Database::instance();

$existing = $db->value('SELECT COUNT(*) FROM security_config WHERE is_active = 1', [], 0);

if ((int) $existing > 0) {
    echo "security_config already has an active row (count: {$existing}). Skipping." . PHP_EOL;
    exit(0);
}

$id = Uuid::v4();

// Column order MUST match schema.sql exactly (18 columns):
//  1 id                          ?       ($id)
//  2 play_integrity_enabled      0
//  3 expected_cert_sha256        NULL
//  4 minimum_app_version         ?       ('1.0.0')
//  5 force_update                0
//  6 security_version            1
//  7 extras                      ?       ('{}')
//  8 is_active                   1
//  9 updated_at                  UTC_TIMESTAMP(6)
// 10 updated_by                  NULL
// 11 created_at                  UTC_TIMESTAMP(6)
// 12 expected_cert_sha256s       ?       ('[]')
// 13 minimum_supported_version   ?       ('1.0.0')
// 14 latest_version              ?       ('1.0.0')
// 15 update_title                ?       ('Update Required')
// 16 update_message              ?       ('A critical update...')
// 17 android_store_url           ?       ('')
// 18 ios_store_url               ?       ('')

$db->query(
    'INSERT INTO security_config
        (id, play_integrity_enabled, expected_cert_sha256, minimum_app_version,
         force_update, security_version, extras, is_active,
         updated_at, updated_by, created_at,
         expected_cert_sha256s, minimum_supported_version, latest_version,
         update_title, update_message, android_store_url, ios_store_url)
     VALUES (?, 0, NULL, ?, 0, 1, ?, 1,
             UTC_TIMESTAMP(6), NULL, UTC_TIMESTAMP(6),
             ?, ?, ?, ?, ?, ?, ?)',
    [
        $id,                //  1 id
        '1.0.0',            //  4 minimum_app_version
        '{}',               //  7 extras
        '[]',               // 12 expected_cert_sha256s
        '1.0.0',            // 13 minimum_supported_version
        '1.0.0',            // 14 latest_version
        'Update Required',  // 15 update_title
        'A critical update is available. Please update the app to continue.', // 16 update_message
        '',                 // 17 android_store_url
        '',                 // 18 ios_store_url
    ]
);

// Verify the insert actually committed
$verify = $db->value('SELECT COUNT(*) FROM security_config WHERE id = ?', [$id], 0);
if ((int) $verify > 0) {
    echo "security_config seeded and verified (id: {$id})" . PHP_EOL;
} else {
    echo "ERROR: Insert appeared to succeed but row not found!" . PHP_EOL;
    exit(1);
}
