<?php

declare(strict_types=1);

/**
 * worker_lock_tests.php — proves the cron worker cannot run twice at once.
 *
 * WHY
 *   The queue's atomic claim stops two workers OWNING the same row and the
 *   per-variant flock stops two renders of the same variant, but neither stops
 *   two worker PROCESSES from existing. On a one-minute cron a slow run overlaps
 *   the next tick, so two FPDI/TCPDF renders run concurrently on a shared
 *   account. `WorkerLock` closes that with an OS-level `flock`, and this suite
 *   checks it with REAL processes — an in-process test would prove nothing,
 *   because the thing under test is kernel-level contention.
 *
 *   W1  a fresh path acquires; the lock file exists and names this process
 *   W2  while another process holds it, acquire() returns false (no blocking)
 *   W3  the holder's identity is readable by the contender (diagnostics)
 *   W4  the OS releases the lock when the holder EXITS — no PID-file staleness
 *   W5  the OS releases the lock when the holder is KILLED (crash / fatal)
 *   W6  an uncreatable lock path THROWS: a worker that cannot prove it is alone
 *       must not run (never silently continue)
 *   W7  the real worker script, run while the lock is held, exits 0 printing
 *       `worker_locked` — it claims and modifies nothing (SKIP if it cannot even
 *       boot, e.g. no .env in this checkout)
 *   W8  the worker claims jobs ONE AT A TIME and registers a fatal-safe release,
 *       so a killed run cannot strand un-started jobs in `processing`
 *
 * SAFETY
 *   • No database writes, no network, no rendering.
 *   • Only touches a throwaway directory under the system temp dir.
 *   • Exit codes: 0 all passed · 1 a check failed · 2 refused / cannot run.
 *
 * USAGE
 *   php backend/tests/material-queue/worker_lock_tests.php
 */

if (PHP_SAPI !== 'cli') {
    exit(1);
}

$root = dirname(__DIR__, 3);
require $root . '/backend/src/Storage/StorageService.php';
require $root . '/backend/src/Services/WorkerLock.php';

use MedAcademy\Services\WorkerLock;

// ── Reporting ───────────────────────────────────────────────────────────────
$failures = [];
$skips = 0;
function check(string $name, bool $ok, string $detail = ''): void
{
    global $failures;
    if (!$ok) {
        $failures[] = $name . ($detail !== '' ? " ({$detail})" : '');
    }
    fwrite(STDOUT, ($ok ? 'PASS ' : 'FAIL ') . $name . ($detail !== '' ? "  [{$detail}]" : '') . "\n");
}

function skip(string $name, string $why): void
{
    global $skips;
    $skips++;
    fwrite(STDOUT, "SKIP {$name}  [{$why}]\n");
}

// ── Sandbox ─────────────────────────────────────────────────────────────────
$tmpRoot = sys_get_temp_dir() . '/medacademy-workerlock-' . getmypid() . '-' . bin2hex(random_bytes(4));
if (!mkdir($tmpRoot, 0775, true) && !is_dir($tmpRoot)) {
    fwrite(STDERR, "cannot create the test sandbox: {$tmpRoot}\n");
    exit(2);
}

/** Remaining processes we started, killed in the finally below. */
$children = [];

/**
 * Start a helper PHP process. The helper holds (or tries to hold) the lock.
 *
 * @return array{proc: resource, pipes: array<int, resource>, pid: int}
 */
