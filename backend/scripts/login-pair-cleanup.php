<?php

declare(strict_types=1);

// CLI-ONLY GUARD — same guard as the sibling scripts.
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

/**
 * login-pair-cleanup.php — removes expired login cooldown state.
 *
 * Cron schedule (suggested): every 30 minutes
 *   */30 * * * * /usr/local/bin/php /path/to/backend/scripts/login-pair-cleanup.php
 *
 * Rows are removed once their last failure is older than the 24 h decay window
 * (they would be reset on next use anyway). Deletes run in bounded batches so a
 * large backlog never holds a long table lock. Safe to run at any frequency.
 */

require dirname(__DIR__) . '/src/bootstrap.php';

use MedAcademy\Services\LoginPairThrottleService;

$service = new LoginPairThrottleService();
$total = 0;
// Bounded: at most 20 batches per run; the next cron run continues any backlog.
for ($i = 0; $i < 20; $i++) {
    $deleted = $service->purgeExpired(5000);
    $total += $deleted;
    if ($deleted < 5000) {
        break;
    }
}

echo 'login_pair_state: removed ' . $total . " expired row(s)\n";
