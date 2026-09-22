<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Database\Database;
use MedAcademy\Utils\Config;

/**
 * System Diagnostics — safe infrastructure health checks for Super Admin.
 *
 * SECURITY CONTRACT (hard requirements):
 *  • NO secret value is EVER included in a result. Only boolean/presence
 *    metadata ("configured": true) crosses the API boundary.
 *  • Every exception is passed through sanitizeError(), which strips anything
 *    that could carry credentials (DSNs, connection strings, URLs with query
 *    strings, "password", "secret", "token", "Authorization", raw SQL, paths).
 *  • Each check is individually time-boxed; one failing dependency never
 *    prevents the others from being checked.
 *
 * Result shape (one entry per service):
 * {
 *   id, name, category, status, message, errorCode, httpStatus, latencyMs,
 *   lastChecked, checks: { configuration, connectivity, authentication, api },
 *   recommendedAction
 * }
 * Status is a controlled enum — raw exception strings never become a status.
 */
final class SystemDiagnosticsService
{
    private const STATUS_HEALTHY              = 'healthy';
    private const STATUS_WARNING              = 'warning';
    private const STATUS_MISCONFIGURED        = 'misconfigured';
    private const STATUS_AUTH_FAILED          = 'authentication_failed';
    private const STATUS_TIMEOUT              = 'timeout';
    private const STATUS_UNAVAILABLE          = 'unavailable';
    private const STATUS_UNKNOWN              = 'unknown';

    private const ERROR_CONFIG      = 'CONFIGURATION_ERROR';
    private const ERROR_AUTH        = 'AUTHENTICATION_ERROR';
    private const ERROR_DB          = 'DATABASE_CONNECTION_ERROR';
    private const ERROR_DNS         = 'DNS_ERROR';
    private const ERROR_NETWORK     = 'NETWORK_ERROR';
    private const ERROR_TIMEOUT     = 'TIMEOUT';
    private const ERROR_HTTP_4XX    = 'HTTP_4XX';
    private const ERROR_HTTP_5XX    = 'HTTP_5XX';
    private const ERROR_RESPONSE    = 'INVALID_RESPONSE';
    private const ERROR_PERMISSION  = 'PERMISSION_ERROR';
    private const ERROR_UNKNOWN     = 'UNKNOWN_ERROR';

    /** Default per-check time budget (seconds). */
    private const CHECK_TIMEOUT = 8;

    /** @var array<int,array<string,mixed>> collected results, one per service */
    private array $results = [];

    /**
     * Run every registered diagnostic. Failures are isolated per service.
     * @return array{id: string, generatedAt: string, results: array, summary: array<string,int>}
     */
    public function scanAll(): array
    {
        $this->results = [];
        foreach ([
            'checkDatabase'      => ['database',   'Database',            'Infrastructure'],
            'checkVdoCipher'     => ['vdocipher',  'VdoCipher',           'Video / DRM'],
            'checkSmtp'          => ['smtp_email', 'Email (SMTP)',        'Notifications'],
            'checkStorage'       => ['storage',    'File Storage',        'Infrastructure'],
            'checkJwt'           => ['jwt_auth',   'Auth / JWT',          'Security'],
            'checkAppUpdateCfg'  => ['app_update', 'App Update Policy',   'Platform'],
            'checkPhpRuntime'    => ['php_api',    'API Runtime',         'Infrastructure'],
        ] as $method => [$id, $name, $category]) {
            try {
                $this->results[] = $this->{$method}();
            } catch (\Throwable $e) {
                // Absolute isolation: a throwing checker still yields a result row.
                $this->results[] = $this->result($id, $name, $category, self::STATUS_UNKNOWN, [
                    'message'            => 'Diagnostic check failed.',
                    'errorCode'          => self::ERROR_UNKNOWN,
                    'recommendedAction'  => 'Review server logs for the diagnostics task.',
                    'exceptionDetail'    => $this->sanitizeError($e),
                ]);
            }
        }

        return [
            'id'          => 'system-diagnostics',
            'generatedAt' => gmdate('Y-m-d\TH:i:s\Z'),
            'results'     => $this->results,
            'summary'     => $this->summarize($this->results),
        ];
    }

