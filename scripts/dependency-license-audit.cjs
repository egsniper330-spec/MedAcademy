#!/usr/bin/env node
/**
 * dependency-license-audit.cjs — reproducible licence inventory for MedAcademy.
 *
 * WHY: the licence question ("may we ship this closed-source and commercial?")
 * was previously answered by memory and by reading package names. This script
 * answers it from the bytes on disk — the INSTALLED npm tree, the INSTALLED
 * Composer tree, plus the third-party code and binaries we vendor or execute —
 * and writes two artefacts that can be diffed in review:
 *
 *   docs/dependency-license-inventory.json   machine-readable inventory
 *   THIRD_PARTY_NOTICES.md                   human-readable attribution notice
 *
 * It classifies every licence expression into one of four policy verdicts:
 *
 *   mit            the target: MIT (or MIT chosen out of a dual licence)
 *   permissive     ISC / Apache-2.0 / BSD / BlueOak / 0BSD / Unlicense / Zlib /
 *                  CC0 / CC-BY / Python-2.0 / Public Domain — no fee, no
 *                  source-disclosure duty, but an attribution/notice duty
 *   weak-copyleft  LGPL / MPL — usable unmodified in a closed-source product,
 *                  but the library's own source and notices must stay intact
 *   copyleft       GPL / AGPL / SSPL / BUSL — blocks our deployment model
 *   unknown        no licence field, or an expression we cannot classify
 *
 * `unknown` is deliberately NOT folded into `permissive`: a package with an
 * empty `license` field ("") grants us nothing we can rely on, and that must
 * show up in the report instead of being silently accepted.
 *
 * Android is audited from the RESOLVED Gradle graph, not from a list of names:
 * `docs/android-dependency-report.txt` holds every artifact on
 * `:app:releaseRuntimeClasspath`, and each artifact's licence is read from the
 * `<licenses>` block of the POM that Gradle itself downloaded. `--gradle`
 * regenerates that report. When a POM is absent (a cold cache), the artifact is
 * marked `unknown` rather than guessed — except for the few groups whose
 * licence is published in the artifact headers, which are recorded with
 * `evidence: "group-map"` so their weaker provenance stays visible.
 *
 * Usage:
 *   node scripts/dependency-license-audit.cjs            # write artefacts
 *   node scripts/dependency-license-audit.cjs --check    # fail if the tree
 *                                                        # gained a blocking
 *                                                        # licence; no writes
 *   node scripts/dependency-license-audit.cjs --gradle   # re-resolve the Android
 *                                                        # graph, then write
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INVENTORY_PATH = path.join(ROOT, 'docs', 'dependency-license-inventory.json');
const NOTICES_PATH = path.join(ROOT, 'THIRD_PARTY_NOTICES.md');
const ANDROID_REPORT_PATH = path.join(ROOT, 'docs', 'android-dependency-report.txt');
const EXCEPTIONS_PATH = path.join(ROOT, 'license-exceptions.json');

/**
 * The Android configurations we audit. `shipped` decides whether an artifact is
 * covered by the strict MIT-only gate:
 *   release — inside the APK/AAB we publish
 *   debug   — inside debug builds only (still distribution to testers)
 *   build   — build machine only (AGP, Kotlin plugin): never reaches a user
 */
const ANDROID_SECTIONS = [
  { name: 'releaseRuntimeClasspath', label: 'release APK/AAB', shipped: 'release' },
  { name: 'debugRuntimeClasspath', label: 'debug build', shipped: 'debug' },
  { name: 'classpath', label: 'Gradle buildscript', shipped: 'build' },
];
const ANDROID_CONFIGURATION = ANDROID_SECTIONS[0].name;

// ── Licence classification ───────────────────────────────────────────────────

/** SPDX token → verdict. Unknown tokens fall through to `unknown`. */
const TOKENS = new Map([
  ['MIT', 'mit'],
  ['MIT-0', 'mit'],
  ['X11', 'mit'],
  ['MIT/X11', 'mit'],
  ['Expat', 'mit'],
  ['ISC', 'permissive'],
  ['Apache-2.0', 'permissive'],
  ['Apache 2.0', 'permissive'],
  ['BSD', 'permissive'],
  ['BSD-2-Clause', 'permissive'],
  ['BSD-3-Clause', 'permissive'],
  ['BSD-3-Clause-Clear', 'permissive'],
  ['BlueOak-1.0.0', 'permissive'],
  ['0BSD', 'permissive'],
  ['Unlicense', 'permissive'],
  ['CC0-1.0', 'permissive'],
  ['CC-BY-4.0', 'permissive'],
  ['CC-BY-3.0', 'permissive'],
  ['Zlib', 'permissive'],
  ['Python-2.0', 'permissive'],
  ['Public Domain', 'permissive'],
  ['WTFPL', 'permissive'],
  ['MPL-2.0', 'weak-copyleft'],
  ['MPL-1.1', 'weak-copyleft'],
  ['EPL-1.0', 'weak-copyleft'],
  ['EPL-2.0', 'weak-copyleft'],
  ['LGPL-2.0-only', 'weak-copyleft'],
  ['LGPL-2.1-only', 'weak-copyleft'],
  ['LGPL-2.1-or-later', 'weak-copyleft'],
  ['LGPL-3.0-only', 'weak-copyleft'],
  ['LGPL-3.0-or-later', 'weak-copyleft'],
  ['GPL-2.0', 'copyleft'],
  ['GPL-2.0-only', 'copyleft'],
  ['GPL-2.0-or-later', 'copyleft'],
  ['GPL-3.0', 'copyleft'],
  ['GPL-3.0-only', 'copyleft'],
  ['GPL-3.0-or-later', 'copyleft'],
  ['AGPL-3.0', 'copyleft'],
  ['AGPL-3.0-only', 'copyleft'],
  ['AGPL-3.0-or-later', 'copyleft'],
  ['SSPL-1.0', 'copyleft'],
  ['BUSL-1.1', 'copyleft'],
  ['Proprietary', 'proprietary'],
]);

const VERDICT_RANK = {
  mit: 0,
  permissive: 1,
  'weak-copyleft': 2,
  // Vendor terms rather than an OSS grant: usable when we have accepted those
  // terms (Google Play services, Play Integrity, VdoCipher), but not a licence
  // that grants redistribution on its own.
  proprietary: 3,
  copyleft: 4,
  unknown: 5,
};

/**
 * Classify one licence expression.
 *
 * "OR" means the consumer may pick any side, so the BEST side decides (that is
 * how jszip's "MIT OR GPL-3.0" becomes MIT). "AND" means every side applies,
 * so the WORST side decides.
 *
 * @param {string|string[]|{type?:string}|null|undefined} raw
 * @returns {{expression:string, verdict:string, notes:string[]}}
 */
