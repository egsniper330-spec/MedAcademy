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
 */
final class Database
{
    private static ?Database $instance = null;
    private ?PDO $pdo = null;

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
            throw new ApiException(500, 'Database connection failed', [], $e);
        }
        return $this->pdo;
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
