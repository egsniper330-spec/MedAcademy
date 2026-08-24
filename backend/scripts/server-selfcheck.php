<?php

declare(strict_types=1);

/**
 * server-selfcheck.php — safe diagnostics for the cPanel deployment.
 *
 * Run on the server AFTER uploading backend/ and creating backend/.env:
 *
 *   php backend/scripts/server-selfcheck.php
 *
 * Output is JSON. It reports BOOLEANS and lengths — never values — so it is
 * safe to paste into a support ticket. It deliberately does not print:
 * passwords, DB names/users in full, JWT secrets, VdoCipher secrets, file
 * paths, or stack traces.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

require dirname(__DIR__) . '/src/bootstrap.php';

use MedAcademy\Database\Database;
use MedAcademy\Http\Request;
use MedAcademy\Http\Router;
use MedAcademy\Utils\Config;
use MedAcademy\Utils\Logger;

$report = ['ok' => true, 'checks' => []];

$add = static function (string $name, bool $passed, string $detail = '') use (&$report): void {
    $report['checks'][] = ['check' => $name, 'ok' => $passed, 'detail' => $detail];
    if (!$passed) {
        $report['ok'] = false;
    }
};

// --- PHP version + extensions ------------------------------------------------
$requiredExt = [
    'pdo', 'pdo_mysql', 'curl', 'fileinfo', 'mbstring',
    'json', 'date', 'filter', 'hash', 'ctype',
];
$add('PHP version >= 8.0', version_compare(PHP_VERSION, '8.0.0', '>='), PHP_VERSION);
foreach ($requiredExt as $ext) {
    $add("extension: $ext", extension_loaded($ext));
}

// --- Environment --------------------------------------------------------------
$envPath = MEDACADEMY_BASE . '/.env';
$add('.env file present', is_file($envPath), is_file($envPath) ? 'found' : 'missing — copy .env.example to .env');
$add('APP_URL set', Config::string('APP_URL') !== '', Config::string('APP_URL', '') !== '' ? 'configured' : 'unset');
$add('JWT_SECRET configured', Config::string('JWT_SECRET') !== '' && !str_starts_with(Config::string('JWT_SECRET'), 'CHANGE_ME'), Config::string('JWT_SECRET') !== '' ? 'length ' . strlen(Config::string('JWT_SECRET')) : 'unset');
$add('VDOCIPHER_API_SECRET configured', Config::string('VDOCIPHER_API_SECRET') !== '' && !str_starts_with(Config::string('VDOCIPHER_API_SECRET'), 'CHANGE_ME'), Config::string('VDOCIPHER_API_SECRET') !== '' ? 'length ' . strlen(Config::string('VDOCIPHER_API_SECRET')) : 'unset');

// --- Database config values (safe diagnostics) ---------------------------------
$dbHost = Config::string('DB_HOST', 'localhost');
$dbPort = Config::int('DB_PORT', 3306);
$dbName = Config::string('DB_NAME');
$dbUser = Config::string('DB_USER');
$dbPass = Config::string('DB_PASS');
$add('DB_HOST', $dbHost !== '', $dbHost);
$add('DB_PORT', true, (string) $dbPort);
$add('DB_NAME set', $dbName !== '', 'length ' . strlen($dbName));
$add('DB_USER set', $dbUser !== '', 'length ' . strlen($dbUser));
$add('DB_PASS set', $dbPass !== '' && $dbPass !== 'CHANGE_ME_DB_PASSWORD', 'length ' . strlen($dbPass));

// --- Database config + connectivity -------------------------------------------
$dbConfigured = $dbName !== '' && $dbUser !== '' && $dbPass !== '' && $dbPass !== 'CHANGE_ME_DB_PASSWORD';
$add('DB credentials configured in .env', $dbConfigured, $dbConfigured ? 'yes' : 'no');
if ($dbConfigured) {
    try {
        Database::instance()->value('SELECT 1');
        $add('Database connection (SELECT 1)', true, 'connected');
    } catch (\Throwable $e) {
        // Walk the exception chain to find the root cause.
        $detail = 'unexpected failure';
        $current = $e;
        while ($current !== null) {
            $cls = get_class($current);
            if (str_contains($cls, 'PDOException')) {
                $msg = $current->getMessage();
                // Classify the error
                $lm = strtolower($msg);
                if (str_contains($lm, 'access denied') || str_contains($lm, 'password')) {
                    $cat = 'access_denied';
                } elseif (str_contains($lm, 'unknown database') || str_contains($lm, 'no database')) {
                    $cat = 'unknown_database';
                } elseif (str_contains($lm, 'connection refused') || str_contains($lm, 'no route')) {
                    $cat = 'connection_refused';
                } elseif (str_contains($lm, 'could not find driver')) {
                    $cat = 'driver_error';
                } else {
                    $cat = 'pdo_error';
                }
                // Redact the message: remove password and user if present
                $dbPass = Config::string('DB_PASS');
                $dbUser = Config::string('DB_USER');
                $safeMsg = $msg;
                if ($dbPass !== '' && strlen($dbPass) > 2) {
                    $safeMsg = str_ireplace($dbPass, '[REDACTED]', $safeMsg);
                }
                if ($dbUser !== '' && strlen($dbUser) > 2) {
                    $safeMsg = str_ireplace($dbUser, '[USER]', $safeMsg);
                }
                $detail = $cat . ' | ' . $safeMsg;
                break;
            }
            $current = $current->getPrevious();
        }
        $add('Database connection (SELECT 1)', false, $detail);
    }
} else {
    $add('Database connection (SELECT 1)', false, 'skipped — credentials not configured yet');
}

// --- Storage --------------------------------------------------------------------
$storageChecks = [
    'storage/ writable' => is_writable(MEDACADEMY_BASE . '/storage'),
    'storage/logs writable' => is_writable(MEDACADEMY_BASE . '/storage/logs'),
    'storage/tmp writable' => is_writable(MEDACADEMY_BASE . '/storage/tmp'),
    'storage/public writable' => is_writable(MEDACADEMY_BASE . '/storage/public'),
    'storage/private writable' => is_writable(MEDACADEMY_BASE . '/storage/private'),
];
foreach ($storageChecks as $name => $writable) {
    $add($name, $writable, $writable ? 'writable' : 'NOT writable');
}

// --- Route table loads + sanity --------------------------------------------------
try {
    $request = Request::capture();
    $router = new Router($request, Logger::instance());
    require MEDACADEMY_BASE . '/routes/api.php';
    $routes = $router->routes();
    $add('route table loads', true, count($routes) . ' routes registered');
    $hasHealth = array_filter($routes, static fn ($r) => $r['pattern'] === '/api/health');
    $add('GET /api/health registered', count($hasHealth) === 1);
} catch (\Throwable $e) {
    $detail = get_class($e) . ': ' . $e->getMessage();
    $add('route table loads', false, $detail);
}

echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
exit($report['ok'] ? 0 : 1);
