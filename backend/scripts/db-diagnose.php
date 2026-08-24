<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

require dirname(__DIR__) . '/src/bootstrap.php';

use MedAcademy\Utils\Config;

/**
 * Redact a string so credentials are never exposed.
 * Keeps first 2 and last 2 chars if long enough, masks the rest.
 */
function redact(string $value, int $minShow = 4): string
{
    $len = strlen($value);
    if ($len <= $minShow) {
        return str_repeat('*', $len);
    }
    return substr($value, 0, 2) . str_repeat('*', $len - 4) . substr($value, -2);
}

function classifyPdoError(string $msg): string
{
    $m = strtolower($msg);
    if (str_contains($m, 'access denied') || str_contains($m, 'password')) {
        return 'access_denied';
    }
    if (str_contains($m, 'unknown database') || str_contains($m, 'no database selected')) {
        return 'unknown_database';
    }
    if (str_contains($m, 'connection refused') || str_contains($m, 'no route to host')) {
        return 'connection_refused';
    }
    if (str_contains($m, 'connection timed out') || str_contains($m, 'timed out')) {
        return 'timeout';
    }
    if (str_contains($m, 'could not find driver')) {
        return 'driver_error';
    }
    if (str_contains($m, 'no such file or directory') || str_contains($m, 'connect')) {
        return 'connection_refused';
    }
    return 'pdo_error';
}

$report = [];

// --- Step 1: Read config values (redacted) ---
$host = Config::string('DB_HOST', 'localhost');
$port = Config::int('DB_PORT', 3306);
$name = Config::string('DB_NAME');
$user = Config::string('DB_USER');
$pass = Config::string('DB_PASS');

$report['config'] = [
    'DB_HOST' => $host,
    'DB_PORT' => $port,
    'DB_NAME_length' => strlen($name),
    'DB_NAME_empty' => $name === '',
    'DB_USER_length' => strlen($user),
    'DB_USER_empty' => $user === '',
    'DB_PASS_length' => strlen($pass),
    'DB_PASS_empty' => $pass === '',
    'DB_PASS_is_placeholder' => $pass === 'CHANGE_ME_DB_PASSWORD',
];

// --- Step 2: Show DSN (without password) ---
$dsn = "mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4";
$report['dsn_preview'] = $dsn;

// --- Step 3: Try raw PDO connection (bypass Database singleton) ---
$report['connection'] = ['ok' => false];

try {
    $pdo = new PDO($dsn, $user, $pass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => true,
        PDO::ATTR_TIMEOUT => 10,
        PDO::MYSQL_ATTR_INIT_COMMAND => 'SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci',
    ]);
    $report['connection'] = ['ok' => true, 'detail' => 'connected'];

    // Test actual query
    $stmt = $pdo->query('SELECT 1 AS val');
    $row = $stmt->fetch();
    $report['query'] = ['ok' => true, 'result' => $row['val'] ?? null];

    // Show server info (safe)
    $report['server'] = [
        'version' => $pdo->getAttribute(PDO::ATTR_SERVER_VERSION),
        'client_version' => $pdo->getAttribute(PDO::ATTR_CLIENT_VERSION),
    ];
} catch (PDOException $e) {
    $msg = $e->getMessage();
    $category = classifyPdoError($msg);

    // Redact the message: replace any password-like substrings
    $safeMsg = $msg;
    if ($pass !== '' && strlen($pass) > 2) {
        $safeMsg = str_ireplace($pass, '[REDACTED]', $safeMsg);
    }
    if ($user !== '' && strlen($user) > 2) {
        $safeMsg = str_ireplace($user, '[USER_REDACTED]', $safeMsg);
    }

    $report['connection'] = [
        'ok' => false,
        'category' => $category,
        'sqlstate' => $e->getCode(),
        'message' => $safeMsg,
    ];
} catch (Throwable $e) {
    $report['connection'] = [
        'ok' => false,
        'category' => 'non_pdo_exception',
        'exception_class' => get_class($e),
        'message' => $e->getMessage(),
    ];
}

// --- Step 4: Show phpinfo-style DB info ---
$report['php_info'] = [
    'pdo_drivers' => PDO::getAvailableDrivers(),
    'php_version' => PHP_VERSION,
];

echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
exit($report['connection']['ok'] ? 0 : 1);