function classify(raw) {
  let expression = '';
  if (Array.isArray(raw)) expression = raw.map((r) => (typeof r === 'string' ? r : r?.type ?? '')).join(' OR ');
  else if (raw && typeof raw === 'object') expression = String(raw.type ?? '');
  else if (typeof raw === 'string') expression = raw;
  expression = expression.trim();

  if (expression === '' || /^UNLICENSED$/i.test(expression)) {
    return { expression: expression || '(none declared)', verdict: 'unknown', notes: ['no licence declared'] };
  }

  // Strip outer parentheses, keep the structure.
  const body = expression.replace(/^\(+\s*/, '').replace(/\s*\)+$/, '').trim();

  const orParts = body.split(/\s+OR\s+/i);
  if (orParts.length > 1) {
    const results = orParts.map((p) => classify(p));
    results.sort((a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict]);
    return {
      expression,
      verdict: results[0].verdict,
      notes: [`OR expression; taking the option "${results[0].expression}"`],
    };
  }

  const andParts = body.split(/\s+AND\s+/i);
  if (andParts.length > 1) {
    const results = andParts.map((p) => classify(p));
    results.sort((a, b) => VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict]);
    return {
      expression,
      verdict: results[0].verdict,
      notes: [`AND expression; every part applies, heaviest is "${results[0].expression}"`],
    };
  }

  const key = body.replace(/\s+/g, ' ').trim();
  const verdict = TOKENS.get(key) ?? TOKENS.get(key.replace(/\+$/, '')) ?? 'unknown';
  return { expression, verdict, notes: verdict === 'unknown' ? [`unrecognised licence token "${key}"`] : [] };
}

// ── Collection ───────────────────────────────────────────────────────────────

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Every installed npm package, including nested copies, from disk. */
function collectNpm() {
  const seen = new Map();
  const rootPkg = readJson(path.join(ROOT, 'package.json')) ?? {};
  const direct = new Set([
    ...Object.keys(rootPkg.dependencies ?? {}),
    ...Object.keys(rootPkg.devDependencies ?? {}),
  ]);
  const prodDirect = new Set(Object.keys(rootPkg.dependencies ?? {}));

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.bin' || entry.name === '.cache') continue;
      const full = path.join(dir, entry.name);
      if (entry.name.startsWith('@')) {
        walk(full);
        continue;
      }
      const pkgFile = path.join(full, 'package.json');
      if (fs.existsSync(pkgFile)) {
        const pkg = readJson(pkgFile);
        if (pkg) {
          const key = `${pkg.name ?? entry.name}@${pkg.version ?? '?'}`;
          if (!seen.has(key)) {
            const lic = classify(pkg.license ?? pkg.licenses ?? null);
            seen.set(key, {
              name: pkg.name ?? entry.name,
              version: pkg.version ?? null,
              license: lic.expression,
              verdict: lic.verdict,
              notes: lic.notes,
              direct: direct.has(pkg.name),
              production: prodDirect.has(pkg.name),
            });
          }
        }
      }
      const nested = path.join(full, 'node_modules');
      if (fs.existsSync(nested)) walk(nested);
    }
  };
  walk(path.join(ROOT, 'node_modules'));
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
}

/** Installed Composer packages (backend/vendor/composer/installed.json). */
function collectComposer() {
  const file = path.join(ROOT, 'backend', 'vendor', 'composer', 'installed.json');
  const data = readJson(file);
  if (!data) return { available: false, packages: [] };
  const packages = (data.packages ?? []).map((p) => {
    const lic = classify(p.license ?? null);
    return {
      name: p.name,
      version: p.version,
      license: lic.expression,
      verdict: lic.verdict,
      notes: lic.notes,
      description: p.description ?? null,
    };
  });
  return { available: true, packages };
}

/**
 * Third-party code and executables that are NOT inside a package manager.
 * Each entry is a claim we can point at a file for; anything we cannot point at
 * is recorded as unverified rather than assumed.
 */
function collectVendored() {
  const entries = [
    {
      name: 'plyr (vendored browser build)',
      version: '3.8.4',
      path: 'public/player/plyr.js, public/player/plyr.css',
      license: 'MIT',
      verdict: 'mit',
      scope: 'runtime (served to the WebView player)',
      evidence: 'npm plyr@3.8.4 package.json; upstream https://github.com/sampotts/plyr/blob/master/LICENSE.md',
      notes: ['minified distribution copied into public/; attribution must ship beside it (see THIRD_PARTY_NOTICES.md)'],
    },
    {
      name: 'DejaVu Sans (PDF watermark face)',
      version: '2.34 (shipped inside tecnickcom/tcpdf)',
      path: 'backend/vendor/tecnickcom/tcpdf/fonts/dejavu-fonts-ttf-2.34/',
      license: 'Bitstream Vera Fonts Licence + Arev/DejaVu public-domain additions',
      verdict: 'permissive',
      scope: 'runtime (glyph subset embedded in each delivered PDF)',
      evidence: 'backend/vendor/tecnickcom/tcpdf/fonts/dejavu-fonts-ttf-2.34/LICENSE',
      notes: ['redistribution is allowed; the licence must accompany the font and derived names must not use the reserved names'],
    },
    {
      name: 'VdoCipher React Native bridge + native SDK',
      version: 'vdocipher-rn-bridge 2.0.1 + com.vdocipher SDK (Maven, https://github.com/VdoCipher/maven-repo)',
      path: 'node_modules/vdocipher-rn-bridge, patches/vdocipher-rn-bridge+2.0.1.patch',
      license: '(none declared)',
      verdict: 'unknown',
      scope: 'runtime (video playback / DRM)',
      evidence: 'node_modules/vdocipher-rn-bridge/package.json — "license": "" and no LICENSE file in the tarball',
      notes: [
        'no licence grant is shipped with the bridge, and we additionally patch its Java source',
        'commercial use rests on the VdoCipher service agreement, not on an OSS licence — obtain written terms',
      ],
    },
    {
      name: 'AndroidX / Jetpack + Kotlin + Expo native modules',
      version: 'resolved graph — see docs/android-dependency-report.txt',
      path: 'android/ (Gradle-resolved Maven artifacts)',
      license: 'Apache-2.0 (dominant) / MIT',
      verdict: 'permissive',
      scope: 'native app runtime',
      evidence:
        'individually audited: every artifact on releaseRuntimeClasspath is in the inventory android section, most with the licence read from its POM',
      notes: [
        'this entry is the platform layer at a glance; the per-artifact verdicts (including the 14 proprietary Google artifacts) are authoritative',
        'transitive and non-replaceable on Android; notices are carried by the artifacts themselves',
      ],
    },
    {
      name: 'iOS CocoaPods (Expo modules, React Native)',
      version: 'unresolved locally — no Podfile.lock/Pods in this checkout',
      path: 'ios/Podfile',
      license: 'MIT / Apache-2.0 (per upstream package)',
      verdict: 'unknown',
      scope: 'native app runtime',
      evidence: 'cannot be verified without a macOS `pod install`; declared versions come from package.json only',
      notes: ['flagged unverified: the audited npm versions are the input, the resolved pods are not'],
    },
    {
      name: 'Ghostscript',
      version: 'not a dependency of the default engine (10.08.0 present only on this Windows dev box)',
      path: 'external executable, gated behind PDF_WATERMARK_ACCEPT_AGPL_RENDERER=1',
      license: 'AGPL-3.0 (or Artifex commercial)',
      verdict: 'copyleft',
      gated: true,
      scope: 'optional raster engine — disabled by default',
      evidence: 'backend/docs/PDF_WATERMARK_LICENSING.md',
      notes: [
        'not a dependency of any shipped code path: `raster` needs both PDF_WATERMARK_MODE=raster and',
        'PDF_WATERMARK_ACCEPT_AGPL_RENDERER=1, and `auto` never selects it — so it is excluded from the',
        'blocking set while it stays gated',
      ],
    },
  ];
  return entries;
}

// ── Android / Gradle ─────────────────────────────────────────────────────────

/**
 * Groups whose licence is published in the artifacts themselves (Apache-2.0
 * headers, MIT licence files). Used ONLY when the POM is missing from the local
 * Gradle cache, and every such reading is tagged `evidence: "group-map"` so it
 * is never confused with a licence read out of a POM.
 */
