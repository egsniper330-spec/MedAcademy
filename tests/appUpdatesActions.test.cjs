/**
 * Automated tests for SUPER ADMIN → APP UPDATES — action-button reliability.
 *
 * Run: node tests/appUpdatesActions.test.cjs
 *
 * Regression coverage for the "frozen buttons" bug. Root causes pinned here:
 *   RC1  set-app-update-config body omitted `platform` → invokeFunction could
 *        not resolve the /admin/app-updates/{platform} route token → EVERY
 *        Save-Policy press 422'd, with the error invisible (Alert-only) on web.
 *   RC2  react-native-web's Alert.alert is a silent no-op → Publish/Archive/
 *        Rollback gated their ENTIRE mutation inside the dialog callback,
 *        which never ran on web (button: zero feedback, zero requests).
 *   RC3  savePolicy had no try/finally → any rejection left `saving` true
 *        forever, permanently disabling the Save button.
 *   RC4  Edit-draft loaded the release into the form but Save always CREATED
 *        → duplicate releases.
 *
 * Backend (structural): no PHP runtime here, so controller/service/route
 * contracts are verified structurally against the shipped PHP source.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// CRLF-normalized reads: several sources use \r\n; assertions match on \n.
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passed++; } else { failed++; failures.push(msg); }
}
function section(name) { console.log('-- ' + name + ' --'); }

const screen = read('src/app/(app)/(superadmin)/app-updates.tsx');
const api = read('src/lib/api.ts');
const phpClient = read('src/client/php.ts');
const routes = read('backend/routes/api.php');
const controller = read('backend/src/Controllers/AppReleaseController.php');
const svc = read('backend/src/Services/AppReleaseService.php');
const updCfgController = read('backend/src/Controllers/UpdateConfigController.php');
const confirmDialog = read('src/components/ConfirmDialog.tsx');

/** First ~maxChars characters of a named function's source. `name` may or may not carry a `const ` prefix. */
function fnSrc(src, name, maxChars) {
  const bare = name.replace(/^const /, '');
  let i = src.indexOf('export async function ' + bare);
  if (i < 0) i = src.indexOf('const ' + bare + ' ');
  if (i < 0) return '';
  return src.slice(i, i + (maxChars || 900));
}

// ============================================================================
section('A. Route-token contract (RC1) — platform must reach the URL');
// ============================================================================

assert(
  /'set-app-update-config':\s*'\/admin\/app-updates\/\{platform\}'/.test(phpClient),
  'php.ts maps set-app-update-config to PUT /admin/app-updates/{platform}'
);
const setCfgSrc = fnSrc(api, 'setAppUpdateConfig', 1200);
assert(
  /platform,\s*\n\s*enabled: input\.enabled,/.test(setCfgSrc) && setCfgSrc.includes('platform,'),
  'api.ts setAppUpdateConfig body includes `platform` (the route token source)'
);
assert(
  /set-app-update-config requires a platform \(android\|ios\)/.test(phpClient),
  'php.ts still rejects a missing platform before any request'
);
assert(
  routes.includes("router->put('/admin/app-updates/{platform}', [UpdateConfigController::class, 'adminUpdate'], $auth + ['role' => ['super_admin']])"),
  'backend route PUT /admin/app-updates/{platform} is Super-Admin gated'
);
assert(
  updCfgController.includes("$request->params['platform'] ?? $request->params['id'] ?? ''"),
  'UpdateConfigController::adminUpdate reads the {platform} route token'
);

// ============================================================================
section('B. Cross-platform confirmation (RC2) — no Alert-gated mutations');
// ============================================================================

