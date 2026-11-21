#!/usr/bin/env node
/**
 * fileTransferStreaming.test.cjs — the wire contract of every file transfer.
 *
 * Run: node tests/fileTransferStreaming.test.cjs
 *
 * This pins the properties an optimisation may not silently lose while it makes
 * transfers faster:
 *
 *   UPLOAD    the file is streamed from disk by the native networking layer (a
 *             `{uri}` FormData part), never read into JS memory or Base64;
 *             progress comes from `xhr.upload.onprogress` (real bytes);
 *             an abort is distinguishable from a dropped connection.
 *   DOWNLOAD  native transfers go straight to the file system
 *             (`createDownloadResumable`); a failure is never a "success";
 *             the web path reads a stream, not a Blob, for progress.
 *   SERVER    private/public objects are STREAMED with Content-Length and range
 *             support; the PDF delivery path is unchanged (watermark, 24 h, audit).
 *
 * The byte-range parser itself is exercised for real by
 * `backend/tests/http/byte_range_tests.php`; this file is the cross-layer contract.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CLIENT = read('src/client/php.ts');
const TRANSPORT = read('src/lib/uploadTransport.ts');
const UPLOAD_PART = read('src/lib/uploadPart.ts');
const LESSON = read('src/app/(app)/lesson/[id].tsx');
const API = read('src/lib/api.ts');
const RESPONSE = read('backend/src/Http/Response.php');
const STORAGE = read('backend/src/Controllers/StorageController.php');
const DELIVERY = read('backend/src/Controllers/MaterialDeliveryController.php');
const CORS = read('backend/src/Middleware/CorsMiddleware.php');

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

console.log('── 1. Upload: bytes leave the device without entering JS memory ──');
check('1a a native upload is a {uri} FormData part (streamed from disk)', () => {
  assert.match(CLIENT, /formData\.append\('file', \{\s*\n\s*uri: part\.value\.uri/);
  assert.match(UPLOAD_PART, /kind: 'descriptor'/);
});
check('1b Base64 is never used to carry an upload body', () => {
  assert.ok(!/base64/i.test(UPLOAD_PART), 'uploadPart must not mention base64');
  const uploadFn = CLIENT.slice(CLIENT.indexOf('function createStorageBucket'));
  assert.ok(!/base64/i.test(uploadFn), 'the storage upload path must not base64 the body');
});
check('1c an ArrayBuffer upload is refused on native (RN cannot build that part)', () => {
  assert.match(UPLOAD_PART, /Creating blobs from 'ArrayBuffer'/);
  assert.match(UPLOAD_PART, /platform === 'web'/);
});
check('1d real byte progress comes from xhr.upload.onprogress', () => {
  assert.match(TRANSPORT, /xhr\.upload\.onprogress = \(event\) =>/);
  assert.match(TRANSPORT, /bytesSent: loaded/);
  assert.match(CLIENT, /onProgress: opts\.onProgress/);
});
check('1e the body-finished moment is separate from the server answer', () => {
  assert.match(TRANSPORT, /xhr\.upload\.onload = \(\) =>/);
});
check('1f cancelling is its own outcome, not a network error', () => {
  assert.match(TRANSPORT, /err\.name = 'AbortError'/);
  assert.match(CLIENT, /cancelled \? 'ABORT_ERR'/);
});
check('1g a non-idempotent upload is never auto-retried', () => {
  assert.ok(!/retry/i.test(CLIENT.slice(CLIENT.indexOf('function createStorageBucket'), CLIENT.indexOf('getPublicUrl'))));
});
check('1h the material upload reports preparing → uploading → verifying', () => {
  assert.match(API, /report\('preparing'\)/);
  // `uploading` is set from the byte callback, not by report(), because it must
  // only ever exist once real bytes have moved.
  assert.match(API, /tracker\.setStage\('uploading'\)/);
  assert.match(API, /report\('verifying'\)/);
});

console.log('── 2. Download: straight to storage, never through a JS string ──');
check('2a native downloads use expo-file-system, not fetch+Blob', () => {
  assert.match(LESSON, /createDownloadResumable/);
  assert.match(LESSON, /await task\.downloadAsync\(\)/);
});
check('2b the downloaded file is verified before it is reported complete', () => {
  assert.match(LESSON, /verifyStoredDownload\(\{/);
  assert.match(LESSON, /'The downloaded file is incomplete\. Please try again\.'/);
});
check('2c progress is indeterminate when the total is unknown (never invented)', () => {
  assert.match(LESSON, /indeterminate: !snap\.determinate/);
  assert.match(LESSON, /lesson\.sizeUnknown/);
});
check('2d the web path streams the response body', () => {
  assert.match(LESSON, /res\.body\?\.getReader\?\.\(\)/);
});
check('2e no Base64 download anywhere in the lesson screen', () => {
  assert.ok(!/base64/i.test(LESSON));
});

console.log('── 3. Server: stream with a length and honour ranges ──');
check('3a Response::file advertises Accept-Ranges and sets Content-Length', () => {
  assert.match(RESPONSE, /header\('Accept-Ranges: bytes'\)/);
  assert.match(RESPONSE, /header\('Content-Length: ' \. \$bytes\)/);
});
check('3b a partial response is 206 with Content-Range', () => {
  assert.match(RESPONSE, /http_response_code\(\$partial \? 206 : 200\)/);
  assert.match(RESPONSE, /Content-Range: bytes ' \. \$start/);
});
check('3c an unsatisfiable range is 416, not a silent full body', () => {
  assert.match(RESPONSE, /range_not_satisfiable/);
  assert.match(RESPONSE, /Content-Range: bytes \*\/' \. \$bytes/);
});
check('3d both generic download routes stream', () => {
  const from = (marker) => STORAGE.slice(STORAGE.indexOf(marker), STORAGE.indexOf('public function upload'));
  assert.ok(from('public function publicFile').includes('Response::file($file'));
  assert.ok(from('public function signedFile').includes('Response::file($file'));
});
check('3e the private lesson-PDF route keeps streaming and its no-store policy', () => {
  assert.match(DELIVERY, /Response::file\(/);
  assert.match(DELIVERY, /Cache-Control' => 'private, no-store, max-age=0'/);
});
check('3f no download route reads a whole file into memory', () => {
  for (const [name, src] of [['StorageController', STORAGE], ['MaterialDeliveryController', DELIVERY]]) {
    assert.ok(!/Response::raw\(\(string\) file_get_contents/.test(src), `${name} still buffers a body`);
  }
});
check('3g Content-Length / ranges are readable cross-origin', () => {
  assert.match(CORS, /Access-Control-Expose-Headers:[^']*Content-Length/);
  assert.match(CORS, /Access-Control-Expose-Headers:[^']*Accept-Ranges/);
});

console.log('── 4. Nothing about authorization or the forensic system moved ──');
check('4a the signed-file route still verifies the HMAC and expiry before streaming', () => {
  const body = STORAGE.slice(STORAGE.indexOf('public function signedFile'));
  assert.ok(body.indexOf('hash_equals') < body.indexOf('Response::file'));
  assert.ok(body.indexOf("Link expired") < body.indexOf('Response::file'));
});
check('4b lesson PDFs are still refused by the generic storage routes', () => {
  assert.match(STORAGE, /material_delivery_required/);
});
check('4c the personalized-PDF authorization and audit are unchanged', () => {
  assert.match(DELIVERY, /canAccess\(\$studentId, \$role, 'lesson-materials'/);
  assert.match(DELIVERY, /material_pdf_delivered/);
  assert.match(DELIVERY, /recordDownload/);
});
check('4d watermarking is still unconditional', () => {
  assert.match(DELIVERY, /private function shouldWatermark\(string \$role\): bool\s*\{\s*unset\(\$role\)/);
});
check('4e no transfer code path skips the security lock', () => {
  assert.match(CLIENT, /isSecurityLocked\(\)/);
  assert.match(CLIENT, /Upload blocked by the active security lock/);
});

console.log(`\n${passed} assertions passed${failures.length ? ` — ${failures.length} FAILED` : ''}.`);
if (failures.length) {
  failures.forEach((f) => console.log(`  ✗ ${f}`));
  process.exitCode = 1;
}
