<?php

declare(strict_types=1);

/**
 * issue-tokens.php — mint ONE access token per load-test student, for local or
 * staging runs.
 *
 * WHY NOT JUST LOG IN 200 TIMES
 * ─────────────────────────────
 * `POST /auth/login` is rate limited per IP (`RATE_LIMIT_LOGIN_PER_MINUTE`,
 * 10 in the shipped `.env.example`). A 200-VU run from one generator IP would
 * spend most of its time being throttled, and the results would describe the
 * limiter instead of the API. It would also share ONE session unless the login
 * happened per VU — the mistake that made the old "10 VUs" test 10 requests from
 * a single device.
 *
 * This script uses the SAME session machinery the login endpoint uses
 * (`SessionManager::issue`) to create one real, independently revocable session
 * per seeded account, and writes the access tokens to a file that
 * `SESSION_MODE=pool` reads. Tokens therefore behave exactly like logged-in
 * ones: same JWT claims (sub/role/sv/device_id), same `security_version` check,
 * same revocation paths.
 *
 * SAFETY
 *   • CLI only.
 *   • Refuses to run when APP_ENV=production: fixtures and pre-issued tokens must
 *     never come from, or be minted for, the live database.
 *   • Tokens are written to the file (mode 0600) and NOT printed — a token on
 *     stdout ends up in shell history and CI logs.
 *   • Only accounts whose email starts with `loadtest.` are considered; this
 *     cannot mint a token for a real user.
 *
 * USAGE
 *   php scripts/loadtest/issue-tokens.php --students=200 --ttl=7200
 *   # writes scripts/loadtest/.tokens.json  (git-ignored)
 *
 *   export LOADTEST_TOKEN_POOL_FILE=scripts/loadtest/.tokens.json
 *
 * Tokens are short-lived by design (JWT_ACCESS_TTL_SECONDS, default 900 s).
 * `--ttl` sets a longer lifetime for the run; pass a value comfortably longer
 * than the planned test (the default here is 2 h).
 */

require dirname(__DIR__, 2) . '/backend/src/bootstrap.php';

use MedAcademy\Auth\SessionManager;
use MedAcademy\Database\Database;
use MedAcademy\Utils\Config;

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "CLI only.\n");
    exit(1);
}

if (Config::string('APP_ENV', 'production') === 'production') {
    fwrite(STDERR, "Refusing to mint load-test tokens: APP_ENV=production.\n");
    exit(2);
}

$options = getopt('', ['students::', 'ttl::', 'out::', 'help']);
if (isset($options['help'])) {
    fwrite(STDOUT, "Usage: php scripts/loadtest/issue-tokens.php [--students=N] [--ttl=7200] [--out=path]\n");
    fwrite(STDOUT, "Mints one access token per loadtest.* student account. Writes JSON, never prints tokens.\n");
    exit(0);
}

$limit = max(1, min(500, (int) ($options['students'] ?? 200)));
$ttl = max(300, min(86400, (int) ($options['ttl'] ?? 7200)));
$out = (string) ($options['out'] ?? __DIR__ . '/.tokens.json');

// The TTL has to apply to the tokens minted HERE, not to whatever the server's
// default is; Config caches values, so reset it before setting this one.
putenv('JWT_ACCESS_TTL_SECONDS=' . $ttl);
if (array_key_exists('JWT_ACCESS_TTL_SECONDS', $_ENV)) {
    $_ENV['JWT_ACCESS_TTL_SECONDS'] = (string) $ttl;
}
Config::init();

$db = Database::instance();
// Only fixture accounts: a real user must never receive a load-test session.
$rows = $db->select(
    "SELECT p.id, p.email, p.role, p.status, p.security_version
       FROM profiles p
      WHERE p.email LIKE 'loadtest.%@example.invalid'
        AND p.status = 'active'
      ORDER BY p.email
      LIMIT {$limit}"
);

if ($rows === []) {
    fwrite(STDERR, "No loadtest.* accounts found. Run: php scripts/loadtest/seed-local.php --students={$limit}\n");
    exit(3);
}

$sessions = new SessionManager();
$tokens = [];
foreach ($rows as $row) {
    $issued = $sessions->issue(
        (string) $row['id'],
        (string) $row['role'],
        (int) $row['security_version'],
        // No device binding: the load generator is not a registered device, and
        // the auth middleware only records device_id for later revocation.
        null
    );
    $tokens[] = (string) $issued['access_token'];
}

$payload = [
    'generated_at' => gmdate('Y-m-d\TH:i:s\Z'),
    'ttl_seconds' => $ttl,
    'expires_at' => gmdate('Y-m-d\TH:i:s\Z', time() + $ttl),
    'count' => count($tokens),
    // The tokens ARE the credential: the file is written 0600 and is git-ignored.
    'tokens' => $tokens,
];

$dir = dirname($out);
if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
    fwrite(STDERR, "Cannot create {$dir}\n");
    exit(4);
}

$json = json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
if ($json === false || @file_put_contents($out, $json . "\n") === false) {
    fwrite(STDERR, "Cannot write {$out}\n");
    exit(4);
}
@chmod($out, 0600);

fwrite(STDOUT, 'Minted ' . count($tokens) . " sessions for loadtest.* accounts.\n");
fwrite(STDOUT, '  file    : ' . $out . " (mode 0600, git-ignored)\n");
fwrite(STDOUT, '  valid   : ' . $ttl . "s (until " . $payload['expires_at'] . ")\n");
fwrite(STDOUT, '  next    : export LOADTEST_TOKEN_POOL_FILE=' . $out . "\n");
fwrite(STDOUT, "Tokens are NOT printed to stdout on purpose.\n");
