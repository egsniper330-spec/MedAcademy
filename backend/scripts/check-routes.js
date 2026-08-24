/**
 * check-routes.js
 * ---------------
 * Static route-table validation without PHP: parses backend/routes/api.php
 * and verifies that every [Controller::class, 'method'] target exists as a
 * real class method in backend/src/Controllers/.
 *
 * Usage: node backend/scripts/check-routes.js
 */
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const routesFile = path.join(root, 'backend/routes/api.php');
const src = fs.readFileSync(routesFile, 'utf8');

const targets = [...src.matchAll(/\[\s*([A-Za-z_][A-Za-z0-9_\\]*::class)\s*,\s*'([a-zA-Z_][a-zA-Z0-9_]*)'\s*\]/g)];

const problems = [];
let count = 0;
const seen = new Set();

for (const m of targets) {
  const fqcn = m[1].replace('::class', '');
  const method = m[2];
  const short = fqcn.split('\\').pop();
  const file = path.join(root, 'backend/src/Controllers', short + '.php');
  count++;
  const key = fqcn + '::' + method;
  if (seen.has(key)) continue;
  seen.add(key);

  if (!fs.existsSync(file)) {
    problems.push(`${key} — controller file missing: ${file}`);
    continue;
  }
  const code = fs.readFileSync(file, 'utf8');
  if (!code.includes('class ' + short)) {
    problems.push(`${key} — class ${short} not found in ${file}`);
  }
  if (!new RegExp('function\\s+' + method + '\\s*\\(').test(code)) {
    problems.push(`${key} — method ${method}() not found in ${short}`);
  }
}

console.log(`Route targets checked: ${count} (${seen.size} unique)`);
if (problems.length) {
  console.log(`PROBLEMS (${problems.length}):`);
  problems.forEach((p) => console.log('  - ' + p));
  process.exit(1);
}
console.log('All route targets exist.');
