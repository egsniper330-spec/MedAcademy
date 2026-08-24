#!/usr/bin/env node
/**
 * extract-schema.mjs
 * ------------------
 * Read-only schema extractor for the MedAcademy Supabase migrations.
 *
 * Parses every file under supabase/migrations/*.sql and produces a
 * structured JSON inventory:
 *   - tables (final columns after all ALTERs, PK/FK/unique/check)
 *   - enums (values unioned across CREATE TYPE + ALTER TYPE ADD VALUE)
 *   - views
 *   - triggers
 *   - functions (names + argument signatures)
 *   - policies (RLS)
 *   - indexes
 *
 * The inventory feeds generate-mysql-schema.mjs, which emits the MySQL DDL.
 * It is intentionally conservative: constructs it cannot parse are recorded
 * in `warnings` rather than guessed.
 *
 * Usage:  node backend/scripts/extract-schema.mjs [path-to-migrations]
 * Output: backend/scripts/schema-inventory.json
 */
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = process.argv[2] || 'supabase/migrations';
const OUT = 'backend/scripts/schema-inventory.json';

// ---------------------------------------------------------------------------
// Statement splitter — respects single/double quotes, parens, line/block
// comments and dollar-quoted bodies ($$ ... $$).
// ---------------------------------------------------------------------------
export function splitStatements(sql) {
  const statements = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  let inSingle = false;
  let inDouble = false;
  let inLine = false;
  let inBlock = false;
  let depth = 0;

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    if (inLine) {
      if (c === '\n') inLine = false;
      cur += c; i++; continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; cur += '*/'; i += 2; continue; }
      cur += c; i++; continue;
    }
    if (inSingle) {
      if (c === "'") {
        if (next === "'") { cur += "''"; i += 2; continue; }
        inSingle = false;
      }
      cur += c; i++; continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      cur += c; i++; continue;
    }
    if (c === '-' && next === '-') { inLine = true; cur += '--'; i += 2; continue; }
    if (c === '/' && next === '*') { inBlock = true; cur += '/*'; i += 2; continue; }
    if (c === "'") { inSingle = true; cur += c; i++; continue; }
    if (c === '"') { inDouble = true; cur += c; i++; continue; }
    if (c === '$' && next === '$') {
      const close = sql.indexOf('$$', i + 2);
      if (close === -1) { cur += sql.slice(i); i = n; continue; }
      cur += sql.slice(i, close + 2);
      i = close + 2;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth = Math.max(0, depth - 1);
    if (c === ';' && depth === 0) {
      const s = cur.trim();
      if (s) statements.push(s);
      cur = '';
      i++;
      continue;
    }
    cur += c; i++;
  }
  const s = cur.trim();
  if (s) statements.push(s);
  return statements;
}

