<?php

declare(strict_types=1);

namespace MedAcademy\Http;

/**
 * A route points at a controller method that the loaded class does not
 * implement.
 *
 * ─── WHY THIS EXISTS: the silently-500ing partial deploy ────────────────────
 *
 * Router resolves `[Controller::class, 'method']` handlers to a closure that
 * instantiates the controller and calls the method. Until now a *missing*
 * method was not checked, so PHP raised
 *
 *   Error: Call to undefined method Controller::method()
 *
 * which is NOT an ApiException. ErrorHandler's non-ApiException branch returns
 * a deliberately opaque `internal_error` 500 with APP_DEBUG=false, so the only
 * observable symptom is a route that answers 500 while every sibling route on
 * the same controller answers 200.
 *
 * That is exactly the signature of a PARTIAL FILE UPLOAD: a newer
 * `routes/api.php` (which registers the route) deployed alongside an older
 * controller file (which never defined the method). The route exists, so it no
 * longer 404s; the handler cannot be called, so it 500s — and nothing in the
 * response says why. Diagnosing it required probing production by hand.
 *
 * The class is deliberately a `final class ... extends ApiException` so it
 * travels the normal error pipeline and, unlike a raw fatal, is logged AND
 * reported with a machine-readable code + the offending handler:
 *
 *   HTTP 500
 *   { "error": { "code": "handler_unavailable",
 *                "handler": "MedAcademy\\Controllers\\SecurityController::policies" } }
 *
 * This does NOT hide the failure and does NOT weaken any policy: the request is
 * still refused with 500, the file is still broken, and the fix is still to
 * deploy a consistent backend. It only makes the deployment fault self-
 * identifying instead of anonymous. Use `server-selfcheck.php` or
 * tests/routeHandlerIntegrity.test.cjs to catch it before deploying.
 */
final class HandlerUnavailableException extends ApiException
{
    public function __construct(
        public readonly string $handler,
        ?string $class = null,
        ?string $method = null
    ) {
        $detail = $class !== null && $method !== null
            ? sprintf('The route handler %s::%s is not available on this deployment.', $class, $method)
            : sprintf('The route handler %s is not available on this deployment.', $handler);

        parent::__construct(500, $detail, 'handler_unavailable');
    }
}
