#!/usr/bin/env node
/**
 * tests/dependencyLicensePolicy.test.cjs
 *
 * Licence policy for MedAcademy's dependency tree.
 *
 * WHY THIS SUITE EXISTS
 *   The licence audit is only useful if it stays true. The tree contains 1000+
 *   installed npm packages, three Composer packages, vendored browser code and
 *   an optional PDF renderer, and the licence position is a mix: MIT plus a
 *   permissive tail (ISC/BSD/Apache/BlueOak/CC-BY), one LGPL-3.0-or-later PHP
 *   library we could not replace, one MPL-2.0 build tool, and one production
 *   dependency with no licence declared at all.
 *
 *   A future `npm install` can quietly add a GPL package, or drop the
 *   attribution header from the inlined polyfill, or delete the record of the
 *   gaps. This suite fails when that happens, and it fails when the audit is
 *   edited to CLAIM MIT-only while a non-MIT dependency is still installed.
 *
 * What this suite CANNOT prove: that a licence is valid in every jurisdiction,
 * or that a package's declared licence matches its source. Those are legal and
 * provenance questions; the report records them as open.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { buildInventory, classify, parseGradleTree } = require('../scripts/dependency-license-audit.cjs');

let passed = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) {
    passed++;
  } else {
    failures.push(label + (detail ? ' — ' + detail : ''));
    console.log('  ✗ ' + label + (detail ? ' — ' + detail : ''));
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function section(title) {
  console.log('\n── ' + title + ' ──');
}

/* ── 0. The classifier itself ─────────────────────────────────────────────── */

section('0. classifier: OR picks the lightest side, AND the heaviest');

ok('plain MIT', classify('MIT').verdict === 'mit');
ok('ISC is permissive, not MIT', classify('ISC').verdict === 'permissive');
ok('MIT/X11 is MIT', classify('MIT/X11').verdict === 'mit');
ok('jszip dual MIT OR GPL-3.0 resolves to MIT', classify('(MIT OR GPL-3.0-or-later)').verdict === 'mit');
ok('BSD-3 OR GPL-2.0 resolves to BSD', classify('(BSD-3-Clause OR GPL-2.0)').verdict === 'permissive');
ok('MIT AND Apache-2.0 is permissive', classify('MIT AND Apache-2.0').verdict === 'permissive');
ok('LGPL-3.0 is weak-copyleft', classify('LGPL-3.0-or-later').verdict === 'weak-copyleft');
ok('AGPL-3.0 is copyleft', classify('AGPL-3.0').verdict === 'copyleft');
ok('empty licence is unknown', classify('').verdict === 'unknown');
ok('null licence is unknown', classify(null).verdict === 'unknown');
ok(
  'unknown is never laundered into permissive',
  classify('Proprietary-EULA-v9').verdict === 'unknown',
);

/* ── 1. Nothing blocking is installed ────────────────────────────────────── */

section('1. no GPL / AGPL / SSPL / BUSL in the audited tree');

const inv = buildInventory();
const blocking = inv.blocking.filter((p) => p.verdict === 'copyleft');

ok('no blocking-licence package', blocking.length === 0, blocking.map((p) => p.name).join(', '));
ok('npm tree was actually read', inv.summary.npm.total > 500, `found ${inv.summary.npm.total}`);
ok(
  'LGPL/MPL packages are inventoried rather than ignored',
  inv.weakCopyleft.length > 0 &&
    inv.weakCopyleft.some((p) => p.name === 'tecnickcom/tcpdf') &&
    inv.weakCopyleft.some((p) => p.name === 'lightningcss'),
);

/* ── 2. The PHP runtime set is exactly what we audited ───────────────────── */

section('2. Composer runtime set unchanged');

const phpNames = inv.composer.packages.map((p) => p.name).sort();
ok(
  'exactly fpdf + fpdi + tcpdf',
  JSON.stringify(phpNames) === JSON.stringify(['setasign/fpdf', 'setasign/fpdi', 'tecnickcom/tcpdf']),
  phpNames.join(', '),
);
const phpBy = Object.fromEntries(inv.composer.packages.map((p) => [p.name, p]));
ok('fpdf is MIT', phpBy['setasign/fpdf']?.verdict === 'mit');
ok('fpdi is MIT', phpBy['setasign/fpdi']?.verdict === 'mit');
ok('tcpdf is still LGPL-3.0-or-later', phpBy['tecnickcom/tcpdf']?.license === 'LGPL-3.0-or-later');

/* ── 3. The removed dependency stays removed, and its notice stays ───────── */

section('3. fast-text-encoding: dependency gone, attribution kept');

