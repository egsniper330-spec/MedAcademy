/**
 * Release-configuration consistency regression suite.
 *
 * Two defects found during the pre-release audit, both of which were invisible
 * on a developer machine and only surfaced from a CLEAN checkout:
 *
 *  1. LINE ENDINGS
 *     The repository had no `.gitattributes`. With core.autocrlf=true, a Windows
 *     checkout rewrote text files to CRLF while the committed blob is LF, so
 *     suites that match multi-line string literals containing "\n" (or compare
 *     generated assets byte-for-byte) failed on a fresh checkout:
 *       - tests/videoLibrarySync.test.cjs  (3 checks, svc/ctrl literals)
 *       - tests/brandIdentity.test.cjs     (12/14 assets; the 2 SVG text files)
 *     Measured before the fix: worktree 18,897 bytes (LF) vs checkout 19,266
 *     bytes (CRLF) for VideoLibrarySyncService.php.
 *
 *  2. API HOST DRIFT
 *     The tracked `.env` named `api.medacademy.eu.cc`, which does not resolve
 *     (DNS SERVFAIL) and is NOT in the app's pinned host list
 *     (expo.extra.medaPinnedHosts = ["api.medacademy.site"], which resolves and
 *     serves a chain matching the shipped SPKI pins). Because a local, ignored
 *     `.env.local` overrode it ("later file wins"), the effective host on a
 *     developer machine was correct and the mismatch stayed hidden — while a
 *     clean checkout would have built an app pointed at a dead host that TLS
 *     pinning did not cover. tests/iosPinningCoverage.test.cjs E4 caught it,
 *     but only when no local override was present.
 *
 * This suite pins both properties so they cannot silently regress. It is
 * deliberately independent of git: it inspects the working tree, so it behaves
 * identically in CI, in a fresh clone, and in an index-derived snapshot.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
    console.log('  \u2714 ' + name);
  } else {
    failed++;
    console.log('  \u2718 ' + name);
  }
}

const apiHostOf = (rel) => {
  const m = read(rel).match(/^\s*EXPO_PUBLIC_PHP_API_URL\s*=\s*(\S+)\s*$/m);
  if (!m) return null;
  try {
    return new URL(m[1]).hostname.toLowerCase();
  } catch {
    return null;
  }
};

// ── A. The line-ending policy exists and is a real LF policy ─────────────────
console.log('\nA. Line-ending policy (.gitattributes)');
{
  check('.gitattributes exists', exists('.gitattributes'));
  const ga = exists('.gitattributes') ? read('.gitattributes') : '';
  check('it normalizes text to LF in the repository AND the working tree',
    /^\*\s+text=auto\s+eol=lf\s*$/m.test(ga));
  check('it never forces CRLF anywhere', !/eol=crlf/i.test(ga));
  check('binary assets are declared binary (never line-normalized)',
    /^\*\.png\s+binary\s*$/m.test(ga) && /^\*\.ttf\s+binary\s*$/m.test(ga));
}

// ── B. The files whose content the suites match literally are LF ─────────────
console.log('\nB. Content files asserted by other suites are LF on disk');
{
  // These are the CONTENT files the other suites match with literal "\n"
  // strings or compare byte-for-byte. (The suite files themselves are not
  // listed: their own line endings do not affect what they assert, and one of
  // them is CRLF in a developer working tree even though its blob is LF.)
  const LF_FILES = [
    'backend/src/Services/VideoLibrarySyncService.php',
    'backend/src/Controllers/VideoController.php',
    'assets/brand/medacademy-symbol.svg',
    'assets/brand/medacademy-wordmark.svg',
  ];
  for (const rel of LF_FILES) {
    check(`${rel} is LF (no CRLF)`, exists(rel) && read(rel).length > 0 && !read(rel).includes('\r\n'));
  }

  const svgDir = path.join(ROOT, 'assets', 'brand');
  if (fs.existsSync(svgDir)) {
    const textAssets = fs.readdirSync(svgDir).filter((n) => /\.(svg|json|txt)$/i.test(n));
    check('every text asset under assets/brand is LF (generated-app reproduces it byte-for-byte)',
      textAssets.length > 0 && textAssets.every((n) => !read(path.join('assets', 'brand', n)).includes('\r\n')));
  } else {
    check('assets/brand exists', false);
  }
}

// ── C. The exact multi-line literals that broke on CRLF still match ──────────
console.log('\nC. The assertions that failed on a CRLF checkout still match');
{
  const svc = read('backend/src/Services/VideoLibrarySyncService.php');
  const ctrl = read('backend/src/Controllers/VideoController.php');
  check('svc: "UPDATE lessons SET\\n<indent>video_asset_id = NULL"',
    svc.includes('UPDATE lessons SET\n                video_asset_id = NULL'));
  check('svc: "return [\\n<indent>\'status\' => \'error\',"',
    svc.includes("return [\n                'status' => 'error',"));
  check('ctrl: "UPDATE lessons SET\\n<indent>video_asset_id = NULL"',
    ctrl.includes('UPDATE lessons SET\n                    video_asset_id = NULL'));
}

// ── D. The TRACKED API host is the one the pin list covers ───────────────────
console.log('\nD. Tracked API host is covered by the TLS pin list');
{
  const appJson = JSON.parse(read('app.json'));
  const pinned = (appJson.expo.extra.medaPinnedHosts || []).map((h) => String(h).toLowerCase());
  check('app.json declares at least one pinned host', pinned.length > 0);

  const trackedHost = apiHostOf('.env');
  check('.env declares EXPO_PUBLIC_PHP_API_URL as a URL', !!trackedHost);
  check(`tracked .env host (${trackedHost}) is in medaPinnedHosts [${pinned.join(', ')}]`,
    !!trackedHost && pinned.includes(trackedHost));

  // The tracked default must not depend on a local, ignored override: this is
  // the assertion that would have failed before the fix even with .env.local
  // present, because it reads .env specifically.
  check('.env.local is NOT required for the tracked host to be pinned (no override needed)',
    !exists('.env.local') || apiHostOf('.env.local') === trackedHost || pinned.includes(apiHostOf('.env.local')));
}

// ── E. Every tracked env template names the same host (no future drift) ──────
console.log('\nE. Env templates agree with the tracked .env');
{
  const trackedHost = apiHostOf('.env');
  const templates = [
    '.env.example',
    '.env.development.example',
    '.env.staging.example',
    '.env.production.example',
    '.env.local.template',
  ];
  for (const rel of templates) {
    check(`${rel} names the same host as .env (${trackedHost})`,
      exists(rel) && apiHostOf(rel) === trackedHost);
  }
  check('no tracked env file still references the decommissioned host',
    ['.env', ...templates].every((rel) => !read(rel).includes('api.medacademy.eu.cc')));
}

// ── F. The confirmed production host is the one everything names ─────────────
// Owner decision (2026-10-13): https://api.medacademy.site is the authoritative
// production API host. Recording it here means a future edit that reintroduces a
// different host in runtime configuration fails loudly instead of shipping.
console.log('\nF. Confirmed production API host (owner decision 2026-10-13)');
{
  const CONFIRMED = 'api.medacademy.site';
  const appJson = JSON.parse(read('app.json'));
  const pinned = (appJson.expo.extra.medaPinnedHosts || []).map((h) => String(h).toLowerCase());
  const templates = [
    '.env.example',
    '.env.development.example',
    '.env.staging.example',
    '.env.production.example',
    '.env.local.template',
  ];

  check(`app.json medaPinnedHosts contains the confirmed host (${CONFIRMED})`,
    pinned.includes(CONFIRMED));
  check('.env names the confirmed host', apiHostOf('.env') === CONFIRMED);
  check('every tracked env template names the confirmed host',
    templates.every((rel) => exists(rel) && apiHostOf(rel) === CONFIRMED));

  // The LIVE runbook is runtime documentation an operator follows: it must name
  // the confirmed host and must not send anyone to the decommissioned one.
  // (Dated audit snapshots under backend/docs/ deliberately keep the historical
  // value verbatim, clearly labeled — they are evidence, not configuration.)
  const runbook = read('backend/NAMECHEAP_DEPLOYMENT.md');
  check('the live deployment runbook names the confirmed host',
    runbook.includes(CONFIRMED));
  check('the live deployment runbook does not name the decommissioned host',
    !runbook.includes('api.medacademy.eu.cc'));
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log('\n' + '\u2500'.repeat(64));
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nRelease-configuration consistency suite FAILED');
  process.exit(1);
}
console.log('Release-configuration consistency suite passed');
