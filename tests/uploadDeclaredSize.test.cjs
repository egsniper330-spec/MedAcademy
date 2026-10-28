/**
 * uploadDeclaredSize.test.cjs — the "which file was selected?" contract.
 *
 * WHY THIS SUITE EXISTS
 * ─────────────────────
 * Two production refusals disagreed with the file the doctor picked:
 *
 *   • a PDF under 200 KB, logged as `pdf_invalid` with `bytes=9563250`;
 *   • a ~140 KB PDF whose refusal quoted 679 bytes.
 *
 * Neither number is possible for the selected document, and neither can come
 * from PHP — `$_FILES['size']` is filled from the bytes PHP received, so it
 * always agrees with itself. Both are provider METADATA: expo-document-picker
 * reports `size` from the platform provider (`OpenableColumns.SIZE`), which
 * cloud providers and some file managers fill with placeholders, pre-conversion
 * lengths or simply wrong values.
 *
 * The upload path therefore (a) measures the file it is about to stream, and
 * (b) says which number it sent. The server treats the two divergences
 * differently, and that asymmetry is the fix:
 *
 *   SHORT body  (fewer bytes than declared)  → refuse: a truncated transfer.
 *   LONG body vs a MEASURED size           → refuse: a different file.
 *   LONG body vs PROVIDER metadata         → accept + log: the hint was wrong.
 *
 * Run: node tests/uploadDeclaredSize.test.cjs
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
  if (cond) passed++;
  else {
    failed++;
    failures.push(msg);
    console.error('  ✗ ' + msg);
  }
}
function eq(actual, expected, msg) {
  ok(
    Object.is(actual, expected),
    `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}
/** Drop full-line comments so a doc comment cannot satisfy a source pin. */
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsize-'));
  const out = path.join(dir, `${name}.js`);
  const src = path.join(dir, `${name}.ts`);
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