const pkg = JSON.parse(read('package.json'));
const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
ok('fast-text-encoding is not a declared dependency', !('fast-text-encoding' in allDeps));
ok('it is not installed either', !exists('node_modules/fast-text-encoding'));

const polyfill = read('src/polyfills/text-encoding.js');
ok(
  'the inlined polyfill still carries its Apache-2.0 attribution',
  /fast-text-encoding@1\.0\.6/.test(polyfill) && /Apache-2\.0/.test(polyfill),
);
ok(
  'Metro still injects the local polyfill',
  /polyfillModuleNames[\s\S]{0,400}src\/polyfills\/text-encoding\.js/.test(read('metro.config.js')),
);

/* ── 4. The unresolved gaps are on the record, not smoothed over ─────────── */

section('4. unresolved gaps are documented');

const auditDoc = exists('DEPENDENCY_LICENSE_AUDIT.md') ? read('DEPENDENCY_LICENSE_AUDIT.md') : '';
ok('the audit report exists', auditDoc.length > 2000, `${auditDoc.length} chars`);
ok('it names the LGPL PDF library', /tecnickcom\/tcpdf/.test(auditDoc) && /LGPL-3\.0-or-later/.test(auditDoc));
ok('it names the undeclared VdoCipher bridge', /vdocipher-rn-bridge/.test(auditDoc));
ok('it names the transitive unlicensed package', /buffers@0\.1\.1|buffers\b/.test(auditDoc));
ok(
  'it states the MIT-only target was not reached',
  /not (?:met|reached|achieved)|partially migrated|unresolved/i.test(auditDoc),
);
ok('it names the proprietary Play/Google artifacts', /play-services|Play Integrity/i.test(auditDoc));

const undeclared = inv.npm.filter((p) => p.verdict === 'unknown');
ok(
  'the only undeclared npm licences are the known two (VdoCipher bridge, buffers)',
  undeclared.length === 2 &&
    undeclared.map((p) => p.name).sort().join(',') === 'buffers,vdocipher-rn-bridge',
  undeclared.map((p) => `${p.name}@${p.version}`).join(', '),
);

/* ── 4b. Android is audited from the RESOLVED graph, not from names ──────── */

section('4b. Android artifacts come from the resolved Gradle graph');

ok('the resolved graph report is committed', exists('docs/android-dependency-report.txt'));
const android = inv.android;
ok('the Android graph was audited', android.available === true, android.reason);
ok(
  'it is the release runtime classpath of the app',
  android.configuration === 'releaseRuntimeClasspath',
);
ok(
  'every artifact on it was collected (not a sample)',
  inv.summary.android.total > 150,
  `found ${inv.summary.android.total}`,
);
ok(
  'every artifact carries a licence string and a reason',
  inv.android.packages.every(
    (p) => typeof p.license === 'string' && p.license.length > 0 && Array.isArray(p.notes),
  ),
);
ok(
  'every unknown artifact is listed in the unknown set',
  inv.android.packages
    .filter((p) => p.verdict === 'unknown')
    .every((p) => inv.unknown.some((u) => u.name === p.name && u.ecosystem === 'android')),
);

// Each verdict must be backed by something readable, and the evidence kind is
// recorded so a weaker source (a group-name map) is never mistaken for a POM.
const evidenceKinds = new Set(['pom', 'artifact', 'group-map', 'none']);
ok(
  'every artifact records where its licence came from',
  inv.android.packages.every((p) => evidenceKinds.has(p.evidence)),
  [...new Set(inv.android.packages.map((p) => p.evidence))].join(', '),
);
ok(
  'the resolved report and the evidence counts agree',
  Object.values(android.byEvidence ?? {}).reduce((a, b) => a + b, 0) === inv.summary.android.total,
);
ok(
  'most licences were read from a POM or from the artifact bytes',
  (android.byEvidence?.pom ?? 0) + (android.byEvidence?.artifact ?? 0) > inv.summary.android.total * 0.6,
  JSON.stringify(android.byEvidence),
);

