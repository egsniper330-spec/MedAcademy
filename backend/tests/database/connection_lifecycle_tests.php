<?php

declare(strict_types=1);

/**
 * connection_lifecycle_tests.php — connection lifetime + quota handling.
 *
 * WHY THIS SUITE EXISTS
 *   Production is shared hosting with a per-ACCOUNT cap of 50 simultaneous MySQL
 *   connections (`max_user_connections = 50`; the server allows 500). At 150-200
 *   concurrent requests the API returned `SQLSTATE[HY000] [1226] User
 *   'vcoafnqsgg_api' has exceeded the 'max_user_connections' resource`.
 *
 *   The demand is `requests per second × connection HOLD time`, so the fix is to
 *   stop holding the single per-request connection across phases that do not use
 *   the database (PDF render, document hash, streaming a file). That is
 *   `Database::release()`, and these checks prove its contract rather than
 *   trusting it:
 *
 *   C1 release() really closes the connection and the next query reconnects
 *      (a DIFFERENT server connection id), so callers need no other change.
 *   C2 release() is a NO-OP inside an open transaction — it can never silently
 *      discard or roll back committed work in progress.
 *   C3 quota errors are recognised narrowly (1226 / 1203 / 1040) and an
 *      unreachable server (2002) is NOT misreported as capacity.
 *   C4 end to end: with the account's connection allowance deliberately
 *      saturated, the API answers 503 + `database_busy` + `Retry-After` on a
 *      database-backed public route, and never fakes a 200. The saturation is
 *      held by THIS process (2 connections) and then confirmed with a refused
 *      third one, so the result cannot depend on winning a request race.
 *      C4 needs a running API and the privilege to set a user quota (UPDATE on
 *      mysql.*); when either is missing it reports SKIP with the reason instead
 *      of a false pass. `/api/health` is deliberately NOT used: that route
 *      catches a database error and answers 200 `degraded`, so it cannot show
 *      the client-visible contract. Override the route with CONN_TEST_PATH
 *      (relative to BASE_URL, e.g. /api/support/contact on the live host).
 *
 * SAFETY
 *   • Refuses to run when APP_ENV=production (it changes a USER quota).
 *   • Restores `MAX_USER_CONNECTIONS 0` in a finally block.
 *   • Writes no rows; touches no application table.
 *
 * USAGE
 *   php backend/tests/database/connection_lifecycle_tests.php
 *   BASE_URL=http://127.0.0.1:8090 php backend/tests/database/connection_lifecycle_tests.php
 * Exit codes: 0 all checks passed · 1 a check failed · 2 refused.
 */

if (PHP_SAPI !== 'cli') {
    exit(1);
}

$root = dirname(__DIR__, 3);
require $root . '/backend/src/bootstrap.php';

use MedAcademy\Database\Database;
use MedAcademy\Utils\Config;

Config::init();

if (Config::string('APP_ENV', 'production') === 'production') {
    fwrite(STDERR, "Refusing to run: APP_ENV=production. This suite changes a DB user quota.\n");
    exit(2);
}

$checks = [];
$check = static function (string $name, bool $ok, string $detail = '') use (&$checks): void {
    $checks[] = [$name, $ok, $detail];
    echo ($ok ? '  ok   ' : '  FAIL ') . $name . ($ok || $detail === '' ? '' : ' — ' . $detail) . "\n";
};
$skipped = 0;
$skip = static function (string $name, string $why) use (&$skipped): void {
    $skipped++;
    echo "  SKIP {$name} — {$why}\n";
};

$db = Database::instance();

// ── C1: release closes, the next query reconnects ───────────────────────────
echo "\nC1 release() closes the slot and reconnects lazily\n";
$id1 = (int) $db->value('SELECT CONNECTION_ID()');
$heldBefore = $db->isConnected();
$db->release();
$closedAfter = !$db->isConnected();
$id2 = (int) $db->value('SELECT CONNECTION_ID()');
$check('a query holds a connection', $heldBefore);
$check('release() drops the handle', $closedAfter);
$check('the next query opens a NEW server connection', $id1 !== $id2, "id1={$id1} id2={$id2}");