async function main() {
  const S = compileModule('localFileSize', 'src/lib/localFileSize.ts');
  const P = compileModule('uploadProgress', 'src/lib/uploadProgress.ts');

  // ══════════════════════════════════════════════════════════════════════════
  // Part A — choosing the number to declare (executed)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('── Part A: declared-size provenance (executed) ──');

  eq(S.chooseDeclaredSize('android', 679, 143_360).source, 'stat',
    'a native stat beats the picker hint (679 B provider value, 140 KB file)');
  eq(S.chooseDeclaredSize('android', 679, 143_360).size, 143_360,
    'the measured size is the one declared');
  eq(S.chooseDeclaredSize('ios', 9_563_250, 0).source, 'picker',
    'without a stat the picker value is only a hint');
  eq(S.chooseDeclaredSize('web', 143_360, 0).source, 'stat',
    'on web the picker value IS a measurement (built from the real File)');
  eq(S.chooseDeclaredSize('android', 0, 0).source, 'none', 'no number → none');
  eq(S.chooseDeclaredSize('android', -1, NaN).size, 0, 'garbage is not a size');
  eq(S.chooseDeclaredSize('android', '143360', 0).size, 143_360, 'numeric strings are accepted');
  eq(S.chooseDeclaredSize('android', 1024.7, 0).size, 1024, 'sizes are truncated to whole bytes');

  // resolveDeclaredFileSize — stat is used when it is possible and honest.
  let statted = 0;
  let r = await S.resolveDeclaredFileSize(
    { uri: 'file:///cache/report.pdf', pickerSize: 679, platform: 'android' },
    async () => { statted++; return 143_360; },
  );
  eq(r.source, 'stat', 'resolve: a successful stat is authoritative');
  eq(r.size, 143_360, 'resolve: the statted byte count is used');
  eq(statted, 1, 'resolve: the file was statted exactly once');

  r = await S.resolveDeclaredFileSize(
    { uri: 'file:///cache/report.pdf', pickerSize: 143_360, platform: 'android' },
    async () => { throw new Error('stat failed'); },
  );
  eq(r.source, 'picker', 'resolve: a failed stat falls back to the hint, tagged');
  eq(r.size, 143_360, 'resolve: the hint is still sent when it is all we have');

  r = await S.resolveDeclaredFileSize(
    { uri: 'file:///cache/report.pdf', pickerSize: 143_360, platform: 'android' },
    async () => null,
  );
  eq(r.source, 'picker', 'resolve: a stat that returns nothing is not a measurement');

  statted = 0;
  r = await S.resolveDeclaredFileSize(
    { uri: 'blob:https://app/abc', pickerSize: 143_360, platform: 'web' },
    async () => { statted++; return 1; },
  );
  eq(statted, 0, 'resolve: web never stats a blob URL');
  eq(r.source, 'stat', 'resolve: web trusts the browser File size');

  r = await S.resolveDeclaredFileSize(
    { uri: 'https://cdn.example/x.pdf', pickerSize: 0, platform: 'android' },
    async () => 999,
  );
  eq(r.source, 'none', 'resolve: a remote URL is not statted (not a local file)');

  // ══════════════════════════════════════════════════════════════════════════
  // Part B — the asymmetry (executed, against the real tolerance helper)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('── Part B: truncation vs substitution (executed) ──');

  const diverges = (d, a) => P.uploadSizeMismatch(d, a);

  // The 140 KB / 679 B shape: more bytes arrived than the hint claimed.
  eq(S.declaresTruncatedTransfer(679, 143_360, diverges), false,
    'a LONG arrival is never a truncation');
  eq(S.declaresDifferentFile(679, 143_360, 'picker', diverges), false,
    'a wrong picker hint does not prove a different file (the 679-byte case)');
  eq(S.declaresDifferentFile(679, 143_360, 'stat', diverges), true,
    'the same divergence from a MEASURED size is a different file');

  // The <200 KB / 9.5 MB shape, with the two provenances.
  eq(S.declaresDifferentFile(191_265, 9_563_250, 'picker', diverges), false,
    'the 9.5 MB shape from a hint is accepted (bytes are still PDF-validated)');
  eq(S.declaresDifferentFile(191_265, 9_563_250, 'stat', diverges), true,
    'the 9.5 MB shape from a measurement is refused');

  // Truncation, in both provenances.
  eq(S.declaresTruncatedTransfer(143_360, 679, diverges), true,
    'a 679-byte body for a 140 KB file is a truncation — regardless of source');
  eq(S.declaresTruncatedTransfer(143_360, 143_000, diverges), false,
    'a transfer within tolerance is not called truncated');
  eq(S.declaresTruncatedTransfer(0, 100, diverges), false,
    'no declared size means no truncation claim');
  eq(S.declaresDifferentFile(0, 9_563_250, 'stat', diverges), false,
    'no declared size means no substitution claim');

  // ══════════════════════════════════════════════════════════════════════════
  // Part C — source pins across the wire contract
  // ══════════════════════════════════════════════════════════════════════════
  console.log('── Part C: wire contract (source pins) ──');

  const client = code(read('src/client/php.ts'));
  ok(client.includes("formData.append('declared_size_source', source)"),
    'client sends declared_size_source alongside declared_size');
  ok(client.includes("declaredSizeSource?: 'stat' | 'picker' | 'none'"),
    'client types the provenance');

  const api = code(read('src/lib/api.ts'));
  ok(api.includes('declaresTruncatedTransfer(declaredBytes, size'),
    'api refuses a short body');
  ok(api.includes('declaresDifferentFile(declaredBytes, size, declaredSource'),
    'api only refuses a long body when the size was measured');
  ok(api.includes("declaredSizeSource: options?.declaredSizeSource ?? 'picker'"),
    'api defaults an unknown provenance to the hint (never a refusal)');

  const controller = code(read('backend/src/Controllers/StorageController.php'));
  ok(controller.includes("$_POST['declared_size_source']"),
    'StorageController reads the provenance from the request');
  ok(controller.includes('$this->integrity->validate($file, $dest, $bucket, $clientDeclared, $declaredSource)'),
    'StorageController passes it into validate()');

  const service = code(read('backend/src/Services/UploadIntegrityService.php'));
  ok(service.includes('public function validate(array $file, string $dest, string $bucket, int $clientDeclaredBytes = 0, string $declaredSource = \'\')'),
    'validate() accepts the declared-size provenance');
  ok(service.includes("$size < $clientDeclaredBytes"),
    'server refuses a SHORT body regardless of provenance');
  ok(service.includes("$declaredSource === 'stat'") && service.includes("$size > $clientDeclaredBytes"),
    'server refuses a LONG body only for a measured size');
  ok(service.includes("'picker_size_inaccurate'"),
    'server logs a wrong picker hint instead of failing the upload');
  ok(service.includes("'declared_source' => $declaredSource"),
    'server records the provenance in its diagnostics');

  const editor = code(read('src/app/(app)/lesson-editor/[id].tsx'));
  ok(editor.includes('resolveDeclaredFileSize('),
    'the lesson editor measures the picked file before uploading');
  ok(editor.includes('getInfoAsync(uri)'),
    'the measurement is a real filesystem stat, not picker metadata');
  ok(editor.includes('declaredSizeSource: declared.source'),
    'the editor tells the uploader which number it sent');
  ok(!editor.includes('file.size ?? 0,\r\n          { onProgress') && !/uploadLessonMaterial\([\s\S]{0,240}file\.size \?\? 0,/.test(editor),
    'the editor no longer declares the raw picker size as the file size');

  // ══════════════════════════════════════════════════════════════════════════
  console.log('');
  if (failed > 0) {
    console.log(`${passed} passed, ${failed} FAILED`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`${passed} passed, 0 failed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
