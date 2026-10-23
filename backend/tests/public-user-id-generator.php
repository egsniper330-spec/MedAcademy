<?php

declare(strict_types=1);

/**
 * public-user-id-generator.php — executable tests for the user-facing public id
 * allocator (PublicUserIdService) and its lookup normaliser
 * (AuthService::normalizePublicUserId).
 *
 * WHY PHP AND NOT ONLY STATIC ANALYSIS: the boundary values (MED-9999 →
 * MED-10000), the sequential→random transition, collision retry and namespace
 * exhaustion are RUNTIME behaviour. These tests drive the real policy through
 * injected sequence / availability / random sources, so every branch executes
 * for real without MySQL, a live server or 100,000 user rows.
 *
 * Run:
 *   php backend/tests/public-user-id-generator.php
 *   (Windows, bundled runtime:
 *    .freebuff/pdfreal.baseline-bak/php/php.exe backend/tests/public-user-id-generator.php)
 *
 * Exit code 0 = every check passed.
 *
 * WHAT IS NOT COVERED HERE (never claim it as verified):
 *   • The SQL trigger's own behaviour (no MySQL/MariaDB in this environment).
 *     Its rules are asserted statically by tests/publicUserIdFiveDigits.test.cjs
 *     and still need a staging-database run.
 *   • Real multi-process contention on the sequence row. The run below proves
 *     the POLICY never hands the same value out twice; the atomicity of
 *     `UPDATE … LAST_INSERT_ID(next_val + 1)` is a MySQL guarantee.
 */

require dirname(__DIR__) . '/src/bootstrap.php';

use MedAcademy\Http\ApiException;
use MedAcademy\Services\AuthService;
use MedAcademy\Services\PublicUserIdService;

$passed = 0;
$failed = 0;
$failures = [];

function check(string $name, callable $fn): void
{
    global $passed, $failed, $failures;
    try {
        $fn();
        $passed++;
        echo "  ok   $name\n";
    } catch (\Throwable $e) {
        $failed++;
        $failures[] = $name . ' → ' . $e->getMessage();
        echo "  FAIL $name\n       " . $e->getMessage() . "\n";
    }
}

function assertSame(mixed $expected, mixed $actual, string $what = ''): void
{
    if ($expected !== $actual) {
        throw new RuntimeException(
            ($what !== '' ? $what . ': ' : '') . 'expected ' . var_export($expected, true)
            . ', got ' . var_export($actual, true)
        );
    }
}

function assertTrue(bool $cond, string $what): void
{
    if (!$cond) {
        throw new RuntimeException($what);
    }
}

/** In-memory "profiles.public_user_id" store: id => true when the id is used. */
function makeStore(array $existing = []): array
{
    return ['ids' => array_fill_keys($existing, true)];
}

function takenIn(array $store): callable
{
    return static fn (string $id): bool => isset($store['ids'][$id]);
}

/** Deterministic "random" source for reproducible collision tests. */
function sequenceRandom(array $values): callable
{
    $i = 0;
    return static function (int $min, int $max) use (&$i, $values): int {
        $v = $values[$i % count($values)];
        $i++;
        if ($v < $min || $v > $max) {
            throw new RuntimeException("test random value $v outside $min..$max");
        }
        return $v;
    };
}

echo "── 1. Format contract: prefix, padding, five-digit ceiling ──\n";

check('MED-0001 is the first id', function (): void {
    assertSame('MED-0001', PublicUserIdService::format(1));
});

check('four-digit zero padding below 1000 is unchanged', function (): void {
    assertSame('MED-0009', PublicUserIdService::format(9));
    assertSame('MED-0042', PublicUserIdService::format(42));
    assertSame('MED-0100', PublicUserIdService::format(100));
    assertSame('MED-0999', PublicUserIdService::format(999));
});

check('MED-9999 keeps four digits (no premature widening)', function (): void {
    assertSame('MED-9999', PublicUserIdService::format(9999));
});

check('MED-10000 crosses to five digits without padding', function (): void {
    assertSame('MED-10000', PublicUserIdService::format(10000));
});

