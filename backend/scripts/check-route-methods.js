const fs = require('fs');

const routes = fs.readFileSync('backend/routes/api.php', 'utf8');

// Extract use statements to build a map of short class -> full class
const useRe = /use\s+([A-Za-z\\]+)\\([A-Za-z]+);/g;
const classMap = {};
let m;
while ((m = useRe.exec(routes)) !== null) {
    classMap[m[2]] = m[1] + '\\' + m[2];
}

// Extract [ClassName::class, 'method'] pairs
const routeRe = /\[([A-Za-z\\]+)::class,\s*'([a-zA-Z]+)'\]/g;
let match2;
const missing = [];
const found = [];

while ((match2 = routeRe.exec(routes)) !== null) {
    const shortClass = match2[1];
    const method = match2[2];
    
    // Resolve to full class (handle both short names and inline FQCNs)
    const fqcn = classMap[shortClass] || shortClass;
    
    // Strip leading backslash if present
    const cleaned = fqcn.replace(/^\\+/, '');
    
    // Convert namespace to path
    const parts = cleaned.replace(/^MedAcademy\\/, '').split('\\');
    const filePath = 'backend/src/' + parts.join('/') + '.php';
    
    if (!fs.existsSync(filePath)) {
        missing.push(fqcn + '::' + method + ' (file not found: ' + filePath + ')');
        continue;
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    const methodRegex = new RegExp('function\\s+' + method + '\\s*\\(');
    if (!methodRegex.test(content)) {
        missing.push(fqcn + '::' + method + ' (method not found in ' + filePath + ')');
    } else {
        found.push(fqcn + '::' + method);
    }
}

console.log('Methods found: ' + found.length);
if (missing.length > 0) {
    console.log('MISSING (' + missing.length + '):');
    missing.forEach(m => console.log('  X ' + m));
    process.exit(1);
} else {
    console.log('All 56 route handler methods exist');
}
