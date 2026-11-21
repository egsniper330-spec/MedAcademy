#!/usr/bin/env node
/**
 * IMAGE-ONLY FORENSIC VERIFICATION — backend + portal + service contracts.
 *
 * Run: node tests/pdfForensicImage.test.cjs
 *
 * What is pinned here:
 *   • a doctor can verify a page from an IMAGE ONLY (screenshot / crop / photo);
 *   • the endpoint is staff-only, rate-limited, audited, and reuses the SAME
 *     payload -> issuance resolution (no second watermarking system, no second
 *     identity path);
 *   • the type is decided by the FILE SIGNATURE, not by the client's filename or
 *     MIME (exercised for real by running PHP against byte fixtures);
 *   • the four outcomes stay distinct — in particular "insufficient quality" is
 *     never reported as "no watermark";
 *   • an unmatched or corrupted payload NEVER resolves an identity;
 *   • the upload is not persisted (service works in memory, PHP unlinks).
 *
 * The watermark itself is not re-tested here: the service tests with a fake model
 * prove the pipeline, and scripts/validate_image_forensics.py measures the real
 * checkpoint on the VPS.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PHP = path.join(ROOT, '.phpcli', 'php', 'php.exe');

const CONTROLLER = read('backend/src/Controllers/PdfForensicController.php');
const CLIENT = read('backend/src/Services/PdfForensicClient.php');
const ROUTES = read('backend/routes/api.php');
const CHECKER = read('portal/src/pages/PdfChecker.tsx');
const I18N = read('portal/src/lib/i18n.tsx');
const SERVICE_MAIN = read('pdf-watermark-service/app/main.py');
const IMAGE_FX = read('pdf-watermark-service/app/image_forensics.py');
const CONFIG = read('pdf-watermark-service/app/config.py');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

console.log('── 1. Route and authorization ──');
check('1a the route exists and is staff-only', () => {
  assert.match(ROUTES, /'\/pdf-forensic\/check-image', \[PdfForensicController::class, 'checkImage'\]/);
  assert.match(ROUTES, /pdf-forensic\/check-image[\s\S]{0,160}role' => \['doctor', 'admin', 'super_admin'\]/);
});
check('1b the controller enforces the role BEFORE reading the upload', () => {
  const body = CONTROLLER.slice(CONTROLLER.indexOf('public function checkImage'));
  const roleIdx = body.indexOf("in_array($role, ['doctor', 'admin', 'super_admin']");
  const fileIdx = body.indexOf("$request->file('file')");
  assert.ok(roleIdx > 0 && roleIdx < fileIdx, 'role check must precede file access');
});
check('1c image verification is rate limited per account AND per IP', () => {
  assert.match(CONTROLLER, /RateLimitService::perAccount\(\$request, 'pdf_forensic_image', self::IMAGE_RATE_ACCOUNT, 60\)/);
  assert.match(CONTROLLER, /RateLimitService::perIp\(\$request, 'pdf_forensic_image_ip', self::IMAGE_RATE_IP, 60\)/);
});
check('1d the same material scoping is applied as the PDF path', () => {
  const body = CONTROLLER.slice(CONTROLLER.indexOf('public function checkImage'), CONTROLLER.indexOf('public static function sniffImageMime'));
  assert.match(body, /storage->canAccess\(\$userId, \$role, 'lesson-materials'/);
  assert.match(body, /\$this->withinScope\(\$userId, \$role, \$material\)/);
});
check('1e identity resolution reuses findIssuance (one mapping, not a second one)', () => {
  const body = CONTROLLER.slice(CONTROLLER.indexOf('public function checkImage'), CONTROLLER.indexOf('public static function sniffImageMime'));
  assert.match(body, /\$this->findIssuance\(\$payload, \$userId, \$role/);
  assert.equal((body.match(/findIssuance\(/g) || []).length, 1);
});
check('1f identity is resolved ONLY for confirmed/probable and a non-null payload', () => {
  assert.match(CONTROLLER, /if \(\$payload !== null && in_array\(\$serviceVerdict, \['confirmed', 'probable'\], true\)\)/);
});

console.log('── 2. Upload safety (real PHP execution) ──');
function phpSniff(bytes, name = 'upload.bin') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfimg-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  const code = [
    `require ${JSON.stringify(path.join(ROOT, 'backend/src/Controllers/PdfForensicController.php').replace(/\\/g, '/'))};`,
    `$r = MedAcademy\\Controllers\\PdfForensicController::sniffImageMime(${JSON.stringify(file.replace(/\\/g, '/'))});`,
    'echo $r === null ? "null" : $r;',
  ].join(' ');
  return execFileSync(PHP, ['-r', code], { encoding: 'utf8' }).trim();
}

check('2a JPEG is identified by its signature', () => {
  assert.equal(phpSniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), 'image/jpeg');
});
check('2b PNG is identified by its signature', () => {
  assert.equal(phpSniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
});
check('2c WebP is identified by RIFF....WEBP', () => {
  const head = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP')]);
  assert.equal(phpSniff(head), 'image/webp');
});
check('2d GIF, PDF, and garbage are refused', () => {
  assert.equal(phpSniff(Buffer.from('GIF89a....')), 'null');
  assert.equal(phpSniff(Buffer.from('%PDF-1.7....')), 'null');
  assert.equal(phpSniff(Buffer.from('')), 'null');
});
check('2e a file named .jpg with PNG bytes is reported as PNG (name is not trusted)', () => {
  assert.equal(phpSniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'x.jpg'), 'image/png');
});
check('2f the size ceiling is 12 MiB and checked before forwarding', () => {
  assert.match(CONTROLLER, /MAX_IMAGE_BYTES = 12582912/);
  assert.match(CONTROLLER, /\(int\) \$file\['size'\] > self::MAX_IMAGE_BYTES/);
});
check('2g the temporary upload is removed after forwarding', () => {
  assert.match(CONTROLLER, /finally \{[\s\S]{0,200}@unlink\(\$tmp\)/);
});
check('2h the client streams from disk (never loads the image into PHP memory)', () => {
  assert.match(CLIENT, /public function detectImageFile\(string \$path, string \$mime/);
  assert.match(CLIENT, /\['path' => \$path, 'size' => \$size, 'sha256' => \$sha\], \$mime/);
  assert.match(CLIENT, /CURLOPT_INFILE/);
});
check('2i the service forbids the image path from being stored', () => {
  assert.ok(!/storage\.put_bytes|LocalPrivateStorage/.test(IMAGE_FX));
});

console.log('── 3. Outcomes are distinct and honest ──');
check('3a four states are computed separately', () => {
  assert.match(CONTROLLER, /\$state = \$issuance !== null \? 'identified'/);
  assert.match(CONTROLLER, /'insufficient_quality'/);
  assert.match(CONTROLLER, /'unmatched_payload'/);
  assert.match(CONTROLLER, /'no_mark'/);
});
check('3b insufficient quality carries reasons and never a payload', () => {
  assert.match(IMAGE_FX, /verdict": "insufficient_quality",\s*\n\s*"payload": None/);
  assert.match(CONTROLLER, /'reasons' => \$reasons/);
});
check('3c an unmatched payload is never an identity and is labelled as such', () => {
  assert.match(CONTROLLER, /It is not treated as valid evidence/);
  assert.match(CONTROLLER, /payload_unmatched/);
});
check('3d a detector outage is NOT reportable as no_mark', () => {
  assert.match(IMAGE_FX, /class ModelUnavailable/);
  assert.match(IMAGE_FX, /if not reads and failures:/);
  assert.match(SERVICE_MAIN, /raise _Reject\(503, "extract_failed"\)/);
});
check('3e ambiguous/conflicting evidence carries no payload', () => {
  assert.match(IMAGE_FX, /"payload": winner\["payload"\] if verdict in \("confirmed", "probable"\) else None/);
});
check('3f the response exposes no payload, package or raw region data', () => {
  const body = CONTROLLER.slice(CONTROLLER.indexOf('public function checkImage'), CONTROLLER.indexOf('public static function sniffImageMime'));
  assert.ok(!/'payload' =>/.test(body), 'payload must stay server-side');
  assert.ok(!/regions/.test(body), 'per-region internals must not be returned');
});
check('3g confidence and verification quality ARE returned to the doctor', () => {
  assert.match(CONTROLLER, /'score' => \(float\) \(\$result\['score'\]/);
  assert.match(CONTROLLER, /'candidates_readable' =>/);
  assert.match(CONTROLLER, /'quality' => \$reasons === \[\] \? \['ok' => true\]/);
});

console.log('── 4. Service limits (VPS resources) ──');
check('4a bounded candidate regions and concurrency', () => {
  assert.match(CONFIG, /image_max_candidates: int = Field\(7, ge=1, le=16\)/);
  assert.match(CONFIG, /image_max_concurrency: int = Field\(2, ge=1, le=4\)/);
  assert.match(SERVICE_MAIN, /asyncio\.Semaphore\(settings\.image_max_concurrency\)/);
});
check('4b decoded pixel cap and side cap before decoding', () => {
  assert.match(IMAGE_FX, /MAX_SIDE = 4096/);
  assert.match(IMAGE_FX, /MAX_PIXELS = 4096 \* 4096/);
  assert.match(IMAGE_FX, /if width \* height > MAX_PIXELS/);
});
check('4c the image route has its own body limit without widening the others', () => {
  assert.match(SERVICE_MAIN, /request\.url\.path == "\/internal\/detect-image"/);
  assert.match(SERVICE_MAIN, /async def require_hmac\(request: Request, max_bytes: int \| None = None\)/);
});
check('4d the upload lives in memory only', () => {
  assert.match(IMAGE_FX, /No storage: the upload is processed from memory/);
  assert.ok(!/NamedTemporaryFile|mkstemp|tempfile/.test(IMAGE_FX));
});

console.log('── 5. Portal wiring ──');
check('5a a mode switch exists and defaults to PDF', () => {
  assert.match(CHECKER, /const \[mode, setMode\] = useState<InputMode>\('pdf'\)/);
  assert.match(CHECKER, /const changeMode = \(next: InputMode\)/);
});
check('5b the image mode posts to the image endpoint', () => {
  assert.match(CHECKER, /mode === 'pdf' \? '\/pdf-forensic\/check' : '\/pdf-forensic\/check-image'/);
});
check('5c the picker accepts exactly jpeg/png/webp and enforces 12 MB', () => {
  assert.match(CHECKER, /accept=\{mode === 'pdf' \? 'application\/pdf,\.pdf' : 'image\/jpeg,image\/png,image\/webp'\}/);
  assert.match(CHECKER, /const MAX_IMAGE_BYTES = 12582912/);
  assert.match(CHECKER, /t\('pdfcheck\.notImage'\)/);
});
check('5d insufficient quality is rendered with its reasons', () => {
  assert.match(CHECKER, /result\.result_state === 'insufficient_quality'/);
  assert.match(CHECKER, /pdfcheck\.quality\.reason\.\$\{reason\}/);
});
check('5e confidence and region counts are shown for image results', () => {
  assert.match(CHECKER, /result\.input === 'image' && \(/);
  assert.match(CHECKER, /t\('pdfcheck\.candidates'\)/);
});
check('5f both locales carry every new string', () => {
  for (const key of ['pdfcheck.mode.image', 'pdfcheck.runImage', 'pdfcheck.notImage',
    'pdfcheck.verdict.insufficient_quality', 'pdfcheck.insufficientQuality',
    'pdfcheck.quality.reason.low_resolution', 'pdfcheck.quality.reason.blurry',
    'pdfcheck.quality.reason.low_contrast', 'pdfcheck.imageNote']) {
    const count = (I18N.match(new RegExp(`'${key.replace(/\./g, '\\.')}'`, 'g')) || []).length;
    assert.equal(count, 2, `${key} must exist in en and ar (found ${count})`);
  }
});
check('5g the page never claims "unwatermarked" from an image result', () => {
  assert.match(I18N, /does not prove the copy is unwatermarked/);
});

console.log('── 6. Existing policy preserved ──');
check('6a the PDF workflow and its endpoint are untouched', () => {
  assert.match(CONTROLLER, /public function check\(Request \$request\)/);
  assert.match(CLIENT, /public function detectFile\(string \$path, \?string \$sha256 = null\)/);
});
check('6b no APK/EAS build step was added anywhere', () => {
  assert.ok(!/eas build|gradlew|assembleRelease/.test(IMAGE_FX + SERVICE_MAIN));
});
check('6c audit events cover attempt, denial and failure', () => {
  for (const action of ['pdf_forensic_image_check', 'pdf_forensic_image_check_denied', 'pdf_forensic_image_check_failed']) {
    assert.ok(CONTROLLER.includes(`'${action}'`), `missing audit action ${action}`);
  }
});

console.log(`\n${passed} assertions passed${failures.length ? ` — ${failures.length} FAILED` : ''}.`);
if (failures.length) {
  failures.forEach((f) => console.log(`  ✗ ${f}`));
  process.exitCode = 1;
}
