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
// Maintenance gate (server-authoritative)
// ---------------------------------------------------------------------------
// When a Super Admin enables Maintenance Mode, every non-exempt request
// receives HTTP 503 maintenance_mode BEFORE routing. Exemptions are
// server-authorized (public auth/health prefixes, the status endpoint, the
// SA's own management routes, and the verified super_admin/whitelist role).
(new \MedAcademy\Middleware\MaintenanceMiddleware())->handle($request);

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
