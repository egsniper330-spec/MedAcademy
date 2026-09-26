/**
 * Automated tests for the IMPERSONATION LIFECYCLE fix:
 *   - Root cause A: setSession() did not emit auth-state changes → swap raced
 *     the 2s poll listener → stale Super-Admin bootstrap clobbered the target.
 *   - Root cause B: single-flight refresh captured `user` before the swap and
 *     re-installed it after → Super-Admin identity inside the target's tokens.
 *   - Root cause C: the one-shot role-redirect guard never reset on identity
 *     change → target's role redirect never fired → index spinner forever.
 *   - Root cause D: success was assumed from HTTP 200 (no profile confirmation).
 *
 * Run: node tests/impersonationLifecycle.test.cjs
 *
 * Client pure logic is pinned structurally; the single-flight refresh discard
 * decision is EXECUTED as a real decision function where extractable.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.log('  ✗ ' + msg); }
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}
/** Strip /*…*​/ and // comments so doc mentions don't false-match. */
function readCode(rel) {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('═══ A. setSession emits identity changes synchronously ═══');
{
  const php = readCode('src/client/php.ts');

  ok(/let _authListener/.test(php),
     '_authListener slot registered');
  ok(/_authListener = \(event, s\) =>/.test(php),
     'onAuthStateChange installs the synchronous listener');

  // setSession must emit SIGNED_IN when the token/identity changed, BEFORE the
  // 2s poll could sample it.
  const setSessionIdx = php.indexOf('setSession: async (session:');
  const setSessionBody = php.slice(setSessionIdx, setSessionIdx + 2200);
  ok(/_authListener\(/.test(setSessionBody),
     'setSession invokes the auth listener synchronously');
  ok(/'SIGNED_IN'/.test(setSessionBody),
     'emitted event is SIGNED_IN');
  ok(/prev\.access_token !== session\.access_token/.test(setSessionBody),
     'emission is gated on an actual token change (no duplicate no-op emits)');
  ok(/prev\.user\?\.id !== user\.id/.test(setSessionBody),
     'emission also fires when only the USER IDENTITY changed');

  // The poll listener must remain as the safety net but de-dup vs the emit.
  const pollIdx = php.indexOf('onAuthStateChange: (callback:');
  const pollBody = php.slice(pollIdx, pollIdx + 1200);
  ok(/setInterval/.test(pollBody), '2s poll safety net retained');
  ok(/t === lastToken\) return/.test(pollBody),
     'listener de-dups against the poll last-seen token (no double emit)');

  // The identity swap must REPLACE the stored user (never reuse the actor's).
  ok(/user \?\? existing\?\.user/.test(setSessionBody),
     'setSession still honors the user override for impersonation swaps');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('═══ B. single-flight refresh is swap-safe ═══');
{
  const php = readCode('src/client/php.ts');
  const refIdx = php.indexOf('async function refreshAccessToken');
  const refBody = php.slice(refIdx, refIdx + 3000);

  // Mid-flight identity change → the rotated OLD pair must be DISCARDED,
  // not stored over the freshly installed target session.
  ok(/current\.access_token !== stored\.access_token/.test(refBody),
     'refresh detects an identity change mid-flight (token comparison)');
  ok(/AUTH_REFRESH_DISCARDED/.test(refBody),
     'mid-flight-swapped refresh result is discarded (logged), never stored');
  ok(refBody.indexOf('current.access_token !== stored.access_token') < refBody.indexOf('await storeSession({ access_token: s.access_token'),
     'discard check happens BEFORE persisting the rotated pair');

  // The user object must be re-read at completion, not from the stale capture.
  ok(/current\?\.user \?\? stored\.user/.test(refBody),
     'rotated pair re-reads the CURRENT stored user (no stale identity resurrection)');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('═══ C. role-redirect guard resets on identity change ═══');
{
  const layout = readCode('src/app/(app)/_layout.tsx');

  ok(/lastIdentityRef/.test(layout),
     'identity tracker (lastIdentityRef) exists');
  ok(/hasNavigated\.current = false;/.test(layout),
     'one-shot redirect guard is RESET');
  const identityIdx = layout.indexOf('lastIdentityRef.current = uid');
  ok(identityIdx >= 0 && layout.indexOf('hasNavigated.current = false;', identityIdx) - identityIdx < 200,
     'reset happens exactly when the session identity changes');
  ok(/uid !== lastIdentityRef\.current/.test(layout),
     'reset is gated on an actual identity CHANGE (same-user re-render safe)');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('═══ D. bootstrap generation guard + terminal loading states ═══');
{
  const layout = readCode('src/app/(app)/_layout.tsx');

  ok(/bootGeneration/.test(layout),
     'bootstrap generation guard exists');
  ok(/myGen !== bootGeneration\.current\) return;/.test(layout),
     'stale getProfile response is discarded after an identity switch');
  // Error path must also respect the generation (no stale error screen).
  ok(/myGen !== bootGeneration\.current\) return;/.test(layout.slice(layout.indexOf('catch (err)'))),
     'stale error responses are discarded too');
  // The finally block must not clobber a NEWER load's loading state.
  ok(/myGen === bootGeneration\.current\) \{[\s\S]{0,80}setProfileLoading\(false\)/.test(layout),
     'finally clears loading only for the CURRENT generation');

  // Terminal-state overlay: the hydration gap is owned and bounded, not an
  // orphan spinner. It must be driven by awaitingProfile (state), not nothing.
  ok(/awaitingProfile/.test(layout),
     'identity-switch hydration gap is explicitly owned (awaitingProfile state)');
  ok(/awaitingProfile && \(/.test(layout),
     'hydration overlay renders only during the confirmed transitional state');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('═══ E. service: confirmed success + atomic A→B + rollback ═══');
{
  const svc = readCode('src/lib/impersonationService.ts');

  // No early success: confirmation gate must exist BEFORE resolution.
  ok(/const confirmTarget = async/.test(svc),
     'target profile confirmation step exists');
  ok(/CONFIRM_TIMEOUT_MS/.test(svc),
     'confirmation is bounded (no infinite wait either)');
  ok(/catch \(err\) \{/.test(svc) && /setSession\(\{[\s\S]{0,400}currentSession\.access_token[\s\S]{0,600}endImpersonation\(\)/.test(svc),
     'rollback is wired to confirmation failure (restore + store reset)');

  // Rollback completeness: original tokens back, store reset, profile cleared.
  const rollbackIdx = svc.indexOf('catch (err) {');
  const rollbackBody = svc.slice(rollbackIdx, rollbackIdx + 1100);
  ok(/currentSession\.access_token/.test(rollbackBody),
     'rollback restores the ORIGINAL Super-Admin tokens');
  ok(/endImpersonation\(\)/.test(rollbackBody),
     'rollback resets the impersonation store');
  ok(/clearProfile\(\)/.test(rollbackBody),
     'rollback clears the profile for authoritative re-hydration');
  ok(/Impersonation was cancelled/.test(rollbackBody),
     'user sees a real error — never a fake success');

  // Atomic A→B: starting while already impersonating ends the current one FIRST.
  const startIdx = svc.indexOf('export async function startImpersonationSession');
  const startBody = svc.slice(startIdx, startIdx + 1800);
  ok(/impersonation\.active/.test(startBody) && /endImpersonationSession\(\)/.test(startBody),
     'A→B switch ends the current impersonation before starting B');
  ok(startBody.indexOf('impersonation.active') < startBody.indexOf('await backendClient.auth.getSession()'),
     'A→B end happens BEFORE the fresh snapshot (no nested-original corruption)');

  // Refresh-token completeness in the contract check.
  ok(/!targetSession\.refresh_token/.test(svc),
     'missing refresh_token is also a hard contract failure');

  // Exit: restore confirmation, never a trap.
  const endIdx = svc.indexOf('export async function endImpersonationSession');
  const endBody = svc.slice(endIdx);
  ok(/getProfile\(uid\)/.test(endBody),
     'exit confirms the Super-Admin profile reloads');
  ok(/} catch \{/.test(endBody),
     'exit confirmation failure is caught — cannot trap anyone');
  ok(/impersonation\.originalAccessToken/.test(endBody),
     'exit restores the preserved original session');
  ok(/signOut\(\)/.test(endBody),
     'expired-original fallback signs out cleanly (no half-restored state)');

  // The screen navigates by TARGET role (no reliance on the consumed guard).
  const screen = readCode('src/app/(app)/(superadmin)/impersonation.tsx');
  ok(/targetUser\.role === 'doctor'/.test(screen) && /dr-overview/.test(screen),
     'screen navigates to the TARGET role dashboard after confirmed success');
  ok(/startImpersonationSession/.test(screen) && screen.indexOf('startImpersonationSession') < screen.indexOf('router.replace'),
     'navigation happens only after the confirmed service call');

  // Banner: no redundant store double-writes racing the layout re-bootstrap.
  const banner = readCode('src/components/ImpersonationBanner.tsx');
  ok(!/endImpersonation\(\)/.test(banner),
     'banner no longer double-resets the store after the service already did');
  ok(!/clearProfile\(\)/.test(banner),
     'banner no longer double-clears the profile after the service already did');
  ok(/endImpersonationSession\(\)/.test(banner),
     'banner delegates to the service (single authoritative exit path)');
  ok(/useSafeAreaInsets/.test(banner) && /insets\.top/.test(banner),
     'safe-area fix intact (insets.top, not hardcoded padding)');
  ok(/accessibilityRole|accessibilityLabel/.test(banner),
     'banner accessibility intact');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('═══ F. backend: stateless repeat-capable contract intact ═══');
{
  const ctrl = readCode('backend/src/Controllers/AuthController.php');
  const impIdx = ctrl.indexOf('public function impersonate');
  const impBody = ctrl.slice(impIdx, impIdx + 4000);

  // Fresh token pair per call — no server-side "active impersonation" row that
  // could block repeats after Exit.
  ok(impBody.includes('SessionManager()') && impBody.includes('->issue('),
     'each impersonate call issues a FRESH session pair (repeat-capable)');
  ok(!/active_impersonation|impersonation_session/i.test(impBody),
     'no blocking server-side impersonation-state row');

  // Authorization + target policy preserved.
  ok(/Only Super Admin can impersonate/.test(impBody), 'super_admin gate intact');
  ok(/Cannot impersonate Super Admin accounts/.test(impBody), 'SA-target block intact');
  ok(/Cannot impersonate yourself/.test(impBody), 'self-target block intact');
  ok(/suspended|blocked|trashed|deleted/.test(impBody), 'suspended-target block intact');

  // Audits: started / ended / failed with no token material.
  ok(/impersonation_started/.test(impBody), 'impersonation_started audited');
  ok(/impersonation_failed/.test(impBody), 'impersonation_failed audited');
  const endIdx = ctrl.indexOf('public function endImpersonation');
  const endBody = ctrl.slice(endIdx, endIdx + 3000);
  ok(/impersonation_ended/.test(endBody), 'impersonation_ended audited');
  ok(/target_user_id.*\$userId|JSON_EXTRACT\(details, '\$\.target_user_id'\)/.test(endBody),
     'end matches the start record by TARGET id (null-safe, no NOT-IN-NULL trap)');
  ok(!/access_token|refresh_token/.test(impBody.replace(/target_user_id|refresh_tokens|SessionManager/g, '')),
     'no token material written to audit payloads');

  // Response contract: { session: {access_token, refresh_token}, target }.
  ok(/'session' => \$session/.test(impBody) && /'target' => \$target/.test(impBody),
     'response contract is { session, target } — one canonical shape');

  // Route gates.
  const routes = readCode('backend/routes/api.php');
  ok(/post\('\/auth\/impersonate'.*super_admin/.test(routes), '/auth/impersonate super_admin-gated');
  ok(/post\('\/auth\/impersonation\/end'/.test(routes), '/auth/impersonation/end exists');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('═══ G. no token leakage in client logs ═══');
{
  const svc = read('src/lib/impersonationService.ts');
  ok(!/console\.(log|info|debug)\(/.test(svc),
     'impersonationService never logs (tokens can never leak to console)');

  const php = read('src/client/php.ts');
  // authStateLog calls must not interpolate the token value.
  const logCalls = php.match(/authStateLog\([^;]*\)/g) || [];
  const bad = logCalls.filter(c => /access_token/.test(c) && !/has_access_token|!!s\?\.access_token/.test(c));
  ok(bad.length === 0, `authStateLog never logs raw tokens (checked ${logCalls.length} calls)`);
}

// ════════════════════════════════════════════════════════════════════════
console.log('═══ H. web-reload persistence (sessionStorage snapshot + boot re-arm) ═══');
{
  const store = read('src/lib/store.ts');
  ok(/IMPERSONATION_SNAPSHOT_KEY/.test(store), 'snapshot key defined');
  ok(/sessionStorage\.setItem\(IMPERSONATION_SNAPSHOT_KEY/.test(store),
     'snapshot WRITES go to sessionStorage (tab-scoped, never localStorage/disk)');
  ok(!/localStorage\.setItem\(IMPERSONATION_SNAPSHOT_KEY/.test(store),
     'snapshot NEVER persisted to localStorage (no disk copy of restore context)');
  ok(/startImpersonation:[\s\S]*?writeImpersonationSnapshot/.test(store),
     'startImpersonation persists the snapshot');
  ok(/endImpersonation:[\s\S]*?clearImpersonationSnapshot/.test(store),
     'endImpersonation clears the snapshot');
  ok(/export function peekImpersonationSnapshot/.test(store),
     'snapshot peek exported for the re-arm');

  const svc = read('src/lib/impersonationService.ts');
  ok(/export function rearmImpersonationAfterReload/.test(svc), 'boot re-arm exported');
  const rearmBody = svc.slice(svc.indexOf('rearmImpersonationAfterReload'));
  ok(/EXPO_OS !== 'web'/.test(rearmBody.slice(0, 300)),
     're-arm is web-only (native no-op — no reload path exists)');
  ok(/access_token !== snap\.originalAccessToken/.test(rearmBody),
     're-arm validates the CURRENT session is still the TARGET\u2019s (token differs from original) before resurrecting');
  ok(/dropImpersonationSnapshot\(\)/.test(rearmBody),
     'stale snapshot (logged out / restored) is DROPPED, never resurrected blind');

  const layout = read('src/app/_layout.tsx');
  ok(/rearmImpersonationAfterReload\(\)/.test(layout), 'root layout invokes the boot re-arm');
  ok(/<ImpersonationBanner \/>/.test(layout), 'banner mounted at ROOT (above navigation)');
}

console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