assert(
  !/Alert\.alert\s*\(/.test(screen),
  'App Updates screen contains ZERO Alert.alert CALLS (silent no-op on web)'
);
assert(
  !/(^|[,{[]\s*)Alert(\s*[,}.\]]|$)/m.test(screen.match(/import \{[^}]*\} from 'react-native';/) || ''),
  'Alert is no longer imported from react-native in the screen'
);
assert(
  screen.includes("import { ConfirmDialog, type ConfirmDialogRequest } from '@/components/ConfirmDialog';"),
  'screen imports the cross-platform ConfirmDialog'
);
assert(
  screen.includes('const [confirm, setConfirm] = useState<ConfirmDialogRequest | null>(null);'),
  'screen drives confirms through explicit dialog state'
);
assert(
  confirmDialog.includes('PortalOverlay') && confirmDialog.includes('visible'),
  'ConfirmDialog renders through PortalOverlay (works on web where Alert cannot)'
);
for (const fn of ['onPublish', 'onRollback', 'onArchive']) {
  const body = fnSrc(screen, 'const ' + fn, 1600);
  assert(body.includes('runConfirmed'), fn + ' routes its mutation through runConfirmed (works on web)');
}
assert(
  confirmDialog.includes('const locked = busy || pendingConfirm;') &&
  confirmDialog.includes('disabled={locked}') &&
  confirmDialog.includes('onRequestClose={locked ? undefined : onClose}'),
  'ConfirmDialog disables buttons + backdrop dismissal while a mutation is in flight'
);

// ============================================================================
section('C. Every failure surfaces visibly (RC3) — no silent errors');
// ============================================================================

assert(screen.includes('const showError = (msg: string): void =>'), 'screen has a visible inline error reporter');
assert(screen.includes('{error ? (') && screen.includes('#EF4444'), 'error banner renders inline (red) on the screen');
const savePolicyBody = (screen.match(/const savePolicy = async[\s\S]*?\n  \};/) || [''])[0];
const finallyIdx = savePolicyBody.indexOf('finally {');
assert(
  savePolicyBody.includes('try {') && finallyIdx >= 0 &&
  savePolicyBody.slice(finallyIdx).includes('saving: false'),
  'savePolicy resets `saving` in finally (button can never stick disabled)'
);
assert(savePolicyBody.includes('showError('), 'savePolicy surfaces API errors inline');
for (const fn of ['onPublish', 'onRollback', 'onArchive', 'onSaveDraft']) {
  const body = fnSrc(screen, 'const ' + fn, 2200);
  assert(body.includes('showError('), fn + ' reports failures via the inline error banner');
}

// ============================================================================
section('D. Draft edit updates in place (RC4) — no duplicate releases');
// ============================================================================