// ── C2: release is a no-op inside a transaction ─────────────────────────────
echo "\nC2 release() never touches an open transaction\n";
$db->begin();
$txId = (int) $db->value('SELECT CONNECTION_ID()');
$db->release();
$stillOpen = $db->isConnected();
$sameConnection = (int) $db->value('SELECT CONNECTION_ID()') === $txId;
$db->rollback();
$check('still connected while a transaction is open', $stillOpen);
$check('the same connection is kept (no silent rollback)', $sameConnection);

// ── C3: quota detection is narrow ───────────────────────────────────────────
echo "\nC3 quota detection\n";
$quotaMessages = [
    "SQLSTATE[HY000] [1226] User 'x' has exceeded the 'max_user_connections' resource (current value: 50)",
    'SQLSTATE[HY000] [1203] User x already has more than max_user_connections active connections',
    'SQLSTATE[HY000] [1040] Too many connections',
];
foreach ($quotaMessages as $i => $m) {
    $check('quota error recognised (' . ($i + 1) . ')', Database::isConnectionQuotaError(new RuntimeException($m)));
}
foreach ([
    'SQLSTATE[HY000] [2002] Connection refused',
    'SQLSTATE[HY000] [1045] Access denied for user',
    'SQLSTATE[42S02] Base table or view not found',
] as $i => $m) {
    $check(
        'non-quota failure NOT reported as capacity (' . ($i + 1) . ')',
        !Database::isConnectionQuotaError(new RuntimeException($m))
    );
}

// ── C4: end to end 503 + database_busy + Retry-After ────────────────────────
echo "\nC4 saturated quota → 503 database_busy with Retry-After\n";
$baseUrl = rtrim((string) (getenv('BASE_URL') ?: 'http://127.0.0.1:8090'), '/');
// A public, DATABASE-BACKED route, so the connection failure reaches the client
// instead of being caught and reported as a healthy 200. The value is a path
// RELATIVE to BASE_URL: the local PHP dev server serves the routes unprefixed
// (`/support/contact`), while the live host is mounted under `/api` — set
// CONN_TEST_PATH=/api/support/contact when checking that deployment.
$dbBackedPath = (string) (getenv('CONN_TEST_PATH') ?: '/support/contact');
$quota = 2;
$canSetQuota = true;
$why = '';

try {
    // CURRENT_USER() avoids quoting a name/host pair from the environment.
    $db->query("ALTER USER CURRENT_USER() WITH MAX_USER_CONNECTIONS {$quota}");
} catch (Throwable $e) {
    $canSetQuota = false;
    $why = 'cannot set a user quota (needs UPDATE on mysql.*): ' . substr($e->getMessage(), 0, 80);
}

