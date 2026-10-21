#!/usr/bin/env node
/**
 * i18n-coverage.js — audit hardcoded user-facing English in the app.
 *
 * WHY: installing a translation library does not translate anything. This
 * script measures the remaining work the same way a reviewer would: it looks
 * for English copy that is rendered rather than routed through `t(...)`.
 *
 * WHAT COUNTS (conservative, to avoid false positives):
 *   • JSX text nodes containing 3+ Latin letters            → visible copy
 *   • placeholder="…" / label="…" / title="…" / accessibilityLabel="…"
 *   • Alert.alert('…') and showToast({ message: '…' }) literals
 *   • string literals passed to setError('…')
 *
 * WHAT DOES NOT COUNT:
 *   • anything already inside t('…') / translate(…)
 *   • Arabic text, numbers, punctuation-only strings
 *   • identifiers, testIDs, route paths, style tokens, console logs
 *   • lines that are comments
 *
 * Usage:
 *   node scripts/i18n-coverage.js            # human report
 *   node scripts/i18n-coverage.js --json     # machine-readable summary
 *   node scripts/i18n-coverage.js --top 20   # show N worst files (default 25)
 *
 * Exit code is always 0 — this is a progress gauge, not a gate. The hard gate
 * is tests/i18nLocalization.test.cjs (resource consistency + detection).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const SCAN_DIRS = ['app', 'components'];

const json = process.argv.includes('--json');
const topIdx = process.argv.indexOf('--top');
const TOP = topIdx > -1 ? Number(process.argv[topIdx + 1]) || 25 : 25;

const ARABIC = /[\u0600-\u06FF]/;
const LATIN_WORD = /[A-Za-z]{3,}/;

/** Heuristics for strings that are code/data, not UI copy. */
const NON_UI = /^(?:[a-z0-9_@./#%?&=:{}-]+|https?:\/\/\S+|#[0-9a-fA-F]{3,8}|rgba?\(|data:|application\/|text\/)$/;

function isUiText(text) {
  const value = text.trim();
  if (value.length < 3) return false;
  if (ARABIC.test(value)) return false;
  if (!LATIN_WORD.test(value)) return false;
  if (NON_UI.test(value)) return false;
  return true;
}

/** Remove comments so prose in a file is not counted as shipped copy. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const findings = [];

function scanFile(rel) {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const src = stripComments(raw);
  const lines = src.split(/\r?\n/);
  const hits = [];

  const push = (lineNo, snippet) => {
    if (isUiText(snippet)) hits.push({ line: lineNo + 1, text: snippet.trim().slice(0, 120) });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\bt\(/.test(line) || /translate\(/.test(line)) continue;

    // JSX text node on one line: >Some copy<
    const jsx = line.match(/>\s*([A-Za-z][^<>{}]{2,120}?)\s*</g);
    if (jsx) for (const m of jsx) push(i, m.replace(/^>\s*|\s*<$/g, ''));

    // Rendered props.
    for (const prop of ['placeholder', 'label', 'title', 'accessibilityLabel', 'message']) {
      const re = new RegExp(`\\b${prop}["']?\\s*[:=]\\s*["']([^"']{3,140})["']`, 'g');
      let m;
      while ((m = re.exec(line))) push(i, m[1]);
    }

    // setError('…') / Alert.alert('…') / showToast({ message: '…' })
    const calls = line.match(/(?:setError|Alert\.alert|showToast)\([^)]*?(['"])([^'"]{3,140})\1/g);
    if (calls) {
      for (const c of calls) {
        const m = c.match(/(['"])([^'"]{3,140})\1\s*\)?$/);
        if (m) push(i, m[2]);
      }
    }
  }

  if (hits.length) findings.push({ file: rel.replace(/\\/g, '/'), count: hits.length, hits });
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) scanFile(path.relative(ROOT, full));
  }
}

for (const d of SCAN_DIRS) {
  const full = path.join(SRC, d);
  if (fs.existsSync(full)) walk(full);
}

findings.sort((a, b) => b.count - a.count);
const total = findings.reduce((n, f) => n + f.count, 0);
const files = findings.length;

if (json) {
  console.log(JSON.stringify({ total, files, top: findings.slice(0, TOP) }, null, 2));
  process.exit(0);
}

console.log('\nArabic localization coverage audit');
console.log('─'.repeat(70));
console.log(`Hardcoded candidate strings: ${total} across ${files} file(s)`);
console.log('(Counts are candidates, not certainties — review before translating.)\n');

for (const f of findings.slice(0, TOP)) {
  console.log(`${String(f.count).padStart(4)}  ${f.file}`);
  for (const h of f.hits.slice(0, 3)) console.log(`        L${h.line}: ${h.text}`);
  if (f.hits.length > 3) console.log(`        … ${f.hits.length - 3} more`);
}

const clean = files === 0;
console.log('\n' + (clean
  ? '✅ No hardcoded English candidates found in scanned directories.'
  : `ℹ️  ${files} file(s) still contain hardcoded English. Run with --json for the full list.`));
