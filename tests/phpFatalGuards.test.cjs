#!/usr/bin/env node
/**
 * Compile-fatal guards for backend PHP controllers.
 * No PHP binary exists in this environment, so these are source-level
 * static checks that catch the classes of fatal errors we've shipped:
 *
 *  1. `return <value>;` inside a `: void` function
 *     (PHP fatal: "A void function must not return a value" — kills the
 *      whole file at compile time, every route through it 500s)
 *  2. Unbalanced braces
 *  3. JavaScript-isms in PHP: `.trim()`, `.replace(...)`, template literals
 *
 * Uses a small character-level lexer so apostrophes inside comments
 * (e.g. "don't") cannot corrupt the scan.
 *
 * Usage: node tests/phpFatalGuards.test.cjs [file.php ...]
 * (no args = scan backend/src/Controllers + backend/src/Services)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'backend', 'src');
const dirs = ['Controllers', 'Services']
  .map(d => path.join(ROOT, d))
  .filter(d => fs.existsSync(d));

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : dirs.flatMap(d =>
      fs.readdirSync(d).filter(f => f.endsWith('.php')).map(f => path.join(d, f))
    );

/** Character-level lexer: returns PHP code with comments and string
 *  contents blanked, preserving newlines and brace/paren structure. */
function lexCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = i + 1 < n ? src[i + 1] : '';

    // Line comments
    if (c === '/' && next === '/' || c === '#') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    // Block comments
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }
    // Single-quoted string (PHP: only \\ and \' are escapes)
    if (c === "'") {
      out += "''";
      i++;
      while (i < n && src[i] !== "'") {
        if (src[i] === '\\') i++; // skip escaped char
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i++; // closing quote
      continue;
    }
    // Double-quoted string (PHP: backslash escapes, but quotes can't
    // span lines in this codebase's style; still handle safely)
    if (c === '"') {
      out += '""';
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\') i++; // skip escaped char
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

let failures = 0;

for (const file of targets) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(path.join(__dirname, '..'), file);
  const code = lexCode(src);

  // ── Guard 1: value-return inside : void ──────────────────────────────
  const voidRe = /function\s+(\w+)\s*\([^)]*\)\s*:\s*void\s*\{/g;
  let m;
  while ((m = voidRe.exec(code)) !== null) {
    let i = voidRe.lastIndex, depth = 1;
    while (i < code.length && depth > 0) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') depth--;
      i++;
    }
    const body = code.slice(voidRe.lastIndex, i - 1);
    // 'return;' is legal in void; 'return <expr>;' is a compile fatal.
    if (/return\s+[^\s;]/.test(body)) {
      console.log(`FAIL ${rel}: void function '${m[1]}' returns a value (PHP compile fatal)`);
      failures++;
    }
  }

  // ── Guard 2: brace balance ───────────────────────────────────────────
  let depth = 0;
  for (const c of code) { if (c === '{') depth++; else if (c === '}') depth--; }
  if (depth !== 0) {
    console.log(`FAIL ${rel}: unbalanced braces (delta ${depth})`);
    failures++;
  }

  // ── Guard 3: JS-isms inside PHP (scan raw source) ────────────────────
  if (/\.trim\(\)/.test(src)) {
    console.log(`FAIL ${rel}: JS-style .trim() found in PHP source`);
    failures++;
  }
  if (/\.replace\(\//.test(src)) {
    console.log(`FAIL ${rel}: JS-style .replace(/regex/) found in PHP source`);
    failures++;
  }
  // JS template literal in a return/string position: backtick followed by ${
  if (/`[^`]*\$\{/.test(src)) {
    console.log(`FAIL ${rel}: JS template literal found in PHP source (use concatenation)`);
    failures++;
  }
}

if (failures) {
  console.log(`\n${failures} fatal-pattern(s) found across ${targets.length} file(s)`);
  process.exit(1);
}
console.log(`PASS: ${targets.length} PHP file(s) free of known compile-fatal patterns`);
