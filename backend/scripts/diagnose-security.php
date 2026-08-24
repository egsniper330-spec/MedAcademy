<?php

declare(strict_types=1);

/**
 * backend/scripts/diagnose-security.php
 *
 * Safe diagnostic — outputs only non-secret metadata about the
 * security_config table and security_events table.
 *
 * Run on the server:
 *   php scripts/diagnose-security.php
 */

require dirname(__DIR__) . '/src/bootstrap.php';

use MedAcademy\Database\Database;

$db = Database::instance();

echo "=== security_config diagnostic ===" . PHP_EOL;

// 1. Total rows
$total = (int) $db->value('SELECT COUNT(*) FROM security_config', [], 0);
echo "Total rows: {$total}" . PHP_EOL;

// 2. Active rows
$active = (int) $db->value('SELECT COUNT(*) FROM security_config WHERE is_active = 1', [], 0);
echo "Active rows (is_active=1): {$active}" . PHP_EOL;

// 3. is_active column type
$colInfo = $db->row("SHOW COLUMNS FROM security_config WHERE Field = 'is_active'");
echo "is_active column: type=" . ($colInfo['Type'] ?? '?') . " null=" . ($colInfo['Null'] ?? '?') . " default=" . ($colInfo['Default'] ?? 'NULL') . PHP_EOL;

// 4. Show non-secret columns of active rows
if ($active > 0) {
    $rows = $db->select(
        'SELECT id, play_integrity_enabled, minimum_app_version, force_update,
                security_version, is_active, minimum_supported_version,
                latest_version, update_title
           FROM security_config WHERE is_active = 1'
    );
    foreach ($rows as $i => $row) {
        echo "Active row " . ($i + 1) . ": id=" . substr($row['id'], 0, 8)
            . "... sec_ver=" . $row['security_version']
            . " min_ver=" . $row['minimum_app_version']
            . " force_update=" . $row['force_update']
            . PHP_EOL;
    }
}

// 5. Show all is_active values
$all = $db->select('SELECT id, is_active FROM security_config');
foreach ($all as $row) {
    echo "  row id=" . substr($row['id'], 0, 8) . "... is_active=" . var_export($row['is_active'], true) . PHP_EOL;
}

echo PHP_EOL . "=== security_events table check ===" . PHP_EOL;

try {
    $cols = $db->select('SHOW COLUMNS FROM security_events');
    echo "security_events columns: " . count($cols) . PHP_EOL;
    foreach ($cols as $c) {
        echo "  " . $c['Field'] . " (" . $c['Type'] . ")" . PHP_EOL;
    }
} catch (\Throwable $e) {
    echo "ERROR: " . $e->getMessage() . PHP_EOL;
}

echo PHP_EOL . "=== content_protection_policies check ===" . PHP_EOL;

try {
    $policies = $db->select('SELECT id, strike1_action, strike2_action, strike3_action FROM content_protection_policies');
    echo "content_protection_policies rows: " . count($policies) . PHP_EOL;
    foreach ($policies as $p) {
        echo "  id=" . substr($p['id'], 0, 8) . "... s1=" . ($p['strike1_action'] ?? 'NULL') . " s2=" . ($p['strike2_action'] ?? 'NULL') . " s3=" . ($p['strike3_action'] ?? 'NULL') . PHP_EOL;
    }
} catch (\Throwable $e) {
    echo "ERROR: " . $e->getMessage() . PHP_EOL;
}
