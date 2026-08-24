const fs = require('fs');

function walk(dir) {
    const files = [];
    const entries = fs.readdirSync(dir, {withFileTypes:true});
    for (const e of entries) {
        const p = dir + '/' + e.name;
        if (e.isDirectory()) files.push(...walk(p));
        else if (e.name.endsWith('.php')) files.push(p);
    }
    return files;
}

const phpFiles = walk('backend/src');
const classMap = {};

// Build class->file map
for (const f of phpFiles) {
    const src = fs.readFileSync(f, 'utf8');
    const nsMatch = src.match(/namespace\s+([A-Za-z\\]+);/);
    const clsMatch = src.match(/(?:final\s+|abstract\s+)?class\s+([A-Za-z]+)/);
    if (nsMatch && clsMatch) {
        const fqcn = nsMatch[1] + '\\' + clsMatch[1];
        classMap[fqcn] = f;
    }
}

// Check use statements
let issues = 0;
for (const f of phpFiles) {
    const src = fs.readFileSync(f, 'utf8');
    const useRe = /use\s+([A-Za-z\\]+);/g;
    let m;
    while ((m = useRe.exec(src)) !== null) {
        const used = m[1];
        if (used.startsWith('MedAcademy\\') && !used.includes('{')) {
            if (!classMap[used]) {
                console.log('MISSING: ' + f + ' uses ' + used);
                issues++;
            }
        }
    }
}

if (issues === 0) {
    console.log('All ' + phpFiles.length + ' PHP files: use statements resolve correctly');
} else {
    console.log(issues + ' broken use statements found');
    process.exit(1);
}
