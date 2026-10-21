#!/usr/bin/env node
/**
 * globalFixesRegression.test.cjs — regression guards for the global UI /
 * feature-flag / access / keyboard fixes.
 *
 * SOURCE-CONTRACT tests (no PHP binary, no device). Each block pins the
 * INVARIANT that made the reported bug possible, so the same class of defect
 * cannot silently return:
 *
 *   P1 keyboard        — one shared mechanism per platform; no double insets;
 *                        no text-input screen left without keyboard handling.
 *   P2 support contact — the block screen can reach the public contact endpoint
 *                        WHILE the security lock is engaged, and a failed fetch
 *                        is never rendered as "not configured".
 *   P4 provider        — a disabled video provider is reported as an
 *                        unavailable FEATURE, never a generic "Save failed".
 *   P5 course creation — the flag is enforced on the path the doctor UI uses.
 *   P6 earnings        — the disabled page renders no page header and centres
 *                        the unavailable state.
 *   P7 suspension      — a suspended enrollment is not access anywhere.
 *
 * Usage: node tests/globalFixesRegression.test.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ok - ' + label); }
  else { failed++; console.error('  FAIL - ' + label); }
}

/**
 * Names imported from 'react-native' in a source file. Used instead of a raw
 * text search so an EXPLANATORY COMMENT mentioning a component is never
 * mistaken for the component actually being used.
 */
