#!/usr/bin/env node
/**
 * Feature-flag ENFORCEMENT contract (regression guard for the Doctor Earnings bug).
 *
 * The shipped defect was: Super Admin → Feature Flags → "Doctor Earnings" OFF did
 * not stop a doctor, because the flag was asserted on the read paths only and
 * every earnings OPERATION stayed reachable (including by direct API call).
 *
 * This suite is source-level (no PHP binary in this environment) and asserts the
 * architectural invariants that make such a regression impossible:
 *
 *   1. REGISTRY integrity — every flag declares label/description/category/default.
 *   2. NO ORPHAN FLAGS — every registry key is asserted somewhere in the backend,
 *      so a flag can never be a UI-only toggle.
 *   3. Every doctor-callable EARNINGS surface in RpcController is gated by the
 *      shared helper, gate-first (before validation and before any DB write).
 *   4. The helper is staff-exempt and honours per-user overrides (assertEnabledFor).
 *   5. The refusal contract (403 + `feature_disabled` + feature key) is intact.
 *   6. Route→handler contract: no doctor-reachable earnings route is ungated.
 *   7. The client-side availability UX exists (nav gating, blocked message,
 *      re-hydration) — the app never claims availability the server would refuse.
 *
 * Usage: node tests/featureFlagEnforcement.test.cjs
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const BACKEND = path.join(REPO, 'backend');
const SRC = path.join(BACKEND, 'src');

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${name}${detail ? '  — ' + detail : ''}`);
  }
}
const read = (p) => fs.readFileSync(p, 'utf8');

/** Blank out PHP comments so words inside prose can never satisfy a check. */
function stripPhpComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
    .replace(/(^|\s)#[^\n]*/g, '$1');
}

// ── Gather backend sources ───────────────────────────────────────────────────
const phpFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.php')) phpFiles.push(full);
  }
})(SRC);

const sources = {};
for (const f of phpFiles) sources[f] = read(f);
const rel = (f) => path.relative(REPO, f).replace(/\\/g, '/');
const codeOf = (f) => stripPhpComments(sources[f]);

const flagServicePath = path.join(SRC, 'Services', 'FeatureFlagService.php');
const rpcPath = path.join(SRC, 'Controllers', 'RpcController.php');
const dataPath = path.join(SRC, 'Controllers', 'DataController.php');
const errPath = path.join(SRC, 'Middleware', 'ErrorHandler.php');
const routesPath = path.join(BACKEND, 'routes', 'api.php');

check('FeatureFlagService exists', fs.existsSync(flagServicePath));
check('RpcController exists', fs.existsSync(rpcPath));
check('routes/api.php exists', fs.existsSync(routesPath));

const flagSrc = read(flagServicePath);
const flagCode = stripPhpComments(flagSrc);

// ── 1. REGISTRY integrity ────────────────────────────────────────────────────
const registryStart = flagSrc.indexOf('const REGISTRY');
const registrySeg = flagSrc.slice(registryStart, flagSrc.indexOf('];', registryStart));
const registryKeys = [];
{
  const re = /^\s{8}'([a-z0-9_]+)'\s*=>/gm;
  let m;
  while ((m = re.exec(registrySeg)) !== null) registryKeys.push(m[1]);
}
check('registry declares feature flags', registryKeys.length >= 15, `found ${registryKeys.length}`);
check('registry contains the canonical doctor_earnings key', registryKeys.includes('doctor_earnings'));

for (const key of registryKeys) {
  const block = registrySeg.slice(registrySeg.indexOf(`'${key}' =>`));
  const next = block.slice(1).search(/^\s{8}'[a-z0-9_]+'\s*=>/m);
  const body = next === -1 ? block : block.slice(0, next + 1);
  check(`registry[${key}] declares label/description/category/default`,
    /'label'\s*=>/.test(body) && /'description'\s*=>/.test(body) &&
    /'category'\s*=>/.test(body) && /'default'\s*=>/.test(body));
}

// ── 2. NO ORPHAN FLAGS — every flag is asserted somewhere ────────────────────
const callSiteSources = { __all: '' };
for (const f of phpFiles) callSiteSources[f] = codeOf(f);
callSiteSources.__all = phpFiles.map((f) => codeOf(f)).join('\n');

// Flags whose enforcement lives in a service (AuthService) still count.
const orphans = [];
for (const key of registryKeys) {
  const pattern = new RegExp(String.raw`assertEnabled(?:For)?\s*\(\s*'${key}'`);
  if (!pattern.test(callSiteSources.__all)) orphans.push(key);
}
check('no orphan (UI-only) flags — every registry key is asserted server-side',
  orphans.length === 0, orphans.join(', '));

