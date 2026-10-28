<?php

declare(strict_types=1);

namespace MedAcademy\Database;

use MedAcademy\Http\ApiException;
use MedAcademy\Utils\Config;
use PDO;
use PDOException;
use PDOStatement;

/**
     * PDO MySQL connection. Lazily connects on first use. All queries go through
     * prepared statements. Passwords are read from the environment only.
     *
     * ── ONE CONNECTION PER REQUEST, AND HOW LONG IT IS HELD ──────────────────
     * There is exactly ONE place in the application that creates a connection:
     * `pdo()` below. `instance()` is a request-scoped singleton, the connection
     * is created lazily on the first query and `PDO::ATTR_PERSISTENT` is NOT set,
     * so a request never opens a second connection and never inherits one.
     *
     * The shared host caps the ACCOUNT with `max_user_connections` (50 on
     * Spaceship), which limits SIMULTANEOUS connections, i.e. how many requests
     * may be inside the database at once. By Little's law the demand is
     * `requests per second × connection hold time`, so what matters for capacity
     * is not how many connections exist but HOW LONG each one is held. The
     * connection used to live until the script ended, which means it was still
     * held while the request did slow NON-database work — rendering a
     * personalized PDF, hashing an uploaded document, reading a whole file into
     * memory to stream it. At 150-200 concurrent requests that produced exactly
     * the observed `SQLSTATE[HY000] [1226] … exceeded the 'max_user_connections'`
     * failures. `release()` exists so those phases can hand the slot back; the
     * next query transparently reconnects (still once per request).
     */
final class Database
{
    private static ?Database $instance = null;
    private ?PDO $pdo = null;

    /**
     * `Retry-After` (seconds) advertised with a 503 when the account's connection
     * quota is exhausted. Deliberately short: the condition clears as in-flight
     * requests finish, and a long value would keep the client away longer than
     * the underlying contention lasts.
     */
    public const BUSY_RETRY_AFTER_SECONDS = 2;

    public static function instance(): Database
    {
        return self::$instance ??= new self();
    }

    private function pdo(): PDO
    {
        if ($this->pdo !== null) {
            return $this->pdo;
        }
        $host = Config::string('DB_HOST', 'localhost');
        $port = Config::int('DB_PORT', 3306);
        $name = Config::string('DB_NAME');
        $user = Config::string('DB_USER');
        $pass = Config::string('DB_PASS');

        if ($name === '' || $user === '' || $pass === '' || $pass === 'CHANGE_ME_DB_PASSWORD') {
            throw new ApiException(500, 'Database is not configured');
        }

        $dsn = "mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4";
        try {
            $this->pdo = new PDO($dsn, $user, $pass, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => true,
                PDO::ATTR_TIMEOUT => 10,
                PDO::MYSQL_ATTR_INIT_COMMAND => "SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci",
            ]);
        } catch (PDOException $e) {
            // Quota exhaustion is NOT an outage: the server is healthy, this
            // account simply has all of its allowed connections busy. Reporting
            // it as a generic 500 made a capacity signal look like a defect and
            // gave the client nothing to act on. It stays an ERROR (never a
            // silent success), it is logged with its real SQLSTATE, and it now
            // carries a distinct code plus `Retry-After` so a client can back
            // off instead of hammering. No retry is attempted here on purpose:
            // retrying inside the request would amplify load on a server that is
            // already saturated.
            if (self::isConnectionQuotaError($e)) {
                throw new ApiException(
                    503,
                    'The service is temporarily at capacity. Please try again shortly.',
                    ['database_busy'],
                    $e
                );
            }
            throw new ApiException(500, 'Database connection failed', [], $e);
        }

