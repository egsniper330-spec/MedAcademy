#!/usr/bin/env node
/**
 * rootAndIntegrityHardening.test.cjs — regression suite for the Android
 * root/runtime-hardening and server-side integrity work.
 *
 * Run: node tests/rootAndIntegrityHardening.test.cjs
 *
 * ─── WHAT THIS PINS, AND WHY EACH CHECK EXISTS ───────────────────────────────
 *
 * The native detectors live inside a template literal that Expo Config Plugins
 * write into android/ during prebuild, so they cannot be executed from Node and
 * there is no Kotlin compiler in CI. What CAN be pinned is the part that
 * actually broke before:
 *
 *   1. DEAD CHECKS. `Runtime.exec("which", "su")` could never succeed on
 *      Android (toybox has no `which`), and `/proc/modules` never carries a
 *      "zygisk" entry (Zygisk is a userspace injection). Both looked like
 *      coverage and provided none. The suite asserts they are gone and that the
 *      replacements (stat-based PATH probe, mount-view inspection) are present.
 *
 *   2. FALSE-POSITIVE CONTRACT. The mount-view rule must flag root-framework
 *      mounts and NOT flag ordinary mounts (tmpfs, app data binds, a plain ext4
 *      /data). The rule is re-implemented here as a mirror and exercised over
 *      both classes; the Kotlin source is asserted to contain the same
 *      conditions. (Mirror, not shared code: Kotlin cannot run in CI. If the
 *      rule changes, both copies must change — the static assertions below fail
 *      loudly if the Kotlin side drifts.)
 *
 *   3. CERTIFICATE ENCODING. Play Integrity reports
 *      appIntegrity.certificateSha256Digest as BASE64URL while
 *      security_config.expected_cert_sha256s holds HEX. Comparing them
 *      directly can never match, so either every genuine client is rejected
 *      (pin present) or the check does nothing. The normalisation is mirrored
 *      and tested; the PHP side is asserted to apply it to BOTH values.
 *
 *   4. TOKEN FRESHNESS + FAILURE TELEMETRY. A decoded token must be recent, and
 *      a rejection must be logged server-side with the failing check.
 *
 *   5. ISSUANCE COVERAGE. Personalised PDF minting must sit behind the same
 *      server-side tiered policy as playback (`material_pdf`), and the client
 *      must send the headers for it. A client-side cache that reuses one hash
 *      for a DIFFERENT action is also a real defect (the server rejects it), so
 *      the per-action cache is pinned too.
 *
 * Every assertion below reads a file on disk. Nothing here claims a device
 * test was performed.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  \u2705 ${name}`);
  } else {
    failed++;
    console.error(`  \u274c ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

// ─── Sources under test ──────────────────────────────────────────────────────

const PLUGIN = read('plugins/withSecurityModule.js');
const KT_MATCH = PLUGIN.match(/const SECURITY_MODULE_KT = `([\s\S]*?)\n`;\n/);
const KT = KT_MATCH ? KT_MATCH[1] : '';

const INTEGRITY_PHP = read('backend/src/Services/IntegrityService.php');
const EVIDENCE_PHP = read('backend/src/Services/SecurityEvidenceService.php');
const DELIVERY_PHP = read('backend/src/Controllers/MaterialDeliveryController.php');
const INTEGRITY_CLIENT = read('src/lib/integrityClient.ts');
const DEVICE_KEY = read('src/lib/deviceKey.ts');
const API_TS = read('src/lib/api.ts');
const NATIVE_TS = read('src/lib/nativeSecurity.ts');

// The Kotlin block around one function, bounded by the next `private fun`.
function ktFunction(name) {
  const start = KT.indexOf(`private fun ${name}(`);
  if (start < 0) return '';
  const rest = KT.slice(start + 1);
  const next = rest.search(/\n {4}(private )?(fun|data class|enum class|object|@ReactMethod)/);
  return next < 0 ? rest : rest.slice(0, next);
}

console.log('\n\u2500\u2500 Kotlin template extracted \u2500\u2500');
check('SecurityModule Kotlin template is present', KT.length > 1000, `extracted ${KT.length} chars`);

// ─── 1. Dead checks replaced ─────────────────────────────────────────────────

console.log('\n\u2500\u2500 1. Dead root checks are gone, real ones are wired \u2500\u2500');

const detectRoot = ktFunction('detectRoot');
check('detectRoot() exists', detectRoot.length > 0);
check('detectRoot() consults the mount view', /inspectMountView\(\)/.test(detectRoot));
check('detectRoot() consults the PATH probe', /suOnPath\(\)/.test(detectRoot));
check(
  'the dead `Runtime.exec("which su")` probe is removed',
  !/exec\(arrayOf\("which"/.test(KT) && !/whichSu/.test(KT),
);
check(
  'its replacement is stat-based (no subprocess)',
  /private fun suOnPath\(\)/.test(KT) && /probePath\(candidate\)/.test(KT),
);
check(
  'the PATH probe treats EACCES as evidence and UNKNOWN as non-evidence',
  /probe == FsProbe\.PRESENT \|\| probe == FsProbe\.DENIED/.test(ktFunction('suOnPath')),
);

const zygisk = ktFunction('checkZygisk');
check('checkZygisk() exists', zygisk.length > 0);
check('checkZygisk() no longer treats /proc/modules as a Zygisk oracle',
  /inspectMountView\(\)/.test(zygisk) && !/contains\("zygisk"\)/.test(zygisk));

check(
  'the DenyList-resistant artifact set covers KernelSU/APatch/module dirs',
  ['modules_update', 'post-fs-data.d', 'service.d', 'ksud', 'apd', 'debug_ramdisk']
    .every((needle) => KT.includes(`"/data/adb/${needle}"`) || KT.includes(`"/${needle}"`)),
);

// ─── 2. Mount-view rule (mirror + static contract) ───────────────────────────

console.log('\n\u2500\u2500 2. Mount-view rule: flags root mounts, ignores ordinary ones \u2500\u2500');

/**
 * Mirror of SecurityModule.inspectMountView()/classify — same fields, same
 * order, same conditions. Keep in sync with the Kotlin template.
 */
