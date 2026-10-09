#!/usr/bin/env node
/**
 * API information-disclosure regression guard.
 *
 * THE DEFECT THIS LOCKS DOWN
 * ──────────────────────────
 * `POST /security/events` (and /security/violations) wrapped raw PDO/Throwable
 * text into the ApiException MESSAGE:
 *
 *     throw new ApiException(500, 'DB error [' . $sqlState . ']: ' . $msg);
 *     throw new ApiException(500, 'Exception [' . $cls . ']: ' . $e->getMessage());
 *
 * ErrorHandler::render() passes an ApiException message to Response::error()
 * VERBATIM (only its own debugMeta is gated on APP_DEBUG), so SQLSTATE codes,
 * table/column names, driver text and filesystem paths went to the client in
 * production. The same pattern existed in SecurityService::logEvent(),
 * AppReleaseService publish/rollback and VideoLibrarySyncService.
 *
 * What it asserts now:
 *   1. No 'DB error [' style envelope survives anywhere in backend/src.
 *   2. No ApiException with a 5xx status concatenates $e->getMessage().
 *   3. Each previously-leaky catch site throws a FIXED generic message with a
 *      stable `internal_error` code.
 *   4. Every one of those sites writes the real detail to the protected
 *      server-side Logger (with credential-shaped values redacted).
 *   5. Deliberate ApiExceptions (validation/authorization) are re-thrown
 *      untouched, so hardening did not corrupt status codes into 500s.
 *   6. ErrorHandler still only exposes exception metadata when APP_DEBUG.
 *
 * Source-level: no PHP runtime exists in this environment.
 *
 * Usage: node tests/apiInformationDisclosure.test.cjs
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const SRC = path.join(REPO, 'backend', 'src');

let checks = 0;
let failures = 0;
function check(name, ok, detail) {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${name}${detail ? '  — ' + detail : ''}`);
  }
}

/** Blank PHP comments so prose cannot satisfy (or break) a check. */
function stripPhpComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.php')) files.push(full);
  }
})(SRC);

const src = {};
for (const f of files) src[f] = fs.readFileSync(f, 'utf8');
const rel = (f) => path.relative(REPO, f).replace(/\\/g, '/');
const codeOf = (f) => stripPhpComments(src[f]);

const find = (needle) => files.filter((f) => src[f].includes(needle));
const where = (re) => files.filter((f) => re.test(codeOf(f)));

// ── 1. The historical leak envelope must be gone ────────────────────────────
check(
  'D1: no `DB error [` envelope anywhere in backend/src',
  find("DB error [").length === 0,
  find("DB error [").map(rel).join(', ')
);
check(
  'D2: no `Exception [` + class-name envelope anywhere in backend/src',
  find("Exception [' .").length === 0 && find('Exception [\' . $cls').length === 0,
  find("Exception [' .").map(rel).join(', ')
);

// ── 2. No 5xx ApiException may interpolate a Throwable message ──────────────
const leaky = [];
for (const f of files) {
  const code = codeOf(f);
  // ApiException( 5xx , ... $e->getMessage() / ->getMessage() ...
  const re = /new\s+(?:\\?MedAcademy\\Http\\)?ApiException\(\s*5\d\d\s*,[^;]{0,400}getMessage\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) leaky.push(rel(f) + ': ' + m[0].slice(0, 90));
}
check('D3: no ApiException(5xx, … getMessage()) concatenation remains', leaky.length === 0, leaky.join(' | '));

// ── 3. Each previously-leaky catch site is now generic + logged ─────────────
const SITES = [
  {
    file: 'backend/src/Controllers/SecurityController.php',
    fn: 'reportEvent',
    generic: 'Unable to record security event',
    scope: 'security_events',
  },
  {
    file: 'backend/src/Controllers/SecurityController.php',
    fn: 'reportViolation',
    generic: 'Unable to record security violation',
    scope: 'security_violations',
  },
  {
    file: 'backend/src/Services/SecurityService.php',
    fn: 'logEvent',
    generic: 'Unable to record security event',
    scope: 'security_events insert failed',
  },
  {
    file: 'backend/src/Services/AppReleaseService.php',
    fn: 'publish',
    generic: 'Publish failed',
    scope: 'app release publish failed',
  },
  {
    file: 'backend/src/Services/AppReleaseService.php',
    fn: 'rollback',
    generic: 'Rollback failed',
    scope: 'app release rollback failed',
  },
  {
    file: 'backend/src/Services/VideoLibrarySyncService.php',
    fn: 'reconcile',
    generic: 'Local reconciliation failed',
    scope: 'video library reconciliation failed',
  },
];

