/**
 * check-env-keys.js
 * -----------------
 * Every environment key read via Config::string/int/bool/list in
 * backend/src/ and backend/scripts/ must be present in .env.example
 * (so a fresh deployment never silently misses a variable).
 *
 * Usage: node backend/scripts/check-env-keys.js
 */
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const envExample = fs.readFileSync(path.join(root, 'backend/.env.example'), 'utf8');
const documented = new Set([...envExample.matchAll(/^[#\s]*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));

const used = new Set();
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'storage') walk(full);
    } else if (e.name.endsWith('.php')) {
      const code = fs.readFileSync(full, 'utf8');
      for (const m of code.matchAll(/Config::(?:string|int|bool|list)\('([A-Z0-9_]+)'/g)) {
        used.add(m[1]);
      }
    }
  }
})(path.join(root, 'backend/src'));

// scripts also read config
for (const m of fs.readFileSync(path.join(root, 'backend/scripts/server-selfcheck.php'), 'utf8').matchAll(/Config::(?:string|int|bool|list)\('([A-Z0-9_]+)'/g)) {
  used.add(m[1]);
}

const missing = [...used].filter((k) => !documented.has(k)).sort();
console.log(`Config keys used: ${used.size} | documented in .env.example: ${documented.size}`);
if (missing.length) {
  console.log('MISSING from .env.example:');
  missing.forEach((k) => console.log('  - ' + k));
  process.exit(1);
}
console.log('Every config key used by the code is documented in .env.example.');