check('MED-99998 / MED-99999 are the last valid ids', function (): void {
    assertSame('MED-99998', PublicUserIdService::format(99998));
    assertSame('MED-99999', PublicUserIdService::format(99999));
});

check('format refuses 0 and anything above 99999 (never a sixth digit)', function (): void {
    foreach ([0, -1, 100000, 1234567] as $bad) {
        $threw = false;
        try {
            PublicUserIdService::format($bad);
        } catch (InvalidArgumentException) {
            $threw = true;
        }
        assertTrue($threw, "format($bad) must throw");
    }
});

echo "── 2. Canonical validation (existing ids are never rewritten) ──\n";

check('canonical ids are recognised, non-canonical spellings are not', function (): void {
    foreach (['MED-0001', 'MED-9999', 'MED-10000', 'MED-48271', 'MED-99999'] as $good) {
        assertTrue(PublicUserIdService::isCanonical($good), "$good must be canonical");
    }
    foreach ([
        'MED-0000', 'MED-00001', 'MED-09999', 'MED-100000', 'MED-123456',
        'MED-', 'MED-ABC', 'MED-1.00', 'ABCDEF', '', '44821',
    ] as $bad) {
        assertTrue(!PublicUserIdService::isCanonical($bad), "$bad must NOT be canonical");
    }
});

check('value() reads the numeric part of a canonical id only', function (): void {
    assertSame(1, PublicUserIdService::value('MED-0001'));
    assertSame(99999, PublicUserIdService::value('MED-99999'));
    assertSame(null, PublicUserIdService::value('MED-100000'));
});

check('the sequential ceiling is 99999, not 9999 and not 100000', function (): void {
    assertTrue(PublicUserIdService::isSequentialValue(1), '1 is sequential');
    assertTrue(PublicUserIdService::isSequentialValue(9999), '9999 is sequential');
    assertTrue(PublicUserIdService::isSequentialValue(10000), '10000 is sequential');
    assertTrue(PublicUserIdService::isSequentialValue(99999), '99999 is sequential');
    assertTrue(!PublicUserIdService::isSequentialValue(100000), '100000 is NOT sequential');
    assertTrue(!PublicUserIdService::isSequentialValue(0), '0 is NOT sequential');
});

echo "── 3. Sequential allocation across the whole range ──\n";

check('an allocated id equals the sequence value, verbatim', function (): void {
    $store = makeStore();
    foreach ([1, 2, 9998, 9999, 10000, 50000, 99998, 99999] as $n) {
        $id = PublicUserIdService::allocateWith(static fn (): int => $n, takenIn($store));
        assertSame(PublicUserIdService::format($n), $id, "sequence $n");
    }
});

check('a full 1..99999 sequential run is unique, canonical and monotonic', function (): void {
    $store = makeStore();
    $seen = [];
    for ($i = 1; $i <= 99999; $i++) {
        $id = PublicUserIdService::allocateWith(
            static fn (): int => $i,
            static function (string $candidate) use (&$store): bool {
                return isset($store['ids'][$candidate]);
            }
        );
        assertSame(PublicUserIdService::format($i), $id, "draw $i");
        assertTrue(!isset($seen[$id]), "duplicate $id at draw $i");
        assertTrue(
            preg_match('/^MED-[0-9]{4,5}$/', $id) === 1,
            "draw $i produced a malformed id: $id"
        );
        $seen[$id] = true;
        $store['ids'][$id] = true; // mirror the DB: the id is now stored
    }
    assertSame(99999, count($seen));
    assertTrue(isset($seen['MED-0001']), 'MED-0001 was issued');
    assertTrue(isset($seen['MED-9999']), 'MED-9999 was issued (four digits)');
    assertTrue(isset($seen['MED-10000']), 'MED-10000 was issued (five digits)');
    assertTrue(isset($seen['MED-99999']), 'MED-99999 was the last sequential id');
    assertTrue(!isset($seen['MED-0000']), 'MED-0000 is never issued');
});

echo "── 4. Random fallback after MED-99999 ──\n";