if (!$canSetQuota) {
    $skip('C4', $why);
} else {
    $squatters = [];
    try {
        // Hold the allowance from THIS process. Racing parallel HTTP requests
        // would only *usually* overlap and could pass by luck; occupying the
        // slots makes the exhaustion certain before the API is called at all.
        $dsn = sprintf(
            'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
            Config::string('DB_HOST', 'localhost'),
            Config::int('DB_PORT', 3306),
            Config::string('DB_NAME')
        );
        $options = [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION, \PDO::ATTR_TIMEOUT => 5];
        $user = Config::string('DB_USER');
        $pass = Config::string('DB_PASS');

        $db->release();   // hand back this process's own slot first
        for ($i = 0; $i < $quota; $i++) {
            $squatters[] = new \PDO($dsn, $user, $pass, $options);
        }

        // Prove the exhaustion is real BEFORE reading anything into the API's
        // answer: the next connection from here must be refused as a quota error.
        $saturated = false;
        $quotaError = false;
        try {
            $overflow = new \PDO($dsn, $user, $pass, $options);
            unset($overflow);
        } catch (\PDOException $e) {
            $saturated = true;
            $quotaError = Database::isConnectionQuotaError($e);
        }
        $check('the account allowance is genuinely saturated', $saturated, 'an extra connection was accepted');
        $check('the refusal really is the quota error (1226/1203/1040)', $quotaError);

        $results = [];
        $mh = curl_multi_init();
        $handles = [];
        for ($i = 0; $i < 6; $i++) {
            $ch = curl_init($baseUrl . $dbBackedPath);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HEADER => true,
                CURLOPT_TIMEOUT => 15,
                CURLOPT_FORBID_REUSE => true,
            ]);
            curl_multi_add_handle($mh, $ch);
            $handles[] = $ch;
        }
        do {
            $status = curl_multi_exec($mh, $running);
            if ($running) {
                curl_multi_select($mh, 0.2);
            }
        } while ($running && $status === CURLM_OK);

        foreach ($handles as $ch) {
            $raw = (string) curl_multi_getcontent($ch);
            $results[] = $raw;
            curl_multi_remove_handle($mh, $ch);
            curl_close($ch);
        }
        curl_multi_close($mh);

        $statuses = [];
        $busy = 0;
        $retryAfter = 0;
        foreach ($results as $raw) {
            if ($raw === '') {
                $statuses['no-response'] = ($statuses['no-response'] ?? 0) + 1;
                continue;
            }
            [$head, $body] = array_pad(explode("\r\n\r\n", $raw, 2), 2, '');
            preg_match('/HTTP\/\d\.\d (\d{3})/', $head, $m);
            $code = $m[1] ?? '000';
            $statuses[$code] = ($statuses[$code] ?? 0) + 1;
            if ($code === '503' && str_contains($body, 'database_busy') && str_contains($head, 'Retry-After')) {
                $busy++;
                preg_match('/Retry-After:\s*(\d+)/i', $head, $mm);
                $retryAfter = max($retryAfter, (int) ($mm[1] ?? 0));
            }
        }

        $check(
            'every request got a definitive HTTP status while saturated',
            $statuses !== [] && !isset($statuses['no-response']),
            json_encode($statuses)
        );
        $check(
            'quota exhaustion produced the distinct 503 database_busy + Retry-After',
            $busy > 0,
            'statuses=' . json_encode($statuses)
        );
        $check(
            'each of the ' . count($handles) . ' requests was refused — none slipped through',
            $busy === count($handles),
            'busy=' . $busy . ' statuses=' . json_encode($statuses)
        );
        $check(
            'every saturated request failed honestly (no 200 was faked)',
            !array_key_exists('200', $statuses) || $busy > 0,
            'statuses=' . json_encode($statuses)
        );
        $check(
            'Retry-After is a short, non-amplifying delay',
            $busy === 0 || ($retryAfter >= 1 && $retryAfter <= 10),
            'retry-after=' . $retryAfter
        );
    } finally {
        $squatters = [];   // dropping the handles releases the slots again
        try {
            $db->query('ALTER USER CURRENT_USER() WITH MAX_USER_CONNECTIONS 0');
            $restored = true;
        } catch (Throwable $e) {
            $restored = false;
            fwrite(STDERR, "!! could not restore MAX_USER_CONNECTIONS 0: " . $e->getMessage() . "\n");
        }
        $check('the account quota was restored to unlimited', $restored);
    }
}

$failed = array_filter($checks, static fn (array $c): bool => !$c[1]);
$passed = count($checks) - count($failed);
echo "\n{$passed} passed; {$skipped} skipped; " . count($failed) . " failed\n";
if ($failed !== []) {
    foreach ($failed as $f) {
        echo ' - ' . $f[0] . "\n";
    }
    exit(1);
}
echo 'ALL CONNECTION-LIFECYCLE CHECKS PASSED'
    . ($skipped > 0 ? " ({$skipped} skipped — see the SKIP lines above)" : '')
    . "\n";
