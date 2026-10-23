/**
 * Bulk user actions (Super Admin All Users) + continuous watermarks + Plyr
 * centre-control lifecycle.
 *
 * Run: node tests/bulkUsersAndWatermarkRefresh.test.cjs
 *
 * Contract tests over the real sources: the screen, the shared modules, the
 * injected player scripts and the PHP controller. They pin what this change
 * delivered and fail if it silently regresses — an action the backend does not
 * implement, a centre button pinned visible, a watermark that teleports every
 * 30 s, or a "password reset" that sets a password nobody knows.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
    console.log('  ✗ ' + msg);
  }
}
function section(title) {
  console.log('── ' + title + ' ──');
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r/g, '');

const sa = read('src/app/(app)/(superadmin)/sa-users.tsx');
const menu = read('src/components/BulkUserMenu.tsx');
const admin = read('backend/src/Controllers/AdminController.php');
const api = read('src/lib/api.ts');
const routes = read('backend/routes/api.php');

const plyrTs = read('src/lib/plyr/playerScript.ts');
const plyrJs = read('public/player/player.js');
const vdoInject = read('src/lib/watermarkInjection.ts');
const vdoService = read('backend/src/Video/VdoCipherService.php');
const nativeOverlay = read('src/components/NativeWatermarkOverlay.tsx');
const webviewPlayer = read('src/components/VdoCipherPlayerWebView.tsx');

/* ══════════════════ 1. Select all, count, overflow menu ══════════════════ */

section('1. All Users — selection interface');

ok(/Select page \(\$\{pageIds\.length\}\)/.test(sa) &&
   /Select all \$\{filtered\.length\} matching/.test(sa),
  'selection offers an explicit page scope and an explicit whole-result scope, each with its count');
ok(/const pageIds = paginated\.map\(u => u\.id\)/.test(sa) &&
   /const togglePageSelection = \(\) =>/.test(sa),
  'page scope selects exactly the rendered page rows (not a hard-coded range)');
ok(/const toggleResultSelection = \(\) =>/.test(sa) &&
   /filtered\.forEach\(u => s\.add\(u\.id\)\)/.test(sa),
  'result scope selects every row in the current filtered result set');
ok(/if \(resultAllSelected\) filtered\.forEach\(u => s\.delete\(u\.id\)\)/.test(sa),
  'clearing the result scope removes only the matching ids (selections from another tab survive)');
ok(/accessibilityRole="checkbox"/.test(sa) && /accessibilityState=\{\{ checked: pageAllSelected \}\}/.test(sa),
  'select-all is an accessible checkbox with its checked state exposed');
ok(/\{bulkSelected\.size\} selected/.test(sa),
  'the selected count is visible in the selection bar');
ok(/<MoreVertical size=\{19\} color=\{c\.primary\} \/>/.test(sa) &&
   /accessibilityLabel="Bulk actions"/.test(sa),
  'a three-dot overflow button opens the bulk menu (labelled for assistive tech)');
ok(/<BulkUserMenu[\s\S]{0,220}onAction=\{handleBulkAction\}/.test(sa),
  'the overflow button renders the bulk menu wired to the handler');
ok(/disabled=\{!bulkSelected\.size \|\| !!bulkRunning\}/.test(sa),
  'the menu cannot be opened with an empty selection or while a batch is running');

section('2. Every menu action maps to a real backend operation');

for (const op of ['suspend', 'unsuspend', 'reset_devices', 'reset_password', 'trash']) {
  ok(new RegExp(`action: '${op}'`).test(menu), `menu offers "${op}"`);
}
ok(!/'block'/.test(menu) || !/action: 'block'/.test(menu),
  'the menu does not offer block/unblock (the bulk endpoint has no such operation)');