check('a sequence past 99999 switches to a five-digit random id', function (): void {
    $store = makeStore();
    // Everything sequential is already used, but 48271 was burned (never stored).
    for ($i = 1; $i <= 99999; $i++) {
        if ($i === 48271) {
            continue;
        }
        $store['ids'][PublicUserIdService::format($i)] = true;
    }
    $rand = static fn (int $min, int $max): int => 48271;
    $id = PublicUserIdService::allocateWith(static fn (): int => 100000, takenIn($store), $rand);
    assertSame('MED-48271', $id);
});

check('every random fallback id has exactly five digits after MED-', function (): void {
    $store = makeStore();
    for ($i = 0; $i < 500; $i++) {
        $id = PublicUserIdService::allocateWith(static fn (): int => 100000 + $i, takenIn($store));
        assertTrue(
            preg_match('/^MED-[0-9]{5}$/', $id) === 1,
            "random id not five digits: $id"
        );
        $value = (int) substr($id, 4);
        assertTrue($value >= 10000 && $value <= 99999, "random value outside 10000..99999: $id");
        assertSame($id, PublicUserIdService::format(PublicUserIdService::value($id) ?? 0), 'canonical');
    }
});

check('randomValue stays inside 10000..99999 over many draws', function (): void {
    for ($i = 0; $i < 2000; $i++) {
        $v = PublicUserIdService::randomValue();
        assertTrue($v >= 10000 && $v <= 99999, "randomValue returned $v");
    }
});

echo "── 5. Collision handling and retry ──\n";

check('an occupied random candidate is retried, not reused', function (): void {
    $store = makeStore(['MED-48271']);
    $rand = sequenceRandom([48271, 48271, 13742]);
    $id = PublicUserIdService::allocateWith(static fn (): int => 100001, takenIn($store), $rand);
    assertSame('MED-13742', $id);
});

check('a taken sequential value falls through to the random tail (no reuse)', function (): void {
    // Legacy drift: the sequence says 42, but MED-0042 already exists.
    $store = makeStore(['MED-0042']);
    $rand = static fn (int $min, int $max): int => 31415;
    $id = PublicUserIdService::allocateWith(static fn (): int => 42, takenIn($store), $rand);
    assertSame('MED-31415', $id);
});

check('existing ids (4-digit, 5-digit, junk rows) are never handed out again', function (): void {
    $existing = ['MED-0001', 'MED-0042', 'MED-9999', 'MED-10000', 'MED-48271', 'MED-99999', 'MED-1.00', 'DEADBEEF'];
    $store = makeStore($existing);
    $rand = sequenceRandom([48271, 10000, 99999, 24680]);
    $id = PublicUserIdService::allocateWith(static fn (): int => 100002, takenIn($store), $rand);
    assertSame('MED-24680', $id);
    foreach ($existing as $old) {
        assertTrue($id !== $old, "allocated an existing id: $old");
    }
});

echo "── 6. Namespace exhaustion fails safely ──\n";

check('an exhausted namespace throws a 503 with an actionable code', function (): void {
    $rand = static fn (int $min, int $max): int => 48271;
    $threw = null;
    try {
        PublicUserIdService::allocateWith(static fn (): int => 100003, static fn (): bool => true, $rand);
    } catch (ApiException $e) {
        $threw = $e;
    }
    assertTrue($threw instanceof ApiException, 'ApiException expected');
    assertSame(503, $threw->status);
    assertSame(PublicUserIdService::EXHAUSTED_CODE, $threw->errors[0] ?? null);
    assertTrue(
        str_contains($threw->getMessage(), 'MED-0001..MED-99999'),
        'message must name the namespace: ' . $threw->getMessage()
    );
});

check('exhaustion is bounded by MAX_RANDOM_ATTEMPTS draws', function (): void {
    $draws = 0;
    $rand = static function (int $min, int $max) use (&$draws): int {
        $draws++;
        return 48271;
    };
    try {
        PublicUserIdService::allocateWith(static fn (): int => 100004, static fn (): bool => true, $rand);
    } catch (ApiException) {
        // expected
    }
    assertSame(PublicUserIdService::MAX_RANDOM_ATTEMPTS, $draws, 'draw count');
});

