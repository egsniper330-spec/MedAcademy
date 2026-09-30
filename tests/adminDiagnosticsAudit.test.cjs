/**
 * adminDiagnosticsAudit.test.cjs — audit + cleanup regression suite.
 *
 * Pins the three work streams of the Super Admin/Admin diagnostics audit:
 *
 *   STORAGE — the Storage page shows REAL server-measured numbers only:
 *     • GET /storage/stats exists, admin/SA-gated, read-only
 *     • disk (disk_total_space/disk_free_space), physical per-bucket scans,
 *       information_schema database size — nothing hardcoded, no row-count
 *       pretending to be file size
 *     • the fake client-side getStorageStats (DB rows → "storage") is gone
 *     • unavailable sections carry reasons; no silent catch on the page
 *
 *   VIDEO SETTINGS — authoritative live VdoCipher status:
 *     • GET /video/vdocipher-status exists, SA-gated, secret stays server-side
 *     • count from the live listing API (provider total or full pagination),
 *       never local DB rows; failures render unavailable + reason, not 0
 *     • webhook contract: real route /api/video/webhook, POST, HMAC
 *       X-VdoCipher-Signature, honest "dashboard could not be verified" text
 *     • Video Health + Video Monitor removed everywhere (routes, nav,
 *       wrappers, component, registry) without touching live infrastructure
 *
 *   DOCTOR EARNINGS — backend-enforced feature flag:
 *     • generic Data API read path gated for the earnings tables
 *     • named endpoints keep their existing gates
 *     • flag key doctor_earnings, 403 feature_disabled contract
 *
 * Run: node tests/adminDiagnosticsAudit.test.cjs
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r/g, '');

let passed = 0;
const failures = [];
function check(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failures.push(msg); console.error(`  ✗ ${msg}`); }
}
const exists = (p) => fs.existsSync(path.join(ROOT, p));

// ── A. STORAGE ────────────────────────────────────────────────────────────────
console.log('\n── Storage: real server-measured stats ──');
{
  const routes = src('backend/routes/api.php');
  check(/'\/storage\/stats',\s*\[StorageController::class, 'stats'\],\s*\$auth \+ \['role' => \['admin', 'super_admin'\]\]/.test(routes),
    'GET /storage/stats registered, admin/super_admin only');

  const sc = src('backend/src/Controllers/StorageController.php');
  check(/disk_total_space\(\$publicDir\)/.test(sc) && /disk_free_space\(\$publicDir\)/.test(sc),
    'disk metrics come from disk_total_space/disk_free_space (real volume)');
  check(/RecursiveIteratorIterator/.test(sc) && /SKIP_DOTS/.test(sc),
    'upload sizes from bounded recursive filesystem scans (app-owned dirs only)');
  check(/information_schema\.TABLES/.test(sc) && /data_length \+ index_length/.test(sc),
    'database size measured from information_schema (physical DB bytes, not row counts)');
  check(/filesystem_measurement_unavailable/.test(sc) && /database_measurement_unavailable/.test(sc),
    'unmeasurable sections report structured reasons (never fake zeros)');
  check(/'measured_root_label'/.test(sc),
    'the page states WHAT is measured (deployment volume), never overclaims the hosting account');
  check(!/['"]total_bytes['"]\s*=>\s*\d{4,}/.test(sc),
    'no hardcoded byte constants in the stats endpoint');
  check(/checked_at' => gmdate\('c'\)/.test(sc), 'response carries last-checked timestamp');

  const ss = src('backend/src/Storage/StorageService.php');
  check(/public function publicDir\(\): string/.test(ss) && /public function privateDir\(\): string/.test(ss),
    'StorageService exposes its roots for the measurement scan');

  // The fake client-side aggregator is gone.
  const api = src('src/lib/api.ts');
  check(!/getStorageStats/.test(api), 'fake client-side getStorageStats removed (was DB rows posing as storage)');
  check(/export async function getRealStorageStats/.test(api), 'getRealStorageStats fetches the real /storage/stats');
  check(!/catch\s*\{\s*return\s*\{[^}]*plyrStorage:\s*0/.test(api), 'no more silent catch → fake zero fallback');

  const page = src('src/app/(app)/(hubs)/storage.tsx');
  check(/getRealStorageStats/.test(page), 'Storage page consumes the real endpoint');
  check(!/catch \(_\) \{\}/.test(page), 'Storage page no longer swallows load errors silently');
  check(/Unable to load storage statistics/.test(page) && /Retry/.test(page),
    'load failure renders a proper error + Retry state');
  check(/SectionUnavailable/.test(page) && /reasonLabel/.test(page),
    'unavailable sections render with their reason');
  check(/Hosting Storage/.test(page) && /Application Uploads/.test(page) && /Database/.test(page),
    'page sections: hosting storage, uploads breakdown, database');
  check(/files/.test(page) && /bytes/.test(page), 'bucket rows report physical bytes AND file counts');
  check(/VdoCipher \(external CDN\)/.test(page),
    'VdoCipher content explicitly labeled as external (never counted as app storage)');
  // stale fake metrics must not resurface
  check(!/plyrStorage/.test(page) && !/vdoVideoCount/.test(page),
    'stale fake metrics (plyrStorage/vdoVideoCount) are gone from the page');
}

// ── B. VIDEO SETTINGS — authoritative VdoCipher status ───────────────────────
console.log('\n── Video Settings: authoritative VdoCipher status ──');
{
  const routes = src('backend/routes/api.php');
  check(/'\/video\/vdocipher-status',\s*\[VideoController::class, 'vdocipherStatus'\],\s*\$auth \+ \['role' => \['super_admin'\]\]/.test(routes),
    'GET /video/vdocipher-status registered, super_admin only');

  const vc = src('backend/src/Controllers/VideoController.php');
  check(/public function vdocipherStatus/.test(vc), 'vdocipherStatus implemented');
  check(/\$this->video->listAllVideos\(100, 100\)/.test(vc),
    'count uses the paginated listing API (up to 100 pages × 100 — never stops at page 1)');
  check(/\$listing\['total'\] \?\? count\(\$listing\['videos'\]\)/.test(vc),
    'count = VdoCipher-reported total when present, else full paginated row count');
  check(!/FROM lessons.*video_type.*vdocipher/s.test(vc.slice(vc.indexOf('vdocipherStatus'), vc.indexOf('public function assets'))),
    'count is NOT derived from local lessons/video_uploads rows');
  check(/listed_videos_size_note/.test(vc) &&
    /Total size of videos returned by the VdoCipher listing API/.test(vc),
    'size metric explicitly labeled as listing size — never "account storage usage"');
  check(/Not available from VdoCipher API|dashboard_verification/.test(vc) ||
    /'video_count' => null/.test(vc),
    'failed calls return null/unavailable fields — never fake zeros');
  check(!/Apisecret \{\$this->video->/.test(vc.slice(vc.indexOf('vdocipherStatus'), vc.indexOf('public function assets'))) &&
    !/VDOCIPHER_API_SECRET/.test(vc.slice(vc.indexOf('vdocipherStatus'), vc.indexOf('public function assets'))),
    'no API secret handling inside the status endpoint (delegated to VdoCipherService)');
  check(/'endpoint_url' => \$appUrl \. '\/api\/video\/webhook'/.test(vc),
    'webhook URL derived from server APP_URL → https://api.medacademy.site/api/video/webhook (not eu.cc, not frontend-generated)');
  check(/X-VdoCipher-Signature/.test(vc) && /secret_configured/.test(vc) &&
    /could not be verified automatically/.test(vc),
    'webhook card: HMAC header, secret-configured flag, honest dashboard-verification statement');
  check(!/VDOCIPHER_WEBHOOK_SECRET'\)\s*\.\s*\$|'secret' =>/.test(vc), 'no webhook secret value in the response');

  // Webhook handler robustness (pre-existing, now pinned)
  check(/HTTP_X_VDOCIPHER_SIGNATURE/.test(vc) && /hash_equals|verifyHmac/.test(vc),
    'webhook verifies the HMAC signature header');
  check(/\$webhookSecret === ''/.test(vc) && /501/.test(vc),
    'unconfigured webhook secret → explicit 501 (fail closed)');
  check(/match \(\$eventType\)/.test(vc) && /default => null/.test(vc),
    'unknown webhook events acknowledged + ignored (idempotent match)');

  const service = src('backend/src/Video/VdoCipherService.php');
  check(/'rows'/.test(service) && /'videos'/.test(service) && /'count'/.test(service),
    'listing parser accepts VdoCipher response shapes (rows/videos/bare array + count)');
  check(/rate_limited/.test(service) && /malformed_response/.test(service) && /upstream_' \. \$http/.test(service),
    'listing failures classified: rate limit, malformed, upstream 4xx/5xx');

  const page = src('src/app/(app)/(hubs)/video-settings.tsx');
  check(/getVdoCipherStatus/.test(page), 'Video Settings consumes the live status endpoint');
  check(/VdoCipher Connection/.test(page) && /Video Library/.test(page) &&
    /Storage \/ Usage/.test(page) && /Webhook/.test(page),
    'sections A–D present (Connection / Library / Usage / Webhook)');
  check(/Last checked/.test(page) && /RefreshCw/.test(page),
    'refresh control + last-checked timestamp');
  check(/Video count unavailable/.test(page) && /apiErrorReason/.test(page),
    'failed listing renders unavailable + reason (never "0 videos")');
  check(/Account storage usage.*Not available from VdoCipher API|value="Not available from VdoCipher API"/.test(page),
    'account storage usage explicitly marked unavailable (not fabricated)');
  check(/videos in the VdoCipher library/.test(page) && /count_source/.test(page),
    'library section shows the authoritative count with its source');
}

// ── C/D. VIDEO HEALTH + VIDEO MONITOR removed ────────────────────────────────
console.log('\n── Video Health / Video Monitor: removed cleanly ──');
{
  for (const f of [
    'src/app/(app)/(hubs)/video-health.tsx',
    'src/app/(app)/(hubs)/video-monitor.tsx',
    'src/app/(app)/(hubs)/sa-video-health.tsx',
    'src/app/(app)/(hubs)/sa-video-monitor.tsx',
    'src/components/VideoHealthDetails.tsx',
  ]) {
    check(!exists(f), `removed: ${f}`);
  }
  check(exists('src/app/(app)/(hubs)/video-settings.tsx'), 'Video Settings remains (the one authoritative page)');
  check(exists('src/app/(app)/(hubs)/video-library.tsx'), 'Video Library remains (upload/management, distinct purpose)');

  // No dangling references anywhere in app code.
  const glob = (dir, exts) => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
      }
    };
    walk(dir);
    return out;
  };
  const files = glob(path.join(ROOT, 'src'), ['.tsx', '.ts'])
    .filter((f) => !f.replace(/\\/g, '/').includes('providers/medacademy.ts'));
  // 'video-health-scan' is LIVE infrastructure (upload tickets/metadata) — its
  // references are pinned as kept above and must not trip this check.
  const offenders = files.filter((f) =>
    /video-health(?!-scan)|video-monitor|VideoHealthDetails/.test(fs.readFileSync(f, 'utf8')));
  check(offenders.length === 0, `no dangling references (${offenders.length || '0'} files)`);

  // Live infrastructure must NOT have been removed.
  const routes = src('backend/routes/api.php');
  check(/'\/video\/health-scan'/.test(routes), 'video-health-scan backend route kept (live upload infrastructure)');
  const map = src('src/client/php.ts');
  check(/'video-health-scan':\s*'\/video\/health-scan'/.test(map), 'video-health-scan route map kept');
  check(/healthScan/.test(src('backend/src/Controllers/VideoController.php')), 'healthScan controller kept (upload tickets/metadata)');

  // Navigation entries removed from every hub/overview/drawer.
  for (const f of [
    'src/components/DrawerNav.tsx',
    'src/app/(app)/(admin)/admin-overview.tsx',
    'src/app/(app)/(hubs)/sa-content.tsx',
    'src/app/(app)/(superadmin)/sa-overview.tsx',
    'src/app/(app)/(superadmin)/sa-analytics.tsx',
    'src/app/(app)/(superadmin)/sa-platform.tsx',
    'src/lib/nativeTabRegistry.tsx',
  ]) {
    check(!/video-health|video-monitor|Video Health|Video Monitor/.test(src(f)), `nav cleaned: ${f}`);
  }
}

// ── E. DOCTOR EARNINGS — backend-enforced flag ───────────────────────────────
console.log('\n── Doctor Earnings: backend enforcement ──');
{
  const dc = src('backend/src/Controllers/DataController.php');
  check(/private const EARNINGS_TABLES = \[\s*'doctor_earnings_events',\s*'doctor_earnings_transactions',\s*'doctor_payout_requests',\s*'doctor_pricing_history',\s*\]/.test(dc),
    'EARNINGS_TABLES defined (the generic-API bypass set)');
  check(/\$this->assertFeatureFlags\(\$table, \$request\)/.test(dc),
    'generic select() runs the feature-flag gate');
  check(/private function assertFeatureFlags/.test(dc) &&
    /assertEnabledFor\('doctor_earnings', \$request\)/.test(dc),
    'gate enforces doctor_earnings via assertEnabledFor (per-user overrides + SA exemption honored)');
  check(/in_array\(\$request->user\['role'\] \?\? '', \['admin', 'super_admin'\], true\)/.test(dc),
    'staff roles keep full visibility (dashboards unaffected)');
  check(/use MedAcademy\\Services\\FeatureFlagService;/.test(dc), 'FeatureFlagService imported');

  // Named endpoints keep their existing gates (regression guard).
  const rpc = src('backend/src/Controllers/RpcController.php');
  check(/doctorEarningsDashboard[\s\S]{0,600}?assertEnabled\('doctor_earnings'/.test(rpc),
    'RPC get_doctor_earnings_dashboard still gated');
  const credit = src('backend/src/Controllers/CreditController.php');
  check(/doctorEarnings\(Request[\s\S]{0,600}?assertEnabled\('doctor_earnings'/.test(credit),
    'GET /credits/doctor/{id} still gated');

  // Structured refusal contract (403 feature_disabled feature=doctor_earnings).
  const ex = src('backend/src/Http/FeatureDisabledException.php');
  check(/403/.test(ex) && /'feature_disabled'/.test(ex) && /\$feature/.test(ex),
    'refusal = HTTP 403 { code: feature_disabled, feature: <key> }');

  // Registry entry intact (SA exempt + read-only semantics documented).
  const ffs = src('backend/src/Services/FeatureFlagService.php');
  check(/'doctor_earnings' => \[[\s\S]{0,400}?'superadmin_exempt' => true/.test(ffs),
    'registry: doctor_earnings exists, superadmin_exempt preserved (no new bypass invented)');

  // Frontend: page consumes a gated source + renders a clean disabled state.
  const drPage = src('src/app/(app)/(doctor)/dr-earnings.tsx');
  check(/isFeatureEnabled\('doctor_earnings'\)/.test(drPage),
    'doctor earnings page reflects the flag (hidden/disabled state when off)');
  check(/Earnings Temporarily Unavailable/.test(drPage),
    'clean user-facing disabled state (no logout / suspension / maintenance misclassification)');
  const flags = src('src/lib/featureFlags.ts');
  check(/isFeatureDisabledError/.test(flags) && /feature_disabled/.test(flags),
    'client recognizes the structured feature_disabled refusal');
  check(/doctor_earnings: true/.test(flags), 'client registry mirrors the backend key');
}

console.log(`\n═══ adminDiagnosticsAudit: ${passed} passed, ${failures.length} failed ═══`);
if (failures.length) {
  failures.forEach((f) => console.error(`  FAIL: ${f}`));
  process.exit(1);
}