const ANDROID_GROUP_FALLBACKS = [
  [/^androidx\./, 'Apache-2.0'],
  [/^com\.android\./, 'Apache-2.0'],
  [/^com\.google\.android\./, 'Apache-2.0'],
  [/^com\.google\.android\.material$/, 'Apache-2.0'],
  [/^org\.jetbrains\.kotlin/, 'Apache-2.0'],
  [/^org\.jetbrains\.kotlinx/, 'Apache-2.0'],
  [/^org\.jetbrains$/, 'Apache-2.0'],
  [/^com\.facebook\.react$/, 'MIT'],
  [/^com\.facebook\.fresco/, 'MIT'],
  [/^com\.facebook\.soloader/, 'MIT'],
  [/^com\.squareup\.okhttp3/, 'Apache-2.0'],
  [/^com\.squareup\.okio/, 'Apache-2.0'],
  [/^expo\.modules(\.|$)/, 'MIT'],
  [/^host\.exp\.exponent/, 'MIT'],
  [/^com\.google\.guava/, 'Apache-2.0'],
  [/^com\.google\.code\.gson/, 'Apache-2.0'],
  [/^com\.google\.protobuf/, 'BSD-3-Clause'],
  [/^commons-codec/, 'Apache-2.0'],
  [/^commons-io/, 'Apache-2.0'],
];

/** Human-readable POM licence names → SPDX tokens we can classify. */
const POM_LICENCE_ALIASES = new Map([
  ['apache-2.0', 'Apache-2.0'],
  ['apache 2', 'Apache-2.0'],
  ['apache 2.0', 'Apache-2.0'],
  ['apache license 2.0', 'Apache-2.0'],
  ['apache license, version 2.0', 'Apache-2.0'],
  ['the apache license, version 2.0', 'Apache-2.0'],
  ['the apache software license, version 2.0', 'Apache-2.0'],
  ['the apache software license, version 2.0 (the "license")', 'Apache-2.0'],
  ['mit', 'MIT'],
  ['mit license', 'MIT'],
  ['the mit license', 'MIT'],
  ['the mit license (mit)', 'MIT'],
  ['isc', 'ISC'],
  ['bsd', 'BSD-3-Clause'],
  ['bsd license', 'BSD-3-Clause'],
  ['bsd-2-clause', 'BSD-2-Clause'],
  ['bsd-3-clause', 'BSD-3-Clause'],
  ['new bsd license', 'BSD-3-Clause'],
  ['the bsd license', 'BSD-3-Clause'],
  ['the 2-clause bsd license', 'BSD-2-Clause'],
  ['the bouncy castle licence', 'MIT'],
  ['bouncy castle licence', 'MIT'],
  ['eclipse public license - v 1.0', 'EPL-1.0'],
  ['eclipse public license v1.0', 'EPL-1.0'],
  ['eclipse public license - v 2.0', 'EPL-2.0'],
  ['eclipse public license v2.0', 'EPL-2.0'],
  ['epl-1.0', 'EPL-1.0'],
  ['epl-2.0', 'EPL-2.0'],
  ['mpl-2.0', 'MPL-2.0'],
  ['unlicense', 'Unlicense'],
  ['the unlicense', 'Unlicense'],
  ['cc0-1.0', 'CC0-1.0'],
  ['zlib', 'Zlib'],
  ['lgpl-2.1', 'LGPL-2.1-or-later'],
  ['lgpl-3.0', 'LGPL-3.0-or-later'],
  ['apache-2', 'Apache-2.0'],
  ['apache 2.0 license', 'Apache-2.0'],
  ['simplified bsd license', 'BSD-2-Clause'],
  ['bsd 2-clause license', 'BSD-2-Clause'],
  ['the 3-clause bsd license', 'BSD-3-Clause'],
  ['android software development kit license', 'Proprietary'],
  ['android software development kit license agreement', 'Proprietary'],
  ['play core software development kit terms of service', 'Proprietary'],
  ['play integrity api terms of service', 'Proprietary'],
  ['google apis terms of service', 'Proprietary'],
  ['google play services terms of service', 'Proprietary'],
]);

/** Licence URLs are a second, independent signal in a POM. */
const POM_LICENCE_URL_HINTS = [
  [/apache\.org\/licenses\/LICENSE-2\.0/i, 'Apache-2.0'],
  [/opensource\.org\/license\/mit/i, 'MIT'],
  [/opensource\.org\/licenses\/MIT/i, 'MIT'],
  [/mozilla\.org\/MPL\/2\.0/i, 'MPL-2.0'],
  [/eclipse\.org\/legal\/epl-2\.0/i, 'EPL-2.0'],
  [/eclipse\.org\/legal\/epl-v10/i, 'EPL-1.0'],
  [/opensource\.org\/license\/bsd-3-clause/i, 'BSD-3-Clause'],
  [/opensource\.org\/license\/bsd-2-clause/i, 'BSD-2-Clause'],
  [/opensource\.org\/license\/isc/i, 'ISC'],
  [/gnu\.org\/licenses\/lgpl-2\.1/i, 'LGPL-2.1-or-later'],
  [/gnu\.org\/licenses\/lgpl-3\.0/i, 'LGPL-3.0-or-later'],
  [/gnu\.org\/licenses\/gpl-3\.0/i, 'GPL-3.0-or-later'],
  [/gnu\.org\/licenses\/agpl-3\.0/i, 'AGPL-3.0'],
];

