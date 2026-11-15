/**
 * CORS allow-list tests (static analysis of the authoritative middleware).
 *
 * Executable without PHP: node backend/tests/cors.test.js
 *
 * Live verification (once deployed):
 *   curl -i -X OPTIONS https://api.medacademy.site/backend/public/index.php/auth/login \
 *     -H 'Origin: http://localhost:8082' \
 *     -H 'Access-Control-Request-Method: POST' \
 *     -H 'Access-Control-Request-Headers: content-type,authorization'
 *   → 204 + Access-Control-Allow-Origin: http://localhost:8082
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MW = path.join(__dirname, '..', 'src', 'Middleware', 'CorsMiddleware.php');
const ENTRY = path.join(__dirname, '..', 'public', 'index.php');
const CLIENT = path.join(__dirname, '..', '..', 'src', 'client', 'php.ts');
const ENV_EXAMPLE = path.join(__dirname, '..', '.env.example');

const mw = fs.readFileSync(MW, 'utf8');
const entry = fs.readFileSync(ENTRY, 'utf8');
const client = fs.readFileSync(CLIENT, 'utf8');

const slice = (from, to) => mw.slice(mw.indexOf(from), mw.indexOf(to, mw.indexOf(from)));
const ALLOWED_HEADERS = slice('ALLOWED_HEADERS =', ';');

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + ' → ' + e.message); }
};

// ── 1. The preview origin is explicitly allowed, in both spellings ───────────
test('1. dev allow-list contains localhost:8082 and 127.0.0.1:8082', () => {
  assert.ok(mw.includes("'http://localhost:8082'"), 'localhost:8082 present');
  assert.ok(mw.includes("'http://127.0.0.1:8082'"), '127.0.0.1:8082 present');
  assert.ok(mw.includes("'http://localhost:8081'") && mw.includes("'http://127.0.0.1:8081'"),
    'documented 8081 origins preserved');
});

test('2. dev origins are an exact closed list, not a pattern', () => {
  const list = slice('DEV_ORIGINS = [', '];');
  // Strip the block comment before looking for wildcards.
  const code = list.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!code.includes('*'), 'no wildcard in dev list');
  const urls = [...code.matchAll(/'(https?:\/\/[^']+)'/g)].map(m => m[1]);
  assert.deepStrictEqual(urls.slice().sort(), [
    'http://127.0.0.1:8081', 'http://127.0.0.1:8082',
    'http://localhost:8081', 'http://localhost:8082',
  ].sort(), 'exactly four loopback origins');
});

// ── 3. No wildcard, no reflection ───────────────────────────────────────────
test('3. wildcard is rejected, never emitted', () => {
  assert.ok(mw.includes("if ($origin === '' || $origin === '*')"), 'explicit "*" rejection');
  assert.ok(!/header\(\s*'Access-Control-Allow-Origin: \*'/.test(mw), 'no wildcard header');
  assert.ok(!mw.includes("in_array('*', $allowed"), 'no wildcard allow path');
});

test('4. header is emitted only for an allow-listed origin (no reflection)', () => {
  const check = mw.indexOf('!in_array($normalized, self::allowedOrigins(), true)');
  const header = mw.indexOf("header('Access-Control-Allow-Origin: ' . $normalized);");
  assert.ok(check > 0 && header > check, 'allow-list check precedes the header');
  assert.ok(!mw.includes("header('Access-Control-Allow-Origin: ' . $origin)"),
    'raw Origin is never echoed');
  const earlyReturn = mw.indexOf('return;', check);
  assert.ok(earlyReturn > check && earlyReturn < header, 'unknown origin returns before any CORS header');
});

// ── 5. Credentials posture (inspect emission, not comments) ────────────────
test('5. no Allow-Credentials header is emitted', () => {
  assert.ok(!/header\(\s*'Access-Control-Allow-Credentials/i.test(mw),
    'middleware must not advertise credentials support');
  assert.ok(client.includes("RNPlatform.OS !== 'web'"),
    'web client does not send native-only custom headers');
});

// ── 6. Preflight correctness and ordering ──────────────────────────────────
test('6. OPTIONS returns 204 and exits before auth/routing', () => {
  const opt = mw.indexOf("if ($method === 'OPTIONS')");
  assert.ok(opt > 0, 'OPTIONS branch present');
  assert.ok(mw.lastIndexOf('http_response_code(204);') > opt, 'OPTIONS → 204');
  assert.ok(mw.indexOf('AuthMiddleware') === -1, 'middleware never touches auth');

  const cors = entry.indexOf('CorsMiddleware())->handle()');
  const maintenance = entry.indexOf('MaintenanceMiddleware())->handle(');
  const router = entry.indexOf('Router($request');
  assert.ok(cors > 0 && cors < maintenance && cors < router,
    'CORS runs before maintenance gate and router');
});

test('7. Allow-Headers constant covers what the clients send, nothing native-only', () => {
  for (const h of [
    'Authorization', 'Content-Type', 'X-Idempotency-Key', 'X-Upload-Id',
    'X-Chunk-Index', 'X-Total-Chunks', 'X-Chunk-Size', 'X-File-Name', 'X-Mime-Type',
  ]) {
    assert.ok(ALLOWED_HEADERS.includes(h), 'missing allow-listed header: ' + h);
  }
  assert.ok(!ALLOWED_HEADERS.includes('X-App-Platform'), 'native-only header must stay off');
  assert.ok(!ALLOWED_HEADERS.includes('X-App-Version-Code'), 'native-only header must stay off');
  assert.ok(!ALLOWED_HEADERS.includes('X-Security-Signature'), 'device-evidence header is native-only');
  assert.ok(!ALLOWED_HEADERS.includes('X-Integrity-Hash'), 'integrity header is native-only');
});

// ── 8. Caching correctness ─────────────────────────────────────────────────
test('7b. Retry-After is exposed to cross-origin JS (portal reads 429 wait time)', () => {
  const mw = fs.readFileSync(path.join(__dirname, '..', 'src', 'Middleware', 'CorsMiddleware.php'), 'utf8');
  assert.ok(mw.includes("header('Access-Control-Expose-Headers: Retry-After')"), 'Expose-Headers Retry-After emitted');
});

test('8. Vary: Origin is always sent', () => {
  const vary = mw.indexOf("header('Vary: Origin')");
  assert.ok(vary > 0, 'Vary present');
  assert.ok(vary < mw.indexOf('if ($origin === null'), 'Vary precedes every early return');
});

// ── 9. Dev origins switchable; production origins preserved and merged ─────
test('9. dev origins gated by CORS_ALLOW_DEV_ORIGINS and merged with env list', () => {
  const fn = slice('public static function allowedOrigins', 'public static function normalizeOrigin');
  const envList = fn.indexOf("Config::list('CORS_ALLOWED_ORIGINS'");
  const devGate = fn.indexOf("Config::bool('CORS_ALLOW_DEV_ORIGINS', true)");
  assert.ok(envList > 0, 'env allow-list read');
  assert.ok(devGate > envList, 'configured origins collected first, dev list added after');
  if (fs.existsSync(ENV_EXAMPLE)) {
    const env = fs.readFileSync(ENV_EXAMPLE, 'utf8');
    assert.ok(/^CORS_ALLOWED_ORIGINS=.+medacademy\.site/m.test(env), 'example keeps production origin');
    assert.ok(!/^\s*CORS_ALLOWED_ORIGINS=\*/m.test(env), 'example never uses a wildcard');
    assert.ok(/^CORS_ALLOW_DEV_ORIGINS=true/m.test(env), 'example documents the dev switch');
  }
});

// ── 10. Normalisation cannot smuggle a different origin ────────────────────
test('10. normalisation rejects paths, credentials and non-http schemes', () => {
  assert.ok(mw.includes("$scheme !== 'http' && $scheme !== 'https'"), 'scheme allow-list');
  assert.ok(mw.includes("isset($parts['user'])"), 'userinfo rejected');
  assert.ok(mw.includes("$path !== '' && $path !== '/'"), 'paths rejected');
  assert.ok(mw.includes('rtrim($host'), 'trailing dot normalised');
});

console.log(failed ? `\n${failed} FAILED / ${passed} passed` : `\nALL ${passed} CORS TESTS PASS`);
process.exit(failed ? 1 : 0);
