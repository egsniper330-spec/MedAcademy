#!/usr/bin/env node
/**
 * tests/materialWatermark.test.cjs
 *
 * Personalized PDF watermarking — MANDATORY policy.
 *
 * The PHP backend cannot be executed from this suite, so it combines:
 *   • SOURCE assertions on the real committed PHP/SQL/TS files (the security
 *     invariants that must not silently drift), and
 *   • PURE MODELS of the decisions that are easiest to get wrong — the delivery
 *     decision, the delivery-token binding, and the "which control do I get?"
 *     mapping — so their behaviour is executed, not just grepped.
 *
 * The policy under test: a STUDENT always receives a personalized copy; a doctor
 * can never disable it; a PDF original is reachable only through the token-gated
 * delivery endpoint.
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

/* ══ 1. Migrations — additive, safe, and the right shape ══════════════════ */

section('1. Migrations 032 + 035');

{
  const sql = read('backend/database/mysql-migrations/032_lesson_material_watermark.sql');
  const hard = read('backend/database/mysql-migrations/035_lesson_material_pdf_hardening.sql');

  ok('032 creates the generated-copy registry',
    /CREATE TABLE IF NOT EXISTS `lesson_material_pdfs`/.test(sql));
  ok('032 caches by (material, student, variant) — one copy per student',
    /UNIQUE KEY `uq_lesson_material_pdfs_variant` \(`material_id`, `student_id`, `variant_key`\)/.test(sql));
  ok('032 stores the source hash so a replaced source invalidates copies',
    /`source_hash`\s+CHAR\(64\)\s+NOT NULL/.test(sql));
  ok('032 cascade-deletes copies with the material',
    /FOREIGN KEY \(`material_id`\) REFERENCES `lesson_materials` \(`id`\) ON DELETE CASCADE/.test(sql));

  ok('035 adds the cached source hash columns',
    /ADD COLUMN `file_hash` CHAR\(64\) NULL/.test(hard) &&
    /ADD COLUMN `file_hash_path` TEXT NULL/.test(hard) &&
    /ADD COLUMN `file_hash_size` BIGINT NULL/.test(hard));
  ok('035 is additive — it never DROPs or rewrites data',
    !/\b(DROP COLUMN|DELETE FROM|TRUNCATE|UPDATE `?lesson_materials`? SET)\b/.test(hard));
  ok('035 does NOT drop the legacy watermark_enabled column',
    !/DROP COLUMN `watermark_enabled`/.test(hard));
  ok('035 registers the two delivery audit actions',
    /'material_pdf_delivered'/.test(hard) && /'material_pdf_failed'/.test(hard));
  ok('035 re-adds the audit CHECK as a SUPERSET of 031 (no action is lost)',
    (() => {
      const list = (t) => new Set((t.match(/CHECK \(`action` IN \(([^)]*)\)\)/) || [, ''])[1]
        .match(/'([^']+)'/g)?.map((s) => s.slice(1, -1)) || []);
      const m31 = list(read('backend/database/mysql-migrations/031_audit_actions_security_vdocipher.sql'));
      const m35 = list(hard);
      return m31.size > 100 && [...m31].every((a) => m35.has(a));
    })());
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

/* ══ 3. Lesson-material PDFs cannot bypass the delivery endpoint ═══════════ */

section('3. A student cannot obtain the ORIGINAL through storage');