function decodeXml(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function gradleUserHome() {
  return process.env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle');
}

/**
 * Every Maven cache this checkout might have populated. A machine can have the
 * user-level cache AND a project-local one (`.gradle-build/`), and a given POM
 * or AAR is only in whichever one the last build used — so all are searched.
 */
function gradleModuleCaches() {
  const roots = [
    path.join(gradleUserHome(), 'caches', 'modules-2', 'files-2.1'),
    path.join(ROOT, '.gradle-build', 'caches', 'modules-2', 'files-2.1'),
    path.join(ROOT, 'android', '.gradle', 'caches', 'modules-2', 'files-2.1'),
  ];
  return roots.filter((r, i) => roots.indexOf(r) === i && fs.existsSync(r));
}

/** First cached file with `ext` for a coordinate, across every cache root. */
function findInGradleCaches(group, artifact, version, ext) {
  for (const cache of gradleModuleCaches()) {
    const hit = findCachedFile(path.join(cache, group, artifact, version), ext);
    if (hit) return hit;
  }
  return null;
}

/** First file with `ext` under `dir`/any one-level subdirectory (Gradle hashes). */
function findCachedFile(dir, ext) {
  let hashes;
  try {
    hashes = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const h of hashes) {
    if (!h.isDirectory()) {
      if (h.name.endsWith(ext)) return path.join(dir, h.name);
      continue;
    }
    let files;
    try {
      files = fs.readdirSync(path.join(dir, h.name));
    } catch {
      continue;
    }
    const hit = files.find((f) => f.endsWith(ext));
    if (hit) return path.join(dir, h.name, hit);
  }
  return null;
}

/** The `<licenses>` blocks of a POM, as [{name, url}]. */
function readPomLicences(pomText) {
  const block = pomText.match(/<licenses>([\s\S]*?)<\/licenses>/);
  if (!block) return [];
  const out = [];
  const re = /<license>([\s\S]*?)<\/license>/g;
  let m;
  while ((m = re.exec(block[1]))) {
    out.push({
      name: decodeXml((m[1].match(/<name>([\s\S]*?)<\/name>/) ?? [])[1]),
      url: decodeXml((m[1].match(/<url>([\s\S]*?)<\/url>/) ?? [])[1]),
      comments: decodeXml((m[1].match(/<comments>([\s\S]*?)<\/comments>/) ?? [])[1]),
    });
  }
  return out;
}

/** POM name/URL → SPDX token, or null when we cannot identify it. */
function pomLicenceToken(entry) {
  const name = String(entry.name ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
  if (POM_LICENCE_ALIASES.has(name)) return POM_LICENCE_ALIASES.get(name);
  if (entry.url) {
    for (const [re, token] of POM_LICENCE_URL_HINTS) if (re.test(entry.url)) return token;
  }
  return null;
}

/**
 * Classify a POM's licence list.
 *
 * Several `<license>` entries mean the consumer may choose (OR). The one place
 * this must NOT be treated as a free choice is when an entry is unidentifiable:
 * a POM listing "Apache-2.0" AND a proprietary option would otherwise be
 * laundered into the permissive side, so any unidentified entry forces
 * `unknown`.
 */
function classifyPomLicences(licences) {
  if (!licences.length) {
    return { expression: '(none declared)', verdict: 'unknown', notes: ['POM has no <licenses> block'] };
  }
  const results = licences.map((entry) => {
    const token = pomLicenceToken(entry);
    if (token) return classify(token);
    const label = entry.name || entry.url || '(unnamed licence)';
    return { expression: label, verdict: 'unknown', notes: [`unrecognised POM licence "${label}"`] };
  });
  const expression = results.map((r) => r.expression).join(' OR ');
  if (results.length === 1) return { ...results[0], expression };
  if (results.some((r) => r.verdict === 'unknown')) {
    return {
      expression,
      verdict: 'unknown',
      notes: ['multiple POM licences, at least one unrecognised — recorded as unknown, not as the permissive option'],
    };
  }
  const best = [...results].sort((a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict])[0];
  return { expression, verdict: best.verdict, notes: [`multiple POM licences; consumer may choose "${best.expression}"`] };
}

/**
 * Parse either a raw `gradle :app:dependencies` transcript or the normalised
 * report this script writes. Handles the tree glyphs, `(*)` repeats, `->`
 * version upgrades and `(c)` constraints; ignores `project :lib` entries.
 */
function parseGradleTree(text, configuration = ANDROID_CONFIGURATION) {
  const lines = String(text).split(/\r?\n/);
  const header = new RegExp('^' + configuration + '\\b');
  const start = lines.findIndex((l) => header.test(l));
  const normalised = start < 0; // our own report: bare group:artifact:version lines
  const artifacts = new Map();
  if (normalised && !lines.some((l) => !/^\s*(#|$)/.test(l))) return artifacts;

  for (let i = normalised ? 0 : start + 1; i < lines.length; i++) {
    let line = lines[i];
    if (normalised) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
    } else {
      // Inside a Gradle tree every line begins with a glyph or whitespace; a line
      // that begins with a letter or digit is the next configuration's header.
      if (/^[A-Za-z0-9]/.test(line)) break;
      line = line.trim();
      if (!line || line === '(*)' || line.startsWith('#')) continue;
      line = line.replace(/^[|+\\\-\s]+/, '').trim();
      if (!line || line.startsWith('project ') || /^FAILED/.test(line)) continue;
    }
    line = line.replace(/\s+\([*c]\)$/, '').trim();
    const [coordPart, arrowPart] = line.split(/\s+->\s+/);
    const left = (coordPart ?? '').replace(/\s+\([*c]\)$/, '').trim();
    const right = (arrowPart ?? '').replace(/\s+\([*c]\)$/, '').trim();
    const VERSION = /^[A-Za-z0-9_.\-+]+$/;
    const fullCoord = /^([A-Za-z0-9_.\-]+):([A-Za-z0-9_.\-]+):([A-Za-z0-9_.\-+]+)$/;
    const twoPart = /^([A-Za-z0-9_.\-]+):([A-Za-z0-9_.\-]+)$/;

    let group;
    let artifact;
    let version;
    // `old:module:+ -> new:module:1.2.3` is a MODULE SUBSTITUTION (`react-native`
    // is replaced by `react-android`), so the right-hand coordinate is the
    // artifact that actually ships.
    const substituted = right ? right.match(fullCoord) : null;
    if (substituted) {
      [, group, artifact, version] = substituted;
    } else {
      const three = left.match(fullCoord);
      if (three) {
        [, group, artifact] = three;
        version = right && VERSION.test(right) ? right : three[3];
      } else {
        // `group:artifact -> 1.2.3`, the form used when the version comes from a
        // platform/BOM rather than the declaration.
        const two = left.match(twoPart);
        if (!two || !right || !VERSION.test(right)) continue;
        [, group, artifact] = two;
        version = right;
      }
    }
    // A dynamic `+` version means Gradle never told us what it picked.
    if (!VERSION.test(version) || version === '+') continue;
    artifacts.set(`${group}:${artifact}`, { group, artifact, version });
  }
  return artifacts;
}

/**
 * Minimal ZIP reader — enough to pull `META-INF/LICENSE*` out of an AAR/JAR
 * without adding a dependency. Supports stored (0) and deflated (8) entries;
 * anything else is skipped, and a malformed archive simply yields no text.
 *
 * @param {string} file
 * @param {(name:string)=>boolean} wanted
 * @returns {Array<{name:string, text:string}>}
 */
function readZipTextEntries(file, wanted, limit = 256 * 1024) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return [];
  }
  const eocd = (() => {
    const floor = Math.max(0, buf.length - 66 * 1024);
    for (let i = buf.length - 22; i >= floor; i--) if (buf.readUInt32LE(i) === 0x06054b50) return i;
    return -1;
  })();
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count && ptr + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    const next = ptr + 46 + nameLen + extraLen + commentLen;
    ptr = next;
    if (!wanted(name) || compSize > limit) continue;
    try {
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(start, start + compSize);
      const data = method === 0 ? raw : method === 8 ? require('zlib').inflateRawSync(raw) : null;
      if (data) out.push({ name, text: data.toString('utf8') });
    } catch {
      // A corrupt entry is not evidence either way — keep looking.
    }
  }
  return out;
}

/** Licence text shipped inside an artifact → SPDX token, or null. */
function licenceTokenFromText(text) {
  const t = String(text ?? '');
  if (!t) return null;
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(t)) return 'AGPL-3.0';
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(t)) return 'LGPL-3.0-or-later';
  if (/GNU GENERAL PUBLIC LICENSE/i.test(t)) return 'GPL-3.0-or-later';
  if (/Mozilla Public License|MPL\s*2\.0/i.test(t)) return 'MPL-2.0';
  if (/Eclipse Public License/i.test(t)) {
    return /-\s*v\s*1\.0|Version 1\.0/i.test(t) ? 'EPL-1.0' : 'EPL-2.0';
  }
  if (/Apache License,?\s*Version 2\.0|Apache License\s*\n?\s*Version 2\.0/i.test(t)) return 'Apache-2.0';
  if (/Permission is hereby granted, free of charge, to any person obtaining a copy/i.test(t)) return 'MIT';
  if (/Redistribution and use in source and binary forms/i.test(t)) return 'BSD-3-Clause';
  return null;
}

