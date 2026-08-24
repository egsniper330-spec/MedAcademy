<?php

declare(strict_types=1);

/**
 * import-auth-users.php — import the Supabase `auth.users` CSV export into
 * the MySQL `users` table, PRESERVING the bcrypt password hashes so existing
 * accounts keep working without a reset.
 *
 * The hash is inserted verbatim (Supabase uses $2a$ bcrypt, which PHP's
 * password_verify() accepts natively). AuthService re-hashes transparently
 * to $2y$ on the user's first successful login after cutover.
 *
 * Usage:
 *   php backend/scripts/import-auth-users.php --file=auth.users.csv
 */

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "CLI only\n");
    exit(1);
}

require dirname(__DIR__) . '/src/bootstrap.php';

use MedAcademy\Database\Database;
use MedAcademy\Utils\Uuid;

$file = '';
foreach ($argv as $i => $a) {
    if ($i > 0 && preg_match('/^--file=(.+)$/', $a, $m)) {
        $file = $m[1];
    }
}
if ($file === '' || !is_file($file)) {
    fwrite(STDERR, "usage: php import-auth-users.php --file=auth.users.csv\n");
    exit(1);
}

$db = Database::instance();
$fh = fopen($file, 'r');
$header = array_map('trim', fgetcsv($fh) ?? []);
$header[0] = preg_replace('/^\xEF\xBB\xBF/', '', (string) $header[0]);

$idIdx = array_search('id', $header, true);
$emailIdx = array_search('email', $header, true);
$phoneIdx = array_search('phone', $header, true);
$passIdx = array_search('encrypted_password', $header, true);
$metaIdx = array_search('raw_user_meta_data', $header, true);
$createdIdx = array_search('created_at', $header, true);

if ($idIdx === false || $passIdx === false) {
    fwrite(STDERR, "CSV must contain at least: id, encrypted_password\n");
    exit(1);
}

$inserted = 0;
$skipped = 0;
while (($row = fgetcsv($fh)) !== false) {
    $id = trim((string) ($row[$idIdx] ?? ''));
    $hash = trim((string) ($row[$passIdx] ?? ''));
    if ($id === '' || $hash === '') {
        $skipped++;
        continue;
    }
    // sanity: refuse to import something that is not a bcrypt hash
    if (!preg_match('/^\$2[aby]\$/', $hash)) {
        fwrite(STDERR, "SKIP $id — encrypted_password is not bcrypt (got: " . substr($hash, 0, 8) . "...)\n");
        $skipped++;
        continue;
    }
    $email = $emailIdx !== false ? trim((string) ($row[$emailIdx] ?? '')) : null;
    $phone = $phoneIdx !== false ? trim((string) ($row[$phoneIdx] ?? '')) : null;
    $meta = $metaIdx !== false ? trim((string) ($row[$metaIdx] ?? '')) : null;
    $created = $createdIdx !== false && trim((string) ($row[$createdIdx] ?? '')) !== '' ? trim((string) $row[$createdIdx]) : null;

    try {
        $db->insert(
            'INSERT INTO users (id, email, phone, encrypted_password, raw_user_meta_data, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, COALESCE(?, UTC_TIMESTAMP(6)), UTC_TIMESTAMP(6))
             ON DUPLICATE KEY UPDATE
               email = VALUES(email), phone = VALUES(phone),
               encrypted_password = VALUES(encrypted_password),
               raw_user_meta_data = VALUES(raw_user_meta_data)',
            [strtolower($id), $email !== '' ? strtolower($email) : null, $phone !== '' ? $phone : null, $hash, $meta, $created]
        );
        $inserted++;
    } catch (PDOException $e) {
        fwrite(STDERR, "error importing $id: " . $e->getMessage() . "\n");
        $skipped++;
    }
}
fclose($fh);
fwrite(STDOUT, "users imported: $inserted | skipped: $skipped\n");
fwrite(STDOUT, "NEXT: import profiles (id must match auth.users.id), then run the main manifest.\n");
