<?php

declare(strict_types=1);

namespace MedAcademy\Middleware;

use MedAcademy\Http\ApiException;
use MedAcademy\Http\Request;
use MedAcademy\Http\Response;
use MedAcademy\Utils\Config;
use MedAcademy\Utils\Logger;
use Throwable;

final class ErrorHandler
{
    public static function register(Logger $logger): void
    {
        set_exception_handler(static function (Throwable $e) use ($logger): void {
            self::render($e, $logger);
        });
        set_error_handler(static function (int $severity, string $message, string $file, int $line) use ($logger): bool {
            if (!(error_reporting() & $severity)) {
                return false; // respect @ suppression
            }
            $logger->error('PHP error', [
                'severity' => $severity,
                'message' => $message,
                'file' => $file,
                'line' => $line,
            ]);
            return true;
        });
    }

    public static function render(Throwable $e, Logger $logger, ?Request $request = null): never
    {
        if ($e instanceof ApiException) {
            if ($e->getPrevious()) {
                $logger->error($e->getMessage(), [
                    'status' => $e->status,
                    'previous' => $e->getPrevious()->getMessage(),
                ]);
            }
            Response::error($e->getMessage(), $e->status, 'api_error', $e->errors);
        }

        $logger->error('Unhandled exception', [
            'class' => get_class($e),
            'message' => $e->getMessage(),
            'file' => $e->getFile(),
            'line' => $e->getLine(),
            'trace' => self::shortTrace($e),
        ]);

        if (Config::isProduction()) {
            Response::error('Internal server error', 500, 'internal_error');
        }
        Response::error($e->getMessage(), 500, 'internal_error');
    }

    private static function shortTrace(Throwable $e): array
    {
        $out = [];
        foreach (array_slice($e->getTrace(), 0, 8) as $frame) {
            $out[] = ($frame['file'] ?? '?') . ':' . ($frame['line'] ?? '?') . ' ' . ($frame['function'] ?? '?');
        }
        return $out;
    }
}
