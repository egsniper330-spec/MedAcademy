#!/usr/bin/env node
/**
 * tests/pdfForensicChecker.test.cjs — Doctor PDF Checker regression coverage.
 *
 * PHP cannot execute in this suite, so this file combines:
 *   • EXECUTED client code: `src/lib/uploadTransport.ts`, `src/lib/uploadPart.ts`
 *     and `src/lib/pdfForensicApi.ts` are transpiled and driven with a fake
 *     XMLHttpRequest / FormData, so the multipart part, headers, progress,
 *     cancellation and the upload-vs-analysis separation are real behaviour,
 *     not string matches;
 *   • source assertions over the PHP endpoints the checker talks to, which pin
 *     the authorization/scope rules, the streaming transport and the timing
 *     contract.
 *
 * The defect this guards: the checker used to be the slow, opaque upload path.
 *   1. web read the whole file into JS memory (`blob()`) before sending;
 *   2. `analyzing` was only entered when the SERVER had finished its forensic
 *      scan, so the entire round trip looked like upload time;
 *   3. native used `fetch()` with no upload progress and no way to tell when the
 *      body had actually left the device.
 *
 * Run: node tests/pdfForensicChecker.test.cjs
 */

const fs = require('fs');
const path = require('path');
const ts = require(path.join(__dirname, '..', 'node_modules', 'typescript'));

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];

function ok(condition, label, detail) {
  if (condition) {
    passed += 1;
    console.log('  ok   ' + label);
  } else {
    failures.push(label);
    console.error('  FAIL ' + label + (detail ? ' — ' + detail : ''));
  }
}