ok(!/bulkUserOps\('block'|bulkUserOps\('unblock'/.test(sa),
  'the screen never sends block/unblock to the bulk endpoint');
for (const op of ['suspend', 'unsuspend', 'reset_devices', 'reset_password', 'trash']) {
  ok(admin.includes(`'${op}' =>`) || admin.includes(`'${op}' => $this->`),
    `backend implements the "${op}" operation`);
}
ok(/post\('\/admin\/bulk-user-ops'/.test(routes) &&
   /'bulk-user-ops':\s*'\/admin\/bulk-user-ops'/.test(read('src/client/php.ts')),
  'route + client mapping for the bulk endpoint exist');

section('3. Safety: confirmation, per-user checks, no unknown passwords');

ok(/const copy: Record<BulkUserAction, \{ title: string; message: string; label: string; danger\?: boolean \}>/.test(sa),
  'each bulk action has its own confirmation copy');
ok(/suspend:[\s\S]{0,400}danger: true/.test(sa) &&
   /trash:[\s\S]{0,400}danger: true/.test(sa) &&
   /destructive: c0\.danger/.test(sa),
  'suspend and trash are confirmed as destructive');
ok(/reset_devices:[\s\S]{0,400}danger: true/.test(sa) &&
   /reset_password:[\s\S]{0,400}label: 'Send links'/.test(sa),
  'device reset is confirmed destructive and password reset is a link send, not a password set');

ok(/foreach \(\$userIds as \$userId\)/.test(admin),
  'bulk suspend/unsuspend iterates per user instead of one blanket UPDATE');
ok(/\$row\['role'\] === 'super_admin' && \$actorRole !== 'super_admin'/.test(admin),
  'a super_admin account is protected from lower-privileged bulk actions');
ok(/processed' => count\(\$userIds\)/.test(admin) &&
   /'succeeded' => \$success/.test(admin) && /'failed' => \$failed/.test(admin) && /'errors' => \$errors/.test(admin),
  'the response reports processed / succeeded / failed / per-user errors');
ok(/bulkTrash\(\s*array \$userIds,\s*string \$actorId,\s*string \$actorRole/.test(admin) &&
   /Only a super admin can trash a super admin account/.test(admin) &&
   /Cannot trash your own account/.test(admin),
  'bulk trash refuses a protected super_admin (for a non-SA actor) and self-trash, per user');
ok(/revokeAllForUser\(\$userId, 'bulk_trashed'\)/.test(admin),
  'a trashed account loses its live sessions, same as the single-user trash');
ok(/Cannot suspend your own account/.test(admin) &&
   /Cannot trash your own account/.test(admin) &&
   /Cannot delete your own account/.test(admin),
  'self-suspension, self-trash and self-permanent-delete are refused per user (server-side, not just hidden in the UI)');
ok(!/array_filter\(\$userIds, fn \(\$id\) => \$id !== \$actorId\)/.test(admin),
  'the actor id is NOT silently dropped from the batch (a refusal is reported, not skipped)');
ok(/revokeAllForUser\(\$userId, 'bulk_suspended'\)/.test(admin) &&
   /revokeAllForUser\(\$userId, 'bulk_device_reset'\)/.test(admin),
  'bulk suspend and bulk device reset revoke live sessions');
ok(/password_reset_tokens/.test(admin) && /EmailService::send\(/.test(admin),
  'bulk password reset issues one-time reset tokens and emails links');
ok(!/encrypted_password = \?/.test(admin.split('bulkResetPassword')[1]?.split('bulkPermanentDelete')[0] ?? ''),
  'bulk password reset does NOT write a password (the old discarded-temp-password path is gone)');
ok(/['"]mode['"] => ['"]reset_links['"]/.test(admin),
  'the audit trail records that resets were links, not passwords');

section('4. Partial success is reported, never hidden');

ok(/const failedIds = new Set\(errors\.map\(e => e\.user_id\)\)/.test(sa),
  'the screen derives the failed ids from the server response');
ok(/setBulkSelected\(new Set\(failedIds\)\)/.test(sa),
  'failed users stay selected so the admin can retry them');
ok(/setBulkResult\(\{/.test(sa) && /nameOf\(e\.user_id\)/.test(sa),
  'a result sheet names each failed user');
ok(/const CHUNK = 200;/.test(sa) && /ids\.slice\(i, i \+ CHUNK\)/.test(sa),
  'batches are sent in 200-id chunks (the server cap) so "select all" cannot 422 on a large result set');
ok(/res\.failed > 0 \? 'error' : 'success'/.test(sa),
  'a partial failure toasts as an error, not a success');

/* ══════════════ 5. Plyr centre control: one button, idle lifecycle ══════ */

section('5. Plyr centre control');

for (const [label, src] of [['native script', plyrTs], ['web copy', plyrJs]]) {
  // The lifecycle is the control bar's OWN `plyr--hide-controls` class on the
  // live root — applied as inline style by the script, mirrored by one CSS
  // rule. (A predicate on player.paused/ended could disagree with the class
  // Plyr paints, which is how the button stayed up after the bar hid.)
  ok(/function centreShouldShow\(\)[\s\S]{0,180}plyr--hide-controls/.test(src) &&
     /btn\.style\.visibility = 'visible'/.test(src),
    `${label}: centre button is visible exactly while the control bar is shown`);
  ok(/\.plyr\.plyr--hide-controls \.plyr__control--overlaid\{[^}]*visibility:hidden/.test(src) &&
     /btn\.style\.visibility = 'hidden'/.test(src),
    `${label}: centre button disappears together with the controls on idle`);
  ok(!/\.plyr--playing \.plyr__control--overlaid\{[^}]*visibility:visible/.test(src),
    `${label}: no rule pins the centre button visible for the whole of playback`);
  ok(/function dedupeCentre\(\)/.test(src) && /syncCentreState\(\)\s*\{\s*dedupeCentre\(\);/.test(src),
    `${label}: duplicate overlaid controls are removed (one functional centre button)`);
  ok(/setCentreState\(!wasPlaying\)/.test(src),
    `${label}: the centre glyph flips on the tap (optimistic), so the control does not feel slow`);
  ok(/if \(wasPlaying\) player\.pause\(\);|if \(wasPlaying\) \{[\s\S]{0,40}player\.pause\(\)/.test(src),
    `${label}: the tap still issues the real play/pause command`);
}

section('6. Plyr watermark — two lines, continuous motion, responsive size');

for (const [label, src] of [['native script', plyrTs], ['web copy', plyrJs]]) {
  ok(/_nEl = document\.createElement\('div'\)[\s\S]{0,120}_nEl\.textContent = name/.test(src) &&
     /_iEl = document\.createElement\('div'\)[\s\S]{0,80}_iEl\.textContent = String\(id \|\| ''\)/.test(src),
    `${label}: the mark is TWO elements — the name, then the id underneath`);
  ok(!/_iEl\.textContent = name \? name \+ ' \\u2022 '/.test(src),
    `${label}: the old single-line "NAME • ID" label is gone`);
  ok(/requestAnimationFrame\(step\)/.test(src) && /function step\(ts\)/.test(src),
    `${label}: motion is a requestAnimationFrame loop`);
  ok(/if \(dt > MAX_STEP_S\) dt = MAX_STEP_S/.test(src) &&
     /function advance\(pos, vel, dt, max\)/.test(src),
    `${label}: motion is elapsed-time based and clamped (frame-rate independent)`);
  ok(/if \(next < 0\) \{ next = -next; v = -v; \}/.test(src) &&
     /next = 2 \* max - next/.test(src),
    `${label}: exact reflection off both edges of each axis (multi-directional bouncing)`);
  ok(!/setTimeout\(function \(\) \{ move\(\); scheduleTick\(\); \}/.test(src) &&
     !/nxtSlot\(\)/.test(src),
    `${label}: the 30–60 s slot teleport is gone (no fixed two-position animation)`);
  ok(/opacity:0\.55/.test(src) && !/rnd\(0\.38,0\.58\)/.test(src),
    `${label}: opacity is fixed — the mark never fades or blinks`);
  ok(/px = Math\.round\(base \* 0\.062\)/.test(src) && /if \(px > 34\) px = 34/.test(src),
    `${label}: font size is responsive to the measured video box (up to 34 px in fullscreen)`);
  ok(/'pointer-events:none'/.test(src),
    `${label}: the mark can never intercept a tap, seek or control press`);
  ok(/function onResize\(\)/.test(src) &&
     /window\.addEventListener\('resize', onResize\)/.test(src),
    `${label}: bounds are recalculated on resize / fullscreen / rotation`);
}

/* ══════════════ 7. VdoCipher — provider annotate identity layout ════════ */

section('7. VdoCipher provider watermark');

ok(/\$id = trim\(\$watermarkId\);/.test(vdoService) &&
   !/['"]ID: ['"]|'ID: '\s*\./.test(vdoService),
  'the provider annotation no longer prints an "ID:" prefix');
ok(/\$lines = array_filter\(\[\s*\$name,\s*\$id,/s.test(vdoService) &&
   /\$text = implode\("\\n", \$lines\)/.test(vdoService),
  'annotate text is the name line followed by the id line');
ok(/'skip'     => '0'/.test(vdoService),
  "annotate skip = 0 — the provider mark is never hidden during playback");
ok(/'interval' => '8000'/.test(vdoService),
  'annotate relocates on a short interval instead of sitting still');

section('8. VdoCipher app overlay (WebView injection + native overlay)');

ok(/requestAnimationFrame\(step\)/.test(vdoInject) &&
   /function advance\(pos,vel,dt,max\)/.test(vdoInject),
  'injected overlay runs a real rAF bounce loop with edge reflection');
ok(!/scheduleTick/.test(vdoInject) && !/nxtSlot/.test(vdoInject),
  'injected overlay no longer uses the 30–60 s slot teleport');
ok(/opacity:0\.55/.test(vdoInject) && /pointer-events:none/.test(vdoInject),
  'injected overlay has fixed opacity and never captures touches');
ok(/px=Math\.round\(base\*0\.062\)/.test(vdoInject),
  'injected overlay scales its type to the viewport (fullscreen readable)');
ok(/_nEl\.textContent=WM_NAME/.test(vdoInject) && /_iEl\.textContent=WM_ID/.test(vdoInject),
  'injected overlay renders the name line and the id line');

ok(/setFontPx\(\(v\) => \(v === nextFont \? v : nextFont\)\)/.test(nativeOverlay),
  'native overlay derives a responsive font size from the measured container');
ok(/Math\.round\(fontPx \* WATERMARK_NAME_FONT_RATIO\)[^>]*>[\s\S]{0,80}\{watermarkName\}/.test(nativeOverlay) &&
   /styles\.wmId, \{ fontSize: fontPx \}[^>]*>[\s\S]{0,80}\{watermarkId\}/.test(nativeOverlay),
  'native overlay renders the name and the id as two separate styled lines');
ok(/stepWatermarkMotion/.test(nativeOverlay) && /useFrameCallback/.test(nativeOverlay),
  'native overlay keeps the UI-thread bouncing loop (no per-frame JS render)');

/* ══════════════ 9. No stale identity, no security regression ════════════ */

section('9. Security boundaries untouched');

ok(!/fetch\(|https?:\/\/[^'"`]*vdocipher[^'"`]*otp/i.test(plyrTs + vdoInject),
  'no player script fetches a provider endpoint or token directly');
ok(!/console\.log\([^)]*(token|otp|password)/i.test(plyrTs + vdoInject),
  'no player script logs a token, OTP or password');
ok(/key=\{`wm:\$\{watermarkLayers\.appOverlay \? watermarkId \?\? '' : ''\}/.test(webviewPlayer),
  'the WebView is keyed by the printed identity, so an identity change reloads the document (no stale mark)');
ok(/watermarkLayers\.appOverlay \? watermarkId : undefined/.test(webviewPlayer),
  'the injected overlay only prints an identity the layer policy activated');
ok(/revokeAllForUser/.test(admin),
  'bulk actions still go through the session-revocation service');
ok(/assertEnabled\('device_management'/.test(admin) || /device_management/.test(admin),
  'device-management feature flag still gates the device reset path');

console.log(`RESULT: ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  • ' + f));
}
process.exit(failed ? 1 : 0);
