/**
 * Public user ID — five-digit ceiling, sequential→random transition, and the
 * compatibility of every consumer (creation paths, lookup, watermarks, schema).
 *
 * Run: node tests/publicUserIdFiveDigits.test.cjs
 *
 * These are contract assertions over the REAL sources: the PHP allocator, the
 * SQL trigger in both schema.sql and migration 036, every user-creation path,
 * the canonical lookup normaliser and the watermark renderers. The runtime
 * behaviour of the allocator itself (boundaries, collisions, retries,
 * exhaustion, the 99999→random transition) is executed for real by
 * backend/tests/public-user-id-generator.php — run that too; a static pass
 * here is NOT proof that the policy works.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r/g, '');

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
    console.log('  ✗ ' + msg);
  }
}
function section(title) {
  console.log('── ' + title + ' ──');
}

/* ═══════════════════ 1. The allocator (PHP) ═══════════════════ */

section('1. Allocator: five-digit ceiling + secure random tail');

const svc = read('backend/src/Services/PublicUserIdService.php');

ok(/public const PREFIX = 'MED-';/.test(svc), 'prefix is still MED-');
ok(/public const MAX_VALUE = 99999;/.test(svc), 'namespace maximum is 99999 (no sixth digit)');
ok(/public const SEQUENTIAL_MAX = 99999;/.test(svc), 'sequential ceiling is MED-99999');
ok(/public const RANDOM_MIN = 10000;\s*\n\s*public const RANDOM_MAX = 99999;/.test(svc),
  'random candidates are exactly the five-digit range 10000..99999');
ok(/str_pad\(\(string\) \$value, 4, '0', STR_PAD_LEFT\)/.test(svc),
  'formatting keeps the four-digit padding floor (MED-0001 … MED-9999)');
ok(/\$value > self::MAX_VALUE\) \{\s*\n\s*throw new \\InvalidArgumentException/.test(svc),
  'format() refuses anything above 99999 instead of emitting a longer id');
ok(/random_int\(\$min, \$max\)/.test(svc), 'random tail uses the CSPRNG (random_int)');
ok(/public const MAX_RANDOM_ATTEMPTS = 40;/.test(svc) &&
   /for \(\$attempt = 0; \$attempt < self::MAX_RANDOM_ATTEMPTS; \$attempt\+\+\)/.test(svc),
  'collision retry is bounded (40 fresh candidates)');
