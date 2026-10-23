<?php

declare(strict_types=1);

namespace MedAcademy\Services;

use MedAcademy\Database\Database;
use MedAcademy\Http\ApiException;

/**
 * PublicUserIdService — the ONE allocator for the user-facing public id
 * (`profiles.public_user_id`, the "MED-…" identifier every screen, watermark
 * and search box shows).
 *
 * ── FORMAT CONTRACT (five digits, never six) ─────────────────────────────────
 *
 *   value 1      → MED-0001      four digits, zero padded (legacy format kept)
 *   value 9999   → MED-9999
 *   value 10000  → MED-10000     five digits, no padding needed
 *   value 99999  → MED-99999     LAST sequential id
 *
 *   MAX = 99999. Nothing is ever formatted wider, and `format()` refuses a
 *   value outside 1..99999 instead of silently emitting a sixth digit.
 *
 * ── ALLOCATION POLICY ───────────────────────────────────────────────────────
 *
 *   1. SEQUENTIAL while the namespace lasts. The sequence row is drawn with the
 *      atomic `UPDATE … LAST_INSERT_ID(next_val + 1)` trick, so two concurrent
 *      requests can never read the same value (the row lock serializes them).
 *   2. RANDOM once the sequence has passed 99999 (or when the sequential value
 *      is already occupied by legacy data). Candidates come from
 *      random_int(10000, 99999) — the CSPRNG PHP ships — and are checked for
 *      availability before use.
 *   3. BOUNDED RETRY. At most MAX_RANDOM_ATTEMPTS candidates are tried; each
 *      attempt is a fresh CSPRNG draw.
 *   4. EXHAUSTION fails loudly with a 503 and a stable error code. It never
 *      falls back to a duplicate, a six-digit value or a malformed id.
 *
 * ── WHO ELSE WRITES THIS COLUMN ─────────────────────────────────────────────
 *
 * The database trigger `trg_on_auth_user_created` (schema.sql / migration 036)
 * creates the profiles row for every new `users` row. Application paths put the
 * id this service allocated into `users.raw_user_meta_data.public_user_id`; the
 * trigger validates it (canonical + free) and uses it, and only allocates
 * itself when the id is absent or was taken between the check and the insert —
 * which is the raw-SQL / importer path. Both implementations use the same
 * namespace, the same formatting rule and the same 99999 ceiling, and
 * `profiles.public_user_id` carries a UNIQUE index, so a duplicate id cannot be
 * stored by either.
 *
 * ── CONCURRENCY ─────────────────────────────────────────────────────────────
 *
 * Sequential: the sequence row UPDATE holds an exclusive lock until the
 * transaction commits, and each draw reads the value it just wrote — two
 * transactions cannot obtain the same number.
 *
 * Random: the availability check is followed by the insert; a competing insert
 * that wins the race is rejected by the UNIQUE index, never stored twice. The
 * caller's transaction then fails cleanly (a 409 from the existing identifier
 * mapping) instead of producing a duplicate id.
 *
 * Nothing here rewrites an existing id: allocation only ever proposes a *new*
 * value, and the unique index plus the trigger's pre-check protect existing rows.
 */
final class PublicUserIdService
{
    /** Product prefix — unchanged by the five-digit change. */
    public const PREFIX = 'MED-';

    /** Smallest assignable numeric value (MED-0001; MED-0000 is never issued). */
    public const MIN_VALUE = 1;

    /** Largest assignable numeric value — the five-digit ceiling. */
    public const MAX_VALUE = 99999;

    /**
     * The last value handed out sequentially. Kept equal to MAX_VALUE because
     * the sequential range IS the whole five-digit namespace: once the sequence
     * passes 99999 only values freed by gaps can still be allocated at random.
     */
    public const SEQUENTIAL_MAX = 99999;

    /** Random fallback range — always exactly five digits (10000..99999). */
    public const RANDOM_MIN = 10000;
    public const RANDOM_MAX = 99999;

    /** Bounded retry budget for the random fallback. */
    public const MAX_RANDOM_ATTEMPTS = 40;

    /** Stable machine-readable error code for an exhausted namespace. */
    public const EXHAUSTED_CODE = 'public_id_exhausted';

    // ── Format contract ───────────────────────────────────────────────────

    /**
     * Canonical formatting: minimum width 4, so 1 → MED-0001 and 10000 →
     * MED-10000. Values outside the namespace are rejected rather than widened.
     */
    public static function format(int $value): string
    {
        if ($value < self::MIN_VALUE || $value > self::MAX_VALUE) {
            throw new \InvalidArgumentException(
                sprintf('public user id value %d is outside %d..%d', $value, self::MIN_VALUE, self::MAX_VALUE)
            );
        }
        return self::PREFIX . str_pad((string) $value, 4, '0', STR_PAD_LEFT);
    }