// Split a parenthesised list body on top-level commas.
function splitTopLevel(body) {
  const parts = [];
  let cur = '';
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    const next = body[i + 1];
    if (inSingle) {
      if (c === "'") {
        if (next === "'") { cur += "''"; i++; continue; }
        inSingle = false;
      }
      cur += c; continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      cur += c; continue;
    }
    if (c === "'") { inSingle = true; cur += c; continue; }
    if (c === '"') { inDouble = true; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  const tail = cur.trim();
  if (tail) parts.push(tail);
  return parts;
}

function unquote(s) {
  return String(s).replace(/^"(.*)"$/, '$1').trim();
}

const CONSTRAINT_WORDS = new Set([
  'NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'REFERENCES',
  'CHECK', 'CONSTRAINT', 'COLLATE', 'GENERATED', 'ON', 'USING', 'STORED',
]);

function parseColumnPart(part) {
  // Column:  name type [constraints...]
  const tokens = part.split(/\s+/);
  if (tokens.length === 0) return null;
  const name = unquote(tokens[0]);
  const typeTokens = [];
  let i = 1;
  for (; i < tokens.length; i++) {
    if (CONSTRAINT_WORDS.has(tokens[i].toUpperCase())) break;
    typeTokens.push(tokens[i]);
  }
  let type = typeTokens.join(' ').trim();
  // Normalise type casing
  type = type.replace(/^([A-Za-z]+)/, (m) => m.toLowerCase());

  const rest = tokens.slice(i).join(' ');
  const col = {
    name,
    type,
    notNull: /\bNOT\s+NULL\b/i.test(rest),
    pk: /\bPRIMARY\s+KEY\b/i.test(rest),
    unique: /\bUNIQUE\b/i.test(rest),
    default: null,
    references: null,
    check: null,
  };

  // DEFAULT <expr> — capture tokens after DEFAULT until next constraint word
  const dIdx = rest.search(/\bDEFAULT\b/i);
  if (dIdx !== -1) {
    const after = rest.slice(dIdx + 'DEFAULT'.length);
    const dm = after.match(/^\s*([^,]+?)(?=\s+(NOT\s+NULL|PRIMARY\s+KEY|UNIQUE|REFERENCES|CHECK|CONSTRAINT)\b|$)/i);
    if (dm) col.default = dm[1].trim();
  }
  if (col.default && /^NULL$/i.test(col.default)) col.default = null;

  const ref = part.match(/\bREFERENCES\s+([A-Za-z_][\w.]*)\s*\(([\w,"\s]+)\)/i);
  if (ref) {
    col.references = {
      table: unquote(ref[1].split('.').pop()),
      columns: ref[2].split(',').map((x) => unquote(x.trim())),
      onDelete: (part.match(/\bON\s+DELETE\s+([A-Z]+(?:\s+[A-Z]+)?)/i) || [])[1] || null,
      onUpdate: (part.match(/\bON\s+UPDATE\s+([A-Z]+(?:\s+[A-Z]+)?)/i) || [])[1] || null,
    };
  }
  const chk = part.match(/\bCHECK\s*\(([\s\S]+)\)$/i);
  if (chk) col.check = chk[1].trim();
  return col;
}

function parseTableLevelPart(part, table) {
  const m = part.match(/^CONSTRAINT\s+([A-Za-z_][\w]*)\s+(UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|CHECK)\b([\s\S]*)$/i);
  const key = m ? m[2].toUpperCase() : (part.match(/^(UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|CHECK)\b/i) || [])[1]?.toUpperCase();
  const name = m ? m[1] : null;
  if (!key) return;
  if (key === 'UNIQUE') {
    const cols = (part.match(/\(([^)]+)\)/) || [])[1];
    table.uniques.push({ name, columns: cols ? cols.split(',').map((x) => unquote(x.trim())) : [] });
  } else if (key === 'PRIMARY KEY') {
    const cols = (part.match(/\(([^)]+)\)/) || [])[1];
    table.primaryKey = cols ? cols.split(',').map((x) => unquote(x.trim())) : [];
  } else if (key === 'FOREIGN KEY') {
    const cols = (part.match(/\(([^)]+)\)/) || [])[1];
    const ref = part.match(/REFERENCES\s+([A-Za-z_][\w.]*)\s*\(([\w,"\s]+)\)/i);
    if (ref) {
      table.foreignKeys.push({
        name,
        columns: cols ? cols.split(',').map((x) => unquote(x.trim())) : [],
        refTable: unquote(ref[1].split('.').pop()),
        refColumns: ref[2].split(',').map((x) => unquote(x.trim())),
        onDelete: (part.match(/\bON\s+DELETE\s+([A-Z]+(?:\s+[A-Z]+)?)/i) || [])[1] || null,
        onUpdate: (part.match(/\bON\s+UPDATE\s+([A-Z]+(?:\s+[A-Z]+)?)/i) || [])[1] || null,
      });
    }
  } else if (key === 'CHECK') {
    const expr = part.slice(part.indexOf('('));
    table.checks.push({ name, expr });
  }
}

function parseCreateTable(stmt) {
  const m = stmt.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w.]*)\s*(?:\(([\s\S]*)\)\s*)?(?:WITH\s*\([\s\S]*\))?$/i);
  if (!m) return null;
  const schema = m[1].includes('.') ? m[1].split('.')[0] : null;
  const name = unquote(m[1].split('.').pop());
  const body = m[2] ?? '';
  const table = {
    name,
    schema,
    columns: [],
    primaryKey: null,
    uniques: [],
    foreignKeys: [],
    checks: [],
  };
  for (const part of splitTopLevel(body)) {
    const upper = part.toUpperCase();
    if (/^CONSTRAINT\b/.test(upper) || /^(UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|CHECK)\b/.test(upper)) {
      parseTableLevelPart(part, table);
    } else {
      const col = parseColumnPart(part);
      if (col) table.columns.push(col);
    }
  }
  return table;
}

// ---------------------------------------------------------------------------
// Main extraction
// ---------------------------------------------------------------------------
const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
const all = files.map((f) => `-- ==== ${f} ====\n` + fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')).join('\n');
const statements = splitStatements(all);

const tables = new Map();      // name -> table model
const enums = new Map();       // name -> Set(values)
const views = new Map();       // name -> { columns?, definition }
const triggers = [];
const functions = [];
const policies = [];
const indexes = [];
const warnings = [];

const order = []; // table creation order

// Strip SQL comments so a leading `-- ==== file ====` header (or any inline
// comment) merged into a statement never breaks keyword classification.
function stripComments(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  let inSingle = false, inDouble = false, inLine = false, inBlock = false;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (inLine) { if (c === '\n') inLine = false; else { i++; continue; } }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i += 2; continue; } i++; continue; }
    if (inSingle) { if (c === "'") { if (next === "'") { out += "''"; i += 2; continue; } inSingle = false; } out += c; i++; continue; }
    if (inDouble) { if (c === '"') inDouble = false; out += c; i++; continue; }
    if (c === '-' && next === '-') { inLine = true; i += 2; continue; }
    if (c === '/' && next === '*') { inBlock = true; i += 2; continue; }
    if (c === "'") { inSingle = true; out += c; i++; continue; }
    if (c === '"') { inDouble = true; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

// Identifier matcher: optional quoted schema + quoted or plain name
// (non-capturing groups so capture indices stay predictable).
// Built from plain strings (no backslash escapes) to avoid JS string
// escape pitfalls when interpolated into RegExp constructors.
const WORD = '[A-Za-z0-9_]+';
const IDENT = `(?:${WORD}|"[^"]+")`;
const NAME = `(?:(?:${IDENT})[.])?${IDENT}`;

function nameOf(s) {
  return unquote(s.split('.').pop());
}

for (const rawStmt of statements) {
  const s = stripComments(rawStmt).replace(/\s+/g, ' ').trim();
  const u = s.toUpperCase();
  if (!s) continue;

  if (/^CREATE\s+TYPE\b/.test(u)) {
    const m = s.match(new RegExp(`^CREATE\\s+TYPE\\s+(${NAME})\\s+AS\\s+ENUM\\s*\\(([\\s\\S]*)\\)\\s*$`, 'i'));
    if (m) {
      const name = nameOf(m[1]);
      const vals = m[2].split(',').map((v) => v.trim().replace(/^'(.*)'$/, '$1'));
      if (!enums.has(name)) enums.set(name, new Set());
      vals.forEach((v) => enums.get(name).add(v));
    } else {
      warnings.push(`CREATE TYPE (unparsed): ${s.slice(0, 120)}`);
    }
    continue;
  }
  if (/^ALTER\s+TYPE\b/.test(u)) {
    const m = s.match(new RegExp(`^ALTER\\s+TYPE\\s+(${NAME})\\s+ADD\\s+VALUE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?'((?:[^']|'')*)'`, 'i'));
    if (m) {
      const name = nameOf(m[1]);
      if (!enums.has(name)) enums.set(name, new Set());
      enums.get(name).add(m[2].replace(/''/g, "'"));
    }
    continue;
  }
  if (/^DROP\s+TYPE\b/.test(u)) {
    const m = s.match(new RegExp(`^DROP\\s+TYPE\\s+(?:IF\\s+EXISTS\\s+)?(${NAME})`, 'i'));
    if (m) enums.delete(nameOf(m[1]));
    continue;
  }
  if (/^CREATE\s+(OR\s+REPLACE\s+)?VIEW\b/.test(u)) {
    const m = s.match(new RegExp(`^CREATE\\s+(?:OR\\s+REPLACE\\s+)?VIEW\\s+(${NAME})\\s*(?:\\(([^)]*)\\))?\\s+AS\\s+([\\s\\S]*)$`, 'i'));
    if (m) {
      views.set(nameOf(m[1]), {
        columns: m[2] ? m[2].split(',').map((x) => unquote(x.trim())) : null,
        definition: m[3].trim(),
      });
    } else {
      warnings.push(`CREATE VIEW (unparsed): ${s.slice(0, 120)}`);
    }
    continue;
  }
  if (/^DROP\s+VIEW\b/.test(u)) {
    const m = s.match(new RegExp(`^DROP\\s+VIEW\\s+(?:IF\\s+EXISTS\\s+)?(${NAME})`, 'i'));
    if (m) views.delete(nameOf(m[1]));
    continue;
  }
  if (/^CREATE\s+TABLE\b/.test(u)) {
    const t = parseCreateTable(s);
    if (t) {
      if (!tables.has(t.name)) order.push(t.name);
      // Later CREATE TABLE ... (re)definitions replace earlier ones
      tables.set(t.name, t);
    } else {
      warnings.push(`CREATE TABLE (unparsed): ${s.slice(0, 160)}`);
    }
    continue;
  }
  if (/^DROP\s+TABLE\b/.test(u)) {
    const m = s.match(new RegExp(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${NAME})`, 'i'));
    if (m) {
      const name = nameOf(m[1]);
      tables.delete(name);
      const idx = order.indexOf(name);
      if (idx !== -1) order.splice(idx, 1);
    }
    continue;
  }
  if (/^ALTER\s+TABLE\b/.test(u)) {
    const m = s.match(new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(${NAME})\\s+([\\s\\S]+)$`, 'i'));
    if (!m) { warnings.push(`ALTER TABLE (unparsed): ${s.slice(0, 140)}`); continue; }
    const name = nameOf(m[1]);
    if (!tables.has(name)) tables.set(name, { name, schema: null, columns: [], primaryKey: null, uniques: [], foreignKeys: [], checks: [] });
    const table = tables.get(name);
    const rest = m[2].trim();

    // Multiple actions separated by commas
    for (const action of splitTopLevel(rest)) {
      const a = action.trim();
      const au = a.toUpperCase();
      if (/^ADD\s+COLUMN\b/.test(au)) {
        const cm = a.match(/^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]+)$/i);
        if (cm) {
          const col = parseColumnPart(cm[1].trim());
          if (col && !table.columns.some((c) => c.name === col.name)) table.columns.push(col);
        }
      } else if (/^DROP\s+COLUMN\b/.test(au)) {
        const dm = a.match(/^DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][\w]*)/i);
        if (dm) table.columns = table.columns.filter((c) => c.name !== unquote(dm[1]));
      } else if (/^ALTER\s+COLUMN\b/.test(au)) {
        const am = a.match(/^ALTER\s+COLUMN\s+([A-Za-z_][\w]*)\s+([\s\S]+)$/i);
        if (am) {
          const colName = unquote(am[1]);
          const sub = am[2].toUpperCase();
          const col = table.columns.find((c) => c.name === colName);
          if (/^TYPE\b/.test(sub)) {
            const tm = am[2].match(/^TYPE\s+([\s\S]+?)(?:\s+USING\s+[\s\S]*)?$/i);
            if (col && tm) col.type = tm[1].trim().toLowerCase();
          } else if (/^SET\s+DEFAULT\b/.test(sub)) {
            const dm2 = am[2].match(/^SET\s+DEFAULT\s+([\s\S]+)$/i);
            if (col && dm2) col.default = dm2[1].trim();
          } else if (/^DROP\s+DEFAULT\b/.test(sub)) {
            if (col) col.default = null;
          } else if (/^SET\s+NOT\s+NULL\b/.test(sub)) {
            if (col) col.notNull = true;
          } else if (/^DROP\s+NOT\s+NULL\b/.test(sub)) {
            if (col) col.notNull = false;
          }
        }
      } else if (/^RENAME\s+COLUMN\b/.test(au)) {
        const rm = a.match(/^RENAME\s+COLUMN\s+([A-Za-z_][\w]*)\s+TO\s+([A-Za-z_][\w]*)/i);
        if (rm) {
          const col = table.columns.find((c) => c.name === unquote(rm[1]));
          if (col) col.name = unquote(rm[2]);
        }
      } else if (/^RENAME\s+TO\b/.test(au)) {
        const rm = a.match(/^RENAME\s+TO\s+([A-Za-z_][\w]*)/i);
        if (rm) {
          // Rename the table key
          const newName = unquote(rm[1]);
          tables.delete(name);
          table.name = newName;
          tables.set(newName, table);
          const idx = order.indexOf(name);
          if (idx !== -1) order[idx] = newName;
        }
      } else if (/^ADD\s+(CONSTRAINT\b|PRIMARY\s+KEY\b|UNIQUE\b|FOREIGN\s+KEY\b)/.test(au)) {
        const addRest = a.replace(/^ADD\s+(?:CONSTRAINT\s+[A-Za-z_][\w]*\s+)?/i, '');
        parseTableLevelPart(addRest, table);
      } else if (/^DROP\s+CONSTRAINT\b/.test(au)) {
        const dm = a.match(/^DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][\w]*)/i);
        if (dm) {
          const cn = dm[1];
          table.uniques = table.uniques.filter((x) => x.name !== cn);
          table.foreignKeys = table.foreignKeys.filter((x) => x.name !== cn);
          table.checks = table.checks.filter((x) => x.name !== cn);
        }
      }
      // ENABLE ROW LEVEL SECURITY / OWNER TO / others are ignored here
    }
    continue;
  }
  if (/^CREATE\s+(UNIQUE\s+)?INDEX\b/.test(u)) {
    const m = s.match(new RegExp(`^CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})\\s+ON\\s+(${NAME})\\s*(?:USING\\s+\\w+\\s*)?\\(([\\s\\S]+)\\)`, 'i'));
    if (m) {
      indexes.push({
        name: nameOf(m[2]),
        table: nameOf(m[3]),
        columns: m[4].trim(),
        unique: !!m[1],
      });
    } else {
      warnings.push(`CREATE INDEX (unparsed): ${s.slice(0, 140)}`);
    }
    continue;
  }
  if (/^DROP\s+INDEX\b/.test(u)) {
    const m = s.match(/^DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][\w]*)/i);
    if (m) {
      const idx = m[1];
      const found = indexes.findIndex((x) => x.name === idx);
      if (found !== -1) indexes.splice(found, 1);
    }
    continue;
  }
  if (/^CREATE\s+TRIGGER\b/.test(u)) {
    const m = s.match(new RegExp(`^CREATE\\s+(?:CONSTRAINT\\s+)?TRIGGER\\s+(${IDENT})\\s+([\\s\\S]*?)\\s+ON\\s+(${NAME})`, 'i'));
    if (m) {
      triggers.push({ name: nameOf(m[1]), timing: m[2].trim(), table: nameOf(m[3]) });
    }
    continue;
  }
  if (/^DROP\s+TRIGGER\b/.test(u)) {
    const m = s.match(/^DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][\w]*)/i);
    if (m) {
      const idx = triggers.findIndex((t) => t.name === m[1]);
      if (idx !== -1) triggers.splice(idx, 1);
    }
    continue;
  }
  if (/^CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/.test(u)) {
    const m = s.match(new RegExp(`^CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(${NAME})\\s*\\(([\\s\\S]*?)\\)\\s+RETURNS`, 'i'));
    if (m) {
      const name = nameOf(m[1]);
      const args = m[2].replace(/\s+/g, ' ').trim();
      functions.push({ name, args: args || '(none)' });
    } else {
      warnings.push(`CREATE FUNCTION (unparsed): ${s.slice(0, 120)}`);
    }
    continue;
  }
  if (/^DROP\s+FUNCTION\b/.test(u)) {
    const m = s.match(new RegExp(`^DROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?(${NAME})`, 'i'));
    if (m) {
      const name = nameOf(m[1]);
      const idx = functions.map((f) => f.name).lastIndexOf(name);
      if (idx !== -1) functions.splice(idx, 1);
    }
    continue;
  }
  if (/^CREATE\s+POLICY\b/.test(u)) {
    const m = s.match(new RegExp(`^CREATE\\s+POLICY\\s+(${IDENT})\\s+ON\\s+(${NAME})`, 'i'));
    if (m) policies.push({ name: nameOf(m[1]), table: nameOf(m[2]) });
    continue;
  }
  if (/^DROP\s+POLICY\b/.test(u)) {
    const m = s.match(new RegExp(`^DROP\\s+POLICY\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})\\s+ON\\s+(${NAME})`, 'i'));
    if (m) {
      const name = nameOf(m[1]);
      const tbl = nameOf(m[2]);
      const idx = policies.findIndex((p) => p.name === name && p.table === tbl);
      if (idx !== -1) policies.splice(idx, 1);
    }
    continue;
  }
  if (/^GRANT\b|^REVOKE\b|^SET\b|^RESET\b|^CREATE\s+EXTENSION\b|^ALTER\s+PUBLICATION\b|^CREATE\s+PUBLICATION\b|^NOTIFY\b|^COMMENT\b|^ALTER\s+DEFAULT\s+PRIVILEGES\b/.test(u)) {
    continue; // not needed for schema conversion
  }
  // Anything else that looks like DDL we did not handle — record it
  if (/^(CREATE|ALTER|DROP|TRUNCATE|COMMENT)\b/.test(u)) {
    warnings.push(`Unhandled DDL: ${s.slice(0, 140)}`);
  }
}

