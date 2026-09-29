'use strict';
/**
 * Auth failure model — deterministic state-machine tests (Issue 4: random logout).
 *
 * INVARIANT under test: only DEFINITIVE auth failures may clear the session.
 * Every transient condition (network error, timeout, 5xx, 429, maintenance,
 * security-unknown, offline) must PRESERVE the session — a temporary outage
 * can never log the user out.
 *
 * The model module is transpiled in-memory with the project's own TypeScript
 * compiler, so these are BEHAVIORAL tests of the real logic, not string pins.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ ' + msg); }
}

// ── Load the real model through the project's TypeScript ────────────────────
const ts = require(path.join(ROOT, 'node_modules', 'typescript'));
const src = fs.readFileSync(path.join(ROOT, 'src/lib/authFailureModel.ts'), 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText;
const m = { exports: {} };
new Function('module', 'exports', js)(m, m.exports);
const {
  isDefinitiveAuthFailure,
  authFailureScope,
  classifyAuthHttpStatus,
  shouldClearSession,
} = m.exports;

console.log('── Definitive vs transient classification ──');
ok(isDefinitiveAuthFailure('AUTH_INVALID') === true, 'AUTH_INVALID is definitive');
ok(isDefinitiveAuthFailure('AUTH_REVOKED') === true, 'AUTH_REVOKED is definitive');
ok(isDefinitiveAuthFailure('ACCOUNT_BLOCKED') === true, 'ACCOUNT_BLOCKED is definitive');
ok(isDefinitiveAuthFailure('SESSION_EXPIRED') === true, 'SESSION_EXPIRED is definitive');
for (const k of ['NETWORK_ERROR', 'TIMEOUT', 'OFFLINE', 'SERVER_5XX', 'SECURITY_UNKNOWN', 'SECURITY_BLOCKED', 'MAINTENANCE', 'UPDATE_REQUIRED']) {
  ok(isDefinitiveAuthFailure(k) === false, `${k} is transient (never definitive)`);
}
ok(authFailureScope('SERVER_5XX') === 'transient', 'SERVER_5XX scope is transient');
ok(authFailureScope('AUTH_REVOKED') === 'definitive', 'AUTH_REVOKED scope is definitive');

console.log('── HTTP status → kind mapping (auth endpoints) ──');
ok(classifyAuthHttpStatus(401) === 'SESSION_EXPIRED', '401 → SESSION_EXPIRED');
ok(classifyAuthHttpStatus(403) === 'ACCOUNT_BLOCKED', '403 → ACCOUNT_BLOCKED');
ok(classifyAuthHttpStatus(400) === 'AUTH_INVALID', '400 → AUTH_INVALID');
ok(classifyAuthHttpStatus(422) === 'AUTH_INVALID', '422 → AUTH_INVALID');
ok(classifyAuthHttpStatus(500) === 'SERVER_5XX', '500 → SERVER_5XX');
ok(classifyAuthHttpStatus(503) === 'SERVER_5XX', '503 (maintenance shape) → SERVER_5XX transient');
ok(classifyAuthHttpStatus(429) === 'SERVER_5XX', '429 rate-limit → retryable transient');
ok(classifyAuthHttpStatus(undefined) === 'NETWORK_ERROR', 'no status (network/DNS failure) → NETWORK_ERROR');
ok(classifyAuthHttpStatus(null) === 'NETWORK_ERROR', 'null status → NETWORK_ERROR');

console.log('── The logout gate: only definitive kinds clear the session ──');
for (const k of ['AUTH_INVALID', 'AUTH_REVOKED', 'ACCOUNT_BLOCKED', 'SESSION_EXPIRED']) {
  ok(shouldClearSession(k) === true, `${k} clears the session`);
}
for (const k of ['NETWORK_ERROR', 'TIMEOUT', 'OFFLINE', 'SERVER_5XX', 'SECURITY_UNKNOWN', 'MAINTENANCE', 'UPDATE_REQUIRED']) {
  ok(shouldClearSession(k) === false, `${k} PRESERVES the session (no logout)`);
}

console.log('── Session-terminating call sites consult the shared gate ──');
const php = fs.readFileSync(path.join(ROOT, 'src/client/php.ts'), 'utf8');
ok(/import \{ classifyAuthHttpStatus, shouldClearSession \} from '@\/lib\/authFailureModel';/.test(php),
  'php.ts imports the shared model');
ok((php.match(/shouldClearSession\(kind\)/g) || []).length >= 2,
  'php.ts: both refresh failure paths (interceptor + explicit-token) gate through shouldClearSession');
ok(!/status === 401 \|\| status === 400 \|\| status === 422 \|\| status === 403/.test(php),
  'php.ts: no ad-hoc status list remains (single canonical gate)');

console.log(`\nauthFailureModel: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