/** The licence a shipped artifact carries in its own META-INF. */
function licenceFromArtifactBytes(group, artifact, version) {
  for (const ext of ['.aar', '.jar']) {
    const file = findInGradleCaches(group, artifact, version, ext);
    if (!file) continue;
    // AndroidX and Firebase nest these as META-INF/<group>/<artifact>/LICENSE.txt.
    const entries = readZipTextEntries(file, (name) =>
      /^META-INF\//i.test(name) && /(^|\/)(LICEN[CS]E|NOTICE)/i.test(name),
    );
    if (!entries.length) continue;
    const licenceEntries = entries.filter((e) => /LICEN[CS]E/i.test(e.name));
    for (const entry of licenceEntries) {
      const token = licenceTokenFromText(entry.text);
      if (token) {
        return {
          token,
          ref: `${path.basename(file)}!${entry.name}`,
        };
      }
    }
    // NOTICE files are copyright lists, not licence grants; only used to
    // recognise the licence when no LICENSE entry resolved.
    for (const entry of entries) {
      const token = licenceTokenFromText(entry.text);
      if (token) return { token, ref: `${path.basename(file)}!${entry.name}` };
    }
  }
  return null;
}

/** Resolve one artifact's licence from the POM Gradle downloaded for it. */
function licenceForArtifact(group, artifact, version) {
  // What the POM claimed, kept so a fallback can still show it.
  let pomResult = null;
  // 1. The POM Gradle downloaded — best available declaration.
  const pomPath = findInGradleCaches(group, artifact, version, '.pom');
  if (pomPath) {
    let licences = [];
    try {
      licences = readPomLicences(fs.readFileSync(pomPath, 'utf8'));
    } catch {
      licences = [];
    }
    if (licences.length) {
      const result = classifyPomLicences(licences);
      // An unrecognised POM licence is reported precisely rather than guessed at
      // from the group name — except that a declared proprietary/vendor term is
      // a real answer, not an unknown.
      if (result.verdict !== 'unknown') {
        return {
          license: result.expression,
          verdict: result.verdict,
          notes: result.notes,
          evidence: 'pom',
          evidenceRef: `${group}/${artifact}/${version}/pom`,
        };
      }
      // Fall through: the POM text stays recorded on whatever we return below.
      pomResult = result;
    }
  }

  // 2. The licence text actually shipped inside the AAR/JAR. This is the
  //    licence of the bytes we redistribute, so it beats any declaration.
  const inArtifact = licenceFromArtifactBytes(group, artifact, version);
  if (inArtifact) {
    const lic = classify(inArtifact.token);
    return {
      license: inArtifact.token,
      verdict: lic.verdict,
      notes: [
        'licence text read from the shipped artifact\'s META-INF',
        ...(pomResult ? [`POM said "${pomResult.expression}"`] : []),
      ],
      evidence: 'artifact',
      evidenceRef: `${group}/${artifact}/${version}/${inArtifact.ref}`,
    };
  }

  // 3. A group whose licence is published in its artifact headers.
  const fallback = ANDROID_GROUP_FALLBACKS.find(([re]) => re.test(group));
  if (fallback) {
    const lic = classify(fallback[1]);
    return {
      license: fallback[1],
      verdict: lic.verdict,
      notes: [
        'no usable POM licence and no META-INF licence; taken from the group\'s published headers',
        ...(pomResult ? [`POM said "${pomResult.expression}"`] : []),
      ],
      evidence: 'group-map',
      evidenceRef: 'ANDROID_GROUP_FALLBACKS',
    };
  }

  if (pomResult) {
    return {
      license: pomResult.expression,
      verdict: 'unknown',
      notes: pomResult.notes,
      evidence: 'pom',
      evidenceRef: `${group}/${artifact}/${version}/pom`,
    };
  }
  return {
    license: '(not resolved)',
    verdict: 'unknown',
    notes: ['no POM, no META-INF licence in the artifact and no recorded licence for this group'],
    evidence: 'none',
  };
}

/**
 * Split the committed report into its `# section: <configuration>` blocks.
 * A report with no section markers is treated as one release section.
 */
