#!/usr/bin/env node
/**
 * Server-side security enforcement (trusted vs untrusted evidence).
 *
 * THE QUESTION THIS ANSWERS
 * ─────────────────────────
 * "If I decompile the APK, strip the VPN detector, the root detector, the
 *  SecurityGate and the integrity plumbing, what still stops the modified app
 *  from reaching protected MedAcademy APIs?"
 *
 * The answer must be: PHP authorization against the database, plus the
 * fail-closed verification services — never anything the client asserts.
 *
 * What it asserts:
 *   A. Client security telemetry is normalized and never grants privilege.
 *   B. Each enforcement gate is opt-in and fails CLOSED (never open).
 *   C. Play Integrity verification fails closed without server credentials
 *      and on every validation mismatch; omitting the header cannot satisfy
 *      an enforced action.
 *   D. App Attest has NO success path without cryptographic verification.
 *   E. Signed device evidence: omission cannot satisfy an enforced action.
 *   F. Authorization is server-side, runs before the handler, and derives
 *      identity from the verified token — not from request input.
 *   G. The priority IDOR/BOLA routes gate on enrollment / role / ownership.
 *
 * Source-level: no PHP runtime exists in this environment.
 *
 * Usage: node tests/serverSideSecurityEnforcement.test.cjs
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const SRC = path.join(REPO, 'backend', 'src');
const BACKEND = path.join(REPO, 'backend');
const ROUTES = path.join(BACKEND, 'routes', 'api.php');

let checks = 0;
let failures = 0;
function check(name, ok, detail) {
  checks++;
  if (!ok) {
    failures++;
    console.log('FAIL ' + name + (detail ? '  — ' + detail : ''));
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
const read = (r) => {
  const f = byRel(r);
  return f ? codeOf(f) : '';
};
const raw = (r) => {
  const f = byRel(r);
  return f ? src[f] : '';
};

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

const routesRaw = fs.readFileSync(ROUTES, 'utf8');
const routeLine = (needle) => routesRaw.split('\n').find((l) => l.includes(needle)) || '';

// ═══════════════════════════════════════════════════════════════════════════
// A. Client security telemetry is untrusted
// ═══════════════════════════════════════════════════════════════════════════
const svcCode = read('backend/src/Services/SecurityService.php');
const logEvent = bodyOf(svcCode, 'logEvent') || '';
check('A1: SecurityService::logEvent found', logEvent.length > 0);
check('A1: risk_score is clamped to 0..100 before storage (no negative/huge input)', /max\(\s*0\s*,\s*min\(\s*100\s*,/.test(logEvent));
check('A1: policy_action is restricted to the schema vocabulary', logEvent.includes("'warn_only'") && logEvent.includes("'block_video'") && logEvent.includes("'block_login'"));
check('A1: event_type is truncated to the VARCHAR(25) column limit', /mb_substr\(\s*\$eventType\s*,\s*0\s*,\s*25\s*\)/.test(logEvent));
check('A1: malformed metadata cannot persist a boolean instead of JSON', /is_string\(\s*\$encoded\s*\)/.test(logEvent));
check('A1: device_id is bounded to the VARCHAR(191) column length', /mb_substr\(\s*\(string\)\s*\$row\['device_id'\],\s*0,\s*191\s*\)/.test(logEvent));
check('A1: every stored field is normalized before the INSERT', /\$deviceId,\s*\n\s*\$platform,\s*\n\s*\$appVersion,\s*\n\s*\$ipAddress,/.test(logEvent));

const secCtl = read('backend/src/Controllers/SecurityController.php');
const reportEvent = bodyOf(secCtl, 'reportEvent') || '';
check('A2: server-observed IP overrides the client-claimed ip_address', reportEvent.includes('$event[\'ip_address\'] = $request->clientIp()'));
check('A2: session device_id overrides the client-claimed device_id', /event\['device_id'\]\s*=\s*\$sessionDevice/.test(reportEvent));

// Enforcement gates are DEFINED in the security services and CALLED from
// controllers. Stored events may only become a decision inside the opt-in,
// per-user, operator-gated risk aggregator.
const DECISION_GATES = ['assertRiskAllowed', 'assertEvidenceAllowed', 'assertActionAllowed'];
const gateDefiners = files.filter((f) => DECISION_GATES.some((g) => new RegExp('function\\s+' + g + '\\s*\\(').test(codeOf(f))));
check(
  'A3: every enforcement gate is defined in a security Service',
  gateDefiners.length === 3 && gateDefiners.every((f) => rel(f).startsWith('backend/src/Services/')),
  gateDefiners.map(rel).join(', ')
);
const gateCallers = files.filter((f) => DECISION_GATES.some((g) => codeOf(f).includes(g + '(')) && !gateDefiners.includes(f));
check(
  'A3: enforcement gates are only invoked by controllers',
  gateCallers.length > 0 && gateCallers.every((f) => rel(f).startsWith('backend/src/Controllers/')),
  gateCallers.map(rel).join(', ')
);

// Whatever reads `security_events`, only the risk aggregator turns it into a
// verdict. The others are aggregate display for the admin dashboard.
const eventReaders = files.filter((f) => /FROM security_events/.test(codeOf(f)));
check('A3: security_events readers were found', eventReaders.length >= 2, eventReaders.map(rel).join(', '));
const gatingReaders = eventReaders.filter((f) => DECISION_GATES.some((g) => codeOf(f).includes(g)));
check(
  'A3: only SecurityRiskService turns stored events into a decision',
  gatingReaders.length === 1 && rel(gatingReaders[0]) === 'backend/src/Services/SecurityRiskService.php',
  gatingReaders.map(rel).join(', ')
);

const analyticsCode = codeOf(byRel('backend/src/Controllers/AnalyticsController.php'));
check(
  'A3: the Security Dashboard reader is aggregate-only, never a gate',
  /FROM security_events/.test(analyticsCode) &&
    !DECISION_GATES.some((g) => analyticsCode.includes(g)) &&
    /COUNT\(/.test(analyticsCode)
);
const riskCode = read('backend/src/Services/SecurityRiskService.php');
const riskPolicy = bodyOf(riskCode, 'policy') || '';
check("A3: the risk engine defaults to disabled", /'enabled'\s*=>\s*false/.test(riskPolicy));
check('A3: the risk engine only ever aggregates the CALLER\'S own events', /WHERE user_id = \?/.test(riskCode));
check('A3: an unenforced tier returns before any scoring', /if\s*\(!\$p\['enabled'\]\s*\|\|\s*\$tier\s*!==\s*'enforce'\)/.test(riskCode));

// ═══════════════════════════════════════════════════════════════════════════
// B. Every gate is opt-in and fails CLOSED
// ═══════════════════════════════════════════════════════════════════════════
const schemaFiles = ['schema.sql', 'schema-no-triggers.sql'];
for (const sf of schemaFiles) {
  const s = fs.readFileSync(path.join(BACKEND, 'database', sf), 'utf8');
  check(
    'B1: ' + sf + ' seeds play_integrity_enabled as OFF (0)',
    /`play_integrity_enabled`\s+TINYINT\(1\)\s+DEFAULT 0/.test(s)
  );
}
const integrityCode = read('backend/src/Services/IntegrityService.php');
const integrityPolicy = bodyOf(integrityCode, 'policy') || '';
// Whitespace-insensitive: the table was re-aligned when 'material_pdf' was added.
check(
  'B2: integrity policy default actions are log_only',
  /['"]vdo_otp['"]\s*=>\s*['"]log_only['"]/.test(integrityPolicy)
    && /['"]material_pdf['"]\s*=>\s*['"]log_only['"]/.test(integrityPolicy)
);
check('B2: integrity enforcement requires enabled AND tier==enforce', /\$policy\['enabled'\]/.test(bodyOf(integrityCode, 'assertActionAllowed') || ''));
check('B2: a MISSING hash can never satisfy an enforced action (no client input consulted at log_only)', /if\s*\(\$hash\s*!==\s*null\s*&&\s*\$hash\s*!==\s*''\)/.test(integrityCode));

const evidenceCode = read('backend/src/Services/SecurityEvidenceService.php');
check('B3: device-evidence default actions are log_only', /'vdo_otp'\s+=>\s*'log_only'/.test(bodyOf(evidenceCode, 'policy') || ''));
check('B3: enforce_strict requires a server-VERIFIED (TRUSTED) key', /enforce_strict[\s\S]{0,200}\['TRUSTED'\]/.test(evidenceCode));
check(
  'B3: a decision row rejected on server-anchored integrity can never authorize, at ANY tier',
  /integrity_state'\]\s*\?\?\s*''\)\s*===\s*'rejected'/.test(evidenceCode)
);

// ═══════════════════════════════════════════════════════════════════════════
// C. Play Integrity fails closed
// ═══════════════════════════════════════════════════════════════════════════
const verifyBody = bodyOf(integrityCode, 'verifyToken') || '';
check('C1: no service-account credential → HTTP 503 (not a pass)', /GOOGLE_SERVICE_ACCOUNT_JSON/.test(verifyBody) && /ApiException\(\s*503/.test(verifyBody));
const googleBody = bodyOf(integrityCode, 'decodeWithGoogle') || '';
check('C1: Google decode also refuses 503 without credentials', /ApiException\(\s*503/.test(googleBody));
check('C1: a Google-side outage fails CLOSED', /ApiException\(\s*503,\s*'Integrity verification unavailable'/.test(googleBody));

check('C2: requestHash is compared with hash_equals (anti-replay, no timing oracle)', /hash_equals\(\s*\$requestHash/.test(verifyBody));
check('C2: package name is validated server-side', /requestPackageName/.test(verifyBody));
check('C2: app recognition verdict is validated', /appRecognitionVerdict/.test(verifyBody));
check('C2: signing certificate digest is validated', /certificateSha256Digest/.test(verifyBody));
check('C2: device integrity verdict is validated', /deviceRecognitionVerdict/.test(verifyBody));
check('C2: the challenge is consumed single-use', /UPDATE play_integrity_nonces SET consumed_at/.test(verifyBody));
check('C2: the verdict row is bound to (user, action, request_hash) with a TTL', /INSERT INTO play_integrity_verdicts/.test(verifyBody) && /DATE_ADD\(UTC_TIMESTAMP\(6\), INTERVAL \? SECOND\)/.test(verifyBody));

// ═══════════════════════════════════════════════════════════════════════════
// D. App Attest has no fake success path
// ═══════════════════════════════════════════════════════════════════════════
const integCtl = read('backend/src/Controllers/IntegrityController.php');
const appIntegrity = bodyOf(integCtl, 'appIntegrity') || '';
check('D1: attest_key / verify_assertion / verify all fail closed with 503', /'attest_key',\s*'verify_assertion',\s*'verify'\s*=>\s*throw new ApiException\(\s*503/.test(appIntegrity));
check('D1: only the challenge action succeeds without Apple credentials', /'get_nonce',\s*'get_challenge'\s*=>/.test(appIntegrity));
check('D1: an unknown/DeviceCheck action does not silently pass', /default\s*=>\s*throw new ApiException\(\s*422/.test(appIntegrity));
check(
  'D1: no branch of appIntegrity returns passed=true',
  !/passed'\s*=>\s*true/.test(appIntegrity)
);

// The iOS client must treat an unavailable verifier as "skip", never as "pass".
const securityTs = fs.readFileSync(path.join(REPO, 'src', 'lib', 'security.ts'), 'utf8');
check('D2: iOS assertion verification requires an explicit passed===true', /verifyData\?\.passed\s*===\s*true/.test(securityTs));
// Both integrity flows (Android Play Integrity, iOS App Attest) must treat a
// verify error as a NON-BLOCKING, NON-PASS outcome. This pins the SEMANTICS
// rather than one literal line: every `if (verifyErr)` branch has to classify
// the error and exit with a null-ish (non-blocking) result. It covers BOTH
// flows — the previous single-line pattern only matched one of them.
check(
  'D2: a verify error is non-blocking (skip), never a pass',
  (securityTs.match(
    /if \(verifyErr\) \{[\s\S]{0,300}?classifyIntegrityError\(verifyErr,[\s\S]{0,200}?return (?:null|finishUnverified\(\));/g,
  ) || []).length >= 2,
);
check(
  'D2: no verify-error branch records a pass',
  !/if \(verifyErr\) \{[\s\S]{0,250}?'passed'/.test(securityTs),
);
check(
  'D2: the unverified exit is typed to return null (cannot return a threat)',
  /const finishUnverified = \(\): null => \{/.test(securityTs),
);
check('D2: DeviceCheck token path also requires an explicit passed===true', /dcData\?\.passed\s*===\s*true/.test(securityTs));

// ═══════════════════════════════════════════════════════════════════════════
// E. Signed device evidence — omission cannot satisfy an enforced action
// ═══════════════════════════════════════════════════════════════════════════
const assertEvidence = bodyOf(evidenceCode, 'assertEvidenceAllowed') || '';
check(
  'E1: enforce tiers throw 403 when no valid evidence id is presented',
  /throw new ApiException\(\s*403,\s*'This action requires a verified device security check/.test(assertEvidence)
);
check(
  'E1: the only non-throwing exit is the explicit ok path',
  /if\s*\(\$ok\)\s*\{\s*return;\s*\}/.test(assertEvidence)
);
check('E1: the decision row must be unexpired, unpassed=false and bound to (id,user,action)', /passed = 1 AND expires_at > UTC_TIMESTAMP\(6\)/.test(assertEvidence));
const verifyEvidence = bodyOf(evidenceCode, 'verifyEvidence') || '';
check('E2: signature verification is real ECDSA P-256', /verifyEcdsaP256/.test(evidenceCode));
check('E2: signature covers the canonical (sorted-key) JSON', /canonicalJson/.test(evidenceCode));
check('E2: monotonic counter rejects replays', /counter_replayed/.test(verifyEvidence));
check('E2: an implausible counter jump is rejected', /counter_gap_suspicious/.test(verifyEvidence));
check('E2: challenge consumption + counter bump are transactional', /transaction\(function[\s\S]{0,600}consumed_at/.test(verifyEvidence) || /consumed_at IS NULL/.test(verifyEvidence));
check('E2: the device binding is checked against the server device table', /device_fingerprint/.test(verifyEvidence) && /FROM devices/.test(evidenceCode));

// ═══════════════════════════════════════════════════════════════════════════
// F. Authorization is server-side and precedes the handler
// ═══════════════════════════════════════════════════════════════════════════
const routerCode = read('backend/src/Http/Router.php');
const dispatch = routerCode.slice(routerCode.indexOf('foreach ($this->routes'));
check(
  'F1: the router runs AuthMiddleware BEFORE invoking the handler',
  dispatch.indexOf('new AuthMiddleware()') !== -1 &&
    dispatch.indexOf('new AuthMiddleware()') < dispatch.indexOf('$handler($this->request)')
);
check('F1: auth only runs when the route opts in', /if\s*\(!empty\(\$options\['auth'\]\)\)/.test(routerCode));
check(
  'F1: role allow-lists are enforced in AuthMiddleware (a middleware concern, not the handler)',
  /if\s*\(!empty\(\$options\['role'\]\)\s*&&\s*!in_array\(\$profile\['role'\],\s*\$options\['role'\],\s*true\)\)/.test(
    read('backend/src/Middleware/AuthMiddleware.php')
  )
);

const authMw = read('backend/src/Middleware/AuthMiddleware.php');
check('F2: a missing bearer token is rejected', authMw.includes("Missing Authorization header"));
check('F2: the account must still exist', authMw.includes("Account not found"));
check('F2: suspended/blocked accounts are rejected', authMw.includes("account_suspended"));
check('F2: trashed/deleted accounts are rejected', /trashed', 'deleted/.test(authMw));
check('F2: a revoked session (security_version bump) is rejected', authMw.includes("session_revoked"));
check('F2: the identity placed on the request comes from the token subject', /'id'\s*=>\s*\$profile\['id'\]/.test(authMw));
check('F2: server-side forced-update floor (426) runs for every authenticated route', authMw.includes('AppUpdateService') && /ApiException\(\s*426/.test(authMw));

const jwt = read('backend/src/Auth/Jwt.php');
check('F3: JWTs are signed HS256 with a server secret', jwt.includes("'alg' => 'HS256'"));
check('F3: the signature is compared with hash_equals', /hash_equals\(\s*self::sign/.test(jwt));
check('F3: expired tokens are rejected', jwt.includes('Token expired'));

const password = read('backend/src/Auth/Password.php');
check('F4: passwords are stored with password_hash (bcrypt, cost 10)', /password_hash\(\s*\$plain,\s*PASSWORD_BCRYPT/.test(password));

// Sensitive routes must carry $auth; count the role-gated share.
const routeLines = routesRaw.split('\n').filter((l) => /^\$router->(get|post|put|patch|delete)\(/.test(l.trim()));
const authed = routeLines.filter((l) => l.includes('$auth'));
const roleGated = routeLines.filter((l) => /'role'\s*=>/.test(l));
check('F5: the route table declares enough routes to be meaningful', routeLines.length >= 150, String(routeLines.length));
check('F5: the large majority of routes require authentication', authed.length >= 150, authed.length + ' authenticated of ' + routeLines.length);
check('F5: role-restricted routes exist', roleGated.length >= 80, String(roleGated.length));

// Client-identity assertions must never be trusted for ownership.
const ownershipViolations = [];
for (const f of files) {
  const code = codeOf(f);
  // A controller deriving the acting identity from the JSON body.
  if (/\$actor\s*=\s*\(string\)\s*\(\$request->json\(\)\['user_id'\]/.test(code)) ownershipViolations.push(rel(f));
  if (/\$userId\s*=\s*\(string\)\s*\(\$request->json\(\)\['user_id'\]/.test(code)) ownershipViolations.push(rel(f));
}
check('F6: no handler derives the acting user from the request body', ownershipViolations.length === 0, ownershipViolations.join(', '));

// ═══════════════════════════════════════════════════════════════════════════
// G. IDOR/BOLA on the priority routes
// ═══════════════════════════════════════════════════════════════════════════
const videoCtl = read('backend/src/Controllers/VideoController.php');
const otpBody = bodyOf(videoCtl, 'otp') || '';
const offlineBody = bodyOf(videoCtl, 'offlineAuthorize') || '';
check('G1: /video/otp passes the SESSION user id to the service', otpBody.includes('$this->video->otp($request->user[\'id\']'));
check('G1: /video/offline-authorize passes the SESSION user id', offlineBody.includes('$this->video->offlineAuthorize($request->user[\'id\']'));
check('G1: playback is gated by the video_playback feature flag', otpBody.includes("assertEnabled('video_playback'") || otpBody.includes('video_playback'));
check('G1: offline download is gated by video_offline_downloads', offlineBody.includes("assertEnabled('video_offline_downloads'"));
check('G1: offline authorize requires BOTH playback and downloads', /assertEnabled\('video_playback'/.test(offlineBody) && /assertEnabled\('video_offline_downloads'/.test(offlineBody));

const vdo = read('backend/src/Video/VdoCipherService.php');
check('G2: VdoCipherService::otp verifies enrollment before issuing an OTP', /FROM enrollments WHERE student_id = \? AND course_id = \?/.test(vdo));
check('G2: it refuses a non-enrolled caller', vdo.includes('Not enrolled in this course'));
check('G2: it refuses an unpublished/unavailable course', vdo.includes('This course is not available'));
check('G2: it refuses an unavailable lesson', vdo.includes('This lesson is not available'));
check('G2: offlineAuthorize applies the SAME enrollment rule', /offlineAuthorize[\s\S]{0,4000}Not enrolled in this course/.test(vdo));

const creditCtl = read('backend/src/Controllers/CreditController.php');
for (const fn of ['refund', 'revoke', 'allocate', 'bulkAllocate']) {
  const b = bodyOf(creditCtl, fn) || '';
  const route = routeLine('/credits/' + fn.replace('bulkAllocate', 'bulk-allocate'));
  check('G3: /credits/' + fn + ' is admin/super_admin role gated', /role'\s*=>\s*\[\s*'admin',\s*'super_admin'\s*\]/.test(route), route.trim());
  check('G3: /credits/' + fn + ' records the acting admin from the session', b.includes("$actor = $request->user['id']"));
}
check('G3: /credits/me scopes to the session user', /WHERE doctor_id = \?[\s\S]{0,80}\$request->user\['id'\]/.test(creditCtl));

// Earnings/credit history: a doctor may only read their own.
const rpcCode = read('backend/src/Controllers/RpcController.php');
check(
  'G4: doctor credit history refuses a doctor_id that is not the caller',
  /!in_array\(\$role,\s*\['admin',\s*'super_admin'\],\s*true\)\s*&&\s*\$doctorId\s*!==\s*\$request->user\['id'\]/.test(rpcCode)
);
check('G4: doctor student profile refuses without a shared enrollment', rpcCode.includes('No shared enrollment with this student'));
check(
  'G4: course update refuses a course the caller does not own',
  /\(string\)\s*\$course\['doctor_id'\]\s*!==\s*\$userId/.test(rpcCode)
);
check(
  'G4: enrollment-scoped mutation refuses an enrollment the caller does not own',
  /\(string\)\s*\$enrollment\['doctor_id'\]\s*!==\s*\$request->user\['id'\]/.test(rpcCode)
);

// Device management: cross-user device actions are staff-only.
const deviceRoutes = [
  ['/security/devices/{id}/block', "['admin', 'super_admin']"],
  ['/security/devices/{id}/unblock', "['admin', 'super_admin']"],
  ['/admin/users/{id}/devices/reset', "['admin', 'super_admin']"],
];
for (const [route, roles] of deviceRoutes) {
  const line = routeLine(route);
  check('G5: ' + route + ' is staff role gated', line.includes('$auth') && line.includes(roles), line.trim());
}
const deviceCtl = read('backend/src/Controllers/DeviceController.php');
check('G5: a user may only revoke their own device', deviceCtl.includes('Not authorized'));
check('G5: device queries are scoped by the session user id', /WHERE user_id = \?/.test(deviceCtl));

// ── Summary ────────────────────────────────────────────────────────────────
console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
if (failures > 0) {
  console.log('FAILURES: ' + failures);
  process.exit(1);
}
console.log('PASS: protected APIs are decided by server state, not by client assertions');
