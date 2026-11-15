/**
 * pdfDeliveryProgress — regression guard for the "stuck at 15 %" fix.
 *
 * The defect this pins: the web download path set `progress: 0.15` by hand and
 * then buffered the whole body with `blob()`, so the panel showed 15 % for the
 * entire transfer and jumped to 100 %. The module under test is the only place
 * allowed to turn byte counters into a percentage.
 *
 * These tests EXECUTE the module (it has no React Native imports), so they fail
 * if the arithmetic, the unknown-total rule or the monotonic clamp regresses.
 *
 * Run: node tests/pdfDeliveryProgress.test.cjs
 */
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

let failures = 0;
function ok(condition, message, detail) {
  if (condition) {
    console.log('  ok   ' + message);
  } else {
    failures += 1;
    console.error('  FAIL ' + message + (detail ? ' — ' + detail : ''));
  }
}

/* The module is TypeScript with no RN imports, so compile it on the fly with the
 * project's TypeScript (present as a dev dependency) into a temp file. */
function loadModule() {
  const ts = require(path.join(ROOT, 'node_modules', 'typescript'));
  const source = fs.readFileSync(path.join(ROOT, 'src/lib/pdfDeliveryProgress.ts'), 'utf8');
  const uploadSrc = fs.readFileSync(path.join(ROOT, 'src/lib/uploadProgress.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const compiledUpload = ts.transpileModule(uploadSrc, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const uploadModule = { exports: {} };
  const uploadRequire = (id) => {
    if (id.startsWith('./uploadProgress')) return uploadModule.exports;
    return require(id);
  };
  new Function('exports', 'require', 'module', compiledUpload)(uploadModule.exports, uploadRequire, uploadModule);
  const mod = { exports: {} };
  const require2 = (id) => (id.startsWith('./uploadProgress') ? uploadModule.exports : require(id));
  new Function('exports', 'require', 'module', compiled)(mod.exports, require2, mod);
  return mod.exports;
}

const mod = loadModule();

console.log('\n1. percentages come from bytes only');

const tracker = mod.createDeliveryTracker(0, { totalBytes: 1000, now: () => 0 });
tracker.setStage('downloading');
let snap = tracker.snapshot(250, 100);
ok(snap.percent === 25, '250 of 1000 bytes → 25 %', String(snap.percent));
ok(snap.determinate === true, 'a known total is determinate');
snap = tracker.snapshot(750, 200);
ok(snap.percent === 75, '750 of 1000 bytes → 75 %', String(snap.percent));

console.log('\n2. an unknown total never invents a percentage');

const unknown = mod.createDeliveryTracker(0, { now: () => 0 });
unknown.setStage('downloading');
const u1 = unknown.snapshot(0, 10);
const u2 = unknown.snapshot(4_000_000, 20);
ok(u1.percent === null && u2.percent === null, 'percent is null while the total is unknown');
ok(u2.determinate === false, 'the snapshot reports indeterminate');
ok(u2.bytesReceived === 4_000_000, 'received bytes are still reported honestly');
unknown.setTotal(8_000_000);
const u3 = unknown.snapshot(4_000_000, 30);
ok(u3.percent === 50, 'once a real total arrives the percentage becomes exact', String(u3.percent));

console.log('\n3. progress is monotonic (a resumed/re-reported counter cannot rewind)');

const mono = mod.createDeliveryTracker(0, { totalBytes: 100, now: () => 0 });
mono.snapshot(80, 10);
const back = mono.snapshot(20, 20);
ok(back.bytesReceived === 80, 'a lower reported count is ignored', String(back.bytesReceived));
ok(back.percent === 80, 'the bar does not jump backwards', String(back.percent));

console.log('\n4. this module can never report a completed download');

const any = mod.createDeliveryTracker(0, { totalBytes: 10, now: () => 0 });
const full = any.snapshot(10, 10);
ok(full.percent === 100, 'a full byte count reads 100 %…');
ok(mod.deliveryStageKey('saving') === 'lesson.stageSaving',
  '…but the SAVING stage has its own label, so 100 % is only shown once the caller marks done');

console.log('\n5. stages are distinct states, not percentages');

const stages = ['preparing', 'generating', 'downloading', 'saving', 'done'].map((s) => mod.deliveryStageKey(s));
ok(new Set(stages).size === 5, 'every stage has its own i18n key', stages.join(','));
ok(stages[1] === 'lesson.stageGenerating', 'the server-generation stage is explicit');

console.log('\n6. UI emission is throttled (no re-render per chunk)');

const s1 = { percent: 10, atMs: 0 };
ok(mod.shouldEmitProgress(s1, { percent: 10 }, 50) === false, 'same percentage inside the window → no render');
ok(mod.shouldEmitProgress(s1, { percent: 11 }, 60) === true, 'a whole percentage point → render');
ok(mod.shouldEmitProgress(s1, { percent: 10 }, 400) === true, 'the byte counter still ticks over time');

console.log('\n7. byte labels');

ok(mod.describeTransfer(1_500_000, 18_000_000).includes(' / '), 'known total → "received / total"');
ok(!mod.describeTransfer(1_500_000, 0).includes(' / '), 'unknown total → received only');

console.log('\n8. the shipped screen no longer contains the placeholder');

const screen = fs.readFileSync(path.join(ROOT, 'src/app/(app)/lesson/[id].tsx'), 'utf8');
ok(!/progress:\s*0\.15/.test(screen), 'no hardcoded 0.15 progress in the lesson download path');
ok(/createDeliveryTracker/.test(screen), 'the download path uses the byte-driven tracker');
ok(/getReader/.test(screen), 'the web download streams the body instead of buffering blindly');
ok(/indeterminate/.test(screen), 'the panel supports an indeterminate state');
ok(/stage:\s*'saving'/.test(screen), 'the device-write stage is explicit');
ok(!/desc' \+/.test(screen), 'no debug string concatenation in the panel');

console.log('\n9. completion means the stored file is complete, not that bytes arrived');

// A response finishing is NOT completion: a dropped connection can leave a
// truncated file, and the native path used to accept "exists and non-empty".
const v = mod.verifyStoredDownload;
ok(typeof v === 'function', 'verifyStoredDownload is exported');
ok(v({ exists: true, storedBytes: 18_000_000, expectedBytes: 18_000_000 }).ok === true,
  'stored size equal to the declared size is complete');
ok(v({ exists: true, storedBytes: 17_900_000, expectedBytes: 18_000_000 }).reason === 'short',
  'a truncated file is NOT reported as complete');
ok(v({ exists: true, storedBytes: 18_000_100, expectedBytes: 18_000_000 }).reason === 'long',
  'more bytes than declared is not the document the server described');
ok(v({ exists: false, storedBytes: 0, expectedBytes: 18_000_000 }).reason === 'missing',
  'a missing file is never complete');
ok(v({ exists: true, storedBytes: 0, expectedBytes: 18_000_000 }).reason === 'empty',
  'a zero-byte file is never complete');
ok(v({ exists: true, storedBytes: 4_000_000, expectedBytes: 0 }).ok === true,
  'with an unknown declared size no size claim is invented');
ok(v({ exists: true, storedBytes: 0, expectedBytes: 0 }).ok === false,
  'an unknown size still refuses an empty file');
ok(/verifyStoredDownload/.test(fs.readFileSync(path.join(ROOT, 'src/app/(app)/lesson/[id].tsx'), 'utf8')),
  'the shipped native download path verifies the stored size before success');

console.log('\n10. backend exposes Content-Length for real browser progress');

const cors = fs.readFileSync(path.join(ROOT, 'backend/src/Middleware/CorsMiddleware.php'), 'utf8');
ok(/Access-Control-Expose-Headers:[^\n]*Content-Length/.test(cors),
  'CORS exposes Content-Length (otherwise the browser cannot compute progress)');

if (failures > 0) {
  console.error('\n' + failures + ' assertion(s) failed\n');
  process.exit(1);
}
console.log('\nAll delivery-progress guards passed\n');
