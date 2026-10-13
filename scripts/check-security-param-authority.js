#!/usr/bin/env node
/* global __dirname */   // CommonJS: available at runtime, not declared by the flat config
/**
 * check-security-param-authority.js
 *
 * ─── WHAT THIS GUARD IS FOR ──────────────────────────────────────────────────
 *
 * A screen must never DECIDE anything about device security from route params.
 * Route params are a client-suppliable carrier: anyone can deep-link into
 * `/(app)/security-warning?riskScore=0&blocksLogin=false&threats=[]` and, on a
 * screen that trusts them, the result is a security surface that reports
 * "no issues, risk 0" while the real verdict says otherwise. That is not
 * theoretical — it is the defect that produced the contradictory warning screen
 * this file now prevents (`router.replace('/security-warning')` passed no params,
 * so the param-derived defaults `[] / 0 / false` were rendered as fact).
 *
 * The app already has the right architecture: `useSecurity()` (SecurityContext)
 * is the single authoritative source of the verdict — findings, risk score, and
 * the policy outcome. This guard enforces that architecture statically:
 *
 *   • route params MAY drive navigation and display-only data (ids, titles,
 *     filter tab, a pre-login presentation payload) — params are not banned;
 *   • route params MAY NOT be the source of a security finding, risk score, or
 *     gate/blocking decision unless the same statement consults the
 *     authoritative verdict FIRST (the approved `authoritative ? … : params …`
 *     fallback shape);
 *   • route params may never AUGMENT or OVERRIDE the authoritative verdict
 *     (`security.blocksLogin || params.blocksLogin === 'true'`);
 *   • route params may never be handed INTO the security decision layer.
 *
 * ─── RULES (rule ids are stable — tests assert them verbatim) ────────────────
 *
 *   PARAM_AUTHORITY_UNGUARDED_DERIVATION
 *       A security value is derived from params in a file that has the
 *       authoritative context available, without consulting it in that same
 *       statement. Fix: make the authoritative verdict the primary source.
 *
 *   PARAM_AUTHORITY_UNEXEMPTED_DERIVATION
 *       Same, in a file with NO authoritative source and no recorded exemption.
 *       Fix: consume the authoritative context, or add an entry to
 *       PRELOGIN_EXEMPTIONS with a reason (pre-login flows only).
 *
 *   PARAM_AUTHORITY_OVERRIDE
 *       A param-derived security field is combined with the authoritative value
 *       using `||`, `&&` or `??`. Params must not widen or relax a verdict.
 *
 *   PARAM_AUTHORITY_INTO_SECURITY_API
 *       A param-derived value is passed as an argument to the security decision
 *       layer (`useSecurity*`, `applySecurityPolicy`, `assessRisk`, …).
 *
 * ─── DELIBERATELY NOT FLAGGED (so this stays a useful guard, not noise) ───────
 *
 *   • `router.push({ pathname, params })` — producing params from authoritative
 *     state is the CORRECT direction (see src/app/(app)/_layout.tsx).
 *   • ids / names / slugs / tabs read from params (`courseId`, `user_id`, `id`).
 *   • `params.redirect` used as a navigation destination.
 *   • Params rendered as display copy that is not a security decision.
 *   • Any file that never calls a params hook (skipped entirely).
 *   • Comments: analysis is on the AST, so prose that merely mentions
 *     `params.riskScore` can neither satisfy nor defeat a rule.
 *
 * ─── USAGE ───────────────────────────────────────────────────────────────────
 *
 *   node scripts/check-security-param-authority.js             # scan the app
 *   node scripts/check-security-param-authority.js --verbose   # + allowed uses
 *   node scripts/check-security-param-authority.js --json      # machine output
 *   node scripts/check-security-param-authority.js --root <dir> [--target a,b]
 *
 * Exits 0 when clean, 1 on any violation (or on an internal failure — a guard
 * that cannot run must never report success).
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const ts   = require('typescript');

const REPO_ROOT = path.resolve(__dirname, '..');

// ─── configuration ───────────────────────────────────────────────────────────

/**
 * Default scan roots, relative to --root. The whole of `src`, not just the
 * screens: a security decision derived from route params is equally wrong in a
 * helper a screen calls, and scanning everything costs about three seconds.
 */
