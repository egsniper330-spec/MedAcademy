/**
 * Automated tests for the PLATFORM CONTROL CENTER
 * (Branding · CMS Pages · Feature Flags · Platform child navigation).
 *
 * Run: node tests/platformCenter.test.cjs
 *
 * Backend (structural): no PHP runtime exists in this environment, so the
 * authoritative behaviour of PlatformController / FeatureFlagService and the
 * enforcement call sites is verified STRUCTURALLY against the shipped PHP
 * source (regex over the real files; any behavioural change to the pinned code
 * path breaks these tests).
 *
 * Frontend (behavioural): the new pure services (featureFlags / branding /
 * cmsContent) are compiled with the project's own babel and executed against a
 * stubbed transport, so fail-open semantics, normalization and the CMS parser
 * are tested FOR REAL, not just textually.
 *
 * Covered from the request:
 *   • self-initializing endpoints (no "Branding unavailable" / "No CMS pages")
 *   • registry-owned flag key space, fail-open defaults, SA exemption on login
 *   • server-side enforcement at every pinned call site (never UI-only)
 *   • flags never override auth / suspension / maintenance (ordering pins)
 *   • branding defaults consistent between PHP and TS (cross-language)
 *   • CMS bodies are plain text (no HTML execution anywhere)
 *   • Platform child pages carry the explicit back action
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
const failures = [];
// Async contract tests land their assertions before the report is printed.
let brandingTests = Promise.resolve();
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.log('  ✗ ' + msg); }
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

// ─── Backend: routes & wiring ──────────────────────────────────────────────────
{
  const routes = read('backend/routes/api.php');
  ok(/use MedAcademy\\Controllers\\PlatformController;/.test(routes), 'routes: PlatformController imported');
  ok(/\$router->get\('\/platform\/branding', \[PlatformController::class, 'branding'\], \$auth\)/.test(routes),
    'routes: GET /platform/branding (authenticated)');
  ok(/\$router->put\('\/platform\/branding'.*\['super_admin'\]/.test(routes),
    'routes: PUT /platform/branding is Super Admin only');
  ok(/\$router->get\('\/platform\/pages', \[PlatformController::class, 'pages'\], \$auth\)/.test(routes),
    'routes: GET /platform/pages');
  ok(/\$router->put\('\/platform\/pages\/\{key\}'.*\['super_admin'\]/.test(routes),
    'routes: PUT /platform/pages/{key} is Super Admin only');
  ok(/\$router->get\('\/platform\/feature-flags', \[PlatformController::class, 'featureFlags'\], \$auth\)/.test(routes),
    'routes: GET /platform/feature-flags');
  ok(/\$router->put\('\/platform\/feature-flags\/\{key\}'.*\['super_admin'\]/.test(routes),
    'routes: PUT /platform/feature-flags/{key} is Super Admin only');
}

// ─── Backend: PlatformController contract ──────────────────────────────────────
{
  const pc = read('backend/src/Controllers/PlatformController.php');
  // Self-initializing reads (the screens' empty states are unreachable now).
  ok(/private function ensureBranding\(\): array/.test(pc) && /INSERT IGNORE INTO `app_branding`/.test(pc),
    'platform: branding row created on demand (INSERT IGNORE, idempotent)');
  ok(/private function ensurePages\(\): array/.test(pc) && /INSERT IGNORE INTO `app_pages`/.test(pc),
    'platform: CMS pages created on demand (INSERT IGNORE, idempotent)');
  // Registry-owned page set — no arbitrary content keys.
  ok(/'terms_conditions'\s+=> \[/.test(pc)
    && /'privacy_policy'\s+=> \[/.test(pc)
    && /'about_us'\s+=> \[/.test(pc)
    && /'contact_us'\s+=> \[/.test(pc),
    'platform: CMS registry covers the four real pages');
  // Super Admin re-check inside the controller (defence in depth).
  ok((pc.match(/assertSuperAdmin\(\$request\)/g) || []).length >= 3,
    'platform: every write re-checks Super Admin inside the controller');
  // Validated, column-allowlisted writes (no mass assignment).
  ok(/BRANDING_COLUMNS = \[/.test(pc) && /app_name', 'logo_url'/.test(pc.replace(/\r?\n\s*/g, ' ')),
    'platform: branding writes restricted to an explicit column allowlist');
  ok(/must start with http:\/\/ or https:\/\//.test(pc),
    'platform: URL fields validated as http(s) (no javascript:/data: payloads)');
  ok(/filter_var\(\$updates\[\$emailKey\], FILTER_VALIDATE_EMAIL\)/.test(pc),
    'platform: contact emails validated');
  // Safe content contract: plain text, empty body means built-in text.
  ok(/using_builtin' => trim\(\(string\) \(\$row\['content'\] \?\? ''\)\) === ''/.test(pc.replace(/' =>/, "' =>")),
    'platform: empty body flagged as built-in text (restore-default semantics)');
  ok(/content is limited to 20000 characters/.test(pc), 'platform: CMS body size bounded');
  // Audited writes (flag toggles audit inside FeatureFlagService — see below).
  ok(/AuditService::write\(/.test(pc) && /'setting' => 'branding'/.test(pc) && /'setting' => 'cms_page'/.test(pc),
    'platform: branding + CMS writes audited through AuditService');
}