{
  const ctl = read('backend/src/Controllers/StorageController.php');

  ok('signed-URL minting refuses lesson-material PDFs',
    /if \(\$this->isLessonMaterialPdf\(\$bucket, \$normalised\)\) \{[\s\S]{0,200}material_delivery_required/.test(ctl));
  ok('the refusal happens BEFORE a signed URL is returned',
    ctl.indexOf('isLessonMaterialPdf($bucket, $normalised)') <
      ctl.indexOf('return [\'signed_url\' => $this->storage->signedUrl('));
  ok('redemption refuses them too (a stale link dies immediately)',
    /if \(\$this->isLessonMaterialPdf\(\$bucket, \$path\)\) \{[\s\S]{0,200}material_delivery_required/.test(ctl));
  ok('the redemption refusal precedes the signature check',
    ctl.indexOf('isLessonMaterialPdf($bucket, $path)') < ctl.indexOf('hash_equals($expected, $sig)'));
  ok('PDF detection is bucket-scoped (other buckets unaffected)',
    /if \(\$bucket !== 'lesson-materials'\) \{\s*return false;/.test(ctl));
  ok('PDF detection also consults the stored file_type (extension may be absent)',
    /SELECT file_type FROM lesson_materials WHERE storage_path = \?/.test(ctl));
  ok('non-PDF attachments keep the existing signed-URL flow',
    !/isLessonMaterialPdf[\s\S]{0,400}(\.docx|\.zip|BLOCKED_UPLOAD_EXTENSIONS)/.test(ctl));

  // ── The legacy `lesson_pdfs` bucket ─────────────────────────────────────
  // It used to be readable by ANY authenticated user. Those objects can never
  // be personalized (there is no lesson_materials row to key a copy on), so
  // leaving it open was a way to obtain an unwatermarked student PDF.
  const storage = read('backend/src/Storage/StorageService.php');
  ok('the legacy lesson-pdfs bucket no longer authorises students',
    /if \(\$bucket === 'lesson-pdfs'\) \{[\s\S]{0,900}?return false;/.test(storage));
  ok('staff keep the legacy bucket (canAccess returns true before the bucket checks)', (() => {
    const guard = storage.indexOf("if (in_array($role, ['doctor', 'admin', 'super_admin'], true))");
    const legacy = storage.indexOf("if ($bucket === 'lesson-pdfs')");
    return guard !== -1 && legacy !== -1 && guard < legacy;
  })());
  ok('minting a legacy lecture note for a student is refused with a clear code',
    /\$bucket === 'lesson-pdfs' && !in_array\(\(string\) \$request->user\['role'\], \['doctor', 'admin', 'super_admin'\], true\)[\s\S]{0,300}material_delivery_required/.test(ctl));
  ok('that refusal precedes the generic authorisation branch',
    ctl.indexOf("$bucket === 'lesson-pdfs' &&") < ctl.indexOf('canAccess($request->user[\'id\']'));

  // Executed model of the two storage decisions.
  const legacyAllowed = (role, bucket) => {
    if (['doctor', 'admin', 'super_admin'].includes(role)) return true;
    return bucket !== 'lesson-pdfs' && bucket !== 'lesson-materials';
  };
  ok('model: student + lesson-pdfs → refused', legacyAllowed('student', 'lesson-pdfs') === false);
  ok('model: student + lesson-materials → refused here too (delivery endpoint only)',
    legacyAllowed('student', 'lesson-materials') === false);
  ok('model: student + avatars → unaffected', legacyAllowed('student', 'avatars') === true);
  ok('model: doctor + lesson-pdfs → allowed', legacyAllowed('doctor', 'lesson-pdfs') === true);
  ok('model: admin + lesson-pdfs → allowed', legacyAllowed('admin', 'lesson-pdfs') === true);
}

/* ══ 4. Watermarking is fail-closed ═══════════════════════════════════════ */

section('4. The PDF engine is fail-closed');

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
    /catch \(\\Throwable \$e\)[\s\S]{0,900}throw new ApiException\(\s*500/.test(svc));
  // Every refusal names its STAGE, so a live delivery failure can be located
  // from the API code instead of the generic "could not be prepared" message.
  ok('generation failures carry a stage code and the real cause',
    /'render_failed',\s*\$e\s*\)/.test(svc) &&
    /get_class\(\$e\)[\s\S]{0,40}\$e->getMessage\(\)/.test(svc));
  ok('the engine-missing refusal carries a stage code',
    /ApiException\(503,[\s\S]{0,400}'engine_unavailable'\)/.test(svc));
  ok('output is verified to exist and be non-empty',
    /filesize\(\$outAbsPath\) === 0[\s\S]{0,120}ApiException\(500/.test(svc));
  ok('an oversized source is refused before parsing',
    /maxSourceBytes\(\)[\s\S]{0,200}ApiException\([\s\S]{0,120}422/.test(svc));

  ok('delivery refuses to stream when the personalized copy is missing',
    /personalized copy is not available[\s\S]{0,120}503, 'watermark_unavailable'/.test(delivery));
  ok('the original is reachable ONLY in the staff branch',
    (() => {
      const stream = delivery.slice(delivery.indexOf('public function streamPdf'));
      return /\} else \{[\s\S]{0,200}'lesson-materials'/.test(stream) &&
        stream.indexOf('watermark_unavailable') < stream.indexOf("privateFilePath('lesson-materials'");
    })());
  // A coded ApiException used to reach the client as the generic 'api_error',
  // so 'engine_unavailable' / 'watermark_busy' / 'pdf_parse' were
  // indistinguishable and the same message was shown for all of them.
  ok('a coded refusal surfaces its code to the client',
    /foreach \(\$e->errors as \$candidate\)[\s\S]{0,160}\$code = \$candidate;/.test(
      read('backend/src/Middleware/ErrorHandler.php')));
  ok('an operator can name the failing stage on the server',
    fs.existsSync(path.join(ROOT, 'backend/scripts/diagnose-pdf-delivery.php')) &&
    /STOPPED at stage/.test(read('backend/scripts/diagnose-pdf-delivery.php')));

  ok('a generation failure is audited (with its stage) and the request still fails',
    /auditFailure\(\$material, \$userId, \$this->failureStage\(\$e\), \$e\);[\s\S]{0,40}throw \$e;/.test(delivery) &&
    /private function failureStage\(ApiException \$e\): string/.test(delivery) &&
    /'cause' => \$e\?->getPrevious\(\) !== null/.test(delivery));
}

/* ══ 5. Layered marks, identity from the server ══════════════════════════ */

section('5. Watermark geometry, layers and identity');

{
  const svc = read('backend/src/Services/PdfWatermarkService.php');
  const baker = read('backend/src/Services/PdfWatermarkBaker.php');
  const tplCall = '$pdf->useTemplate($tpl, 0, 0, $w, $h)';

  ok('loops over EVERY imported page (TCPDF engine)',
    /for \(\$pageNo = 1; \$pageNo <= \$pageCount; \$pageNo\+\+\)/.test(svc));
  // Scoped to the layered TCPDF renderer: the renderer-free `flatten` engine also
  // calls useTemplate(), and it appears earlier in the file, so a whole-file
  // index comparison would compare positions across two different engines.
  const tcpdfBody = svc.slice(
    svc.indexOf('private function renderWithTcpdfFpdi('),
    svc.indexOf('private function drawTcpdfBackLayer(')
  );
  ok('a BACK layer is drawn before the page is placed',
    tcpdfBody.indexOf('$this->drawTcpdfBackLayer(') > 0 &&
    tcpdfBody.indexOf('$this->drawTcpdfBackLayer(') < tcpdfBody.indexOf(tplCall));
  ok('a FRONT layer is drawn after the page, so it covers the lecture',
    svc.indexOf('$this->drawTcpdfFrontLayer(') > svc.indexOf(tplCall));
  ok('the identity rails are drawn after the page (always readable)',
    svc.indexOf('$this->drawTcpdfRails(') > svc.indexOf(tplCall));
  ok('an interior anchor is drawn after the page AND after the rails',
    svc.indexOf('$this->drawTcpdfAnchor(') > svc.indexOf('$this->drawTcpdfRails(') &&
    /private function drawTcpdfAnchor\(\\TCPDF/.test(svc));
  ok('the interior anchor is the dark layer (survives flatten + threshold + crop)',
    /setAlpha\(0\.85\)/.test(svc) && /self::VECTOR_ANCHOR_PT, 6\.5, 5\.5/.test(svc));
  ok('the interior anchor drops the "| MedAcademy" tail and falls back to the id',
    /explode\('\|', \$identity\)\[0\]/.test(svc) &&
    /str_contains\(\$identity, '\\u\{2022\}'\)/.test(svc));
  ok('a non-text trace lattice is part of every page',
    svc.indexOf('$this->drawTcpdfTraceLattice(') > svc.indexOf(tplCall) &&
    /function traceBits\(/.test(svc) && /function traceCode\(/.test(svc));
  ok('marks are BAKED inside each imported page stream (not one deletable block)',
    /new PdfWatermarkBaker\(\)\)->bake\(/.test(svc) && /private function appendToForm\(/.test(baker) &&
    /%MAC-WM-BAKED/.test(baker));
  ok('baking fails open to the layered marks, never to a clean page',
    /catch \(\\Throwable \$e\) \{\s*error_log\('\[pdf-watermark\] content bake failed/.test(svc));
  ok('every mark is measured and clamped inside the page (never clipped)',
    /private function fittedOrigin\(/.test(svc) &&
    /if \(\$px \+ \$minX < \$margin - 0\.02 \|\| \$px \+ \$maxX > \$w - \$margin \+ 0\.02/.test(svc));
  ok('placement is seeded per recipient and page (no fixed mask)',
    /private function pageSeed\(/.test(svc) && /hash\(\s*'sha256',\s*self::LAYERS_VERSION/s.test(svc));
  ok('front marks are a SEPARATE, lower-ceiling setting from the back grid',
    /function vectorOpacity\(\)/.test(svc) && /function vectorForegroundOpacity\(\)/.test(svc) &&
    /min\(0\.55, \$o\)/.test(svc));
  ok('diagonal placement (45° rotation applied)',
    /Rotate\(45, \$x, \$y\)/.test(svc));
  ok('back-grid opacity is low enough to keep the lecture readable',
    /return max\(0\.04, min\(0\.35, \$o\)\)/.test(svc));
  ok('an embedded Unicode face is used (no external font file needed)',
    /private const VECTOR_FONT = 'dejavusans'/.test(svc) && /setFontSubsetting\(true\)/.test(svc));
  ok('page size/orientation is preserved per page',
    /getTemplateSize\(\$tpl\)/.test(svc));
  ok('the mark is drawn as TEXT in the page content, not an annotation',
    !/\/Annots|FreeText|Widget/.test(svc));
  ok('identity text is sanitized (control chars + bidi overrides stripped)',
    /sanitizeIdentityLine\(/.test(svc) && /\\x\{202A\}-\\x\{202E\}/.test(svc) && /mb_substr\(/.test(svc));
  ok('a name that cannot be drawn falls back to the account id (never mojibake)',
    /private function renderableName/.test(svc) && /return '';/.test(svc) &&
    /\\x\{0590\}-\\x\{08FF\}/.test(svc));
  ok('the raster engine is preserved as an opt-in, not the default',
    /Config::string\('PDF_WATERMARK_MODE', self::MODE_AUTO\)/.test(svc));
}

/* ══ 6. Authorization is single-sourced and re-checked live ═══════════════ */

section('6. A permission change kills an already-issued link');

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

/* ══ 7. Delivery token — executed model ═══════════════════════════════════ */

section('7. The delivery token binds material + student + intent + expiry');

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
  ok('the token identifies the STUDENT (so a copy cannot be re-pointed)', good.studentId === 'stu-A');
  ok('an expired token is refused', verify(t, now + 301).error === 'expired');
  ok('a tampered body is refused', (() => {
    const forged = b64url('mat-2|stu-A|view|' + (now + 300) + '|' + '0'.repeat(64));
    return verify(forged, now).error === 'invalid';
  })());
  ok('another student cannot reuse a token by editing the payload', (() => {
    const forged = b64url('mat-1|stu-B|view|' + (now + 300) + '|' + crypto.createHmac('sha256', 'wrong').update('x').digest('hex'));
    return verify(forged, now).error === 'invalid';
  })());
  ok('the token carries NO storage path or file name',
    !Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8').includes('/'));
  ok('a download intent is signed in (cannot be flipped to view)',
    verify(sign('mat-1', 'stu-A', 'download', now + 300), now).intent === 'download');
}

/* ══ 8. MANDATORY policy — executed model + source proof ═════════════════ */

section('8. Which bytes may be served (watermarking is mandatory)');

{
  // Mirror of MaterialDeliveryController::shouldWatermark: every role, always.
  const shouldWatermark = (_role) => true;
  const decide = ({ role, forDownload, enrolled, published, engineAvailable, legacyFlag }) => {
    if (published && !enrolled && role === 'student') return { deny: true };
    if (forDownload && legacyFlag === 'ignored') return { deny: true };
    if (shouldWatermark(role)) {
      return engineAvailable ? { watermarked: true } : { status: 503 };
    }
    return { original: true };
  };

  ok('student → personalized copy', decide({ role: 'student', enrolled: true, published: true, engineAvailable: true }).watermarked === true);
  ok('student + engine missing → 503, NEVER the original',
    (() => { const d = decide({ role: 'student', enrolled: true, published: true, engineAvailable: false }); return d.status === 503 && !d.original; })());
  ok('student + download intent → still personalized',
    decide({ role: 'student', forDownload: true, enrolled: true, published: true, engineAvailable: true }).watermarked === true);
  ok('doctor → ALSO personalized (the original is never served)',
    decide({ role: 'doctor', enrolled: false, published: true, engineAvailable: true }).watermarked === true);
  ok('doctor + engine missing → 503, never the original',
    (() => { const d = decide({ role: 'doctor', published: true, engineAvailable: false }); return d.status === 503 && !d.original; })());
  ok('admin → personalized too', decide({ role: 'admin', published: true, engineAvailable: true }).watermarked === true);
  ok('un-enrolled student → denied', decide({ role: 'student', enrolled: false, published: true, engineAvailable: true }).deny === true);

  const delivery = read('backend/src/Controllers/MaterialDeliveryController.php');
  ok('shouldWatermark takes ONLY the role (no material, no request field)',
    /private function shouldWatermark\(string \$role\): bool/.test(delivery));
  ok('it returns true for EVERY role, unconditionally',
    /private function shouldWatermark\(string \$role\): bool\s*\{[^}]*return true;/.test(delivery));
  ok('loadMaterial does not even SELECT the legacy column',
    !/SELECT[^']*watermark_enabled[^']*FROM lesson_materials/.test(delivery));
  ok('no code path reads a per-material watermark flag',
    !/watermark_enabled'?\]/.test(delivery));
}

/* ══ 9. Doctor-facing control is GONE ═════════════════════════════════════ */

section('9. No doctor-facing toggle anywhere');

{
  const api = read('src/lib/api.ts');
  const editor = read('src/app/(app)/lesson-editor/[id].tsx');
  const mats = read('src/lib/lessonMaterials.ts');

  ok('updateMaterialWatermark is DELETED from the API client',
    !/export async function updateMaterialWatermark/.test(api));
  ok('the material update payload cannot set watermark_enabled',
    !/watermark_enabled: boolean/.test(api));
  ok('the read type marks the column LEGACY (read-only)',
    /LEGACY \(migration 032\)/.test(api));
  ok('the editor has no watermark handler',
    !/handleUpdateWatermark/.test(editor));
  ok('the editor calls no watermark setter',
    !/updateMaterialWatermark/.test(editor));
  ok('the editor no longer imports one',
    !/updateMaterialWatermark,/.test(editor));
  ok('the editor still explains that personalization is ALWAYS ON',
    /t\('lessonEditor\.watermarkBody'\)/.test(editor) &&
    /lessonEditor\.watermarkBody/.test(read('src/lib/i18n/resources.ts')));
  ok('there is no switch/pressable for the watermark row',
    !/onPress=\{[^}]*[Ww]atermark/.test(editor));
  ok('lessonMaterials.ts no longer exposes a watermark switch reader',
    !/isMaterialWatermarkEnabled/.test(mats));
  ok('it documents that the server ignores the legacy column',
    /consult `watermark_enabled` \(the legacy column is ignored server-side\)/.test(mats));
}

/* ══ 10. Frontend PDF delivery wiring ═════════════════════════════════════ */

section('10. Students open PDFs through the personalized endpoint');

{
  const api = read('src/lib/api.ts');
  const lesson = read('src/app/(app)/lesson/[id].tsx');
  const mats = read('src/lib/lessonMaterials.ts');

  ok('getMaterialPdfUrl takes a material id (not a path)',
    /export async function getMaterialPdfUrl\(\s*materialId: string/.test(api) && /material_id: materialId, intent:/.test(api));
  ok('it maps forDownload → download intent server-side',
    /intent: forDownload \? 'download' : 'view'/.test(api));
  ok('no client identity is ever sent to the watermarker', (() => {
    const start = api.indexOf('export async function getMaterialPdfUrl');
    const body = api.slice(start, start + 900);
    return /material_id: materialId/.test(body) && !/full_name|public_user_id|student_name/.test(body);
  })());
  ok('the lesson screen uses the delivery endpoint for PDFs',
    /getMaterialPdfUrl\(String\(material\.id\), forDownload\)/.test(lesson));
  // A helper that is not routed fails at runtime with "Unknown function": the
  // delivery endpoint must exist in BOTH the PHP router and the PHP client map.
  const phpClient = read('src/client/php.ts');
  const routes = read('backend/routes/api.php');
  ok('the delivery function is mapped to its PHP route in the backend client',
    /'materials\/pdf-url':\s*'\/materials\/pdf-url'/.test(phpClient));
  ok('the PHP router exposes POST /materials/pdf-url',
    /\$router->post\('\/materials\/pdf-url'/.test(routes));
  ok('the PHP router exposes GET /materials/pdf (token-gated stream)',
    /\$router->get\('\/materials\/pdf'/.test(routes));
  ok('the stream route is public-by-token (not behind the auth middleware)',
    /\$router->get\('\/materials\/pdf', \[MaterialDeliveryController::class, 'streamPdf'\]\);/.test(routes));
  ok('the status route is restricted to admins',
    /material-watermark-status'[\s\S]{0,120}'role' => \['admin', 'super_admin'\]/.test(routes));
  ok('the lesson screen still uses a signed URL for non-PDF attachments',
    /getMaterialSignedUrl\(String\(path\), forDownload\)/.test(lesson));
  ok('legacy lesson_pdfs are passed to staff only (never offered to a student)',
    /pdfs=\{isStudent \? \[\] : \(lesson\.lesson_pdfs \?\? \[\]\)\}/.test(lesson) &&
      !/pdfs=\{lesson\.lesson_pdfs/.test(lesson));
  ok('both View and Download go through openMaterial (one flow)',
    (lesson.match(/onOpenMaterial=\{openMaterial\}/g) || []).length >= 2);
  ok('the material row passes the whole material (so the id is available)',
    /onOpenMaterial\(mat, name, downloadable\)/.test(lesson));
  ok('a watermark failure is surfaced with its own localized message',
    /lesson\.materialWatermarkUnavailable/.test(lesson));
  ok('the i18n key exists in English and Arabic', (() => {
    const res = read('src/lib/i18n/resources.ts');
    return (res.match(/'lesson\.materialWatermarkUnavailable'/g) || []).length === 2;
  })());

  // Executed model of the helper.
  const isPdfMaterial = (mat) => {
    const type = String(mat?.file_type ?? '').toLowerCase();
    const name = String(mat?.file_name ?? '').toLowerCase();
    return type.includes('pdf') || name.endsWith('.pdf');
  };
  ok('isPdfMaterial: pdf MIME → true', isPdfMaterial({ file_type: 'application/pdf' }) === true);
  ok('isPdfMaterial: .PDF extension only → true', isPdfMaterial({ file_name: 'lecture.PDF' }) === true);
  ok('isPdfMaterial: docx → false (keeps the signed-URL flow)', isPdfMaterial({ file_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', file_name: 'notes.docx' }) === false);
  ok('isPdfMaterial: zip → false', isPdfMaterial({ file_name: 'slides.zip' }) === false);
  ok('isPdfMaterial: missing fields → false', isPdfMaterial({}) === false);
  ok('the real helper matches the model',
    /export function isPdfMaterial\(mat: any\): boolean \{[\s\S]{0,220}type\.includes\('pdf'\) \|\| name\.endsWith\('\.pdf'\)/.test(mats));
}

/* ══ 11. Cache identity, concurrency, resource limits, audit ═════════════ */

section('11. Cache, concurrency and operational safety');

{
  const delivery = read('backend/src/Controllers/MaterialDeliveryController.php');
  const svc = read('backend/src/Services/PdfWatermarkService.php');
  const resp = read('backend/src/Http/Response.php');

  ok('the variant key folds in the source hash + identity + settings',
    /variantKey\(\$sourceHash, \$identityHash, \$this->watermark->variantSettings\(\$lines\)\)/.test(delivery));
  // The engine tokens are PINNED on purpose: they must change whenever the
  // rendered look changes (tiled grid -> single centred mark -> exact-opacity
  // single pass bumped the raster token to flatten-v4-single; the new flatten
  // engine carries its own center-bake token), otherwise a cached copy drawn by
  // the old layout would keep being served.
  ok('the cache identity includes the ENGINE (a switch regenerates)',
    /'engine' => \$mode === self::MODE_RASTER\s*\? 'flatten-v4-single'/.test(svc) &&
    /self::MODE_FLATTEN\s*\? self::FLATTEN_LAYOUT/.test(svc) &&
    /private const FLATTEN_LAYOUT = 'center-bake-v1'/.test(svc));
  ok('the cache identity includes the LAYER LAYOUT (old copies are regenerated)',
    /private const LAYERS_VERSION = 'layers-v4'/.test(svc) &&
    /\$settings\['layers'\] = self::LAYERS_VERSION/.test(svc));
  ok('the front opacity is part of the cache identity',
    /\$settings\['vector_front_opacity'\] = \$this->vectorForegroundOpacity\(\)/.test(svc));
  ok('a replaced source is detected via a CACHED hash, not a per-request one',
    /private function sourceHashFor/.test(delivery) && /file_hash_path/.test(delivery));
  ok('the cache is invalidated when the path, size or mtime changes',
    /\$storedPath === \(string\) \$material\['storage_path'\]/.test(delivery)
    && /\$storedSize !== null/.test(delivery)
    && /file_hash_mtime/.test(delivery));
  ok('a cached copy is only reused when the LIVE variant key matches',
    /findPersonalizedCopy\(\$material, \$studentId, \$variantKey\)/.test(delivery)
    && /\$expectedVariantKey !== null/.test(delivery));
  ok('the vector opacity is part of the cache identity',
    /\$settings\['vector_opacity'\] = \$this->vectorOpacity\(\)/.test(svc));
  ok('a per-variant lock serialises generation',
    /flock\(\$handle, LOCK_EX \| LOCK_NB\)/.test(delivery) && /private function withVariantLock/.test(delivery));
  ok('the lock is re-checked after waiting (no double render)',
    /another worker may have finished while we waited/.test(delivery));
  ok('output is published atomically (rename from a .part sibling)',
    /rename\(\$partAbs, \$finalAbs\)/.test(delivery));
  ok('expired variants for the same student are purged',
    /private function purgeStaleVariants/.test(delivery));
  ok('purging validates the path prefix before deleting',
    /str_starts_with\(\$path, \$prefix\)/.test(delivery));
  ok('minting is rate limited per account',
    /RateLimitService::perAccount\(\$request, 'material_pdf_mint'/.test(delivery));
  ok('delivery is audited with ids only (no name/token/bytes)',
    /'material_pdf_delivered'/.test(delivery) && !/full_name/.test(delivery.slice(delivery.indexOf('auditDelivery'), delivery.indexOf('auditDelivery') + 900)));
  ok('the audit write cannot break a legitimate read',
    /An audit failure must never block a legitimate read/.test(delivery));
  ok('the stream is sent as private + no-store',
    /'Cache-Control' => 'private, no-store, max-age=0'/.test(delivery));
  ok('the file is streamed in chunks, not loaded into memory',
    /public static function file\(/.test(resp) && /fread\(\$handle, 262144\)/.test(resp) && !/file_get_contents\(\$abs\)/.test(delivery));
}

/* ══ 12. Migration importable on a restricted cPanel MySQL user ═══════════ */

section('12. Migrations avoid information_schema');

{
  for (const [name, file] of [
    ['032', 'backend/database/mysql-migrations/032_lesson_material_watermark.sql'],
    ['035', 'backend/database/mysql-migrations/035_lesson_material_pdf_hardening.sql'],
  ]) {
    const sqlCode = read(file).replace(/^\s*--.*$/gm, '');
    ok(`${name}: no information_schema QUERY (cPanel #1044 regression)`, !/information_schema/i.test(sqlCode));
  }
}

/* ══ 13. Deployment surface ══════════════════════════════════════════════ */

section('13. Dependencies, diagnostics and cleanup are documented');

{
  const composer = JSON.parse(read('backend/composer.json'));
  ok('backend/composer.json pins FPDI and TCPDF', !!composer.require['setasign/fpdi'] && !!composer.require['tecnickcom/tcpdf']);
  ok('FPDF stays available for the minimal fallback engine', !!composer.require['setasign/fpdf']);
  ok('both libraries are pure PHP (no ext beyond zlib)',
    Object.keys(composer.require).filter((k) => k.startsWith('ext-')).join(',') === 'ext-zlib');
  ok('a cleanup CLI exists (cron-ready, dry-run by default)',
    read('backend/scripts/watermark-cleanup.php').includes('--apply'));
  ok('a host diagnostics script exists',
    read('backend/scripts/watermark-diagnostics.php').length > 200);
  ok('the engine reports its driver + engine identity',
    /'vector_engine' =>/.test(read('backend/src/Services/PdfWatermarkService.php')));
  ok('the deployment checklist exists (uploads, cron, migration)', (() => {
    const doc = read('backend/docs/PDF_WATERMARK_DEPLOYMENT.md');
    return /cron/i.test(doc) && /backend\/vendor/.test(doc) && /035_lesson_material_pdf_hardening\.sql/.test(doc);
  })());
  ok('the end-to-end delivery suite is part of the harness', (() => {
    return /delivery_tests\.php/.test(read('backend/tests/pdf-watermark/run.sh'))
      && /delivery_tests\.php/.test(read('backend/tests/pdf-watermark/run.ps1'))
      && /'delivery'/.test(read('backend/tests/pdf-watermark/summarize.php'));
  })());
  ok('the fixture generator builds a modern xref-stream PDF',
    /source-xrefstream\.pdf/.test(read('backend/tests/pdf-watermark/make_fixture.php')));
}

/* ══ 14. Diagnosis + download UX regressions ══════════════════════════════ */

section('14. The reported failure modes cannot return silently');

{
  const svc = read('backend/src/Services/PdfWatermarkService.php');

  // BUG 1 — "no engine installed" was reported on a host that HAD the engine.
  // rendererStatus() memoised a verdict probed BEFORE the vendored autoloader
  // ran (loadLibraries was only called from isAvailable), so diagnostics said
  // "missing" and every later isAvailable() in that request refused delivery.
  const probe = svc.slice(svc.indexOf('public function rendererStatus'), svc.indexOf('$hasFpdi ='));
  ok('rendererStatus() loads the vendored libraries BEFORE probing the engine',
    /\$this->loadLibraries\(\);/.test(probe));
  ok('loadLibraries() is idempotent (a second call is a no-op)',
    /private function loadLibraries\(\): void\s*\{\s*if \(\$this->librariesLoaded\) \{\s*return;/.test(svc));
  ok('the availability verdict still fails closed when no engine exists',
    /no compatible engine is installed[\s\S]{0,80}503|ApiException\(503, 'PDF watermarking is not available on this server/.test(svc));

  // BUG 2 — the real reason (503 watermark_unavailable) reached the UI as
  // "Could not generate a download link": the PHP client dropped status/code.
  const php = read('src/client/php.ts');
  const invoke = php.slice(php.indexOf('async function invokeFunction'), php.indexOf('// ── RPC ─'));
  ok('the PHP client keeps the HTTP status and error code on function errors',
    (invoke.match(/status: res\.error\.status, code: res\.error\.code/g) || []).length === 2);
  ok('its declared result type exposes status/code to callers',
    /error: \{ message: string; status\?: number; code\?: string/.test(invoke));

  const api = read('src/lib/api.ts');
  const helper = api.slice(api.indexOf('export async function invokeEdgeFunction'), api.indexOf('// ── Profiles ──'));
  ok('invokeEdgeFunction falls back to the error\'s own status',
    /typeof \(error as \{ status\?: unknown \}\)\.status === 'number'/.test(helper));
  ok('invokeEdgeFunction falls back to the error\'s own code',
    /if \(!errCode && typeof \(error as \{ code\?: unknown \}\)\.code === 'string'\)/.test(helper));

  // BUG 3 — on web the download only navigated to the URL, so a JSON refusal
  // looked like "nothing downloaded" and no file was ever produced.
  const lesson = read('src/app/(app)/lesson/[id].tsx');
  const web = lesson.slice(lesson.indexOf("if (process.env.EXPO_OS === 'web') {"), lesson.indexOf('const urlExt'));
  ok('web downloads FETCH the delivered URL before saving',
    /await fetch\(signedUrl\)/.test(web));
  ok('a refusal is detected from the status or a JSON content type',
    /contentType\.includes\('json'\)/.test(web) && /if \(!res\.ok \|\|/.test(web));
  ok('a real file is written through an anchor download',
    /URL\.createObjectURL\(blob\)/.test(web) && /a\.download = downloadName|anchor\.download/.test(web) && /anchor\.click\(\)/.test(web));
  ok('the error carries the HTTP status so the screen can map it',
    /failure\.httpStatus = res\.status/.test(web));
  ok('a cross-origin fetch failure still falls back to opening the URL',
    /catch \{[\s\S]{0,400}Linking\.openURL\(signedUrl\)/.test(web));
  ok('the missing-engine state is recognized by code OR message',
    /WATERMARK_STAGES\.includes\(code\)[\s\S]{0,80}watermarking is not available\/i\.test\(msg\)/.test(lesson));
  ok('every personalized-delivery stage code is mapped to that state',
    ['watermark_unavailable', 'watermark_busy', 'engine_unavailable', 'render_failed',
      'pdf_parse', 'output_missing', 'publish_failed', 'source_missing',
      'source_not_pdf', 'storage_unwritable', 'schema']
      .every(c => lesson.includes(`'${c}'`)));
  ok('that state shows the dedicated watermark message (not the generic one)',
    /engineMissing \|\| status === 503[\s\S]{0,120}materialWatermarkUnavailable/.test(lesson));
}

/* ── Summary ─────────────────────────────────────────────────────────────── */

console.log('\n' + (failures.length === 0 ? '✅' : '❌') + ` ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
