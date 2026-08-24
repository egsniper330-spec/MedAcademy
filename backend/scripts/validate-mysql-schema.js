/**
 * validate-mysql-schema.js
 * ------------------------
 * Parses every DDL statement in backend/database/schema.sql with
 * node-sql-parser (MySQL dialect) to catch syntax errors before the schema
 * is ever executed against the production MySQL database.
 *
 * Usage (from a directory where node-sql-parser is installed):
 *   node backend/scripts/validate-mysql-schema.js
 */
const fs = require('fs');
const path = require('path');
const { Parser } = require('node-sql-parser');

const parser = new Parser();
const schemaPath = process.argv[2] || path.join(process.cwd(), 'backend', 'database', 'schema.sql');
const sql = fs.readFileSync(schemaPath, 'utf8');

// Only validate up to the TRIGGERS marker (trigger bodies use DELIMITER $$,
// which node-sql-parser does not support).
const triggerIdx = sql.indexOf('TRIGGERS (ported from PostgreSQL');
const ddl = triggerIdx === -1 ? sql : sql.slice(0, triggerIdx);

// Split on ';' at top level, respecting single-quoted strings (COMMENT
// clauses legitimately contain semicolons inside quotes).
function splitStatements(sql) {
  const out = [];
  let cur = '';
  let inSingle = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const n = sql[i + 1];
    if (inLine) { if (c === '\n') inLine = false; cur += c; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; cur += '*/'; i++; continue; } cur += c; continue; }
    if (inSingle) {
      if (c === "'") {
        if (n === "'") { cur += "''"; i++; continue; }
        inSingle = false;
      }
      cur += c; continue;
    }
    if (c === '-' && n === '-') { inLine = true; cur += '--'; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; cur += '/*'; i++; continue; }
    if (c === "'") { inSingle = true; cur += c; continue; }
    if (c === ';') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const statements = splitStatements(ddl).map((s) => s.trim()).filter((s) => s && !s.startsWith('--'));

let ok = 0;
const errors = [];
for (const stmt of statements) {
  try {
    parser.astify(stmt, { database: 'mysql' });
    ok++;
  } catch (e) {
    errors.push({ stmt: stmt.slice(0, 160), err: String(e.message || e).slice(0, 200) });
  }
}
console.log(`Parsed OK: ${ok}`);
if (errors.length) {
  console.log(`FAILED: ${errors.length}`);
  errors.slice(0, 40).forEach((x) => console.log('---\n' + x.stmt + '\n    => ' + x.err));
  process.exit(1);
} else {
  console.log('All DDL statements parse as MySQL.');
}