// Spot checks against artifacts we can point at by name.
const androidBy = Object.fromEntries(inv.android.packages.map((p) => [p.name, p]));
ok(
  'AndroidX resolves to Apache-2.0',
  androidBy['androidx.core:core']?.license === 'Apache-2.0',
  androidBy['androidx.core:core']?.license,
);
ok('React Native resolves to MIT', androidBy['com.facebook.react:react-android']?.verdict === 'mit');
ok(
  'Play services artifacts are recorded as proprietary, not as Apache-2.0',
  androidBy['com.google.android.gms:play-services-base']?.verdict === 'proprietary',
  androidBy['com.google.android.gms:play-services-base']?.verdict,
);
ok(
  'Play Integrity is on the runtime classpath and is proprietary',
  androidBy['com.google.android.play:integrity']?.verdict === 'proprietary',
  String(androidBy['com.google.android.play:integrity']?.verdict),
);
ok(
  'the VdoCipher native SDK is unknown, not assumed MIT',
  androidBy['com.vdocipher.aegis:vdocipher-android']?.verdict === 'unknown',
);
ok(
  'proprietary artifacts are reported separately from unknown ones',
  inv.proprietary.some((p) => p.name === 'com.google.android.play:integrity') &&
    !inv.unknown.some((p) => p.name === 'com.google.android.play:integrity'),
);
ok(
  'a proprietary verdict never counts as blocking copyleft',
  !inv.blocking.some((p) => p.verdict === 'proprietary'),
);

// The parser itself: version upgrades, repeats and project deps.
const sample = parseGradleTree(
  [
    'releaseRuntimeClasspath - Runtime classpath of \'/release\'.',
    '+--- androidx.core:core:1.9.0 -> 1.17.0',
    '|    +--- org.jetbrains.kotlin:kotlin-stdlib:2.1.20 (*)',
    '\\--- project :expo-modules-core',
    'otherConfiguration - not the one we audit',
    '+--- com.example:not-collected:1.0',
    '',
  ].join('\n'),
);
ok('the parser reads only the audited configuration', sample.size === 2, `${sample.size} entries`);
ok(
  'the parser follows a version upgrade to the resolved version',
  sample.get('androidx.core:core')?.version === '1.17.0',
  sample.get('androidx.core:core')?.version,
);
ok('the parser ignores project deps', ![...sample.keys()].some((k) => k.includes('expo-modules-core')));

/* ── 5. The gated AGPL renderer stays gated ─────────────────────────────── */

section('5. AGPL renderer is unreachable from the default path');

const wmService = read('backend/src/Services/PdfWatermarkService.php');
ok(
  'the watermark service no longer invokes Ghostscript',
  !/proc_open\(\s*\[\s*['"]gs['"]|GHOSTSCRIPT_BIN|PDF_WATERMARK_ACCEPT_AGPL_RENDERER/.test(wmService),
);
ok(
  'the raster engine is the bundled PDFium helper (BSD-3-Clause)',
  /pdfium_render/.test(wmService) && /BSD-3-Clause/.test(wmService),
);
ok(
  'Ghostscript is no longer listed as a gated dependency',
  !inv.vendored.some((g) => /Ghostscript/.test(g.name)),
);

/* ── 6. Notices ship with the code they cover ───────────────────────────── */

section('6. attribution artefacts');

ok('THIRD_PARTY_NOTICES.md exists', exists('THIRD_PARTY_NOTICES.md'));
const notices = exists('THIRD_PARTY_NOTICES.md') ? read('THIRD_PARTY_NOTICES.md') : '';
ok('notices cover TCPDF', /tecnickcom\/tcpdf/.test(notices));
ok('notices cover the MPL build tool', /lightningcss/.test(notices));
ok('notices cover the CC-BY data package', /caniuse-lite/.test(notices));
ok('notices cover the DejaVu font', /DejaVu/.test(notices));
ok('notices point at the Plyr licence file', /public\/player\/THIRD_PARTY_NOTICES\.txt/.test(notices));

ok('vendored Plyr ships its MIT text', exists('public/player/THIRD_PARTY_NOTICES.txt'));
ok(
  'the vendored Plyr notice is actually a licence, not a placeholder',
  /Permission is hereby granted, free of charge/.test(read('public/player/THIRD_PARTY_NOTICES.txt')),
);

/* ── 7. The inventory is machine-readable and current ───────────────────── */

section('7. inventory artefact');

ok('docs/dependency-license-inventory.json exists', exists('docs/dependency-license-inventory.json'));
if (exists('docs/dependency-license-inventory.json')) {
  const onDisk = JSON.parse(read('docs/dependency-license-inventory.json'));
  ok('it parses', typeof onDisk === 'object' && onDisk !== null);
  ok(
    'its npm count matches the installed tree',
    onDisk.summary?.npm?.total === inv.summary.npm.total,
    `file=${onDisk.summary?.npm?.total} live=${inv.summary.npm.total}`,
  );
  ok('it records the MIT-only target as not met', onDisk.summary?.mitOnlyTarget === false);
}

/* ── Summary ─────────────────────────────────────────────────────────────── */

console.log(`\n${'─'.repeat(60)}`);
if (failures.length) {
  console.log(`FAIL — ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log(`PASS — ${passed} assertions`);
