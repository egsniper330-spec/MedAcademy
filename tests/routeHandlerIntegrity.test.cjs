/**
 * Regression test — ROUTE ↔ HANDLER INTEGRITY (the partial-deploy 500).
 *
 * Run: node tests/routeHandlerIntegrity.test.cjs
 *
 * ─── THE DEFECT THIS PINS ───────────────────────────────────────────────────
 *
 * Production reported:
 *
 *   GET /security/policies → HTTP 500 {"error":{"code":"internal_error"}}
 *
 * while every sibling route on the SAME controller worked:
 *
 *   GET /security/config   → 200
 *   GET /security/version  → 200
 *   GET /video-providers   → 200
 *   POST /auth/login       → 200
 *
 * The route resolved (so it was NOT a 404) and the controller class loaded (so
 * construction was fine), yet the request failed. Probing production directly
 * ruled out the data layer: `security_policies` returns rows with exactly the
 * columns the handler selects, and `security_vpn_whitelist.name` exists (an
 * unknown column was confirmed to reproduce the identical generic 500).
 *
 * The real cause is a MIXED FILE SET on the server: `policies()` and its route
 * both landed in the same commit, so a deployment that uploaded the newer
 * `routes/api.php` but kept an older `SecurityController.php` yields a route
 * whose handler cannot be called. `Router::add` resolved the pair to a closure
 * that called the method directly, so PHP raised
 *
 *   Error: Call to undefined method ...SecurityController::policies()
 *
 * which is not an ApiException and therefore rendered as the opaque
 * `internal_error` body (ErrorHandler's debug-off branch) — no file, no line,
 * no clue that a single stale file was at fault.
 *
 * ─── WHAT IS PINNED HERE ────────────────────────────────────────────────────
 *
 *  A. EVERY route handler in routes/api.php resolves to a controller FILE that
 *     exists and defines that exact METHOD. This is the check that would have
 *     caught the bad deploy before it reached production.
 *  B. No duplicate METHOD+path route is registered (a silently shadowed route
 *     is the same class of undiagnosable failure).
 *  C. The specific production route /security/policies is wired to a method
 *     that exists, and every /security/* route handler is present.
 *  D. The router now GUARDS dispatch: a missing class/method is reported as a
 *     machine-readable `handler_unavailable` 500 naming the handler (instead of
 *     an anonymous internal_error), it is logged, and it fails only the one
 *     route — never the whole API.
 *  E. The migrations the release depends on are present in the tree.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');
const ROUTES = path.join(BACKEND, 'routes', 'api.php');

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.log('  ✗ ' + msg); }
}
function read(abs) {
  return fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
}
function exists(rel) {
  return fs.existsSync(path.isAbsolute(rel) ? rel : path.join(ROOT, rel));
}

const routesSrc = read(ROUTES);

/* ── A. resolve every [Controller::class, 'method'] handler ───────────────── */

// `use MedAcademy\Controllers\X;` → short name → source file
const imports = new Map();
for (const m of routesSrc.matchAll(/^use\s+([A-Za-z0-9_\\]+)\\(\w+);/gm)) {
  const [, nsPath, short] = m;
  const rel = path.join(BACKEND, 'src', ...nsPath.replace(/^MedAcademy\\?/, '').split('\\').filter(Boolean), short + '.php');
  imports.set(short, rel);
}

// `[X::class, 'method']` — the only handler form used in this file
const handlers = [];
for (const m of routesSrc.matchAll(/\[\\?([A-Za-z0-9_\\]+)::class,\s*'([a-zA-Z0-9_]+)'\]/g)) {
  handlers.push({ token: m[1], method: m[2] });
}

ok(handlers.length >= 170, `route handlers discovered (found ${handlers.length}, expected the full route table)`);

// Resolve a class token to a file: import map first, then a search of src/.
function resolveFile(token) {
  const short = token.split('\\').pop();
  if (imports.has(short)) return imports.get(short);
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === short + '.php') hits.push(p);
    }
  };
  walk(path.join(BACKEND, 'src'));
  return hits[0] || null;
}

const missingClass = [];
const missingMethod = [];
const perClass = new Map();

for (const { token, method } of handlers) {
  const short = token.split('\\').pop();
  const file = resolveFile(token);
  if (!file || !fs.existsSync(file)) { missingClass.push(short); continue; }
  const src = read(file);
  const hasMethod = new RegExp(`function\\s+${method}\\s*\\(`).test(src);
  if (!hasMethod) missingMethod.push(`${short}::${method}`);
  perClass.set(short, (perClass.get(short) || 0) + 1);
}

ok(missingClass.length === 0,
  `every routed controller file exists (missing: ${missingClass.join(', ') || 'none'})`);
ok(missingMethod.length === 0,
  `every routed handler method is implemented (missing: ${missingMethod.join(', ') || 'none'})`);

/* ── B. no shadowed (duplicate METHOD+path) route ─────────────────────────── */