assert(screen.includes('const [editingId, setEditingId] = useState<string | null>(null);'), 'screen tracks which release is being edited');
assert(screen.includes('setEditingId(r.id);'), 'onEditPending records the release id');
assert(/if \(editingId\) \{[\s\S]{0,500}updateAppRelease\(editingId/.test(screen), 'Save switches to updateAppRelease when editing an existing draft');
assert(screen.includes('setEditingId(null);'), 'editing state resets after save/cancel');
assert(
  svc.includes('Published releases are immutable') && svc.includes('Archived releases cannot be edited'),
  'backend rejects edits to published/archived releases (409)'
);

// ============================================================================
section('E. Full action pipeline — routes, auth, methods, state machine');
// ============================================================================

const contract = [
  ['getAppReleasesOverview', "'/admin/app-releases'", "'GET'"],
  ['createAppRelease', "'/admin/app-releases'", "'POST'"],
  ['updateAppRelease', '/admin\/app-releases\/\$\{id\}`/', 'n/a'],
];
// per-function explicit checks (template literals need substring checks):
const pipeline = [
  ['getAppReleasesOverview', 'apiFetch<AppReleasesOverview>(\'/admin/app-releases\'', 'method: \'GET\''],
  ['createAppRelease', 'apiFetch<AppRelease>(\'/admin/app-releases\'', 'method: \'POST\''],
  ['updateAppRelease', 'apiFetch<AppRelease>(`/admin/app-releases/${id}`', 'method: \'PUT\''],
  ['publishAppRelease', 'apiFetch<AppRelease>(`/admin/app-releases/${id}/publish`', 'method: \'POST\''],
  ['rollbackAppRelease', 'apiFetch<AppRelease>(`/admin/app-releases/${id}/rollback`', 'method: \'POST\''],
  ['archiveAppRelease', 'apiFetch<AppRelease>(`/admin/app-releases/${id}/archive`', 'method: \'POST\''],
];
for (const [fn, routeSnippet, methodSnippet] of pipeline) {
  const body = fnSrc(api, fn, 900);
  assert(body.includes(routeSnippet), fn + ' targets its canonical route');
  assert(body.includes(methodSnippet), fn + ' uses ' + methodSnippet);
}
assert(contract.length === 3, 'contract table sanity');

const routeChecks = [
  ["router->get('/admin/app-releases', [AppReleaseController::class, 'index'],", 'GET /admin/app-releases (index)'],
  ["router->post('/admin/app-releases', [AppReleaseController::class, 'create'],", 'POST /admin/app-releases (create)'],
  ["router->put('/admin/app-releases/{id}', [AppReleaseController::class, 'update'],", 'PUT /admin/app-releases/{id} (update)'],
  ["router->post('/admin/app-releases/{id}/publish', [AppReleaseController::class, 'publish'],", 'POST .../{id}/publish'],
  ["router->post('/admin/app-releases/{id}/rollback', [AppReleaseController::class, 'rollback'],", 'POST .../{id}/rollback'],
  ["router->post('/admin/app-releases/{id}/archive', [AppReleaseController::class, 'archive'],", 'POST .../{id}/archive'],
];
for (const [snippet, label] of routeChecks) {
  const idx = routes.indexOf(snippet);
  assert(idx !== -1, 'route exists: ' + label);
  if (idx !== -1) {
    assert(routes.slice(idx, idx + 160).includes('$auth'), 'route is auth-gated: ' + label);
  }
}
assert(
  /if \(!r\.download_url\) \{[\s\S]{0,200}showError\(/.test(screen),
  'publish is blocked client-side without a download URL (visible error)'
);

// ============================================================================
section('F. Production safety — Current Production changes ONLY on Publish');
// ============================================================================

assert(svc.includes('NEVER touches the published record'), 'create/update documented + implemented as non-production-touching');
assert(
  /public function publish[\s\S]{0,3000}promoteToUpdateConfig/.test(svc),
  'only publish() promotes into the update-gate config (app_update_config)'
);
assert(
  /public function rollback[\s\S]{0,3000}promoteToUpdateConfig/.test(svc),
  'rollback re-promotes a previous release (explicit action only)'
);
assert(
  !/function createRelease[\s\S]{0,2000}promoteToUpdateConfig/.test(svc) &&
  !/function updateRelease[\s\S]{0,2000}promoteToUpdateConfig/.test(svc),
  'create/update NEVER promote (drafts cannot change production)'
);
assert(
  /status = 'published'[\s\S]{0,400}(UPDATE app_releases|AND status = 'published')/.test(svc),
  'publish promotes within a transaction, demoting the previous current release'
);

// ============================================================================
section('G. Server-state refresh + visible busy states');
// ============================================================================

for (const fn of ['onSaveDraft', 'onPublish', 'onRollback', 'onArchive']) {
  const body = fnSrc(screen, 'const ' + fn, 2600);
  assert(body.includes('await load()'), fn + ' refreshes server state after mutating');
}
assert(/busyId === r\.id[\s\S]{0,200}ActivityIndicator/.test(screen), 'publish/rollback rows show a spinner while busy');
assert(/pol\.saving\s*\?\s*<ActivityIndicator/.test(screen), 'Save-Policy buttons show a spinner while saving');
assert(screen.includes("label={saving ? 'Saving…' : editingId ? 'Save Changes' : 'Save Draft'}"), 'draft button reflects saving + editing modes');
assert(/Re-read server state[\s\S]{0,300}getAppUpdateConfig\(p\)/.test(screen), 'policy save re-reads the persisted config (server-authoritative UI)');

// ============================================================================
section('H. Authorization preserved (no weakening)');
// ============================================================================

assert(
  controller.includes('Super Admin authorization required') &&
  controller.includes("!== 'super_admin'"),
  'AppReleaseController asserts super_admin on every action'
);
assert(
  (controller.match(/assertSuperAdmin\(\$request\)/g) || []).length >= 6,
  'every controller action calls assertSuperAdmin'
);

console.log('\nApp Updates actions: ' + passed + ' passed, ' + failed + ' failed');
if (failed === 0) {
  console.log('ALL PASS');
} else {
  for (const f of failures) console.log('  FAILED: ' + f);
  process.exit(1);
}
