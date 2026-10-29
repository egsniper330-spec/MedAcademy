#!/usr/bin/env node
/**
 * doctorVideoRenameDialog.test.cjs — the video rename dialog must show the
 * CURRENT title, let the user edit it with immediately visible text, and save.
 *
 * REPORTED DEFECTS
 * ────────────────
 *   • the existing name was not properly visible when the dialog opened;
 *   • the text input appeared too small;
 *   • newly typed text could fail to render.
 *
 * ROOT CAUSES (each pinned below)
 * ───────────────────────────────
 *  1. PRESENTATION. The dialog was a raw React Native <Modal>. This repo's
 *     ResponsiveModal documents — and every other form in the app follows —
 *     that RN's Android Modal renders each open/close as a native dialog
 *     WINDOW, and on RN 0.83 + New Architecture + edge-to-edge that window
 *     show/dismiss race produces duplicated / stacked / flickering dialogs.
 *     Repainting over a stale frame is exactly "typed text not rendering".
 *
 *  2. INPUT GEOMETRY. The field was `flex: 1` + `paddingVertical: 0` inside an
 *     AUTO-HEIGHT COLUMN. `flex` is a MAIN-AXIS property: in a column that is
 *     the VERTICAL axis, so the box collapsed to the glyph height and the zero
 *     padding then clipped the text on Android. It now uses the same metrics
 *     as the proven profile / contact / password fields (fontSize 15 +
 *     paddingVertical 12 + the themed recessed surface).
 *
 *  3. VALUE BINDING. It must stay a controlled `value`/`onChangeText` pair
 *     seeded from the row. `defaultValue` would not re-seed when a DIFFERENT
 *     video is opened, so the second rename would show the previous title.
 *
 * WHAT THIS CHECKS
 *   1. ResponsiveModal is used; no raw <Modal> remains for rename.
 *   2. The input is controlled and seeded from the opened asset's title.
 *   3. The input has a real height / font size and no zero vertical padding.
 *   4. Save persists via the API, updates the list IN PLACE (no refetch, no
 *      restart), and reports success; failure reports an error and keeps the
 *      dialog open so the typed text is not lost.
 *   5. Cancel clears the target without calling the API.
 *   6. Pickers re-seed the field for each newly opened video.
 *   7. Keyboard interaction (submit-to-save, select-on-focus) and the dirty
 *      guard are wired.
 *   8. Every string is localized in BOTH locales.
 *
 * Run: node tests/doctorVideoRenameDialog.test.cjs
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const SCREEN = 'src/app/(app)/(doctor)/video-library.tsx';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.error('  ✗ ' + name + (detail ? `  [${detail}]` : ''));
  }
}
function section(name) {
  console.log('\n── ' + name + ' ──');
}
/** Strip comments so prose about the fix cannot satisfy a structural pin. */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const raw = read(SCREEN);
const src = code(raw);

/* ══ 1. Presentation ════════════════════════════════════════════════════ */

section('1. The rename dialog uses the app-wide modal');

check('ResponsiveModal is imported',
  /import \{ ResponsiveModal \} from '@\/components\/ResponsiveModal'/.test(src));
check('the dialog is rendered through ResponsiveModal',
  /<ResponsiveModal[\s\S]*?visible=\{!!renameAsset\}/.test(src));
check('no raw <Modal> wraps the rename form',
  !/<Modal[^>]*visible=\{!!renameAsset\}/.test(src));
check('the modal is titled with a localized string',
  /title=\{t\('videoLibrary\.renameTitle'\)\}/.test(src));

/* ══ 2. The value is controlled and pre-seeded ══════════════════════════ */

section('2. The current name is visible and editable');

check('the input is controlled by renameTitle',
  /value=\{renameTitle\}/.test(src) && /onChangeText=\{setRenameTitle\}/.test(src));
check('it is NOT an uncontrolled defaultValue field',
  !/defaultValue=\{renameTitle\}/.test(src));
check('opening the action seeds the field from the row title',
  /setRenameAsset\(item\); setRenameTitle\(item\.title\)/.test(src));
check('the seeding happens on open, so every video re-seeds (not just the first)',
  (src.match(/setRenameTitle\(item\.title\)/g) || []).length >= 1);

/* ══ 3. Input geometry ═════════════════════════════════════════════════ */

section('3. The field is tall enough to read and type in');

