<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Storage\StorageService;

/**
 * WorkerLock — one running cron worker per host, enforced by the OS.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The PDF queue already prevents duplicate WORK: `MaterialPdfQueueService::claim()`
 * claims a row with a conditional UPDATE, and `MaterialPdfVariantService` takes a
 * per-variant `flock`. Neither stops two worker PROCESSES from existing, so on a
 * one-minute cron a slow run overlaps the next one and the host ends up rendering
 * two (or three) PDFs concurrently — each a FPDI/TCPDF render that can take tens
 * of seconds and hundreds of MB. That is a resource problem on a shared account,
 * not a correctness problem, and it is what a single-instance guard fixes.
 *
 * WHY `flock` AND NOT A PID FILE
 * ──────────────────────────────
 * A PID file is a check-then-create race: two processes can both read "no file"
 * and both write one. It also goes stale the moment a process is killed, and then
 * the check must guess whether the PID was reused. `flock(LOCK_EX|LOCK_NB)` is
 * atomic in the kernel: exactly one process gets it, and the descriptor closes
 * (releasing the lock) when the process exits, crashes, or is killed — including
 * on an uncatchable PHP fatal.
 *
 * The file's CONTENT is only diagnostics (pid, host, start time); the lock is the
 * flock itself, never the file's existence.
 *
 * WHERE
 * ─────
 * Inside private storage (`storage/private/.watermark-worker.lock`), which the
 * deploy already makes writable and which is outside the web root. `StorageService`
 * is used for the directory so the path matches the per-variant lock convention
 * (`.watermark-locks/`).
 *
 * FAILURE POLICY
 * ──────────────
 * If the lock file cannot be CREATED, `acquire()` throws: a worker that cannot
 * prove it is the only instance must not run, or the guard is decorative. If the
 * lock is merely HELD by someone else, `acquire()` returns false and the caller
 * exits cleanly — that is a normal, informative outcome, not an error.
 */
final class WorkerLock
{
    /** @var resource|null */
    private $handle = null;

    private bool $held = false;

    public function __construct(private readonly string $path)
    {
    }

    /** Default location: private storage next to the per-variant locks. */
    public static function defaultPath(StorageService $storage = new StorageService()): string
    {
        return $storage->privateDir() . '/.watermark-worker.lock';
    }

    public function path(): string
    {
        return $this->path;
    }

    /**
     * Try to become the single running worker.
     *
     * @return bool true when THIS process holds the lock, false when another
     *              live process holds it
     * @throws \RuntimeException when the lock file cannot be created or opened
     */
    public function acquire(): bool
    {
        if ($this->held) {
            return true;
        }

        $dir = dirname($this->path);
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new \RuntimeException('cannot create the worker lock directory: ' . $dir);
        }

        // 'c' opens for writing WITHOUT truncating and creates the file if
        // needed — truncating here would wipe a holder's diagnostics before we
        // know whether we won, and 'w' would also destroy it on contention.
        $handle = @fopen($this->path, 'c');
        if ($handle === false) {
            throw new \RuntimeException('cannot open the worker lock file: ' . $this->path);
        }

        // LOCK_NB: never wait. A cron run that blocks is worse than a skipped one.
        if (!flock($handle, LOCK_EX | LOCK_NB)) {
            fclose($handle);
            return false;
        }

        $this->handle = $handle;
        $this->held = true;
        $this->writeHolder();
        return true;
    }

    /** Release the lock (idempotent; also safe to call from a shutdown handler). */
    public function release(): void
    {
        if ($this->handle !== null) {
            @flock($this->handle, LOCK_UN);
            @fclose($this->handle);
        }
        $this->handle = null;
        $this->held = false;
    }

    public function isHeld(): bool
    {
        return $this->held;
    }

    /**
     * Diagnostics for whoever ELSE holds the lock (pid/host/since).
     *
     * Read-only and best-effort: content is written by the holder after it wins,
     * so a contender can report "another worker is running" with evidence. A
     * corrupt/empty file simply yields an empty array — the flock remains the
     * only authority.
     *
     * @return array<string,mixed>
     */
    public function holder(): array
    {
        $raw = @file_get_contents($this->ownerPath());
        if (!is_string($raw) || trim($raw) === '') {
            return [];
        }
        $decoded = json_decode(trim($raw), true);
        return is_array($decoded) ? $decoded : [];
    }

    /**
     * Companion file holding the CURRENT holder's identity, next to the lock.
     *
     * WHY NOT THE LOCK FILE ITSELF
     *   Writing the identity into the locked file works on Linux (flock does not
     *   block reads) but not on Windows, where PHP emulates flock with LockFileEx
     *   and any other handle gets "Permission denied" — so a contender could not
     *   report who is running. Diagnostics live in their own unlocked file for
     *   that reason. It is NEVER consulted for locking: the flock is the only
     *   authority, and stale content here cannot hold or block anything.
     */
    public function ownerPath(): string
    {
        return $this->path . '.owner';
    }

    /** Write this process's identity for the next contender's diagnostics. */
    private function writeHolder(): void
    {
        $body = json_encode([
            'pid' => getmypid(),
            'host' => gethostname() ?: '',
            'started_at' => gmdate('Y-m-d\TH:i:s\Z'),
            'sapi' => PHP_SAPI,
        ], JSON_UNESCAPED_SLASHES);
        if ($body === false) {
            return;
        }
        // Not atomic, and it does not need to be: a torn read only yields an
        // unreadable holder report, never a wrong lock decision.
        @file_put_contents($this->ownerPath(), $body . "\n");
    }

    /** Release on destruction so an exception path cannot leak the lock. */
    public function __destruct()
    {
        $this->release();
    }
}
