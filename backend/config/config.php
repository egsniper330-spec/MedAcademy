<?php

declare(strict_types=1);

/**
 * Shared bootstrap for CLI scripts (cron jobs, importers).
 * Web requests bootstrap through public/index.php instead.
 */

define('MEDACADEMY_BASE', dirname(__DIR__));

date_default_timezone_set('UTC');
error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('log_errors', '1');
ini_set('memory_limit', '512M');
set_time_limit(0);
