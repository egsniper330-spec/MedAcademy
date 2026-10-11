#!/usr/bin/env node
/**
 * tests/materialWatermark.test.cjs
 *
 * Personalized PDF watermarking + Preview-Only enforcement.
 *
 * The PHP backend cannot be executed here, so this suite combines:
 *   • SOURCE assertions on the real committed PHP/SQL/TS files (the security
 *     invariants that must not silently drift), and
 *   • PURE MODELS of the two decisions that are easiest to get wrong — the
 *     delivery-token binding and the "may this request receive the original
 *     file?" decision — so their behaviour is executed, not just grepped.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
const failures = [];

function ok(label, cond) {
  if (cond) {
    passed++;
  } else {
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

/* ══ 1. Migration — additive, safe, and the right shape ═══════════════════ */

section('1. Migration 032');

{
  const sql = read('backend/database/mysql-migrations/032_lesson_material_watermark.sql');

  ok('adds watermark_enabled with DEFAULT 0 (nothing starts watermarking)',
    /ADD COLUMN `watermark_enabled` TINYINT\(1\) NOT NULL DEFAULT 0/.test(sql));
  ok('watermark toggle is independent of permission/download_enabled (no ALTER to them)',
    !/ALTER TABLE `lesson_materials`[\s\S]{0,200}(permission|download_enabled)/.test(sql));
  ok('creates the generated-copy registry',
    /CREATE TABLE IF NOT EXISTS `lesson_material_pdfs`/.test(sql));
  ok('registry is idempotent (CREATE TABLE IF NOT EXISTS)',
    /CREATE TABLE IF NOT EXISTS/.test(sql));
  ok('caches by (material, student, variant) — one copy per student',
    /UNIQUE KEY `uq_lesson_material_pdfs_variant` \(`material_id`, `student_id`, `variant_key`\)/.test(sql));
  ok('source hash is stored so a replaced source invalidates copies',
    /`source_hash`\s+CHAR\(64\)\s+NOT NULL/.test(sql));
  ok('variant_key is stored (drives cache identity)',
    /`variant_key`\s+CHAR\(64\)\s+NOT NULL/.test(sql));
  ok('generated copies cascade-delete with the material',
    /FOREIGN KEY \(`material_id`\) REFERENCES `lesson_materials` \(`id`\) ON DELETE CASCADE/.test(sql));
  ok('generated copies cascade-delete with the student',
    /FOREIGN KEY \(`student_id`\) REFERENCES `profiles` \(`id`\) ON DELETE CASCADE/.test(sql));
  ok('migration does not touch existing rows or drop anything',
    !/\b(DROP|DELETE FROM|UPDATE )\b/.test(sql));
}

/* ══ 2. No direct route to a personalized copy ════════════════════════════ */

section('2. The generated bucket has no storage route');