{
  // Pull the TextInput that renders renameTitle.
  const start = src.indexOf('value={renameTitle}');
  const block = start < 0 ? '' : src.slice(start, start + 900);

  check('the input sets a real font size without a full-line zero padding',
    /fontSize:\s*15/.test(block),
    'fontSize missing');
  check('it keeps vertical padding (a zero value clipped the glyphs on Android)',
    /paddingVertical:\s*12/.test(block) && !/paddingVertical:\s*0/.test(block));
  check('it sits on the themed input surface with a rounded radius',
    /backgroundColor: c\.inputSurface/.test(block) && /borderRadius:\s*12/.test(block));
  check('it is not a `flex: 1` child of an auto-height column any more',
    !/flex:\s*1,[\s\S]{0,80}paddingVertical:\s*0/.test(block));
}

/* ══ 4/5. Save and cancel ═══════════════════════════════════════════════ */

section('4. Save persists and refreshes the list without a restart');

{
  const h = src.slice(src.indexOf('const handleRename'), src.indexOf('const statusColor'));

  check('save calls the update API with the trimmed title',
    /updateVideoAsset\(renameAsset\.id, \{ title: renameTitle\.trim\(\) \}\)/.test(h));
  check('it updates the list IN PLACE (no refetch, no app restart)',
    /setAssets\(prev => prev\.map\(a => a\.id === renameAsset\.id \? \{ \.\.\.a, title: renameTitle\.trim\(\) \} : a\)\)/.test(h));
  check('it closes the dialog only after a successful write',
    /await updateVideoAsset[\s\S]{0,200}setRenameAsset\(null\)/.test(h));
  check('an empty title never reaches the API',
    /if \(!renameAsset \|\| !renameTitle\.trim\(\)\) return;/.test(h));
  check('a failure surfaces an error and does not close the dialog',
    /catch[\s\S]{0,160}showToast\(\{ type: 'error'[\s\S]{0,80}videoLibrary\.renameFailed'/.test(h)
    && !/catch[\s\S]{0,160}setRenameAsset\(null\)/.test(h));
  check('the saving flag is always cleared (no stuck spinner)',
    /try \{[\s\S]*?\} catch[\s\S]*?\}\s*setRenameSaving\(false\);/.test(h));

  check('the Cancel control clears the target WITHOUT saving',
    /label=\{t\('common\.cancel'\)\}[\s\S]{0,80}onPress=\{\(\) => setRenameAsset\(null\)\}/.test(src));
  check('Cancel is disabled mid-save so it cannot race the write',
    /t\('common\.cancel'\)[\s\S]{0,200}disabled=\{renameSaving\}/.test(src));
}

/* ══ 6. Keyboard + dirty guard ═════════════════════════════════════════ */

section('5. Keyboard interaction and the unsaved-change guard');

check('the keyboard can submit the rename',
  /returnKeyType="done"/.test(src) && /onSubmitEditing=\{handleRename\}/.test(src));
check('the existing title is selected on focus so typing replaces it',
  /selectTextOnFocus/.test(src));
check('closing with an edited title asks before discarding',
  /isDirty=\{!!renameAsset && renameTitle\.trim\(\) !== \(renameAsset\.title \?\? ''\)\}/.test(src));
check('the save button is disabled while the title is empty',
  /disabled=\{!renameTitle\.trim\(\)\}/.test(src));

/* ══ 7. Localization ═══════════════════════════════════════════════════ */

section('6. Every rename string exists in BOTH locales');

{
  const i18n = read('src/lib/i18n/resources.ts');
  const en = i18n.slice(0, i18n.indexOf('export const ar'));
  const ar = i18n.slice(i18n.indexOf('export const ar'));
  const keys = [
    'videoLibrary.renameTitle',
    'videoLibrary.titlePlaceholder',
    'videoLibrary.rename',
    'videoLibrary.renamed',
    'videoLibrary.renameFailed',
    'common.cancel',
    'common.save',
  ];
  const count = (haystack, key) =>
    (haystack.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length;
  check('all rename strings exist exactly once per locale',
    keys.every((k) => count(en, k) === 1 && count(ar, k) === 1),
    keys.filter((k) => count(en, k) !== 1 || count(ar, k) !== 1).join(','));
  check('the dialog text itself is resolved through t(...)',
    /t\('videoLibrary\.renameTitle'\)/.test(src)
    && /placeholder=\{t\('videoLibrary\.titlePlaceholder'\)\}/.test(src));
}

/* ════════════════════════════════════════════════════════════════════════ */
console.log('\n' + '─'.repeat(60));
if (failed > 0) {
  console.error(`${passed} passed, ${failed} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
