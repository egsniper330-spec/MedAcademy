'use strict';
/**
 * Security Dashboard contract guards.
 *
 * Regression: "riskyDevices.map is not a function" (2026-09). The backend
 * GET /analytics/risky-devices endpoint returned { devices: [...] } with
 * different field names, while the dashboard stored the payload directly as
 * RiskyDevice[] and called .map() on the object wrapper. The screen crashed
 * on open.
 *
 * These tests pin the CANONICAL CONTRACT on both sides so the mismatch can
 * never reintroduce the crash:
 *  - Backend: risky_devices wrapper + exact RiskyDevice field names.
 *  - Backend: securityStats window params + per-category counters.
 *  - Frontend: envelope unwrapping + array/shape guards + explicit error state.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r/g, '');

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed += 1;
  console.log('  ok - ' + label);
}

// ─── Backend: AnalyticsController riskyDevices() ─────────────────────────────
{
  const src = read('backend/src/Controllers/AnalyticsController.php');

  // Canonical wrapper key (NOT the legacy { devices: ... } shape).
  ok(/risky_devices'\s*=>/.test(src), 'riskyDevices() returns the canonical risky_devices wrapper key');
  ok(!/return \['devices' =>/.test(src), 'legacy { devices: ... } wrapper is gone');

  // Canonical RiskyDevice field names (the original Supabase get_risky_devices contract).
  ok(/d\.id AS device_id/.test(src), 'selects d.id AS device_id');
  ok(/p\.email AS user_email/.test(src), 'selects p.email AS user_email');
  ok(/d\.last_active_at AS last_seen/.test(src), 'selects d.last_active_at AS last_seen');
  ok(/p\.full_name AS user_name/.test(src), 'selects p.full_name AS user_name');
  ok(/max_risk_score/.test(src), 'produces max_risk_score');
  ok(/'event_types' =>/.test(src) || /"event_types" =>/.test(src) || /\$dev\['event_types'\]/.test(src), 'produces event_types');

  // Optional params the client sends (p_ prefix is stripped by the client bridge).
  ok(/\$q\['min_score'\]/.test(src), 'reads min_score param');
  ok(/\$q\['limit'\]/.test(src), 'reads limit param');
  ok(/\$q\['offset'\]/.test(src), 'reads offset param');

  // Deterministic, always-array output even for zero rows.
  const fnBody = src.slice(src.indexOf('public function riskyDevices'), src.indexOf('videoAssetUsage'));
  ok((fnBody.match(/risky_devices' => \[\]/g) || []).length >= 2, 'empty/filtered result sets still return risky_devices => []');

  // Authorization: route remains admin/super_admin only.
  const routes = read('backend/routes/api.php');
  ok(/'\/analytics\/risky-devices', \[AnalyticsController::class, 'riskyDevices'\], \$auth \+ \['role' => \['admin', 'super_admin'\]\]/.test(routes),
    'risky-devices route remains role-gated to admin + super_admin');
}

// ─── Backend: securityStats() window + counters ──────────────────────────────
{
  const src = read('backend/src/Controllers/AnalyticsController.php');

  ok(/\$q\['start_date'\]/.test(src), 'securityStats() reads start_date window param');
  ok(/\$q\['end_date'\]/.test(src), 'securityStats() reads end_date window param');
  for (const key of ['root_jailbreak', 'vpn', 'proxy', 'ssl_pinning', 'screenshot', 'screen_recording', 'debug', 'app_integrity']) {
    ok(src.includes(`'${key}`) || src.includes(`\`${key}\``), `securityStats() produces the ${key} counter`);
  }
  ok(/'by_type'/.test(src) && /'by_platform'/.test(src) && /'policies'/.test(src),
    'legacy keys (by_type, by_platform, policies) remain for compatibility');
}

// ─── Frontend: sec-dashboard contract handling ───────────────────────────────
{
  const src = read('src/app/(app)/(hubs)/sec-dashboard.tsx');

  // Envelope is unwrapped at the boundary — never stored raw as the array.
  ok(/risky_devices\s*\}\s*\|\s*null\s*\)?\.risky_devices|as \{ risky_devices\?/.test(src) && /\.risky_devices\)/.test(src),
    'device envelope payload is unwrapped via .risky_devices before setState');

  // Shape guards throw loudly on non-arrays (no silent coercion, no `as any`).
  ok(/const asRiskyDevices/.test(src) && /Array\.isArray\(payload\)/.test(src), 'asRiskyDevices guard requires an array');
  ok(/Malformed risky-devices response/.test(src), 'guard throws a clear error on malformed risky-devices payload');
  ok(/const asSecurityEvents/.test(src), 'events payload is guarded too');
  ok(/const asSecurityStats/.test(src) && /Array\.isArray\(payload\)/.test(src), 'stats guard rejects non-object payloads');
  ok(!/\bas any\b/.test(src), 'no `as any` casts');

  // Errors are explicit UI state — never turned into empty arrays.
  ok(/const \[loadError, setLoadError\]/.test(src), 'loadError state exists');
  ok(/setLoadError\(errors\[0\]\)/.test(src) && /\{loadError && /.test(src), 'loadError is rendered as a visible banner');
  ok(/Pull to refresh to retry/.test(src), 'error banner offers the retry path');

  // Error responses never flow into data state: each source checks .error first.
  ok(/if \(devicesRes\.error\)[\s\S]*?else\s*\{[\s\S]*?asRiskyDevices/.test(src), 'risky devices set only from success responses');
  ok(/if \(statsRes\.error\)[\s\S]*?else\s*\{[\s\S]*?asSecurityStats/.test(src), 'stats set only from success responses');
  ok(/if \(eventsRes\.error\)[\s\S]*?else\s*\{[\s\S]*?asSecurityEvents/.test(src), 'events set only from success responses');

  // Empty state still present (zero risky devices must render, not crash).
  ok(/riskyDevices\.length === 0 \?/.test(src) && /No risky devices detected/.test(src), 'zero-device empty state preserved');
  ok(/riskyDevices\.map\(/.test(src), 'device list rendering preserved');
}

// ─── Backend: securityEvents() — the profiles-embed replacement ─────────────
{
  const src = read('backend/src/Controllers/AnalyticsController.php');

  // Server-side identity join (many-to-one) instead of the generic-API embed.
  ok(/LEFT JOIN profiles p ON p\.id = se\.user_id/.test(src),
    'securityEvents() joins profiles via user_id server-side (no embed parser)');
  ok(src.includes("$r['profiles'] = $user;"), 'securityEvents() emits the profiles{full_name,email} contract shape');
  ok(/LIMIT 50/.test(src), 'securityEvents() caps the recent-events window');

  // Authorization: admin/super_admin only.
  const routes = read('backend/routes/api.php');
  ok(/'\/analytics\/security-events', \[AnalyticsController::class, 'securityEvents'\], \$auth \+ \['role' => \['admin', 'super_admin'\]\]/.test(routes),
    'security-events route is role-gated to admin + super_admin');

  // Client wiring: the dashboard no longer embeds profiles via the Data API.
  const dash = read('src/app/(app)/(hubs)/sec-dashboard.tsx');
  ok(!dash.includes("profiles(full_name"), 'dashboard no longer uses the broken profiles embed');
  ok(dash.includes("rpc('get_security_events'"), 'dashboard reads events via get_security_events RPC');
  const client = read('src/client/php.ts');
  ok(client.includes("'get_security_events':              '/analytics/security-events'"),
    'client maps get_security_events → /analytics/security-events');
  ok(/GET_RPCS = new Set\(\[[\s\S]*?'get_security_events'/.test(client), 'get_security_events is a GET rpc');
}

// ─── Security Policies admin plane (Option A — real policy management) ─────
{
  const ctrl = read('backend/src/Controllers/SecurityController.php');

  // Root-cause regression guard: the 500 came from Database::instance()
  // resolving to MedAcademy\Controllers\Database (no import).
  ok(ctrl.includes('use MedAcademy\\Database\\Database;'),
    'SecurityController imports MedAcademy\\Database\\Database (policies() cannot fatal)');

  // SA-only routes, validated update, audited writes, mandatory-block guard.
  const routes = read('backend/routes/api.php');
  ok(/'\/admin\/security\/policies', \[SecurityController::class, 'adminPolicies'\], \$auth \+ \['role' => \['super_admin'\]\]/.test(routes),
    'admin policies read route is super_admin only');
  ok(/'\/admin\/security\/policies\/\{type\}', \[SecurityController::class, 'updatePolicy'\], \$auth \+ \['role' => \['super_admin'\]\]/.test(routes),
    'admin policy update route is super_admin only (PUT {type})');
  ok(/vpn-whitelist'/.test(routes) && /addVpnWhitelist/.test(routes) && /deleteVpnWhitelist/.test(routes),
    'VPN whitelist management routes registered');

  ok(/POLICY_TYPES = \[/.test(ctrl) && ctrl.includes("'play_integrity'"),
    'policy types validated against the schema CHECK allowlist');
  ok(/MANDATORY_BLOCK = \['developer_options', 'debug', 'tamper', 'play_integrity'\]/.test(ctrl),
    'mandatory-block buckets pinned (migration 016 owner requirement)');
  ok(/cannot be weakened/.test(ctrl), 'write path refuses weakening mandatory policies');
  ok((ctrl.match(/AuditService::write/g) || []).length >= 3,
    'every policy/whitelist mutation is audited');

  // Client write plane goes through the SA endpoints (never the generic Data API).
  const page = read('src/app/(app)/(hubs)/sec-policies.tsx');
  ok(!page.includes("from('security_policies')"), 'policies page no longer PATCHes via the generic Data API');
  ok(!page.includes("from('security_vpn_whitelist')"), 'policies page no longer writes the whitelist via the generic Data API');
  ok(page.includes("admin-security-policy-update") && page.includes("method: 'PUT'"),
    'policies page saves via the SA PUT endpoint');
  ok(page.includes('MANDATORY_BLOCK'), 'policies page knows the mandatory-block set (UI parity)');
  ok(page.includes('invalidatePolicyCache()'), 'policies page still invalidates the enforcement cache after save');
  const client = read('src/client/php.ts');
  ok(client.includes("'admin-security-policy-update':  '/admin/security/policies/{type}'"),
    'client maps the SA policy update route');
  ok(/FORCE_PUT_FUNCTIONS = new Set\(\['set-app-update-config', 'admin-security-policy-update'\]\)/.test(client),
    'policy update enforces the PUT contract');
}

console.log(`\nsecurityDashboardContract: ${passed} guards passed`);