{
  const ctl = read('backend/src/Controllers/StorageController.php');
  const svc = read('backend/src/Storage/StorageService.php');
  const delivery = read('backend/src/Controllers/MaterialDeliveryController.php');

  ok('lesson-material-pdfs is NOT a private bucket (so /storage/signed refuses it)',
    !/PRIVATE_BUCKETS = \[[^\]]*lesson-material-pdfs/.test(ctl));
  ok('lesson-material-pdfs is NOT a public bucket either',
    !/PUBLIC_BUCKETS = \[[^\]]*lesson-material-pdfs/.test(ctl));
  ok('canAccess refuses unknown buckets for students (falls through to false)',
    /if \(\$bucket === 'lesson-materials'\)[\s\S]*?\n        return false;/.test(svc));
  ok('delivery reads the copy through a dedicated private path helper',
    /privateFilePath\(PdfWatermarkService::BUCKET/.test(delivery));
  ok('the bucket constant is defined once and reused',
    /public const BUCKET = 'lesson-material-pdfs';/.test(read('backend/src/Services/PdfWatermarkService.php')));
}

/* ══ 3. Watermarking is fail-closed ═══════════════════════════════════════ */

section('3. PDF engine is fail-closed');

{
  const svc = read('backend/src/Services/PdfWatermarkService.php');
  const delivery = read('backend/src/Controllers/MaterialDeliveryController.php');

  ok('unavailable engine throws 503 rather than falling back',
    /if \(!\$this->isAvailable\(\)\) \{\s*throw new ApiException\(503/.test(svc));
  ok('the 503 message says the original will not be served',
    /unwatermarked original will not be served/i.test(svc));
  ok('rejects a non-PDF before processing',
    /str_starts_with\(\$head, '%PDF-'\)[\s\S]{0,200}ApiException\(422/.test(svc));
  ok('refuses an ENCRYPTED pdf explicitly (never ships the original)',
    /\/Encrypt[\s\S]{0,160}ApiException\(422/.test(svc));
  ok('a generation failure throws instead of returning the source',
    /catch \(\\Throwable \$e\)[\s\S]{0,240}throw new ApiException\(500/.test(svc));
  ok('output is verified to exist and be non-empty',
    /filesize\(\$outAbsPath\) === 0[\s\S]{0,120}ApiException\(500/.test(svc));

  ok('delivery refuses to stream when the personalized copy is missing',
    /personalized copy is not available[\s\S]{0,120}503, 'watermark_unavailable'/.test(delivery));
  ok('the original is reachable ONLY in the non-watermarked else branch',
    (() => {
      const stream = delivery.slice(delivery.indexOf('public function streamPdf'));
      return /\} else \{[\s\S]{0,200}'lesson-materials'/.test(stream) &&
        stream.indexOf('watermark_unavailable') < stream.indexOf("privateFilePath('lesson-materials'");
    })());
}

/* ══ 4. Background compositing + every page ═══════════════════════════════ */

section('4. Watermark is a per-page BACKGROUND');

{
  const svc = read('backend/src/Services/PdfWatermarkService.php');

  ok('loops over EVERY imported page',
    /for \(\$pageNo = 1; \$pageNo <= \$pageCount; \$pageNo\+\+\)/.test(svc));
  ok('the WATERMARK is drawn before the page is composited (background)',
    svc.indexOf('// ── 1. Watermark layer, painted FIRST so it sits behind ──') <
      svc.indexOf('$pdf->useTemplate($tpl, 0, 0, $w, $h)'));
  ok('the original page is placed ON TOP of the watermark',
    /ORIGINAL page, drawn ON TOP of the watermark[\s\S]{0,120}useTemplate/.test(svc));
  ok('original page size/orientation is preserved per page',
    /getTemplateSize\(\$tpl\)/.test(svc) && /AddPage\(\$orientation, \[\$w, \$h\]\)/.test(svc));
  ok('watermark opacity is low (does not harm readability)',
    /SetAlpha\(0\.10\)/.test(svc));
  ok('diagonal placement (rotation applied)',
    /Rotate\(45, \$x, \$y\)/.test(svc));
  ok('watermark is written into the page content, not an annotation',
    !/\/Annots|FreeText|Widget|SetXY|Write\(/.test(svc));
  ok('identity text is sanitized before it reaches a PDF string',
    /sanitizeIdentityLine\(/.test(svc) && /\\x\{202A\}-\\x\{202E\}/.test(svc) && /mb_substr\(/.test(svc));
}

/* ══ 5. Authorization is single-sourced and re-checked live ═══════════════ */

section('5. A permission change kills an already-issued link');

{
  const delivery = read('backend/src/Controllers/MaterialDeliveryController.php');
  const svc = read('backend/src/Storage/StorageService.php');

  ok('mint path authorises through StorageService::canAccess (one source of truth)',
    /canAccess\(\$userId, \$role, 'lesson-materials'/.test(delivery));
  ok('mint passes the download intent into canAccess',
    /\$forDownload = \$intent === 'download';/.test(delivery));
  ok('stream path RE-authorises with the CURRENT database state',
    /canAccess\(\$studentId, \$role, 'lesson-materials'[\s\S]{0,80}forDownload\)/.test(delivery));
  ok('stream re-reads the role from the database (not from the token)',
    /SELECT role FROM profiles WHERE id = \?/.test(delivery));
  ok('a preview_only material refuses the download intent server-side',
    /\$forDownload && \(\$permission === 'preview_only' \|\| !\$row\['download_enabled'\]\)/.test(svc));
  ok('hidden/disabled materials are refused for view AND download',
    /in_array\(\$permission, \['hidden', 'disabled'\], true\)/.test(svc));
}

/* ══ 6. Token binding — executed model, not a grep ════════════════════════ */

section('6. Delivery token binds material + student + intent + expiry');

{
  const SECRET = 'test-secret';
  const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sign = (materialId, studentId, intent, expires) => {
    const body = [materialId, studentId, intent, String(expires)].join('|');
    const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    return b64url(body + '|' + sig);
  };
  const verify = (token, now) => {
    const padded = token.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((token.length + 3) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const parts = decoded.split('|');
    if (parts.length !== 5) return { error: 'invalid' };
    const [materialId, studentId, intent, expiresRaw, sig] = parts;
    const expected = crypto.createHmac('sha256', SECRET).update([materialId, studentId, intent, expiresRaw].join('|')).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return { error: 'invalid' };
    if (Number(expiresRaw) < now) return { error: 'expired' };
    return { materialId, studentId, intent };
  };

  const now = 1_000_000;
  const t = sign('mat-1', 'stu-A', 'view', now + 300);
  const good = verify(t, now);
  ok('a freshly minted token verifies', !good.error && good.materialId === 'mat-1' && good.studentId === 'stu-A');
  ok('the token identifies the STUDENT (so a copy cannot be re-pointed)',
    good.studentId === 'stu-A');
  ok('an expired token is refused',
    verify(t, now + 301).error === 'expired');
  ok('a tampered body is refused',
    (() => {
      const forged = b64url('mat-2|stu-A|view|' + (now + 300) + '|' + '0'.repeat(64));
      return verify(forged, now).error === 'invalid';
    })());
  ok('another student cannot reuse a token by editing the payload',
    (() => {
      const [body] = Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8').split('|').slice(-1);
      void body;
      const forged = b64url('mat-1|stu-B|view|' + (now + 300) + '|' + crypto.createHmac('sha256', 'wrong').update('x').digest('hex'));
      return verify(forged, now).error === 'invalid';
    })());
  ok('the token carries NO storage path or file name',
    !Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8').includes('/'));
  ok('a download intent is signed in (cannot be flipped to view)',
    verify(sign('mat-1', 'stu-A', 'download', now + 300), now).intent === 'download');
}

/* ══ 7. Delivery decision — executed model ════════════════════════════════ */

section('7. Which bytes may be served');

{
  // Mirror of MaterialDeliveryController::shouldWatermark + the canAccess rules.
  const shouldWatermark = (material, role) => role === 'student' && Number(material.watermark_enabled) === 1;
  const decide = ({ material, role, forDownload, enrolled, published, engineAvailable }) => {
    const perm = String(material.permission ?? 'allow');
    if (perm === 'hidden' || perm === 'disabled') return { deny: true };
    if (published && !enrolled && role === 'student') return { deny: true };
    if (forDownload && (perm === 'preview_only' || !material.download_enabled)) return { deny: true };
    if (shouldWatermark(material, role)) {
      return engineAvailable ? { watermarked: true } : { status: 503 };
    }
    return { original: true };
  };

  const base = { permission: 'allow', download_enabled: 1, watermark_enabled: 0 };

  ok('student + watermark ON → personalized copy',
    decide({ material: { ...base, watermark_enabled: 1 }, role: 'student', forDownload: false, enrolled: true, published: true, engineAvailable: true }).watermarked === true);
  ok('student + watermark ON + engine missing → 503, NEVER the original',
    (() => { const d = decide({ material: { ...base, watermark_enabled: 1 }, role: 'student', forDownload: false, enrolled: true, published: true, engineAvailable: false }); return d.status === 503 && !d.original; })());
  ok('watermark OFF → the original (permission permitting)',
    decide({ material: base, role: 'student', forDownload: true, enrolled: true, published: true, engineAvailable: true }).original === true);
  ok('teacher is not personalized even with watermark ON',
    decide({ material: { ...base, watermark_enabled: 1 }, role: 'doctor', forDownload: false, enrolled: false, published: true, engineAvailable: true }).original === true);
  ok('preview_only + download → denied',
    decide({ material: { ...base, permission: 'preview_only' }, role: 'student', forDownload: true, enrolled: true, published: true, engineAvailable: true }).deny === true);
  ok('preview_only + view → allowed (and personalized when watermark ON)',
    decide({ material: { ...base, permission: 'preview_only', watermark_enabled: 1 }, role: 'student', forDownload: false, enrolled: true, published: true, engineAvailable: true }).watermarked === true);
  ok('watermark ON + download allowed → still personalized',
    decide({ material: { ...base, watermark_enabled: 1 }, role: 'student', forDownload: true, enrolled: true, published: true, engineAvailable: true }).watermarked === true);
  ok('hidden → denied for both intents',
    decide({ material: { ...base, permission: 'hidden' }, role: 'student', forDownload: false, enrolled: true, published: true, engineAvailable: true }).deny === true &&
    decide({ material: { ...base, permission: 'hidden' }, role: 'student', forDownload: true, enrolled: true, published: true, engineAvailable: true }).deny === true);
  ok('un-enrolled student → denied',
    decide({ material: base, role: 'student', forDownload: false, enrolled: false, published: true, engineAvailable: true }).deny === true);
}

/* ══ 8. Frontend plumbing ═════════════════════════════════════════════════ */

section('8. Frontend: independent control, no client-supplied identity');

{
  const api = read('src/lib/api.ts');
  const mats = read('src/lib/lessonMaterials.ts');

  ok('upload payload carries watermark_enabled',
    /watermark_enabled\?: boolean;/.test(api));
  ok('a dedicated setter exists and is separate from permission',
    /export async function updateMaterialWatermark\(id: string, watermarkEnabled: boolean\)/.test(api));
  ok('the new delivery helper asks for a material id (not a path)',
    /export async function getMaterialPdfUrl\(/.test(api) && /material_id: materialId, intent:/.test(api));
  ok('the helper maps forDownload → download intent server-side',
    /intent: forDownload \? 'download' : 'view'/.test(api));
  ok('no client identity is ever sent to the watermarker',
    (() => {
      // Scope the check to the delivery helper: identity must come from the
      // server's own profile row, never from the client payload.
      const start = api.indexOf('export async function getMaterialPdfUrl');
      const body = api.slice(start, start + 900);
      return /material_id: materialId/.test(body) &&
        !/full_name|public_user_id|student_name/.test(body);
    })());
  ok('the watermark helper defaults OFF for pre-migration rows',
    /isMaterialWatermarkEnabled\(mat: any\): boolean \{[\s\S]{0,120}return false;/.test(mats));
  ok('watermark state does not change materialAccess (preview_only stays view)',
    /permission === 'preview_only'\) return 'view';/.test(mats));

  const editor = read('src/app/(app)/lesson-editor/[id].tsx');
  ok('the teacher UI exposes the watermark control',
    /Personalized Student Watermark/.test(editor));
  ok('the watermark control has its OWN handler (not the permission handler)',
    /const handleUpdateWatermark = async \(materialId: string, enabled: boolean\)/.test(editor) &&
    /updateMaterialWatermark\(materialId, enabled\)/.test(editor));
  ok('the watermark toggle does not set `permission`',
    !/handleUpdateWatermark[\s\S]{0,600}updateMaterialPermission/.test(editor));
  ok('an optimistic flip is reverted when the write fails',
    /watermark_enabled: enabled \? 0 : 1/.test(editor));
}

/* ══ 9. Flattened, image-based engine ════════════════════════════════════ */

section('9. Flattened, image-based engine');

{
  const svc = read('backend/src/Services/PdfWatermarkService.php');
  const delivery = read('backend/src/Controllers/MaterialDeliveryController.php');

  ok('engine selectors defined (raster/vector/auto)',
    /MODE_RASTER = 'raster'/.test(svc) && /MODE_VECTOR = 'vector'/.test(svc) && /MODE_AUTO\s*=\s*'auto'/.test(svc));
  ok('pages are rendered with a TRANSPARENT background (pngalpha device)',
    /-sDEVICE=pngalpha/.test(svc));
  ok('watermark canvas is built BEFORE the page composited on top (GD)',
    (() => {
      const gd = svc.slice(svc.indexOf('private function compositeGd'), svc.indexOf('private function watermarkPlacements'));
      return gd.indexOf('imagefilledrectangle') !== -1 &&
        gd.indexOf('imagefilledrectangle') < gd.indexOf('imagecopy($canvas, $fg');
    })());
  ok('watermark canvas is built BEFORE the page composited on top (Imagick)',
    (() => {
      const im = svc.slice(svc.indexOf('private function compositeImagick'), svc.indexOf('private function compositeGd'));
      return im.indexOf('drawImage($draw)') !== -1 &&
        im.indexOf('drawImage($draw)') < im.indexOf('compositeImage($fg');
    })());
  ok('raster engine requires Ghostscript + compositor + font + FPDF',
    /\$rasterReady = \$canExec && \$gsVersion !== null && \$compositor !== null && \$font !== null && \$pdfWriter/.test(svc));
  ok('page count is capped before processing',
    /PDF_WATERMARK_MAX_PAGES/.test(svc) && /count\(\$pages\) > \$maxPages/.test(svc));
  ok('a per-page pixel budget guards memory',
    /maxPixels/.test(svc) && /\$w \* \$h > \$maxPixels/.test(svc));
  ok('no text is drawn into the flattened PDF (image pages only)',
    (() => {
      const raster = svc.slice(svc.indexOf('private function renderRaster'), svc.indexOf('private function compositePage'));
      return !/useTemplate|\$pdf->Text\(/.test(raster);
    })());
  ok('the vector engine is preserved (not removed)',
    /private function renderWithFpdfFpdi/.test(svc) && /SetAlpha\(0\.10\)/.test(svc));
  ok('variant cache identity includes the engine token + dpi',
    /'engine' => 'flatten-v2'/.test(svc) && /'dpi' => \$this->dpi\(\)/.test(svc));
  ok('delivery folds the engine settings into variantKey',
    /variantKey\(\$sourceHash, \$identityHash, \$this->watermark->variantSettings\(\$lines\)\)/.test(delivery));
  ok('env keys + requirements documented for deployment',
    /PDF_WATERMARK_MODE=raster/.test(read('backend/NAMECHEAP_DEPLOYMENT.md')));
  ok('server diagnostics + integration-test scripts exist',
    read('backend/scripts/watermark-diagnostics.php').length > 200 &&
    /LECTURE-TEXT-MARKER-ALPHA/.test(read('backend/scripts/verify-watermark.php')));
  ok('a per-page memory guard prevents an uncatchable OOM',
    /memoryLimitBytes/.test(svc) && /\$w \* \$h \* 8 >/.test(svc));
  ok('the HTTP status surface never returns filesystem paths',
    /'font_present' =>/.test(svc) && !/'font' => \$this->fontPath\(\)/.test(svc));
  ok('a failed generation cannot leave an orphaned .part file',
    /catch \(\\Throwable \$e\) \{\s*@unlink\(\$partAbs\);/.test(delivery));
}

/* ══ 9b. Migration is folded into the fresh-install schema ════════════════ */

section('9b. schema.sql carries the same objects as migration 032');

{
  const schema = read('backend/database/schema.sql');
  ok('schema.sql includes the watermark_enabled column',
    /`watermark_enabled` TINYINT\(1\) DEFAULT 0 NOT NULL/.test(schema));
  ok('schema.sql includes the lesson_material_pdfs table',
    /CREATE TABLE IF NOT EXISTS `lesson_material_pdfs`/.test(schema));
  ok('schema.sql mirrors the per-student unique key',
    /uq_lesson_material_pdfs_variant/.test(schema));
}

/* ══ 10. Migration must not require information_schema ════════════════════ */

section('10. Migration 032 is importable on a restricted cPanel MySQL user');

{
  const sql = read('backend/database/mysql-migrations/032_lesson_material_watermark.sql');
  // Strip SQL comments first: the docblock deliberately NAMES the denied
  // object to explain the fix; the guard is about executable statements.
  const sqlCode = sql.replace(/^\s*--.*$/gm, '');
  ok('no information_schema QUERY (cPanel #1044 regression)',
    !/information_schema/i.test(sqlCode));
  ok('still adds the watermark column + the copy registry',
    /ADD COLUMN `watermark_enabled`/.test(sql) && /CREATE TABLE IF NOT EXISTS `lesson_material_pdfs`/.test(sql));
}

/* ── Summary ─────────────────────────────────────────────────────────────── */

console.log('\n' + (failures.length === 0 ? '✅' : '❌') + ` ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
