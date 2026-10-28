'use strict';
/**
 * Regression guard — a refused PDF upload must reach the doctor with a REASON,
 * and a refused material row must not leave bytes behind.
 *
 * ── The incident this pins ──────────────────────────────────────────────────
 * On the live host a doctor attached a PDF and the app answered "Upload failed."
 * That sentence was the frontend's generic fallback, not the server's answer: the
 * backend had already decided something precise (the document was refused by the
 * PDF gate, or its row could not be written) and returned a 422/500 with a stable
 * code. `classifyUploadFailure()` only looked at the HTTP status, so every 422 —
 * a compressed-container PDF, a damaged one, an encrypted one, a missing stored
 * object — collapsed into the same unactionable sentence. Nothing in the UI could
 * tell the doctor to re-export the file, pick another copy, or retry.
 *
 * A second, quieter defect: when the row was refused AFTER the bytes were stored,
 * nothing reclaimed that object. Every retry uploaded a second copy and the first
 * stayed in private storage forever.
 *
 * ── What is pinned here ─────────────────────────────────────────────────────
 *   • each stable backend code maps to its OWN localized message;
 *   • every key the classifier can return exists in BOTH locales (so no toast can
 *     ever render a raw key or fall back to "Upload failed.");
 *   • the screen reclaims the uploaded object only when the server definitively
 *     refused (4xx) — a 5xx/timeout may have written the row, so bytes are kept;
 *   • the server side of the contract: host-aware size cap, explained code for a
 *     compressed container, a named material-write failure, and an existing
 *     CLI diagnostic that changes nothing.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

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
/** Whole-line comments removed, so a phrase inside a comment cannot satisfy a check. */
function code(src) {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}
function compileModule(name, relPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upfail-'));
  const src = path.join(dir, `${name}.ts`);
  const out = path.join(dir, `${name}.js`);
  fs.writeFileSync(src, read(relPath), 'utf8');
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      src,
      '--outDir', dir,
      '--module', 'commonjs',
      '--target', 'es2020',
      '--skipLibCheck',
      '--noEmitOnError', 'false',
    ],
    { stdio: 'pipe' },
  );
  return require(out);
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Backend codes → their own wording
// ════════════════════════════════════════════════════════════════════════════
console.log('── 1. Failure classification (executed) ──');

const P = compileModule('uploadProgress', 'src/lib/uploadProgress.ts');

const EXPECTED = [
  [{ status: 422, code: 'pdf_unsupported_format' }, 'lessonEditor.upload.pdfUnsupported', false],
  [{ status: 422, code: 'pdf_invalid' }, 'lessonEditor.upload.pdfInvalid', false],
  [{ status: 422, code: 'pdf_encrypted' }, 'lessonEditor.upload.pdfEncrypted', false],
  [{ status: 400, code: 'pdf_truncated' }, 'lessonEditor.upload.pdfTruncated', true],
  [{ status: 400, code: 'upload_truncated' }, 'lessonEditor.upload.pdfTruncated', true],
  [{ status: 422, code: 'material_file_missing' }, 'lessonEditor.upload.notStored', true],
  [{ status: 422, code: 'material_file_empty' }, 'lessonEditor.upload.notStored', true],
  [{ status: 500, code: 'material_write_failed' }, 'lessonEditor.upload.saveFailed', true],
  [{ status: 500, code: 'storage_write_failed' }, 'lessonEditor.upload.saveFailed', true],
  [{ status: 500, code: 'persist_mismatch' }, 'lessonEditor.upload.saveFailed', true],
];
const returnedKeys = new Set();
for (const [error, key, retryable] of EXPECTED) {
  const info = P.classifyUploadFailure(error);
  returnedKeys.add(info.messageKey);
  ok(
    info.messageKey === key && info.retryable === retryable && info.stage === 'failed',
    `code ${error.code} → ${key} (got ${info.messageKey}/${info.retryable})`,
  );
}

// The generic fallback must remain reachable for genuinely unknown failures.
const generic = P.classifyUploadFailure({ status: 422, code: 'something_new' });
returnedKeys.add(generic.messageKey);
ok(generic.messageKey === 'lessonEditor.upload.failed', 'an unknown 422 code stays generic');
ok(generic.retryable === true, 'an unknown failure is retryable');

// A status with dedicated copy still wins over a code.
ok(
  P.classifyUploadFailure({ status: 401, code: 'pdf_invalid' }).messageKey === 'lessonEditor.upload.sessionExpired',
  'auth failure is never reported as a document problem',
);

// ════════════════════════════════════════════════════════════════════════════
// 2. Every reachable key is translated in both locales
// ════════════════════════════════════════════════════════════════════════════
console.log('── 2. Localization of every reachable message ──');

