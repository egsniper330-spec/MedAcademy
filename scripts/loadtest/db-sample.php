<?php

declare(strict_types=1);

/**
 * db-sample.php — read-only database metrics WHILE a load test runs.
 *
 * WHY THIS EXISTS
 * ───────────────
 * A load test measured only from the client cannot say whether the API or the
 * database was the limit. Shared cPanel exposes no MySQL resource metrics to the
 * application, and this repository must not enable the slow-query log or change
 * server settings to get them. What it CAN do is read the counters MySQL already
 * keeps, which is what this script does — `SHOW GLOBAL STATUS` /
 * `SHOW VARIABLES` are read-only and cheap.
 *
 * WHAT IT REPORTS
 *   Threads_connected / Threads_running   live connections (the pool ceiling)
 *   Max_used_connections                  high-water mark since the server started
 *   Aborted_connects / Connection_errors* refusals — the "cannot connect" signal
 *   Innodb_row_lock_waits / _time_avg     lock waits (write contention)
 *   Slow_queries                          only meaningful if the host enables it
 *   Questions / Com_select                query rate (delta between samples)
 *   uptime, max_connections               for context
 *
 * WHAT IT CANNOT REPORT (say so, never invent it)
 *   • per-process CPU/RAM of mysqld      — not exposed to the account
 *   • InnoDB buffer-pool hit rate detail — needs more privileges than a shared
 *                                          account normally has (skipped, not faked)
 *   • query text / which query was slow  — requires the slow-query log, which is
 *                                          a production-wide setting (needs owner
 *                                          approval; not enabled by this tool)
 *
 * USAGE (on the server, in one terminal, while k6 runs in another)
 *   php scripts/loadtest/db-sample.php --interval=5 --duration=300
 *   php scripts/loadtest/db-sample.php --once --pretty
 *
 * Emits newline-delimited JSON (one sample per interval) so a run can be replayed
 * or charted afterwards. `--duration` is a hard cap; Ctrl+C also works.
 *
 * SAFETY
 *   • CLI only (never reachable over HTTP).
 *   • Read-only statements only. No SET, no FLUSH, no logging changes.
 *   • Refuses to run when APP_ENV=production unless `--allow-production` is
 *     passed, because sampling is expected on staging; reading counters on
 *     production is harmless but should be a deliberate act.
 *   • Prints counts and timings only: no credentials, no query text, no user
 *     data, no answers from result rows.
 */

require dirname(__DIR__, 2) . '/backend/src/bootstrap.php';

use MedAcademy\Database\Database;
use MedAcademy\Utils\Config;

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "CLI only.\n");
    exit(1);
}

$args = [];
foreach (array_slice($argv, 1) as $arg) {
    if (!str_starts_with($arg, '--')) {
        continue;
    }
    [$k, $v] = array_pad(explode('=', substr($arg, 2), 2), 2, '1');
    $args[$k] = $v;
}

if (isset($args['help'])) {
    fwrite(STDOUT, "Usage: php scripts/loadtest/db-sample.php [--interval=5] [--duration=300] [--once] [--pretty] [--allow-production]\n");
    exit(0);
}

$interval = max(1, (int) ($args['interval'] ?? 5));
$duration = max(0, (int) ($args['duration'] ?? 300));
$once = isset($args['once']);
$pretty = isset($args['pretty']);
$allowProduction = isset($args['allow-production']);

if (Config::string('APP_ENV', 'production') === 'production' && !$allowProduction) {
    fwrite(STDERR, "APP_ENV=production: pass --allow-production to sample the live database (read-only).\n");
    exit(2);
}

/**
 * All global status counters in ONE round trip.
 *
 * `SHOW GLOBAL STATUS LIKE ?` cannot take a placeholder (MySQL does not allow
 * prepared parameters in SHOW statements), so the whole table is read once per
 * sample and the needed keys are picked in PHP — one query instead of a dozen.
 *
 * @return array<string,int|null>
 */
function readStatusCounters(array $keys): array
{
    $out = array_fill_keys($keys, null);
    foreach (Database::instance()->select('SHOW GLOBAL STATUS') as $row) {
        $name = (string) ($row['Variable_name'] ?? $row['variable_name'] ?? '');
        if ($name === '' || !array_key_exists($name, $out)) {
            continue;
        }
        $raw = $row['Value'] ?? $row['value'] ?? null;
        $out[$name] = is_numeric($raw) ? (int) $raw : null;
    }
    return $out;
}

