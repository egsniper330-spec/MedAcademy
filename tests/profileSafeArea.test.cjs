#!/usr/bin/env node
'use strict';
/**
 * profileSafeArea.test.cjs — locks the iOS profile-screen safe-area contract.
 *
 * THE BUGS THIS GUARDS
 * ────────────────────
 * 1. TOP CLIPPING. The student profile renders its avatar hero INSIDE the
 *    scrolling content and has no PageHeader/DashboardHeader above it — those
 *    are what normally apply `safeTop(insets.top)` and put a screen on the
 *    app-wide header grid. It used `padding: layout.screenPx` (~20dp) instead,
 *    so on a notched / Dynamic-Island iPhone (insets.top ≈ 47–62) the avatar
 *    row started UNDER the status bar and the top of the circle was hidden.
 *    The doctor profile was already fixed (`layout.headerTop` on a non-scrolling
 *    hero header) — hence "only on iPhone" and only on the student screen.
 *
 * 2. BOTTOM CLIPPING. Every iOS role screen puts scroll padding on with
 *    `safeBottom(layout.insets.bottom)`. That helper knows only the WINDOW's
 *    home-indicator inset, and on iOS the role tab bar is the REAL native bar
 *    (react-native-bottom-tabs → UITabBar / SwiftUI TabView, a floating Liquid
 *    Glass capsule on iOS 26) laid out by UIKit OUTSIDE the React Native view
 *    hierarchy: the RN screen keeps the full window height and the bar floats
 *    over its bottom edge. Its own height is therefore never reserved, so the
 *    tail of the profile sat under the bar and the scrollable extent excluded
 *    the obscured strip (rubber-band in, snap back — bounce, not scroll).
 *    The correct value already existed — useLayout().scrollBottom(), which is
 *    safeBottom(insets.bottom, tabBarClearance) — but no screen called it.
 *
 * The fix routes both profile scroll containers through `layout.scrollBottom()`
 * and the student hero through `layout.headerTop`. The invariants that must
 * hold from now on:
 *   • the composition is additive, never duplicative (scrollBottom = inset +
 *     bar clearance, applied ONCE — no `padding` shorthand also painting a
 *     bottom, and RN's contentInsetAdjustmentBehavior default is 'never');
 *   • the clearance is 0 on Android/web, so those layouts are untouched;
 *   • the iOS values are UIKit's own constants, not arbitrary padding.
 *
 * Source-level only. No build, no device.
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

const student   = read('src/app/(app)/(student)/profile.tsx');
const doctor    = read('src/app/(app)/(doctor)/dr-profile.tsx');
const ds        = read('src/lib/ds.ts');
const iosClear  = read('src/lib/tabBarClearance.ios.ts');
const andClear  = read('src/lib/tabBarClearance.ts');

/* ── 1. Student profile: hero clears the unsafe TOP region ─────────────── */
section('1. student profile — top safe area');
{
  // The hero is inside the scroll content, so the screen (not a header) owns
  // the top inset. headerTop === safeTop(insets.top).
  ok(/paddingTop:\s*layout\.headerTop/.test(student),
    '1a: the hero View reserves the safe TOP inset via layout.headerTop');
  ok(/<View style=\{\{\s*paddingHorizontal:\s*layout\.screenPx,\s*paddingTop:\s*layout\.headerTop/.test(student),
    '1b: it uses paddingHorizontal + paddingTop (no all-sides shorthand)');
  // Regression: the exact old shape must be gone.
  ok(!/<View style=\{\{\s*padding:\s*layout\.screenPx\s*\}\}>\r?\n\s*<PermissionRationaleModal/.test(student),
    '1c: the old `padding: layout.screenPx` container is gone');
  ok(/import\s*\{[^}]*\buseLayout\b[^}]*\}\s*from\s*'@\/lib\/neu'/.test(student),
    '1d: useLayout comes from the shared neu/ds module (one layout hook)');
}