check('a misbehaving random source cannot widen the namespace', function (): void {
    $threw = false;
    try {
        PublicUserIdService::randomValue(static fn (): int => 100000);
    } catch (RuntimeException) {
        $threw = true;
    }
    assertTrue($threw, 'out-of-range random value must be rejected');
});

echo "── 7. Concurrency model: no two creations share an id ──\n";

check('a full sequential run is unique, and the 100000th request fails instead of duplicating', function (): void {
    // The atomic "last issued" counter — exactly what the SQL
    // `UPDATE … SET next_val = LAST_INSERT_ID(next_val + 1)` provides.
    $lastIssued = 0;
    $draw = static function () use (&$lastIssued): int {
        $lastIssued++;
        return $lastIssued;
    };
    $store = makeStore();
    $isTaken = static function (string $id) use (&$store): bool {
        return isset($store['ids'][$id]);
    };
    $seen = [];

    for ($i = 1; $i <= 99999; $i++) {
        $id = PublicUserIdService::allocateWith($draw, $isTaken);
        assertTrue(!isset($seen[$id]), "duplicate allocation $id at call $i");
        assertTrue(
            preg_match('/^MED-[0-9]{4,5}$/', $id) === 1,
            "call $i produced a malformed id: $id"
        );
        $seen[$id] = true;
        $store['ids'][$id] = true;
    }
    assertSame(99999, count($seen));

    // Every five-digit value is now stored, so no candidate remains: the next
    // request must FAIL, not duplicate, shorten or widen.
    $threw = null;
    try {
        PublicUserIdService::allocateWith($draw, $isTaken);
    } catch (ApiException $e) {
        $threw = $e;
    }
    assertTrue($threw instanceof ApiException, 'request 100000 must fail with ApiException');
    assertSame(503, $threw->status);
});

check('the random tail fills gaps left by rolled-back creations', function (): void {
    // The sequence ran to 99999, but 50000..50004 rolled back and were never
    // stored, so five free five-digit values remain.
    $store = makeStore();
    for ($i = 1; $i <= 99999; $i++) {
        if ($i >= 50000 && $i <= 50004) {
            continue;
        }
        $store['ids'][PublicUserIdService::format($i)] = true;
    }
    // Random candidates are always 10000..99999, so a gap in the FOUR-digit part
    // of the range can never be handed out at random — only five-digit gaps can.
    $rand = sequenceRandom([50000]);
    $id = PublicUserIdService::allocateWith(static fn (): int => 200000, takenIn($store), $rand);
    assertSame('MED-50000', $id);
});

echo "── 8. Lookup normalisation matches the allocator ──\n";

check('accepted spellings normalise to the canonical id', function (): void {
    assertSame('MED-0001', AuthService::normalizePublicUserId('MED-0001'));
    assertSame('MED-0001', AuthService::normalizePublicUserId('med-0001'));
    assertSame('MED-0001', AuthService::normalizePublicUserId('MED0001'));
    assertSame('MED-0001', AuthService::normalizePublicUserId(' 0001 '));
    assertSame('MED-0001', AuthService::normalizePublicUserId('1'));
    assertSame('MED-0001', AuthService::normalizePublicUserId('00001')); // non-canonical 5-digit spelling
    assertSame('MED-9999', AuthService::normalizePublicUserId('9999'));
    assertSame('MED-10000', AuthService::normalizePublicUserId('MED-10000'));
    assertSame('MED-10000', AuthService::normalizePublicUserId('10000'));
    assertSame('MED-48271', AuthService::normalizePublicUserId('med-48271'));
    assertSame('MED-99999', AuthService::normalizePublicUserId('99999'));
});

check('out-of-namespace / non-id inputs resolve to null (never a widened id)', function (): void {
    foreach (['', '0', '000000', 'MED-0000', '123456', 'MED-100000', 'med@academy.com', 'Ahmed Ali'] as $bad) {
        assertSame(null, AuthService::normalizePublicUserId($bad), "input: $bad");
    }
});

echo "\n────────────────────────────────────────────────────────────\n";
echo "RESULT: {$passed} passed, {$failed} failed\n";
if ($failed > 0) {
    echo "\nFailures:\n";
    foreach ($failures as $f) {
        echo "  • $f\n";
    }
    exit(1);
}
exit(0);
