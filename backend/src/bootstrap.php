<?php

declare(strict_types=1);

/**
 * Shared bootstrap: autoloader + environment + config.
 * Safe to include from CLI scripts (importers, cron). Web requests use
 * public/index.php, which additionally registers error handling, CORS and
 * the router.
 */

if (!defined('MEDACADEMY_BASE')) {
    define('MEDACADEMY_BASE', dirname(__DIR__));
}

spl_autoload_register(static function (string $class): void {
    $prefix = 'MedAcademy\\';
    if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
        return;
    }
    $relative = substr($class, strlen($prefix));
    $file = MEDACADEMY_BASE . '/src/' . str_replace('\\', '/', $relative) . '.php';
    if (is_file($file)) {
        require $file;
    }
});

\MedAcademy\Utils\Env::load(MEDACADEMY_BASE . '/.env');
\MedAcademy\Utils\Config::init();

if (PHP_SAPI === 'cli') {
    date_default_timezone_set('UTC');
}
