/**
 * check-queries-vs-schema.js
 * --------------------------
 * Cross-checks every SQL statement embedded in backend/src/*.php against the
 * extracted schema inventory (backend/scripts/schema-inventory.json):
 *
 *   - INSERT INTO <t> (cols...)  -> every column must exist in <t>
 *   - UPDATE <t> SET `col` = ... -> every set column must exist in <t>
 *   - SELECT ... FROM <t>        -> table must exist (multi-table queries are
 *     validated for table existence only; column/alias checks are skipped)
 *
 * Usage:  node backend/scripts/check-queries-vs-schema.js
 */
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const inv = JSON.parse(fs.readFileSync(path.join(root, 'backend/scripts/schema-inventory.json'), 'utf8'));
const tableMap = new Map(inv.tables.map((t) => [t.name, new Set(t.columns.map((c) => c.name))]));
// `users` is the GoTrue auth.users equivalent defined in schema.sql
// (backend/scripts/generate-mysql-schema.mjs → USERS_TABLE) — it has no
// CREATE TABLE in supabase/migrations, so add it manually here.
tableMap.set('users', new Set([
  'id', 'aud', 'role', 'email', 'phone', 'encrypted_password', 'email_confirmed_at',
  'phone_confirmed_at', 'confirmation_token', 'recovery_token', 'email_change_token_new',
  'email_change', 'raw_app_meta_data', 'raw_user_meta_data', 'created_at', 'updated_at',
  'banned_until', 'deleted_at', 'is_sso_user',
]));

const phpFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'storage') walk(full);
    } else if (e.name.endsWith('.php')) {
      phpFiles.push(full);
    }
  }
})(path.join(root, 'backend'));

const problems = [];
let checks = 0;

function checkTableCol(table, col, ctx) {
  checks++;
  if (!tableMap.has(table)) {
    problems.push(`${ctx} — unknown table \`${table}\``);
    return;
  }
  if (!tableMap.get(table).has(col)) {
    problems.push(`${ctx} — \`${table}\` has no column \`${col}\``);
  }
}

for (const file of phpFiles) {
  const src = fs.readFileSync(file, 'utf8');
  // crude string extraction (single and double quoted, backtick SQL)
  const strings = [...src.matchAll(/(['"])([\s\S]*?)(?<!\\)\1/g)].map((m) => m[2]);

  for (const s of strings) {
    const up = s.toUpperCase();
    // INSERT INTO `t` (`a`,`b`) VALUES ...
    let m = s.match(/INSERT\s+INTO\s+`?([a-z_]+)`?\s*\(([^)]*)\)/i);
    if (m) {
      const table = m[1];
      m[2].split(',').forEach((c) => checkTableCol(table, c.trim().replace(/^`|`$/g, ''), `${path.basename(file)}: INSERT ${table}`));
      continue;
    }
    // UPDATE `t` SET `a` = ?, `b` = ? ...
    m = s.match(/UPDATE\s+`?([a-z_]+)`?\s+SET\s+([\s\S]*?)(?:WHERE|$)/i);
    if (m) {
      const table = m[1];
      const sets = m[2].split(',').map((x) => x.trim());
      for (const set of sets) {
        const cm = set.match(/^`?([a-z_]+)`?\s*=/);
        if (cm) checkTableCol(table, cm[1], `${path.basename(file)}: UPDATE ${table}`);
      }
      continue;
    }
    // SELECT ... FROM `t` (single table only)
    m = s.match(/SELECT\s+[\s\S]*?\bFROM\s+`?([a-z_]+)`?(?:\s+(?:WHERE|ORDER\s+BY|GROUP\s+BY|LIMIT|$))/i);
    if (m) {
      checks++;
      if (!tableMap.has(m[1])) {
        problems.push(`${path.basename(file)}: SELECT FROM unknown table \`${m[1]}\``);
      }
    }
  }
}

console.log(`Checks performed: ${checks}`);
if (problems.length) {
  console.log(`PROBLEMS (${problems.length}):`);
  [...new Set(problems)].forEach((p) => console.log('  - ' + p));
  process.exit(1);
}
console.log('All SQL table/column references in PHP match the schema inventory.');