function rnImports(src) {
  const names = new Set();
  const re = /import\s*\{([\s\S]*?)\}\s*from\s*'react-native';/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (name) names.add(name);
    }
  }
  return names;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── P1: keyboard overlap (shared, single inset per platform) ──');
{
  const kai = read('src/components/KeyboardAwareScrollView.tsx');
  ok(/export function KeyboardAwareScrollView/.test(kai),
    'KeyboardAwareScrollView primitive exists (the ONE shared solution)');
  ok(/automaticallyAdjustKeyboardInsets/.test(kai),
    'iOS uses the native automaticallyAdjustKeyboardInsets (exactly one inset)');
  ok(/keyboardShouldPersistTaps\s*=\s*'handled'/.test(kai),
    'keyboardShouldPersistTaps=handled so a single tap reaches Save with the keyboard open');
  ok(!rnImports(kai).has('KeyboardAvoidingView'),
    'the primitive does NOT wrap in KeyboardAvoidingView (which would double the inset)');

  // Shared wrappers must delegate — a KeyboardAvoidingView there was the
  // double-inset (iOS padding + automatic insets; Android adjustResize + height).
  for (const f of ['src/components/AppScreen.tsx', 'src/components/AdaptiveScreen.tsx']) {
    const src = read(f);
    ok(/import\s*\{\s*KeyboardAwareScrollView\s*\}\s*from\s*'@\/components\/KeyboardAwareScrollView'/.test(src),
      `${path.basename(f)} delegates to the shared primitive`);
    ok(!rnImports(src).has('KeyboardAvoidingView'), `${path.basename(f)} no longer nests a KeyboardAvoidingView`);
  }

  // No screen may re-introduce a KeyboardAvoidingView that actually shrinks the
  // container: Android is adjustResize, so behavior height/padding is a second
  // inset, and iOS handles it natively on the scroll view.
  const appFiles = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx$/.test(e.name)) appFiles.push(path.relative(ROOT, p).replace(/\\/g, '/'));
    }
  })(path.join(ROOT, 'src', 'app'));

  const badBehavior = appFiles.filter((f) =>
    /behavior=\{(process\.env\.EXPO_OS === 'ios' \? 'padding' : 'height'|Platform\.OS === 'ios' \? 'padding' : 'height'|'padding')\}/.test(read(f)));
  ok(badBehavior.length === 0,
    'no screen applies KeyboardAvoidingView padding/height (double-inset class is gone)',
    badBehavior.join(', '));

  // Every screen that can receive text must have SOME keyboard handling.
  const uncovered = appFiles.filter((f) => {
    const s = read(f);
    if (!/TextInput|NeuInput/.test(s)) return false;
    return !/automaticallyAdjustKeyboardInsets|KeyboardAwareScrollView|<KeyboardAvoidingView/.test(s);
  });
  ok(uncovered.length === 0,
    'every text-input screen has keyboard handling (was 38 with none)',
    uncovered.join(', '));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── P2: support contact reaches the block screen while locked ──');
{
  const php = read('src/client/php.ts');
  const exemptBlock = php.slice(php.indexOf('const LOCK_EXEMPT_PREFIXES'), php.indexOf('function isLockExempt'));
  ok(/'\/support\/contact'/.test(exemptBlock),
    '/support/contact is in LOCK_EXEMPT_PREFIXES (the lock screen can load contacts)');
  ok(/'\/auth\/refresh'/.test(php) && !/'\/auth\/refresh'/.test(exemptBlock),
    'token refresh stays frozen while locked (exemption did not widen refresh)');

  // The support-load error copy is localized now: the screen renders the
  // `security.supportLoadFailed` key and the English string lives in the
  // dictionaries. Pin the key on the screen AND the copy in the resources, so a
  // regression cannot silently turn the error back into "not configured".
  const resources = read('src/lib/i18n/resources.ts');
  for (const f of ['src/app/(app)/security-warning.tsx', 'src/app/(auth)/security-warning.tsx']) {
    const src = read(f);
    ok(/supportError/.test(src), `${f} tracks a fetch error separately from "not configured"`);
    ok(/t\('security\.supportLoadFailed'\)/.test(src),
      `${f} shows an error + retry instead of the misleading "not configured"`);
    ok(/'security\.supportLoadFailed': 'Could not load support contacts/.test(resources),
      `${f} error copy still says it could not load the contacts (dictionary)`);
    ok(/loadSupportContacts/.test(src), `${f} can retry the public contact fetch`);
  }

  const admin = read('src/app/(app)/(hubs)/sa-support-settings.tsx');
  ok(/readBack/.test(admin) && /did not persist/.test(admin),
    'admin save verifies the value is readable back before reporting success');
  ok(/setDrafts\(settingsToDrafts\(fresh\)\)/.test(admin),
    'admin form refreshes from the canonical server state after saving (no stale cache)');
  ok(/was saved but is hidden from users/.test(admin),
    'saving a value with the toggle OFF warns instead of implying it is shown');

  const api = read('src/lib/api.ts');
  ok(/normalizeAdminSupportSettings/.test(api),
    'admin support response is normalized through one shared mapper');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── P4: disabled video provider is an unavailable FEATURE ──');
{
  const policy = read('src/lib/videoProviderPolicy.ts');
  ok(/export function isProviderDisabledError/.test(policy),
    'isProviderDisabledError distinguishes the policy refusal from other 403s');
  ok(/video_provider_disabled/.test(policy), 'the structured refusal code is the detection key');

  const le = read('src/app/(app)/lesson-editor/[id].tsx');
  ok(/isProviderDisabledError\(e\)/.test(le),
    'lesson save branches on the provider refusal (no generic "Save failed.")');
  ok(/describeProviderError\(e\)/.test(le), 'the friendly provider message is surfaced');
  ok(/FeatureUnavailableState/.test(le),
    'the video URL entry area renders the shared unavailable state');
  ok(/plyrBlocked \|\| providerSaveBlocked/.test(le),
    'a disabled/refused provider replaces the URL form instead of leaving a failing form');

  // Backend enforcement must remain (the UI is not the boundary).
  const dc = read('backend/src/Controllers/DataController.php');
  ok((dc.match(/VideoProviderPolicyService::assertProviderAllowed/g) || []).length >= 2,
    'backend enforces provider availability on the lessons INSERT and UPDATE paths');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── P5: course-creation flag enforced on the path the UI uses ──');
{
  const rpc = read('backend/src/Controllers/RpcController.php');
  const createAudited = rpc.slice(rpc.indexOf('public function createCourseAudited'));
  ok(/assertEnabled\('course_creation'/.test(createAudited.slice(0, 1200)),
    'RPC create_course_audited asserts course_creation (this is what the doctor app calls)');

  const cc = read('backend/src/Controllers/CourseController.php');
  const dup = cc.slice(cc.indexOf('public function duplicate'));
  ok(/assertEnabled\('course_creation'/.test(dup.slice(0, 600)),
    'duplicate() creates a course and therefore honours course_creation');

  const dc = read('backend/src/Controllers/DataController.php');
  ok(/if \(\$table === 'courses'\) \{\s*\(new FeatureFlagService\(\)\)->assertEnabled\('course_creation', \$request\)/.test(dc),
    'generic POST /api/courses is gated too (no alternate entry point)');

  const flags = read('backend/src/Services/FeatureFlagService.php');
  ok(/Enforced on POST \/courses, POST \/rpc\/create-course-audited/.test(flags),
    'the registry documents the real enforcement points');

  const courses = read('src/app/(app)/(doctor)/courses.tsx');
  ok(/isEnabled\('course_creation'\)/.test(courses), 'doctor courses screen reflects the flag');
  ok(/FeatureUnavailableState/.test(courses), 'disabled state uses the shared unavailable design');
  ok(/isFeatureDisabledError/.test(courses), 'a server refusal is not shown as a generic failure');

  const builder = read('src/app/(app)/course-builder/[id].tsx');
  ok(/isNew && !isEnabled\('course_creation'\)/.test(builder),
    'the /course-builder/new route cannot be reached to create a course while disabled');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── P6: disabled Earnings hides the page header and centres the state ──');
{
  const dr = read('src/app/(app)/(doctor)/dr-earnings.tsx');
  // Slice the guard branch by its real boundaries (start → its return statement)
  // instead of a fixed 1400-character window: the window silently spilled into
  // the normal branch once the copy moved into the dictionary, which would have
  // made this check depend on string length rather than on the branch content.
  const guardStart = dr.indexOf('if (platformDisabled) {');
  // End at the component's own top-level `return (` (2-space indent); the guard's
  // early return is indented one level deeper.
  const guard = dr.slice(guardStart, dr.indexOf('\n  return (', guardStart));
  ok(guard.length > 0, 'a dedicated platformDisabled branch exists');
  ok(!/DashboardHeader/.test(guard),
    'the disabled branch renders NO DashboardHeader (no revenue subtitle / trend icon)');
  ok(/FeatureUnavailableState/.test(guard),
    'the disabled branch uses the shared, consistent unavailable design');
  ok(/flex: 1[^}]*alignItems: 'center', justifyContent: 'center'/.test(guard) ||
     /justifyContent: 'center'/.test(guard),
    'the state is centred in the available area');
  ok(/safeTop\(layout\.insets\.top\)/.test(guard) && /safeBottom\(layout\.insets\.bottom\)/.test(guard),
    'the centred state accounts for top safe area and the bottom tab bar');
  ok(/HamburgerButton/.test(guard), 'navigation is still reachable (drawer affordance kept)');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── P7: a suspended enrollment is not access, anywhere ──');
{
  const vdo = read('backend/src/Video/VdoCipherService.php');
  const statusChecks = (vdo.match(/SELECT status FROM enrollments WHERE student_id = \? AND course_id = \? LIMIT 1/g) || []).length;
  ok(statusChecks >= 2,
    'VdoCipher OTP + offline-authorize both read enrollment status (was COUNT(*) with no status)');
  ok(/has been suspended by the instructor/.test(vdo),
    'the refusal is honest (suspended vs never enrolled)');
  ok(!/COUNT\(\*\) FROM enrollments WHERE student_id = \? AND course_id = \?',\s*\n\s*\[\$userId, \$lesson\['course_id'\]\],\s*\n\s*0/.test(vdo),
    'the old status-blind COUNT(*) check is gone from the playback paths');

  const cc = read('backend/src/Controllers/CourseController.php');
  ok(/status IS NULL OR status <> 'suspended'/.test(cc),
    'isEnrolled() requires a non-suspended enrollment (course detail / sections / lessons)');
  ok(/e\.status IS NULL OR e\.status <> 'suspended'/.test(cc),
    'the student course list only counts non-suspended enrollments');

  const dc = read('backend/src/Controllers/DataController.php');
  ok(/\$role === 'student'[\s\S]{0,700}<> 'suspended'/.test(dc),
    'a student direct GET of enrollments cannot resurrect a suspended course');

  const api = read('src/lib/api.ts');
  ok(/\.neq\('status', 'suspended'\)/.test(api),
    "getMySubscriptions excludes suspended enrollments from the student's active list");
  ok(/suspendCourseSubscription[\s\S]{0,200}suspendStudentCourseAccess/.test(api),
    'the duplicate suspension writers delegate to ONE canonical path');
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
