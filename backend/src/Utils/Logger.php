<?php

declare(strict_types=1);

namespace MedAcademy\Utils;

/**
 * Secure structured logger. Writes newline-delimited JSON to
 * storage/logs/app.log. Never logs raw passwords, tokens, or secrets —
 * values whose keys look sensitive are redacted automatically.
 */
final class Logger
{
    private const LEVELS = ['debug' => 10, 'info' => 20, 'warning' => 30, 'error' => 40];

    private static ?Logger $instance = null;

    private string $dir;
    private string $level;
    private string $requestId;

    public static function instance(): Logger
    {
        if (self::$instance === null) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct()
    {
        $this->dir = Config::string('LOG_DIR', 'storage/logs');
        if (!is_dir($this->dir)) {
            @mkdir($this->dir, 0775, true);
        }
        $this->level = strtolower(Config::string('LOG_LEVEL', 'info'));
        $this->requestId = bin2hex(random_bytes(8));
    }

    public function requestId(): string
    {
        return $this->requestId;
    }

    public function debug(string $message, array $context = []): void
    {
        $this->log('debug', $message, $context);
    }

    public function info(string $message, array $context = []): void
    {
        $this->log('info', $message, $context);
    }

    public function warning(string $message, array $context = []): void
    {
        $this->log('warning', $message, $context);
    }

    public function error(string $message, array $context = []): void
    {
        $this->log('error', $message, $context);
    }

    public function log(string $level, string $message, array $context = []): void
    {
        $threshold = self::LEVELS[$this->level] ?? 20;
        if ((self::LEVELS[$level] ?? 20) < $threshold) {
            return;
        }
        $entry = [
            'ts' => gmdate('Y-m-d\TH:i:s\Z'),
            'level' => $level,
            'request_id' => $this->requestId,
            'message' => $message,
            'context' => self::redact($context),
        ];
        $line = json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $file = rtrim($this->dir, '/\\') . '/app.log';
        @file_put_contents($file, $line . "\n", FILE_APPEND | LOCK_EX);
    }

    /**
     * Redact anything that looks like a credential before it reaches disk.
     */
    public static function redact(mixed $value): mixed
    {
        if (is_array($value)) {
            $out = [];
            foreach ($value as $k => $v) {
                $key = strtolower((string) $k);
                if (preg_match('/(pass|secret|token|key|authorization|cookie|credential)/i', $key)) {
                    $out[$k] = '***REDACTED***';
                } else {
                    $out[$k] = self::redact($v);
                }
            }
            return $out;
        }
        if (is_string($value)) {
            if (preg_match('/Bearer\s+\S+/i', $value)) {
                return '***REDACTED***';
            }
        }
        return $value;
    }
}