const DEFAULT_TARGETS = ['src'];

/** Hooks that read the route's params (client-suppliable). */
const PARAM_HOOKS = ['useLocalSearchParams', 'useGlobalSearchParams'];

/** Hooks that yield the AUTHORITATIVE security verdict. */
const AUTHORITY_HOOKS = ['useSecurity', 'useSecurityContext', 'useSecurityGate', 'useSecurityVerdict'];

/**
 * Param field names that carry a security finding, score or decision.
 *
 * NOTE the case-sensitive `[A-Z]` patterns: written with /i they would also
 * match ordinary words — `/^blocks?[A-Z]/i` matches "blockers" (a course-publish
 * concept, not a security decision), which is exactly the kind of false positive
 * that makes a guard get deleted. The named compounds are matched separately.
 */
const SECURITY_FIELD = [
  /^threats?$/i,
  /^findings?$/i,
  /^risk/i,
  /^block(s)?(Login|Video|Reason|ed)/i,   // blocksLogin / blockVideo / blocked
  /^block[s]?[A-Z]/,                      // any camelCase block* field
  /^mustBlock$/i,
  /^verdict$/i,
  /^gate(Decision|State|Result|Outcome|Policy)?$/i,
  /^policy(Decision|Outcome|Result|State)?$/i,
  /^integrity/i,
  /^appAttest/i,
  /^playIntegrity/i,
  /^security[A-Z]/,                       // case-sensitive
  /^tampered/i,
  /^jailbroken/i,
  /^rooted$/i,
  /^emulator/i,
];

/** Local variable names that would hold a security finding, score or decision. */
const SECURITY_NAME = [
  /threat/i,
  /finding/i,
  /risk/i,
  /^block(s)?(Login|Video|Reason|ed)/i,
  /^block[s]?[A-Z]/,                      // case-sensitive
  /mustBlock/i,
  /verdict/i,
  /^gate(Decision|Result|Outcome|State|Policy)?$/i,
  /^policy(Decision|Outcome|Result|State)?$/i,
  /integrity/i,
  /^(appAttest|playIntegrity)/i,
  /^security(Blocked|Findings|Verdict|Decision|Policy|Threats)/,
];

/** Callees that constitute the security decision layer itself. */
const SECURITY_API_CALLEE =
  /^(useSecurity\w*|applySecurityPolicy|evaluateSecurity|assessRisk|resolveGateDecision|setSecurityPolicy|enforceSecurity|recordSecurityVerdict)$/;

/**
 * Files permitted to derive a security value from route params.
 *
 * Every entry is a reviewable claim, and every claim is conditional:
 *
 *   • exact repo-relative path (relative to --root);
 *   • `fields` — the ONLY param fields covered; anything else still fails;
 *   • the entry is VOID the moment the file acquires an authoritative source
 *     (`useSecurity*`), because then the params are no longer the only carrier
 *     of the decision. Enforced in classifyDerivation(), pinned by a fixture.
 *
 * Pre-login is the one legitimate case: before authentication there is no
 * SecurityContext verdict to consult, so the server-computed outcome can only
 * arrive as params. Such a screen must stay PRESENTATION-ONLY — it may not read
 * the authoritative context and may not fold params back into the verdict.
 */
const PRELOGIN_EXEMPTIONS = {
  'src/app/(auth)/security-warning.tsx': {
    reason:
      'Pre-login screen: no authenticated verdict exists yet, so the server-computed '
      + 'outcome arrives as route params. Presentation-only; reads no authoritative '
      + 'context, and this exemption is void if it ever starts to.',
    fields: ['threats', 'riskScore', 'blocksLogin', 'redirect'],
  },
};