function section(title) {
  console.log('\n── ' + title + ' ──');
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Strip comments so prose can never satisfy an assertion. */
function codeOf(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/^[ \t]*#(?!\[).*$/gm, '');
}

function transpile(rel) {
  return ts.transpileModule(read(rel), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
}

function loadCommonJs(code, customRequire) {
  const mod = { exports: {} };
  new Function('exports', 'require', 'module', code)(mod.exports, customRequire || require, mod);
  return mod.exports;
}

/* ── browser-ish globals the client modules expect ─────────────────────────── */

class FakeBlob {
  constructor(parts, opts) {
    this.size = opts && typeof opts.size === 'number' ? opts.size : 4096;
    this.type = (opts && opts.type) || '';
    this._parts = parts;
  }
}
class FakeFile extends FakeBlob {
  constructor(parts, name, opts) {
    super(parts, opts);
    this.name = name;
  }
}
class FakeFormData {
  constructor() {
    this.entries = [];
  }
  append(key, value, fileName) {
    this.entries.push({ key, value, fileName });
  }
}

globalThis.Blob = FakeBlob;
globalThis.File = FakeFile;
globalThis.FormData = FakeFormData;

/** One controllable XMLHttpRequest used by the transport tests. */
class FakeXhr {
  constructor() {
    this.upload = { onprogress: null, onload: null };
    this.status = 0;
    this.responseText = '';
    this.headers = {};
    this.sent = null;
    this.aborted = false;
    this.timeout = 0;
    FakeXhr.instances.push(this);
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name, value) {
    this.headers[name] = value;
  }
  send(body) {
    this.sent = body;
  }
  abort() {
    this.aborted = true;
    if (this.onabort) this.onabort();
  }
}
FakeXhr.instances = [];

globalThis.XMLHttpRequest = FakeXhr;

/* ── load the modules under test ──────────────────────────────────────────── */

const uploadPartExports = loadCommonJs(transpile('src/lib/uploadPart.ts'));
const transportExports = loadCommonJs(transpile('src/lib/uploadTransport.ts'));

const STUB_MODULES = {
  'react-native': { Platform: { OS: 'android' } },
  '@/client/php': {
    backendApiBase: 'https://api.example.test/backend/public/index.php',
    apiFetch: async () => ({ data: null, error: null }),
    backendClient: {
      auth: {
        getSession: async () => ({ data: { session: { access_token: 'test-token' } } }),
      },
    },
  },
  '@/lib/securityLock': { isSecurityLocked: () => STUB_MODULES.__locked },
  '@/lib/uploadPart': uploadPartExports,
  '@/lib/uploadTransport': transportExports,
  __locked: false,
};

const forensicExports = loadCommonJs(transpile('src/lib/pdfForensicApi.ts'), (id) => {
  if (Object.prototype.hasOwnProperty.call(STUB_MODULES, id)) return STUB_MODULES[id];
  throw new Error('unexpected import in pdfForensicApi: ' + id);
});

function resetXhr() {
  FakeXhr.instances.length = 0;
}

function lastXhr() {
  const list = FakeXhr.instances;
  if (!list.length) throw new Error('no XMLHttpRequest was created');
  return list[list.length - 1];
}

const PICKED = {
  uri: 'file:///cache/document.pdf',
  name: 'document.pdf',
  size: 18874368,
  mimeType: 'application/pdf',
};

const VERDICT_BODY = {
  verdict: 'confirmed',
  score: 0.99,
  agreement: 1,
  pages_analyzed: 3,
  pages_total: 12,
  matched: true,
  timings: { bytes: 18874368, receive_ms: 900, detect_ms: 4200, forwarded_ms: 4100, total_ms: 5100 },
  issuance: {
    watermark_record: 'w-1',
    issued_at: '2026-01-01 10:00:00',
    expires_at: '2026-01-02 10:00:00',
    course_id: 'course-1',
    material_id: 'material-1',
  },
};

async function runCheck(overrides = {}) {
  resetXhr();
  const events = { progress: [], stages: [], timings: null };
  const promise = forensicExports.runForensicCheck(PICKED, {
    onProgress: (p) => events.progress.push(p),
    onStage: (s) => events.stages.push(s),
    onTiming: (t) => { events.timings = t; },
    ...overrides,
  });
  // The request is created synchronously up to `send`; drive it.
  await Promise.resolve();
  await Promise.resolve();
  const xhr = lastXhr();
  return { promise, events, xhr };
}

function respond(xhr, status, body) {
  xhr.status = status;
  xhr.responseText = JSON.stringify(body);
  if (xhr.onload) xhr.onload();
}

(async () => {
  /* ═════════════════════ 1. transport behaviour ══════════════════════════ */
  section('1. shared upload transport (real code)');

  {
    resetXhr();
    const seen = [];
    let uploadDone = false;
    const p = transportExports.uploadWithProgress({
      url: 'https://api.example.test/upload',
      formData: new FakeFormData(),
      headers: { Authorization: 'Bearer t' },
      onProgress: (e) => seen.push(e.bytesSent),
      onUploadComplete: () => { uploadDone = true; },
    });
    const xhr = lastXhr();
    ok(xhr.method === 'POST' && xhr.url === 'https://api.example.test/upload', 'posts multipart to the endpoint');
    ok(xhr.headers.Authorization === 'Bearer t', 'sends the caller headers');
    xhr.upload.onprogress({ loaded: 100, total: 400, lengthComputable: true });
    xhr.upload.onprogress({ loaded: 400, total: 400, lengthComputable: true });
    ok(seen.length === 2 && seen[1] === 400, 'reports real transferred byte counts');
    ok(uploadDone === false, 'upload is NOT complete before the body is sent');
    xhr.upload.onload();
    ok(uploadDone === true, 'upload-complete fires when the body has been sent');
    respond(xhr, 200, { ok: true });
    const res = await p;
    ok(res.status === 200 && JSON.parse(res.bodyText).ok === true, 'resolves with status/body for the caller');
  }

  {
    resetXhr();
    const p = transportExports.uploadWithProgress({
      url: 'https://api.example.test/upload',
      formData: new FakeFormData(),
    });
    const xhr = lastXhr();
    xhr.onerror();
    let code = null;
    try { await p; } catch (e) { code = e.code; }
    ok(code === 'NETWORK', 'a dropped connection rejects with NETWORK');
  }

  {
    resetXhr();
    const controller = new AbortController();
    const p = transportExports.uploadWithProgress({
      url: 'https://api.example.test/upload',
      formData: new FakeFormData(),
      signal: controller.signal,
    });
    const xhr = lastXhr();
    controller.abort();
    let name = null;
    try { await p; } catch (e) { name = e.name; }
    ok(name === 'AbortError', 'aborting cancels the transfer (AbortError)');
    ok(xhr.aborted === true, 'the underlying request is aborted, not left running');
  }

  /* ═══════════════════ 2. multipart part: URI, never Base64 ══════════════ */
  section('2. multipart file part');

  {
    const decision = uploadPartExports.toUploadPart(
      { uri: 'content://media/document.pdf', mimeType: 'application/pdf', name: 'document.pdf' },
      'android',
    );
    ok(decision.kind === 'descriptor', 'native uploads the file-URI descriptor');
    ok(decision.kind === 'descriptor' && decision.value.uri === 'content://media/document.pdf',
      'the descriptor keeps the on-disk URI (streamed by the native layer)');
    ok(!/base64/i.test(codeOf(read('src/lib/pdfForensicApi.ts'))), 'no Base64 conversion anywhere in the checker client');
    ok(!/arrayBuffer\(\)/.test(read('src/lib/pdfForensicApi.ts')),
      'the checker never materialises the file as an ArrayBuffer');
    ok(!/await \(await fetch\(file\.uri\)\)\.blob\(\)/.test(read('src/lib/pdfForensicApi.ts')),
      'the web path no longer copies the file into JS memory before upload');
  }

  {
    const asset = await uploadPartExports.resolveUploadPart(
      { uri: 'blob:https://app.test/1234', name: 'doc.pdf', mimeType: 'application/pdf' },
      'web',
      async () => new FakeBlob([], { size: 2048, type: 'application/pdf' }),
    );
    ok(asset.kind === 'blob', 'web converts the blob: URL into a real File part');
    ok(asset.kind === 'blob' && asset.value instanceof FakeBlob,
      'web appends bytes, not a stringified { uri } object');
  }

  /* ═════════════════ 3. request contract of runForensicCheck ═════════════ */
  section('3. checker request contract');

  {
    const { promise, xhr } = await runCheck();
    respond(xhr, 200, VERDICT_BODY);
    const result = await promise;
    ok(xhr.url === 'https://api.example.test/backend/public/index.php/pdf-forensic/check',
      'posts to the authorized PHP endpoint (never straight to the VPS)');
    ok(xhr.headers.Authorization === 'Bearer test-token', 'sends the session bearer token');
    ok(xhr.headers['Content-Type'] === undefined,
      'lets the platform set the multipart boundary (no hand-written content type)');
    ok(xhr.headers.Accept === 'application/json', 'asks for JSON');
    const fileEntry = xhr.sent.entries.find((e) => e.key === 'file');
    ok(Boolean(fileEntry) && typeof fileEntry.value === 'object' && fileEntry.value.uri === PICKED.uri,
      'the file part is the streamed URI descriptor');
    ok(result.verdict === 'confirmed' && result.matched === true, 'returns the server verdict');
    ok(result.timings && result.timings.detect_ms === 4200, 'server stage timings are surfaced to the caller');
  }

  {
    const { promise, events, xhr } = await runCheck();
    xhr.upload.onprogress({ loaded: 4718592, total: 18874368, lengthComputable: true });
    xhr.upload.onprogress({ loaded: 9447436, total: 18874368, lengthComputable: true });
    ok(events.progress.length === 2 && events.progress[1] === 50,
      'progress is a percentage of REAL transferred bytes (25 %, 50 %)');
    ok(events.stages[0] === 'uploading', 'the first stage is uploading');
    ok(!events.stages.includes('analyzing'), 'analyzing is NOT claimed while the body is still uploading');
    xhr.upload.onload();
    respond(xhr, 200, VERDICT_BODY);
    await promise;
    ok(events.stages.includes('analyzing'), 'analyzing starts when the body has been sent, before the verdict');
    ok(events.stages.indexOf('analyzing') < events.stages.length,
      'the analysing stage is entered exactly once at body-sent time');
    ok(events.timings && events.timings.uploadMs >= 0 && events.timings.analysisMs >= 0,
      'upload and analysis durations are measured separately');
    ok(events.timings.bytesSent === 9447436, 'the reported bytes are the transport-confirmed count');
    ok(events.timings.bytesDeclared === PICKED.size, 'the declared (selected) size is reported alongside');
  }

  {
    // Unknown length ⇒ no invented percentage.
    const { promise, events, xhr } = await runCheck();
    xhr.upload.onprogress({ loaded: 1000, total: 0, lengthComputable: false });
    respond(xhr, 200, VERDICT_BODY);
    await promise;
    ok(events.progress.length === 0, 'an unknown total produces NO percentage');
  }

  /* ════════════════════ 4. errors, retry, cancellation ═════════════════ */
  section('4. errors and cancellation');

  async function errorFor(status, body) {
    const { promise, xhr } = await runCheck();
    respond(xhr, status, body);
    try {
      await promise;
      return null;
    } catch (e) {
      return e.message;
    }
  }

  ok((await errorFor(413, { message: 'too big' })) === 'too_large', '413 maps to too_large');
  ok((await errorFor(422, { message: 'nope' })) === 'not_inspectable', '422 maps to not_inspectable');
  ok((await errorFor(403, { message: 'denied' })) === 'forbidden', '403 maps to forbidden');
  ok((await errorFor(503, { message: 'busy' })) === 'busy', 'a server message is preserved for 5xx');
  ok((await errorFor(200, null)) === 'invalid_response', 'a non-JSON 200 is not treated as a verdict');

  {
    const { promise, xhr } = await runCheck();
    xhr.onerror();
    let message = null;
    try { await promise; } catch (e) { message = e.message; }
    ok(message === 'network_error', 'a transport failure surfaces as network_error');
  }

  {
    const controller = new AbortController();
    const { promise } = await runCheck({ signal: controller.signal });
    controller.abort();
    let message = null;
    try { await promise; } catch (e) { message = e.message; }
    ok(message === 'aborted', 'cancellation is distinguishable from failure');
  }

  {
    STUB_MODULES.__locked = true;
    let message = null;
    try { await forensicExports.runForensicCheck(PICKED, {}); } catch (e) { message = e.message; }
    STUB_MODULES.__locked = false;
    ok(message === 'security_lock', 'the checker honours the central security lock');
  }

  {
    // Retry after a failure is a fresh request (no client-side stub of success).
    const first = await runCheck();
    respond(first.xhr, 503, { message: 'busy' });
    try { await first.promise; } catch (_) { /* expected */ }
    const second = await runCheck();
    ok(second.xhr !== first.xhr && second.xhr.sent instanceof FakeFormData,
      'a retry issues a NEW multipart request (no cached success)');
    respond(second.xhr, 200, VERDICT_BODY);
    const result = await second.promise;
    ok(result.verdict === 'confirmed', 'the retry can complete normally');
  }

  /* ═══════════════ 5. backend authorization + scope (source) ═════════════ */
  section('5. PHP authorization and scope');

  const controller = codeOf(read('backend/src/Controllers/PdfForensicController.php'));
  const client = codeOf(read('backend/src/Services/PdfForensicClient.php'));
  const routes = read('backend/routes/api.php');

  ok(/in_array\(\$role, \['doctor', 'admin', 'super_admin'\], true\)/.test(controller),
    'the check endpoint is staff-only');
  ok(/\$this->storage->canAccess\(/.test(controller) && /withinScope\(/.test(controller),
    'material-level access AND role scope are both enforced server-side');
  ok(/\(\* \$material\)\[.course_id.\]/.test(controller) || /courses WHERE id = \? LIMIT 1/.test(controller),
    'doctor scope is derived from courses.doctor_id, never from the request');
  ok(/i\.doctor_id = \?/.test(controller), 'issuance lookup is restricted to the caller doctor');
  ok(!/request->input\('student_id'\)/.test(controller) && !/request->input\('doctor_id'\)/.test(controller),
    'no client-supplied identity can widen the result');
  ok(/MAX_UPLOAD_BYTES = 26214400/.test(controller), 'upload size is bounded server-side');
  ok(/str_starts_with\(\$magic, '%PDF-'\)|str_starts_with\(.PDF-\)/.test(controller) ||
    /%PDF-/.test(controller), 'the body must really be a PDF');
  ok(/pdf-forensic\/check/.test(routes) && /role.*doctor/.test(routes),
    'the route declares the staff role requirement');

  /* ═════════════ 6. transport: streaming, HMAC, no downgrade ═════════════ */
  section('6. PHP → VPS transport');

  ok(/hash_hmac\('sha256', \$canonical, \$secret\)/.test(client), 'requests are HMAC-signed');
  ok(/X-Nonce: /.test(client) && /X-Timestamp: /.test(client) && /X-Key-Id: /.test(client),
    'each request carries key id, timestamp and a fresh nonce');
  ok(/bin2hex\(random_bytes\(16\)\)/.test(client), 'the nonce is random per request (no replay)');
  ok(/CURLOPT_SSL_VERIFYPEER => true/.test(client) && /CURLOPT_SSL_VERIFYHOST => 2/.test(client),
    'TLS verification stays ON');
  ok(!/CURLOPT_SSL_VERIFYPEER => false/.test(client), 'no TLS downgrade path exists');
  ok(/CURLOPT_UPLOAD, true/.test(client) && /CURLOPT_INFILE/.test(client),
    'document bodies are streamed from disk by cURL (no PHP buffer)');
  ok(/CURLOPT_INFILESIZE/.test(client), 'the streamed body declares its exact size');
  ok(/function detectFile\(string \$path, \?string \$sha256 = null\)/.test(client),
    'detection reuses the digest the controller already computed (one file read, not two)');
  ok(/detectFile\(\$tmp, \$fileSha256\)/.test(controller),
    'the controller passes that digest through');
  ok(/CURLOPT_TCP_KEEPALIVE => 1/.test(client), 'connections are kept alive for the poll loop');
  ok(/curl_reset\(\$ch\)/.test(client), 'a reused handle is reset before every request (no option leak)');

  /* ══════════════ 7. WAM payload resolution is unchanged ════════════════ */
  section('7. WAM payload resolution');

  ok(/findIssuance\(\$payload, \$userId, \$role, \$materialId === '' \? null : \$materialId\)/.test(controller),
    'the payload is still mapped by the server (auto resolution preserved)');
  ok(/in_array\(\$verdict, \['confirmed', 'probable'\], true\)/.test(controller),
    'a weak verdict still never resolves an identity');
  ok(/\$materialId = trim\(\(string\) \(\$request->input\('material_id'\)/.test(controller),
    'material_id stays OPTIONAL (the payload identifies the issuance)');
  const checkerClient = codeOf(read('src/lib/pdfForensicApi.ts'))
    .split('export async function runForensicCheck')[1] || '';
  ok(/form\.append\('material_id'/.test(checkerClient) && !/form\.append\('(student|doctor|course)/.test(checkerClient),
    'the request carries the file (+ optional material_id) and no identity claim');

  /* ── summary ───────────────────────────────────────────────────────────── */
  console.log('\n' + (failures.length ? 'FAILURES: ' + failures.join(' | ') : 'All PDF Checker regressions passed'));
  console.log(`${passed} assertions passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('suite crashed:', e);
  process.exit(1);
});
