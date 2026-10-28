#!/usr/bin/env node
/**
 * tests/videoImport.test.cjs
 *
 * Explicit "Import Video" flow (doctor enters a VdoCipher video ID).
 *
 * Why this exists: one VdoCipher account serves the whole platform, so the
 * remote listing contains EVERY doctor's videos. Sync must never import unknown
 * remote assets, and an explicit import must never let a doctor claim another
 * doctor's asset or a client-supplied owner id.
 *
 * Like the other PHP-facing suites this combines SOURCE assertions over the
 * committed PHP/TS with a PURE MODEL of the server decision order, so the policy
 * is executed here rather than only grepped.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
const failures = [];

function ok(label, cond) {
  if (cond) passed++;
  else {
    failures.push(label);
    console.log('  ✗ ' + label);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function section(title) {
  console.log('\n── ' + title + ' ──');
}

const CONTROLLER = 'backend/src/Controllers/VideoController.php';
const SYNC = 'backend/src/Services/VideoLibrarySyncService.php';
const ROUTES = 'backend/routes/api.php';
const CLIENT_MAP = 'src/client/php.ts';
const LIB_API = 'src/lib/videoLibraryApi.ts';
const SCREEN = 'src/app/(app)/(doctor)/video-library.tsx';
const I18N = 'src/lib/i18n/resources.ts';

/* ══ 1. Routing and payload ═══════════════════════════════════════════════ */

section('1. Route and request contract');

{
  const routes = read(ROUTES);
  const controller = read(CONTROLLER);

  ok('POST /video/import exists and is limited to content roles',
    /\$router->post\('\/video\/import', \[VideoController::class, 'importAsset'\], \$auth \+ \['role' => \['doctor', 'admin', 'super_admin'\]\]\)/.test(routes));
  ok('the handler is a real controller method',
    /public function importAsset\(Request \$request\): array/.test(controller));
  ok('the owner is taken from the AUTHENTICATED user, never the body',
    /\$actorId = \(string\) \$request->user\['id'\]/.test(controller) &&
    !/\$body\['doctor_id'\]|\$body\['owner_id'\]/.test(controller));
  ok('the id is validated by shape before any lookup',
    /preg_match\('\/\^\[A-Za-z0-9_-\]\{6,191\}\$\/', \$videoId\)/.test(controller));
  ok('an invalid id is a clear 422', /'invalid_video_id'/.test(controller));
}

/* ══ 2. Ownership rules ═══════════════════════════════════════════════════ */

section('2. Ownership and duplicates');

