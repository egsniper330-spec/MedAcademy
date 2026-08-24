<?php

declare(strict_types=1);

namespace MedAcademy\Http;

use MedAcademy\Middleware\AuthMiddleware;
use MedAcademy\Utils\Logger;

/**
 * Minimal router:
 *   $router->post('/auth/login', [AuthController::class, 'login']);
 *   $router->get('/courses/{id}', [CourseController::class, 'show'], ['auth' => true]);
 *   $router->get('/admin/users', [AdminController::class, 'users'], ['auth' => true, 'role' => ['admin', 'super_admin']]);
 *
 * Middleware options:
 *   auth   => require a valid access token (AuthMiddleware)
 *   role   => require one of these roles (after auth)
 *   permission => require an assistant_permissions key (after auth)
 */
final class Router
{
    /** @var array<int,array{method:string,pattern:string,handler:callable,options:array}> */
    private array $routes = [];

    public function __construct(
        private readonly Request $request,
        private readonly Logger $logger
    ) {
    }

    public function get(string $pattern, callable|array $handler, array $options = []): void
    {
        $this->add('GET', $pattern, $handler, $options);
    }

    public function post(string $pattern, callable|array $handler, array $options = []): void
    {
        $this->add('POST', $pattern, $handler, $options);
    }

    public function put(string $pattern, callable|array $handler, array $options = []): void
    {
        $this->add('PUT', $pattern, $handler, $options);
    }

    public function patch(string $pattern, callable|array $handler, array $options = []): void
    {
        $this->add('PATCH', $pattern, $handler, $options);
    }

    public function delete(string $pattern, callable|array $handler, array $options = []): void
    {
        $this->add('DELETE', $pattern, $handler, $options);
    }

    /**
     * Register a route. Accepts a callable or [ControllerClass::class, 'method'] array.
     * Arrays are resolved to real callables (closure that instantiates the controller)
     * at registration time, so the stored handler is always a proper callable.
     */
    public function add(string $method, string $pattern, callable|array $handler, array $options = []): void
    {
        if (is_array($handler)) {
            [$class, $methodName] = $handler;
            $handler = static function (Request $request) use ($class, $methodName): mixed {
                $controller = new $class();
                return $controller->$methodName($request);
            };
        }

        $this->routes[] = [
            'method' => strtoupper($method),
            'pattern' => $pattern,
            'handler' => $handler,
            'options' => $options,
        ];
    }

    /**
     * Registered routes (used by server-selfcheck.php diagnostics).
     *
     * @return array<int,array{method:string,pattern:string,options:array}>
     */
    public function routes(): array
    {
        return array_map(static fn (array $r) => [
            'method' => $r['method'],
            'pattern' => $r['pattern'],
            'options' => $r['options'],
        ], $this->routes);
    }

    public function dispatch(): never
    {
        $path = $this->request->path();
        $method = $this->request->method();

        foreach ($this->routes as $route) {
            if ($route['method'] !== $method) {
                continue;
            }
            $params = $this->match($route['pattern'], $path);
            if ($params === null) {
                continue;
            }
            $this->request->params = $params;

            // Middleware
            $options = $route['options'];
            if (!empty($options['auth'])) {
                (new AuthMiddleware())->handle($this->request, $options);
            }

            $handler = $route['handler'];
            $result = $handler($this->request);
            if (is_array($result)) {
                Response::json($result);
            }
            // non-array handlers are expected to respond themselves
            Response::error('No response', 500);
        }

        Response::error('Route not found: ' . $method . ' ' . $path, 404, 'not_found');
    }

    /**
     * @return array<string,string>|null route params, or null if no match
     */
    private function match(string $pattern, string $path): ?array
    {
        $regex = preg_replace_callback(
            '/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/',
            static fn (array $m) => '(?P<' . $m[1] . '>[^/]+)',
            $pattern
        );
        if ($regex === null) {
            return null;
        }
        if (!preg_match('~^' . $regex . '$~', $path, $m)) {
            return null;
        }
        $params = [];
        foreach ($m as $k => $v) {
            if (!is_int($k)) {
                $params[$k] = $v;
            }
        }
        return $params;
    }
}
