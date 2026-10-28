#!/usr/bin/env node
/**
 * webUploadPart.test.cjs — the browser must upload the FILE, not a stringified
 * descriptor.
 *
 * THE PRODUCTION FAILURE PINNED HERE
 * ─────────────────────────────────
 * A Doctor upload on the web build always failed with "فشل الرفع" and a size of
 * 679 / 777 / 790 bytes for a real 142 786-byte PDF. Instrumenting the running
 * preview showed why:
 *
 *   partKind: "[object String]"   partName: "[object Object]"   partSize: null
 *   POST …/storage/upload → 400 {"error":{"code":"upload_missing"}}
 *
 * `toUploadPart()` returns the `{ uri, name, type }` descriptor, which only
 * React Native understands (its networking layer streams the file from that
 * URI). On web `FormData.append('file', {uri})` follows the HTML spec and
 * stringifies the object, so no file part existed at all. The number shown to
 * the doctor was the size of the MULTIPART BODY, not the document — which is
 * why it never matched the 140 KB source and why the earlier "picker metadata"
 * theory fit the numbers without being the cause.
 *
 * `resolveUploadPart()` fetches the picker's `blob:` URL on web and appends the
 * real bytes; native keeps the descriptor path untouched.
 *
 * Run: node tests/webUploadPart.test.cjs
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? `  [${detail}]` : '')); }
}
function section(name) { console.log('\n── ' + name + ' ──'); }

/* Compile the module under test (no bundler, real code). */
const BUILD = fs.mkdtempSync(path.join(os.tmpdir(), 'upart-'));
execFileSync(
  process.execPath,
  [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(ROOT, 'src/lib/uploadPart.ts'),
    '--outDir', BUILD,
    '--module', 'commonjs',
    '--target', 'es2020',
    '--skipLibCheck',
    '--noEmitOnError', 'false',
  ],
  { stdio: 'pipe' },
);
const { resolveUploadPart, toUploadPart } = require(path.join(BUILD, 'uploadPart.js'));

/** A Blob stand-in with real byte accounting (Node 18+ has Blob anyway). */
function blobOf(size, type = 'application/pdf') {
  return new Blob([new Uint8Array(size)], { type });
}

async function main() {
  const PDF_SIZE = 142_786; // the failing Downloads/file.pdf
  const blobUrl = 'blob:http://localhost:8081/9f3c';

  // ══════════════════════════════════════════════════════════════════════════
  section('1. Web: a descriptor becomes the real bytes');
  // ══════════════════════════════════════════════════════════════════════════
  let fetched = null;
  let part = await resolveUploadPart(
    { uri: blobUrl, name: 'file.pdf', mimeType: 'application/pdf' },
    'web',
    async (uri) => { fetched = uri; return blobOf(PDF_SIZE); },
  );
  check('the picker URI is fetched', fetched === blobUrl, String(fetched));
  check('a Blob is appended, not an object', part.kind === 'blob', part.kind);
  check('the part carries the whole document', part.kind === 'blob' && part.value.size === PDF_SIZE,
    part.kind === 'blob' ? String(part.value.size) : 'n/a');
  check('it is a File with the original name',
    part.kind === 'blob' && part.value.name === 'file.pdf', part.kind === 'blob' ? part.value.name : 'n/a');
  check('and the PDF content type',
    part.kind === 'blob' && part.value.type === 'application/pdf',
    part.kind === 'blob' ? part.value.type : 'n/a');

  // A File input (some callers already hold one) goes straight through.
  part = await resolveUploadPart(new File([new Uint8Array(2048)], 'a.pdf', { type: 'application/pdf' }), 'web');
  check('a File is passed through untouched', part.kind === 'blob' && part.value.size === 2048);

  // ══════════════════════════════════════════════════════════════════════════
  section('2. Web failures are explicit, never a silent empty part');
  // ══════════════════════════════════════════════════════════════════════════
  part = await resolveUploadPart(
    { uri: blobUrl, name: 'file.pdf', mimeType: 'application/pdf' },
    'web',
    async () => blobOf(0),
  );
  check('a 0-byte blob is refused before it reaches the server',
    part.kind === 'error' && /0 bytes/.test(part.message), part.kind === 'error' ? part.message : part.kind);

  part = await resolveUploadPart(
    { uri: 'blob:revoked', name: 'file.pdf', mimeType: 'application/pdf' },
    'web',
    async () => { throw new Error('Failed to fetch'); },
  );
  check('an unreadable URI reports what to do',
    part.kind === 'error' && /Pick it again/.test(part.message),
    part.kind === 'error' ? part.message : part.kind);

  // ══════════════════════════════════════════════════════════════════════════
  section('3. Native is unchanged (the descriptor IS the transport value)');
  // ══════════════════════════════════════════════════════════════════════════
  let statCalled = false;
  part = await resolveUploadPart(
    { uri: 'file:///cache/report.pdf', name: 'report.pdf', mimeType: 'application/pdf' },
    'android',
    async () => { statCalled = true; return blobOf(PDF_SIZE); },
  );
  check('android keeps the { uri } descriptor', part.kind === 'descriptor' && part.value.uri === 'file:///cache/report.pdf');
  check('and never fetches the file into JS memory', statCalled === false);

  part = await resolveUploadPart({ uri: 'content://doc/1', name: 'x.pdf' }, 'ios', async () => blobOf(10));
  check('ios keeps the descriptor too', part.kind === 'descriptor');

  check('an ArrayBuffer on native is still refused with the RN explanation',
    (await resolveUploadPart(new ArrayBuffer(10), 'android')).kind === 'error');
  check('the sync helper still behaves as before (native descriptor)',
    toUploadPart({ uri: 'file:///a.pdf' }, 'android').kind === 'descriptor');

  // ══════════════════════════════════════════════════════════════════════════
  section('4. The storage client uses the resolver');
  // ══════════════════════════════════════════════════════════════════════════
  const client = read('src/client/php.ts');
  check('php.ts imports resolveUploadPart', /import \{ resolveUploadPart \} from '@\/lib\/uploadPart'/.test(client));
  check('php.ts awaits it before building FormData', /const part = await resolveUploadPart\(file, RNPlatform\.OS\)/.test(client));
  check('php.ts no longer appends a raw descriptor on web', !/const part = toUploadPart\(/.test(client));
  check('an unreadable part surfaces as a coded error', /code: 'upload_part_unreadable'/.test(client));

  console.log('\n' + '─'.repeat(60));
  if (failed > 0) {
    console.error(`${passed} passed, ${failed} FAILED`);
    process.exit(1);
  }
  console.log(`${passed} passed, 0 failed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
