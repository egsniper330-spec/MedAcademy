#!/usr/bin/env node
/**
 * Phase 0 — security telemetry correctness regression suite.
 *
 * Run: node tests/securityTelemetryPolicy.test.cjs
 *
 * WHAT THIS PINS
 *  - IntegrityService::reject() no longer records `log_only` for a request that
 *    is actually refused with a 403. It records the enforcement category the
 *    refused action really falls under, or NULL when none fits.
 *  - SecurityEvidenceService::assertEvidenceAllowed() no longer records
 *    `block_login` for a refused NON-login action.
 *  - Enforcement is unchanged: both paths still throw the same 403 bodies, the
 *    enforcement tiers (log_only default) are untouched, and telemetry remains
 *    best-effort (wrapped in try/catch).
 *  - The closed `policy_action` vocabulary and its schema CHECK are unchanged.
 *
 * PHP is not executed here (no PHP runtime in this environment). These are
 * source-shape assertions on the PHP files, the same approach used by the other
 * suites in tests/. Behaviour should also be confirmed by a PHP run in CI.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Extract the body of a PHP function by its signature line (brace matched). */
function functionBody(src, signatureRegex) {
  const m = signatureRegex.exec(src);
  if (!m) throw new Error(`function not found: ${signatureRegex}`);
  let i = src.indexOf('{', m.index + m[0].length);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(m.index, j + 1);
    }
  }
  throw new Error('unterminated function body');
}

const integrity = read('backend/src/Services/IntegrityService.php');
const evidence = read('backend/src/Services/SecurityEvidenceService.php');
const securityService = read('backend/src/Services/SecurityService.php');
const migrationsDir = path.join(ROOT, 'backend/database/mysql-migrations');

const rejectBody = functionBody(integrity, /private static function reject\(/);
const rejectMapBody = functionBody(integrity, /private static function rejectPolicyAction\(/);
const evidenceBody = functionBody(evidence, /public static function assertEvidenceAllowed\(/);
const refusalMapBody = functionBody(evidence, /private static function refusalPolicyAction\(/);

console.log('Phase 0 — telemetry policy_action correctness');

check('IntegrityService::reject() never hardcodes log_only', () => {
  assert(!/'policy_action'\s*=>\s*'log_only'/.test(rejectBody), 'reject() still records log_only');
});

check('IntegrityService::reject() derives policy_action from the refused action', () => {
  assert(/'policy_action'\s*=>\s*self::rejectPolicyAction\(\$action\)/.test(rejectBody),
    'reject() does not map policy_action through rejectPolicyAction()');
});

check('IntegrityService::rejectPolicyAction maps vdo_otp to block_video only', () => {
  assert(/'vdo_otp'\s*=>\s*'block_video'/.test(rejectMapBody), 'vdo_otp must map to block_video');
  assert(!/block_login/.test(rejectMapBody), 'integrity rejections must never map to block_login');
  assert(!/log_only/.test(rejectMapBody), 'a refused request must never map to log_only');
});

check('every reject() call site passes the action', () => {
  const calls = integrity.match(/self::reject\(\$userId, \$ip, [^;]*\);/g) || [];
  assert(calls.length === 7, `expected 7 reject() call sites, found ${calls.length}`);
  for (const c of calls) {
    assert(/, \$action\);$/.test(c), `reject() call without action: ${c}`);
  }
});

check('IntegrityService reject() still throws the unchanged 403 body', () => {
  assert(/throw new ApiException\(403, 'Integrity verification failed'\);/.test(rejectBody),
    'reject() 403 body changed');
});

check('reject() telemetry is still best-effort', () => {
  assert(/try \{[\s\S]*logEvent[\s\S]*\} catch \(\\Throwable\)/.test(rejectBody),
    'reject() telemetry is no longer wrapped in try/catch');
});

check('assertEvidenceAllowed no longer hardcodes block_login', () => {
  assert(!/'policy_action'\s*=>\s*'block_login'/.test(evidenceBody),
    'assertEvidenceAllowed still records block_login for every action');
});

check('assertEvidenceAllowed derives policy_action from the refused action', () => {
  assert(/'policy_action'\s*=>\s*self::refusalPolicyAction\(\$action\)/.test(evidenceBody),
    'assertEvidenceAllowed does not use refusalPolicyAction()');
});

check('refusalPolicyAction: login → block_login, vdo_otp → block_video, others NULL', () => {
  assert(/'login'\s*=>\s*'block_login'/.test(refusalMapBody), 'login must map to block_login');
  assert(/'vdo_otp'\s*=>\s*'block_video'/.test(refusalMapBody), 'vdo_otp must map to block_video');
  assert(/default\s*=>\s*null/.test(refusalMapBody), 'other actions must map to null');
});

check('assertEvidenceAllowed keeps the unchanged 403 body', () => {
  assert(/throw new ApiException\(403, 'This action requires a verified device security check\. Please reopen the app and try again\.'\);/
    .test(evidenceBody), 'assertEvidenceAllowed 403 body changed');
});

check('assertEvidenceAllowed telemetry remains best-effort', () => {
  assert(/try \{[\s\S]*logEvent[\s\S]*\} catch \(\\Throwable\)/.test(evidenceBody),
    'assertEvidenceAllowed telemetry is no longer wrapped in try/catch');
});

console.log('\nPhase 0 — vocabulary and schema unchanged');

check('SecurityService closed policy_action vocabulary is unchanged', () => {
  assert(/\['log_only', 'warn_only', 'block_video', 'block_login'\]/.test(securityService),
    'closed policy_action vocabulary changed');
});

check('no migration alters the security_events.policy_action CHECK', () => {
  const files = fs.readdirSync(migrationsDir);
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    assert(!/chk_security_events_policy_action[\s\S]{0,200}(DROP|ADD)/i.test(sql) ||
      /log_only/.test(sql), `${f} modifies the policy_action CHECK`);
  }
});

console.log('\nPhase 0 — enforcement defaults unchanged');

check('Integrity and device-evidence default tiers are still log_only', () => {
  assert(/'vdo_otp'\s*=>\s*'log_only'/.test(integrity), 'Integrity vdo_otp default changed');
  assert(/'vdo_otp'\s*=>\s*'log_only'/.test(evidence), 'Evidence vdo_otp default changed');
  assert(/'device_bind'\s*=>\s*'log_only'/.test(evidence), 'Evidence device_bind default changed');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
