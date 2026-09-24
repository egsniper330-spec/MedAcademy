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
            $meta = Config::isDebug() ? self::debugMeta($e) : [];
            // App update enforcement (HTTP 426): enrich the error body with the
            // platform's update payload so the client can render the forced-
            // update screen directly from the rejected response —
            // { error: { code: UPDATE_REQUIRED, latestVersion, latestVersionCode,
            //            minimumVersionCode, updateUrl, updateMode } }.
            $code = 'api_error';
            if ($e->status === 426 && $request !== null) {
                $code = 'UPDATE_REQUIRED';
                try {
                    $svc = new \MedAcademy\Services\AppUpdateService();
                    $vc = $request->header('x-app-version-code');
                    $verdict = $svc->evaluate(
                        $request->header('x-app-platform'),
                        $vc !== null ? (int) $vc : null
                    );
                    if ($verdict !== null) {
                        unset($verdict['message'], $verdict['code']);
                        $meta = array_merge($meta, $verdict);
                    }
                } catch (\Throwable) {
                    // never let meta construction mask the 426 itself
                }
            }
            // Feature flags (HTTP 403 from FeatureFlagService::assertEnabled):
            // the refusal carries its own code + the flag key so the client can
            // treat "this capability is switched off" as a distinct state
            // (never confused with a permission error or a maintenance window).
            if ($e instanceof \MedAcademy\Http\FeatureDisabledException) {
                $code = 'feature_disabled';
                $meta = array_merge($meta, ['feature' => $e->feature]);
            }
            // Route handler mismatch (HTTP 500, thrown by the Router's dispatch
            // guard): the route resolves but the loaded controller does not
            // implement its method. This is the signature of a PARTIAL DEPLOY
            // (newer routes/api.php + older controller file) and used to be
            // rendered as an anonymous internal_error. Naming the handler makes
            // the deployment fault diagnosable from the response alone; it is
            // still a hard 500 and no policy is bypassed.
            if ($e instanceof \MedAcademy\Http\HandlerUnavailableException) {
                $code = 'handler_unavailable';
                $meta = array_merge($meta, ['handler' => $e->handler]);
            }

            Response::error($e->getMessage(), $e->status, $code, $e->errors, $meta);
        }

        $logger->error('Unhandled exception', [
            'class' => get_class($e),
            'message' => $e->getMessage(),
            'file' => $e->getFile(),
            'line' => $e->getLine(),
            'trace' => self::shortTrace($e),
        ]);

        if (Config::isDebug()) {
            Response::error($e->getMessage(), 500, 'internal_error', [], self::debugMeta($e));
        }
        Response::error('Internal server error', 500, 'internal_error');
    }

    /**
     * Debug-only exception metadata. NEVER surfaced when APP_DEBUG=false.
     * Only non-secret fields are included: class name, file path, line number.
     */
    private static function debugMeta(Throwable $e): array
    {
        return [
            'exception' => get_class($e),
            'file' => $e->getFile(),
            'line' => $e->getLine(),
        ];
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
