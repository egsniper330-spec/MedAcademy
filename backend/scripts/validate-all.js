const fs = require('fs');
const path = require('path');

function validatePHP(file) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    let braces = 0, parens = 0, inSingleStr = false, inDoubleStr = false;
    let errors = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (let j = 0; j < line.length; j++) {
        const ch = line[j];
        const prev = j > 0 ? line[j-1] : '';
        
        if (inSingleStr) {
          if (ch === "'" && prev !== '\\') inSingleStr = false;
          continue;
        }
        if (inDoubleStr) {
          if (ch === '"' && prev !== '\\') inDoubleStr = false;
          continue;
        }
        if (ch === "'") { inSingleStr = true; continue; }
        if (ch === '"') { inDoubleStr = true; continue; }
        if (ch === '{') braces++;
        if (ch === '}') braces--;
        if (ch === '(') parens++;
        if (ch === ')') parens--;
      }
    }
    
    if (braces !== 0) errors.push('Brace mismatch: ' + braces);
    if (parens !== 0) errors.push('Paren mismatch: ' + parens);
    if (!content.includes('<?php') && !content.includes('CREATE TABLE') && !content.includes('CREATE OR REPLACE')) {
      errors.push('Missing PHP/SQL open tag');
    }
    
    return { file: path.basename(file), lines: lines.length, errors };
  } catch(e) {
    return { file: path.basename(file), lines: 0, errors: [e.message] };
  }
}

const files = [
  'backend/routes/api.php',
  'backend/database/schema.sql',
  'backend/database/views.sql',
  'backend/database/triggers.sql',
  'backend/src/Controllers/AdminController.php',
  'backend/src/Controllers/AuthController.php',
  'backend/src/Controllers/CourseController.php',
  'backend/src/Controllers/CreditController.php',
  'backend/src/Controllers/DeviceController.php',
  'backend/src/Controllers/AnalyticsController.php',
  'backend/src/Controllers/SecurityController.php',
  'backend/src/Controllers/StorageController.php',
  'backend/src/Controllers/StudentController.php',
  'backend/src/Controllers/UserController.php',
  'backend/src/Controllers/VideoController.php',
  'backend/src/Controllers/RpcController.php',
  'backend/src/Controllers/IntegrityController.php',
  'backend/src/Controllers/NotificationController.php',
  'backend/src/Controllers/HealthController.php',
  'backend/src/Services/AuthService.php',
  'backend/src/Services/SecurityService.php',
  'backend/src/Services/AuditService.php',
  'backend/database/mysql-migrations/001_add_support_settings.sql',
];

let pass = 0, fail = 0;
files.forEach(f => {
  const r = validatePHP(f);
  if (r.errors.length === 0) { pass++; console.log('✅ ' + r.file + ' (' + r.lines + ' lines)'); }
  else { fail++; console.log('❌ ' + r.file + ': ' + r.errors.join(', ')); }
});
console.log('\n' + pass + ' passed, ' + fail + ' failed out of ' + files.length);