// ─── AST helpers ─────────────────────────────────────────────────────────────

/** Walk every node under `node` (inclusive) and yield it. */
function walk(node, visit) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** Names declared by a binding pattern (identifiers only). */
function bindingNames(name, out = []) {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
  } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) bindingNames(el.name, out);
    }
  }
  return out;
}

/** { localName -> param field } for `const { riskScore: r } = useLocalSearchParams()`. */
function destructuredFields(name, out = []) {
  if (ts.isObjectBindingPattern(name)) {
    for (const el of name.elements) {
      if (!ts.isBindingElement(el)) continue;
      const field = el.propertyName && ts.isIdentifier(el.propertyName)
        ? el.propertyName.text
        : (ts.isIdentifier(el.name) ? el.name.text : null);
      if (field && ts.isIdentifier(el.name)) out.push({ local: el.name.text, field });
    }
  }
  return out;
}

function calleeName(call) {
  return ts.isIdentifier(call.expression) ? call.expression.text : null;
}

/** Enclosing statement of a node (VariableStatement, ReturnStatement, …). */
function enclosingStatement(node) {
  let cur = node;
  while (cur && !ts.isStatement(cur)) cur = cur.parent;
  return cur ?? null;
}

function positionOf(sf, node) {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: line + 1, col: character + 1 };
}