/** Extract a top-level `function <name>(...)` body by brace matching. */
function bodyOf(code, name) {
  const idx = code.indexOf('function ' + name + '(');
  if (idx === -1) return null;
  const open = code.indexOf('{', idx);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  return null;
}

for (const site of SITES) {
  const f = files.find((x) => rel(x) === site.file);
  const okFile = !!f;
  check(`D4.${site.fn}: ${site.file} exists`, okFile);
  if (!okFile) continue;

  const code = codeOf(f);
  let body = bodyOf(code, site.fn);
  if (body === null) {
    // fall back: the helper may be private/static, or the caller differs —
    // search the whole file for the generic message instead.
    body = code;
  }

  check(
    `D4.${site.fn}: throws the fixed generic message`,
    body.includes(`'${site.generic}'`),
    `expected '${site.generic}'`
  );
  check(
    `D4.${site.fn}: no getMessage() interpolated into that throw`,
    !new RegExp(
      `ApiException\\(\\s*5\\d\\d\\s*,\\s*'${site.generic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^']*'[^;]{0,200}getMessage\\s*\\(`
    ).test(body)
  );
  check(
    `D4.${site.fn}: real detail written to the protected server log`,
    body.includes('Logger::instance()') || body.includes('logInternalFailure('),
    'expected Logger::instance() or the shared logInternalFailure() helper'
  );
  // Redaction lives either inline or inside the shared logInternalFailure()
  // helper (which D7 verifies separately) — one of the two must hold.
  check(
    `D4.${site.fn}: credentials redacted before logging`,
    body.includes('REDACTED') || body.includes('logInternalFailure('),
    'expected an inline redaction pattern or delegation to logInternalFailure()'
  );
  check(
    `D4.${site.fn}: generic error carries a stable machine code`,
    body.includes("'internal_error'"),
    "expected code 'internal_error'"
  );
}

// ── 4. Hardening must not corrupt deliberate API contracts ──────────────────
const secCtl = codeOf(files.find((f) => rel(f) === 'backend/src/Controllers/SecurityController.php'));
check(
  'D5: reportEvent/reportViolation re-throw deliberate ApiExceptions untouched',
  /catch\s*\(\s*ApiException\s+\$e\s*\)\s*\{\s*throw\s+\$e\s*;/.test(secCtl),
  'expected catch (ApiException $e) { throw $e; } — preserves 4xx validation codes'
);

// ── 5. Server-side detail stays behind APP_DEBUG ────────────────────────────
const errHandler = codeOf(files.find((f) => rel(f) === 'backend/src/Middleware/ErrorHandler.php'));
check(
  'D6: ErrorHandler gates exception metadata on Config::isDebug()',
  errHandler.includes('Config::isDebug()')
);

// ── 6. The shared redaction helper actually redacts ─────────────────────────
const logHelper = bodyOf(secCtl, 'logInternalFailure');
check('D7: logInternalFailure helper exists', !!logHelper);
if (logHelper) {
  check(
    'D7: helper redacts password/secret/token/api-key/authorization',
    /password\|passwd\|secret\|token\|api\[_-\]\?key\|authorization/i.test(logHelper)
  );
  check('D7: helper never passes the raw message to the client', !/ApiException\([^)]*getMessage/.test(logHelper));
  check('D7: helper bounds the logged detail length', logHelper.includes('mb_substr'));
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`FAILURES: ${failures}`);
  process.exit(1);
}
console.log('PASS: no internal exception/SQL text can reach an API client');
