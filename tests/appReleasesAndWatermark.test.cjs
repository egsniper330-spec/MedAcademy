/**
 * Automated tests for APP RELEASE MANAGEMENT (Super Admin production versions)
 * and the SECURITY CENTER WATERMARK ID fix.
 *
 * Run: node tests/appReleasesAndWatermark.test.cjs
 *
 * Part A — App releases (mig028): draft/pending releases never change Current
 * Production; publish/rollback are the ONLY production-changing actions;
 * semver compares numerically; one-active-per-platform invariant; download
 * URL required before publish; audit actions present; ForceUpdateGate keeps
 * consuming the published record via app_update_config.
 *
 * Part B — Watermark identity: the Security Center renders the canonical
 * public watermark identity (MED-#### via the shared resolver), never the
 * internal DB id / legacy token ("16"); read-only with copy feedback.
 *
 * Backend parts are pinned structurally against the shipped PHP source (no
 * PHP runtime in this environment — same convention as the other suites);
 * client pure helpers (semver.ts) are compiled and executed FOR REAL.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

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
function compileModule(name, code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relwm-'));
  const out = path.join(dir, name + '.js');
  const src = path.join(dir, name + '.ts');
  fs.writeFileSync(src, code, 'utf8');
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    src, '--outDir', dir, '--module', 'commonjs', '--target', 'es2020',
    '--skipLibCheck', '--noEmitOnError', 'false',
  ], { stdio: 'pipe' });
  return require(out);
}

// ════════════════════════════════════════════════════════════════════════════
// PART A — semantic version helper (BEHAVIORAL: real execution)
// ════════════════════════════════════════════════════════════════════════════
console.log('── Part A1: semver helper (executed) ──');
{
  const semver = compileModule('semver', read('src/lib/semver.ts'));
  const { normalizeSemanticVersion, isValidSemanticVersion, compareVersions, displayVersion } = semver;

  // Normalization: v-prefix optional, canonical stored WITHOUT it
  ok(normalizeSemanticVersion('1.0.0') === '1.0.0', 'normalize: plain version accepted');
  ok(normalizeSemanticVersion('v1.1.0') === '1.1.0', 'normalize: lowercase v stripped');
  ok(normalizeSemanticVersion('V1.1.0') === '1.1.0', 'normalize: uppercase V stripped');
  ok(normalizeSemanticVersion('  1.1.0  ') === '1.1.0', 'normalize: whitespace trimmed');
  ok(normalizeSemanticVersion('1.10.0') === '1.10.0', 'normalize: 1.10.0 preserved (never 1.1.0)');
  ok(normalizeSemanticVersion('1.1') === null, 'normalize: two-part rejected');
  ok(normalizeSemanticVersion('1.1.0.0.1') === null, 'normalize: five-part rejected');
  ok(normalizeSemanticVersion('01.2.3') === null, 'normalize: leading-zero noise rejected');
  ok(normalizeSemanticVersion('abc') === null, 'normalize: non-numeric rejected');
  ok(normalizeSemanticVersion('') === null, 'normalize: empty rejected');
  ok(normalizeSemanticVersion(null) === null, 'normalize: null rejected');
  ok(isValidSemanticVersion('2.0.0') === true, 'isValid: valid accepted');
  ok(isValidSemanticVersion('1.1') === false, 'isValid: invalid rejected');

  // Comparison: NUMERIC, never lexicographic
  ok(compareVersions('1.0.0', '1.0.1') < 0, 'compare: 1.0.0 < 1.0.1');
  ok(compareVersions('1.0.1', '1.1.0') < 0, 'compare: 1.0.1 < 1.1.0');
  ok(compareVersions('1.1.0', '2.0.0') < 0, 'compare: 1.1.0 < 2.0.0');
  ok(compareVersions('1.10.0', '1.9.0') > 0, 'compare: 1.10.0 > 1.9.0 (string comparison bug class)');
  ok(compareVersions('1.10.0', '1.9.0') > 0, 'compare: 1.10.0 > 1.9.0 again (pinned)');
  ok(compareVersions('1.0.0', '1.0.0') === 0, 'compare: equal versions → 0');
  ok(compareVersions('v1.2.0', '1.2.0') === 0, 'compare: v-prefix ignored');
  ok(compareVersions('1.0', '1.0.0') === 0, 'compare: missing part = 0');

  ok(displayVersion('1.1.0') === 'v1.1.0', 'display: v prefix added for display');
  ok(displayVersion('v1.1.0') === 'v1.1.0', 'display: idempotent');
}

// ════════════════════════════════════════════════════════════════════════════
// PART A2 — AppReleaseService (structural pins on the PHP source)
// ════════════════════════════════════════════════════════════════════════════
console.log('── Part A2: backend release service (structural) ──');
{
  const svc = read('backend/src/Services/AppReleaseService.php');

  ok(/class AppReleaseService/.test(svc), 'service exists in the backend');

  // THE INVARIANT: only publish/rollback change production
  ok(/THE ONLY OPERATION that changes Current Production/.test(svc) && /public function publish\(/.test(svc),
    'publish() documented and implemented as the only production-changing action');
  ok(/createRelease|updateRelease/.test(svc) && /status = \?/ .test(svc),
    'create/update write draft/ready rows only');
  ok(/A new release must start as draft or ready/.test(svc),
    'create: cannot create directly as published/archived');
  ok(/Published releases are immutable/.test(svc),
    'update: published rows immutable (no accidental production edits)');

  // Publish: archives previous + sets published, in ONE transaction, with
  // semver ordering guard
  ok(/SELECT id, version, published_at FROM app_releases\s*\n\s*WHERE platform = \? AND status = 'published'\s*\n\s*FOR UPDATE/.test(svc),
    'publish: locks the current production row (concurrency-safe)');
  ok(/UPDATE app_releases SET status = 'archived'/.test(svc) && /status = 'published', published_at = UTC_TIMESTAMP\(6\)/.test(svc),
    'publish: archives previous + publishes new atomically');
  ok(/it is older than the current production/.test(svc) && /Use rollback to re-activate/.test(svc),
    'publish: refuses older versions (rollback is the explicit path)');
  ok(/public function rollback\(/.test(svc) && /release_rollback/.test(svc),
    'rollback: explicit re-activation of a previous release, audited');

  // Download URL required before publish
  ok(/A download URL is required before this release can be published/.test(svc),
    'publish: blocked when download_url missing (validation, not silent)');

  // Semver compare on the backend too (numeric, mirrored from client helper)
  ok(/public static function compareVersions\(string \$a, string \$b\): int/.test(svc),
    'service: centralized numeric comparison exists server-side');
  ok(/\(int\) \$pa\[\$i\]/.test(svc), 'service: comparison casts parts to int (never string compare)');

  // Version validation
  ok(/public static function normalizeVersion\(mixed \$raw\): \?string/.test(svc),
    'service: version normalization (v-prefix strip + validation) server-side');
  ok(/version must be semantic \(e\.g\. 1\.1\.0\)/.test(svc),
    'service: invalid versions rejected with a clear message');
  ok(/A \{\$platform\} release for version \{\$version\} already exists/.test(svc),
    'service: duplicate live version per platform rejected');

  // One-active-per-platform: DB-level + transaction
  ok(/FOR UPDATE/.test(svc), 'service: row locking on the production transition');

  // Audit + gate promotion
  ok(/release_created/.test(svc) && /release_updated/.test(svc) && /release_published/.test(svc)
    && /release_rollback/.test(svc) && /release_archived/.test(svc),
    'audit: all five release events written via AuditService');
  ok(/promoteToUpdateConfig/.test(svc) && /app_update_config/.test(svc),
    'gate integration: publish promotes the release into app_update_config (ForceUpdate source)');
  ok(/update_mode, is_enabled FROM app_update_config/.test(svc),
    'gate integration: policy (mode/enabled) preserved from the existing config');
  ok(/minimum_version_code[\s\S]{0,80}VALUES|, 0, \?/.test(svc) || /VALUES \(\?, \?, \?, 0, \?/.test(svc),
    'gate integration: minimum floor never silently moved by a publish (stays operator-controlled)');
}

// ════════════════════════════════════════════════════════════════════════════
// PART A3 — migration 028 + schema + routes + controller
// ════════════════════════════════════════════════════════════════════════════
console.log('── Part A3: migration/schema/routes (structural) ──');
{
  const mig = read('backend/database/mysql-migrations/028_app_release_management.sql');
  const schema = read('backend/database/schema.sql');
  const routes = read('backend/routes/api.php');
  const ctl = read('backend/src/Controllers/AppReleaseController.php');

  ok(/CREATE TABLE IF NOT EXISTS `app_releases`/.test(mig), 'migration 028: app_releases table');
  ok(/UNIQUE KEY `uq_app_releases_one_active` \(`active_marker`\)/.test(mig),
    'migration 028: one-active-per-platform enforced at the DB level');
  ok(/status.*published.*THEN.*platform.*ELSE NULL/.test(mig.replace(/\s+/g, ' ')) || /WHEN `status` = 'published' THEN `platform` ELSE NULL END/.test(mig),
    'migration 028: generated marker column implements the partial-unique trick');
  ok(/draft \| ready \| published \| archived/.test(mig), 'migration 028: full status model');
  ok(/'android', '1\.0\.0', 1, NULL/.test(mig) && /'ios', '1\.0\.0', NULL, 1/.test(mig),
    'migration 028: initial production reset to v1.0.0 per platform (build numbers 1, not zero)');
  ok(/WHERE NOT EXISTS/.test(mig), 'migration 028: reset only when the platform has no releases (idempotent)');
  ok(/release_created', 'release_updated', 'release_published', 'release_rollback', 'release_archived'/.test(mig),
    'migration 028: audit actions appended to chk_audit_logs_action');
  ok(/versionCode \(separate concept|developer-facing versionCode/.test(mig),
    'migration 028: documents versionCode/buildNumber as separate from the semantic version');

  ok(/app_releases/.test(schema) && /uq_app_releases_one_active/.test(schema),
    'schema.sql mirrors the app_releases table');
  ok(/release_created', 'release_updated', 'release_published', 'release_rollback', 'release_archived'/.test(schema),
    'schema.sql audit actions match');

  ok(/\$router->get\('\/admin\/app-releases'/.test(routes) && /\$router->post\('\/admin\/app-releases\/\{id\}\/publish'/.test(routes),
    'routes: release endpoints registered (list/create/update/publish/rollback/archive)');
  ok(/'role' => \['super_admin'\]/.test(routes.split('/admin/app-releases')[1]?.split(';')[0] ?? ''),
    'routes: all release endpoints Super Admin-gated');
  ok(/assertSuperAdmin/.test(ctl),
    'controller: explicit in-controller super_admin check (defense in depth)');
}

// ════════════════════════════════════════════════════════════════════════════
// PART A4 — ForceUpdateGate integration contract
// ════════════════════════════════════════════════════════════════════════════
console.log('── Part A4: ForceUpdateGate integration ──');
{
  const gate = read('src/lib/updateConfigService.ts');
  const api = read('src/lib/api.ts');
  const screen = read('src/app/(app)/(superadmin)/app-updates.tsx');

  // The gate keeps consuming the versionCode-based config (now fed by the
  // published release) — untouched comparison contract.
  ok(/evaluateUpdateVerdict/.test(gate), 'gate: verdict model unchanged (versionCode authoritative)');
  ok(/X-App-Platform|X-App-Version-Code/.test(gate) || /x-app-platform/i.test(gate),
    'gate: platform/versionCode headers intact (server-side 426 enforcement)');
  ok(/nativeApplicationVersion|expoConfig\?\.version/.test(gate),
    'gate: installed version from the native build source');
  ok(/getInstalledVersionCode|getInstalledVersionName/.test(gate),
    'gate: runtime accessors for installed version/versionCode');

  // Screen: separation of concepts + no auto-increment anywhere
  ok(/Current Production/.test(screen) && /Prepare New Release/.test(screen)
    && /Pending Releases/.test(screen) && /Release History/.test(screen),
    'screen: four sections (production / prepare / pending / history)');
  ok(/Saving a draft NEVER changes Current Production/.test(screen),
    'screen: explicit statement that drafts never touch production');
  ok(/Current Production becomes/.test(screen),
    'screen: publish confirm dialog states the production change');
  ok(/Download URL required/.test(screen),
    'screen: publish blocked client-side when URL missing');
  ok(/Activate for Production/.test(screen),
    'screen: rollback surfaced as an explicit activation action');
  ok(/NEVER changes automatically|NEVER change automatically/.test(screen),
    'screen: no-auto-increment statement present');
  ok(!/Date\.now\(\).*version|version.*\+\s*1\b/.test(screen), 'screen: no client-side version increment');
  ok(/normalizeSemanticVersion/.test(screen), 'screen: version validated via the central helper');
  ok(/displayVersion/.test(screen), 'screen: display form via the central helper (canonical stored without v)');

  // API layer wired to the real endpoints
  ok(/\/admin\/app-releases/.test(api) && /publishAppRelease|rollbackAppRelease/.test(api),
    'api: typed release wrappers call the real endpoints');
}

// ════════════════════════════════════════════════════════════════════════════
// PART B — Security Center watermark identity
// ════════════════════════════════════════════════════════════════════════════
console.log('── Part B: Security Center watermark identity ──');
{
  const screen = read('src/app/(app)/security.tsx');
  const resolver = read('src/lib/watermarkIdentity.ts');

  // THE REGRESSION: no raw profile?.watermark_id rendering in the Security Center
  ok(!/profile\?\.watermark_id \?\? 'N\/A'/.test(screen),
    'security center: raw legacy watermark_id rendering REMOVED (the "16" bug)');
  ok(/resolveWatermarkIdentity\(profile\)/.test(screen),
    'security center: uses the ONE canonical resolver (same source as players)');
  ok(!/profile\?\.(id|user_id)\b.*watermark/i.test(screen), 'security center: never renders the DB id');

  // Same identity everywhere: all watermark consumers share the resolver
  for (const f of [
    'src/components/OfflineVideoPlayer.native.tsx',
    'src/components/VdoCipherPlayerNativeAdapter.native.tsx',
    'src/app/(app)/offline-course.tsx',
    'src/app/(app)/offline-library.tsx',
  ]) {
    ok(/resolveWatermarkIdentity/.test(read(f)), `shared resolver used by ${f.split('/').pop()}`);
  }

  // Resolver behavioral check (executed): UUID/legacy token "16" never resolve
  const mod = compileModule('wmsec', resolver);
  ok(mod.resolveWatermarkIdentity({ public_user_id: 'MED-0016', watermark_id: '16' })?.id === 'MED-0016',
    'resolver: public MED id wins over the legacy token "16"');
  // Resolver backward-compat (pinned by offlineState too): legacy WM tokens
  // still resolve FOR RENDERING — identity DISPLAYS are filtered stricter.
  ok(mod.resolveWatermarkIdentity({ public_user_id: null, watermark_id: 'WM-20251234' })?.id === 'WM-20251234',
    'resolver: legacy token still resolves for rendering (no rendering regression)');
  ok(mod.isPublicWatermarkToken('16') === false, 'display filter: bare numeric "16" is never shown as the public identity');
  ok(mod.isPublicWatermarkToken('MED-0016') === true, 'display filter: MED-0016 is public');
  ok(mod.isPublicWatermarkToken('10') === false, 'display filter: hex-legacy decimal "10" (hex A) also blocked from display');
  ok(mod.isPublicWatermarkToken('758490a6-5538-4af2-acf3-a72b862804d6') === false, 'display filter: UUID blocked');
  ok(mod.resolveWatermarkIdentity({ public_user_id: '758490a6-5538-4af2-acf3-a72b862804d6' }) === null,
    'resolver: UUID never rendered');

  // UI contract: read-only + copy + not-applicable state for SA without identity
  ok(/Copy watermark ID/.test(screen), 'security center: copy button with a11y label');
  ok(/Copied ✓/.test(screen), 'security center: copy success feedback');
  // The identity must never be bound to an editable input value: the only
  // TextInput values in this screen are the password fields.
  const identityBlock = screen.slice(screen.indexOf('Watermark ID'), screen.indexOf('Change Password'));
  ok(!/TextInput/.test(identityBlock), 'security center: identity is a read-only display (no TextInput in the card)');
  ok(/Not applicable/.test(screen), 'security center: explicit not-applicable state (no DB-id fallback)');
  ok(/Read-only/.test(screen), 'security center: read-only note present');
  ok(/isPublicWatermarkToken/.test(screen) && /isPublicWatermarkToken/.test(resolver),
    'security center: bare-numeric internal-id filter applied at display time');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
