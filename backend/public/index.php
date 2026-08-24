<?php
/**
 * MedAcademy PHP API — front controller.
 *
 * All requests are rewritten here by public/.htaccess. Bootstrap order:
 *   1. autoloader (PSR-4: MedAcademy\ -> ../src)
 *   2. environment (.env)
 *   3. error handler (JSON errors, secrets redacted in logs)
 *   4. CORS (configurable origin allow-list, OPTIONS short-circuit)
 *   5. router -> controller dispatch
 *
 * No secrets are ever hard-coded in this file or in the repo.
 */

declare(strict_types=1);

require dirname(__DIR__) . '/src/bootstrap.php';

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
$logger = \MedAcademy\Utils\Logger::instance();
\MedAcademy\Middleware\ErrorHandler::register($logger);

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
(new \MedAcademy\Middleware\CorsMiddleware())->handle();

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------
$request = \MedAcademy\Http\Request::capture();

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
$router = new \MedAcademy\Http\Router($request, $logger);
require MEDACADEMY_BASE . '/routes/api.php';

try {
    $router->dispatch();
} catch (\Throwable $e) {
    \MedAcademy\Middleware\ErrorHandler::render($e, $logger, $request);
}
