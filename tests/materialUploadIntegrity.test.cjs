'use strict';
/**
 * Regression guard — a lesson-material upload can never again "succeed" with
 * zero bytes stored, and deleting/replacing a material reclaims its files.
 *
 * ── The incident this pins ──────────────────────────────────────────────────
 * A doctor uploaded a ~2 MB PDF. It finished instantly, the app reported
 * success, `lesson_materials` gained a row — and the object in private storage
 * was 0 bytes (`file_hash = e3b0c442…`, the SHA-256 of empty input). The app's
 * PDF delivery endpoint then refused it (`source_unreadable`), so the document
 * was simply gone, and the row kept claiming a 2 MB file.
 *
 * Two independent gaps combined:
 *
 *   1. CLIENT — `uploadLessonMaterial` built the multipart body from
 *      `(await fetch(fileUri)).blob()`. On React Native that does not read a
 *      local file: it resolves immediately with an EMPTY body, so the part
 *      carried 0 bytes and nothing was ever read from disk (hence "instant").
 *      The supported representation is the `{ uri, name, type }` descriptor,
 *      which the native layer streams from disk (`toUploadPart`).
 *   2. SERVER — `StorageController::upload` only inspected `$_FILES['error']`.
 *      `UPLOAD_ERR_OK` plus an empty temp file passed every check, was moved
 *      into storage as a 0-byte object, and answered 200. `putFile()` did not
 *      verify what it wrote, and the material row stored the picker's claimed
 *      size without looking at the file.
 *
 * ── Also pinned ─────────────────────────────────────────────────────────────
 *   • the upload reports the MEASURED size + SHA-256, and a 0-byte response is
 *     treated as a failure by the client;
 *   • a `lesson_materials` write is refused when the object is missing/empty,
 *     and `file_size` is re-measured from disk;
 *   • delete/replace are server-side, commit the row first, then reclaim the
 *     source AND the generated watermarked copies (which used to leak forever);
 *   • a path still referenced by another material is retained, `../` cannot
 *     escape the storage root, and a failed unlink is queued for retry;
 *   • lesson/section/course deletion reclaims their files (the old
 *     `$storagePaths` array was collected and never used).
 *
 * Behaviour that cannot be exercised from Node (the PHP services themselves)
 * lives in `backend/tests/material-lifecycle/upload_and_cleanup_tests.php`,
 * which runs against a real filesystem and a real (SQLite) database:
 *   bash backend/tests/material-lifecycle/run.sh
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error('  ✗ ' + msg);
  }
}
function read(p) {
  return fs.readFileSync(path.join(ROOT, p), 'utf8');
}
/**
 * Drop comment-only lines so a phrase inside an explanatory comment (e.g. the
 * `fetch(fileUri).blob()` this suite forbids) can never satisfy a check.
 * Only whole-line comments are removed — `//` inside a URL literal must survive.
 */
function code(src) {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#['));
    })
    .join('\n');
}
function exists(p) {
  return fs.existsSync(path.join(ROOT, p));
}

const API = 'src/lib/api.ts';
const CLIENT = 'src/client/php.ts';
const EDITOR = 'src/app/(app)/lesson-editor/[id].tsx';
const STORE_CTRL = 'backend/src/Controllers/StorageController.php';
const STORAGE = 'backend/src/Storage/StorageService.php';
const INTEGRITY = 'backend/src/Services/UploadIntegrityService.php';
const CLEANUP = 'backend/src/Services/MaterialFileCleanupService.php';
const MATERIAL_CTRL = 'backend/src/Controllers/LessonMaterialController.php';
const DATA = 'backend/src/Controllers/DataController.php';
const COURSE_CTRL = 'backend/src/Controllers/CourseController.php';
const RPC = 'backend/src/Controllers/RpcController.php';
const WATERMARK = 'backend/src/Services/PdfWatermarkService.php';
const ROUTES = 'backend/routes/api.php';
const DIAG = 'backend/scripts/diagnose-pdf-delivery.php';
const CLI = 'backend/scripts/storage-cleanup.php';
const PHP_SUITE = 'backend/tests/material-lifecycle/upload_and_cleanup_tests.php';