/* ── 2. Both profiles: bottom clearance includes the native bar ─────────── */
section('2. profile bottom clearance (iOS native tab bar)');
{
  ok(/contentContainerStyle=\{\{\s*paddingBottom:\s*layout\.scrollBottom\(\)\s*\}\}/.test(student),
    '2a: student profile scroll content pads with layout.scrollBottom()');
  // The inset-only helper is what the bug looked like.
  ok(!/safeBottom\(layout\.insets\.bottom\)/.test(student),
    '2b: student profile no longer uses the inset-only safeBottom on the scroll body');

  const docScroll = doctor.match(/contentContainerStyle=\{\{\s*paddingHorizontal:\s*layout\.screenPx,\s*paddingTop:\s*layout\.screenPx,\s*paddingBottom:\s*layout\.scrollBottom\(\)\s*\}\}/g) || [];
  ok(docScroll.length === 2,
    `2c: BOTH live doctor-profile tab scroll containers use scrollBottom() (found ${docScroll.length})`);
  ok(/paddingTop:\s*layout\.headerTop/.test(doctor),
    '2d: the doctor hero header still owns the top inset (not regressed)');
  // The earnings feature was removed, so the dead EarningsTab component that
  // used to live in this file is gone too (it must not come back as a second
  // scroll owner that skips scrollBottom()).
  ok(!/function EarningsTab\(/.test(doctor),
    '2e: the retired EarningsTab component is gone from the doctor profile');
}

/* ── 3. The clearance is additive, never duplicative ───────────────────── */
section('3. no double padding');
{
  // scrollBottom() === safeBottom(insets.bottom, extra + barClearance)
  ok(/const scrollBottom = useMemo\(/.test(ds) && /safeBottom\(insets\.bottom,\s*extra\s*\+\s*barClearance\)/.test(ds),
    '3a: scrollBottom() = safeBottom(insets.bottom, extra + barClearance) — one sum, one owner');
  ok(/const pageBottom\s*=\s*safeBottom\(insets\.bottom,\s*barClearance\)/.test(ds),
    '3b: pageBottom uses the same composition');
  // The bar's height must NOT also be inside safeBottom, or the inset would
  // be counted twice.
  ok(/export function safeBottom\(insetsBottom: number, extra = 0\): number \{\s*return Math\.max\(insetsBottom \+ safeArea\.bottomBreathing, safeArea\.bottomMin\) \+ extra;\s*\}/.test(ds),
    '3c: safeBottom() itself stays a pure inset helper (no bar baked in)');
  // RN default is 'never', so the platform is not also insetting.
  ok(!/contentInsetAdjustmentBehavior="automatic"/.test(student) && !/contentInsetAdjustmentBehavior="automatic"/.test(doctor),
    '3d: no scroll view opts into automatic inset adjustment (which would double the manual padding)');
}

/* ── 4. Android / web are provably unchanged ───────────────────────────── */
section('4. Android + web invariance');
{
  ok(/export function tabBarClearance\(_isLandscape = false\): number \{\s*return 0;\s*\}/.test(andClear),
    '4a: the Android/web clearance resolves to exactly 0');
  ok(/tabBarClearance/.test(ds),
    '4b: ds.ts consumes the platform-resolved clearance (so it is 0 off-iOS)');
  ok(/paddingBottom:\s*layout\.scrollBottom\(\)/.test(student),
    '4c: student profile goes through the platform-aware value, not a hardcoded number');
}

/* ── 5. iOS values are UIKit's constants ───────────────────────────────── */
section('5. iOS clearance values');
{
  ok(/TAB_BAR_CLASSIC_PORTRAIT = 49/.test(iosClear) && /TAB_BAR_CLASSIC_LANDSCAPE = 32/.test(iosClear),
    '5a: classic UITabBar 49pt portrait / 32pt compact-height landscape');
  ok(/TAB_BAR_LIQUID_PORTRAIT = 56/.test(iosClear) && /TAB_BAR_LIQUID_LANDSCAPE = 44/.test(iosClear),
    '5b: iOS 26 floating Liquid Glass bar 56pt / 44pt');
  ok(/return isLandscape \? TAB_BAR_LIQUID_LANDSCAPE : TAB_BAR_LIQUID_PORTRAIT;/.test(iosClear),
    '5c: orientation picks the right constant');
  ok(/IOS_MAJOR >= 26/.test(iosClear),
    '5d: Liquid Glass detection is a version gate, not a hardcoded assumption');
  ok(/LIQUID_GLASS_TAB_BAR/.test(iosClear),
    '5e: the gate is exported for consumers/tests');
}

/* ── 6. The reported symptom cannot silently return ────────────────────── */
section('6. symptom-level guards');
{
  // A profile screen whose ONLY top spacing is screenPx is the bug.
  ok(!/padding:\s*layout\.screenPx\s*\}\}>\r?\n\s*<View style=\{\{\s*alignItems:\s*'center',\s*marginTop:\s*12/.test(student),
    '6a: student hero is not preceded by an all-sides screenPx container');
  // The hero's own `marginTop: 12` is a deliberate small visual offset and is
  // preserved (visual design unchanged). What must NOT exist is a SECOND
  // top-inset source, which would double the clearance.
  const headerTopUses = (student.match(/layout\.headerTop/g) || []).length;
  ok(headerTopUses === 1,
    `6b: exactly ONE top-inset source governs the hero (found ${headerTopUses})`);
  ok(!/paddingTop:\s*layout\.insets\.top/.test(student),
    '6b2: the raw window inset is not used as a second top padding source');
  // And the scroll container must actually have a contentContainerStyle.
  ok(/<ScrollView automaticallyAdjustKeyboardInsets=\{[^}]*\}[\s\S]{0,900}?contentContainerStyle=\{\{\s*paddingBottom:\s*layout\.scrollBottom\(\)/.test(student),
    '6c: the student profile ScrollView has real contentContainerStyle padding');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
