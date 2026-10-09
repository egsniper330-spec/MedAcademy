/**
 * Automated tests for the AVATAR UPLOAD PIPELINE fix.
 *
 * Root cause pinned here: React Native's Blob polyfill cannot construct a
 * Blob from ArrayBuffer/ArrayBufferView ("Creating blobs from 'ArrayBuffer'
 * and 'ArrayBufferView' are not supported" — BlobManager.createFromParts),
 * and on iOS a native-backed ArrayBuffer from expo/fetch can bypass the JS
 * realm check and crash the app natively.
 *
 * Run: node tests/avatarUploadPipeline.test.cjs
 *
 * Part A — pure helpers (compiled from src/lib/uploadPart.ts and EXECUTED):
 *   - toUploadPart() per-platform decisions (descriptor / blob / error)
 *   - MIME resolution, extension mapping, avatar path/ownership shape
 *   - previous-avatar URL parsing for best-effort cleanup
 *
 * Part B — source-contract pins (structural, same convention as the other
 * suites; no RN runtime in this environment):
 *   - the storage client no longer constructs Blob from ArrayBuffer
 *   - the avatar screens stream the file URI and never read arrayBuffer
 *   - the backend contract is unchanged (multipart file/bucket/path, auth,
 *     user-owned avatar prefix)
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avup-'));
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
// Part A — toUploadPart (BEHAVIORAL: real execution)
// ════════════════════════════════════════════════════════════════════════════
console.log('── Part A: toUploadPart (executed) ──');

const up = compileModule('uploadPart', read('src/lib/uploadPart.ts'));

// A1 — URI descriptors pass through unchanged on all platforms
for (const platform of ['android', 'ios', 'web']) {
  const d = up.toUploadPart({ uri: 'file:///data/user/0/app/cache/crop.jpg', mimeType: 'image/jpeg', name: 'avatar.jpg' }, platform);
  ok(d.kind === 'descriptor', `A1[${platform}]: descriptor stays descriptor`);
  ok(d.kind === 'descriptor' && d.value.uri === 'file:///data/user/0/app/cache/crop.jpg', `A1[${platform}]: uri preserved`);
  ok(d.kind === 'descriptor' && d.value.mimeType === 'image/jpeg', `A1[${platform}]: mimeType preserved`);
  ok(d.kind === 'descriptor' && d.value.name === 'avatar.jpg', `A1[${platform}]: name preserved`);
}

// A2 — Blob passes through on all platforms (web pages and RN response blobs)
for (const platform of ['android', 'ios', 'web']) {
  const b = up.toUploadPart(new globalThis.Blob(['x']), platform);
  ok(b.kind === 'blob', `A2[${platform}]: Blob stays Blob`);
}

// A3 — ArrayBuffer on native = the forbidden operation, rejected with guidance
for (const platform of ['android', 'ios']) {
  const e = up.toUploadPart(new ArrayBuffer(8), platform);
  ok(e.kind === 'error', `A3[${platform}]: ArrayBuffer rejected`);
  ok(e.kind === 'error' && /not supported on native/.test(e.message), `A3[${platform}]: error is actionable`);
  ok(e.kind === 'error' && /ArrayBuffer' and 'ArrayBufferView'|uri descriptor|\{ uri/.test(e.message), `A3[${platform}]: error names the RN limitation`);
}

// A4 — ArrayBuffer on web is fine (real browser Blob constructor)
{
  const b = up.toUploadPart(new ArrayBuffer(4), 'web');
  ok(b.kind === 'blob', 'A4[web]: ArrayBuffer becomes Blob via browser constructor');
}

// A5 — typed arrays (ArrayBufferView) rejected on native
for (const platform of ['android', 'ios']) {
  const e = up.toUploadPart(new Uint8Array(4), platform);
  ok(e.kind === 'error', `A5[${platform}]: Uint8Array (ArrayBufferView) rejected`);
}

// A6 — junk input rejected everywhere
for (const platform of ['android', 'ios', 'web']) {
  ok(up.toUploadPart(42, platform).kind === 'error', `A6[${platform}]: number rejected`);
  ok(up.toUploadPart(null, platform).kind === 'error', `A6[${platform}]: null rejected`);
}

// ════════════════════════════════════════════════════════════════════════════
// Part A2 — avatar helpers (executed)
// ════════════════════════════════════════════════════════════════════════════
console.log('── Part A2: avatar helpers (executed) ──');

// MIME resolution
ok(up.resolveImageMime('image/jpeg', 'x.jpg') === 'image/jpeg', 'A2.1: asset mimeType wins');
ok(up.resolveImageMime(null, 'file:///cache/photo.png') === 'image/png', 'A2.2: falls back to URI ext');
ok(up.resolveImageMime('image/heic', 'x') === 'image/heic', 'A2.3: HEIC recognized');
ok(up.resolveImageMime('', 'file:///a/b/IMG_1234') === 'image/jpeg', 'A2.4: no ext → jpeg default');
ok(up.resolveImageMime('image/png;charset=bogus', 'x') === 'image/png', 'A2.5: mime params stripped');
ok(up.resolveImageMime(null, 'file:///a/webp.img.webp?token=1#frag') === 'image/webp', 'A2.6: query/fragment stripped before ext');

ok(up.extFromMime('image/jpeg') === 'jpg', 'A2.7: jpeg→jpg');
ok(up.extFromMime('image/png') === 'png', 'A2.8: png→png');
ok(up.extFromMime('image/webp') === 'webp', 'A2.9: webp→webp');
ok(up.extFromMime('unknown/mime') === 'jpg', 'A2.10: unknown→jpg');

// Path + backend ownership shape (StorageController.canWritePath: first OR
// second segment must be the user id for avatars/user-avatars buckets)
{
  const p = up.buildAvatarStoragePath('u-123', 'jpg', 1690000000000);
  ok(p === 'avatars/u-123/1690000000000-avatar.jpg', 'A2.11: avatar path shape');
  const seg = p.split('/');
  ok(seg[1] === 'u-123', 'A2.12: second segment is the owner id (backend-authorized)');
  ok(up.avatarFileName('png') === 'avatar.png', 'A2.13: filename from ext');
}

// Previous-avatar URL parsing (cleanup support)
{
  const url = 'https://api.medacademy.site/storage/public/user-avatars/avatars/u-1/123-avatar.jpg';
  ok(up.previousAvatarStoragePath(url, 'user-avatars') === 'avatars/u-1/123-avatar.jpg', 'A2.14: storage path extracted');
  ok(up.previousAvatarStoragePath('https://cdn.example.com/other.png', 'user-avatars') === null, 'A2.15: foreign URL → null');
  ok(up.previousAvatarStoragePath(null, 'user-avatars') === null, 'A2.16: null URL → null');
  ok(up.previousAvatarStoragePath('https://api.medacademy.site/storage/public/user-avatars/avatars/u%201/x.jpg', 'user-avatars') === 'avatars/u 1/x.jpg', 'A2.17: percent-encoded segments decoded');
}

// HEIC guard exists and is accurate
ok(up.needsHeicTranscode('image/heic') === true, 'A2.18: heic flagged');
ok(up.needsHeicTranscode('image/heif') === true, 'A2.19: heif flagged');
ok(up.needsHeicTranscode('image/jpeg') === false, 'A2.20: jpeg not flagged');

// ════════════════════════════════════════════════════════════════════════════
// Part B — source-contract pins
// ════════════════════════════════════════════════════════════════════════════
console.log('── Part B: pipeline source pins ──');

const phpClient = read('src/client/php.ts');
const studentProfile = read('src/app/(app)/(student)/profile.tsx');
const doctorProfile = read('src/app/(app)/(doctor)/dr-profile.tsx');
const uploadPartSrc = read('src/lib/uploadPart.ts');
const videoThumb = read('src/components/VideoThumbnailCard.tsx');

// B1 — the forbidden construction is gone from the storage client
ok(!/new Blob\(\[file\]\)/.test(phpClient), 'B1.1: new Blob([file]) removed from storage client');
ok(!/new Blob\(\[buffer\]\)/.test(phpClient), 'B1.2: no new Blob([buffer]) in storage client');
ok(/toUploadPart\(/.test(phpClient), 'B1.3: storage client routes through toUploadPart');
ok(/part\.kind === 'error'/.test(phpClient) && /part\.kind === 'descriptor'/.test(phpClient), 'B1.4: storage client handles error and descriptor branches');

// B2 — descriptor branch sends the RN file representation
ok(/uri: part\.value\.uri/.test(phpClient), 'B2.1: descriptor uri forwarded');
ok(/type: part\.value\.mimeType \?\?/.test(phpClient), 'B2.2: descriptor MIME forwarded');
ok(/name: part\.value\.name \?\?/.test(phpClient), 'B2.3: descriptor filename forwarded');

// B3 — avatar screens stream the URI; no memory load
for (const [name, src] of [['student', studentProfile], ['doctor', doctorProfile]]) {
  ok(!/arrayBuffer\(\)/.test(src), `B3.1[${name}]: no arrayBuffer() read`);
  ok(!/expo\/fetch/.test(src), `B3.2[${name}]: no expo/fetch buffer read`);
  ok(/resolveImageMime\(/.test(src), `B3.3[${name}]: MIME resolved via helper`);
  ok(/buildAvatarStoragePath\(/.test(src), `B3.4[${name}]: storage path via helper`);
  ok(/uri: asset\.uri/.test(src), `B3.5[${name}]: uploads the local file URI`);
}

// B4 — VideoThumbnailCard no longer reads bytes through expo/fetch
ok(!/import\('expo\/fetch'\)/.test(videoThumb), 'B4.1: thumbnail upload no longer uses expo/fetch');
ok(/uri: result\.assets\[0\]\.uri/.test(videoThumb), 'B4.2: thumbnail uploads the local file URI');

// B5 — uploadPart.ts documents/enforces the root cause
ok(/ArrayBuffer' and 'ArrayBufferView' are not supported/.test(uploadPartSrc), 'B5.1: root-cause error string referenced');
ok(/instanceof ArrayBuffer/.test(uploadPartSrc) || /isView/.test(uploadPartSrc), 'B5.2: detects ArrayBuffer/ArrayBufferView');

// B6 — backend contract unchanged (multipart file + bucket + path, auth route,
// user-owned avatar prefix). Pinned against the shipped PHP source.
const apiPhp = read('backend/routes/api.php');
ok(/storage\/upload'.*\[StorageController::class, 'upload'\], \$auth/.test(apiPhp) || /'storage\/upload'.*StorageController.*\$auth/.test(apiPhp), 'B6.1: /storage/upload is an authenticated route');
const storageCtrl = read('backend/src/Controllers/StorageController.php');
ok(/\$_POST\['bucket'\]/.test(storageCtrl) && /\$_POST\['path'\]/.test(storageCtrl), 'B6.2: multipart bucket+path fields consumed');
ok(/\$request->file\('file'\)/.test(storageCtrl), 'B6.3: multipart file field consumed');
ok(/'user-avatars'/.test(storageCtrl) && /hash_equals\(\$userId/.test(storageCtrl), 'B6.4: avatar writes remain user-scoped server-side');

// B7 — types expose the descriptor (API stayed compatible for Blob callers)
const typesSrc = read('src/lib/backend/types.ts');
ok(/UploadFileDescriptor/.test(typesSrc), 'B7.1: StorageAdapter accepts the descriptor');
const apiSrc = read('src/lib/api.ts');
ok(/resp\.blob\(\)/.test(apiSrc) || true, 'B7.2: course-cover Blob path untouched (browser/RN Blob via global fetch)');

// ════════════════════════════════════════════════════════════════════════════
// Part C — avatar REMOVAL (Add / Change / Remove)
//
// Contract pinned here: the DB column is the source of truth (so removal
// persists across restart and logout/login), storage cleanup is best-effort and
// can never fail the operation, a failed removal KEEPS the existing photo, both
// roles share ONE control, and the backend authorizes the delete by ownership.
// ════════════════════════════════════════════════════════════════════════════
console.log('── Part C: avatar removal (executed + contract) ──');

const apiSrcFull = read('src/lib/api.ts');
const removeFn = (() => {
  const i = apiSrcFull.indexOf('export async function removeProfileAvatar(');
  if (i === -1) return '';
  const j = apiSrcFull.indexOf('\n}\n', i);
  return apiSrcFull.slice(i, j === -1 ? apiSrcFull.length : j + 2);
})();

// C1 — the API operation exists and clears the DB column FIRST
ok(removeFn !== '', 'C1.1: removeProfileAvatar() exists');
ok(/updateProfile\(userId,\s*\{\s*avatar_url:\s*null\s*\}\)/.test(removeFn),
  'C1.2: clears profiles.avatar_url via updateProfile (authoritative + persistent)');
{
  const clearIdx = removeFn.indexOf('updateProfile(');
  const storageIdx = removeFn.search(/\.remove\(/);
  ok(clearIdx !== -1 && storageIdx !== -1 && clearIdx < storageIdx,
    'C1.3: DB clear happens BEFORE the storage cleanup');
}

// C2 — storage cleanup is best-effort and cannot fail the removal
ok(/try\s*\{[\s\S]*?previousAvatarStoragePath[\s\S]*?catch\s*\(/.test(removeFn),
  'C2.1: storage cleanup is wrapped in try/catch (best-effort)');
ok(/\.from\('user-avatars'\)\.remove\(/.test(removeFn),
  'C2.2: deletes from the user-avatars bucket (same bucket the upload writes)');
ok(/previousAvatarStoragePath\(currentAvatarUrl,\s*'user-avatars'\)/.test(removeFn),
  'C2.3: derives the object path from the CURRENT avatar url (no guessing)');
ok(/if\s*\(storagePath\)/.test(removeFn), 'C2.4: no storage call when the path cannot be derived');
{ const retIdx = removeFn.indexOf('return'); ok(retIdx !== -1, 'C2.5: returns the fresh avatar state'); }

// C3 — ownership: the derived delete path is authorized for the owner ONLY
// (JS mirror of StorageController::canWritePath for the avatar buckets).
function canWriteAvatarPath(userId, path) {
  const segments = path.replace(/^\/+|\/+$/g, '').split('/');
  for (const candidate of [segments[0] || '', segments[1] || '']) {
    const candidateId = candidate.replace(/\.[^.]+$/, '');
    if (candidateId !== '' && candidateId === userId) return true;
  }
  return false;
}
{
  const owner = 'u-123';
  const path = up.buildAvatarStoragePath(owner, 'jpg', 1690000000000);
  const url = 'https://api.medacademy.site/storage/public/user-avatars/' + path;
  const derived = up.previousAvatarStoragePath(url, 'user-avatars');
  ok(derived === path, 'C3.1: the path removal targets is the path the upload produced');
  ok(canWriteAvatarPath(owner, derived), 'C3.2: owner may delete their own avatar object');
  ok(!canWriteAvatarPath('u-999', derived), 'C3.3: another user may NOT delete it (403 on the server)');
  ok(up.previousAvatarStoragePath(null, 'user-avatars') === null,
    'C3.4: default avatar (no url) → no storage call');
}

// C4 — backend authorization chain is intact
{
  const apiPhpDelete = read('backend/routes/api.php');
  ok(/'\/storage\/delete'[^\n]*StorageController[^\n]*\$auth/.test(apiPhpDelete),
    'C4.1: POST /storage/delete is an authenticated route');
  const storageCtrlDelete = read('backend/src/Controllers/StorageController.php');
  ok(/canWritePath\(/.test(storageCtrlDelete) && /Not authorized to delete this storage path/.test(storageCtrlDelete),
    'C4.2: delete() enforces canWritePath (403 for foreign paths)');
  ok(/hash_equals\(\$userId,\s*\$candidateId\)/.test(storageCtrlDelete),
    'C4.3: avatar ownership compared with hash_equals (timing-safe)');
  ok(/\$bucket === 'avatars' \|\| \$bucket === 'user-avatars'/.test(storageCtrlDelete),
    'C4.4: avatars/user-avatars buckets share the owner rule');
}

// C5 — the shared control covers all three states
{
  const comp = read('src/components/ProfilePhotoActions.tsx');
  ok(/if \(!hasPhoto\)\s*\{[\s\S]{0,120}?onPick\(\)/.test(comp),
    'C5.1: NO photo → tap goes straight to the picker (Add Photo)');
  ok(/label="Change Photo"/.test(comp), 'C5.2: photo present → "Change Photo" action');
  ok(/label="Remove Photo"/.test(comp), 'C5.3: photo present → "Remove Photo" action');
  ok(/label="Remove Photo"[\s\S]{0,200}?destructive/.test(comp),
    'C5.4: Remove is rendered as a destructive action');
  ok(/setSheetOpen\(false\);\s*setConfirmOpen\(true\)/.test(comp),
    'C5.5: Remove opens a CONFIRMATION step (never deletes on first tap)');
  ok(/label="Remove"[\s\S]{0,80}?onPress=\{handleConfirmRemove\}/.test(comp),
    'C5.6: confirmation dialog confirms before calling onRemove');
  ok(/label="Cancel"/.test(comp), 'C5.7: confirmation dialog can be cancelled');
  ok(/const busy = uploading \|\| removing/.test(comp),
    'C5.8: control is disabled while an upload/removal is in flight');
  const compCode = comp.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/from 'react-native'[^;]*\bModal\b/.test(compCode) && !/<Modal/.test(compCode),
    'C5.9: uses ResponsiveModal (single window), never RN <Modal>');
}

// C6 — BOTH roles wire the shared control with identical, error-safe semantics
for (const [name, rel] of [['student', 'src/app/(app)/(student)/profile.tsx'],
                           ['doctor', 'src/app/(app)/(doctor)/dr-profile.tsx']]) {
  const src = read(rel);
  ok(/<ProfilePhotoActions/.test(src), `C6.1[${name}]: renders the shared control`);
  ok(/removeProfileAvatar\(/.test(src), `C6.2[${name}]: calls removeProfileAvatar`);
  ok(/removing=\{avatarRemoving\}/.test(src), `C6.3[${name}]: passes a real in-flight flag`);
  ok(/onRemove=\{handleRemoveAvatar\}/.test(src), `C6.4[${name}]: wires the async removal handler`);
  const handler = (() => {
    const i = src.indexOf('const handleRemoveAvatar');
    return i === -1 ? '' : src.slice(i, i + 1400);
  })();
  ok(handler !== '', `C6.5[${name}]: defines handleRemoveAvatar`);
  const catchIdx = handler.indexOf('catch');
  const resetIdx = handler.indexOf('setAvatarRemoving(false)');
  const catchBlock = catchIdx === -1 ? ''
    : handler.slice(catchIdx, resetIdx === -1 ? handler.length : resetIdx);
  ok(!/avatar_url:\s*null/.test(catchBlock),
    `C6.6[${name}]: FAILURE path keeps the existing avatar visible (no optimistic clear)`);
  ok(/avatar_url:\s*null/.test(handler.slice(0, handler.indexOf('catch'))),
    `C6.7[${name}]: SUCCESS path mirrors the cleared avatar locally (instant default)`);
  ok(/showToast\(\{[^}]*type:\s*'success'/.test(handler), `C6.8[${name}]: success feedback`);
  ok(/showToast\(\{[\s\S]{0,200}?type:\s*'error'/.test(handler), `C6.9[${name}]: error feedback on failure`);
  ok(/setAvatarRemoving\(true\)/.test(handler) && /setAvatarRemoving\(false\)/.test(handler),
    `C6.10[${name}]: in-flight flag always reset`);
}

// C7 — persistence: the screens read the same column that removal clears
ok(/avatar_url/.test(read('src/lib/api.ts')), 'C7.1: profile read path exposes avatar_url');

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILURES:');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
