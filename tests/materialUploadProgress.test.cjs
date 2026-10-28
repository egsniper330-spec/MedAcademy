/**
 * materialUploadProgress.test.cjs — the PDF/material upload progress contract.
 *
 * WHY THIS SUITE EXISTS
 * ─────────────────────
 * A doctor attaching a PDF used to get a spinner and the single word
 * "Uploading…" until the request finished — no bytes, no percentage, no ETA,
 * no cancel. On a slow link a 40 MB scan takes minutes, so the screen could not
 * be distinguished from a hung request, and the only recovery was to leave the
 * screen (or the app) and try again.
 *
 * The fix has three parts, and each is pinned here:
 *
 *   A. `src/lib/uploadProgress.ts` — percent/speed/ETA/stage helpers and the
 *      failure → message mapping. COMPILED AND EXECUTED (real behaviour).
 *   B. `src/lib/uploadTransport.ts` — the XMLHttpRequest multipart transport
 *      that actually reports bytes and supports cancellation. COMPILED AND
 *      EXECUTED against a fake XHR, so progress, abort, timeout and network
 *      failure are all exercised without a device.
 *   C. Source pins — the storage client routes progress through the transport
 *      exactly once and keeps its security-lock + zero-byte checks; the API
 *      wrapper keeps `verifying` distinct from `uploading`; the editor renders
 *      the card and refuses a second concurrent transfer; every message key
 *      exists in BOTH locales.
 *
 * Run: node tests/materialUploadProgress.test.cjs
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uprog-'));
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

// ════════════════════════════════════════════════════════════════════════════
// Part A — progress maths (executed)
// ════════════════════════════════════════════════════════════════════════════
console.log('── Part A: uploadProgress helpers (executed) ──');

const P = compileModule('uploadProgress', 'src/lib/uploadProgress.ts');

eq(P.percentOf(0, 0), null, 'percent: unknown total → null (indeterminate, never a fake 0 %)');
eq(P.percentOf(5, 10), 50, 'percent: half of a known total');
eq(P.percentOf(10, 10), 100, 'percent: complete');
eq(P.percentOf(11, 10), 100, 'percent: clamped at 100 (multipart overhead can exceed the claim)');
eq(P.percentOf(-4, 10), 0, 'percent: clamped at 0');
eq(P.percentOf(1, 3), 33.3, 'percent: one decimal');

eq(P.formatByteCount(512), '512 B', 'format: bytes');
eq(P.formatByteCount(2048), '2 KB', 'format: KB');
eq(P.formatByteCount(5 * 1024 * 1024), '5 MB', 'format: MB');
eq(P.formatByteCount(Number.NaN), '0 B', 'format: NaN is treated as 0');

// Stage vocabulary
for (const stage of ['preparing', 'uploading', 'verifying', 'saving', 'done', 'failed', 'cancelled']) {
  ok(typeof P.stageMessageKey(stage) === 'string' && P.stageMessageKey(stage).startsWith('lessonEditor.upload.'),
    `stage key: ${stage} maps to a lessonEditor.upload.* i18n key`);
}
ok(P.isActiveStage('preparing') && P.isActiveStage('uploading') && P.isActiveStage('verifying') && P.isActiveStage('saving'),
  'stage: preparing/uploading/verifying/saving are all active');
ok(!P.isActiveStage('done') && !P.isActiveStage('failed') && !P.isActiveStage('cancelled'),
  'stage: done/failed/cancelled are terminal');

// Tracker — deterministic clock
let clock = 1000;
const tracker = P.createUploadTracker(10_000, 1000, { now: () => clock, smoothing: 1 });
tracker.setStage('uploading');
let snap = tracker.snapshot(0);
eq(snap.percent, 0, 'tracker: starts at 0 %');
eq(snap.speedBps, 0, 'tracker: no speed before two samples');
eq(snap.etaSeconds, null, 'tracker: no ETA before speed is known');

clock = 2000; // 1 second later, 2000 bytes sent (2 kB/s)
snap = tracker.snapshot(2000);
eq(snap.percent, 20, 'tracker: 2000/10000 → 20 %');
eq(snap.speedBps, 2000, 'tracker: 2000 bytes in 2000 ms → 2000 B/s');
eq(snap.etaSeconds, 4, 'tracker: 8000 bytes left at 2 kB/s → 4 s');

clock = 2050;
snap = tracker.snapshot(500); // a re-report (buffered/retried XHR) must not rewind
eq(snap.bytesSent, 2000, 'tracker: byte count never goes backwards');
eq(snap.percent, 20, 'tracker: progress never rewinds');

clock = 2100;
snap = tracker.snapshot(3000);
eq(snap.bytesSent, 3000, 'tracker: advance is recorded');
ok(snap.percent > 20 && snap.percent < 100, 'tracker: partial progress is between the bounds');
ok(snap.etaSeconds !== null && snap.etaSeconds > 0, 'tracker: ETA present while bytes remain');

// Wire total beats the picker claim
const pickerUnknown = P.createUploadTracker(0, 0, { now: () => 0 });
pickerUnknown.setTotal(4096);
eq(pickerUnknown.snapshot(1024, 1000).percent, 25, 'tracker: a wire total supplied later makes the bar determinate');

tracker.setStage('verifying');
eq(tracker.snapshot().stage, 'verifying', 'tracker: stage is carried into the snapshot');

console.log('── Part A2: failure classification ──');
const cases = [
  [{ name: 'AbortError' }, 'cancelled', 'lessonEditor.upload.cancelled', false, 'abort by the doctor is NOT an error'],
  [{ code: 'ABORT_ERR' }, 'cancelled', 'lessonEditor.upload.cancelled', false, 'ABORT_ERR code is a cancel'],
  [{ code: 'TIMEOUT' }, 'failed', 'lessonEditor.upload.transferTimedOut', true, 'transport timeout'],
  [{ status: 408 }, 'failed', 'lessonEditor.upload.transferTimedOut', true, 'HTTP 408'],
  [{ status: 401 }, 'failed', 'lessonEditor.upload.sessionExpired', false, 'HTTP 401 → sign in again'],
  [{ status: 403 }, 'failed', 'lessonEditor.upload.sessionExpired', false, 'HTTP 403 → sign in again'],
  [{ status: 413 }, 'failed', 'lessonEditor.upload.tooLarge', false, 'HTTP 413 → shrink the file'],
  [{ status: 429 }, 'failed', 'lessonEditor.upload.tooManyRequests', true, 'HTTP 429 → rate limited'],
  [{ status: 500 }, 'failed', 'lessonEditor.upload.serverError', true, 'HTTP 5xx → server problem'],
  [{ status: 503 }, 'failed', 'lessonEditor.upload.serverError', true, 'HTTP 503 → server problem'],
  [{ code: 'NETWORK' }, 'failed', 'lessonEditor.upload.networkError', true, 'dropped connection'],
  [{ status: 0 }, 'failed', 'lessonEditor.upload.failed', true, 'status 0 without a transport code is not assumed to be the network'],
  [{ code: 'upload_empty' }, 'failed', 'lessonEditor.uploadEmpty', true, '200 with zero stored bytes is a real failure'],
  // ── Stable backend codes: the reason must survive the trip to the doctor ──
  // Every one of these arrives as HTTP 422, so without the code the UI can only
  // say "Upload failed." — which is exactly how a refused PDF used to present.
  [{ status: 422, code: 'pdf_unsupported_format' }, 'failed', 'lessonEditor.upload.pdfUnsupported', false, 'compressed-container PDF → re-export advice'],
  [{ status: 422, code: 'pdf_invalid' }, 'failed', 'lessonEditor.upload.pdfInvalid', false, 'unreadable PDF → different copy'],
  [{ status: 422, code: 'pdf_encrypted' }, 'failed', 'lessonEditor.upload.pdfEncrypted', false, 'encrypted PDF → unencrypted copy'],
  [{ status: 400, code: 'pdf_truncated' }, 'failed', 'lessonEditor.upload.pdfTruncated', true, 'truncated PDF → upload again'],
  [{ status: 400, code: 'upload_truncated' }, 'failed', 'lessonEditor.upload.pdfTruncated', true, 'short transfer → upload again'],
  [{ status: 422, code: 'material_file_missing' }, 'failed', 'lessonEditor.upload.notStored', true, 'stored bytes not found when the row was written'],
  [{ status: 500, code: 'material_write_failed' }, 'failed', 'lessonEditor.upload.saveFailed', true, 'row insert failed after a good upload'],
  [{ status: 500, code: 'persist_mismatch' }, 'failed', 'lessonEditor.upload.saveFailed', true, 'partial write was rolled back'],
  [{ status: 403, code: 'pdf_invalid' }, 'failed', 'lessonEditor.upload.sessionExpired', false, 'a status with its own copy wins over the code'],
  [{ status: 500 }, 'failed', 'lessonEditor.upload.serverError', true, 'an unknown code stays generic-but-actionable'],
  [{ status: 422 }, 'failed', 'lessonEditor.upload.failed', true, 'anything else falls back to the generic key'],
  [null, 'failed', 'lessonEditor.upload.failed', true, 'null error still yields a usable message'],
];
for (const [error, stage, key, retryable, label] of cases) {
  const info = P.classifyUploadFailure(error);
  ok(info.stage === stage && info.messageKey === key && info.retryable === retryable,
    `classify: ${label} → ${key} (got ${info.stage}/${info.messageKey}/${info.retryable})`);
}

// ════════════════════════════════════════════════════════════════════════════
// Part A3 — is a server REFUSAL known, or is the outcome unknown?
// ════════════════════════════════════════════════════════════════════════════
// Only a 4xx proves no material row was written, which is what makes it safe to
// reclaim the object that was just uploaded. A 5xx/timeout/dropped connection
// may have committed the row, so the bytes must be kept.
console.log('── Part A3: server refusal detection ──');
for (const [status, expected, label] of [
  [400, true, '400 is a refusal'],
  [403, true, '403 is a refusal'],
  [404, true, '404 is a refusal'],
  [409, true, '409 is a refusal'],
  [413, true, '413 is a refusal'],
  [422, true, '422 is a refusal'],
  [429, true, '429 is a refusal'],
  [500, false, '500 has an UNKNOWN outcome'],
  [503, false, '503 has an UNKNOWN outcome'],
  [0, false, 'status 0 (transport) has an UNKNOWN outcome'],
  [undefined, false, 'a missing status is not a refusal'],
]) {
  ok(P.isServerRefusal(status === undefined ? undefined : { status }) === expected,
    `refusal: ${label} → ${expected}`);
}
ok(P.isServerRefusal(null) === false, 'refusal: a null error is not a refusal');

// ════════════════════════════════════════════════════════════════════════════
// Part B — the transport (executed with a fake XHR)
// ════════════════════════════════════════════════════════════════════════════
console.log('── Part B: uploadTransport (executed, fake XHR) ──');

const T = compileModule('uploadTransport', 'src/lib/uploadTransport.ts');

function makeFakeXhr() {
  const state = {
    opened: null,
    headers: {},
    sentBody: null,
    aborted: false,
    timeout: -1,
    xhr: null,
  };
  class FakeXhr {
    constructor() {
      this.upload = { onprogress: null };
      this.status = 0;
      this.responseText = '';
      this.timeout = 0;
      this.onload = null;
      this.onerror = null;
      this.onabort = null;
      this.ontimeout = null;
      state.xhr = this;
    }
    open(method, url) { state.opened = { method, url }; }
    setRequestHeader(name, value) { state.headers[name] = value; }
    send(body) { state.sentBody = body; }
    abort() { state.aborted = true; }
    // test helpers
    progress(loaded, total) { if (this.upload.onprogress) this.upload.onprogress({ loaded, total, lengthComputable: true }); }
    succeed(status, body) { this.status = status; this.responseText = body; if (this.onload) this.onload(); }
    fail() { if (this.onerror) this.onerror(); }
    timeOut() { if (this.ontimeout) this.ontimeout(); }
  }
  return { state, factory: () => new FakeXhr() };
}

(async () => {
  // B1 — progress events reach the caller, headers are applied, body is sent
  {
    const fake = makeFakeXhr();
    const seen = [];
    const promise = T.uploadWithProgress({
      url: 'https://api.test/storage/upload',
      formData: { marker: 'fd' },
      headers: { Authorization: 'Bearer abc', '': 'ignored' },
      onProgress: (p) => seen.push(p),
      xhrFactory: fake.factory,
    });
    eq(fake.state.opened.method, 'POST', 'transport: opens a POST');
    eq(fake.state.opened.url, 'https://api.test/storage/upload', 'transport: uses the given URL');
    eq(fake.state.headers.Authorization, 'Bearer abc', 'transport: forwards the auth header');
    ok(!('' in fake.state.headers), 'transport: empty header names are skipped');
    ok(fake.state.sentBody !== null, 'transport: sends the FormData body');

    fake.state.xhr.progress(1024, 4096);
    fake.state.xhr.progress(4096, 4096);
    eq(seen.length, 2, 'transport: every progress event is forwarded');
    eq(seen[0].bytesSent, 1024, 'transport: reports sent bytes');
    eq(seen[0].totalBytes, 4096, 'transport: reports the total');
    fake.state.xhr.succeed(200, '{"size":4096}');
    const res = await promise;
    eq(res.status, 200, 'transport: resolves with the status (the client judges it)');
    eq(res.bodyText, '{"size":4096}', 'transport: returns the raw body for the shared parser');
  }

  // B2 — non-2xx resolves (no throwing), preserving status for the caller
  {
    const fake = makeFakeXhr();
    const promise = T.uploadWithProgress({ url: 'u', formData: {}, xhrFactory: fake.factory });
    fake.state.xhr.succeed(413, '{"error":{"message":"too big"}}');
    const res = await promise;
    eq(res.status, 413, 'transport: 413 resolves so the client can map it');
  }

  // B3 — abort BEFORE send rejects without touching the network
  {
    const fake = makeFakeXhr();
    let rejected = null;
    try {
      await T.uploadWithProgress({
        url: 'u', formData: {}, xhrFactory: fake.factory,
        signal: { aborted: true },
      });
    } catch (e) { rejected = e; }
    ok(rejected && rejected.name === 'AbortError', 'transport: an already-aborted signal rejects with AbortError');
    eq(fake.state.opened, null, 'transport: nothing was opened for a pre-aborted signal');
  }

  // B4 — abort MID-flight calls xhr.abort and rejects as AbortError
  {
    const fake = makeFakeXhr();
    let listener = null;
    const signal = {
      aborted: false,
      addEventListener: (type, cb) => { if (type === 'abort') listener = cb; },
      removeEventListener: () => { listener = null; },
    };
    const promise = T.uploadWithProgress({ url: 'u', formData: {}, signal, xhrFactory: fake.factory });
    ok(typeof listener === 'function', 'transport: subscribes to the abort signal');
    signal.aborted = true;
    listener();
    let rejected = null;
    try { await promise; } catch (e) { rejected = e; }
    ok(rejected && rejected.name === 'AbortError', 'transport: a mid-flight abort rejects with AbortError');
    ok(fake.state.aborted === true, 'transport: the underlying XHR is actually aborted');
    ok(listener === null, 'transport: the abort listener is removed (no leak)');
  }

  // B5 — network + timeout
  {
    const fake = makeFakeXhr();
    const promise = T.uploadWithProgress({ url: 'u', formData: {}, xhrFactory: fake.factory });
    fake.state.xhr.fail();
    let err = null;
    try { await promise; } catch (e) { err = e; }
    ok(err && err.code === 'NETWORK', 'transport: a connection failure surfaces as NETWORK');
  }
  {
    const fake = makeFakeXhr();
    const promise = T.uploadWithProgress({ url: 'u', formData: {}, timeoutMs: 5000, xhrFactory: fake.factory });
    eq(fake.state.xhr.timeout, 5000, 'transport: the timeout is applied to the XHR');
    fake.state.xhr.timeOut();
    let err = null;
    try { await promise; } catch (e) { err = e; }
    ok(err && err.code === 'TIMEOUT', 'transport: a timeout surfaces as TIMEOUT');
  }
  {
    // No artificial limit unless asked: 0 means "the server decides".
    const fake = makeFakeXhr();
    const promise = T.uploadWithProgress({ url: 'u', formData: {}, xhrFactory: fake.factory });
    eq(fake.state.xhr.timeout, 0, 'transport: no default timeout is imposed');
    fake.state.xhr.succeed(200, '{}');
    await promise;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Part C — wiring pins
  // ══════════════════════════════════════════════════════════════════════════
  console.log('── Part C: wiring ──');

  const client = code(read('src/client/php.ts'));
  const api = code(read('src/lib/api.ts'));
  const editor = code(read('src/app/(app)/lesson-editor/[id].tsx'));
  const component = code(read('src/components/MaterialUploadProgress.tsx'));
  const i18n = read('src/lib/i18n/resources.ts');

  // C1 — the storage client: one contract, two transports
  ok(/uploadWithProgress\(/.test(client), 'client: routes progress uploads through the XHR transport');
  ok(/if \(typeof opts\?\.onProgress === 'function'\)/.test(client),
    'client: only takes the XHR path when progress is actually wanted');
  ok(/isSecurityLocked\(\)/.test(client) && client.indexOf('isSecurityLocked()') < client.indexOf('uploadWithProgress('),
    'client: the security lock is still checked BEFORE any upload starts');
  ok(/upload_empty/.test(client), 'client: a zero-byte response is still a failure, not a success');
  ok(/AbortError/.test(client) && /ABORT_ERR/.test(client),
    'client: an abort keeps its identity so the UI can say "cancelled"');
  ok(/onProgress/.test(client) && /signal/.test(client), 'client: exposes progress + cancellation to callers');

  // C2 — the API wrapper: bytes ≠ server confirmation
  ok(/createUploadTracker\(/.test(api), 'api: uses the shared tracker for materials');
  ok(/report\('verifying'\)/.test(api), 'api: verifies the stored file as a distinct stage after transfer');
  ok(/onProgress\?: \(snapshot: UploadProgressSnapshot\)/.test(api),
    'api: uploadLessonMaterial accepts a progress callback');
  ok(/signal\?: UploadCancelSignal \| null/.test(api), 'api: uploadLessonMaterial accepts a cancel signal');
  ok(/replaceLessonMaterialFile[\s\S]{0,900}options\?: \{[\s\S]{0,300}onProgress/.test(api)
    && /replaceLessonMaterialFile[\s\S]{0,900}options\?: \{[\s\S]{0,300}signal\?: UploadCancelSignal/.test(api),
    'api: replace forwards the same progress/cancel options');
  ok(/replaceLessonMaterialFile[\s\S]{0,1200}declaredSizeSource\?: DeclaredSizeSource/.test(api),
    'api: replace forwards the declared-size provenance too');
  ok(!/fetch\(fileUri\)/.test(api), 'api: still never reads the picked file through fetch() (zero-byte incident)');

  // C3 — the editor
  ok(/from '@\/components\/MaterialUploadProgress'/.test(editor), 'editor: renders the progress card');
  ok(/<MaterialUploadProgress/.test(editor), 'editor: the card is mounted in the materials tab');
  ok(/onCancel=\{cancelMaterialTransfer\}/.test(editor), 'editor: the card can cancel the transfer');
  ok(/materialAbortRef\.current\?\.abort\(\)/.test(editor), 'editor: cancel aborts only the registered transfer');
  ok(/if \(materialAbortRef\.current\) return;/.test(editor),
    'editor: a second tap cannot start a duplicate transfer');
  ok(/classifyUploadFailure\(/.test(editor), 'editor: failures are mapped to actionable wording');
  ok(/isActiveStage\(materialTransfer\.snapshot\.stage\)/.test(editor),
    'editor: the upload button is disabled while a transfer is active');
  ok(/disabled=\{uploading \|\|/.test(editor), 'editor: the existing busy flag still disables the button');

  // C4 — the card itself
  ok(/stageMessageKey\(snapshot\.stage\)/.test(component), 'card: shows the real stage, not a hard-coded label');
  ok(/percent/.test(component) && /%</.test(component), 'card: shows the percentage');
  ok(/formatByteCount\(snapshot\.bytesSent\)/.test(component), 'card: shows transferred bytes');
  ok(/snapshot\.speedBps/.test(component), 'card: shows transfer speed');
  ok(/snapshot\.etaSeconds/.test(component), 'card: shows an ETA when one is known');
  ok(/direction: isRTL \? 'rtl' : 'ltr'/.test(component), 'card: lays out correctly in Arabic RTL');

  // C5 — every message key exists in BOTH locales
  const keys = [
    'lessonEditor.upload.preparing',
    'lessonEditor.upload.verifyingStored',
    'lessonEditor.upload.saving',
    'lessonEditor.upload.cancelled',
    'lessonEditor.upload.cancel',
    'lessonEditor.upload.dismiss',
    'lessonEditor.upload.retryHint',
    'lessonEditor.upload.progressDetail',
    'lessonEditor.upload.speed',
    'lessonEditor.upload.etaSeconds',
    'lessonEditor.upload.etaMinutes',
    'lessonEditor.upload.transferTimedOut',
    'lessonEditor.upload.networkError',
    'lessonEditor.upload.sessionExpired',
    'lessonEditor.upload.tooLarge',
    'lessonEditor.upload.tooManyRequests',
    'lessonEditor.upload.serverError',
  ];
  for (const key of keys) {
    const matches = i18n.split(`'${key}':`).length - 1;
    ok(matches === 2, `i18n: ${key} exists in both locales (found ${matches})`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.error('\nFailures:');
    for (const f of failures) console.error('  - ' + f);
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('suite crashed:', e);
  process.exit(1);
});
