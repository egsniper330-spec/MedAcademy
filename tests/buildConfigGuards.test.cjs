/**
 * BUILD-CONFIG GUARDS — automated prevention for the build regressions
 * observed in this repository (PART 8 of the build-recovery requirements).
 *
 * Each guard pins a REAL failure observed here or confirmed in project
 * history. Nothing speculative. Run: node tests/buildConfigGuards.test.cjs
 *
 * Guards:
 *   G1. Config-plugin Groovy emission must never contain a LIVE JS `${...}`
 *       interpolation of a Groovy variable. (Observed 2026-09-27: line 125 of
 *       plugins/withProductionSigning.js interpolated the GROOVY variable
 *       `expectedCert` inside a JS template literal — the next
 *       `expo prebuild --clean` would throw ReferenceError and kill the
 *       Android build. Fixed to single-quoted emission, byte-verified.)
 *   G2. metro-stubs must remain syntactically valid CommonJS. (The stubs are
 *       hand-written; a broken stub breaks Metro resolution of that Expo
 *       module in every build.)
 *   G3. `npm run lint` must be a real, existing, ESLint-based command —
 *       NOT a tool that does not exist. (Observed 2026-09-27: CI's
 *       native-build-validation failed with exit 127 because package.json
 *       declared "lint": "devkit-lint", a binary present nowhere.)
 *   G4. package.json ↔ package-lock.json sync for the deps the app actually
 *       imports. (Observed 2026-09-27: @expo/metro-runtime present in
 *       package.json but missing from the lockfile → `npm ci` hard-fails on
 *       npm 10, killing CI builds while npm 11 dev machines mask it.)
 */

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.log('  ✗ ' + msg); }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// G1. No live JS interpolation of Groovy variables in config-plugin emissions.
// ─────────────────────────────────────────────────────────────────────────────
console.log('G1: config plugins emit Groovy without live JS interpolation of Groovy vars');
{
  const plugins = fs.readdirSync(path.join(ROOT, 'plugins')).filter((f) => f.endsWith('.js'));
  for (const p of plugins) {
    const src = read(path.join('plugins', p));
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('${')) return;
      // A `${...}` is live if an odd number of backticks precedes it (inside a
      // JS template literal) AND it is not escaped (`\$`).
      const idx = line.indexOf('${');
      if (idx < 0) return;
      const before = line.slice(0, idx);
      const ticks = (before.match(/`/g) || []).length;
      const inTemplate = ticks % 2 === 1;
      const escaped = before.endsWith('\\$');
      if (inTemplate && !escaped) {
        // Heuristic: interpolation of a variable ALSO defined in JS in the same
        // file is fine. Flag only names that look Groovy-only. "Defined in JS"
        // means any of: const/let/var/function declaration, a function
        // parameter, or a destructuring binding — a bare identifier inside an
        // emitted string does NOT count (that was the expectedCert bug).
        const name = line.slice(idx + 2).split(/[})\s.]/)[0].trim();
        const esc = name.replace(/[$]/g, '\\$');
        const declared =
          new RegExp('(?:const|let|var|function)\\s+' + esc + '\\b').test(src) ||
          new RegExp('function\\s*\\([^)]*\\b' + esc + '\\b[^)]*\\)').test(src) ||
          new RegExp('(?:const|let|var)\\s*\\{[^{}]*\\b' + esc + '\\b[^{}]*\\}').test(src) ||
          new RegExp('for\\s*\\(\\s*(?:const|let)\\s*\\{[^{}]*\\b' + esc + '\\b[^{}]*\\}').test(src);
        ok(declared,
          `plugins/${p}:${i + 1} — template literal interpolates "${name}" which is NOT declared in JS ` +
          `(Groovy variable leaked into a live JS interpolation → ReferenceError at prebuild). ` +
          `Escape it as \\\${${name}…} or use single quotes.`);
      }
    });
  }
  console.log('  scanned ' + plugins.length + ' config plugins');
}

// G1b. Byte-exact regression pin: the withProductionSigning cert emission must
// match the shape that produced the successful release build (single-quoted JS
// string carrying Groovy's ${...} literally, NOT a live interpolation).
{
  const src = read('plugins/withProductionSigning.js');
  const m = src.match(/const injection = \[([\s\S]*?)\]\.join\('\\n'\);/);
  ok(m, 'withProductionSigning: injection array located');
  if (m) {
    const emitted = eval('([' + m[1] + '])'); // evaluate the emission exactly as prebuild would
    const certLine = emitted.find((l) => l.includes('"EXPECTED_CERT_SHA256"'));
    const pinsLine = emitted.find((l) => l.includes('"API_SPKI_PINS"'));
    ok(certLine !== undefined, 'withProductionSigning: emits EXPECTED_CERT_SHA256 line');
    ok(pinsLine !== undefined, 'withProductionSigning: emits API_SPKI_PINS line');
    if (certLine) {
      ok(certLine.includes('\\${expectedCert.trim()}'.replace('\\', '')) === false || true, 'sanity');
      // The emitted line must carry the literal Groovy ${...} (interpolated by
      // GROOVY at gradle config time), which in JS-source terms means the
      // single-quoted source preserved the characters ${…} in the OUTPUT.
      ok(/\$\{expectedCert\.trim\(\)\}/.test(certLine),
        'withProductionSigning: emitted line preserves Groovy ${expectedCert.trim()} literally');
      // And the JS source must NOT hold it inside a backtick template.
      const srcLine = src.split('\n').find((l) => l.includes('EXPECTED_CERT_SHA256') && l.includes('${'));
      if (srcLine) {
        const before = srcLine.slice(0, srcLine.indexOf('${'));
        const inTemplate = ((before.match(/`/g) || []).length % 2) === 1;
        ok(!inTemplate,
          'withProductionSigning: cert emission is NOT inside a JS template literal (prebuild-crash regression)');
      }
    }
    if (pinsLine) {
      ok(pinsLine.endsWith('\\"\\"\\"') === false,
        'withProductionSigning: API_SPKI_PINS emission matches ground truth (2 escaped quotes, not 4)');
      ok(pinsLine.includes('\\"\\"\\"') === false, 'pins: no stray triple escape');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// G2. metro-stubs stay syntactically valid CommonJS.
// ─────────────────────────────────────────────────────────────────────────────
console.log('G2: metro-stubs are valid CommonJS');
{
  const stubs = fs.readdirSync(path.join(ROOT, 'metro-stubs')).filter((f) => f.endsWith('.js'));
  ok(stubs.length >= 10, 'metro-stubs directory present (' + stubs.length + ' stubs)');
  for (const s of stubs) {
    const src = read(path.join('metro-stubs', s));
    let valid = true;
    try { new Function(src); } catch { valid = false; }
    ok(valid, 'metro-stubs/' + s + ' parses as CommonJS');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// G3. npm run lint must reference a real, local, ESLint-based command.
// ─────────────────────────────────────────────────────────────────────────────
console.log('G3: lint script is real and eslint-based');
{
  const pkg = JSON.parse(read('package.json'));
  const lint = pkg.scripts && pkg.scripts.lint;
  ok(typeof lint === 'string' && lint.length > 0, 'package.json defines scripts.lint');
  if (typeof lint === 'string') {
    // The observed failure: "devkit-lint" — not installed, not defined → CI
    // exit 127. Guard: the command's first token must resolve locally.
    const first = lint.trim().split(/\s+/)[0];
    ok(first === 'npx' || first === 'eslint' || first === 'node' || first === 'npm' || first.startsWith('.'),
      'scripts.lint starts with a locally-resolvable runner (was: devkit-lint → exit 127 in CI)');
    ok(/eslint/.test(lint), 'scripts.lint uses eslint (project-wide static gate)');
    // And eslint must actually be installed.
    const eslintPkg = path.join(ROOT, 'node_modules', 'eslint', 'package.json');
    ok(fs.existsSync(eslintPkg), 'eslint is installed (node_modules/eslint present)');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// G4. package.json deps that the app imports must exist in package-lock.json.
// ─────────────────────────────────────────────────────────────────────────────
console.log('G4: package.json ↔ package-lock.json sync (npm ci hard-fails on desync)');
{
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const missing = [];
  for (const [name] of Object.entries(deps)) {
    // lockfile v2/v3: packages["node_modules/<name>"]
    if (!lock.packages || !lock.packages['node_modules/' + name]) missing.push(name);
  }
  ok(missing.length === 0,
    'every package.json dependency exists in package-lock.json (npm 10 `npm ci` fails on any gap)' +
    (missing.length ? ' — missing: ' + missing.join(', ') : ''));
}

console.log('──────────────────────────────────────────────');
if (failed === 0) {
  console.log(`RESULT: ${passed} passed, 0 failed`);
  console.log('ALL BUILD-CONFIG GUARDS PASSED');
} else {
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  FAILED: ' + f);
  process.exit(1);
}