function classifyMountLine(raw) {
  const dash = raw.indexOf(' - ');
  if (dash <= 0) return null;
  const left = raw.slice(0, dash).split(' ');
  const right = raw.slice(dash + 3).split(' ');
  if (left.length < 6 || right.length < 2) return null;

  const mountPoint = left[4];
  const fstype = right[0];
  const source = right[1];
  // Whole line — an overlay's upperdir/lowerdir are in the per-mount OPTIONS
  // field, which the fstype/source fields do not contain.
  const hay = raw.toLowerCase();

  const overSystem = ['/system', '/vendor', '/product', '/odm', '/system_ext']
    .some((root) => mountPoint === root || mountPoint.startsWith(`${root}/`));
  const dataBacked = hay.includes('/data/adb')
    || hay.includes('upperdir=/data')
    || hay.includes('lowerdir=/data');
  const magiskNamed = hay.includes('magisk') || hay.includes('.magisk');

  if (fstype === 'overlay' && overSystem && (dataBacked || magiskNamed)) return 'root_overlay_on_system';
  if (overSystem && dataBacked) return 'root_module_mount';
  if (magiskNamed || mountPoint.startsWith('/data/adb')) return 'root_module_mount';
  if (source.startsWith('/debug_ramdisk')) return 'magisk_debug_ramdisk';
  return null;
}

const BENIGN_MOUNTS = [
  // Ordinary /data on a stock device.
  '36 25 253:4 / /data rw,seclabel,nosuid,nodev,noatime 0 0 - ext4 /dev/block/dm-1 rw,seclabel',
  // The app's own data dir, bind-mounted the way the platform normally does.
  '412 36 253:4 /data/user/0/com.medacademy.app /data/user/0/com.medacademy.app rw,seclabel 0 0 - ext4 /dev/block/dm-1 rw',
  // tmpfs — created by every Android boot.
  '12 1 0:11 / /dev rw,nosuid,relatime 0 0 - tmpfs tmpfs rw,seclabel,mode=755',
  // A vendor overlay that is NOT backed by /data (legit OEM overlayfs).
  '58 25 0:49 / /system_ext rw,nosuid,nodev,noatime 0 0 - overlay overlay rw,lowerdir=/system_ext',
  // Read-only /system on a stock, verified-boot device.
  '30 25 253:2 / /system ro,seclabel,relatime 0 0 - ext4 /dev/block/dm-2 ro,seclabel',
];

const ROOT_MOUNTS = [
  // Magisk-style overlay over /system backed by /data/adb.
  '61 25 0:52 / /system rw,relatime,upperdir=/data/adb/modules/x/system,lowerdir=/system 0 0 - overlay overlay rw',
  // Module bind mount.
  '77 36 253:4 /data/adb/modules/foo/system/bin /system/bin rw,seclabel 0 0 - ext4 /dev/block/dm-1 rw',
  // Magisk's /debug_ramdisk.
  '21 1 0:20 / /debug_ramdisk rw,seclabel,relatime 0 0 - ext4 /debug_ramdisk rw',
];