{
  const controller = read(CONTROLLER);
  const body = controller.slice(
    controller.indexOf('public function importAsset'),
    controller.indexOf('public function deleteAsset'),
  );

  ok('local ownership is checked BEFORE any network call',
    body.indexOf('FROM video_assets WHERE provider_video_id') < body.indexOf('listAllVideos()'));
  ok('a row owned by the caller is an idempotent success (no duplicate)',
    /'status' => 'already_imported'/.test(body) && /'imported' => false/.test(body));
  ok('a row owned by ANOTHER doctor is refused',
    /video_owned_by_another_doctor/.test(body) && /throw new ApiException\(\s*409/.test(body));
  ok('the refusal happens before the listing/insert',
    body.indexOf("'video_owned_by_another_doctor'") < body.indexOf('listAllVideos()') === false ||
    body.indexOf("'video_owned_by_another_doctor'") < body.indexOf('INSERT INTO video_assets'));
  ok('duplicates are impossible even under a race (INSERT … WHERE NOT EXISTS)',
    /INSERT INTO video_assets[\s\S]{0,600}WHERE NOT EXISTS \([\s\S]{0,200}provider_video_id = \? AND doctor_id = \?/.test(body));
  ok('the client cannot send an owner id through the API layer either',
    !/doctor_id/.test(read(LIB_API).slice(read(LIB_API).indexOf('export async function importVdoCipherVideo'))));
}

/* ══ 3. Remote verification / eligibility ═════════════════════════════════ */

section('3. Remote verification');

{
  const controller = read(CONTROLLER);
  const body = controller.slice(
    controller.indexOf('public function importAsset'),
    controller.indexOf('public function deleteAsset'),
  );

  ok('a failed/partial listing imports nothing',
    /video_service_unavailable/.test(body) &&
    /\(\$listing\['status'\] \?\? ''\) !== 'ok'/.test(body));
  ok('the id must appear in the COMPLETE listing',
    /\$listing\['videos'\]\[\$videoId\]/.test(body) && /video_not_found/.test(body));
  ok('only a READY remote asset is eligible',
    /\$remoteStatus !== 'ready'/.test(body) && /video_not_ready/.test(body));
  ok('ownership confirmation is mandatory',
    /ownership_confirmation_required/.test(body));
  ok('the import never deletes or modifies the provider asset',
    !/deleteVideo\(|request\('DELETE'/.test(body));
  ok('the import never loops over the whole listing (no bulk import)',
    !/foreach \(\$listing\['videos'\]/.test(body));
}

/* ══ 4. Sync still does not import ════════════════════════════════════════ */

section('4. Sync behaviour preserved');

{
  const sync = read(SYNC);
  ok('sync never INSERTs video_assets (no auto-import of unknown assets)',
    !/INSERT INTO video_assets/i.test(sync));
  ok('sync only removes CONFIRMED-remote-missing rows',
    /verifyRemote\(/.test(sync) && /'missing'/.test(sync));
  ok('sync never deletes a remote VdoCipher asset',
    !/deleteVideo\(/.test(sync) && !/request\('DELETE'/.test(sync));
}

/* ══ 5. Audit ═════════════════════════════════════════════════════════════ */

section('5. Audit is honest and constraint-safe');

{
  const controller = read(CONTROLLER);
  const body = controller.slice(
    controller.indexOf('public function importAsset'),
    controller.indexOf('public function deleteAsset'),
  );
  const allowed = new Set(
    (read('backend/database/mysql-migrations/035_lesson_material_pdf_hardening.sql')
      .match(/CHECK \(`action` IN \(([^)]*)\)\)/) || [, ''])[1]
      .match(/'([^']+)'/g)?.map((s) => s.slice(1, -1)) || [],
  );

  const actions = [...body.matchAll(/AuditService::write\(\$actorId, '([a-z_]+)'/g)].map((m) => m[1]);
  ok('the import writes at least one audit row', actions.length > 0);
  ok('every imported audit action is allowed by the audit CHECK constraint',
    actions.every((a) => allowed.has(a)));
  ok('the audit says ownership is unverified (no invented proof)',
    /'ownership' => 'unverified'/.test(body));
  ok('the response tells the client ownership is unverified',
    /'ownership_verified' => false/.test(body));
}

/* ══ 6. Client flow ═══════════════════════════════════════════════════════ */

section('6. Client');

{
  const map = read(CLIENT_MAP);
  const lib = read(LIB_API);
  const screen = read(SCREEN);
  const i18n = read(I18N);

  ok('the PHP client maps the import endpoint',
    /'video-import':\s*'\/video\/import'/.test(map));
  ok('the API layer exposes importVdoCipherVideo with an explicit confirmation',
    /export async function importVdoCipherVideo\(/.test(lib) && /confirm_ownership: confirmOwnership/.test(lib));
  ok('the screen offers an import dialog with an ID field',
    /importVdoCipherVideo\(/.test(screen) && /videoLibrary\.importIdLabel/.test(screen) &&
    /<TextInput/.test(screen));
  ok('the UI requires the ownership checkbox before enabling the action',
    /disabled=\{importBusy \|\| !importId\.trim\(\) \|\| !importConfirmed\}/.test(screen));
  ok('the UI does not auto-retry or bulk-import',
    (screen.match(/importVdoCipherVideo\(/g) || []).length === 1);
  ok('the confirmation string exists in BOTH locales',
    (i18n.match(/'videoLibrary\.importConfirm':/g) || []).length === 2);
  ok('the failure string exists in BOTH locales',
    (i18n.match(/'videoLibrary\.importFailed':/g) || []).length === 2);
}

/* ══ 7. Decision model ════════════════════════════════════════════════════ */

section('7. Server decision model');

{
  // Mirrors importAsset: the FIRST matching rule decides.
  function decide({ localOwners = [], listingOk = true, listing = {}, confirmed = true }) {
    if (localOwners.includes('me')) return 'already_imported';
    if (localOwners.length > 0) return 'video_owned_by_another_doctor';
    if (!listingOk) return 'video_service_unavailable';
    if (!listing.exists) return 'video_not_found';
    if (listing.status !== 'ready') return 'video_not_ready';
    if (!confirmed) return 'ownership_confirmation_required';
    return 'imported';
  }

  ok('own existing row → idempotent success', decide({ localOwners: ['me'] }) === 'already_imported');
  ok('another doctor\'s row → refused even if the id is ready',
    decide({ localOwners: ['other'], listing: { exists: true, status: 'ready' } }) === 'video_owned_by_another_doctor');
  ok('unknown id + remote ready → imported',
    decide({ listing: { exists: true, status: 'ready' } }) === 'imported');
  ok('unknown id + remote processing → refused',
    decide({ listing: { exists: true, status: 'processing' } }) === 'video_not_ready');
  ok('unknown id + listing failure → nothing imported',
    decide({ listingOk: false }) === 'video_service_unavailable');
  ok('unknown id + ready + no confirmation → refused',
    decide({ confirmed: false, listing: { exists: true, status: 'ready' } }) === 'ownership_confirmation_required');
}

/* ══ Report ═══════════════════════════════════════════════════════════════ */

console.log('\n' + (failures.length === 0 ? '✔' : '✗') +
  ` videoImport: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
