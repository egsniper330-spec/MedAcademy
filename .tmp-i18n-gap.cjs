'use strict';
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const src = fs.readFileSync(path.join(root, 'src/lib/i18n/resources.ts'), 'utf8');
const enBlock = src.split('export const ar')[0];
const values = new Map();
const re = /'([A-Za-z0-9_.]+)':\s*'((?:[^'\\]|\\.)*)'/g;
let m;
while ((m = re.exec(enBlock))) values.set(m[2].toLowerCase(), m[1]);

const audit = require(path.join(root, '.i18n-now.json'));
let have = 0;
const missing = {};
for (const f of audit.top) {
  for (const h of f.hits) {
    if (values.has(h.text.toLowerCase())) have++;
    else (missing[f.file] = missing[f.file] || []).push(h.text);
  }
}
console.log('already-keyed', have);
const totalMissing = Object.values(missing).reduce((a, b) => a + b.length, 0);
console.log('new-strings', totalMissing);
for (const [file, list] of Object.entries(missing)) {
  console.log('\n## ' + file + '  (' + list.length + ')');
  console.log(list.join('\n'));
}
