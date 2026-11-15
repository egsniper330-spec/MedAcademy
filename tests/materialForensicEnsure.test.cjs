#!/usr/bin/env node
/**
 * tests/materialForensicEnsure.test.cjs — MaterialForensicPdfService::ensure()
 * streamed upload, master reuse, concurrency coordination and the 24-hour
 * personalized-copy contract.
 *
 * PHP cannot run in this suite, so verification is two-layered and labelled as
 * such in the report:
 *   • SOURCE assertions over the real PHP that pin each invariant (no full-file
 *     memory read, streamed upload, marker identity, flock, fail-closed expiry);
 *   • a small PURE MODEL of the two decisions that can be reasoned about exactly
 *     — "is this remembered master reusable?" and "is this copy still inside its
 *     24 h window?" — executed at the boundaries, because a boundary is where
 *     this contract actually breaks.
 *
 * Run: node tests/materialForensicEnsure.test.cjs
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
const failures = [];

function ok(condition, label, detail) {
  if (condition) {
    passed += 1;
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

function codeOf(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/^[ \t]*#(?!\[).*$/gm, '');
}

const SERVICE = read('backend/src/Services/MaterialForensicPdfService.php');
const CLIENT = read('backend/src/Services/PdfForensicClient.php');
const VARIANTS = read('backend/src/Services/MaterialPdfVariantService.php');
const CLEANUP = read('backend/scripts/forensic-cleanup.php');
const CODE = { service: codeOf(SERVICE), client: codeOf(CLIENT), variants: codeOf(VARIANTS) };

/* ═════════════════ 1. no full-file memory read, streamed upload ═══════════ */
section('1. source handling in ensure()');

const ensureBody = CODE.service.slice(
  CODE.service.indexOf('public function ensure('),
  CODE.service.indexOf('public function recordDownload('),
);

ok(ensureBody.length > 500, 'ensure() found in the service source');
ok(!/file_get_contents\(\$sourceAbs\)/.test(CODE.service),
  'the source PDF is never loaded into PHP memory');
ok(!/hash\('sha256', \$bytes\)/.test(CODE.service),
  'the source hash no longer comes from a buffered byte string');
ok(/sourceHashFor\(\$material, \$sourceAbs\)/.test(ensureBody),
  'the digest comes from the STREAMED (and cached) sourceHashFor() path');
ok(/uploadOriginalFile\(\$materialId, \$versionId, \$sourceHash, \$sourceAbs\)/.test(CODE.service),
  'the original is uploaded straight from disk');
ok(!/uploadOriginal\(\$materialId, \$versionId, \$sourceHash, \$bytes\)/.test(CODE.service),
  'the buffered uploadOriginal() is no longer used by the delivery path');