const api = code(read(API));
const client = code(read(CLIENT));
const editor = code(read(EDITOR));
const storeCtrl = read(STORE_CTRL);
const storage = read(STORAGE);
const integrity = read(INTEGRITY);
const cleanup = read(CLEANUP);
const materialCtrl = read(MATERIAL_CTRL);
const dataCtrl = read(DATA);
const courseCtrl = read(COURSE_CTRL);
const rpc = read(RPC);
const watermark = read(WATERMARK);
const routes = read(ROUTES);

/* ─────────── 1. The client must never derive upload bytes from a Blob ────── */

console.log('── Client upload path: bytes come from the file descriptor ──');

ok(
  !/fetch\(\s*fileUri\s*\)/.test(api) && !/resp\.blob\(\)/.test(api),
  'api.ts must not read a local file via fetch(fileUri).blob() — that yields an empty body on React Native'
);
ok(
  /\.upload\(\s*\n?\s*storagePath,\s*\n?\s*\{\s*uri:\s*fileUri,\s*name:\s*fileName,\s*mimeType\s*\}/.test(api) ||
    /upload\(\s*storagePath,\s*\{\s*uri:\s*fileUri,\s*name:\s*fileName,\s*mimeType\s*\}/.test(api),
  'uploadLessonMaterial must pass the { uri, name, mimeType } descriptor to the storage client'
);
ok(
  /const \{ storagePath, publicUrl, size \} = await uploadLessonMaterial/.test(editor) &&
    /file_size:\s*size/.test(editor),
  'the lesson editor must record the SERVER-measured size, not the picker claim'
);
ok(
  /lessonEditor\.uploadEmpty/.test(editor),
  'the editor must reject a 0-byte pick before uploading (localized message)'
);

console.log('── Storage client: an upload only succeeds with real bytes ──');

ok(/sha256:\s*String\(data\??\.sha256 \?\? ''\)/.test(client) || /sha256/.test(client), 'the upload result must expose the stored digest');
ok(
  /if \(!\(size > 0\)\)/.test(client) && /upload_empty/.test(client),
  'the client upload must FAIL when the server reports 0 stored bytes'
);
ok(/data:\s*null/.test(client), 'every upload failure branch returns data: null (no ambiguous shape)');

/* ───────────────── 2. Server: validate → persist → verify ───────────────── */

console.log('── Server upload: validate the bytes, store atomically, verify ──');

ok(/UploadIntegrityService/.test(storeCtrl), 'StorageController must use UploadIntegrityService');
// The controller passes the SELECTED file's byte count as a 4th argument — the
// only independent measurement that can say whether the body belongs to that
// document (`$_FILES['size']` is filled by PHP from the bytes it received) —
// together with its PROVENANCE, because provider metadata is a hint while a
// filesystem stat is a measurement. Both must reach validate().
ok(
  /validate\(\$file, \$dest, \$bucket, \$clientDeclared, \$declaredSource\)/.test(storeCtrl)
    && /\$_POST\['declared_size'\]/.test(storeCtrl)
    && /\$_POST\['declared_size_source'\]/.test(storeCtrl)
    && /persist\(\$validated\['tmp'\], \$validated\['size'\]/.test(storeCtrl),
  'the controller must validate (including the declared size AND its source) before writing and persist the validated byte count'
);
// A refusal must carry the operation id back to the app, otherwise "Upload
// failed" cannot be matched to one `storage-upload` log line.
ok(
  /new UploadIntegrityService|new UploadRefusedException/.test(storeCtrl)
    && /UploadRefusedException\(/.test(storeCtrl)
    && /opId\(\)/.test(storeCtrl),
  'an upload refusal must return the operation id (UploadRefusedException)'
);
ok(
  /UploadRefusedException/.test(read('backend/src/Middleware/ErrorHandler.php'))
    && /'op' => \$e->op/.test(read('backend/src/Middleware/ErrorHandler.php')),
  'ErrorHandler must expose the upload operation id on the error object'
);
ok(
  /'size' => \$stored\['size'\]/.test(storeCtrl) && /'sha256' => \$stored\['sha256'\]/.test(storeCtrl),
  'the upload response must carry the measured size and SHA-256'
);
ok(!/\$this->storage->putFile\(/.test(storeCtrl) || /integrity->persist/.test(storeCtrl), 'no direct putFile() call bypasses validation');

ok(/upload_empty/.test(integrity), 'an empty body must be refused with upload_empty');
ok(/upload_truncated/.test(integrity), 'a body shorter than its declared size must be refused with upload_truncated');
ok(/persist_mismatch/.test(integrity), 'a short write must be refused with persist_mismatch');
ok(/material_file_missing/.test(integrity) && /material_file_empty/.test(integrity), 'stored-object inspection must distinguish missing from empty');
ok(/PdfWatermarkService/.test(integrity) && /inspect\(/.test(integrity), 'PDF validation must reuse the renderer\'s own parser');
ok(/opId/.test(integrity) && /Logger::instance\(\)/.test(integrity), 'uploads must log a correlation id + stage (privacy-safe diagnostics)');

ok(/const part = \$full . '.' . bin2hex/.test(storage) || /\.part'/.test(storage), 'putFile must write a sibling .part then rename (atomic)');
ok(/expectedBytes !== null && \$written !== \$expectedBytes/.test(storage), 'putFile must compare the written bytes before publishing');
ok(/absolutePath\(/.test(storage), 'StorageService must expose containment-checked absolute paths');
ok(/is_link\(\$abs\)/.test(storage), 'a symlinked object must be refused for deletion');

/* ───────── 3. A material row must point at real, measured bytes ─────────── */

console.log('── Material rows: measured size + hash cache, never a client claim ──');

ok(/withVerifiedMaterialFile/.test(dataCtrl), 'DataController must verify lesson_materials writes');
ok(
  /\$table === 'lesson_materials'[\s\S]{0,120}withVerifiedMaterialFile\(\$row\)/.test(dataCtrl),
  'the INSERT path must verify the object'
);
ok(/\$row\['file_size'\] = \$measured\['size'\]/.test(dataCtrl), 'the measured byte count must override the client-declared size');
ok(/file_hash_mtime/.test(dataCtrl), 'the source-hash cache must be populated, including the mtime guard');

/* ───────────── 4. Delete / replace: row first, files after ──────────────── */

console.log('── Delete / replace: commit, then reclaim source + generated copies ──');

ok(/material-delete/.test(api) && /material-replace/.test(api), 'the client must use the server lifecycle endpoints');
ok(!/storage\.from\('lesson-materials'\)\.remove\(\[oldStoragePath\]\)/.test(api), 'the client must not delete the old object before the row is updated');
ok(
  /'\/materials\/\{id\}\/delete'/.test(client) && /'\/materials\/\{id\}\/replace'/.test(client),
  'the client must route to the new lifecycle endpoints'
);
ok(
  /\/materials\/\{id\}\/delete/.test(routes) && /\/materials\/\{id\}\/replace/.test(routes),
  'both lifecycle routes must be registered'
);
ok(/LessonMaterialController/.test(routes), 'routes must point at LessonMaterialController');

const txnAt = materialCtrl.indexOf('->transaction(');
const retireAt = materialCtrl.indexOf('cleanup->retire(');
ok(txnAt > 0 && retireAt > txnAt, 'the database change must commit BEFORE any file is reclaimed');
ok(/snapshotMaterial\(\$materialId\)/.test(materialCtrl), 'the file snapshot must be taken before the cascade removes the variant rows');
ok(/courses WHERE id = \? AND doctor_id = \?/.test(materialCtrl), 'ownership must be re-checked from the material\'s course');
ok(/path_out_of_scope/.test(materialCtrl), 'a replacement path must stay inside this course/lesson prefix');
ok(/path_in_use/.test(materialCtrl), 'a replacement may not adopt an object already used by another material');
ok(/inspectStored\(/.test(materialCtrl), 'a replacement must be validated before the row is changed');

ok(/isReferencedElsewhere/.test(cleanup), 'cleanup must retain a path still referenced by another material');
ok(/DELETE FROM lesson_material_pdfs WHERE material_id = \?/.test(cleanup), 'cleanup must drop the variant registry rows');
ok(/enqueue\(/.test(cleanup) && /retryPending\(/.test(cleanup), 'a failed unlink must be queued and retryable');
ok(/scanOrphans\(/.test(cleanup), 'cleanup must be able to list unreferenced files for reconciliation');
ok(/outside_root_or_missing/.test(cleanup), 'cleanup must refuse a path that resolves outside the storage root');

/* ─────── 5. Lesson / section / course deletion no longer leaks files ────── */

console.log('── Cascading deletes reclaim their material files ──');

ok(!/\$storagePaths = \[\];/.test(courseCtrl), 'the dead $storagePaths collection must be gone');
ok(/materialSnapshots = \$cleanup->snapshotLesson\(\$lessonId\)/.test(courseCtrl), 'lesson delete must snapshot its materials');
ok(/materialSnapshots = \$cleanup->snapshotCourse\(\$id\)/.test(courseCtrl), 'course delete must snapshot its materials');
ok(/snapshotLesson\(\$lessonId\)/.test(courseCtrl) && /'section_delete'/.test(courseCtrl), 'section delete must reclaim its lessons\' materials');
ok(/snapshotCourse\(\$courseId\)/.test(rpc) && /'course_hard_delete'/.test(rpc), 'hard course delete must reclaim its materials');

/* ───────────── 6. Diagnostics + operator tooling ────────────────────────── */

console.log('── Diagnostics and the cleanup CLI ──');

const diag = read(DIAG);
ok(/source_unreadable/.test(diag) && /0 bytes/.test(diag), 'the diagnostic must explain a 0-byte source file');
ok(/hash_cache/.test(diag) && /personalized_copies/.test(diag) && /cleanup_health/.test(diag), 'the diagnostic must report cache, copies and cleanup health');
ok(/absolute_path/.test(diag), 'the diagnostic must report the resolved storage path (CLI only)');

ok(exists(CLI), 'storage-cleanup.php must exist');
const cli = read(CLI);
ok(/PHP_SAPI !== 'cli'/.test(cli), 'the cleanup CLI must refuse a web SAPI');
ok(/--retry/.test(cli) && /--orphans/.test(cli), 'the CLI must support retry and orphan listing');
ok(/--delete-orphans/.test(cli) && /--yes/.test(cli), 'deleting orphans must require an explicit --yes');
ok(exists(PHP_SUITE), 'the filesystem/database suite must exist');
ok(exists('backend/tests/material-lifecycle/run.sh'), 'the suite must have a runner');

/* ───────────── 7. The watermark delivery contract is untouched ──────────── */

console.log('── PDF protection is not weakened by any of this ──');

ok(/source_unreadable/.test(watermark), 'the renderer still refuses an unreadable source');
ok(/public function inspect\(/.test(watermark), 'the shared PDF validation must live on the watermark service');
ok(!/ghostscript/i.test(integrity) && !/ghostscript/i.test(cleanup), 'no AGPL renderer may be introduced by the upload/cleanup paths');
ok(!/unwatermarked/i.test(materialCtrl), 'no unwatermarked fallback may be introduced');

/* ─────────────────────────────── Summary ────────────────────────────────── */

console.log('\n' + '─'.repeat(60));
if (failed > 0) {
  console.error(`${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
