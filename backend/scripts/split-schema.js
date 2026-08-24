/**
 * split-schema.js
 * ---------------
 * Splits backend/database/schema.sql into two files so it can be imported
 * even without cPanel Terminal (phpMyAdmin cannot execute DELIMITER blocks):
 *
 *   backend/database/schema-no-triggers.sql  — tables, indexes, appendix
 *   backend/database/triggers.sql            — the DELIMITER $$ trigger block
 *
 * Primary method remains:  mysql -u USER -p DB < backend/database/schema.sql
 * (cPanel Terminal). The split files are the fallback for phpMyAdmin.
 *
 * Usage: node backend/scripts/split-schema.js
 */
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const schemaPath = path.join(root, 'backend/database/schema.sql');
const sql = fs.readFileSync(schemaPath, 'utf8');

const marker = 'TRIGGERS (ported from PostgreSQL';
const idx = sql.indexOf(marker);
if (idx === -1) {
  console.error('trigger marker not found — is schema.sql generated?');
  process.exit(1);
}

const header = '-- MedAcademy MySQL schema — split files for phpMyAdmin import.\n'
  + '-- Primary method: cPanel Terminal -> mysql -u USER -p DB < backend/database/schema.sql\n'
  + '-- See backend/NAMECHEAP_DEPLOYMENT.md step 7.\n\n';

const base = sql.slice(0, idx).replace(/SET FOREIGN_KEY_CHECKS = 0;\n/, '');
const triggers = sql.slice(idx);

fs.writeFileSync(path.join(root, 'backend/database/schema-no-triggers.sql'), header + base + '\nSET FOREIGN_KEY_CHECKS = 1;\n');
fs.writeFileSync(path.join(root, 'backend/database/triggers.sql'), header + triggers);
console.log('Wrote backend/database/schema-no-triggers.sql and backend/database/triggers.sql');
