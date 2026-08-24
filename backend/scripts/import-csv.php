<?php

declare(strict_types=1);

/**
 * import-csv.php — import a Supabase Table Editor CSV export into MySQL.
 *
 * Preserves UUIDs verbatim (CHAR(36)), converts:
 *   \N / empty-string  -> NULL (where the column allows)
 *   "true"/"false"     -> 1 / 0
 *   {...} / [...]      -> JSON (passed through)
 *   ISO timestamps     -> stored as-is (DATETIME(6))
 *
 * Usage:
 *   php backend/scripts/import-csv.php --table=profiles --file=profiles.csv [--truncate]
 *
 * The importer uses the column names in the CSV header row and only touches
 * the columns present. It is intentionally conservative: it never drops or
 * rewrites rows.
 */

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "CLI only\n");
    exit(1);
}

require dirname(__DIR__) . '/src/bootstrap.php'; // env + autoload (no dispatch)

use MedAcademy\Database\Database;
use MedAcademy\Utils\Uuid;

$args = [];
foreach ($argv as $i => $a) {
    if ($i === 0) {
        continue;
    }
    if (preg_match('/^--([a-z_]+)=(.*)$/', $a, $m)) {
        $args[$m[1]] = $m[2];
    }
}

$table = $args['table'] ?? '';
$file = $args['file'] ?? '';
if ($table === '' || $file === '' || !is_file($file)) {
    fwrite(STDERR, "usage: php import-csv.php --table=<table> --file=<file.csv> [--truncate]\n");
    exit(1);
}

$db = Database::instance();

// Validate the table exists and read its columns
$cols = $db->select('SHOW COLUMNS FROM `' . preg_replace('/[^a-z_]/', '', $table) . '`');
$colInfo = [];
foreach ($cols as $c) {
    $colInfo[$c['Field']] = [
        'nullable' => $c['Null'] === 'YES',
        'type' => $c['Type'],
        'default' => $c['Default'],
    ];
}
if ($colInfo === []) {
    fwrite(STDERR, "table not found: $table\n");
    exit(1);
}

$fh = fopen($file, 'r');
if ($fh === false) {
    fwrite(STDERR, "cannot open $file\n");
    exit(1);
}

$header = fgetcsv($fh);
if ($header === false) {
    fwrite(STDERR, "empty CSV\n");
    exit(1);
}
// Trim BOM
$header[0] = preg_replace('/^\xEF\xBB\xBF/', '', (string) $header[0]);
$header = array_map('trim', $header);

if (!empty($args['truncate'])) {
    $db->query('DELETE FROM `' . $table . '`');
    fwrite(STDOUT, "truncated $table\n");
}

$importCols = [];
foreach ($header as $h) {
    if (isset($colInfo[$h])) {
        $importCols[] = $h;
    } else {
        fwrite(STDERR, "warning: column '$h' not in table — skipped\n");
    }
}
if ($importCols === []) {
    fwrite(STDERR, "no matching columns\n");
    exit(1);
}

$placeholders = implode(',', array_fill(0, count($importCols), '?'));
$sql = 'INSERT INTO `' . $table . '` (`' . implode('`,`', $importCols) . '`) VALUES (' . $placeholders . ')';
$stmt = $db->query('SET autocommit=0');

$row = 0;
$inserted = 0;
$skipped = 0;
$batch = [];
$batchSize = 500;

$convert = static function (string $value, array $info): mixed {
    $value = trim($value);
    if ($value === '\\N' || $value === '') {
        return $info['nullable'] ? null : ($info['default'] ?? null);
    }
    $lower = strtolower($value);
    if ($lower === 'true') {
        return 1;
    }
    if ($lower === 'false') {
        return 0;
    }
    if (preg_match('/^(0|[1-9]\d*)$/', $value)) {
        return (int) $value;
    }
    // timestamps: pass through ISO strings (DATETIME accepts them)
    return $value;
};

while (($data = fgetcsv($fh)) !== false) {
    $row++;
    if (count($data) < count($importCols)) {
        $skipped++;
        continue;
    }
    $values = [];
    foreach ($importCols as $j => $col) {
        $values[] = $convert((string) ($data[$j] ?? ''), $colInfo[$col]);
    }
    // ensure an id exists when the row is new
    if (in_array('id', $importCols, true)) {
        $idIdx = array_search('id', $importCols, true);
        if ($values[$idIdx] === null || $values[$idIdx] === '') {
            $values[$idIdx] = Uuid::v4();
        }
    }
    $batch[] = $values;
    if (count($batch) >= $batchSize) {
        $inserted += runBatch($db, $stmt, $sql, $batch);
        $batch = [];
    }
}
if ($batch !== []) {
    $inserted += runBatch($db, $stmt, $sql, $batch);
}

$db->query('COMMIT');
fclose($fh);
fwrite(STDOUT, "rows read: $row | inserted: $inserted | skipped: $skipped\n");

function runBatch(Database $db, $stmt, string $sql, array $batch): int
{
    $n = 0;
    foreach ($batch as $values) {
        try {
            $db->query($sql, $values);
            $n++;
        } catch (PDOException $e) {
            if ($e->getCode() === '23000') {
                // duplicate key — row already present (idempotent re-run)
                continue;
            }
            throw $e;
        }
    }
    return $n;
}