    /**
     * Re-run a single service check by id (individual refresh).
     */
    public function checkOne(string $id): array
    {
        foreach ($this->scanAll()['results'] as $r) {
            if (($r['id'] ?? '') === $id) {
                return $r;
            }
        }
        return $this->result($id, 'Unknown service', 'Unknown', self::STATUS_UNKNOWN, [
            'message'   => 'Unknown service id.',
            'errorCode' => self::ERROR_UNKNOWN,
        ]);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Individual checks
    // ─────────────────────────────────────────────────────────────────────────

    private function checkDatabase(): array
    {
        $configured = Config::string('DB_NAME') !== '' && Config::string('DB_USER') !== '';
        $started = microtime(true);
        if (!$configured) {
            return $this->result('database', 'Database', 'Infrastructure', self::STATUS_MISCONFIGURED, [
                'checks'   => ['configuration' => 'failed', 'connectivity' => 'not tested', 'api' => 'not tested'],
                'message'  => 'Database configuration is incomplete on the server.',
                'errorCode' => self::ERROR_CONFIG,
                'recommendedAction' => 'Set DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASS in the server environment.',
            ]);
        }
        try {
            $version = Database::instance()->value('SELECT VERSION()');
            $latency = $this->latencyMs($started);
            return $this->result('database', 'Database', 'Infrastructure', self::STATUS_HEALTHY, [
                'checks'   => ['configuration' => 'passed', 'connectivity' => 'passed', 'query' => 'passed'],
                'message'  => 'Connection and test query succeeded.',
                'latencyMs' => $latency,
                'meta'     => ['engine_version' => is_string($version) ? $version : ''],
            ]);
        } catch (\Throwable $e) {
            $detail = $this->sanitizeError($e);
            $isTimeout = stripos($detail, 'timed out') !== false || stripos($detail, 'timeout') !== false;
            $isDns = stripos($detail, 'getaddrinfo') !== false
                || stripos($detail, 'name or service not known') !== false
                || stripos($detail, 'nodename') !== false;
            return $this->result('database', 'Database', 'Infrastructure', $isTimeout ? self::STATUS_TIMEOUT : self::STATUS_UNAVAILABLE, [
                'checks'   => ['configuration' => 'passed', 'connectivity' => 'failed', 'query' => 'not tested'],
                'message'  => $isDns ? 'Database host could not be resolved.' : 'Database connection or test query failed.',
                'errorCode' => $isDns ? self::ERROR_DNS : self::ERROR_DB,
                'latencyMs' => $this->latencyMs($started),
                'recommendedAction' => 'Verify the database service is running and reachable from the API server.',
                'exceptionDetail' => $detail,
            ]);
        }
    }

    private function checkVdoCipher(): array
    {
        $apiSecret = Config::string('VDOCIPHER_API_SECRET');
        $apiBase   = rtrim(Config::string('VDOCIPHER_API_BASE', 'https://dev.vdocipher.com/api'), '/');
        $configured = $apiSecret !== '' && $apiSecret !== 'CHANGE_ME';

        if (!$configured) {
            return $this->result('vdocipher', 'VdoCipher', 'Video / DRM', self::STATUS_MISCONFIGURED, [
                'checks'   => ['configuration' => 'failed', 'connectivity' => 'not tested', 'authentication' => 'not tested', 'api' => 'not tested'],
                'message'  => 'VdoCipher credentials are not configured on the server.',
                'errorCode' => self::ERROR_CONFIG,
                'recommendedAction' => 'Set VDOCIPHER_API_SECRET in the server environment. The value itself is never exposed here.',
            ]);
        }

        $started = microtime(true);
        // Safe authenticated probe: list videos with pageSize=1. Proves DNS,
        // TLS, connectivity, authentication AND response shape in one call.
        [$status, $body, $curlErr, $curlErrNo] = $this->http($apiBase . '/videos?pageSize=1', [
            'Authorization: Apisecret ' . $apiSecret,
            'Accept: application/json',
        ]);
        $latency = $this->latencyMs($started);

        if ($curlErr !== '' || $body === null) {
            return $this->result('vdocipher', 'VdoCipher', 'Video / DRM', $this->networkStatus($curlErrNo), [
                'checks'   => ['configuration' => 'passed', 'connectivity' => 'failed', 'authentication' => 'not tested', 'api' => 'not tested'],
                'message'  => $this->networkMessage($curlErrNo, 'VdoCipher API could not be reached.'),
                'errorCode' => $this->networkErrorCode($curlErrNo),
                'latencyMs' => $latency,
                'recommendedAction' => 'Verify outbound HTTPS connectivity from the API server to the VdoCipher endpoint.',
                'exceptionDetail' => $this->redact($curlErr),
            ]);
        }

        if ($status === 401 || $status === 403) {
            return $this->result('vdocipher', 'VdoCipher', 'Video / DRM', self::STATUS_AUTH_FAILED, [
                'checks'   => ['configuration' => 'passed', 'connectivity' => 'passed', 'authentication' => 'failed', 'api' => 'not tested'],
                'message'  => 'VdoCipher authentication failed. The configured secret was rejected.',
                'errorCode' => self::ERROR_AUTH,
                'httpStatus' => $status,
                'latencyMs' => $latency,
                'recommendedAction' => 'Verify the VdoCipher API secret configured on the server.',
            ]);
        }

        if ($status >= 500) {
            return $this->result('vdocipher', 'VdoCipher', 'Video / DRM', self::STATUS_UNAVAILABLE, [
                'checks'   => ['configuration' => 'passed', 'connectivity' => 'passed', 'authentication' => 'passed', 'api' => 'failed'],
                'message'  => 'VdoCipher API returned a server error.',
                'errorCode' => self::ERROR_HTTP_5XX,
                'httpStatus' => $status,
                'latencyMs' => $latency,
                'recommendedAction' => 'Retry later; if persistent, contact VdoCipher support.',
            ]);
        }

        if ($status >= 400) {
            return $this->result('vdocipher', 'VdoCipher', 'Video / DRM', self::STATUS_WARNING, [
                'checks'   => ['configuration' => 'passed', 'connectivity' => 'passed', 'authentication' => 'passed', 'api' => 'failed'],
                'message'  => 'VdoCipher API rejected the diagnostic request.',
                'errorCode' => self::ERROR_HTTP_4XX,
                'httpStatus' => $status,
                'latencyMs' => $latency,
                'recommendedAction' => 'Verify the VdoCipher account permissions for API access.',
            ]);
        }

        $decoded = json_decode($body, true);
        if (!is_array($decoded) || !array_key_exists('videos', $decoded)) {
            return $this->result('vdocipher', 'VdoCipher', 'Video / DRM', self::STATUS_WARNING, [
                'checks'   => ['configuration' => 'passed', 'connectivity' => 'passed', 'authentication' => 'passed', 'api' => 'failed'],
                'message'  => 'VdoCipher responded with an unexpected payload shape.',
                'errorCode' => self::ERROR_RESPONSE,
                'httpStatus' => $status,
                'latencyMs' => $latency,
                'recommendedAction' => 'Confirm the VdoCipher API contract has not changed.',
            ]);
        }

        return $this->result('vdocipher', 'VdoCipher', 'Video / DRM', self::STATUS_HEALTHY, [
            'checks'   => ['configuration' => 'passed', 'connectivity' => 'passed', 'authentication' => 'passed', 'api' => 'passed'],
            'message'  => 'Credentials present; authenticated API call succeeded.',
            'httpStatus' => $status,
            'latencyMs' => $latency,
        ]);
    }

    private function checkSmtp(): array
    {
        $host = Config::string('SMTP_HOST');
        $configured = $host !== '';

        if (!$configured) {
            return $this->result('smtp_email', 'Email (SMTP)', 'Notifications', self::STATUS_MISCONFIGURED, [
                'checks'   => ['configuration' => 'failed', 'connectivity' => 'not tested', 'authentication' => 'not tested'],
                'message'  => 'SMTP is not configured. Email features (verification, password reset) will not send.',
                'errorCode' => self::ERROR_CONFIG,
                'recommendedAction' => 'Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_SECURE on the server if email delivery is required.',
            ]);
        }

        $port   = Config::int('SMTP_PORT', 587);
        $user   = Config::string('SMTP_USER');
        $secure = Config::string('SMTP_SECURE', 'tls');
        $started = microtime(true);

        // Transport-level probe ONLY — no email is sent. For STARTTLS we open
        // a plain socket and issue EHLO; for ssl:// we verify TLS + EHLO.
        $target = ($secure === 'ssl' ? 'ssl://' : '') . $host . ':' . $port;
        $sock = @stream_socket_client($target, $errno, $errstr, self::CHECK_TIMEOUT);
        if ($sock === false) {
            return $this->result('smtp_email', 'Email (SMTP)', 'Notifications', $this->networkStatus($errno), [
                'checks'   => ['configuration' => 'passed', 'connectivity' => 'failed', 'authentication' => 'not tested'],
                'message'  => $this->networkMessage($errno, 'SMTP server could not be reached.'),
                'errorCode' => $this->networkErrorCode($errno),
                'latencyMs' => $this->latencyMs($started),
                'recommendedAction' => 'Verify SMTP host/port and outbound connectivity from the API server.',
                'exceptionDetail' => $this->redact($errstr),
            ]);
        }
        stream_set_timeout($sock, self::CHECK_TIMEOUT);
        $greeting = fgets($sock, 515);
        $ehloOk = false;
        if (is_string($greeting) && str_starts_with($greeting, '220')) {
            fwrite($sock, "EHLO medacademy\r\n");
            $resp = '';
            while (($line = fgets($sock, 515)) !== false) {
                $resp .= $line;
                if (isset($line[3]) && $line[3] === ' ') break;
            }
            $ehloOk = str_starts_with($resp, '250');
        }
        fclose($sock);

        if (!$ehloOk) {
            return $this->result('smtp_email', 'Email (SMTP)', 'Notifications', self::STATUS_UNAVAILABLE, [
                'checks'   => ['configuration' => 'passed', 'connectivity' => 'passed', 'authentication' => 'not tested'],
                'message'  => 'SMTP server connected but did not complete the protocol handshake.',
                'errorCode' => self::ERROR_NETWORK,
                'latencyMs' => $this->latencyMs($started),
                'recommendedAction' => 'Verify SMTP_SECURE matches the provider requirement (tls vs ssl).',
            ]);
        }

        // Credentials present → report "configured" WITHOUT attempting a real
        // AUTH transaction (that path is exercised on every real email send).
        return $this->result('smtp_email', 'Email (SMTP)', 'Notifications', $user !== '' ? self::STATUS_HEALTHY : self::STATUS_WARNING, [
            'checks'   => ['configuration' => 'passed', 'connectivity' => 'passed', 'authentication' => $user !== '' ? 'configured' : 'not configured'],
            'message'  => $user !== ''
                ? 'SMTP reachable; handshake succeeded; credentials are configured.'
                : 'SMTP reachable but no credentials configured — authenticated sending will fail.',
            'latencyMs' => $this->latencyMs($started),
            'recommendedAction' => $user !== '' ? null : 'Set SMTP_USER/SMTP_PASS on the server.',
        ]);
    }

    private function checkStorage(): array
    {
        $publicDir  = MEDACADEMY_BASE . '/' . Config::string('STORAGE_PUBLIC_DIR', 'storage/public');
        $privateDir = MEDACADEMY_BASE . '/' . Config::string('STORAGE_PRIVATE_DIR', 'storage/private');
        $signedSecretConfigured = Config::string('STORAGE_SIGNED_URL_SECRET', Config::string('JWT_SECRET')) !== '';

        $dirsOk = true;
        $detail = [];
        foreach (['public' => $publicDir, 'private' => $privateDir] as $label => $dir) {
            if (!is_dir($dir)) {
                $dirsOk = false;
                $detail[] = $label . ' directory missing';
                continue;
            }
            // Safe write/read/delete probe of a uniquely-named temp object.
            $probe = $dir . '/.diag-' . bin2hex(random_bytes(6)) . '.tmp';
            $wrote = @file_put_contents($probe, 'diag');
            if ($wrote === false) {
                $dirsOk = false;
                $detail[] = $label . ' not writable';
            } else {
                $read = @file_get_contents($probe) === 'diag';
                @unlink($probe);
                if (!$read) {
                    $dirsOk = false;
                    $detail[] = $label . ' read-back failed';
                }
                if (file_exists($probe)) {
                    $detail[] = $label . ' cleanup failed';
                }
            }
        }

        if (!$dirsOk) {
            return $this->result('storage', 'File Storage', 'Infrastructure', self::STATUS_UNAVAILABLE, [
                'checks'   => ['configuration' => 'passed', 'connectivity' => 'n/a', 'api' => 'failed'],
                'message'  => 'Local storage failed the write/read/cleanup probe.',
                'errorCode' => self::ERROR_PERMISSION,
                'recommendedAction' => 'Fix directory permissions for the storage folders on the API server.',
                'exceptionDetail' => implode('; ', $detail),
            ]);
        }

        return $this->result('storage', 'File Storage', 'Infrastructure', self::STATUS_HEALTHY, [
            'checks'   => ['configuration' => 'passed', 'connectivity' => 'n/a', 'api' => 'passed'],
            'message'  => 'Public and private storage are writable; signed-URL secret is '
                . ($signedSecretConfigured ? 'configured.' : 'MISSING — signed URLs will fail.'),
            'recommendedAction' => $signedSecretConfigured ? null : 'Set STORAGE_SIGNED_URL_SECRET on the server.',
        ]);
    }

    private function checkJwt(): array
    {
        $secret = Config::string('JWT_SECRET');
        $ttl    = Config::int('JWT_ACCESS_TTL_SECONDS', 0);
        if ($secret === '' || strlen($secret) < 16) {
            return $this->result('jwt_auth', 'Auth / JWT', 'Security', self::STATUS_MISCONFIGURED, [
                'checks'   => ['configuration' => 'failed'],
                'message'  => 'JWT signing secret is missing or too short.',
                'errorCode' => self::ERROR_CONFIG,
                'recommendedAction' => 'Set a strong JWT_SECRET on the server. The value is never exposed.',
            ]);
        }
        return $this->result('jwt_auth', 'Auth / JWT', 'Security', self::STATUS_HEALTHY, [
            'checks'   => ['configuration' => 'passed'],
            'message'  => 'Signing secret present; access TTL is ' . ($ttl > 0 ? ($ttl . 's') : 'default') . '.',
        ]);
    }

    private function checkAppUpdateCfg(): array
    {
        try {
            $db = Database::instance();
            $rows = $db->select(
                "SELECT `key`, `value` FROM `system_config` WHERE `key` IN ('update_android_config','update_ios_config')"
            );
            $found = count($rows);
            $msg = $found > 0
                ? 'Update policy rows present in system_config.'
                : 'No update policy rows found — enforcement falls back to disabled (clients allowed).';
            return $this->result('app_update', 'App Update Policy', 'Platform', $found > 0 ? self::STATUS_HEALTHY : self::STATUS_WARNING, [
                'checks'   => ['configuration' => $found > 0 ? 'passed' : 'warning', 'query' => 'passed'],
                'message'  => $msg,
                'recommendedAction' => $found > 0 ? null : 'Configure app update policy from the App Updates screen.',
            ]);
        } catch (\Throwable $e) {
            return $this->result('app_update', 'App Update Policy', 'Platform', self::STATUS_UNAVAILABLE, [
                'checks'   => ['configuration' => 'not tested', 'query' => 'failed'],
                'message'  => 'Could not read the update policy table.',
                'errorCode' => self::ERROR_DB,
                'exceptionDetail' => $this->sanitizeError($e),
            ]);
        }
    }

    private function checkPhpRuntime(): array
    {
        $started = microtime(true);
        $writable = is_writable(MEDACADEMY_BASE . '/storage');
        $logDir  = Config::string('LOG_DIR', '');
        $logOk   = $logDir === '' ? true : is_dir(MEDACADEMY_BASE . '/' . $logDir);
        return $this->result('php_api', 'API Runtime', 'Infrastructure', self::STATUS_HEALTHY, [
            'checks'   => ['configuration' => 'passed', 'connectivity' => 'n/a', 'api' => 'passed'],
            'message'  => 'PHP ' . PHP_VERSION . '; storage ' . ($writable ? 'writable' : 'NOT writable')
                . '; log directory ' . ($logOk ? 'present' : 'missing') . '.',
            'latencyMs' => $this->latencyMs($started),
            'meta'     => ['php_version' => PHP_VERSION, 'storage_writable' => $writable],
        ]);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Shared plumbing
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Bounded HTTP GET. Returns [status, body, curlErr, curlErrNo].
     * Never includes the request headers in any error output.
     * @return array{0:int,1:?string,2:string,3:int}
     */
    private function http(string $url, array $headers): array
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => self::CHECK_TIMEOUT,
            CURLOPT_CONNECTTIMEOUT => self::CHECK_TIMEOUT,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_FOLLOWLOCATION => false,
        ]);
        $raw = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err    = curl_error($ch);
        $errno  = (int) curl_errno($ch);
        curl_close($ch);
        // Redact any URL that may have crept into an error string.
        return [$status, is_string($raw) ? $raw : null, $this->redact($err), $errno];
    }

    private function networkStatus(int $errno): string
    {
        if ($errno === CURLE_OPERATION_TIMEDOUT) return self::STATUS_TIMEOUT;
        if ($errno === CURLE_COULDNT_RESOLVE_HOST || $errno === CURLE_COULDNT_RESOLVE_PROXY) return self::STATUS_UNAVAILABLE;
        if ($errno === CURLE_SSL_CONNECT_ERROR || $errno === CURLE_SSL_PEER_CERTIFICATE || $errno === CURLE_SSL_CACERT) return self::STATUS_UNAVAILABLE;
        if ($errno === CURLE_COULDNT_CONNECT) return self::STATUS_UNAVAILABLE;
        return self::STATUS_UNKNOWN;
    }

    private function networkErrorCode(int $errno): string
    {
        if ($errno === CURLE_OPERATION_TIMEDOUT) return self::ERROR_TIMEOUT;
        if ($errno === CURLE_COULDNT_RESOLVE_HOST || $errno === CURLE_COULDNT_RESOLVE_PROXY) return self::ERROR_DNS;
        return self::ERROR_NETWORK;
    }

    private function networkMessage(int $errno, string $fallback): string
    {
        if ($errno === CURLE_OPERATION_TIMEDOUT) return $fallback . ' (timed out).';
        if ($errno === CURLE_COULDNT_RESOLVE_HOST) return $fallback . ' (DNS resolution failed).';
        return $fallback;
    }

    /**
     * @param array<string,mixed> $extra
     * @return array<string,mixed>
     */
    private function result(
        string $id,
        string $name,
        string $category,
        string $status,
        array $extra = []
    ): array {
        return array_merge([
            'id'          => $id,
            'name'        => $name,
            'category'    => $category,
            'status'      => $status,
            'message'     => '',
            'latencyMs'   => null,
            'httpStatus'  => null,
            'lastChecked' => gmdate('Y-m-d\TH:i:s\Z'),
            'checks'      => [],
            'recommendedAction' => null,
        ], $extra);
    }

    private function summarize(array $results): array
    {
        $counts = [
            'healthy' => 0, 'warning' => 0, 'unavailable' => 0,
            'misconfigured' => 0, 'authentication_failed' => 0,
            'timeout' => 0, 'unknown' => 0,
        ];
        foreach ($results as $r) {
            $s = $r['status'] ?? self::STATUS_UNKNOWN;
            $counts[$s] = ($counts[$s] ?? 0) + 1;
        }
        return $counts;
    }

    private function latencyMs(float $started): int
    {
        return (int) round((microtime(true) - $started) * 1000);
    }

    /**
     * Redact credential-ish content from free-form error strings.
     * Deliberately paranoid: anything that LOOKS like a secret is dropped.
     */
    private function redact(?string $text): string
    {
        if ($text === null || $text === '') return '';
        $patterns = [
            '/Apisecret\s+\S+/i'        => 'Apisecret [redacted]',
            '/Bearer\s+\S+/i'           => 'Bearer [redacted]',
            '/(api[_-]?key|secret|token|password|passwd|pwd|authorization)\s*[:=]\s*\S+/i' => '$1=[redacted]',
            '/#?[A-Za-z][A-Za-z0-9+.\-]*:\/\/[^\s]*:[^\s@]*@[^\s]+/i' => '[url-with-credentials redacted]',
            '/\b(?:[0-9a-f]{32,}|sk_live_[A-Za-z0-9]+|rk_live_[A-Za-z0-9]+)\b/i' => '[redacted]',
        ];
        return preg_replace(array_keys($patterns), array_values($patterns), $text) ?? '[unavailable]';
    }

    /**
     * Full sanitizer for exception text: redaction + drop of SQL fragments,
     * stack paths and anything after the first "SQLSTATE" marker.
     */
    private function sanitizeError(\Throwable $e): string
    {
        $msg = $e->getMessage();
        // Strip SQL fragments entirely — they can carry column names and values.
        if (stripos($msg, 'SQLSTATE') !== false) {
            $msg = (string) preg_replace('/SQLSTATE\[?\w*\]?.*$/s', 'database error', $msg);
        }
        $msg = (string) preg_replace('/\/[A-Za-z0-9_\-\.\/]+\.php/', '[path]', $msg);
        return $this->redact(mb_substr($msg, 0, 200));
    }
}

if (!defined('CURLE_OPERATION_TIMEDOUT')) define('CURLE_OPERATION_TIMEDOUT', 28);
if (!defined('CURLE_COULDNT_RESOLVE_HOST')) define('CURLE_COULDNT_RESOLVE_HOST', 6);
if (!defined('CURLE_COULDNT_RESOLVE_PROXY')) define('CURLE_COULDNT_RESOLVE_PROXY', 5);
if (!defined('CURLE_COULDNT_CONNECT')) define('CURLE_COULDNT_CONNECT', 7);
if (!defined('CURLE_SSL_CONNECT_ERROR')) define('CURLE_SSL_CONNECT_ERROR', 35);
if (!defined('CURLE_SSL_PEER_CERTIFICATE')) define('CURLE_SSL_PEER_CERTIFICATE', 60);
if (!defined('CURLE_SSL_CACERT')) define('CURLE_SSL_CACERT', 60);
