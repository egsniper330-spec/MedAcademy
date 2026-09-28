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

console.log(`\nsecurityDashboardContract: ${passed} guards passed`);
