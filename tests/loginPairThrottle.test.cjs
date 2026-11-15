// Login pair-throttle static checks (no PHP runtime in this environment, so
// these assert the implementation shape; behaviour needs a PHP+MySQL run).
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const svc = read('backend/src/Services/LoginPairThrottleService.php');
const auth = read('backend/src/Services/AuthService.php');
const handler = read('backend/src/Middleware/ErrorHandler.php');
const mig = read('backend/database/mysql-migrations/040_login_pair_state.sql');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); }
}

test('HMAC-SHA256 key from config, no hardcoded secret, raw IP/identifier not stored', () => {
  assert.match(svc, /hash_hmac\('sha256'/);
  assert.match(svc, /Config::string\('LOGIN_THROTTLE_HMAC_KEY'/);
  assert.match(mig, /`pair_key`\s+CHAR\(64\)/);
  assert.ok(!/ip_address|identifier\s+VARCHAR|user_id/.test(mig), 'table has no raw ip, identifier or user id');
});

test('missing key disables pair throttle (per-IP limiter still applies)', () => {
  assert.match(svc, /if \(\$key === ''\) \{\s*return null;/);
});

test('cooldown check is read-only (cannot extend cooldown)', () => {
  const m = svc.match(/function assertAllowed[\s\S]*?\n    \}\n/);
  assert.ok(m, 'assertAllowed found');
  assert.ok(!/INSERT|UPDATE|DELETE/.test(m[0]), 'assertAllowed does not write');
});

test('failure upsert keeps an active cooldown (no extension) and decays after 24h', () => {
  assert.match(svc, /next_allowed_at > UTC_TIMESTAMP\(6\),\s*next_allowed_at,/);
  assert.match(svc, /DECAY_SECONDS = 86400/);
  assert.match(svc, /fail_count = \{\$newCount\}/);
});

test('policy defaults: 4 free, 30s base, 300s cap', () => {
  assert.match(svc, /FREE_FAILURES = 4/);
  assert.match(svc, /Config::int\('LOGIN_PAIR_BASE_COOLDOWN_SECONDS', 30\)/);
  assert.match(svc, /MAX_COOLDOWN_SECONDS = 300/);
});

test('normalization resolves public ID before email/phone (matches resolver order)', () => {
  const pub = svc.indexOf('normalizePublicUserId');
  const mail = svc.indexOf("str_contains($identifier, '@')");
  assert.ok(pub > 0 && mail > pub);
});

test('login checks cooldown before credentials and records failures for known and unknown', () => {
  const login = auth.slice(auth.indexOf('function login('), auth.indexOf('function login(') + 4000);
  const assertAt = login.indexOf('assertAllowed');
  const resolveAt = login.indexOf('resolveIdentifier');
  assert.ok(assertAt > 0 && assertAt < resolveAt, 'cooldown before resolve');
  assert.strictEqual((login.match(/recordFailure/g) || []).length, 2, 'two failure paths');
  assert.match(login, /\$pairThrottle->clear\(/);
});

test('per-IP limiter is still called first in login()', () => {
  const login = auth.slice(auth.indexOf('function login('), auth.indexOf('function login(') + 3000);
  assert.ok(login.indexOf("'login:' . $request->clientIp()") < login.indexOf('assertAllowed'));
});

test('429 carries Retry-After and the generic body (no account existence leak)', () => {
  assert.match(handler, /instanceof \\MedAcademy\\Services\\LoginCooldownException/);
  assert.match(handler, /header\('Retry-After: '/);
  const exc = read('backend/src/Services/LoginCooldownException.php');
  assert.match(exc, /Too many attempts\. Please try again later\./);
  assert.match(exc, /'rate_limited'/);
});

test('down migration drops only login_pair_state', () => {
  const down = read('backend/database/mysql-migrations/040_login_pair_state_down.sql');
  assert.match(down, /DROP TABLE IF EXISTS `login_pair_state`;/);
  assert.ok(!/DROP TABLE IF EXISTS `(users|rate_limits|sessions)/.test(down));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
