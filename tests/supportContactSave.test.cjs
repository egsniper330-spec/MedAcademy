/**
 * supportContactSave.test.cjs — regression test for the Support Contact save flow.
 *
 * Verifies end-to-end source contract:
 *   Super Admin PUT /admin/support-settings (WhatsApp)
 *     → SupportController validates + normalizes + upserts
 *     → GET /support/contact returns the enabled WhatsApp contact
 *     → invalid input rejected
 *     → normal user cannot PUT
 *     → disabled contacts omitted from public endpoint
 *
 * These are SOURCE-CONTRACT tests (they assert the backend source shape),
 * not live-server tests — they catch regressions in SupportController.php
 * before deploy, including the JS-syntax-in-PHP fatal bug that broke phone saves.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ok - ' + label); }
  else { failed++; console.error('  FAIL - ' + label); }
}

console.log('\n── Support Contact save flow (source contract) ──');

// ── Backend: SupportController exists and implements the 3 handlers ──────────
{
  const ctrl = read('backend/src/Controllers/SupportController.php');

  // The 3 routed handlers
  ok(ctrl.includes('public function adminUpdate(Request $request): void'),
    'SupportController::adminUpdate exists (the save handler)');
  ok(ctrl.includes('public function adminIndex(Request $request): void'),
    'SupportController::adminIndex exists (admin GET)');
  ok(ctrl.includes('public function publicContact(Request $request): void'),
    'SupportController::publicContact exists (public blocked-screen read)');

  // Authorization: Super Admin only on writes
  ok(ctrl.includes('private function assertSuperAdmin'),
    'SupportController asserts Super Admin role on writes');
  ok(/\$role !== 'super_admin'/.test(ctrl),
    'SupportController rejects non-super_admin with 403');

  // Upsert mechanism
  ok(ctrl.includes('ON DUPLICATE KEY UPDATE'),
    'SupportController uses INSERT ... ON DUPLICATE KEY UPDATE (upsert by key)');

  // Primary key is `key` (the platform column) — verify the CREATE TABLE
  const schema = read('backend/database/schema.sql');
  const mig = read('backend/database/mysql-migrations/001_add_support_settings.sql');
  const combined = schema + '\n' + mig;
  ok(/PRIMARY KEY \(`key`\)/.test(combined),
    'support_settings primary key is `key` (platform column) — upsert targets it');

  // Audit logging (non-blocking — must not fail the save)
  ok(ctrl.includes('support_settings_updated') && ctrl.includes('AuditService::write'),
    'SupportController audits changes via canonical AuditService (support_settings_updated)');
  ok(ctrl.includes('catch (\\Throwable $_)'),
    'Audit log failure is caught and non-blocking (save still succeeds)');

  // ── JS-syntax-in-PHP regression guard ─────────────────────────────────────
  // The phone normalization path previously contained JS syntax:
  //   $value.trim().replace(/[^\d+]/g, '')
  //   return $clean.startsWith('+') ? $clean : `+${clean}`;
  // That is a FATAL PHP error (Call to a member function trim() on string).
  // It must never re-enter the codebase.
  ok(!ctrl.includes('$value.trim().replace'),
    'NO JS syntax $value.trim().replace in SupportController (was a fatal PHP bug)');
  ok(!ctrl.includes('`+${'),
    'NO JS template literal `+${...}` in SupportController (was a fatal PHP bug)');
  ok(ctrl.includes('preg_replace'),
    'Phone normalization uses PHP preg_replace (valid PHP)');

  // ── WhatsApp validation + normalization contract ──────────────────────────
  // WhatsApp is a "social" platform in the controller's model: it accepts
  // either an HTTPS URL or a raw handle/phonenumber, and normalizes to
  // https://wa.me/<E164-without-plus>.
  ok(ctrl.includes("=> ['https']"),
    'WhatsApp allowed scheme is HTTPS only (public endpoint)');
  ok(ctrl.includes("'whatsapp', 'facebook', 'instagram', 'telegram', 'x'"),
    'WhatsApp is grouped with other social platforms in validation/normalization');
  ok(ctrl.includes("return 'https://wa.me/' . ltrim($value, '+')"),
    'WhatsApp normalizes raw handle/phone to https://wa.me/<number-without-plus>');
  ok(ctrl.includes("str_starts_with($value, 'https://')"),
    'WhatsApp normalization returns the value unchanged if it is already HTTPS');

  // ── Public endpoint projection ────────────────────────────────────────────
  // GET /support/contact returns ONLY enabled contacts with non-empty values.
  ok(ctrl.includes('WHERE `enabled` = 1'),
    'Public endpoint filters to enabled contacts only');
  ok(ctrl.includes("if ($value === '')"),
    'Public endpoint skips contacts with empty values');
  ok(/'platform'\s*=>\s*\$key/.test(ctrl) && /'url'\s*=>\s*\$url/.test(ctrl),
    'Public endpoint returns platform + url (not raw value, not admin fields)');
  ok(!ctrl.includes("'value' =>"), 'Public endpoint does NOT expose raw stored values');
}

// ── Frontend: upsertSupportSetting → PUT /admin/support-settings ────────────
{
  const api = read('src/lib/api.ts');

  ok(api.includes('export async function upsertSupportSetting'),
    'Frontend exports upsertSupportSetting');
  ok(api.includes("'/admin/support-settings'") && api.includes("method: 'PUT'"),
    'Frontend save hits PUT /admin/support-settings (not the generic Data API)');
  ok(api.includes('settings: {') && api.includes('[key]: {'),
    'Frontend sends { settings: { [key]: { value, label, enabled, display_order } } }');
  ok(api.includes("'display_order'"), 'Frontend sends display_order');
}

// ── Frontend: getSupportSettings reads via generic Data API (read-only) ─────
{
  const api = read('src/lib/api.ts');
  ok(api.includes('export async function getSupportSettings'),
    'Frontend exports getSupportSettings (load)');
  // getSupportSettings uses the generic Data API .from('support_settings') —
  // that is intentional: reads are public/authenticated via DataController,
  // writes go through SupportController. This is why the page LOADED even when
  // SupportController was not yet deployed on the live server.
  ok(api.includes(".from('support_settings')"), 'getSupportSettings reads via Data API (support_settings is PUBLIC_TABLES)');
}

// ── Frontend: getPublicSupportContacts → GET /support/contact ───────────────
{
  const api = read('src/lib/api.ts');
  ok(api.includes('export async function getPublicSupportContacts'),
    'Frontend exports getPublicSupportContacts (blocked screen read)');
  ok(api.includes("'/support/contact'"), 'Public contacts hits GET /support/contact (no auth)');
}

// ── Routes: all 3 SupportController routes registered ───────────────────────
{
  const routes = read('backend/routes/api.php');
  ok(routes.includes("$router->put('/admin/support-settings', [SupportController::class, 'adminUpdate']"),
    'PUT /admin/support-settings is wired to SupportController::adminUpdate');
  ok(routes.includes("$router->get('/admin/support-settings', [SupportController::class, 'adminIndex']"),
    'GET /admin/support-settings is wired to SupportController::adminIndex');
  ok(routes.includes("$router->get('/support/contact', [SupportController::class, 'publicContact']"),
    'GET /support/contact is wired to SupportController::publicContact (public, no auth)');
}

console.log(`\n═══ supportContactSave: ${passed} passed, ${failed} failed ═══`);
if (failed) process.exit(1);
