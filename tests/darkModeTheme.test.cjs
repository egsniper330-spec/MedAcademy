#!/usr/bin/env node
'use strict';
/**
 * darkModeTheme.test.cjs — locks the Dark Mode surface ladder and proves Light
 * Mode cannot have shifted.
 *
 * The bug this guards: the neumorphic system had exactly ONE background token
 * (`base`). Page, sidebar, card, input and modal all painted the same deep navy,
 * so Dark read as flat while Light looked layered (there, the soft shadows do
 * the separating). Two mechanical patterns caused the rest of the flatness:
 *
 *   1. `backgroundColor: c.base` for surfaces that are not the page.
 *   2. `color: c.text, opacity: 0.4…0.6` for every piece of secondary text —
 *      which on dark blends the glyph toward the navy floor (4.0–4.4:1 at 0.5).
 *
 * Assertions are of two kinds, deliberately separated:
 *   • SOURCE — the ladder exists, is wired into the shared components, and the
 *     Light branch of `mutedTextStyle` is literally `{ color: c.text, opacity }`
 *     so Light renders byte-identically (verified against HEAD by
 *     .freebuff/verify-muted-sweep.cjs: 885/885 opacities preserved).
 *   • MEASURED — real WCAG contrast computed from the token values parsed out of
 *     src/lib/neu.ts. Not a claim about a screenshot; a claim about the numbers
 *     the code will paint.
 *
 * No build, no device.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  \u2714 ' + label); }
  else { failed++; console.log('  \u2718 ' + label); }
}
function section(name) { console.log('\n' + name); }

const neu = read('src/lib/neu.ts');

/* ── parse both palettes out of the source ───────────────────────────────── */
function palette(name) {
  const start = neu.indexOf(`  ${name}: {`);
  if (start === -1) return null;
  let depth = 0, i = neu.indexOf('{', start);
  const from = i;
  for (; i < neu.length; i++) {
    if (neu[i] === '{') depth++;
    else if (neu[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = neu.slice(from, i);
  const out = {};
  for (const m of body.matchAll(/^\s*(\w+):\s*'([^']+)'/gm)) out[m[1]] = m[2];
  return out;
}
const light = palette('light');
const dark = palette('dark');

/* ── WCAG relative luminance + contrast ──────────────────────────────────── */
const srgb = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
const lum = (hex) => {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return 0.2126 * srgb(parseInt(n.slice(0, 2), 16)) + 0.7152 * srgb(parseInt(n.slice(2, 4), 16)) + 0.0722 * srgb(parseInt(n.slice(4, 6), 16));
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** Composite an `rgba()` / `#RRGGBBAA` layer over a solid colour. */
const over = (layer, base) => {
  let r, g, b, a;
  const m = layer.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map((s) => parseFloat(s));
    [r, g, b] = p; a = p[3] ?? 1;
  } else {
    const h = layer.replace('#', '');
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
    a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  }
  const bh = base.replace('#', '');
  const br = parseInt(bh.slice(0, 2), 16), bg = parseInt(bh.slice(2, 4), 16), bb = parseInt(bh.slice(4, 6), 16);
  const to = (v) => Math.round(v).toString(16).padStart(2, '0');
  return `#${to(a * r + (1 - a) * br)}${to(a * g + (1 - a) * bg)}${to(a * b + (1 - a) * bb)}`;
};
const r2 = (n) => Math.round(n * 100) / 100;

/* ══ 1. the ladder exists ══════════════════════════════════════════════════ */
section('1. surface ladder');
const RUNGS = ['base', 'navSurface', 'inputSurface', 'surface', 'elevated'];
ok(RUNGS.every((k) => typeof dark[k] === 'string' && /^#[0-9A-Fa-f]{6}$/.test(dark[k])),
  `dark defines all ${RUNGS.length} surface rungs (${RUNGS.join(', ')})`);
ok(new Set(RUNGS.map((k) => dark[k])).size === RUNGS.length,
  'no two dark surface rungs are the same colour — the flatness bug cannot return');
ok(dark.mode === 'dark' && light.mode === 'light',
  'each palette carries a `mode` discriminant, so helpers need no separate isDark flag');

/* ══ 2. Light Mode is untouched — the reference must not move ═════════════ */
section('2. Light preservation (the critical invariant)');
const LIGHT_BASE = '#E8EEF6';
ok(light.base === LIGHT_BASE, `light base is still ${LIGHT_BASE}`);
for (const k of ['surface', 'navSurface', 'inputSurface', 'elevated']) {
  ok(light[k] === LIGHT_BASE, `light ${k} collapses to base — Light surfaces render exactly as before`);
}
ok(light.text === '#081A35' && light.primary === '#1E90FF' && light.accent === '#2DA8FF',
  'light text/primary/accent brand values unchanged');
ok(light.shadowDark === 'rgba(160,185,215,0.78)' && light.shadowLight === 'rgba(255,255,255,0.90)',
  'light neumorphic shadows unchanged');
ok(light.onPrimary === '#FFFFFF',
  'light primary-button ink is still white (dark is the only theme that inverts it)');
ok(/: \{ color: c\.text, opacity \};/.test(neu),
  'mutedTextStyle returns `{ color: c.text, opacity }` VERBATIM for light — adopting it cannot restyle Light');
ok(/isDarkPalette\(c\)\s*\?\s*\{ color: opacity <= 0\.42 \? c\.textSubtle : c\.textMuted, opacity: 1 \}/.test(neu),
  'dark branch of mutedTextStyle uses a SOLID tier colour at full opacity (no blend toward the navy floor)');

/* ══ 3. the ladder is a real perceptual ladder ════════════════════════════ */
section('3. rung separation (measured, not assumed)');
const ordered = [
  ['base', 'navSurface'], ['navSurface', 'surface'],
  ['inputSurface', 'surface'], ['surface', 'elevated'],
];
for (const [a, b] of ordered) {
  const cr = ratio(dark[a], dark[b]);
  ok(cr >= 1.10, `${a} → ${b} luminance step is ${r2(cr)}:1 (>= 1.10 is above the just-noticeable floor)`);
}
const darkLums = RUNGS.map((k) => lum(dark[k]));
ok(darkLums[0] === Math.min(...darkLums) && lum(dark.elevated) === Math.max(...darkLums),
  'base is the darkest rung and elevated the lightest — page sits BENEATH modal, as the eye expects');
ok(lum(dark.base) > 0.005,
  'dark base is deep navy, not pure black (brand identity preserved)');

/* ══ 4. text contrast on every surface ═══════════════════════════════════ */
section('4. text contrast (WCAG, computed from the tokens)');
const SURFACES = ['base', 'navSurface', 'inputSurface', 'surface', 'elevated'];
for (const s of SURFACES) {
  const cr = ratio(dark.text, dark[s]);
  ok(cr >= 7.0, `primary text on ${s}: ${r2(cr)}:1 (AAA body text)`);
}
for (const s of SURFACES) {
  const cr = ratio(dark.textMuted, dark[s]);
  ok(cr >= 4.5, `muted text on ${s}: ${r2(cr)}:1 (AA small text) — was 4.0–4.4 at opacity 0.5`);
}
for (const s of ['base', 'surface', 'elevated']) {
  const cr = ratio(dark.textSubtle, dark[s]);
  ok(cr >= 4.5, `subtle/placeholder text on ${s}: ${r2(cr)}:1 (AA small text) — was 2.5:1 as \`\${text}50\``);
}

/* ══ 5. semantic + button ink ════════════════════════════════════════════ */
section('5. semantic colours and button ink');
for (const [name, base] of [['elevated', dark.elevated], ['surface', dark.surface]]) {
  for (const tone of ['success', 'warning', 'danger', 'info']) {
    const cr = ratio(dark[tone], base);
    ok(cr >= 4.5, `dark ${tone} on ${name}: ${r2(cr)}:1 (AA) — the light-mode mid-tones sat at 2.1–3.6:1 here`);
  }
}
const darkOnPrimary = ratio(dark.onPrimary, dark.primary);
const lightOnPrimary = ratio(light.onPrimary, light.primary);
ok(darkOnPrimary >= 4.5, `dark primary-button ink on its fill: ${r2(darkOnPrimary)}:1 (AA)`);
ok(darkOnPrimary > lightOnPrimary,
  `dark primary button (${r2(darkOnPrimary)}:1) is a contrast IMPROVEMENT on light (${r2(lightOnPrimary)}:1, pre-existing, unchanged)`);
ok(dark.onPrimary === dark.base,
  'dark primary-button ink is the brand deep navy (#071628), not white — 2.77:1 white would fail AA');
for (const k of ['border', 'borderSoft', 'divider']) {
  const cr = ratio(over(dark[k], dark.surface), dark.surface);
  ok(cr >= 1.15, `dark ${k} is visible against a card: ${r2(cr)}:1`);
}

/* ══ 6. the shared components consume the ladder ═════════════════════════ */
section('6. shared-component wiring');
const CASES = [
  ['src/lib/neu.ts', /backgroundColor: c\.surface/, 'neuFlatStyle (every NeuCard/panel) paints the card rung'],
  ['src/components/ChangePasswordModal.tsx', /isDark \? c\.textMuted/, 'change-password modal uses the shared muted tier on dark (was a hardcoded hue)'],
  ['src/components/NeuInputRow.tsx', /backgroundColor: c\.inputSurface/, 'NeuInputRow uses the recessed input rung'],
  ['src/components/NeuInputRow.tsx', /placeholderTextColor=\{isDark \? c\.textSubtle/, 'input placeholders use a readable tier on dark'],
  ['src/components/NeuButton.tsx', /variant === 'primary' \? c\.primary : variant === 'danger' \? '#DC2626' : c\.inputSurface/, 'secondary buttons use a recessed fill; danger keeps its deep fill for white ink'],
  ['src/components/navigation/RoleTabShell.tsx', /backgroundColor: c\.navSurface/, 'Android/web tab bar uses the navigation rung'],
  ['src/components/navigation/RoleTabShell.tsx', /inactiveTintColor=\{`\$\{c\.text\}\$\{isDark \? '99' : '44'\}`\}/, 'tab labels are readable (not 26% alpha) on dark'],
  ['src/components/DrawerNav.tsx', /backgroundColor: c\.navSurface/, 'drawer panel uses the navigation rung'],
  ['src/components/DrawerNav.tsx', /isDark \? '2B' : '1F'/, 'active nav item gets a stronger brand tint on dark'],
  ['src/components/DrawerNav.tsx', /c\.surface/, 'drawer profile section is a raised card on dark'],
  ['src/components/DrawerNav.tsx', /const danger = c\.danger/, 'logout row uses the theme danger token (3.4:1 → 6.1:1)'],
  ['src/components/ResponsiveModal.tsx', /backgroundColor: c\.elevated/, 'all modals use the elevated rung'],
  ['src/components/Toast.tsx', /backgroundColor: c\.elevated/, 'toasts use the elevated rung'],
  ['src/components/ConfirmDialog.tsx', /backgroundColor: c\.elevated/, 'confirm dialog uses the elevated rung'],
  ['src/components/SubscribeSheet.tsx', /backgroundColor: c\.elevated/, 'subscribe sheet uses the elevated rung'],
  ['src/components/ActionMenu.tsx', /DARK_ACTION_INK/, 'action menu resolves dark ink partners instead of pasting light mids'],
  ['src/components/PortalOverlay.tsx', /isDark \? neuColors\.dark\.overlay : '#00000066'/, 'overlay scrim deepens on dark'],
  ['src/components/EmptyState.tsx', /mutedTextStyle\(c, /, 'empty-state description uses the muted helper'],
  ['src/components/ScreenState.tsx', /isDark \? c\.danger : '#DC2626'/, 'error state icon uses the theme danger token'],
  ['src/components/DashboardHeader.tsx', /mutedTextStyle\(c, /, 'dashboard header role label uses the muted helper'],
];
for (const [file, re, label] of CASES) {
  const src = read(file);
  ok(re.test(src), label);
}

/* ══ 7. the opaque `(c as any).text` cast is gone from the modal ═════════ */
section('7. cleanup');
ok(!/\(c as any\)\.text/.test(read('src/components/ResponsiveModal.tsx')),
  'ResponsiveModal no longer routes text through an `as any` cast');
ok(/void isDark|isDark \? \{ borderWidth: 1/.test(read('src/components/ResponsiveModal.tsx')),
  'ResponsiveModal still applies its dark-only hairline edge');

/* ══ 8. completeness — the old idiom must not creep back ════════════════ */
section('8. muted-text idiom sweep (completeness)');
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full, out); }
    else if (e.isFile() && full.endsWith('.tsx')) out.push(full);
  }
  return out;
};
const IDIOM = /color:\s*c\.text,\s*opacity:\s*(0\.\d+)/g;
const inRange = [];
let helperSites = 0;
for (const file of walk(path.join(ROOT, 'src'))) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(IDIOM)) {
    const v = Number(m[1]);
    if (v >= 0.25 && v <= 0.68) inRange.push(`${path.relative(ROOT, file)} (${v})`);
  }
  helperSites += [...src.matchAll(/mutedTextStyle\(c, /g)].length;
}
ok(inRange.length === 0,
  `no \`color: c.text, opacity: 0.25–0.68\` site survives anywhere in src (found ${inRange.length})`);
// The floor tracks the shipped source size; it dropped when the three earnings
// screens (~120 call sites) were retired. The sweep above is the real assertion —
// this only has to be high enough that a wholesale revert would trip it.
ok(helperSites >= 700,
  `${helperSites} call sites now route muted text through the theme-aware helper`);

/* ══ summary ═════════════════════════════════════════════════════════════ */
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
