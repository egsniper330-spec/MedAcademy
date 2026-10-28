#!/usr/bin/env node
/**
 * tests/healthEndpointsHardening.test.cjs
 *
 * Static guards for the health diagnostics endpoints (audit round 2, items 1-2).
 *
 *   • /system-health and /provider-health are admin-only (role gate in routes);
 *   • /provider-health selects an explicit column whitelist, so status_message,
 *     version and config (provider account / error details) never leave the server;
 *   • /health and /api/health are public but return only a database ping result,
 *     never raw exception text;
 *   • the client's `system-health` invoke still maps to a route that exists.
 *
 * Runtime behaviour is covered by backend/scripts/regression-test.php.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) {
    passed++;
  } else {
    failures.push(label + (detail ? ' — ' + detail : ''));
    console.log('  ✗ ' + label + (detail ? ' — ' + detail : ''));
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function section(title) {
  console.log('\n── ' + title + ' ──');
}

const controller = read('backend/src/Controllers/HealthController.php');
const routes = read('backend/routes/api.php');
const maintenance = read('backend/src/Middleware/MaintenanceMiddleware.php');
const client = read('src/client/php.ts');

section('1. Admin-only routing');

const systemRoute = routes.match(/\$router->get\('\/system-health'[^\n]*/);
const providerRoute = routes.match(/\$router->get\('\/provider-health'[^\n]*/);
ok('system-health route exists', !!systemRoute);
ok('provider-health route exists', !!providerRoute);
ok(
  "system-health gated to ['admin', 'super_admin']",
  !!systemRoute && /\$auth\s*\+\s*\['role'\s*=>\s*\['admin',\s*'super_admin'\]\]/.test(systemRoute[0])
);
ok(
  "provider-health gated to ['admin', 'super_admin']",
  !!providerRoute && /\$auth\s*\+\s*\['role'\s*=>\s*\['admin',\s*'super_admin'\]\]/.test(providerRoute[0])
);

section('2. provider-health column whitelist');

const providerFn = controller.slice(controller.indexOf('function providerHealth'));
const selectMatch = providerFn.match(/SELECT\s+([\s\S]*?)\s+FROM\s+provider_registry/);
ok('providerHealth queries provider_registry with an explicit SELECT list', !!selectMatch);
const columns = selectMatch ? selectMatch[1].split(',').map((c) => c.trim()) : [];
ok(
  'whitelist is exactly the non-sensitive columns',
  JSON.stringify(columns.sort()) ===
    JSON.stringify(
      ['provider_key', 'display_name', 'category', 'is_active', 'is_default', 'status', 'last_health_check'].sort()
    ),
  'got: ' + columns.join(', ')
);
ok('SELECT does not use *', !/SELECT\s+\*/.test(providerFn));
for (const sensitive of ['status_message', 'version', 'config', 'capabilities']) {
  ok('providerHealth does not return ' + sensitive, !columns.includes(sensitive));
}

section('3. /health and /system-health do not leak exception text');

const healthFn = controller.slice(controller.indexOf('function health('), controller.indexOf('function systemHealth'));
ok('health() returns only a generic error code', /'error'\s*=>\s*\$dbError/.test(healthFn) && /'database_unavailable'/.test(healthFn));
ok('health() does not interpolate caught exception message', !/\$e->getMessage\(\)/.test(healthFn));
const sysFn = controller.slice(controller.indexOf('function systemHealth'), controller.indexOf('function providerHealth'));
ok('systemHealth() does not interpolate caught exception message', !/\$e->getMessage\(\)/.test(sysFn));
ok('systemHealth() does not return hosts, paths or SQL', !/MEDACADEMY_BASE\s*\.\s*'/.test(sysFn.replace(/is_writable\(MEDACADEMY_BASE[^)]*\)/, '')));

section('4. Maintenance bypass list and client mapping');

ok(
  'maintenance allow-list names the health endpoints',
  /'\/health'[\s\S]*'\/system-health'[\s\S]*'\/provider-health'/.test(maintenance)
);
ok(
  "client maps 'system-health' to /system-health",
  /'system-health':\s*'\/system-health'/.test(client)
);
ok(
  "client maps 'provider-health' to /provider-health",
  /'provider-health':\s*'\/provider-health'/.test(client)
);

console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  console.log('FAILURES:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