    /**
     * True when `$id` is EXACTLY the canonical form of an in-range value.
     *
     * Rejects: MED-100000 (six digits), MED-0 / MED-0000 (value 0),
     * MED-00001 (non-canonical five-digit spelling of 1), MED-ABC, empty,
     * and any legacy token that is not MED + digits.
     */
    public static function isCanonical(string $id): bool
    {
        if (preg_match('/^MED-([0-9]{4,5})$/', $id, $m) !== 1) {
            return false;
        }
        $value = (int) $m[1];
        // Range first: format() throws outside the namespace and a validator
        // must answer false, never raise (MED-0000 / MED-00000 reach here).
        if ($value < self::MIN_VALUE || $value > self::MAX_VALUE) {
            return false;
        }
        return self::format($value) === $id;
    }

    /** Numeric value of a canonical id, or null when it is not canonical. */
    public static function value(string $id): ?int
    {
        return self::isCanonical($id) ? (int) substr($id, strlen(self::PREFIX)) : null;
    }

    /** True while a sequence draw is still inside the sequential namespace. */
    public static function isSequentialValue(int $sequence): bool
    {
        return $sequence >= self::MIN_VALUE && $sequence <= self::SEQUENTIAL_MAX;
    }

    // ── Random fallback ───────────────────────────────────────────────────

    /**
     * One random five-digit candidate value (10000..99999).
     *
     * `$randomInt` exists for deterministic tests; production uses PHP's
     * CSPRNG (`random_int`).
     *
     * @param callable(int,int):int|null $randomInt
     */
    public static function randomValue(?callable $randomInt = null): int
    {
        $draw = $randomInt ?? static fn (int $min, int $max): int => random_int($min, $max);
        $value = (int) $draw(self::RANDOM_MIN, self::RANDOM_MAX);
        if ($value < self::RANDOM_MIN || $value > self::RANDOM_MAX) {
            // A misbehaving injected generator must never widen the namespace.
            throw new \RuntimeException('random candidate outside the five-digit range');
        }
        return $value;
    }

    // ── Allocation ────────────────────────────────────────────────────────

    /**
     * The allocation policy, with its data access injected so the whole rule
     * set (boundaries, collision retry, exhaustion) is testable without a
     * database.
     *
     * @param callable():int                    $drawSequence Next atomic sequence value.
     * @param callable(string):bool             $isTaken      Is this id already stored?
     * @param callable(int,int):int|null        $randomInt    CSPRNG override (tests only).
     *
     * @throws ApiException 503 when the namespace is exhausted.
     */
    public static function allocateWith(
        callable $drawSequence,
        callable $isTaken,
        ?callable $randomInt = null
    ): string {
        $sequence = (int) $drawSequence();

        if (self::isSequentialValue($sequence)) {
            $candidate = self::format($sequence);
            if (!$isTaken($candidate)) {
                return $candidate;
            }
            // Legacy drift (restored dump / hand-written rows): fall through to
            // the random tail instead of ever reusing an existing id.
        }

        for ($attempt = 0; $attempt < self::MAX_RANDOM_ATTEMPTS; $attempt++) {
            $candidate = self::format(self::randomValue($randomInt));
            if (!$isTaken($candidate)) {
                return $candidate;
            }
        }

        throw self::exhausted();
    }

    /**
     * Allocate the public id for a new user against the live database.
     *
     * Call inside the caller's transaction: the sequence draw then rolls back
     * with a failed creation (a burned number is harmless — a reused one is not).
     *
     * @throws ApiException 503 when no id remains in MED-0001..MED-99999.
     */
    public static function allocate(): string
    {
        $db = Database::instance();

        return self::allocateWith(
            static function () use ($db): int {
                // Atomic draw: the row lock serializes concurrent allocations and
                // LAST_INSERT_ID() returns the value this statement just wrote.
                $db->query('UPDATE public_user_id_seq SET next_val = LAST_INSERT_ID(next_val + 1) WHERE id = 1');
                $sequence = (int) $db->value('SELECT LAST_INSERT_ID()', [], 0);
                if ($sequence < self::MIN_VALUE) {
                    // Row missing / never seeded: refuse instead of allocating
                    // from a stale LAST_INSERT_ID value.
                    throw new ApiException(
                        500,
                        'Public user id sequence is not initialized (public_user_id_seq is empty)',
                        'public_id_sequence_missing'
                    );
                }
                return $sequence;
            },
            static fn (string $id): bool => (int) $db->value(
                'SELECT COUNT(*) FROM profiles WHERE public_user_id = ?',
                [$id],
                0
            ) > 0
        );
    }

    /** The safe, actionable failure used when the namespace is full. */
    public static function exhausted(): ApiException
    {
        return new ApiException(
            503,
            'No user IDs remain available in the MED-0001..MED-99999 namespace. '
            . 'Existing IDs were not changed and no longer ID was issued.',
            self::EXHAUSTED_CODE
        );
    }
}