const seen = new Map();
const dups = [];
for (const m of routesSrc.matchAll(/->(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
  const key = m[1].toUpperCase() + ' ' + m[2];
  if (seen.has(key)) dups.push(key);
  else seen.set(key, true);
}
ok(seen.size >= 170, `route table parsed (${seen.size} method+path pairs)`);
ok(dups.length === 0, `no duplicate routes registered (duplicates: ${dups.join(', ') || 'none'})`);

/* ── C. the production failure, specifically ──────────────────────────────── */

ok(/->get\('\/security\/policies',\s*\[SecurityController::class,\s*'policies'\]/.test(routesSrc),
  'route GET /security/policies is wired to SecurityController::policies');

const secCtrl = path.join(BACKEND, 'src', 'Controllers', 'SecurityController.php');
ok(exists(secCtrl), 'SecurityController.php exists in the tree');
const secSrc = read(secCtrl);
ok(/public function policies\(Request \$request\): array/.test(secSrc),
  'SecurityController declares policies(Request): array (the method the route calls)');

// Contract preservation: the handler must still read the real policy tables and
// return the same shape — a fix for the 500 must not stub the endpoint.
ok(/FROM security_policies/.test(secSrc), 'policies() still reads security_policies');
ok(/FROM security_vpn_whitelist/.test(secSrc), 'policies() still reads security_vpn_whitelist');
ok(/'policies'\s*=>\s*\$policies/.test(secSrc) && /'vpn_whitelist'\s*=>\s*\$vpnWhitelist/.test(secSrc),
  'policies() preserves the { policies, vpn_whitelist } response contract');
ok(!/return\s*\[\s*\]\s*;/.test(secSrc.match(/public function policies[\s\S]*?\n    \}/)[0]),
  'the 500 was not "fixed" by returning an empty success payload');

// Every /security/* route handler must exist (this controller family was the one
// left stale on the server).
const secRoutes = [...routesSrc.matchAll(/->(get|post|put|patch|delete)\('(\/security\/[^']*)',\s*\[(\w+)::class,\s*'(\w+)'\]/g)];
ok(secRoutes.length >= 8, `/security/* routes found (${secRoutes.length})`);
for (const [, verb, pattern, cls, fn] of secRoutes) {
  const file = resolveFile(cls);
  ok(!!file && fs.existsSync(file), `${verb.toUpperCase()} ${pattern}: ${cls} file present`);
  ok(!!file && new RegExp(`function\\s+${fn}\\s*\\(`).test(read(file)),
    `${verb.toUpperCase()} ${pattern}: ${cls}::${fn} implemented`);
}

/* ── D. the dispatch guard that makes this diagnosable ────────────────────── */

const router = read(path.join(BACKEND, 'src', 'Http', 'Router.php'));
ok(/class_exists\(\$class\)\s*\|\|\s*!method_exists\(\$class, \$methodName\)/.test(router),
  'Router checks class_exists + method_exists before calling a route handler');
ok(/throw new HandlerUnavailableException\(/.test(router),
  'Router throws HandlerUnavailableException for an unimplemented handler');
ok(/->logger->error\('Route handler unavailable'/.test(router),
  'the mismatch is logged (handler + path + which lookup failed)');
ok(!/if \(is_array\(\$handler\)\) \{\s*\[.+\] = \$handler;\s*\$handler = static function/.test(router),
  'the handler closure is no longer a bare unchecked static call');

const closureAt = router.indexOf('$handler = function (Request $request) use ($class, $methodName)');
const guardAt = router.indexOf('method_exists($class, $methodName)');
const ctorAt = router.indexOf('new $class();');
ok(closureAt > 0, 'array handlers resolve into the dispatching closure');
ok(guardAt > closureAt && ctorAt > guardAt, 'the guard runs inside the closure, before the controller is called');
ok(/\$result = \$handler\(\$this->request\);/.test(router),
  'dispatch invokes that guarded closure — a mismatched file fails one route, not registration of the whole API');

const exc = path.join(BACKEND, 'src', 'Http', 'HandlerUnavailableException.php');
ok(exists(exc), 'HandlerUnavailableException.php exists');
const excSrc = read(exc);
ok(/final class HandlerUnavailableException extends ApiException/.test(excSrc),
  'HandlerUnavailableException extends ApiException (travels the normal error pipeline)');
ok(/parent::__construct\(500, \$detail, 'handler_unavailable'\)/.test(excSrc),
  'it is a hard 500 carrying the machine-readable code handler_unavailable');
ok(/public readonly string \$handler/.test(excSrc), 'it exposes the offending handler for the response meta');

const err = read(path.join(BACKEND, 'src', 'Middleware', 'ErrorHandler.php'));
ok(/HandlerUnavailableException\)\s*\{\s*\$code = 'handler_unavailable';/.test(err),
  "ErrorHandler maps the exception to code 'handler_unavailable'");
ok(/array_merge\(\$meta, \['handler' => \$e->handler\]\)/.test(err),
  'ErrorHandler includes the handler in the response meta');
ok(/\$logger->error\('Unhandled exception'/.test(err) && /Config::isDebug\(\)/.test(err),
  'unhandled errors are still logged and internals stay hidden unless APP_DEBUG');

/* ── E. release dependencies present in the tree ──────────────────────────── */

ok(exists('backend/database/mysql-migrations/025_audit_actions_platform_console.sql'),
  'migration 025 (audit actions for the platform console) is present');
ok(exists('backend/database/mysql-migrations/026_contact_links.sql'),
  'migration 026 (contact_links) is present');

const mig025 = read(path.join(BACKEND, 'database', 'mysql-migrations', '025_audit_actions_platform_console.sql'));
ok(/DROP CONSTRAINT|DROP CHECK|chk_audit_logs_action/.test(mig025),
  '025 targets the audit-log action constraint (no data is rewritten)');
const mig026 = read(path.join(BACKEND, 'database', 'mysql-migrations', '026_contact_links.sql'));
ok(/ADD COLUMN\s+`?contact_links`?/i.test(mig026),
  '026 adds the contact_links column additively');

/* ── report ───────────────────────────────────────────────────────────────── */

console.log('──────────────────────────────────────────────');
console.log(`routed controllers checked: ${perClass.size} · handler methods checked: ${handlers.length}`);
if (failed === 0) {
  console.log(`RESULT: ${passed} passed, 0 failed`);
  console.log('ALL ROUTE HANDLER INTEGRITY TESTS PASSED');
} else {
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  FAILED: ' + f);
  process.exit(1);
}
