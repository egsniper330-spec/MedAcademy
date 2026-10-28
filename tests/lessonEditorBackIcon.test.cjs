#!/usr/bin/env node
/**
 * The lesson editor's back control must render a DIRECTIONAL arrow glyph.
 *
 * THE DEFECT THIS GUARDS
 * ──────────────────────
 * The header used to fake the Arabic (RTL) back arrow by rotating a
 * `ChevronDown` with `style={{ transform: [{ rotate: '90deg' }] }}`. react-native-svg
 * puts that transform inside the 20x20 viewport with `overflow: hidden`, so the
 * glyph was rotated out of the clip box: the button painted as an EMPTY rounded
 * square (measured in the running web preview — the SVG path's rect sat above
 * the SVG's own rect while `elementFromPoint` still hit the SVG). Nothing in the
 * styles or the colour was wrong; the icon simply was not inside its own box.
 *
 * The fix is the app's existing convention (shared `PageHeader`, and
 * `course-builder`'s `BackIcon`): choose the glyph from the app locale instead of
 * rotating an icon, because the layout engine does not mirror Svg icons.
 *
 * These are source assertions: the visual check lives in the manual preview
 * verification described in the task report.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const lesson = read('src/app/(app)/lesson-editor/[id].tsx');
const header = read('src/components/PageHeader.tsx');
const builder = read('src/app/(app)/course-builder/[id].tsx');

const checks = [];
const check = (name, ok) => checks.push([name, !!ok]);

// ── The regression itself ────────────────────────────────────────────────────
check(
  'lesson editor back control selects the arrow glyph by locale',
  /isRTL\s*\?\s*<ArrowRight size=\{20\} color=\{c\.text\} opacity=\{0\.6\} \/>\s*:\s*<ArrowLeft\s+size=\{20\} color=\{c\.text\} opacity=\{0\.6\} \/>/s.test(
    lesson
  )
);

check(
  'lesson editor imports both directional arrows from the icon library',
  /import \{[\s\S]*ArrowLeft[\s\S]*ArrowRight[\s\S]*\} from 'lucide-react-native'/.test(lesson)
);

// The concrete defect: an icon rotated by style so it leaves its own 20x20
// viewport and is clipped away. No direction should ever be expressed that way.
check(
  'no Svg icon in the lesson editor is rotated to fake a direction glyph',
  !/transform:\s*\[\{\s*rotate/.test(lesson) && !/rotate:\s*'(?:-?90|180|270)deg'/.test(lesson)
);

// ── Behaviour and design must be unchanged by the icon fix ───────────────────
check(
  'back control still pops the real navigation stack',
  /onPress=\{\(\) => router\.back\(\)\}/.test(lesson)
);

check(
  'back control keeps its 40x40 rounded-square box',
  /width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center'/.test(lesson)
);

check(
  'back control keeps its 8px hitSlop',
  /<Pressable onPress=\{\(\) => router\.back\(\)\}\s*hitSlop=\{8\}/.test(lesson)
);

// ── Shared convention: the bug was NOT in these, keep it that way ────────────
check(
  'shared PageHeader picks the arrow glyph by locale without rotating it',
  /isRTL\s*\?\s*<ArrowRight size=\{iconSize\.lg\}/.test(header) &&
    /:\s*<ArrowLeft\s+size=\{iconSize\.lg\}/.test(header) &&
    !/transform:\s*\[\{\s*rotate/.test(header)
);

check(
  'course builder back icon stays direction-aware without rotation',
  /const BackIcon = isRTL \? ArrowRight : ArrowLeft;/.test(builder) &&
    !/transform:\s*\[\{\s*rotate/.test(builder)
);

for (const [name, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`);
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length} passed; ${failed.length} failed`);
if (failed.length) process.exit(1);