function spawn_helper(string $script, array $args): array
{
    $cmd = escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($script);
    foreach ($args as $arg) {
        $cmd .= ' ' . escapeshellarg((string) $arg);
    }
    $descriptors = [1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    // bypass_shell: without it Windows wraps the command in cmd.exe, so the pid
    // we get is the shell's and killing it leaves PHP running (still holding the
    // lock) — which would make the crash-release check test the shell, not PHP.
    $proc = proc_open($cmd, $descriptors, $pipes, null, null, ['bypass_shell' => true]);
    if (!is_resource($proc)) {
        throw new RuntimeException('proc_open failed');
    }
    $status = proc_get_status($proc);
    return ['proc' => $proc, 'pipes' => $pipes, 'pid' => (int) ($status['pid'] ?? 0)];
}

/** Read the helper's single JSON line (it prints, then holds). */
function helper_result(array $child): array
{
    $line = fgets($child['pipes'][1]);
    if (!is_string($line) || trim($line) === '') {
        return [];
    }
    $decoded = json_decode(trim($line), true);
    return is_array($decoded) ? $decoded : [];
}

function helper_alive(array $child): bool
{
    $status = proc_get_status($child['proc']);
    return (bool) ($status['running'] ?? false);
}

function helper_wait(array $child, float $timeoutSeconds): void
{
    $deadline = microtime(true) + $timeoutSeconds;
    while (helper_alive($child) && microtime(true) < $deadline) {
        usleep(50000);
    }
}

function helper_close(array $child): void
{
    foreach ($child['pipes'] as $pipe) {
        if (is_resource($pipe)) {
            @fclose($pipe);
        }
    }
    if (is_resource($child['proc'])) {
        @proc_terminate($child['proc']);
        @proc_close($child['proc']);
    }
}

try {
    // The helper: require WorkerLock only (no bootstrap, no DB), acquire, print,
    // then optionally sleep while holding. `--busy` burns CPU so a kill/exit is
    // observed as a real process death rather than an early return.
    $helperPath = $tmpRoot . '/hold-lock.php';
    file_put_contents($helperPath, <<<'PHP'
        <?php
        declare(strict_types=1);
        require getenv('WL_ROOT') . '/backend/src/Storage/StorageService.php';
        require getenv('WL_ROOT') . '/backend/src/Services/WorkerLock.php';

        $path = (string) ($argv[1] ?? '');
        $hold = (float) ($argv[2] ?? 0.0);
        $lock = new \MedAcademy\Services\WorkerLock($path);
        try {
            $got = $lock->acquire();
        } catch (\Throwable $e) {
            echo json_encode(['acquired' => false, 'error' => $e->getMessage()]) . "\n";
            exit(0);
        }
        echo json_encode([
            'acquired' => $got,
            'pid' => getmypid(),
            'holder' => $got ? $lock->holder() : [],
        ]) . "\n";
        $end = microtime(true) + $hold;
        while (microtime(true) < $end) {
            usleep(20000);
        }
        $lock->release();
        exit(0);
        PHP
    );
    putenv('WL_ROOT=' . $root);

    // ── W1: a fresh path is acquirable, and the holder is identifiable ──────
    $lockPath = $tmpRoot . '/fresh.lock';
    $first = new WorkerLock($lockPath);
    check('W1 fresh lock path is acquired', $first->acquire() === true, $lockPath);
    check('W1 lock file exists on disk', is_file($lockPath));
    $holder = $first->holder();
    check('W1 holder() names this pid + host', (int) ($holder['pid'] ?? 0) === getmypid() && isset($holder['host']), json_encode($holder));
    $first->release();
    check('W1 release() gives the lock back (re-acquirable)', (new WorkerLock($lockPath))->acquire() === true);

    // ── W2/W3: a second PROCESS is refused, non-blocking, with diagnostics ──
    $contendedPath = $tmpRoot . '/contended.lock';
    $holder = spawn_helper($helperPath, [$contendedPath, 4]);
    $children[] = $holder;
    $held = helper_result($holder);
    check('W2 holder process acquired the lock', ($held['acquired'] ?? false) === true, json_encode($held));

    $startedAt = microtime(true);
    $contender = spawn_helper($helperPath, [$contendedPath, 0]);
    $children[] = $contender;
    $contended = helper_result($contender);
    $waited = microtime(true) - $startedAt;
    check('W2 second process is refused while the lock is held', ($contended['acquired'] ?? null) === false, json_encode($contended));
    check('W2 refusal is non-blocking (<1s, never waits for the holder)', $waited < 1.0, round($waited, 3) . 's');

    $seen = (new WorkerLock($contendedPath))->holder();
    check(
        'W3 contender can read the holder identity (pid/host)',
        (int) ($seen['pid'] ?? 0) === (int) ($held['pid'] ?? -1) && (string) ($seen['host'] ?? '') !== '',
        json_encode($seen)
    );
    helper_close($contender);

    // ── W4: a normal EXIT releases the lock (no stale PID file) ─────────────
    helper_wait($holder, 6.0);
    check('W4 holder exited', !helper_alive($holder));
    helper_close($holder);
    $afterExit = new WorkerLock($contendedPath);
    check('W4 lock is free again after the holder exits', $afterExit->acquire() === true);
    $afterExit->release();

    // ── W5: a KILLED holder cannot leave the queue locked forever ───────────
    $crashPath = $tmpRoot . '/crash.lock';
    $victim = spawn_helper($helperPath, [$crashPath, 10]);
    $children[] = $victim;
    $victimHeld = helper_result($victim);
    check('W5 victim acquired the lock before being killed', ($victimHeld['acquired'] ?? false) === true, json_encode($victimHeld));
    $killed = proc_terminate($victim['proc'], 9); // SIGKILL: no finally, no shutdown
    check('W5 victim was killed hard (SIGKILL, like an execution-time fatal)', $killed !== false);
    helper_wait($victim, 5.0);
    helper_close($victim);
    $afterCrash = new WorkerLock($crashPath);
    check('W5 the kernel released the lock on kill (no manual cleanup needed)', $afterCrash->acquire() === true);
    $afterCrash->release();

    // ── W6: cannot create the lock file => refuse to run, never continue ────
    $blocked = $tmpRoot . '/not-a-dir';
    file_put_contents($blocked, 'this is a regular file, not a directory');
    $threw = false;
    try {
        (new WorkerLock($blocked . '/inner.lock'))->acquire();
    } catch (Throwable $e) {
        $threw = true;
    }
    check('W6 acquire() throws when the lock path cannot be created', $threw);

    // ── W7: the REAL worker, run while locked, claims/modifies nothing ──────
    $workerPath = $root . '/backend/scripts/watermark-worker.php';
    $realPath = $tmpRoot . '/worker.lock';
    $realHolder = new WorkerLock($realPath);
    check('W7 test holds the real worker lock path', $realHolder->acquire() === true);

    $cmd = escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($workerPath)
        . ' --limit=5 --max-seconds=50 --lock-file=' . escapeshellarg($realPath) . ' 2>&1';
    $output = [];
    $exitCode = 0;
    exec($cmd, $output, $exitCode);
    $stdout = implode("\n", $output);
    $decoded = json_decode(trim((string) ($output[0] ?? '')), true);

    if ($decoded === null && $stdout !== '' && str_contains($stdout, 'worker cannot start')) {
        skip('W7 locked worker exits cleanly', 'worker could not boot in this checkout: ' . substr($stdout, 0, 120));
    } else {
        check('W7 locked worker exits 0 (a skip is not a failure)', $exitCode === 0, 'exit=' . $exitCode . ' ' . substr($stdout, 0, 120));
        check('W7 locked worker reports worker_locked', is_array($decoded) && ($decoded['skipped'] ?? '') === 'worker_locked', $stdout);
        check(
            'W7 locked worker claimed and modified nothing',
            is_array($decoded) && (int) ($decoded['claimed'] ?? -1) === 0 && str_contains((string) ($decoded['reason'] ?? ''), 'claimed and modified nothing'),
            json_encode($decoded)
        );
    }
    $realHolder->release();

    // ── W8: one-at-a-time claims + a fatal-safe release path exist ──────────
    $source = (string) file_get_contents($workerPath);
    check(
        'W8 worker claims ONE job per iteration (never limit-at-once)',
        str_contains($source, '$queue->claim(1, $workerId)') && !str_contains($source, '$queue->claim($limit'),
        'claim(1) present, claim($limit) absent'
    );
    check(
        'W8 worker stops BEFORE claiming when the budget cannot finish a render',
        str_contains($source, '$remaining < $minRenderSeconds') && str_contains($source, 'budget_stop'),
        'min-render-seconds guard'
    );
    check(
        'W8 shutdown handler releases a held job after an uncatchable fatal',
        str_contains($source, 'register_shutdown_function') && str_contains($source, 'wm_held_job') && str_contains($source, "'worker_aborted'"),
        'register_shutdown_function + release(worker_aborted)'
    );
} finally {
    foreach ($children as $child) {
        helper_close($child);
    }
    // Best-effort sandbox cleanup (locks are released by their owners above).
    foreach (glob($tmpRoot . '/*') ?: [] as $path) {
        @unlink($path);
    }
    @unlink($tmpRoot . '/.owner');
    @rmdir($tmpRoot);
}

fwrite(STDOUT, "\n");
if ($failures !== []) {
    fwrite(STDOUT, 'FAILURES (' . count($failures) . "):\n");
    foreach ($failures as $failure) {
        fwrite(STDOUT, '  - ' . $failure . "\n");
    }
    exit(1);
}
fwrite(STDOUT, 'All worker-lock checks passed' . ($skips > 0 ? " ({$skips} skipped)" : '') . ".\n");
exit(0);
