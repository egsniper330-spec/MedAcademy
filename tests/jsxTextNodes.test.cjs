/**
 * Regression test — RAW TEXT NODES UNDER NON-<Text> PARENTS.
 *
 * Run: node tests/jsxTextNodes.test.cjs
 *
 * THE DEFECT THIS PINS:
 * React Native renders a bare string/number child of a host view as a text node
 * and throws:
 *
 *   Unexpected text node: <text>. A text node cannot be a child of a <View>.
 *
 * The trap is JSX whitespace. Babel's cleanJSXElementLiteralChild DROPS
 * whitespace-only text that spans a newline, but KEEPS whitespace-only text
 * that sits on a single line. So:
 *
 *   <View>          <Child />
 *   → createElement(View, null, "          ", createElement(Child, null))
 *
 * That space run is a real text node — and because it is whitespace the error
 * message prints nothing between "Unexpected text node:" and the explanation,
 * which is exactly how this was reported from the device.
 *
 * HOW THIS TEST WORKS:
 *  1. `cleanJSXText` re-implements Babel's whitespace rule verbatim, and
 *     `selfValidate` proves it agrees with a REAL @babel transform on samples
 *     (including the offending shape) before any file is judged.
 *  2. CANARIES prove the scanner has teeth: it must flag the known-bad shape and
 *     must NOT flag newline-separated indentation, DOM/portal JSX, or the
 *     verified @rn-primitives text components. A scanner that silently stopped
 *     matching would fail here instead of reporting a clean repo.
 *  3. Every src/**.tsx|jsx file is parsed (jsx + typescript) and walked:
 *       • whitespace/literal text children of a non-<Text> parent → offender
 *       • string/number/template literal children              → offender
 *       • && / ternary branches yielding a literal string      → offender
 *         (they become a text node whenever the branch is taken)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');
const parser = require('@babel/parser');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// Parents that legitimately accept raw text (RN requires text inside <Text>).
//   • Text / RCTText / AnimatedText: RN text hosts.
//   • AlertDialog(Title|Description): @rn-primitives components that render their
//     children into react-native's <Text> (verified in
//     node_modules/@rn-primitives/alert-dialog/dist/alert-dialog.js:215-221).
const TEXT_PARENT = /(^|\.)(Text|RCTText|AnimatedText|StyledText)$/;
const TEXT_PARENT_PRIMITIVES = /^(AlertDialog|Dialog)(Title|Description)$/;
function allowsRawText(parent) {
  return !!parent && (TEXT_PARENT.test(parent) || TEXT_PARENT_PRIMITIVES.test(parent));
}

// JSX handed to react-dom inside a WebView page (ReactDOM.createPortal(...,
// document.body), renderToString, …) is NOT React Native JSX: <button>text
// </button> is correct there and must not be reported.
const DOM_RENDERER = /(^|\.)(createPortal|renderToString|renderToStaticMarkup)$/;

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.log('  ✗ ' + msg); }
}

// ── 1. Babel's exact JSX text rule (cleanJSXElementLiteralChild) ─────────────
function cleanJSXText(value) {
  const lines = value.split(/\r\n|\n|\r/);
  let lastNonEmptyLine = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/[^ \t]/.test(lines[i])) lastNonEmptyLine = i;
  }
  let str = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isFirstLine = i === 0;
    const isLastLine = i === lines.length - 1;
    const isLastNonEmptyLine = i === lastNonEmptyLine;
    let trimmedLine = line.replace(/\t/g, ' ');
    if (!isFirstLine) trimmedLine = trimmedLine.replace(/^ +/, '');
    if (!isLastLine) trimmedLine = trimmedLine.replace(/ +$/, '');
    if (trimmedLine) {
      if (!isLastNonEmptyLine) trimmedLine += ' ';
      str += trimmedLine;
    }
  }
  return str;
}

(function selfValidate() {
  const samples = [
    '<V>          </V>',   // the reported defect: same-line spaces → text node
    '<V>\n        \n</V>', // newline + indentation only → dropped
    '<V>\n  hi  \n</V>',   // indentation around real text → "hi"
    '<V>hello</V>',        // real text
    '<V>\t</V>',           // tab on a single line → a space text node
    '<V>\n</V>',           // bare newline → dropped
  ];
  const mismatches = [];
  for (const s of samples) {
    const out = babel.transformSync('const x = ' + s + ';', {
      filename: 'probe.tsx',
      configFile: false,
      babelrc: false,
      plugins: [require('@babel/plugin-transform-react-jsx')],
    }).code;
    const ast = parser.parse(out);
    const call = ast.program.body.find((n) => n.type === 'VariableDeclaration').declarations[0].init;
    const babelChildren = call.arguments
      .slice(call.arguments[1] && call.arguments[1].type === 'ObjectExpression' ? 2 : 1)
      .filter((a) => a.type === 'StringLiteral')
      .map((a) => a.value)
      .join('');
    const ours = cleanJSXText(s.slice(s.indexOf('>') + 1, s.lastIndexOf('<')));
    if (ours !== babelChildren) {
      mismatches.push(`${JSON.stringify(s)} → ours=${JSON.stringify(ours)} babel=${JSON.stringify(babelChildren)}`);
    }
  }
  ok(mismatches.length === 0,
    `whitespace rule matches a real Babel transform on all samples${mismatches.length ? ' — ' + mismatches.join(' | ') : ''}`);
})();

// ── 2. Scanner ──────────────────────────────────────────────────────────────
function jsxName(node) {
  if (!node) return null;
  if (node.type === 'JSXIdentifier' || node.type === 'Identifier') return node.name;
  if (node.type === 'JSXMemberExpression' || node.type === 'MemberExpression') {
    const obj = jsxName(node.object);
    const prop = node.property ? node.property.name : null;
    return obj ? obj + '.' + prop : prop;
  }
  return null;
}

function literalText(expr) {
  if (!expr) return null;
  if (expr.type === 'StringLiteral') return expr.value;
  if (expr.type === 'NumericLiteral') return String(expr.value);
  if (expr.type === 'TemplateLiteral' && expr.expressions.length === 0) {
    return expr.quasis.map((q) => q.value.cooked).join('');
  }
  return null;
}

function scanSource(code) {
  const found = [];
  let ast;
  try {
    ast = parser.parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  } catch {
    return found;
  }

  (function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);

    // DOM subtrees render in the WebView page, not in the RN tree.
    if (node.type === 'CallExpression' && DOM_RENDERER.test(jsxName(node.callee) || '')) {
      return;
    }

    if (node.type === 'JSXElement' && node.openingElement) {
      const parent = jsxName(node.openingElement.name);
      if (!allowsRawText(parent)) {
        for (const child of node.children) {
          const at = child.loc ? child.loc.start.line : 0;
          if (child.type === 'JSXText') {
            const text = cleanJSXText(child.value);
            if (text) found.push({ at, parent, text });
          } else if (child.type === 'JSXExpressionContainer') {
            const e = child.expression;
            const lit = literalText(e);
            if (lit !== null) found.push({ at, parent, text: lit });
            if (e.type === 'LogicalExpression' || e.type === 'ConditionalExpression') {
              const branches = [e.left, e.right, e.consequent, e.alternate];
              const litBranch = branches.map(literalText).find((t) => t !== null);
              if (litBranch !== undefined) {
                found.push({ at, parent, text: `<conditional string ${JSON.stringify(litBranch)}>` });
              }
            }
          }
        }
      }
    }

    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      visit(node[k]);
    }
  })(ast.program);

  return found;
}

// ── 3. Canaries — the scanner must find the bug and spare the legitimate cases ─
{
  const bad = scanSource('const x = <View>          <Child /></View>;');
  ok(bad.length === 1 && bad[0].parent === 'View',
    `canary: same-line whitespace under <View> IS detected (found ${bad.length})`);

  const indented = scanSource('const x = <View>\n  <Child />\n</View>;');
  ok(indented.length === 0, `canary: newline-separated indentation is NOT flagged (found ${indented.length})`);

  const dom = scanSource('const x = ReactDOM.createPortal(<button>Exit</button>, document.body);');
  ok(dom.length === 0, `canary: DOM/portal JSX is NOT flagged (found ${dom.length})`);

  const prim = scanSource('const x = <AlertDialogTitle>Hi</AlertDialogTitle>;');
  ok(prim.length === 0, `canary: @rn-primitives text components are allowed (found ${prim.length})`);

  const inText = scanSource('const x = <Text>{cond && "yes"}</Text>;');
  ok(inText.length === 0, `canary: conditional string inside <Text> is NOT flagged (found ${inText.length})`);

  const conditional = scanSource('const x = <View>{cond && "yes"}</View>;');
  ok(conditional.length >= 1, `canary: conditional string under <View> IS flagged (found ${conditional.length})`);
}

// ── 4. Scan the whole source tree ───────────────────────────────────────────
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx|jsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const offenders = [];
for (const file of walk(SRC)) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  for (const o of scanSource(fs.readFileSync(file, 'utf8'))) offenders.push({ rel, ...o });
}

ok(offenders.length === 0, `no raw text nodes under non-<Text> parents in src/ (found ${offenders.length})`);
for (const o of offenders) {
  ok(false, `  → ${o.rel}:${o.at} <${o.parent}> has text child ${JSON.stringify(o.text)}`);
}

// The exact root-layout defect reported from the device must stay fixed.
{
  const rootLayout = fs.readFileSync(path.join(ROOT, 'src/app/_layout.tsx'), 'utf8');
  ok(!/<GestureHandlerRootView[^>]*>[ \t]+</.test(rootLayout),
    'root layout: no same-line whitespace text child after <GestureHandlerRootView>');
}

console.log('──────────────────────────────────────────────');
if (failed === 0) {
  console.log(`RESULT: ${passed} passed, 0 failed`);
  console.log('ALL JSX TEXT-NODE TESTS PASSED');
} else {
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  FAILED: ' + f);
  process.exit(1);
}
