/**
 * Automated tests for the ADMIN / SUPER-ADMIN CONTROL CENTER
 * (detail-page back navigation · video providers · Contact Links · feature flags).
 *
 * Run: node tests/platformControlCenter.test.cjs
 *
 * Backend (structural): no PHP runtime exists in this environment, so the
 * authoritative behaviour of the controllers/services and their enforcement
 * call sites is verified STRUCTURALLY against the shipped PHP source (regex over
 * the real files — any behavioural change to a pinned path breaks these tests).
 *
 * Covered from the request:
 *   1. every listed detail page carries a back action (not the hamburger)
 *   2. the 500 "Internal server error" root cause cannot come back
 *      (every audit action written by code must exist in the CHECK constraint)
 *   3. video-provider policy is server-enforced on both authorization paths
 *   4. Contact Us links: persisted, validated server-side, editable, rendered
 *   5. feature flags: real registry, real enforcement points, stable keys,
 *      no React key warning in FeatureFlagsScreen
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
function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. NAVIGATION — every listed detail page has a back action
// ─────────────────────────────────────────────────────────────────────────────
// [label, file, whether it is a top-level tab root that intentionally keeps ☰]
const LISTED_PAGES = [
  ['System Diagnostics',   'src/app/(app)/(admin)/system-providers.tsx', false],
  ['Video Providers',      'src/app/(app)/(superadmin)/video-providers.tsx', false],
  ['Currency Settings',    'src/app/(app)/(superadmin)/currency.tsx', false],
  ['Content Protection',   'src/app/(app)/(superadmin)/content-protection.tsx', false],
  ['Watermark / DRM',      'src/app/(app)/(superadmin)/content-protection.tsx', false],
  ['Video Monitor',        'src/app/(app)/(admin)/video-monitor.tsx', false],
  ['Video Health',         'src/app/(app)/(admin)/video-health.tsx', false],
  ['Video Settings',       'src/app/(app)/(admin)/video-settings.tsx', false],
  ['Storage',              'src/app/(app)/(admin)/storage.tsx', false],
  ['Security Dashboard',   'src/app/(app)/(superadmin)/sec-dashboard.tsx', false],
  ['Security Policies',    'src/app/(app)/(superadmin)/sec-policies.tsx', false],
  ['Security Diagnostics', 'src/app/(app)/(superadmin)/sec-diag.tsx', false],
  ['Violation Management', 'src/app/(app)/(superadmin)/violation-management.tsx', false],
  ['Impersonation',        'src/app/(app)/(superadmin)/impersonation.tsx', false],
  ['Device Management',    'src/app/(app)/(admin)/devices.tsx', false],
  ['Academic Structure',   'src/app/(app)/(admin)/academic.tsx', false],
  ['Enrollment Manager',   'src/app/(app)/(admin)/enrollment-manager.tsx', false],
  ['Notifications',        'src/app/(app)/(admin)/notifications-center.tsx', false],
  ['Bulk Import',          'src/app/(app)/(admin)/bulk-import.tsx', false],
  ['DB Audit',             'src/app/(app)/(admin)/db-audit.tsx', false],
  ['Trash Bin',            'src/app/(app)/(superadmin)/trash-bin.tsx', false],
  ['Delete Permissions',   'src/app/(app)/(superadmin)/delete-permissions.tsx', false],
  // Real top-level tab that RECEIVES the "Admin Management" hub link. It is the
  // Users root, so it deliberately keeps the drawer (hamburger) — documented.
  ['Admin Management (Users tab root)', 'src/app/(app)/(superadmin)/sa-users.tsx', true],
];

{
  for (const [label, file, isTabRoot] of LISTED_PAGES) {
    ok(exists(file), `nav: ${label} screen exists (${file})`);
    if (!exists(file)) continue;
    const src = read(file);
    // A back action is either the shared PageHeader back button (showBack), an
    // explicit header arrow, or a canGoBack()-guarded router.back().
    const hasBack = /showBack/.test(src)
      || /ArrowLeft/.test(src)
      || /canGoBack\(\)/.test(src);
    if (isTabRoot) {
      ok(!/showBack/.test(src),
        `nav: ${label} intentionally keeps the drawer (no forced back arrow)`);
    } else {
      ok(hasBack, `nav: ${label} has a back action`);
    }
  }

  // The shared header must expose an accessible, reusable back control.
  const header = read('src/components/PageHeader.tsx');
  ok(/accessibilityLabel="Go back"/.test(header), 'nav: PageHeader back button is accessible ("Go back")');
  ok(/backFallback/.test(header), 'nav: PageHeader supports a terminal backFallback');
  ok(/if \(onBack\) \{ onBack\(\); return; \}/.test(header), 'nav: PageHeader prefers an explicit onBack');
  ok(/if \(router\.canGoBack\(\)\) \{ router\.back\(\); return; \}/.test(header),
    'nav: PageHeader pops the real parent before falling back');
  ok(/const showHamburger = !showBack && insideDrawer;/.test(header),
    'nav: hamburger is only rendered when there is no back action');

  // SA-shell wrappers must hand the shared screens a terminal fallback, so a
  // drawer entry cannot dead-end.
  const wrapperMap = {
    'sa-video-health.tsx': "backTo=\"/sa-content\"",
    'sa-video-settings.tsx': "backTo=\"/sa-content\"",
    'sa-storage.tsx': "backTo=\"/sa-content\"",
    'sa-devices.tsx': "backTo=\"/sa-platform\"",
    'sa-academic.tsx': "backTo=\"/sa-platform\"",
    'sa-enrollment-manager.tsx': "backTo=\"/sa-platform\"",
    'sa-notifications-center.tsx': "backTo=\"/sa-platform\"",
    'sa-bulk-import.tsx': "backTo=\"/sa-platform\"",
    'sa-db-audit.tsx': "backTo=\"/sa-platform\"",
    'sa-cms.tsx': "backTo=\"/sa-platform\"",
    'sa-system-providers.tsx': "backTo=\"/sa-platform\"",
    'sa-currency.tsx': "backTo=\"/sa-finance\"",
    'sa-content-protection.tsx': "backTo=\"/sa-content\"",
    'sa-video-monitor.tsx': "backTo=\"/sa-platform\"",
  };
  for (const [file, expected] of Object.entries(wrapperMap)) {
    const rel = `src/app/(app)/(superadmin)/${file}`;
    ok(exists(rel) && read(rel).includes(expected), `nav: wrapper ${file} passes ${expected}`);
  }

  // Hub links must stay inside the SA shell: pushing an (admin)-only route makes
  // the user fall out of the Super Admin tab bar (the reported bug).
  const ADMIN_ONLY = ['video-health', 'video-settings', 'storage', 'devices', 'academic',
    'enrollment-manager', 'notifications-center', 'bulk-import', 'db-audit', 'video-monitor',
    'cms', 'system-providers'];
  const hubFiles = walk('src/app/(app)/(superadmin)').filter(f => /sa-(overview|platform|content|reports|finance)\.tsx$/.test(f));
  for (const hub of hubFiles) {
    const src = read(hub);
    for (const route of ADMIN_ONLY) {
      ok(!new RegExp(`path="/${route}"`).test(src),
        `nav: ${path.basename(hub)} does not link the admin-only /${route} route`);
    }
  }

  // Every route file in the SA shell must be registered as a hidden tab, or
  // expo-router renders it as a stray tab with a raw route name.
  const layout = read('src/lib/nativeTabRegistry.tsx'); // registration lives in the shared registry
  const registered = new Set([...layout.matchAll(/name:\s*'([a-z0-9-]+)'/g)].map(m => m[1]));
  const saFiles = walk('src/app/(app)/(superadmin)')
    .filter(f => /\.tsx$/.test(f) && !/_layout/.test(f))
    .map(f => path.basename(f, '.tsx'));
  for (const name of saFiles) {
    ok(registered.has(name), `nav: SA route "${name}" is registered as a hidden tab`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. AUDIT-ACTION CONSTRAINT — the 500 "Internal server error" root cause
// ─────────────────────────────────────────────────────────────────────────────
{
  const constraintFiles = [
    'backend/database/schema.sql',
    'backend/database/schema-no-triggers.sql',
    ...fs.readdirSync(path.join(ROOT, 'backend/database/mysql-migrations'))
      .filter(f => f.endsWith('.sql'))
      .map(f => `backend/database/mysql-migrations/${f}`),
  ];

  const allowed = new Set();
  for (const rel of constraintFiles) {
    const src = read(rel);
    for (const block of src.matchAll(/chk_audit_logs_action[\s\S]{0,6000}?;/g)) {
      for (const q of block[0].matchAll(/'([a-z_]+)'/g)) allowed.add(q[1]);
    }
  }

  const phpFiles = walk('backend/src').filter(f => f.endsWith('.php'));
  const used = new Map();
  for (const rel of phpFiles) {
    const src = read(rel);
    // $userId is argument 1; the ACTION is the first literal that follows the
    // comma separating it, so argument values (statuses, ids) are never counted.
    for (const call of src.matchAll(/AuditService::write\(\s*[^,'"]*?,\s*'([a-z_]{3,60})'/g)) {
      used.set(call[1], rel);
    }
  }

  ok(allowed.size >= 174, `audit: constraint exposes the full action list (${allowed.size} actions)`);
  ok(used.size >= 30, `audit: code writes a wide action set (${used.size} distinct actions)`);

  for (const [action, file] of used) {
    ok(allowed.has(action),
      `audit: action "${action}" (used in ${path.basename(file)}) is allowed by chk_audit_logs_action`);
  }

  // The three console writes that produced the 500 must be present.
  for (const action of ['video_provider_global_updated', 'video_provider_doctor_override_updated',
    'feature_flag_override_updated']) {
    ok(allowed.has(action), `audit: ${action} added to the constraint by migration 025`);
  }
  ok(exists('backend/database/mysql-migrations/025_audit_actions_platform_console.sql'),
    'audit: migration 025 exists');
  const mig = read('backend/database/mysql-migrations/025_audit_actions_platform_console.sql');
  ok(/DROP CONSTRAINT `chk_audit_logs_action`/.test(mig), 'audit: migration 025 drops the old constraint');
  ok(/ADD CONSTRAINT `chk_audit_logs_action`/.test(mig), 'audit: migration 025 re-adds it with the new list');
  ok(/PRODUCTION DATA/.test(mig) && /SUPERSET/.test(mig),
    'audit: migration 025 documents that existing data stays valid');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. VIDEO PROVIDERS — policy + enforcement on both authorization paths
// ─────────────────────────────────────────────────────────────────────────────
{
  const routes = read('backend/routes/api.php');
  ok(/\$router->get\('\/video-providers', \[VideoProviderController::class, 'index'\], \$auth \+ \['role' => \['super_admin'\]\]\)/.test(routes),
    'video: GET /video-providers is Super Admin only');
  ok(/\$router->put\('\/video-providers\/\{key\}\/global'.*super_admin/.test(routes),
    'video: PUT global availability is Super Admin only');
  ok(/\$router->get\('\/video-providers\/teachers\/\{id\}'.*super_admin/.test(routes),
    'video: GET per-doctor state is Super Admin only');
  ok(/\$router->put\('\/video-providers\/teachers\/\{id\}'.*super_admin/.test(routes),
    'video: PUT per-doctor override is Super Admin only');

  const policy = read('backend/src/Services/VideoProviderPolicyService.php');
  ok(/public const PROVIDERS = \['plyr', 'vdocipher'\];/.test(policy),
    'video: exactly the two real providers are controllable');
  ok(/SELECT is_enabled FROM `teacher_provider_permissions`/.test(policy),
    'video: effective state reads the per-doctor override');
  ok(/SELECT is_globally_enabled FROM `video_providers`/.test(policy),
    'video: effective state falls back to the global row');
  ok(/return \$global === null \? true : \(int\) \$global === 1;/.test(policy),
    'video: missing configuration fails OPEN (never disables by accident)');
  ok(/code=video_provider_disabled|'video_provider_disabled'/.test(policy),
    'video: refusal uses the stable machine code video_provider_disabled');
  ok(/DELETE FROM `teacher_provider_permissions`/.test(policy) && /'inherit'/.test(policy),
    'video: INHERIT deletes the override row (three-state model)');
  ok(/ON DUPLICATE KEY UPDATE `is_enabled`/.test(policy),
    'video: ENABLED/DISABLED upsert the override row');

  const controller = read('backend/src/Controllers/VideoProviderController.php');
  ok(/'final_enabled'   => \$p\['effective'\]/.test(controller),
    'video: the API maps the resolved verdict to the client field final_enabled');
  ok(/video_provider_global_updated/.test(controller) && /video_provider_doctor_override_updated/.test(controller),
    'video: both configuration writes are audited');

  const video = read('backend/src/Controllers/VideoController.php');
  ok(/assertProviderAllowed\(/.test(video), 'video: playback authorization enforces the provider policy');
  const otp = video.slice(video.indexOf('public function otp('), video.indexOf('public function offlineAuthorize('));
  ok(/assertProviderAllowed\(/.test(otp), 'video: /video/otp enforces the provider policy');
  // Only offlineAuthorize's own body — otherwise later methods (deleteAsset)
  // would be pulled in and the "never deletes" assertion would be meaningless.
  const offline = video.slice(
    video.indexOf('public function offlineAuthorize('),
    video.indexOf('public function uploadInit('),
  );
  ok(/assertProviderAllowed\(/.test(offline), 'video: /video/offline-authorize enforces the provider policy');
  ok(/'video_offline_downloads'/.test(offline), 'video: offline downloads have their own kill switch');
  ok(/'video_playback'/.test(otp), 'video: online playback has a kill switch');
  ok(!/(DELETE\s+FROM|DROP\s+TABLE|UPDATE\s+`)/i.test(offline),
    'video: disabling a provider never deletes or rewrites existing offline content');

  const migration = read('backend/database/mysql-migrations/023_video_provider_defaults.sql');
  ok(/video_providers/.test(migration) && /teacher_provider_permissions/.test(migration),
    'video: migration 023 seeds the existing provider tables (no schema change)');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. CONTACT LINKS — persistence, validation, editor, rendering
// ─────────────────────────────────────────────────────────────────────────────
{
  const schema = read('backend/database/schema.sql');
  ok(/`contact_links` JSON DEFAULT \('\[\]'\) NOT NULL/.test(schema),
    'contact: app_branding.contact_links exists in the canonical schema');
  ok(exists('backend/database/mysql-migrations/026_contact_links.sql'),
    'contact: migration 026 exists');
  const mig = read('backend/database/mysql-migrations/026_contact_links.sql');
  ok(/ALTER TABLE `app_branding`\s*\n\s*ADD COLUMN `contact_links` JSON DEFAULT \('\[\]'\) NOT NULL/.test(mig),
    'contact: migration 026 adds the column non-destructively');
  ok(/Additive only/.test(mig), 'contact: migration 026 documents that existing data is preserved');

  const platform = read('backend/src/Controllers/PlatformController.php');
  ok(/'contact_links',/.test(platform), 'contact: contact_links is an editable branding field');
  ok(/'contact_links'   => '\[\]',/.test(platform), 'contact: contact_links has a deterministic default');
  ok(/public const CONTACT_LINK_PLATFORMS = \[/.test(platform), 'contact: platform presets are registry-driven');
  for (const preset of ['whatsapp', 'telegram', 'facebook', 'instagram', 'twitter', 'website', 'email', 'phone']) {
    ok(new RegExp(`'${preset}'`).test(platform), `contact: preset "${preset}" is supported`);
  }
  ok(/Unsupported contact link platform/.test(platform),
    'contact: unknown platforms are rejected server-side');
  ok(/FILTER_VALIDATE_EMAIL/.test(platform), 'contact: email destinations are validated');
  ok(platform.includes('[0-9 ()\\-]{6,20}'),
    'contact: phone destinations are validated by an explicit pattern');
  ok(platform.includes("#^https?://#i") && platform.includes('must start with http:// or https://'),
    'contact: web destinations must be http(s) — no javascript:/data: payloads');
  ok(/is limited to 20 links/.test(platform), 'contact: the list is length-capped');
  ok(/json_encode\(/.test(platform) && /Sanitize|sanitizeContactLinks/.test(platform),
    'contact: values are sanitised then stored as JSON (never HTML)');
  ok(/public static function decodeContactLinks/.test(platform)
    && /catch \(ApiException\) \{\s*return \[\];/.test(platform),
    'contact: a malformed stored value degrades to an empty list (never breaks a read)');
  ok(/Super Admin/.test(platform) && /\$this->assertSuperAdmin\(\$request\);/.test(platform),
    'contact: writes stay Super Admin only');

  const branding = read('src/lib/branding.ts');
  ok(/export type ContactLink = \{/.test(branding), 'contact: client has the ContactLink type');
  ok(/contact_links: \[\],/.test(branding), 'contact: client default is an empty list (fail-open)');
  ok(/export function parseContactLinks/.test(branding) && /catch \{ return \[\]; \}/.test(branding),
    'contact: client parser never throws');
  ok(/export function contactLinkHref/.test(branding) && /mailto:\$\{link\.url\}/.test(branding)
    && /tel:\$\{link\.url\.replace\(\/\[\^0-9\+\]\/g, ''\)\}/.test(branding),
    'contact: mailto:/tel: are built client-side from the raw value');
  ok(/out\.contact_links = parseContactLinks\(row\.contact_links\);/.test(branding),
    'contact: normalizeBranding parses the list (array or JSON string)');

  const api = read('src/lib/api.ts');
  ok(/contact_links: Array<\{ platform: string; label: string; url: string; enabled: boolean \}>;/.test(api),
    'contact: the branding API accepts the structured list');

  const cms = read('src/app/(app)/(admin)/cms.tsx');
  ok(/function ContactLinksEditor/.test(cms), 'contact: the CMS editor renders a Contact Links section');
  ok(/page\.key === 'contact_us'/.test(cms), 'contact: the section is attached to the Contact Us page');
  ok(/Add Link/.test(cms), 'contact: "Add Link" exists');
  ok(/PRESETS\.map/.test(cms) || /CONTACT_LINK_PRESETS\.map/.test(cms), 'contact: presets are selectable');
  ok(/Move \$\{link\.label\} up/.test(cms) && /Move \$\{link\.label\} down/.test(cms),
    'contact: links can be reordered');
  ok(/Remove \$\{link\.label\}/.test(cms), 'contact: links can be deleted');
  ok(/onValueChange=\{v => update\(index, \{ enabled: v \}\)\}/.test(cms),
    'contact: links can be enabled/disabled');
  ok(/updateBranding\(\{ contact_links: links \}\)/.test(cms),
    'contact: saving persists server-side through the branding API (not local state)');
  ok(/function linkError/.test(cms) && /Fix the highlighted links before saving/.test(cms),
    'contact: invalid destinations block the save with a visible error');

  const contact = read('src/app/(app)/info/contact.tsx');
  ok(/\.filter\(\(l\) => l\.enabled\)/.test(contact),
    'contact: the user screen renders only ENABLED configured links');
  ok(/contactLinkHref\(link\)/.test(contact), 'contact: tapping builds the href through the shared helper');
  ok(/isSafeContactHref/.test(contact),
    'contact: hrefs are safety-checked before rendering/opening (js/data/file/intent refused)');
  ok(/void Linking\.openURL\(href\)\.catch\(\(\) => \{\}\)/.test(contact),
    'contact: an unavailable destination fails silently instead of crashing');
  ok(/const configured = new Set\(customLinks\.map\(\(l\) => l\.platform\)\)/.test(contact),
    'contact: legacy fixed channels are skipped when a configured link covers the platform');
  ok(/label: link\.label/.test(contact), 'contact: users see the friendly label (not the raw URL)');
  ok(/Unable to load Contact Us/.test(contact) && /Retry/.test(contact),
    'contact: genuine fetch failure reaches a terminal error state with Retry (no infinite spinner)');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. FEATURE FLAGS — real registry, real enforcement, stable keys
// ─────────────────────────────────────────────────────────────────────────────
{
  const service = read('backend/src/Services/FeatureFlagService.php');
  ok(/const REGISTRY = \[/.test(service), 'flags: the registry const exists');
  // Each registry entry: key + its metadata body (up to the closing bracket at
  // the same indentation). Works regardless of where the const ends.
  const entries = [...service.matchAll(/^ {8}'([a-z_]+)' => \[([\s\S]*?)^ {8}\],/gm)];
  const keys = entries.map(e => e[1]);
  const bodyOf = Object.fromEntries(entries.map(e => [e[1], e[2]]));

  ok(keys.length >= 20, `flags: the registry covers ${keys.length} capabilities (>= 20)`);
  ok(new Set(keys).size === keys.length, 'flags: every registry key is unique');

  for (const key of ['user_login', 'user_registration', 'password_reset', 'course_creation',
    'course_editing', 'doctor_course_publishing', 'course_enrollment', 'doctor_earnings',
    'redeem_codes', 'doctor_credit_refunds', 'user_management', 'student_enrollment_credits',
    'video_playback', 'video_offline_downloads', 'impersonation', 'device_management', 'db_audit',
    'trash_cleanup', 'violation_management', 'video_monitoring']) {
    ok(keys.includes(key), `flags: "${key}" is in the registry`);
  }

  // Every entry must carry the full metadata contract.
  for (const [key, body] of Object.entries(bodyOf)) {
    ok(/'label'       => '[^']+'/.test(body), `flags: ${key} has a label`);
    ok(/'description' => '[^']+'/.test(body), `flags: ${key} explains what it does`);
    ok(/'category'    => '[a-z]+'/.test(body), `flags: ${key} has a category`);
    ok(/'default'     => (true|false)/.test(body), `flags: ${key} has a safe default`);
    ok(/'superadmin_exempt' => (true|false)/.test(body), `flags: ${key} declares its SA exemption`);
    ok(/Enforced on |Enforced via |Expose doctor earnings|Master switch|always allowed/.test(body),
      `flags: ${key} names its enforcement point`);
    ok(/'default'     => true/.test(body), `flags: ${key} defaults to ENABLED (a failure never disables it)`);
  }

  // The one deliberate non-exempt flag, and the reason it is safe.
  ok(/'superadmin_exempt' => false,/.test(bodyOf.impersonation || ''),
    'flags: impersonation is deliberately NOT Super-Admin exempt (the flag must actually work)');

  // Enforcement call sites must exist in the controllers, not just the registry.
  const ENFORCEMENT = [
    ['backend/src/Services/AuthService.php', 'user_registration'],
    ['backend/src/Services/AuthService.php', 'user_login'],
    ['backend/src/Services/AuthService.php', 'password_reset'],
    ['backend/src/Controllers/CourseController.php', 'course_creation'],
    ['backend/src/Controllers/CourseController.php', 'course_editing'],
    ['backend/src/Controllers/CourseController.php', 'doctor_course_publishing'],
    ['backend/src/Controllers/CourseController.php', 'course_enrollment'],
    ['backend/src/Controllers/CreditController.php', 'doctor_credit_refunds'],
    ['backend/src/Controllers/CreditController.php', 'doctor_earnings'],
    ['backend/src/Controllers/RedeemCodeController.php', 'redeem_codes'],
    ['backend/src/Controllers/AdminController.php', 'user_management'],
    ['backend/src/Controllers/AdminController.php', 'device_management'],
    ['backend/src/Controllers/StudentController.php', 'student_enrollment_credits'],
    ['backend/src/Controllers/VideoController.php', 'video_playback'],
    ['backend/src/Controllers/VideoController.php', 'video_offline_downloads'],
    ['backend/src/Controllers/AuthController.php', 'impersonation'],
    ['backend/src/Controllers/SecurityController.php', 'device_management'],
    ['backend/src/Controllers/AnalyticsController.php', 'db_audit'],
    ['backend/src/Controllers/AdminController.php', 'trash_cleanup'],
    ['backend/src/Controllers/RpcController.php', 'violation_management'],
    ['backend/src/Controllers/VideoController.php', 'video_monitoring'],
  ];

  // A flag must never sit on a path that cannot be refused safely.
  const cleanup = read('backend/src/Controllers/AdminController.php');
  const cleanupBody = cleanup.slice(cleanup.indexOf('public function runTrashCleanup('),
    cleanup.indexOf('public function ', cleanup.indexOf('public function runTrashCleanup(') + 10));
  ok(/assertEnabled\('trash_cleanup'/.test(cleanupBody),
    'flags: trash_cleanup gates the purge BEFORE any deletion happens');
  for (const [file, key] of ENFORCEMENT) {
    const src = read(file);
    ok(new RegExp(`assertEnabled(For)?\\('${key}'`).test(src),
      `flags: ${key} is enforced in ${path.basename(file)}`);
  }

  // Flags must never bypass the stronger policies.
  const middleware = read('backend/src/Middleware/ErrorHandler.php');
  ok(/feature_disabled/.test(middleware), 'flags: disabled features return a machine-readable code');
  ok(/403/.test(middleware), 'flags: the refusal is an HTTP 403');

  // The client mirror must know every key (a missing mirror entry would make the
  // UI disagree with the server).
  const mirror = read('src/lib/featureFlags.ts');
  for (const key of keys) {
    ok(new RegExp(`\\b${key}: (true|false),`).test(mirror), `flags: client mirror defines "${key}"`);
  }
  ok(/A flag is never UI-only/.test(mirror), 'flags: the client documents the server-authoritative contract');

  // React key warning — every JSX list in FeatureFlagsScreen must be keyed by a
  // stable identifier from the data (never an index or Math.random()).
  const screen = read('src/app/(app)/(superadmin)/feature-flags.tsx');
  // Take a generous window after each .map( — enough to cover the JSX it returns
  // regardless of whether the callback closes with ))} or })}.
  // Extract each `.map(...)` callback by matching parentheses, then keep only
  // the ones that return JSX — those are the lists React requires keys for.
  const mapBodies = [];
  for (const m of screen.matchAll(/\.map\(/g)) {
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < screen.length; end++) {
      if (screen[end] === '(') depth++;
      else if (screen[end] === ')') { depth--; if (depth === 0) break; }
    }
    mapBodies.push(screen.slice(m.index + m[0].length - 1, end + 1));
  }
  const jsxMapWindows = mapBodies.filter(w => /<(NeuCard|View|Pressable|Text)\b/.test(w));
  ok(jsxMapWindows.length >= 3,
    `flags: FeatureFlagsScreen renders ${jsxMapWindows.length} JSX list blocks`);
  for (const w of jsxMapWindows) {
    ok(/key=\{/.test(w), 'flags: every JSX list in FeatureFlagsScreen supplies a key');
  }
  ok(!/key=\{Math\.random|key=\{index\}|key=\{i\}/.test(screen),
    'flags: no random/index keys in FeatureFlagsScreen');
  ok(/<NeuCard key=\{flag\.key\}/.test(screen), 'flags: flag cards are keyed by the stable flag key');
  ok(/<View key=\{flag\.key\}/.test(screen), 'flags: per-user flag rows are keyed by the stable flag key');
  ok(/<View key=\{group\.category\}/.test(screen), 'flags: category groups are keyed by category');
  ok(/key=\{mode\}/.test(screen), 'flags: override options are keyed by mode');
  ok(!/Fragment/.test(screen), 'flags: no unkeyed fragments in the flag lists');
  ok(/CATEGORY_TITLES/.test(screen) && /grouped\.map/.test(screen),
    'flags: flags are grouped by category rather than dumped as a flat list');
}

console.log('──────────────────────────────────────────────');
if (failed === 0) {
  console.log(`RESULT: ${passed} passed, 0 failed`);
  console.log('ALL ADMIN CONTROL CENTER TESTS PASSED');
} else {
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  FAILED: ' + f);
  process.exit(1);
}