function snippet(sf, node, max = 160) {
  const text = node.getText(sf).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const matchesAny = (text, patterns) => patterns.some((re) => re.test(text));

// ─── per-file analysis ───────────────────────────────────────────────────────

/**
 * Analyse one file.
 *
 * @returns {{ skipped: boolean, violations: Array, allowed: Array }}
 */
function analyzeSource(sf, relPath) {
  const violations = [];
  const allowed    = [];

  // Per-file hook aliases (`import { useLocalSearchParams as useParams }`).
  const paramHooks = new Set();
  const authHooks  = new Set();
  walk(sf, (node) => {
    if (!ts.isImportDeclaration(node)) return;
    const clause = node.importClause;
    if (!clause || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return;
    for (const spec of clause.namedBindings.elements) {
      const imported = (spec.propertyName ?? spec.name).text;
      const local    = spec.name.text;
      if (PARAM_HOOKS.includes(imported))    paramHooks.add(local);
      if (AUTHORITY_HOOKS.includes(imported)) authHooks.add(local);
    }
  });
  for (const h of PARAM_HOOKS)     paramHooks.add(h);
  for (const h of AUTHORITY_HOOKS) authHooks.add(h);

  const isParamCall = (node) =>
    ts.isCallExpression(node) && paramHooks.has(calleeName(node) ?? '');

  // Fast path: a file that never reads params cannot violate these rules.
  let readsParams = false;
  walk(sf, (node) => { if (isParamCall(node)) readsParams = true; });
  if (!readsParams) return { skipped: true, violations, allowed };

  // tainted: local identifier -> Set of param fields it carries ('*' = the whole
  // params object, i.e. an unknown field until a concrete member access names one).
  const tainted  = new Map();
  const authority = new Set();

  const declarations = [];
  walk(sf, (node) => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    if (ts.isCallExpression(node) && authHooks.has(calleeName(node) ?? '')) {
      const stmt = enclosingStatement(node);
      if (stmt) {
        walk(stmt, (n) => {
          if (ts.isVariableDeclaration(n) && n.initializer === node) {
            for (const nm of bindingNames(n.name)) authority.add(nm);
          }
        });
      }
    }
  });

  const merge = (name, fields) => {
    const cur = tainted.get(name);
    let changed = false;
    if (!cur) { tainted.set(name, new Set(fields)); return true; }
    for (const f of fields) if (!cur.has(f)) { cur.add(f); changed = true; }
    return changed;
  };

  // PARAM ROOTS — identifiers holding the params OBJECT itself, so a member read
  // off one is a DIRECT route-param read. A value computed FROM the object is not
  // a root: once a screen has vetted a value against the authoritative verdict
  // (the approved `authoritative ? … : params …` shape), downstream display state
  // computed from it is none of this guard's business. Without that split the
  // guard flags `findingCount = threats.length` — noise that trains people to
  // ignore it.
  const paramRoots = new Set();
  for (const decl of declarations) {
    if (!decl.initializer || !isParamCall(decl.initializer)) continue;
    for (const nm of bindingNames(decl.name)) { merge(nm, ['*']); paramRoots.add(nm); }
    for (const { local, field } of destructuredFields(decl.name)) merge(local, [field]);
  }

  const unwrap = (n) => {
    let cur = n;
    while (cur && (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur)
      || ts.isTypeAssertionExpression(cur) || ts.isNonNullExpression(cur))) cur = cur.expression;
    return cur;
  };
  // A pure alias of the object (`const p = params`) is a root as well, so the
  // indirection a developer adds to shorten the code cannot dodge the rules.
  for (const decl of declarations) {
    const init = decl.initializer ? unwrap(decl.initializer) : null;
    if (!init || !ts.isIdentifier(init) || !paramRoots.has(init.text)) continue;
    for (const nm of bindingNames(decl.name)) { merge(nm, ['*']); paramRoots.add(nm); }
  }

  /** Param fields referenced anywhere inside `node`. */
  const fieldsIn = (node) => {
    const fields = new Set();
    walk(node, (n) => {
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && tainted.has(n.expression.text)) {
        for (const f of tainted.get(n.expression.text)) fields.add(f);
        fields.add(n.name.text);                       // the accessed member names the field
      } else if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && tainted.has(n.expression.text)) {
        // `params['riskScore']` must not be a way round the rules.
        for (const f of tainted.get(n.expression.text)) fields.add(f);
        const arg = n.argumentExpression;
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) fields.add(arg.text);
      } else if (ts.isIdentifier(n) && tainted.has(n.text)) {
        for (const f of tainted.get(n.text)) fields.add(f);
      }
    });
    return fields;
  };

  const refsAuthority = (node) => {
    let found = false;
    walk(node, (n) => { if (ts.isIdentifier(n) && authority.has(n.text)) found = true; });
    return found;
  };

  /** Does this subtree read the params object itself (directly or via an alias)? */
  const refsParamRoot = (node) => {
    let found = false;
    walk(node, (n) => { if (ts.isIdentifier(n) && paramRoots.has(n.text)) found = true; });
    return found;
  };

  // Propagate through simple assignments / useMemo factories (bounded fixpoint).
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const decl of declarations) {
      if (!decl.initializer || isParamCall(decl.initializer)) continue;
      const fields = fieldsIn(decl.initializer);
      if (fields.size === 0) continue;
      for (const nm of bindingNames(decl.name)) if (merge(nm, [...fields])) changed = true;
    }
    if (!changed) break;
  }

  const securitySignal = (decl, fields) => {
    const concrete = [...fields].filter((f) => f !== '*' && matchesAny(f, SECURITY_FIELD));
    const named    = bindingNames(decl.name).filter((n) => matchesAny(n, SECURITY_NAME));
    return { concrete, named };
  };

  const exemption = PRELOGIN_EXEMPTIONS[relPath] ?? null;

  // ── rule 1/2: a security derivation must consult the authoritative verdict ──
  for (const decl of declarations) {
    if (!decl.initializer) continue;
    const fromHookCall = isParamCall(decl.initializer);
    // Only a direct read of the params object is a "derivation".
    if (!fromHookCall && !refsParamRoot(decl.initializer)) continue;

    const fields = fromHookCall ? new Set(['*']) : fieldsIn(decl.initializer);
    if (fromHookCall) {
      for (const { field } of destructuredFields(decl.name)) fields.add(field);
    }
    if (fields.size === 0) continue;

    const fieldList = () => [...fields].filter((f) => f !== '*').sort();
    const { concrete, named } = securitySignal(decl, fields);
    if (concrete.length === 0 && named.length === 0) {
      allowed.push({ reason: 'navigation/display only', fields: fieldList(), line: positionOf(sf, decl).line });
      continue;
    }

    const stmt = enclosingStatement(decl);
    const guarded = stmt ? refsAuthority(stmt) : false;
    if (guarded) {
      allowed.push({ reason: 'authoritative-first fallback', fields: fieldList(), line: positionOf(sf, decl).line });
      continue;
    }

    const offending = concrete.length > 0 ? concrete : named;
    const pos = positionOf(sf, decl);

    if (authority.size > 0) {
      violations.push({
        rule: 'PARAM_AUTHORITY_UNGUARDED_DERIVATION',
        line: pos.line, col: pos.col,
        detail: `security value derived from route params (${offending.join(', ')}) while the authoritative`
          + ' verdict is available but not consulted in this statement',
        code: snippet(sf, decl),
      });
    } else if (exemption && offending.every((f) => exemption.fields.includes(f))) {
      allowed.push({ reason: 'pre-login exemption', fields: offending, line: pos.line });
    } else {
      violations.push({
        rule: 'PARAM_AUTHORITY_UNEXEMPTED_DERIVATION',
        line: pos.line, col: pos.col,
        detail: `security value derived from route params (${offending.join(', ')}) with no authoritative`
          + ' security source in this file and no recorded pre-login exemption',
        code: snippet(sf, decl),
      });
    }
  }

  // ── rule 3: params must not augment or override the authoritative verdict ──
  walk(sf, (node) => {
    if (!ts.isBinaryExpression(node)) return;
    const op = node.operatorToken.kind;
    if (op !== ts.SyntaxKind.BarBarToken
      && op !== ts.SyntaxKind.AmpersandAmpersandToken
      && op !== ts.SyntaxKind.QuestionQuestionToken) return;

    const sideIsParam = (side) => refsParamRoot(side)
      && [...fieldsIn(side)].some((f) => f !== '*' && matchesAny(f, SECURITY_FIELD));
    const leftParam  = sideIsParam(node.left);
    const rightParam = sideIsParam(node.right);
    const leftAuth   = refsAuthority(node.left);
    const rightAuth  = refsAuthority(node.right);
    if (!((leftParam && rightAuth) || (rightParam && leftAuth))) return;

    const pos = positionOf(sf, node);
    const securityField = [...fieldsIn(node.left), ...fieldsIn(node.right)]
      .find((f) => f !== '*' && matchesAny(f, SECURITY_FIELD));
    violations.push({
      rule: 'PARAM_AUTHORITY_OVERRIDE',
      line: pos.line, col: pos.col,
      detail: `route param "${securityField}" is combined with the authoritative verdict by `
        + `"${node.operatorToken.getText(sf)}" — params may not widen, relax or amend a verdict`,
      code: snippet(sf, node),
    });
  });

  // ── rule 4: params must not be fed into the security decision layer ────────
  walk(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = calleeName(node);
    if (!callee || !SECURITY_API_CALLEE.test(callee)) return;
    for (const arg of node.arguments) {
      if (fieldsIn(arg).size === 0 || !refsParamRoot(arg)) continue;
      const pos = positionOf(sf, node);
      violations.push({
        rule: 'PARAM_AUTHORITY_INTO_SECURITY_API',
        line: pos.line, col: pos.col,
        detail: `route params are passed into the security decision layer (${callee}(...))`,
        code: snippet(sf, node),
      });
      break;
    }
  });

  return { skipped: false, violations, allowed };
}