ok(/function uploadOriginalFile\(/.test(CODE.client), 'PdfForensicClient::uploadOriginalFile exists');
ok(/hash_file\('sha256', \$path\) !== \$sha256/.test(CODE.client),
  'the streamed upload still verifies the bytes against the expected SHA-256 BEFORE sending');
ok(/MAX_SOURCE_BYTES/.test(CODE.client) && /source_too_large/.test(CODE.client),
  'the streamed upload keeps the size bound');
ok(/source_unreadable|source_empty/.test(CODE.client),
  'unreadable/empty sources fail closed instead of sending a broken body');
ok(/CURLOPT_UPLOAD, true/.test(CODE.client) && /CURLOPT_INFILE/.test(CODE.client),
  'the body is a cURL upload stream, not a PHP string');

ok(/if \(\$size <= 0\)[\s\S]{0,120}ApiException\(422/.test(ensureBody),
  'an empty source is refused (422), never personalized');

/* ═════════════════════ 2. master reuse decision ══════════════════════════ */
section('2. master reuse');

ok(/private function issueWithReusableMaster\(/.test(CODE.service), 'reuse decision is a dedicated step');
ok(/sourcePublished\(\$marker, \$materialId, \$versionId, \$sourceHash\)/.test(CODE.service),
  'reuse is keyed on material + version + source hash');
ok(/\(\$decoded\['material_id'\] \?\? null\) === \$materialId[\s\S]{0,300}\$decoded\['source_sha256'\] \?\? null\) === \$sourceHash/.test(CODE.service),
  'the marker must match the material, version AND the full hash');
ok(/PdfForensicClient::sourceKey\(\$materialId, \$versionId, \$sourceHash\)/.test(CODE.service),
  'the marker’s storage key is re-derived, never trusted verbatim');
ok(/function markSourcePublished[\s\S]{0,900}rename\(\$tmp, \$marker\)/.test(CODE.service),
  'the marker is written atomically (temp + rename)');
ok(/preg_match\('\/\^\[0-9a-f\]\{64\}\$\/', \$sourceHash\)/.test(ensureBody),
  'a digest that is not a real SHA-256 aborts before anything is reused');
ok(/versionId = substr\(\$sourceHash, 0, 32\)/.test(ensureBody),
  'the version id is derived from the source hash (a replaced source is a new version)');

/* ═══════════════════ 3. concurrency coordination (flock) ══════════════════ */
section('3. per-source coordination');

ok(/flock\(\$handle, LOCK_EX \| LOCK_NB\)/.test(CODE.service),
  'publication is serialized with a non-blocking advisory lock');
ok(/hash\('sha256', \$materialId \. '\|' \. \$versionId\)/.test(CODE.service),
  'the lock is per material+version (unrelated documents never serialize)');
ok(/finally \{[\s\S]{0,400}flock\(\$handle, LOCK_UN\)/.test(CODE.service),
  'the lock is released on success AND on any exception path');
ok(/SOURCE_LOCK_WAIT_SECONDS/.test(CODE.service),
  'the wait is bounded; the descriptor closes if the process dies (no stale lock file)');
ok(/if \(\$this->sourcePublished\(\$marker/.test(CODE.service),
  'the reuse decision is re-checked UNDER the lock (no duplicate publication)');
ok(/if \(\$handle === false\)[\s\S]{0,220}\$publish\(\);/.test(CODE.service),
  'a missing lock never fails a delivery (upstream calls are idempotent)');
ok(/awaitIssuance\(\$client, \$identity, true\)/.test(CODE.service),
  'a remembered master is verified by asking for the issuance (no blind trust)');
ok(/forensic_master_missing/.test(CODE.service) && /clearSourceMarker\(\$marker\)/.test(CODE.service),
  'a stale master drops the marker and re-publishes the source');
ok(/master_not_ready/.test(CODE.service) && /POLL_SLEEP_MICROSECONDS/.test(CODE.service),
  'master_not_ready keeps bounded polling once the source has been published');

// ── pure model of the marker decision ──────────────────────────────────────
function sourceKey(materialId, versionId, sha) {
  return 'originals/' + materialId + '/' + versionId + '/' + sha + '.pdf';
}

/** Mirror of sourcePublished() + issueWithReusableMaster()'s decision. */
function decide(remembered, want, masterOnService) {
  const matches = Boolean(remembered)
    && remembered.material_id === want.materialId
    && remembered.version_id === want.versionId
    && remembered.source_sha256 === want.sha
    && remembered.source_key === sourceKey(want.materialId, want.versionId, want.sha);
  if (!matches) return 'publish';
  if (!masterOnService) return 'publish'; // marker stale → verified by the service, then re-publish
  return 'reuse';
}

const WANT = { materialId: 'm-1', versionId: 'abc123', sha: 'a'.repeat(64) };
const MEMO = {
  material_id: 'm-1',
  version_id: 'abc123',
  source_sha256: 'a'.repeat(64),
  source_key: sourceKey('m-1', 'abc123', 'a'.repeat(64)),
};

ok(decide(null, WANT, true) === 'publish', 'first delivery publishes the source');
ok(decide(MEMO, WANT, true) === 'reuse', 'a matching, still-valid master is reused (no re-upload)');
ok(decide(MEMO, WANT, false) === 'publish', 'a master the service no longer has is re-published');
ok(decide({ ...MEMO, source_sha256: 'b'.repeat(64) }, WANT, true) === 'publish',
  'a different source hash is never reused');
ok(decide({ ...MEMO, version_id: 'other' }, WANT, true) === 'publish',
  'a different version is never reused');
ok(decide({ ...MEMO, source_key: 'originals/m-1/abc123/' + 'c'.repeat(64) + '.pdf' }, WANT, true) === 'publish',
  'a marker whose key does not match its own identity is rejected');
ok(decide({ ...MEMO, material_id: 'm-2' }, WANT, true) === 'publish',
  'a marker from another material is never reused (replaced material ⇒ new master)');

/* ═══════════════ 4. 24-hour retention contract (strict) ═══════════════════ */
section('4. 24-hour personalized-copy retention');

const existingBody = CODE.variants.slice(
  CODE.variants.indexOf('public function existing('),
  CODE.variants.indexOf('public function touchServed('),
);

ok(/created_at >= \?/.test(existingBody) && /time\(\) - 86400/.test(existingBody),
  'a personalized copy is only reused inside 86400 s of its creation');
ok(/FROM lesson_material_pdfs/.test(existingBody) && !/suppress/i.test(existingBody),
  'expiry is filtered in SQL, so cleanup lag can never serve an expired copy');
ok(/row\['source_hash'\]/.test(existingBody) && /sourceHashFor\(/.test(existingBody),
  'a copy whose source changed is treated as absent (regenerated)');
ok(/file_size/.test(existingBody) && /filesize\(\$copyAbs\)/.test(existingBody),
  'a truncated stored copy is never served');
const touchBody = CODE.variants.slice(
  CODE.variants.indexOf('public function touchServed('),
  CODE.variants.indexOf('public function sourceHashFor('),
);
ok(touchBody.length > 0 && !/UPDATE|query\(|insert/.test(touchBody),
  'serving a copy performs no write — expiry stays fixed at 24 h from publication');
ok(/gmdate\('Y-m-d H:i:s', \(int\) \(\$result\['expires_at'\] \?\? \(time\(\) \+ 86400\)\)\)/.test(CODE.service),
  'the issuance row records the service’s absolute expiry');
ok(/ON DUPLICATE KEY UPDATE[\s\S]{0,600}expires_at = VALUES\(expires_at\)/.test(CODE.service),
  'reuse refreshes the ROW, but the expiry written is the one the service published (not now+24 h)');
ok(/expires_at > \?/.test(CODE.service) && /purged_at/.test(CODE.service),
  'an expired or purged copy cannot be attributed, so it is not served');
ok(!/DELETE FROM pdf_forensic_issuances/.test(CODE.service) && !/DELETE FROM pdf_forensic_issuances/.test(CLEANUP),
  'cleanup never deletes the issuance mapping (forensic history survives)');
ok(/UPDATE pdf_forensic_issuances[\s\S]{0,260}'expired', gmdate\('Y-m-d H:i:s'\)/.test(CLEANUP),
  'expired copies are recorded as expired + purged, not silently forgotten');
ok(/MaterialForensicPdfService::BUCKET/.test(CLEANUP) && /storage->delete\(MaterialForensicPdfService::BUCKET, \$rel\)/.test(CLEANUP),
  'cleanup physically removes only the personalized copy from the variant bucket');
ok(!/lesson-materials/.test(CLEANUP),
  'cleanup never touches the original uploads bucket (originals are separate)');
ok(!/masters\/|manifest\.json/.test(CLEANUP),
  'cleanup never touches master pages (they are the reusable, non-expiring asset)');
ok(/strpos\(\$rel, '\.\.'\) === false/.test(CLEANUP),
  'cleanup refuses any path containing traversal');

/** Model of the retention window: [publishedAt, publishedAt + 24 h). */
const DAY = 86400;
function copyState(publishedAt, now, storedExists = true) {
  if (!storedExists) return 'regenerate';
  return now < publishedAt + DAY ? 'reuse' : 'regenerate';
}
const T0 = 1_800_000_000;
ok(copyState(T0, T0) === 'reuse', 'a brand-new copy is immediately reusable');
ok(copyState(T0, T0 + DAY - 1) === 'reuse', 'one second before expiry the SAME copy is reused');
ok(copyState(T0, T0 + DAY) === 'regenerate', 'at exactly 24 h the old copy is NOT served');
ok(copyState(T0, T0 + DAY + 1) === 'regenerate', 'after expiry a fresh copy is generated');
ok(copyState(T0, T0 + 60, false) === 'regenerate', 'a missing stored file is regenerated, not served');
ok(copyState(T0, T0 + 5) === copyState(T0, T0 + 300),
  'reads inside the window never change the decision (no sliding expiry)');

/* ── summary ─────────────────────────────────────────────────────────────── */
console.log('\n── ' + (failures.length ? 'FAILURES' : 'all assertions passed') + ' ──');
if (failures.length) console.log(failures.join('\n'));
console.log(`${passed} assertions passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