        $this->pinSessionTimeZone($this->pdo);
        return $this->pdo;
    }

    /**
     * True when the driver refused the connection because a connection LIMIT was
     * reached rather than because the database is unreachable or broken.
     *
     *   • 1226 ER_USER_LIMIT_REACHED  — this DB user's `max_user_connections`
     *   • 1203 ER_TOO_MANY_USER_CONNECTIONS
     *   • 1040 ER_CON_COUNT_ERROR     — the server-wide `max_connections`
     *
     * Matched on the driver's own message: PDO exposes the MySQL errno only in
     * the message string for a connect-time failure (there is no errorInfo on a
     * failed constructor), and the code is stable across MySQL and MariaDB.
     */
    public static function isConnectionQuotaError(\Throwable $e): bool
    {
        $message = $e->getMessage();
        foreach (['1226', '1203', '1040'] as $errno) {
            if (str_contains($message, '[HY000] [' . $errno . ']')) {
                return true;
            }
        }
        return str_contains($message, 'max_user_connections')
            || str_contains($message, 'Too many connections');
    }

    /**
     * Hand the connection slot back early, without ending the request.
     *
     * Call this immediately before a phase that does NOT touch the database but
     * can take a long time — a PDF render, a document hash, streaming a file to
     * a slow client. The object stays usable: the next `query()` opens a fresh
     * connection lazily, so callers need no changes beyond the call itself.
     *
     * Refuses to act while a transaction is open: dropping the handle there
     * would silently roll the work back. In that case the connection is kept and
     * released normally when the script ends.
     */
    public function release(): void
    {
        if ($this->pdo === null) {
            return;
        }
        try {
            if ($this->pdo->inTransaction()) {
                return;
            }
        } catch (\Throwable) {
            // Cannot determine transaction state: keep the connection rather
            // than risk discarding an open unit of work.
            return;
        }
        $this->pdo = null;
    }

    /**
     * Whether a connection is currently held (diagnostics/tests only).
     */
    public function isConnected(): bool
    {
        return $this->pdo !== null;
    }

    /**
     * Pin the MySQL SESSION time zone to UTC.
     *
     * WHY: a DATETIME column stores whatever wall-clock the session writes, and
     * the schema defaults ~100 timestamp columns to `CURRENT_TIMESTAMP` — which
     * follows the SESSION zone, not UTC. On a host whose MySQL default zone is
     * not UTC, those defaults wrote local time (e.g. Africa/Cairo) into columns
     * the rest of the code writes AND reads as UTC (`UTC_TIMESTAMP(6)`). One
     * column then held two different clocks: a device row inserted by the login
     * path could read as "3 hours ago" one minute after it was created, while a
     * row updated by an explicit UTC write was correct.
     *
     * Pinning the zone makes `CURRENT_TIMESTAMP` and `UTC_TIMESTAMP` agree, so
     * every new row is UTC regardless of which write path touches it. It does
     * NOT rewrite stored values: existing DATETIME data is left exactly as it is
     * (a blind "shift every row" migration would corrupt the rows that were
     * already correct). Rows written before this fix may still carry local time;
     * the presence policy treats an implausibly-future timestamp as unknown and
     * the next heartbeat re-anchors it (see DeviceController).
     *
     * `SET time_zone = '+00:00'` works on servers without the named-zone tables;
     * the 'UTC' name is only a fallback. A host that forbids both is reported in
     * the error log rather than silently continuing with a mixed clock.
     */
    private function pinSessionTimeZone(PDO $pdo): void
    {
        foreach (["SET time_zone = '+00:00'", "SET time_zone = 'UTC'"] as $sql) {
            try {
                $pdo->exec($sql);
                return;
            } catch (\Throwable) {
                // try the next form
            }
        }
        error_log('[Database] could not pin session time_zone to UTC — timestamps may use the server zone');
    }

    public function query(string $sql, array $params = []): PDOStatement
    {
        $stmt = $this->pdo()->prepare($sql);
        $stmt->execute($params);
        return $stmt;
    }

    /**
     * @return array<int,array<string,mixed>>
     */
    public function select(string $sql, array $params = []): array
    {
        return $this->query($sql, $params)->fetchAll();
    }

    /**
     * @return array<string,mixed>|null
     */
    public function row(string $sql, array $params = []): ?array
    {
        $row = $this->query($sql, $params)->fetch();
        return $row === false ? null : $row;
    }

    public function value(string $sql, array $params = [], mixed $default = null): mixed
    {
        $v = $this->query($sql, $params)->fetchColumn();
        return $v === false ? $default : $v;
    }

    public function insert(string $sql, array $params = []): int
    {
        $this->query($sql, $params);
        return (int) $this->pdo()->lastInsertId();
    }

    public function transaction(callable $fn): mixed
    {
        $pdo = $this->pdo();
        $pdo->beginTransaction();
        try {
            $result = $fn($this);
            $pdo->commit();
            return $result;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    public function begin(): void
    {
        $this->pdo()->beginTransaction();
    }

    /**
     * Alias of begin() using PDO's method name. Controllers written against
     * the PDO API (e.g. RpcController) call beginTransaction()/commit()/
     * rollBack(); commit() and rollBack() resolve to the methods above (PHP
     * method names are case-insensitive), this completes the set.
     */
    public function beginTransaction(): void
    {
        $this->pdo()->beginTransaction();
    }

    public function commit(): void
    {
        $this->pdo()->commit();
    }

    public function rollback(): void
    {
        if ($this->pdo()->inTransaction()) {
            $this->pdo()->rollBack();
        }
    }
}
