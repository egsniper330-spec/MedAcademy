/**
 * validate-php-syntax.js
 * ----------------------
 * Parses every .php file under backend/ with the glayzzle php-parser
 * (PHP 8 grammar) to catch syntax errors. Run from a directory where
 * php-parser is installed:
 *
 *   cd /tmp/phplint && node /d/v3/backend/scripts/validate-php-syntax.js /d/v3/backend
 *
 * NOTE: this is a grammar check, not a full php -l. Run `php -l` on the
 * server (or locally with PHP installed) as the final gate.
 */
const fs = require('fs');
const path = require('path');
const parser = require('php-parser');

const engine = new parser.Engine({
  parser: { extractDoc: false, php7: true, suppressErrors: false },
  ast: { withPositions: true },
});

const root = process.argv[2] || path.join(process.cwd(), 'backend');
if (!fs.existsSync(root)) {
  console.error('root not found: ' + root);
  process.exit(2);
}

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'storage' && entry.name !== '.git') walk(full);
    } else if (entry.name.endsWith('.php')) {
      files.push(full);
    }
  }
})(root);

let ok = 0;
const errors = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  try {
    engine.parseCode(src, file);
    ok++;
  } catch (e) {
    errors.push({ file, err: String(e.message || e).split('\n')[0] });
  }
}
console.log(`PHP files parsed OK: ${ok}/${files.length}`);
if (errors.length) {
  console.log('FAILED:');
  for (const e of errors) console.log('  ' + e.file + ' => ' + e.err);
  process.exit(1);
}
console.log('All PHP files parse with the PHP 8 grammar.');
