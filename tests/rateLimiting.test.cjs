#!/usr/bin/env node
/**
 * Backend rate-limiting contract.
 *
 * WHAT WAS MISSING
 * ────────────────
 * The old helper lived as a PRIVATE method on AuthService and was called from
 * exactly two places: register and login. Every other abuse-prone flow —
 * password reset, refresh-token rotation, challenge issuance, evidence
 * verification, and the four PUBLIC identifier lookups — had no throttle at
 * all.
 *
 * This suite asserts the contract of the shared RateLimitService:
 *   1. Implementation — one fixed-window counter on the existing
 *      `rate_limits` table (no new dependency, no new table).
 *   2. Failure contract — HTTP 429 carrying `rate_limited`, matching what the
 *      client already treats as retryable-but-not-a-logout.
 *   3. Identity trust — Request::clientIp() reads REMOTE_ADDR only, so a
 *      forged X-Forwarded-For cannot select (or escape) a bucket.
 *   4. Coverage — every endpoint named in the hardening pass is throttled.
 *   5. Lockout safety — per-IP ceilings are generous (carrier NAT) and the
 *      per-identifier ceiling for password reset is the tight one.
 *   6. Window semantics — counters are aligned to a fixed window, so a limit
 *      is never permanent: it resets when the window rolls.
 *   7. Independence — login/register keep their historical identifiers and
 *      `auth` operation, so a deploy does not reset live counters, while the
 *      new scopes use their own operation names.
 *
 * Source-level: no PHP runtime exists in this environment.
 *
 * Usage: node tests/rateLimiting.test.cjs
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
const byRel = (r) => files.find((f) => rel(f) === r);

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

// ── 1. Implementation ───────────────────────────────────────────────────────
const svcPath = byRel('backend/src/Services/RateLimitService.php');
check('R1: RateLimitService exists', !!svcPath);
const svc = svcPath ? codeOf(svcPath) : '';

if (svc) {
  check('R1: counts against the existing rate_limits table', svc.includes('INSERT INTO rate_limits'));
  check('R1: increments atomically (ON DUPLICATE KEY UPDATE)', svc.includes('ON DUPLICATE KEY UPDATE request_count = request_count + 1'));
  check(
    'R1: window key matches the schema unique index (identifier, operation, window_start)',
    svc.includes('WHERE identifier = ? AND operation = ? AND window_start = ?')
  );
  check('R1: no new composer dependency introduced', !/composer|require\s*\(/.test(svc));
  check(
    'R1: window is a fixed, self-resetting bucket',
    /intdiv\(\s*time\(\)\s*,\s*\$windowSeconds\s*\)/.test(svc),
    'expected floor(time()/window)*window — guarantees the limit expires'
  );
}

// ── 2. Failure contract ─────────────────────────────────────────────────────
if (svc) {
  check('R2: refuses with HTTP 429', /new\s+ApiException\(\s*429\b/.test(svc));
  check("R2: error code is the historical 'rate_limited'", svc.includes("'rate_limited'"));
  check(
    'R2: message unchanged (clients match on it)',
    svc.includes('Too many attempts. Please try again later.')
  );
}
const phpClient = fs.readFileSync(path.join(REPO, 'src', 'lib', 'authFailureModel.ts'), 'utf8');
check(
  'R2: client treats 429 as retryable, never as a logout',
  /429/.test(phpClient) && /SERVER_5XX/.test(phpClient)
);

// ── 3. Identity trust (no X-Forwarded-For spoofing) ─────────────────────────
const reqPath = byRel('backend/src/Http/Request.php');
const reqCode = reqPath ? codeOf(reqPath) : '';
const clientIpBody = bodyOf(reqCode, 'clientIp') || '';
check('R3: Request::clientIp() exists', !!clientIpBody);
check('R3: clientIp() derives from REMOTE_ADDR only', clientIpBody.includes("$_SERVER['REMOTE_ADDR']"));
check(
  'R3: X-Forwarded-For is never read anywhere in the backend',
  files.filter((f) => /HTTP_X_FORWARDED_FOR|_SERVER\[['"]HTTP_X_FORWARDED_FOR/.test(codeOf(f))).length === 0,
  files.filter((f) => /HTTP_X_FORWARDED_FOR/.test(codeOf(f))).map(rel).join(', ')
);
// Raw source (codeOf() blanks comments — this assertion is ABOUT the comment).
const reqRaw = reqPath ? src[reqPath] : '';
check(
  'R3: the trust policy is documented at the source of truth',
  reqRaw.includes('TRUST POLICY') || reqRaw.includes('attacker-controlled'),
  'expected an explicit X-Forwarded-For trust policy on Request::clientIp()'
);

// ── 4. Coverage of every endpoint in the hardening pass ─────────────────────
const COVERAGE = [
  // [file, function, must-call]
  ['backend/src/Services/AuthService.php', 'register', 'rateLimit('],
  ['backend/src/Services/AuthService.php', 'login', 'rateLimit('],
  ['backend/src/Services/AuthService.php', 'refresh', 'RateLimitService::perIp'],
  ['backend/src/Services/AuthService.php', 'forgotPassword', 'RateLimitService::perIp'],
  ['backend/src/Services/AuthService.php', 'forgotPassword', 'RateLimitService::forKey'],
  ['backend/src/Services/AuthService.php', 'resetPassword', 'RateLimitService::perIp'],
  ['backend/src/Services/AuthService.php', 'changePassword', 'RateLimitService::perAccount'],
  ['backend/src/Controllers/AuthController.php', 'lookup', 'RateLimitService::perIp'],
  ['backend/src/Controllers/AuthController.php', 'preLoginCheck', 'RateLimitService::perIp'],
  ['backend/src/Controllers/RpcController.php', 'getEmailByPhone', 'RateLimitService::perIp'],
  ['backend/src/Controllers/RpcController.php', 'checkRegistrationConflicts', 'RateLimitService::perIp'],
  ['backend/src/Controllers/SecurityEvidenceController.php', 'registerKey', 'RateLimitService::perAccount'],
  ['backend/src/Controllers/SecurityEvidenceController.php', 'challenge', 'RateLimitService::perAccount'],
  ['backend/src/Controllers/SecurityEvidenceController.php', 'submit', 'RateLimitService::perAccount'],
  ['backend/src/Controllers/IntegrityController.php', 'playIntegrity', 'RateLimitService::perAccount'],
  ['backend/src/Controllers/IntegrityController.php', 'appIntegrity', 'RateLimitService::perAccount'],
  ['backend/src/Controllers/SecurityController.php', 'reportEvent', 'RateLimitService::perAccount'],
];

for (const [file, fn, call] of COVERAGE) {
  const f = byRel(file);
  const ok = !!f;
  check(`R4.${fn}: ${file} exists`, ok);
  if (!ok) continue;
  const body = bodyOf(codeOf(f), fn) || '';
  check(`R4.${fn}: throttled (${call})`, body.includes(call), 'no rate limit call found in the function body');
}

// AuthService's legacy helper must delegate rather than duplicate.
const authSvc = codeOf(byRel('backend/src/Services/AuthService.php'));
check(
  'R4: AuthService no longer owns a second, divergent counter implementation',
  authSvc.includes('RateLimitService::legacy(')
);

// ── 5. Lockout safety ───────────────────────────────────────────────────────
if (svc) {
  const num = (accessor) => {
    const b = bodyOf(svc, accessor) || '';
    const m = b.match(/Config::int\(\s*'[^']+'\s*,\s*(\d+)\s*\)/);
    return m ? parseInt(m[1], 10) : null;
  };
  const perIpKeys = [
    'forgotPasswordPerIpPerHour',
    'resetPasswordPerIpPerHour',
    'refreshPerIpPerMinute',
    'identifierLookupPerIpPerMinute',
  ];
  const perId = num('forgotPasswordPerAccountPerHour');
  const lookup = num('identifierLookupPerIpPerMinute');

  for (const k of perIpKeys) {
    const v = num(k);
    check(`R5: ${k} is present and generous`, v !== null && v >= 20, `default=${v}`);
  }
  check(
    'R5: per-identifier forgot-password ceiling is tighter than the per-IP ceiling',
    perId !== null && lookup !== null && perId < lookup,
    `per-account=${perId} per-ip=${lookup}`
  );
  check(
    'R5: operators can disable a single limiter with 0',
    /if\s*\(\s*\$max\s*<=\s*0/.test(svc)
  );
}

// ── 6. Independence of scopes ───────────────────────────────────────────────
if (svc) {
  check(
    "R6: login/register keep operation 'auth' + their historical identifiers (no counter reset)",
    svc.includes("self::hit('auth', $identifier, $max, $windowSeconds);")
  );
  const scopes = [
    'auth_refresh', 'auth_forgot_ip', 'auth_forgot_id', 'auth_reset_ip',
    'auth_change_password', 'identifier_lookup', 'security_challenge',
    'security_evidence', 'security_device_key', 'integrity_play',
    'integrity_app', 'security_events',
  ];
  const all = files.map(codeOf).join('\n');
  for (const s of scopes) {
    check(`R6: scope '${s}' is used by a call site`, all.includes(`'${s}'`));
  }
}

// ── 7. Password-reset lookup identifier is not stored in clear text ─────────
const forgot = bodyOf(authSvc, 'forgotPassword') || '';
check(
  'R7: forgot-password per-identifier bucket stores a hash, not the raw e-mail/phone',
  forgot.includes('hash(\'sha256\'') && forgot.includes('strtolower($identifier)')
);

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`FAILURES: ${failures}`);
  process.exit(1);
}
console.log('PASS: rate limiting covers every abuse-prone endpoint with lockout-safe defaults');