function analyzeFile(absPath, relPath) {
  const text = fs.readFileSync(absPath, 'utf8');
  const sf = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result = analyzeSource(sf, relPath);
  for (const v of result.violations) v.file = relPath;
  return result;
}

// ─── file discovery ──────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'android', 'ios', '.expo', 'dist', 'build']);

function collectFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;                                     // absent target is not an error
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectFiles(abs, out);
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { root: REPO_ROOT, targets: DEFAULT_TARGETS, json: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--verbose') opts.verbose = true;
    else if (arg === '--root') opts.root = path.resolve(argv[++i]);
    else if (arg === '--target') opts.targets = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith('--target=')) opts.targets = arg.slice('--target='.length).split(',').filter(Boolean);
    else if (!arg.startsWith('--')) opts.targets = [arg];
    else {
      console.error(`unknown flag: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  let files = [];
  for (const target of opts.targets) {
    files = files.concat(collectFiles(path.resolve(opts.root, target)));
  }
  files = [...new Set(files)].sort();

  const allViolations = [];
  const scanned = [];
  const allowed = [];
  let analyzed = 0;

  for (const abs of files) {
    const rel = path.relative(opts.root, abs).split(path.sep).join('/');
    let result;
    try {
      result = analyzeFile(abs, rel);
    } catch (e) {
      // A guard that cannot parse a file must fail — never pass silently.
      console.error(`  ✖ ${rel}: analysis failed — ${e.message}`);
      process.exit(1);
    }
    scanned.push(rel);
    if (result.skipped) continue;
    analyzed++;
    for (const v of result.violations) allViolations.push(v);
    for (const a of result.allowed) allowed.push({ ...a, file: rel });
  }

  // FAIL CLOSED. A guard that scanned nothing, or found nothing that reads route
  // params, has not proved anything — it is far more likely to be misconfigured
  // (renamed directory, wrong --root) than to mean the risk has vanished. Passing
  // here would be exactly the "control that never ran reported as satisfied"
  // failure this file exists to prevent.
  if (files.length === 0) {
    console.error(`  \u2716 no files found to scan under: ${opts.targets.join(', ')} (root: ${opts.root})`);
    console.error('    refusing to report success for an empty scan');
    process.exit(1);
  }
  if (analyzed === 0) {
    console.error('  \u2716 no scanned file reads route params \u2014 the rule set cannot have been exercised');
    console.error('    refusing to report success; check --root/--target');
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify({
      scanned: scanned.length,
      readRouteParams: analyzed,
      violations: allViolations,
      allowed: allowed.map((a) => ({ file: a.file, reason: a.reason, fields: a.fields, line: a.line })),
    }, null, 2));
    process.exit(allViolations.length === 0 ? 0 : 1);
  }

  console.log(`\n── Security param-authority check ──────────────────────────────`);
  console.log(`  scanned ${scanned.length} file(s); ${analyzed} read route params`);

  if (opts.verbose) {
    for (const a of allowed) {
      console.log(`  · allowed  ${a.file}:${a.line}  ${a.reason}${a.fields && a.fields.length ? ` (${a.fields.join(', ')})` : ''}`);
    }
  }

  if (allViolations.length === 0) {
    console.log('  ✅ no screen derives a security finding, risk score or gate decision from route params');
    console.log('     (authoritative source: useSecurity() / SecurityContext)');
    return;
  }

  console.error(`\n  ❌ ${allViolations.length} security param-authority violation(s):\n`);
  for (const v of allViolations) {
    console.error(`  ${v.file}:${v.line}:${v.col}  ${v.rule}`);
    console.error(`      ${v.detail}`);
    console.error(`      ${v.code}`);
    console.error('');
  }
  console.error('  Fix: read the verdict from the authoritative context (useSecurity()) and use route');
  console.error('       params only for navigation or display. Pre-login screens that genuinely have no');
  console.error('       verdict must be recorded in PRELOGIN_EXEMPTIONS with a reason.');
  console.error('');
  process.exit(1);
}

main();