function parseAndroidReport(text) {
  const sections = [];
  let current = { name: ANDROID_CONFIGURATION, lines: [] };
  for (const line of String(text).split(/\r?\n/)) {
    const head = line.match(/^#\s*section:\s*([A-Za-z0-9_.-]+)/);
    if (head) {
      if (current.lines.some((l) => l.trim())) sections.push(current);
      current = { name: head[1], lines: [] };
      continue;
    }
    if (line.startsWith('#')) continue;
    current.lines.push(line);
  }
  if (current.lines.some((l) => l.trim())) sections.push(current);
  return sections
    .filter((s) => s.lines.some((l) => l.trim()))
    .map((s) => ({ name: s.name, artifacts: parseGradleTree(s.lines.join('\n')) }));
}

/**
 * Every artifact on every audited Android configuration, merged by coordinate.
 * `shipped` records the widest exposure the artifact reaches:
 *   release — in the published APK/AAB; debug — debug builds only; build — the
 *   build machine only. A library that appears in both release and debug is
 *   reported as release (the stricter case).
 */
function collectAndroid() {
  if (!fs.existsSync(ANDROID_REPORT_PATH)) {
    return {
      available: false,
      reason: `missing ${path.relative(ROOT, ANDROID_REPORT_PATH).replace(/\\/g, '/')} — regenerate with: node scripts/dependency-license-audit.cjs --gradle`,
      configuration: ANDROID_CONFIGURATION,
      sections: [],
      packages: [],
    };
  }
  const sections = parseAndroidReport(fs.readFileSync(ANDROID_REPORT_PATH, 'utf8'));
  const merged = new Map();
  for (const section of sections) {
    const meta = ANDROID_SECTIONS.find((s) => s.name === section.name);
    const shipped = meta?.shipped ?? (section.name === 'classpath' ? 'build' : 'debug');
    for (const a of section.artifacts.values()) {
      const key = `${a.group}:${a.artifact}`;
      const existing = merged.get(key);
      if (existing) {
        existing.configurations.push(section.name);
        // release wins over debug wins over build.
        const rank = { release: 3, debug: 2, build: 1 };
        if ((rank[shipped] ?? 0) > (rank[existing.shipped] ?? 0)) existing.shipped = shipped;
      } else {
        merged.set(key, {
          group: a.group,
          artifact: a.artifact,
          version: a.version,
          shipped,
          configurations: [section.name],
        });
      }
    }
  }

  const packages = [...merged.values()]
    .map((a) => ({
      name: `${a.group}:${a.artifact}`,
      group: a.group,
      artifact: a.artifact,
      version: a.version,
      ...licenceForArtifact(a.group, a.artifact, a.version),
      production: a.shipped === 'release',
      shipped: a.shipped,
      configurations: a.configurations.sort(),
      scope:
        a.shipped === 'release'
          ? 'native app runtime (published build)'
          : a.shipped === 'debug'
            ? 'native app runtime (debug builds only)'
            : 'Gradle buildscript (build machine only)',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const byEvidence = {};
  const byShipped = {};
  for (const p of packages) {
    byEvidence[p.evidence] = (byEvidence[p.evidence] ?? 0) + 1;
    byShipped[p.shipped] = (byShipped[p.shipped] ?? 0) + 1;
  }
  return {
    available: true,
    configuration: ANDROID_CONFIGURATION,
    configurations: sections.map((s) => s.name),
    report: path.relative(ROOT, ANDROID_REPORT_PATH).replace(/\\/g, '/'),
    byEvidence,
    byShipped,
    packages,
  };
}

/**
 * Re-resolve the Android graph and rewrite the committed report.
 * Never throws: a missing Gradle/JDK/SDK is reported, and the audit then runs
 * from the last committed report instead of silently auditing nothing.
 */
function generateAndroidReport() {
  const androidDir = path.join(ROOT, 'android');
  if (!fs.existsSync(androidDir)) return { ok: false, reason: 'no android/ directory in this checkout' };
  const windows = process.platform === 'win32';
  const runGradle = (args) => {
    // Fixed argument list: nothing from the repository, the environment or the
    // command line is interpolated into the process invocation. On Windows the
    // wrapper is a .bat, so cmd.exe must interpret it, one token per argv
    // element (which is why the checkout path must not contain spaces there).
    const res = windows
      ? spawnSync(
          process.env.ComSpec || 'cmd.exe',
          ['/d', '/c', path.join(androidDir, 'gradlew.bat'), ...args],
          { cwd: androidDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000 },
        )
      : spawnSync(path.join(androidDir, 'gradlew'), args, {
          cwd: androidDir,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          timeout: 20 * 60 * 1000,
        });
    if (res.error || res.status !== 0) {
      const detail = res.error?.message || (res.stderr || '').split(/\r?\n/).filter(Boolean).slice(-3).join(' / ');
      return { ok: false, reason: `gradle exited ${res.status ?? 'null'}: ${detail}` };
    }
    return { ok: true, stdout: res.stdout ?? '' };
  };

  const out = [
    '# Android resolved dependencies',
    '# generated by: node scripts/dependency-license-audit.cjs --gradle',
    '# one resolved artifact per line (group:artifact:version) — do not edit by hand.',
  ];
  const report = { ok: true, sections: {}, failures: [] };
  for (const section of ANDROID_SECTIONS) {
    const args =
      section.name === 'classpath'
        ? ['--offline', '--console=plain', 'buildEnvironment']
        : ['--offline', '--console=plain', ':app:dependencies', '--configuration', section.name];
    const res = runGradle(args);
    if (!res.ok) {
      report.failures.push(`${section.name}: ${res.reason}`);
      continue;
    }
    const artifacts = parseGradleTree(res.stdout, section.name);
    if (!artifacts.size) {
      report.failures.push(`${section.name}: no artifacts parsed`);
      continue;
    }
    report.sections[section.name] = artifacts.size;
    out.push('', `# section: ${section.name} (${section.label})`);
    out.push(...[...artifacts.values()].map((a) => `${a.group}:${a.artifact}:${a.version}`).sort());
  }
  if (!Object.keys(report.sections).length) {
    return { ok: false, reason: report.failures.join('; ') || 'gradle produced nothing' };
  }
  fs.mkdirSync(path.dirname(ANDROID_REPORT_PATH), { recursive: true });
  fs.writeFileSync(ANDROID_REPORT_PATH, out.join('\n') + '\n');
  report.path = path.relative(ROOT, ANDROID_REPORT_PATH).replace(/\\/g, '/');
  report.count = Object.values(report.sections).reduce((a, b) => a + b, 0);
  return report;
}

/* ── iOS (CocoaPods) ─────────────────────────────────────────────────────── */

/**
 * CocoaPods: the only thing this checkout can prove is which pods are ASKED
 * for. Without `Podfile.lock` or `Pods/Manifest.lock` (both produced by
 * `pod install` on macOS) the resolved versions — and therefore the licences —
 * are unknown, and that is what gets recorded instead of a guess.
 */
function collectIos() {
  const podfile = path.join(ROOT, 'ios', 'Podfile');
  const lock = path.join(ROOT, 'ios', 'Podfile.lock');
  const manifest = path.join(ROOT, 'ios', 'Pods', 'Manifest.lock');
  const declared = [];
  if (fs.existsSync(podfile)) {
    const text = fs.readFileSync(podfile, 'utf8');
    const re = /^\s*pod\s+'([^']+)'(?:\s*,\s*'([^']+)')?/gm;
    let m;
    while ((m = re.exec(text))) declared.push({ name: m[1], constraint: m[2] ?? null });
  }
  const resolvedFile = fs.existsSync(lock) ? lock : fs.existsSync(manifest) ? manifest : null;
  return {
    available: Boolean(resolvedFile),
    podfile: fs.existsSync(podfile),
    declared,
    reason: resolvedFile
      ? null
      : 'no ios/Podfile.lock or ios/Pods/Manifest.lock in this checkout — resolved pod versions are unknown until `pod install` runs on macOS',
    packages: [],
  };
}

/* ── Scope and the strict MIT-only gate ─────────────────────────────────── */

function loadExceptions() {
  const data = readJson(EXCEPTIONS_PATH);
  if (!data) return { available: false, note: null, patterns: [] };
  return {
    available: true,
    note: data.note ?? null,
    patterns: Array.isArray(data.exceptions) ? data.exceptions : [],
  };
}

/** `androidx.*:*` style matching — deliberate wildcards only, no regex input. */
function globMatch(value, pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$').test(value);
}

/**
 * What the strict gate covers, stated precisely because the scope is a choice:
 *   npm       — packages we DECLARE as production dependencies. Transitive
 *               permissive packages are excluded by policy (see the report):
 *               their notices are met, but replacing them is not a choice we
 *               make and would not change our own licence position.
 *   composer  — every PHP runtime package (that is the whole backend).
 *   android   — every artifact in the RELEASE graph (what ships in the APK).
 *   vendored  — third-party code copied into the repo and served/shipped.
 * Debug-only and buildscript Android artifacts are reported but not gated,
 * because they never reach a user.
 */
function buildScope(inv) {
  return [
    ...inv.npm
      .filter((p) => p.direct === true && p.production === true)
      .map((p) => ({ ...p, ecosystem: 'npm' })),
    ...inv.composer.packages.map((p) => ({ ...p, ecosystem: 'composer' })),
    ...inv.android.packages
      .filter((p) => p.shipped === 'release')
      .map((p) => ({ ...p, ecosystem: 'android' })),
    ...inv.vendored.filter((p) => !p.gated).map((p) => ({ ...p, ecosystem: 'vendored' })),
  ];
}

/**
 * The strict gate: in-scope packages must be MIT, or match an explicitly
 * recorded exception in `license-exceptions.json`. Anything else FAILS — that
 * is the difference between "we know we are not MIT-only" and "nobody noticed".
 */
function evaluateMitOnly(inv) {
  const scope = buildScope(inv);
  const { available, note, patterns } = loadExceptions();
  const covered = [];
  const uncovered = [];
  for (const p of scope) {
    if (p.verdict === 'mit') continue;
    const hit = patterns.find(
      (e) => e && e.pattern && globMatch(p.name, e.pattern) && (!e.ecosystem || e.ecosystem === p.ecosystem),
    );
    if (hit) {
      covered.push({
        name: p.name,
        ecosystem: p.ecosystem,
        license: p.license,
        verdict: p.verdict,
        pattern: hit.pattern,
        reason: hit.reason ?? null,
      });
    } else {
      uncovered.push({ name: p.name, ecosystem: p.ecosystem, license: p.license, verdict: p.verdict });
    }
  }
  return {
    scopeSize: scope.length,
    mitInScope: scope.filter((p) => p.verdict === 'mit').length,
    covered,
    uncovered,
    exceptionsFile: available,
    exceptionsNote: note,
    exceptionPatterns: patterns.length,
  };
}

function summarise(packages) {
  const byVerdict = {};
  const byLicense = {};
  for (const p of packages) {
    byVerdict[p.verdict] = (byVerdict[p.verdict] ?? 0) + 1;
    byLicense[p.license] = (byLicense[p.license] ?? 0) + 1;
  }
  return { total: packages.length, byVerdict, byLicense };
}

function buildInventory() {
  const npm = collectNpm();
  const composer = collectComposer();
  const vendored = collectVendored();
  const android = collectAndroid();
  const ios = collectIos();

  const tag = (ecosystem) => (p) => ({ ...p, ecosystem });
  const    blocking = [
    ...npm.filter((p) => p.verdict === 'copyleft').map(tag('npm')),
    ...composer.packages.filter((p) => p.verdict === 'copyleft').map(tag('composer')),
    ...android.packages.filter((p) => p.verdict === 'copyleft').map(tag('android')),
    // A gated entry is documented but not reachable from any shipped code path
    // (the Ghostscript raster engine), so it is reported separately.
    ...vendored
      .filter((p) => p.verdict === 'copyleft' && !p.gated)
      .map(tag('vendored')),
  ];
  // A copyleft BUILD tool (Gradle plugin) never reaches a user, so it is not a
  // distribution blocker; say which entries those are rather than dropping them.
  const blockingShipped = blocking.filter((p) => p.shipped !== 'build');
  const weakCopyleft = [
    ...npm.filter((p) => p.verdict === 'weak-copyleft').map(tag('npm')),
    ...composer.packages.filter((p) => p.verdict === 'weak-copyleft').map(tag('composer')),
    ...android.packages.filter((p) => p.verdict === 'weak-copyleft').map(tag('android')),
    ...vendored.filter((p) => p.verdict === 'weak-copyleft').map(tag('vendored')),
  ];
  const unknown = [
    ...npm.filter((p) => p.verdict === 'unknown').map(tag('npm')),
    ...composer.packages.filter((p) => p.verdict === 'unknown').map(tag('composer')),
    ...android.packages.filter((p) => p.verdict === 'unknown').map(tag('android')),
    ...vendored.filter((p) => p.verdict === 'unknown').map(tag('vendored')),
  ];
  // Vendor terms, not an OSS grant: these are usable because we accept the
  // vendor's agreement (Play, Play Integrity, VdoCipher), but they are not
  // licences we may describe as free/MIT, so they get their own section.
  const proprietary = [...android.packages.filter((p) => p.verdict === 'proprietary').map(tag('android'))];

  const inventory = {
    generatedAt: new Date().toISOString(),
    project: {
      name: readJson(path.join(ROOT, 'package.json'))?.name ?? 'medacademy',
      version: readJson(path.join(ROOT, 'package.json'))?.version ?? null,
    },
    summary: {
      npm: summarise(npm),
      composer: summarise(composer.packages),
      android: summarise(android.packages),
      vendored: summarise(vendored),
      ios: { total: 0, declared: ios.declared.length, resolved: ios.available },
      mitOnlyTarget:
        npm.every((p) => p.verdict === 'mit') &&
        composer.packages.every((p) => p.verdict === 'mit') &&
        android.packages.every((p) => p.verdict === 'mit'),
    },
    blocking,
    blockingShipped,
    weakCopyleft,
    proprietary,
    unknown,
    npm,
    composer,
    android,
    ios,
    vendored,
  };
  // The strict gate needs the whole inventory, so it is evaluated last.
  inventory.mitOnly = evaluateMitOnly(inventory);
  return inventory;
}

// ── Notices rendering ────────────────────────────────────────────────────────

const LICENCE_URLS = {
  MIT: 'https://opensource.org/license/mit',
  ISC: 'https://opensource.org/license/isc-license-txt',
  'Apache-2.0': 'https://www.apache.org/licenses/LICENSE-2.0',
  'BSD-2-Clause': 'https://opensource.org/license/bsd-2-clause',
  'BSD-3-Clause': 'https://opensource.org/license/bsd-3-clause',
  'BlueOak-1.0.0': 'https://blueoakcouncil.org/license/1.0.0',
  'MPL-2.0': 'https://www.mozilla.org/MPL/2.0/',
  'LGPL-3.0-or-later': 'https://www.gnu.org/licenses/lgpl-3.0.html',
  'LGPL-2.1-or-later': 'https://www.gnu.org/licenses/lgpl-2.1.html',
  'CC-BY-4.0': 'https://creativecommons.org/licenses/by/4.0/',
  '0BSD': 'https://opensource.org/license/0bsd',
  Unlicense: 'https://unlicense.org/',
  'Zlib': 'https://opensource.org/license/zlib',
  'Python-2.0': 'https://opensource.org/license/python-2.0',
};

function renderNotices(inv) {
  const lines = [];
  lines.push('# Third-party notices');
  lines.push('');
  lines.push('MedAcademy is proprietary software, but it is built on third-party components whose');
  lines.push('licences require us to keep their copyright and permission notices. This file is');
  lines.push('generated — do not edit it by hand:');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/dependency-license-audit.cjs');
  lines.push('```');
  lines.push('');
  lines.push(`Generated: ${inv.generatedAt}`);
  lines.push('');
  lines.push('Full licence texts are installed alongside each package:');
  lines.push('`node_modules/<package>/LICENSE*` for JavaScript, `backend/vendor/<vendor>/<package>/`');
  lines.push('for PHP. Where a package ships no separate licence file, the licence identifier in');
  lines.push('its `package.json` / Composer metadata is authoritative.');
  lines.push('');
  lines.push('## Components with a notice obligation outside the package managers');
  lines.push('');

  for (const v of inv.vendored) {
    lines.push(`### ${v.name}`);
    lines.push('');
    lines.push(`- Version: ${v.version}`);
    lines.push(`- Location: \`${v.path}\``);
    lines.push(`- Licence: ${v.license}`);
    lines.push(`- Used for: ${v.scope}`);
    lines.push(`- Evidence: ${v.evidence}`);
    if (v.notes?.length) {
      for (const n of v.notes) lines.push(`- Note: ${n}`);
    }
    lines.push('');
  }

  lines.push('## PHP backend');
  lines.push('');
  if (!inv.composer.available) {
    lines.push('`backend/vendor/` is not installed in this checkout, so the PHP dependency licences');
    lines.push('could not be read from disk here. Composer metadata is the authority: see');
    lines.push('`backend/composer.lock`.');
  } else {
    lines.push('| Package | Version | Licence |');
    lines.push('|---|---|---|');
    for (const p of inv.composer.packages) {
      const url = LICENCE_URLS[p.license];
      lines.push(`| ${p.name} | ${p.version} | ${url ? `[${p.license}](${url})` : p.license} |`);
    }
  }
  lines.push('');

  lines.push('## Android / Maven (resolved graph)');
  lines.push('');
  if (!inv.android.available) {
    lines.push('The Android dependency graph was not audited in this checkout:');
    lines.push(`\`${inv.android.reason}\``);
  } else {
    lines.push(
      `\`${inv.android.configuration}\` resolves to **${inv.summary.android.total} artifacts**`,
    );
    lines.push(
      `(read from \`${inv.android.report}\`; licence evidence: ${Object.entries(inv.android.byEvidence ?? {})
        .map(([k, v]) => `\`${k}\` × ${v}`)
        .join(', ')}).`,
    );
    lines.push('');
    lines.push(
      'The Apache-2.0 artifacts below carry their own `NOTICE` files, which the Android Gradle',
    );
    lines.push('Plugin merges into the APK; they are not re-listed here. Artifacts whose licence is');
    lines.push('neither MIT nor Apache-2.0 are listed explicitly:');
    lines.push('');
    const androidNotable = inv.android.packages.filter(
      (p) => p.verdict !== 'mit' && !/^Apache-2\.0$/i.test(p.license),
    );
    if (!androidNotable.length) {
      lines.push('_None — every artifact is MIT or Apache-2.0._');
    } else {
      lines.push('| Artifact | Version | Licence | Evidence |');
      lines.push('|---|---|---|---|');
      for (const p of androidNotable) {
        const lic = String(p.license).replace(/\|/g, '\\|');
        lines.push(`| ${p.name} | ${p.version} | ${lic} | ${p.evidence} |`);
      }
    }
  }
  lines.push('');

  lines.push('## JavaScript / npm');
  lines.push('');
  lines.push(
    `${inv.summary.npm.total} installed packages. The table lists every non-MIT licence; all remaining packages`,
  );
  lines.push('are MIT and are covered by the same notice text (see `node_modules/<package>/LICENSE`).');
  lines.push('');
  lines.push('| Package | Version | Licence |');
  lines.push('|---|---|---|');
  for (const p of inv.npm.filter((x) => x.verdict !== 'mit').sort((a, b) => a.name.localeCompare(b.name))) {
    const url = LICENCE_URLS[p.license];
    const lic = p.license.replace(/\|/g, '\\|');
    lines.push(`| ${p.name} | ${p.version ?? '?'} | ${url ? `[${lic}](${url})` : lic} |`);
  }
  lines.push('');
  lines.push('Packages whose licence is MIT (or MIT chosen from a dual licence) are not listed');
  lines.push('individually here to keep this file reviewable; the machine-readable inventory at');
  lines.push('`docs/dependency-license-inventory.json` lists every one of them with its version.');
  lines.push('');
  lines.push('## Fonts and media');
  lines.push('');
  lines.push('- DejaVu Sans (embedded in watermarked PDFs) — Bitstream Vera Fonts Licence,');
  lines.push('  shipped at `backend/vendor/tecnickcom/tcpdf/fonts/dejavu-fonts-ttf-2.34/LICENSE`.');
  lines.push('- Plyr 3.8.4 (`public/player/plyr.js`, `public/player/plyr.css`) — MIT,');
  lines.push('  see `public/player/THIRD_PARTY_NOTICES.txt`.');
  lines.push('');
  lines.push('## What this file does not do');
  lines.push('');
  lines.push('A notice is not a licence verification. The verdicts, versions and open gaps are');
  lines.push('argued in `DEPENDENCY_LICENSE_AUDIT.md`; read that before shipping to a store or');
  lines.push('signing a customer contract.');
  lines.push('');
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main(argv) {
  const checkOnly = argv.includes('--check');
  if (argv.includes('--gradle')) {
    const gen = generateAndroidReport();
    console.log(
      gen.ok
        ? `android: re-resolved ${gen.count} artifacts → ${gen.path}`
        : `android: could not re-resolve (${gen.reason}) — using the committed report`,
    );
  }
  const inv = buildInventory();

  // Only copyleft that actually reaches a user blocks distribution; a Gradle
  // plugin used to BUILD the app is reported but not a shipped-code blocker.
  const blocking = inv.blockingShipped.filter((p) => p.verdict === 'copyleft');
  const unknownProd = inv.unknown.filter((p) => p.production !== false);
  const gated = inv.vendored.filter((p) => p.gated);

  console.log(`npm:      ${inv.summary.npm.total} packages  ${JSON.stringify(inv.summary.npm.byVerdict)}`);
  console.log(`composer: ${inv.summary.composer.total} packages  ${JSON.stringify(inv.summary.composer.byVerdict)}`);
  console.log(
    inv.android.available
      ? `android:  ${inv.summary.android.total} artifacts ${JSON.stringify(inv.summary.android.byVerdict)}  evidence ${JSON.stringify(inv.android.byEvidence)}`
      : `android:  NOT AUDITED (${inv.android.reason})`,
  );
  console.log(`vendored: ${inv.summary.vendored.total} entries    ${JSON.stringify(inv.summary.vendored.byVerdict)}`);
  console.log(
    inv.ios.available
      ? `ios:      ${inv.ios.packages.length} resolved pods`
      : `ios:      NOT AUDITED (${inv.ios.reason})`,
  );
  console.log(`MIT-only target met: ${inv.summary.mitOnlyTarget ? 'yes' : 'NO'}`);

  if (inv.weakCopyleft.length) {
    console.log('\nweak-copyleft (usable unmodified, notices must be kept):');
    for (const p of inv.weakCopyleft) console.log(`  ${p.ecosystem}  ${p.name}@${p.version}  ${p.license}`);
  }
  if (inv.proprietary.length) {
    console.log('\nproprietary vendor terms (no OSS grant; usable only under the vendor agreement):');
    for (const p of inv.proprietary) console.log(`  ${p.ecosystem}  ${p.name}@${p.version ?? '?'}  ${p.license}`);
  }
  if (unknownProd.length) {
    console.log('\nlicence unknown / not declared:');
    for (const p of unknownProd) console.log(`  ${p.ecosystem}  ${p.name}@${p.version ?? '?'}  ${p.license}`);
  }
  if (gated.length) {
    console.log('\ngated (present in the repo, unreachable from shipped code):');
    for (const p of gated) console.log(`  ${p.name}  ${p.license}`);
  }
  if (blocking.length) {
    console.log('\nBLOCKING copyleft:');
    for (const p of blocking) console.log(`  ${p.ecosystem}  ${p.name}@${p.version}  ${p.license}`);
  }

  if (checkOnly) {
    if (blocking.length) {
      console.error('\nFAIL: a dependency with a blocking licence is present in the tree.');
      process.exit(1);
    }
    console.log('\nOK: no GPL/AGPL/SSPL/BUSL dependency in shipped code.');
    return;
  }

  if (argv.includes('--mit-only')) {
    const gate = inv.mitOnly;
    console.log(
      `\nMIT-only gate: ${gate.mitInScope}/${gate.scopeSize} in-scope units are MIT; ` +
        `${gate.covered.length} covered by ${gate.exceptionPatterns} recorded exception(s) in license-exceptions.json`,
    );
    if (!gate.exceptionsFile) {
      console.log('  (no license-exceptions.json found — every non-MIT in-scope unit is uncovered)');
    }
    if (gate.uncovered.length) {
      console.log(`\nUNCOVERED non-MIT units (${gate.uncovered.length}):`);
      for (const p of gate.uncovered) console.log(`  ${p.ecosystem}  ${p.name}  ${p.license}`);
      console.error('\nFAIL: the tree is not MIT-only and these are not recorded exceptions.');
      process.exit(1);
    }
    console.log('OK: every non-MIT in-scope unit is a recorded, reasoned exception.');
    return;
  }

  fs.mkdirSync(path.dirname(INVENTORY_PATH), { recursive: true });
  fs.writeFileSync(INVENTORY_PATH, JSON.stringify(inv, null, 2) + '\n');
  fs.writeFileSync(NOTICES_PATH, renderNotices(inv));
  console.log(`\nwrote ${path.relative(ROOT, INVENTORY_PATH)}`);
  console.log(`wrote ${path.relative(ROOT, NOTICES_PATH)}`);
}

module.exports = {
  classify,
  classifyPomLicences,
  buildInventory,
  renderNotices,
  collectNpm,
  collectComposer,
  collectAndroid,
  parseGradleTree,
  licenceForArtifact,
  generateAndroidReport,
};

if (require.main === module) main(process.argv.slice(2));
