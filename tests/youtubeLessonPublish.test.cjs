#!/usr/bin/env node
/**
 * Regression: a lesson with a saved YouTube video must pass the course-builder's
 * publish validation.
 *
 * The builder used to read `youtube_video_id` — a field that does not exist —
 * while the editor and the API store the reference in `video_id`. Every YouTube
 * lesson therefore looked empty and publishing was refused.
 *
 * This loads the REAL module (transpiled from TS) and asserts the behaviour,
 * not the source text.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'publishValidation.ts'), 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const tmp = path.join(os.tmpdir(), `publishValidation-${process.pid}.cjs`);
fs.writeFileSync(tmp, js);
const { lessonHasVideo, lessonVideoType, isYoutubeReference } = require(tmp);
fs.unlinkSync(tmp);

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    console.error(`  \u2717 ${name}\n    ${error.message}`);
    process.exitCode = 1;
  }
};

console.log('YouTube lessons are recognised');

check('a YouTube lesson whose id lives in video_id counts as having video', () => {
  assert.strictEqual(lessonHasVideo({ video_type: 'youtube', video_id: 'dQw4w9WgXcQ' }), true);
});

check('a YouTube lesson saved as a full URL counts as having video', () => {
  assert.strictEqual(
    lessonHasVideo({ video_type: 'youtube', video_id: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
    true,
  );
});

check('the legacy youtube_video_id field is still honoured', () => {
  assert.strictEqual(lessonHasVideo({ video_type: 'youtube', youtube_video_id: 'dQw4w9WgXcQ' }), true);
});

check('a legacy row with no video_type but a YouTube id is treated as YouTube', () => {
  assert.strictEqual(lessonVideoType({ video_id: 'dQw4w9WgXcQ' }), 'youtube');
  assert.strictEqual(lessonHasVideo({ video_id: 'dQw4w9WgXcQ' }), true);
});

console.log('\nValidation is not weakened');

check('an empty YouTube lesson still fails', () => {
  assert.strictEqual(lessonHasVideo({ video_type: 'youtube', video_id: '   ' }), false);
  assert.strictEqual(lessonHasVideo({ video_type: 'youtube' }), false);
});

check('a lesson with no content at all still fails', () => {
  assert.strictEqual(lessonHasVideo({ video_type: 'vdocipher' }), false);
  assert.strictEqual(lessonHasVideo(null), false);
});

check('"coming soon" is an explicit, allowed state', () => {
  assert.strictEqual(lessonHasVideo({ video_type: 'coming_soon' }), true);
});

check('legacy uploaded rows are still accepted', () => {
  assert.strictEqual(lessonHasVideo({ video_type: 'vdocipher', video_status: 'ready' }), true);
  assert.strictEqual(lessonHasVideo({ video_type: 'vdocipher', video_upload_id: 'u1' }), true);
});

check('YouTube references are shape-checked', () => {
  assert.strictEqual(isYoutubeReference('dQw4w9WgXcQ'), true);
  assert.strictEqual(isYoutubeReference('https://youtu.be/dQw4w9WgXcQ'), true);
  assert.strictEqual(isYoutubeReference('not a video'), false);
});

console.log('\nThe builder uses the shared rule');

check('both publish checks call lessonHasVideo (no youtube_video_id-only test)', () => {
  const builder = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'app', '(app)', 'course-builder', '[id].tsx'),
    'utf8',
  );
  assert.match(builder, /import \{ lessonHasVideo \} from '@\/lib\/publishValidation';/);
  assert.strictEqual((builder.match(/if \(!lessonHasVideo\(l\)\)/g) || []).length, 2);
  assert.ok(!/l\.youtube_video_id\?\.trim\(\)/.test(builder), 'the phantom field is no longer trusted alone');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