const earningsCallSites = (callSiteSources.__all.match(/assertEnabled(?:For)?\s*\(\s*'doctor_earnings'|assertDoctorEarningsEnabled\s*\(\s*\$request\s*\)/g) || []).length;
check('doctor_earnings is asserted on the shared read path AND the earnings surfaces',
  /assertEnabledFor\s*\(\s*'doctor_earnings'/.test(callSiteSources[dataPath] || '') && earningsCallSites >= 2,
  `call sites: ${earningsCallSites}`);

// ── 3. Every doctor-callable earnings surface is gated, gate-first ───────────
const rpcCode = codeOf(rpcPath);
const rpcRaw = sources[rpcPath];

function methodBody(code, name) {
  const re = new RegExp(String.raw`public function ${name}\s*\(Request \$request\)`);
  const m = re.exec(code);
  if (!m) return null;
  const start = m.index;
  const nextPublic = code.slice(m.index + 10).search(/\n\s*(?:public|private|protected) function /);
  return code.slice(start, nextPublic === -1 ? code.length : m.index + 10 + nextPublic);
}

const EARNINGS_SURFACES = [
  'doctorActivityStats',
  'doctorCreditTransactions',
  'doctorEarningsDashboard',
  'doctorStudentProfile',
  'setEnrollmentAssignedPrice',
  'removeStudentAndRecordEarnings',
];

for (const name of EARNINGS_SURFACES) {
  const body = methodBody(rpcCode, name);
  check(`RpcController::${name}() exists`, body !== null);
  if (!body) continue;
  const gateIdx = body.indexOf('assertDoctorEarningsEnabled($request)');
  check(`RpcController::${name}() is gated by the shared earnings helper`, gateIdx !== -1);

  if (gateIdx !== -1) {
    // gate-first: no DB write and no parameter validation before the gate
    const writeIdx = [body.indexOf('->insert('), body.indexOf('->update('), body.indexOf('->query(')]
      .filter((i) => i >= 0).reduce((a, b) => Math.min(a, b), Number.MAX_SAFE_INTEGER);
    check(`RpcController::${name}() gate runs before any DB write`, gateIdx < writeIdx);
    const throwIdx = body.indexOf('throw new ApiException');
    check(`RpcController::${name}() gate runs before parameter validation`, throwIdx === -1 || gateIdx < throwIdx);
  }
}

const helperMatch = rpcCode.match(/private function assertDoctorEarningsEnabled\(Request \$request\): void\s*\{([\s\S]*?)\n    \}/);
check('RpcController declares the shared earnings gate helper', !!helperMatch);
if (helperMatch) {
  const helper = helperMatch[1];
  check('earnings gate helper is staff-exempt (admin/super_admin keep console access)',
    /super_admin/.test(helper) && /admin/.test(helper) && /return;/.test(helper));
  check('earnings gate helper honours per-user overrides (assertEnabledFor, not assertEnabled)',
    /assertEnabledFor\s*\(\s*'doctor_earnings'/.test(helper) && !/assertEnabled\s*\(\s*'doctor_earnings'/.test(helper));
  check('earnings gate helper performs no DB write (read-only policy)',
    !/->(insert|update|query|delete)\(/.test(helper));
}

const exactGates = (rpcCode.match(/assertDoctorEarningsEnabled\(\$request\);/g) || []).length;
check('exactly one gate per earnings surface (6 call sites)', exactGates === EARNINGS_SURFACES.length,
  `found ${exactGates}`);

// ── 4. Refusal contract ──────────────────────────────────────────────────────
const errCode = codeOf(errPath);
check('ErrorHandler maps FeatureDisabledException to code feature_disabled',
  /FeatureDisabledException/.test(errCode) && /feature_disabled/.test(errCode));
check('ErrorHandler exposes the flag key on the refusal (error.feature)',
  /'feature'\s*=>\s*\$e->feature/.test(errCode) || /'feature' => \$e->feature/.test(sources[errPath]));

const flagErrPath = path.join(SRC, 'Http', 'FeatureDisabledException.php');
check('FeatureDisabledException exists', fs.existsSync(flagErrPath));
if (fs.existsSync(flagErrPath)) {
  const fe = stripPhpComments(read(flagErrPath));
  check('FeatureDisabledException is HTTP 403 + feature_disabled', /403/.test(fe) && /feature_disabled/.test(fe));
}

check('FeatureFlagService throws FeatureDisabledException (never a bare 403)',
  /throw new FeatureDisabledException/.test(flagCode));
check('FeatureFlagService fails OPEN on unknown keys (availability beats configuration)',
  /unknown key[^\n]*fail open|\$meta === null[\s\S]{0,120}?return true;/.test(flagCode) ||
  /REGISTRY\[\$key\] \?\? null;[\s\S]{0,80}?return true;/.test(flagCode));
check('FeatureFlagService declares a bounded cache TTL (flag changes propagate)',
  /CACHE_TTL\s*=\s*\d+/.test(flagCode));

// ── 5. Route → handler contract: no ungated doctor earnings route ────────────
const routesCode = stripPhpComments(read(routesPath));
const routeLines = routesCode.split('\n').filter((l) => l.includes('$router->'));
const GATED_HANDLERS = new Set(EARNINGS_SURFACES);
const ungated = [];
for (const line of routeLines) {
  const pathMatch = line.match(/'(?:get|post|put|delete|patch)'\s*,\s*'([^']+)'/);
  const ctrlMatch = line.match(/\[(\w+Controller)::class,\s*'(\w+)'\]/);
  if (!pathMatch || !ctrlMatch) continue;
  const [, route, handler] = [null, pathMatch[1].toLowerCase(), ctrlMatch[2]];
  const isEarningsRoute = /doctor-earnings|doctor-credit|doctor-activity|doctor-student-profile|assigned-price|record-earnings/.test(route);
  if (!isEarningsRoute) continue;
  const roleMatch = line.match(/'role'\s*=>\s*\[([^\]]*)\]/);
  const roles = roleMatch ? roleMatch[1] : '';
  const doctorReachable = roles.includes('doctor');
  if (doctorReachable && !GATED_HANDLERS.has(handler)) ungated.push(`${route} → ${handler}`);
}
check('every doctor-reachable earnings route maps to a gated handler', ungated.length === 0, ungated.join('; '));

const earningsRouteCount = routeLines.filter((l) => /doctor-earnings-dashboard|doctor-credit-transactions|doctor-activity-stats|doctor-student-profile|set-enrollment-assigned-price|remove-student-and-record-earnings/.test(l)).length;
check('the six earnings routes are still mounted (contract unchanged)',
  earningsRouteCount === EARNINGS_SURFACES.length, `found ${earningsRouteCount}`);

// ── 6. Client-side availability UX ───────────────────────────────────────────
const clientFlagsPath = path.join(REPO, 'src', 'lib', 'featureFlags.ts');
check('client flag helper exists', fs.existsSync(clientFlagsPath));
if (fs.existsSync(clientFlagsPath)) {
  const clientFlags = read(clientFlagsPath);
  check('client exposes isFeatureEnabled()', /isFeatureEnabled/.test(clientFlags));
  check('client exposes ensureFeatureFlagsFresh() for propagation without reinstall',
    /ensureFeatureFlagsFresh/.test(clientFlags));
  check('client treats 403 feature_disabled as an availability state',
    /feature_disabled/.test(clientFlags));
}

const earningsScreen = path.join(REPO, 'src', 'app', '(app)', '(doctor)', 'dr-earnings.tsx');
check('doctor earnings screen exists', fs.existsSync(earningsScreen));
if (fs.existsSync(earningsScreen)) {
  const screen = read(earningsScreen);
  // Localization moved the sentence into the dictionary: the screen must render
  // the unavailable key, and the English resources must still hold the exact
  // user-safe sentence (so the message is both shipped and translatable).
  const strings = read(path.join(REPO, 'src', 'lib', 'i18n', 'resources.ts'));
  check('earnings screen renders a user-safe unavailability message',
    /t\('drProfile\.featureUnavailable'\)/.test(screen) && /currently unavailable/i.test(strings));
  check('earnings screen does NOT leak technical detail in that message',
    !/feature_disabled[^"'`]{0,40}message/i.test(screen));
  check('earnings screen checks the platform flag (not only the doctor toggle)',
    /doctor_earnings/.test(screen));
}

const drawerPath = path.join(REPO, 'src', 'components', 'DrawerNav.tsx');
check('drawer nav exists', fs.existsSync(drawerPath));
if (fs.existsSync(drawerPath)) {
  const drawer = read(drawerPath);
  check("drawer nav gates the Earnings entry on the platform flag",
    /isFeatureEnabled\(\s*'doctor_earnings'\s*\)/.test(drawer));
}

console.log(failures
  ? `\n${failures} of ${checks} feature-flag enforcement checks FAILED`
  : `PASS: ${checks} feature-flag enforcement checks (registry, per-flag call sites, earnings gates, refusal contract, routes, client UX)`);
process.exit(failures ? 1 : 0);