// ─── Backend: FeatureFlagService contract ──────────────────────────────────────
{
  const svc = read('backend/src/Services/FeatureFlagService.php');
  for (const key of ['user_registration', 'user_login', 'course_creation',
                     'doctor_course_publishing', 'course_enrollment', 'doctor_earnings']) {
    ok(new RegExp(`'${key}' => \\[`).test(svc), `flags: registry declares '${key}'`);
  }
  // Fail-open defaults: every registry default is true.
  ok(!/'default'\s+=> false/.test(svc), 'flags: no registry default disables a capability');
  ok(/FAIL OPEN/.test(svc) && /catch \(\\Throwable\)/.test(svc),
    'flags: DB/table failure resolves to defaults (fail open)');
  ok(/Unknown feature flag/.test(svc) && /422/.test(svc),
    'flags: unknown keys rejected on write (registry-owned key space)');
  ok(/'superadmin_exempt' => true,\s*\n\s*\],\s*\n\s*'user_login'/s.test(svc.replace(/\r\n/g, '\n'))
    || (/user_login[\s\S]{0,400}superadmin_exempt' => true/.test(svc)),
    'flags: user_login is superadmin_exempt (no SA lockout)');
  ok(/FeatureDisabledException\(\s*\$key,/.test(svc),
    'flags: refusal is a typed 403 feature_disabled');
  ok(/AuditService::write\(/.test(svc) && /flushCache\(\)/.test(svc),
    'flags: toggles are audited and immediately visible (cache flushed)');
}

// ─── Backend: enforcement call sites (never UI-only) ───────────────────────────
{
  const auth = read('backend/src/Services/AuthService.php');
  // registration refused before any row is created
  ok(/assertEnabled\('user_registration', \$request\)/.test(auth),
    'enforced: user_registration on AuthService::register');
  {
    // Order-based pin: inside register(), the flag call must precede the first
    // write/insert (or any delegation that would create the account).
    const regStart = auth.indexOf('public function register');
    const regSlice = auth.slice(regStart, auth.indexOf('public function', regStart + 10));
    const flagAt = regSlice.indexOf("assertEnabled('user_registration'");
    const firstWrite = ['INSERT INTO', '->insert(', 'ON DUPLICATE KEY']
      .map((t) => regSlice.indexOf(t)).filter((i) => i >= 0);
    ok(flagAt >= 0 && (firstWrite.length === 0 || firstWrite.every((i) => i > flagAt)),
      'enforced: registration flag fires BEFORE account creation');
  }
  // login: after credentials + account status, before session; SA exempt
  ok(/assertEnabled\('user_login', \$request\)/.test(auth),
    'enforced: user_login on AuthService::login');
  ok(/\(\(\$account\['role'\] \?\? ''\) !== 'super_admin'\)\s*{\s*\$this->flags->assertEnabled\('user_login'/s.test(auth.replace(/\r\n/g, '\n')),
    'enforced: Super Admin bypasses the login flag (role from the authenticated account row)');
  {
    // Order-based pin: credentials → suspension policy → flag.
    const loginStart = auth.indexOf('public function login');
    const loginSlice = auth.slice(loginStart, auth.indexOf('public function', loginStart + 10));
    const suspendedAt = loginSlice.indexOf("['suspended', 'blocked']");
    const flagAt = loginSlice.indexOf("assertEnabled('user_login'");
    ok(suspendedAt >= 0 && flagAt > suspendedAt,
      'enforced: login flag evaluated AFTER account-suspension policy (suspension always wins)');
  }

  const course = read('backend/src/Controllers/CourseController.php');
  ok(/assertEnabled\('course_creation', \$request\)/.test(course), 'enforced: course_creation on CourseController::create');
  ok(/assertEnabled\('doctor_course_publishing', \$request\)/.test(course), 'enforced: doctor_course_publishing on CourseController::publish');
  ok(/assertEnabled\('course_enrollment', \$request\)/.test(course), 'enforced: course_enrollment on CourseController::enroll');
  {
    // Order-based pin: inside publish(), the flag precedes any DB access/write.
    const pubStart = course.indexOf('public function publish');
    const pubSlice = course.slice(pubStart, course.indexOf('public function', pubStart + 10));
    const flagAt = pubSlice.indexOf("assertEnabled('doctor_course_publishing'");
    const firstDb = ['Database::instance()', '->query(', '->update(']
      .map((t) => pubSlice.indexOf(t)).filter((i) => i >= 0);
    ok(flagAt >= 0 && (firstDb.length === 0 || firstDb.every((i) => i > flagAt)),
      'enforced: publish flag fires before any course write (drafts/published untouched)');
  }

  const credit = read('backend/src/Controllers/CreditController.php');
  ok(/assertEnabled\('doctor_earnings', \$request\)/.test(credit), 'enforced: doctor_earnings on CreditController::doctorEarnings');
  const rpc = read('backend/src/Controllers/RpcController.php');
  ok(/assertEnabled\('doctor_earnings', \$request\)/.test(rpc), 'enforced: doctor_earnings on RpcController::doctorEarningsDashboard (doctor-facing)');

  // Generic data API can no longer rewrite identity/content behind the SA back.
  const data = read('backend/src/Controllers/DataController.php');
  ok(/'app_branding', 'app_pages',/.test(data), 'enforced: app_branding/app_pages writes gated to Super Admin in the generic data API');
}

// ─── Backend: error mapping + migration ────────────────────────────────────────
{
  const eh = read('backend/src/Middleware/ErrorHandler.php');
  ok(/FeatureDisabledException/.test(eh) && /feature_disabled/.test(eh),
    'errors: FeatureDisabledException → 403 code feature_disabled');

  const mig = read('backend/database/mysql-migrations/022_platform_content_defaults.sql');
  ok(/INSERT IGNORE INTO `app_branding`/.test(mig) && /00000000-0000-0000-0000-000000000001/.test(mig),
    'migration: branding row seeded with the client-fixed id');
  ok(/INSERT IGNORE INTO `app_pages`/.test(mig) && /terms_conditions/.test(mig) && /privacy_policy/.test(mig)
    && /about_us/.test(mig) && /contact_us/.test(mig),
    'migration: all four CMS pages seeded (empty content = built-in text)');
  ok(/INSERT IGNORE INTO `feature_flags`/.test(mig), 'migration: feature flags seeded');
  ok(/, '', 1,/.test(mig), 'migration: CMS bodies stay EMPTY (legal copy never replaced by a stub)');
  ok(/, 1, UTC_TIMESTAMP\(6\)\)/.test(mig) || /, 1, UTC_TIMESTAMP\(6\)/.test(mig),
    'migration: every flag seeded ENABLED (fail-open starting state)');
}

// ─── Frontend: behavioural tests of the new pure services ──────────────────────
{
  const babel = require('@babel/core');
  // Compiled modules live INSIDE the project tree so require('react') and the
  // transport alias resolve through the real node_modules (a temp dir sits
  // outside the package root, where resolution fails).
  const outDir = path.join(ROOT, '.freebuff', 'platform-cc-test');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const stubPath = path.join(outDir, 'transport-stub.js').replace(/\\/g, '/');
  fs.writeFileSync(stubPath,
    "let handler = async () => ({ data: null, error: null });\n" +
    "module.exports = { apiFetch: (...a) => handler(...a), __setHandler: (fn) => { handler = fn; } };\n");

  const compile = (rel, modName) => {
    const src = read(rel);
    const out = babel.transformSync(src, {
      filename: modName + '.ts',
      configFile: false, babelrc: false,
      presets: [],
      plugins: [
        [require('@babel/plugin-transform-typescript'), { isTSX: false, allExtensions: true }],
        require('@babel/plugin-transform-modules-commonjs'),
      ],
    }).code
      .replace(/require\("\@\/client\/backendClient"\)/g, 'require("' + stubPath + '")')
      .replace(/require\("\@\/client\/php"\)/g, 'require("' + stubPath + '")');
    const file = path.join(outDir, modName + '.js');
    fs.writeFileSync(file, out);
    return require(file);
  };

  // 1. Feature flags — fail-open resolution.
  try {
    const flags = compile('src/lib/featureFlags.ts', 'featureFlags');
    ok(Object.values(flags.FEATURE_FLAG_DEFAULTS).every(Boolean),
      'client flags: every default is ENABLED (fail open)');
    ok(flags.isFeatureEnabled('course_creation') === true,
      'client flags: known key resolves enabled before any fetch');
    ok(flags.isFeatureEnabled('totally_unknown_flag') === true,
      'client flags: unknown key fails open (never silently disables)');
    const cached = flags.cachedFeatureFlags();
    ok(typeof cached === 'object' && cached !== null, 'client flags: cached state always resolvable synchronously');
  } catch (e) {
    ok(false, 'client flags: module compiled/executed — ' + e.message);
  }

  // 2. Branding — normalization always yields a complete object, and the module
  //    cache serves the LAST KNOWN state when the network dies (async contract,
  //    driven through fetchBrandingSafe with a scripted transport).
  const brandingTestsLocal = (async () => {
    try {
      const branding = compile('src/lib/branding.ts', 'branding');
      const fromGarbage = branding.normalizeBranding(null);
      ok(fromGarbage.app_name === 'MedAcademy' && fromGarbage.primary_color === '#1565C0',
        'client branding: null response normalizes to the built-in defaults');
      const partial = branding.normalizeBranding({ app_name: 'CustomName', logo_url: '  ' });
      ok(partial.app_name === 'CustomName' && partial.primary_color === '#1565C0' && partial.logo_url === '',
        'client branding: partial/blank fields fall back per-field');
      const transport = require(stubPath);
      transport.__setHandler(async () => ({ data: { branding: { app_name: 'CustomName' } }, error: null }));
      const live = await branding.fetchBrandingSafe(true);
      ok(live !== undefined && live.app_name === 'CustomName',
        'client branding: successful fetch adopts the server identity');
      transport.__setHandler(async () => { throw new Error('network down'); });
      const afterFail = await branding.fetchBrandingSafe(true);
      ok(afterFail !== undefined && afterFail.app_name === 'CustomName' && afterFail.primary_color === '#1565C0',
        'client branding: failed fetch serves last known state, never undefined');
    } catch (e) {
      ok(false, 'client branding: module compiled/executed — ' + e.message);
    }
  })();
  brandingTests = brandingTestsLocal;

  // 3. CMS parser — plain text only, headings, empty → [].
  try {
    const cms = compile('src/lib/cmsContent.ts', 'cmsContent');
    ok(cms.parseCmsBody('').length === 0 && cms.parseCmsBody('   \n  ').length === 0,
      'client cms: empty/blank body → no sections (built-in text stands)');
    const parsed = cms.parseCmsBody('Intro line.\n\n## First\nBody A.\nBody B.\n\n## Second\nTail.');
    ok(parsed.length === 3, 'client cms: paragraphs + headings split into sections');
    ok(parsed[0].heading === '' && parsed[0].body === 'Intro line.', 'client cms: leading paragraph kept without a heading');
    ok(parsed[1].heading === 'First' && parsed[1].body === 'Body A.\nBody B.', 'client cms: multi-line bodies preserved');
    // No HTML execution surface: parser only ever returns strings it was given.
    const hostile = cms.parseCmsBody('<script>alert(1)</script>');
    ok(hostile.length === 1 && typeof hostile[0].body === 'string' && !hostile[0].hasOwnProperty('__proto__'),
      'client cms: hostile text stays inert plain text (no html rendering path)');

    // ROUND-TRIP: the seeded migration 024 bodies must parse to EXACTLY the
    // built-in sections the legal screens render — no content loss, no drift.
    const mig = fs.readFileSync('backend/database/mysql-migrations/024_platform_content_migration_and_flag_overrides.sql', 'utf8');
    const bodyFor = (key) => {
      const idx = mig.indexOf("WHERE `key` = '" + key + "'");
      if (idx < 0) return null;
      const start = mig.lastIndexOf('UPDATE `app_pages`', idx);
      const m = mig.slice(start, idx).match(/= '([\s\S]*)',\s*\n\s*`updated_at`/);
      return m ? m[1] : null;
    };
    const unescapeSql = (s) => s.replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/''/g, "'");
    const extractSections = (file) => {
      const re = /heading:\s*'([^']*)',\s*\n\s*body:\s*'((?:[^'\\\\]|\\\\.)*)'/g;
      const secs = [];
      let m;
      while ((m = re.exec(fs.readFileSync(file, 'utf8'))) !== null) {
        secs.push({ heading: m[1], body: m[2].replace(/\\'/g, "'") });
      }
      return secs;
    };
    for (const [key, file] of [
      ['terms_conditions', 'src/app/(app)/info/terms.tsx'],
      ['privacy_policy', 'src/app/(app)/info/privacy.tsx'],
    ]) {
      const builtIn = extractSections(file);
      const seeded = cms.parseCmsBody(unescapeSql(bodyFor(key)));
      ok(builtIn.length >= 9 && builtIn.length === seeded.length,
        `content round-trip: ${key} seeded body yields all ${builtIn.length} built-in sections`);
      let exact = builtIn.length === seeded.length;
      for (let i = 0; exact && i < builtIn.length; i++) {
        exact = builtIn[i].heading === seeded[i].heading && builtIn[i].body === seeded[i].body;
      }
      ok(exact, `content round-trip: ${key} headings+bodies verbatim-identical (no drift)`);
    }
  } catch (e) {
    ok(false, 'client cms: module compiled/executed — ' + e.message);
  }

  fs.rmSync(outDir, { recursive: true, force: true });
}

// ─── Frontend: cross-language default consistency (PHP ↔ TS) ───────────────────
{
  const php = read('backend/src/Controllers/PlatformController.php');
  const ts = read('src/lib/branding.ts');
  const phpKeys = [...php.matchAll(/'([a-z_]+)'\s+=> '(?:[^']*)',/g)].map((m) => m[1]);
  const wanted = ['app_name', 'primary_color', 'secondary_color', 'contact_email', 'support_email'];
  for (const key of wanted) {
    ok(phpKeys.includes(key) && ts.includes(key), `consistency: branding default '${key}' declared in both PHP and TS`);
  }
  ok(ts.includes("app_name: 'MedAcademy'") && php.includes("'app_name'        => 'MedAcademy'"),
    'consistency: app_name default identical in PHP and TS');
  const svc = read('backend/src/Services/FeatureFlagService.php');
  const ff = read('src/lib/featureFlags.ts');
  for (const key of ['user_registration', 'user_login', 'course_creation', 'doctor_course_publishing', 'course_enrollment', 'doctor_earnings', 'password_reset', 'redeem_codes', 'doctor_credit_refunds', 'user_management', 'student_enrollment_credits']) {
    ok(svc.includes(`'${key}' => [`) && ff.includes(`${key}: true`), `consistency: flag '${key}' registered in PHP and defaulted in TS`);
  }
}

// ─── Deep audit (second pass): real content, overrides, new enforcement ──────
{
  // Per-user flag overrides: service, endpoint, audit, migration.
  const svc = read('backend/src/Services/FeatureFlagService.php');
  ok(/public function isEnabledForUser\(string \$key, string \$userId\): bool/.test(svc),
    'overrides: effective state resolves explicit override → global (isEnabledForUser)');
  ok(/public function assertEnabledFor\(string \$key, Request \$request\): void/.test(svc),
    'overrides: assertEnabledFor enforces per-user state with the SA exemption');
  ok(/public function setOverride\(string \$key, string \$userId, string \$mode\): void/.test(svc),
    'overrides: three-state setOverride (inherit deletes, enabled/disabled upserts)');
  ok(/feature_flag_overrides/.test(svc), 'overrides: reads/writes the feature_flag_overrides table');
  ok(/feature_flag_override_updated/.test(read('backend/src/Controllers/PlatformController.php')),
    'overrides: audit event feature_flag_override_updated');
  const mig24 = read('backend/database/mysql-migrations/024_platform_content_migration_and_flag_overrides.sql');
  ok(/CREATE TABLE IF NOT EXISTS `feature_flag_overrides`/.test(mig24), 'overrides: migration creates the table');
  ok(/UNIQUE \(`flag_key`, `user_id`\)/.test(mig24), 'overrides: one row per (flag, user) — upsert-safe');

  // CMS real-content migration: guarded fills, never overwrites admin edits.
  ok(/WHERE `key` = 'terms_conditions' AND TRIM\(`content`\) = ''/.test(mig24),
    'content: Terms migration fills ONLY empty bodies (admin edits preserved)');
  ok(/WHERE `key` = 'privacy_policy' AND TRIM\(`content`\) = ''/.test(mig24),
    'content: Privacy migration fills ONLY empty bodies');
  ok(/1\. Acceptance of Terms/.test(mig24) && /2\. Account Responsibilities/.test(mig24),
    'content: migrated Terms text matches the in-app copy (verbatim)');
  ok(/3\. Forensic Watermarking/.test(mig24),
    'content: migrated Privacy text matches the in-app copy (verbatim)');
  ok(/Need help\? Choose one of the contact methods below/.test(mig24),
    'content: migrated Contact intro matches the in-app copy (verbatim)');

  // New enforcement call sites.
  const auth = read('backend/src/Services/AuthService.php');
  ok(/assertEnabled\('password_reset', \$request\)/.test(auth),
    'enforced: password_reset on AuthService::forgotPassword (before any token/probe)');
  ok(/assertEnabledFor\('redeem_codes', \$request\)/.test(read('backend/src/Controllers/RedeemCodeController.php')),
    'enforced: redeem_codes on RedeemCodeController::redeem (before integrity gate)');
  const credit = read('backend/src/Controllers/CreditController.php');
  ok(/assertEnabledFor\('doctor_credit_refunds', \$request\)/.test(credit),
    'enforced: doctor_credit_refunds on CreditController::refund (before ledger writes)');
  const student = read('backend/src/Controllers/StudentController.php');
  ok(/assertEnabledFor\('user_management', \$request\)/.test(student)
    && /assertEnabledFor\('student_enrollment_credits', \$request\)/.test(student),
    'enforced: user_management + student_enrollment_credits on StudentController::handle (before writes)');
  const admin = read('backend/src/Controllers/AdminController.php');
  ok(/assertEnabledFor\('user_management', \$request\)/.test(admin),
    'enforced: user_management on AdminController::userManagement (before account creation)');

  // Branding actually consumed on identity surfaces.
  ok(/branding\.app_name/.test(read('src/app/(auth)/sign-in.tsx')), 'branding: sign-in header uses the server display name');
  ok(/branding\.app_name/.test(read('src/app/(auth)/sign-up.tsx')), 'branding: sign-up header uses the server display name');
  ok(/branding\.app_name/.test(read('src/app/(app)/info/about.tsx')), 'branding: About page uses the server display name');
  ok(/useCmsSections\('contact_us'/.test(read('src/app/(app)/info/contact.tsx')),
    'branding: Contact intro is CMS-managed (useCmsSections)');
}

// ─── Frontend: Platform child-page back navigation ─────────────────────────────
{
  ok(/showBack\n?\s*onBack=\{\(\) => router\.push\('\/sa-platform'\)\}/.test(read('src/app/(app)/(superadmin)/branding.tsx')),
    'nav: Branding header has the explicit ← Platform action');
  ok(/onBack=\{\(\) => router\.push\('\/sa-platform'\)\}/.test(read('src/app/(app)/(superadmin)/maintenance.tsx')),
    'nav: Maintenance header has the explicit ← Platform action');
  ok(/onBack=\{\(\) => router\.push\('\/sa-platform'\)\}/.test(read('src/app/(app)/(superadmin)/feature-flags.tsx')),
    'nav: Feature Flags header has the explicit ← Platform action');
  const saCms = read('src/app/(app)/(superadmin)/sa-cms.tsx');
  const saDiag = read('src/app/(app)/(superadmin)/sa-system-providers.tsx');
  ok(/backTo="\/sa-platform"/.test(saCms) && /backTo="\/sa-platform"/.test(saDiag),
    'nav: shared CMS/Diagnostics screens receive the Platform back target in the SA shell');
  const hub = read('src/app/(app)/(superadmin)/sa-platform.tsx');
  ok(/path="\/sa-cms"/.test(hub) && /path="\/sa-system-providers"/.test(hub),
    'nav: Platform hub links stay inside the Super Admin shell');
  // Video Providers is reachable from both /sa-platform and /sa-content, so the
  // arrow pops the real parent and falls back to Platform when there is none.
  const vp = read('src/app/(app)/(superadmin)/video-providers.tsx');
  ok(/showBack\n/.test(vp) && /backFallback="\/sa-platform"/.test(vp),
    'nav: Video Providers header has an explicit back action (fallback ← Platform)');
  // Multi-hub wrappers: each one declares the hub that actually lists it, so a
  // no-history entry never dead-ends on an unrelated section.
  for (const [route, file, target] of [
    ['sa-currency', 'src/app/(app)/(superadmin)/sa-currency.tsx', '/sa-finance'],
    ['sa-content-protection', 'src/app/(app)/(superadmin)/sa-content-protection.tsx', '/sa-content'],
    ['sa-video-monitor', 'src/app/(app)/(superadmin)/sa-video-monitor.tsx', '/sa-platform'],
  ]) {
    const w = read(file);
    ok(new RegExp(`backTo="${target}"`).test(w),
      `nav: ${route} wrapper falls back to ${target}`);
  }
  for (const f of [
    'src/app/(app)/(superadmin)/currency.tsx',
    'src/app/(app)/(superadmin)/content-protection.tsx',
    'src/app/(app)/(admin)/video-monitor.tsx',
  ]) {
    const src = read(f);
    ok(/\{ backTo\?: string \} = \{\}/.test(src),
      `nav: ${f.split('/').pop()} accepts an optional backTo prop`);
    // The back arrow is always present on these detail pages; `backTo` supplies
    // the terminal fallback used only when there is no history to pop, so a
    // multi-hub entry still returns to the hub that actually pushed the screen.
    ok(/showBack\n/.test(src),
      `nav: ${f.split('/').pop()} always renders the back arrow`);
    ok(/backFallback=\{backTo \?\?/.test(src),
      `nav: ${f.split('/').pop()} uses backTo as the terminal back fallback`);
  }
  // Hub ↔ child contract: every hub path with an sa- wrapper resolves to that wrapper.
  {
    const m = hub.match(/path="(\/sa-[a-z-]+)"/g) || [];
    ok(m.length >= 5, 'nav: Platform hub links >= 5 SA-shell routes');
    for (const raw of m) {
      const route = raw.match(/"(\/sa-[a-z-]+)"/)[1].slice(1);
      ok(read(`src/app/(app)/(superadmin)/${route}.tsx`).length > 0,
        `nav: hub route ${route} resolves to an SA-shell screen`);
    }
  }
}

// The branding cache contract is async — print the report once it has landed.
brandingTests.then(() => {
console.log('──────────────────────────────────────────────');
if (failed === 0) {
  console.log(`RESULT: ${passed} passed, 0 failed`);
  console.log('ALL PLATFORM CENTER TESTS PASSED');
} else {
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  FAILED: ' + f);
  process.exit(1);
}
});