check(
  'every ordinary mount is classified as clean (no false positive)',
  BENIGN_MOUNTS.every((line) => classifyMountLine(line) === null),
  BENIGN_MOUNTS.map((l) => `${classifyMountLine(l)} :: ${l}`).join('\n       '),
);
check(
  'every root-framework mount is classified as evidence',
  ROOT_MOUNTS.every((line) => classifyMountLine(line) !== null),
);
check('the rule names its three evidence kinds',
  ['root_overlay_on_system', 'root_module_mount', 'magisk_debug_ramdisk']
    .every((kind) => KT.includes(kind)));
check(
  'the Kotlin rule requires overlay + a system mount point + /data backing',
  /fstype == "overlay" && overSystem && \(dataBacked \|\| magiskNamed\)/.test(KT),
);
check(
  'a system path backed by /data is caught even without a module-named path',
  /overSystem && dataBacked ->/.test(KT),
);
check(
  'the rule scans the per-mount OPTIONS field (where upperdir lives)',
  /val hay = raw\.lowercase\(\)/.test(KT),
);
check(
  'the mount view is bounded (no unbounded /proc parse)',
  /scanned > 512/.test(KT),
);
check(
  'the evidence surface reports the new signals',
  /o\.put\("mountEvidence"/.test(KT) && /o\.put\("suOnPath"/.test(KT),
);
check(
  'the JS evidence type declares the new signals',
  /mountEvidence\?: string\[\]/.test(NATIVE_TS) && /suOnPath\?: string\[\]/.test(NATIVE_TS),
);

// ─── 3. Certificate-digest normalisation ─────────────────────────────────────

console.log('\n\u2500\u2500 3. Play Integrity cert digest: hex and base64url agree \u2500\u2500');

/**
 * Mirror of IntegrityService::normalizeCertDigest() — 64-hex passes through
 * lowercased; anything else is treated as base64/base64url of 32 raw bytes.
 */
function normalizeCertDigest(raw) {
  const value = String(raw).replace(/:/g, '').trim();
  if (value === '') return '';
  if (/^[0-9A-Fa-f]{64}$/.test(value)) return value.toLowerCase();
  let b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const rem = b64.length % 4;
  if (rem > 0) b64 += '='.repeat(4 - rem);
  const bin = Buffer.from(b64, 'base64');
  if (bin.length !== 32) return '';
  // Reject non-canonical input: Buffer silently drops invalid characters.
  if (Buffer.from(b64, 'base64').toString('base64').replace(/=+$/, '')
    !== value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')) return '';
  return bin.toString('hex');
}

const DIGEST_HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const DIGEST_B64URL = Buffer.from(DIGEST_HEX, 'hex').toString('base64url');

check('Google-style base64url digest normalises to the pinned hex',
  normalizeCertDigest(DIGEST_B64URL) === DIGEST_HEX,
  `got ${normalizeCertDigest(DIGEST_B64URL)}`);
check('uppercase hex normalises to lowercase',
  normalizeCertDigest(DIGEST_HEX.toUpperCase()) === DIGEST_HEX);
check('colon-separated hex normalises to the bare digest',
  normalizeCertDigest('A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90')
    === DIGEST_HEX);
check('garbage does not normalise to something that could match a pin',
  normalizeCertDigest('not-a-digest') === '' && normalizeCertDigest('') === '');
check('the PHP helper exists and is applied to the GOOGLE value',
  /public static function normalizeCertDigest/.test(INTEGRITY_PHP)
    && /\$cert = self::normalizeCertDigest\(\(string\) \$certs\[0\]\)/.test(INTEGRITY_PHP));
check('the PHP helper is applied to the PINNED values too',
  /\$d = self::normalizeCertDigest\(\(string\) \$d\)/.test(INTEGRITY_PHP));
check('base64 decoding is strict and length-checked',
  /base64_decode\(\$b64, true\)/.test(INTEGRITY_PHP) && /strlen\(\$bin\) === 32/.test(INTEGRITY_PHP));

// ─── 4. Freshness, licensing, telemetry ──────────────────────────────────────

console.log('\n\u2500\u2500 4. Token freshness, licensing policy, failure telemetry \u2500\u2500');

check('decoded-token freshness is enforced', /private static function tokenIsFresh/.test(INTEGRITY_PHP)
  && /requestDetails\.timestampMillis|'timestampMillis'/.test(INTEGRITY_PHP)
  && /tokenIsFresh\(\$details\)/.test(INTEGRITY_PHP));
check('a missing or unparsable timestamp fails closed',
  /if \(!is_numeric\(\(string\) \$raw\)\) \{\s*\n\s*return false;/.test(INTEGRITY_PHP));
check('the freshness window is bounded by named constants',
  /MAX_TOKEN_AGE_MS = 600_000/.test(INTEGRITY_PHP) && /MAX_CLOCK_SKEW_MS/.test(INTEGRITY_PHP));
check('rejections are logged with the failing check',
  /private static function reject\(/.test(INTEGRITY_PHP)
    && /'play_integrity_failed'/.test(INTEGRITY_PHP)
    && /self::reject\(\$userId, \$ip, 'certificate_mismatch'\)/.test(INTEGRITY_PHP));
check('device verdicts come from a policy list, not a hard-coded pair',
  /'device_verdicts'/.test(INTEGRITY_PHP) && /array_intersect\(\$policy\['device_verdicts'\]/.test(INTEGRITY_PHP));
check('licensing is opt-in (Play is not the only distribution channel)',
  /'require_licensed'\s*=> \(bool\) \(\$pi\['require_licensed'\] \?\? false\)/.test(INTEGRITY_PHP)
    && /appLicensingVerdict/.test(INTEGRITY_PHP));
check('Google-side failures are classified transient vs permanent',
  /\$transient = \$httpCode === 0 \|\| \$httpCode === 429 \|\| \$httpCode >= 500/.test(INTEGRITY_PHP));
check('the service-account access token is cached, not minted per call',
  /private static \?array \$accessTokenCache/.test(INTEGRITY_PHP)
    && /expires_at' => time\(\) \+ max\(60, \$ttl - 60\)/.test(INTEGRITY_PHP));

// ─── 5. Issuance coverage + per-action client cache ──────────────────────────

console.log('\n\u2500\u2500 5. PDF issuance is a protected action end-to-end \u2500\u2500');

check("IntegrityService knows the 'material_pdf' tier",
  /'material_pdf'\s*=> 'log_only'/.test(INTEGRITY_PHP));
check("SecurityEvidenceService accepts a 'material_pdf' challenge",
  /KNOWN_ACTIONS = \[[^\]]*'material_pdf'/.test(EVIDENCE_PHP)
    && /'material_pdf' => 'log_only'/.test(EVIDENCE_PHP));
check('the delivery controller enforces the tier before rendering',
  /IntegrityService::assertActionAllowed\(\s*\n\s*\$userId,\s*\n\s*'material_pdf'/.test(DELIVERY_PHP));
check('the enforcement call sits before the (expensive) mint',
  DELIVERY_PHP.indexOf("'material_pdf'") < DELIVERY_PHP.indexOf('$this->ensurePersonalizedCopy('));
check('the client type lists material_pdf as a protected action',
  /export type ProtectedAction =[\s\S]*?\| 'material_pdf'/.test(DEVICE_KEY));
check('the client builds the headers for the mint call',
  /buildProtectedCallHeaders\('material_pdf', body\)/.test(API_TS)
    && /'materials\/pdf-url',\s*\n\s*body,\s*\n\s*undefined,\s*\n\s*'POST',\s*\n\s*securityHeaders/.test(API_TS));

console.log('\n\u2500\u2500 5b. The integrity-hash cache is bound to ONE action \u2500\u2500');
check('the cache records the action it was minted for',
  /_cached: \{ action: string; hash: string; fetchedAt: number \}/.test(INTEGRITY_CLIENT));
check('a cached hash is only reused for the SAME action',
  /_cached\.action === action/.test(INTEGRITY_CLIENT));
check('peekIntegrityHash requires an action (no cross-action reuse)',
  /export function peekIntegrityHash\(action: string\)/.test(INTEGRITY_CLIENT));

// ─── 6. The PHP files still parse ────────────────────────────────────────────

console.log('\n\u2500\u2500 6. Modified PHP parses \u2500\u2500');

let phpOk = true;
try {
  const PhpParser = require('php-parser');
  const parser = new PhpParser({ parser: { extractDoc: false, php7: true }, ast: { withPositions: false } });
  const files = [
    'backend/src/Services/IntegrityService.php',
    'backend/src/Services/SecurityEvidenceService.php',
    'backend/src/Controllers/MaterialDeliveryController.php',
  ];
  for (const file of files) {
    try {
      parser.parseCode(read(file), file);
    } catch (e) {
      phpOk = false;
      console.error(`       ${file}: ${e.message}`);
    }
  }
} catch (e) {
  phpOk = false;
  console.error(`       php-parser unavailable: ${e.message}`);
}
check('all three modified PHP files parse cleanly', phpOk);

// ─── summary ─────────────────────────────────────────────────────────────────

console.log('\n' + '\u2500'.repeat(64));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nRoot / integrity hardening suite FAILED');
  process.exit(1);
}
console.log('Root / integrity hardening suite passed');