// ---- tidy: drop views/triggers/functions referencing dropped tables ----
for (const t of tables.values()) {
  // normalise column-level PK into table primaryKey if only one PK column
  const pkCols = t.columns.filter((c) => c.pk);
  if (pkCols.length) {
    if (!t.primaryKey) t.primaryKey = pkCols.map((c) => c.name);
    pkCols.forEach((c) => { c.pk = false; });
  }
}

const result = {
  generatedAt: new Date().toISOString(),
  migrationsParsed: files.length,
  summary: {
    tables: tables.size,
    enums: enums.size,
    views: views.size,
    triggers: triggers.length,
    functions: functions.length,
    policies: policies.length,
    indexes: indexes.length,
  },
  tables: order.map((n) => tables.get(n)),
  enums: Object.fromEntries([...enums.entries()].map(([k, v]) => [k, [...v]])),
  views: Object.fromEntries([...views.entries()].map(([k, v]) => [k, v.columns ? { columns: v.columns, definitionPreview: v.definition.slice(0, 200) } : { definitionPreview: v.definition.slice(0, 200) }])),
  triggers,
  functions,
  policies,
  indexes,
  warnings,
};

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));

if (isMain) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`Parsed ${files.length} migrations`);
  console.log(`Tables: ${result.summary.tables} | Enums: ${result.summary.enums} | Views: ${result.summary.views} | Triggers: ${result.summary.triggers} | Functions: ${result.summary.functions} | Policies: ${result.summary.policies} | Indexes: ${result.summary.indexes}`);
  console.log(`Warnings: ${warnings.length}`);
  warnings.slice(0, 30).forEach((w) => console.log('  WARN: ' + w));
  console.log('Wrote ' + OUT);
}