function maxConnections(): ?int
{
    try {
        $value = Database::instance()->value('SELECT @@max_connections AS v');
        return is_numeric($value) ? (int) $value : null;
    } catch (Throwable) {
        return null;
    }
}

$statusKeys = [
    'Threads_connected',
    'Threads_running',
    'Max_used_connections',
    'Aborted_connects',
    'Connection_errors_max_connections',
    'Innodb_row_lock_waits',
    'Innodb_row_lock_time_avg',
    'Slow_queries',
    'Questions',
    'Com_select',
    'Uptime',
];

$maxConnections = maxConnections();
$startedAt = microtime(true);
$previous = null;
$previousSampleAt = $startedAt;

do {
    $sampleStart = microtime(true);
    $status = [];
    $unavailable = [];

    try {
        $status = readStatusCounters($statusKeys);
        foreach ($status as $key => $value) {
            if ($value === null) {
                $unavailable[] = $key;
            }
        }
    } catch (Throwable $e) {
        // A missing privilege must not abort the sample: report it as unavailable.
        $status = array_fill_keys($statusKeys, null);
        $unavailable = $statusKeys;
    }

    // Query latency for ONE trivial round trip: the database's own response time
    // as this account can measure it (SELECT 1 + the driver's round trip).
    $probeStart = microtime(true);
    try {
        Database::instance()->value('SELECT 1', [], 1);
        $probeMs = round((microtime(true) - $probeStart) * 1000, 2);
    } catch (Throwable $e) {
        $probeMs = null;
    }

    $delta = [];
    if ($previous !== null) {
        foreach (['Questions', 'Com_select', 'Aborted_connects', 'Innodb_row_lock_waits'] as $key) {
            if (($status[$key] ?? null) !== null && ($previous[$key] ?? null) !== null) {
                $delta[$key] = $status[$key] - $previous[$key];
            }
        }
        $elapsed = $sampleStart - ($previousSampleAt ?? $sampleStart);
        if ($elapsed > 0 && isset($delta['Questions'])) {
            $delta['questions_per_second'] = round($delta['Questions'] / $elapsed, 2);
        }
    }
    $previous = $status;
    $previousSampleAt = $sampleStart;

    $record = [
        'ts' => gmdate('Y-m-d\TH:i:s\Z'),
        'elapsed_seconds' => round($sampleStart - $startedAt, 1),
        'max_connections' => $maxConnections === null ? null : (int) $maxConnections,
        'threads_connected' => $status['Threads_connected'],
        'threads_running' => $status['Threads_running'],
        'max_used_connections' => $status['Max_used_connections'],
        'connection_errors' => [
            'aborted_connects' => $status['Aborted_connects'],
            'max_connections' => $status['Connection_errors_max_connections'],
        ],
        'row_locks' => [
            'waits' => $status['Innodb_row_lock_waits'],
            'avg_wait_ms' => $status['Innodb_row_lock_time_avg'],
        ],
        'slow_queries' => $status['Slow_queries'],
        'queries' => [
            'total' => $status['Questions'],
            'select' => $status['Com_select'],
        ],
        'delta' => $delta,
        'probe_select1_ms' => $probeMs,
        'unavailable' => $unavailable,
        'note' => 'Read-only counters. mysqld CPU/RAM and per-query timings are not exposed to this account.',
    ];

    if ($pretty) {
        fwrite(
            STDOUT,
            sprintf(
                "%s connected=%s running=%s max_used=%s locks=%s slow=%s probe=%sms qps=%s\n",
                $record['ts'],
                (string) $record['threads_connected'],
                (string) $record['threads_running'],
                (string) $record['max_used_connections'],
                (string) $record['row_locks']['waits'],
                (string) $record['slow_queries'],
                (string) $record['probe_select1_ms'],
                (string) ($delta['questions_per_second'] ?? 'n/a')
            )
        );
    } else {
        fwrite(STDOUT, json_encode($record, JSON_UNESCAPED_SLASHES) . "\n");
    }

    if ($once) {
        break;
    }
    if ($duration > 0 && (microtime(true) - $startedAt) + $interval > $duration) {
        break;
    }
    sleep($interval);
} while (true);