ok(/new ApiException\(\s*503,/.test(svc) && /public const EXHAUSTED_CODE = 'public_id_exhausted';/.test(svc),
  'an exhausted namespace throws a clear 503 with a stable code');
ok(/No user IDs remain available in the MED-0001\.\.MED-99999 namespace/.test(svc),
  'the exhaustion message names the namespace and says nothing was changed');
ok(/UPDATE public_user_id_seq SET next_val = LAST_INSERT_ID\(next_val \+ 1\)/.test(svc),
  'sequential draw uses the atomic LAST_INSERT_ID trick (no read-after-write race)');
ok(/SELECT COUNT\(\*\) FROM profiles WHERE public_user_id = \?/.test(svc),
  'availability is checked against the complete existing id namespace');
ok(/public static function isCanonical/.test(svc) &&
   /\$value < self::MIN_VALUE \|\| \$value > self::MAX_VALUE/.test(svc),
  'canonical validation rejects MED-0000 / six-digit / malformed ids without throwing');

/* ═══════════════ 2. The database trigger (schema + migration) ═══════════════ */

section('2. Trigger: same policy in SQL, for non-PHP inserts');

const schema = read('backend/database/schema.sql');
const mig = read('backend/database/mysql-migrations/036_public_user_id_five_digits.sql');

for (const [label, sql] of [['schema.sql', schema], ['migration 036', mig]]) {
  ok(/IF v_num BETWEEN 1 AND 99999 THEN/.test(sql),
    `${label}: the sequential branch is bounded at 99999`);
  ok(!/v_num > 9999 THEN/.test(sql),
    `${label}: the retired four-digit ceiling (SIGNAL at 10000) is gone`);
  ok(/SET v_num = 10000 \+ FLOOR\(RAND\(\) \* 90000\)/.test(sql),
    `${label}: random fallback draws a five-digit value (10000..99999)`);
  ok(/SET v_tries = v_tries \+ 1/.test(sql) && /v_tries >= 40/.test(sql),
    `${label}: the random fallback is bounded (no infinite loop)`);
  ok(/SIGNAL SQLSTATE '45000'[\s\S]{0,160}MED-0001\.\.MED-99999/.test(sql),
    `${label}: exhaustion fails loudly instead of duplicating or widening`);
  ok(/CONCAT\('MED-', LPAD\(v_num, 4, '0'\)\)/.test(sql),
    `${label}: formatting is the same minimum-width-4 rule as the PHP allocator`);
  ok(/LAST_INSERT_ID\(`?next_val`? \+ 1\)/.test(sql),
    `${label}: concurrent creations serialize on the atomic sequence draw`);
  ok(/WHERE `public_user_id` = v_pub/.test(sql),
    `${label}: a taken sequential value is never reused (falls through to random)`);
  ok(/'\$\.public_user_id'/.test(sql) && /AND CONCAT\('MED-', LPAD/.test(sql),
    `${label}: the application-supplied id is validated (canonical + free) before use`);
  ok(!/MED-[0-9]\{6/.test(sql) && !/LPAD\(v_num, 6/.test(sql),
    `${label}: no six-digit formatting exists`);
}

ok(/UNIQUE KEY `uq_profiles_public_user_id` \(`public_user_id`\)/.test(schema),
  'schema.sql enforces public_user_id uniqueness at the database level');
ok(/ADD UNIQUE KEY `uq_profiles_public_user_id`/.test(mig),
  'migration 036 adds the unique index on databases that lack it');
ok(/GROUP BY `public_user_id`\s*\n\s*HAVING COUNT\(\*\) > 1/.test(mig),
  'migration reports duplicate ids instead of silently renumbering users');
ok(/GREATEST\(`next_val`, VALUES\(`next_val`\)\)/.test(mig),
  'migration only raises the sequence (never resets or lowers it)');
ok(!/UPDATE `profiles`\s+SET `public_user_id`/.test(mig),
  'migration never rewrites an existing public_user_id');
ok(/DELIMITER \$\$[\s\S]*DROP TRIGGER IF EXISTS trg_on_auth_user_created \$\$/.test(mig),
  'migration sets DELIMITER before the trigger (phpMyAdmin/MariaDB safe)');
ok(/INSERT IGNORE INTO `public_user_id_seq` \(`id`, `next_val`\) VALUES \(1, 0\);/.test(schema),
  'a fresh sequence starts at "nothing issued yet" so the first id is MED-0001');
ok(/next_val = the LAST ISSUED numeric value/.test(schema),
  'schema documents the next_val convention the allocator relies on');

/* ═════════════════ 3. Every user-creation path ═════════════════ */

section('3. One generator for every creation path');

const auth = read('backend/src/Services/AuthService.php');
const adminCtl = read('backend/src/Controllers/AdminController.php');
const studentCtl = read('backend/src/Controllers/StudentController.php');
const importer = read('backend/scripts/import-auth-users.php');

ok(/PublicUserIdService::allocate\(\)/.test(auth), 'registration (AuthService::register) uses the allocator');
ok(/PublicUserIdService::allocate\(\)/.test(adminCtl), 'admin/super-admin user creation uses the allocator');
ok(/PublicUserIdService::allocate\(\)/.test(studentCtl), 'doctor-created student creation uses the allocator');
ok(/PublicUserIdService::allocate\(\)/.test(importer), 'the auth-users importer uses the allocator for new rows');
ok(!/INSERT INTO `?profiles`?/i.test(auth + adminCtl + studentCtl + importer),
  'no PHP path inserts a profiles row directly (the trigger stays the single writer)');

/* ═════════════════ 4. Lookup / normalisation ═════════════════ */

section('4. Lookup accepts the five-digit ids');

ok(/public static function normalizePublicUserId/.test(auth) &&
   /return PublicUserIdService::format\(\$value\);/.test(auth),
  'normalisation delegates to the allocator formatter (padding can never drift)');
ok(!/str_pad\(\$digits, 4/.test(auth),
  'the old fixed four-digit str_pad is gone from the normaliser');
ok(/\$value > PublicUserIdService::MAX_VALUE\) \{\s*\n\s*return null;/.test(auth),
  'an out-of-namespace number is rejected, never widened into an id');
ok(/findByPublicUserId[\s\S]{0,400}public_user_id = \?/.test(auth),
  'lookup matches the canonical id exactly');

/* ═════════════════ 5. Watermarks / display ═════════════════ */

section('5. The full id survives every watermark');

const pdf = read('backend/src/Services/PdfWatermarkService.php');
const vdo = read('backend/src/Video/VdoCipherService.php');
const plyr = read('src/lib/plyr/playerScript.ts');
const inj = read('src/lib/watermarkInjection.ts');

ok(/\$identity = trim\(\$name \. \(\$name !== '' && \$id !== '' \? ' • ' : ''\) \. \$id\);/.test(pdf),
  'PDF identity line concatenates the complete id (no truncation)');
ok(!/substr\(\$id, 0,|mb_substr\(\$id, 0,/.test(pdf), 'PDF watermark never slices the id');
ok(/\$wmId = trim\(\(string\) \(\$profile\['public_user_id'\] \?\? ''\)\);/.test(vdo),
  'VdoCipher annotate reads the public id from the profile');
ok(/public function buildAnnotate\(string \$fullName, string \$watermarkId\)/.test(vdo) &&
   !/substr\(\$watermarkId, 0,/.test(vdo),
  'VdoCipher annotate receives the full id (no slicing)');
ok(/_iEl\.textContent = String\(id \|\| ''\);/.test(plyr) && !/\.slice\(0, 9\)|\.substring\(0, 9\)/.test(plyr),
  'Plyr renders the complete id');
ok(/max-width:min\(78%,420px\)/.test(plyr), 'Plyr mark width accommodates MED-99999');
ok(/_iEl\.textContent=WM_ID/.test(inj) && !/WM_ID\.slice|WM_ID\.substring/.test(inj),
  'the VdoCipher WebView injection renders the complete id');
ok(/(function fontSize\(\)|const px = fontSize\(\))/.test(plyr + inj),
  'watermark type scales with the player, so a longer id still fits');

/* ═════════════════ 6. No stale four-digit assumptions ═════════════════ */

section('6. No four-digit-only assumptions left');

const sources = [
  'backend/src/Services/AuthService.php',
  'backend/src/Services/PublicUserIdService.php',
  'backend/src/Controllers/AdminController.php',
  'backend/src/Controllers/UserController.php',
  'src/lib/watermarkIdentity.ts',
  'src/lib/api.ts',
];
let stale = [];
for (const file of sources) {
  const src = read(file);
  if (/MED-\\d\{4\}\$|MED-\[0-9\]\{4\}\$|\^MED-\[0-9\]\{4\}\$/.test(src)) {
    stale.push(file);
  }
}
ok(stale.length === 0, 'no source validates public_user_id as exactly four digits' +
  (stale.length ? ': ' + stale.join(', ') : ''));

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  • ' + f));
}
process.exit(failed ? 1 : 0);