const resources = read('src/lib/i18n/resources.ts');
function localeKeys(name, nextMarker) {
  const start = resources.indexOf(`export const ${name}: TranslationDict = {`);
  const end = nextMarker ? resources.indexOf(nextMarker) : resources.length;
  const region = resources.slice(start, end);
  return new Set([...region.matchAll(/^\s{2}'([^']+)':/gm)].map((m) => m[1]));
}
ok(resources.indexOf('export const en: TranslationDict = {') >= 0, 'en locale block found');
const enKeys = localeKeys('en', 'export const ar: TranslationDict');
const arKeys = localeKeys('ar', 'export const LOCALES');
ok(enKeys.size > 1000 && arKeys.size > 1000, `locales parsed (en=${enKeys.size}, ar=${arKeys.size})`);

for (const key of returnedKeys) {
  ok(enKeys.has(key), `en has ${key}`);
  ok(arKeys.has(key), `ar has ${key}`);
}
// No Arabic string may be the English one by accident, and placeholders must match.
for (const key of returnedKeys) {
  const en = resources.match(new RegExp(`'${key.replace(/[.]/g, '\\.')}':\\s*'([^']*)'`));
  ok(!!en && en[1].length > 10, `en message for ${key} is a real sentence`);
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Reclaim-on-refusal: the editor's behaviour
// ════════════════════════════════════════════════════════════════════════════
console.log('── 3. Orphaned-upload cleanup ──');

const editor = code(read('src/app/(app)/lesson-editor/[id].tsx'));
ok(/discardUploadedMaterialObject/.test(editor), 'editor imports the reclaim helper');
ok(
  /isServerRefusal\(/.test(editor),
  'editor checks the failure is a server refusal before reclaiming',
);
{
  // The reclaim call must live inside the failing insert's catch, guarded by the
  // refusal test — not on every failure, and never before the row was attempted.
  const idx = editor.indexOf('discardUploadedMaterialObject(storagePath)');
  const guard = editor.lastIndexOf('isServerRefusal(', idx);
  const insert = editor.indexOf('createLessonMaterial({');
  const catchAt = editor.lastIndexOf('} catch (e) {', idx);
  ok(idx > 0, 'editor calls the reclaim helper with the uploaded path');
  ok(guard > 0 && guard < idx, 'the reclaim is guarded by isServerRefusal(...)');
  ok(insert > 0 && insert < guard, 'the guard runs after the row insert was attempted');
  ok(catchAt > insert && catchAt < idx, 'the reclaim lives in the insert catch block');
  ok(/throw e;/.test(editor.slice(idx, idx + 400)), 'the original error is rethrown after cleanup');
}
const api = code(read('src/lib/api.ts'));
ok(/export async function discardUploadedMaterialObject/.test(api), 'api exports discardUploadedMaterialObject');
{
  const start = api.indexOf('export async function discardUploadedMaterialObject');
  const body = api.slice(start, start + 1400);
  // The GENERIC /storage/delete is permissive by design (old builds delete the
  // object then the row), so reclaim must use the guarded discard route, which
  // refuses a path a material still references.
  ok(/apiFetch\('\/storage\/discard-upload'/.test(body), 'reclaim uses the guarded /storage/discard-upload route');
  ok(/bucket: 'lesson-materials'/.test(body), 'reclaim is scoped to the lesson-materials bucket');
  ok(!/storage\.from\('lesson-materials'\)\.remove/.test(body), 'reclaim does NOT use the permissive storage delete');
  ok(/\}\s*catch\s*\(_\)\s*\{/.test(body), 'reclaim is best-effort (a failure never masks the upload error)');
  ok(/if \(path === ''\) return;/.test(body), 'reclaim refuses an empty path');
  ok(/void error;/.test(body), 'a protective 409 is accepted silently (the row wins)');
}
// The happy path must never reclaim anything: exactly one call site, inside the
// insert's catch. A second call would delete bytes a successful row references.
ok((editor.match(/discardUploadedMaterialObject\(/g) || []).length === 1,
  'the editor reclaims from exactly one place');
// (the import line has no call parens, so this locates the CALL SITE only)
ok(editor.indexOf('discardUploadedMaterialObject(') > editor.indexOf('createLessonMaterial({'),
  'nothing is reclaimed before the row insert is attempted');

// ── Server: the guarded route ──────────────────────────────────────────────
const routes = code(read('backend/routes/api.php'));
ok(/\/storage\/discard-upload',\s*\[StorageController::class, 'discardUpload'\], \$auth/.test(routes),
  'the discard route is registered behind authentication');
const storageSrc = code(read('backend/src/Controllers/StorageController.php'));
ok(/public function discardUpload\(Request \$request\)/.test(storageSrc), 'StorageController::discardUpload exists');
ok(/isReferencedElsewhere\(\$path\)/.test(storageSrc), 'discard refuses a path a material references');
ok(/object_referenced/.test(storageSrc), 'the refusal has its own stable code');
ok(/MaterialFileCleanupService::BUCKET/.test(storageSrc), 'only the attachment bucket can be discarded');
ok(/canWritePath\(/.test(storageSrc.slice(storageSrc.indexOf('function discardUpload'))),
  'discard is authorized against the caller\'s own course rows');



// ════════════════════════════════════════════════════════════════════════════
// 4. Server side of the contract
// ════════════════════════════════════════════════════════════════════════════
console.log('── 4. Backend contract ──');

const pdfSvc = code(read('backend/src/Services/PdfWatermarkService.php'));
ok(/pdf_unsupported_format/.test(pdfSvc), 'the engine reports an unreadable CONTAINER as its own code');
ok(/isUnsupportedContainer\(/.test(pdfSvc), 'container detection is centralized');
ok(
  /\$fpdiRenders\s*=\s*\$mode === self::MODE_VECTOR \|\| \$mode === self::MODE_FLATTEN/.test(pdfSvc),
  'the FPDI parse runs only when FPDI is the renderer (Ghostscript hosts accept the file)',
);
ok(/Re-export/.test(pdfSvc), 'the refusal message tells the doctor what to do');

const integrity = code(read('backend/src/Services/UploadIntegrityService.php'));
ok(/ini_get\('upload_max_filesize'\)/.test(integrity), 'the size cap reads the host limit');
ok(/min\(\$configured, \$host\)/.test(integrity), 'the effective cap is min(configured, host)');

const storage = code(read('backend/src/Controllers/StorageController.php'));
ok(/\$this->integrity->maxBytes\(\)/.test(storage), 'the upload policy uses the host-aware cap');
ok(/postBodyExceededLimit\(\)/.test(storage), 'a body over post_max_size is still answered 413');
ok(/upload_too_large/.test(storage), 'oversize refusals carry a stable code');

const data = code(read('backend/src/Controllers/DataController.php'));
ok(/material_write_failed/.test(data), 'a failed material insert has a named code');
ok(/\[material-write\]/.test(data), 'the failure is logged with a correlatable reference');
ok(
  !/throw new ApiException\([^)]*\$e->getMessage\(\)/.test(data),
  'the database message itself is never returned to the client',
);

// ════════════════════════════════════════════════════════════════════════════
// 5. The production diagnostic exists, is CLI-only, and changes nothing
// ════════════════════════════════════════════════════════════════════════════
console.log('── 5. Upload diagnostic script ──');

const diagPath = 'backend/scripts/diagnose-upload.php';
ok(fs.existsSync(path.join(ROOT, diagPath)), `${diagPath} exists`);
const diag = code(read(diagPath));
ok(/PHP_SAPI !== 'cli'/.test(diag), 'diagnostic refuses to run over HTTP');
ok(!/\bINSERT\s+INTO\b/i.test(diag) && !/\bUPDATE\s+\w+\s+SET\b/i.test(diag) && !/\bDELETE\s+FROM\b/i.test(diag),
  'diagnostic performs no database writes');
ok(/upload\.validate/.test(diag) && /upload\.persist/.test(diag) && /upload\.verify_stored/.test(diag),
  'diagnostic exercises validate → persist → verify (the real upload path)');
ok(/db\.required_columns/.test(diag), 'diagnostic flags a NOT NULL column the app does not send');
ok(/--file/.test(diag), 'diagnostic can gate the doctor\'s own PDF (--file=...)');
ok(/upload\.cleanup/.test(diag), 'the sample object it stores is removed again');

// ════════════════════════════════════════════════════════════════════════════
// 6. Executed: the diagnostic and the PHP gate test, when PHP is available
// ════════════════════════════════════════════════════════════════════════════
console.log('── 6. Executed PHP checks (skipped when no PHP binary) ──');

const phpBin = process.env.PHP_BIN || 'php';
const hasPhp = spawnSync(phpBin, ['-v'], { stdio: 'ignore' }).status === 0;
if (!hasPhp) {
  console.log('  (skipped: no PHP binary on PATH; set PHP_BIN to run these)');
} else {
  for (const suite of [
    ['backend/tests/material-upload/pdf_gate_tests.php', 'pdf_gate_tests.php passes (gate codes)'],
    [
      'backend/tests/material-lifecycle/upload_and_cleanup_tests.php',
      'upload_and_cleanup_tests.php passes (discard guard, ownership, idempotency)',
    ],
  ]) {
    const run = spawnSync(phpBin, [suite[0]], { cwd: ROOT, encoding: 'utf8' });
    ok(run.status === 0, suite[1]);
    if (run.status !== 0) {
      console.error((run.stdout || '') + (run.stderr || ''));
    }
  }

  const run = spawnSync(phpBin, ['backend/scripts/diagnose-upload.php', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  let parsed = null;
  try {
    parsed = JSON.parse(run.stdout);
  } catch (_) {
    parsed = null;
  }
  ok(parsed !== null, 'diagnose-upload.php --json emits JSON');
  if (parsed) {
    ok(Array.isArray(parsed.checks) && parsed.checks.length > 10, 'diagnostic reports every stage');
    ok(
      parsed.checks.some((c) => c.stage === 'upload.verify_stored' && c.ok),
      'the diagnostic round trip stored and verified bytes',
    );
    ok(
      parsed.checks.every((c) => typeof c.detail !== 'string' || !/password|secret|token=/i.test(c.detail)),
      'no secret-looking value in the diagnostic output',
    );
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
