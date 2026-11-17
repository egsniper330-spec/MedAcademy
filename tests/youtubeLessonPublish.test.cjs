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

console.log('\nThe declared type never overrides a real YouTube reference');

check('a YouTube reference in youtube_video_id wins over a stale video_type', () => {
  // The exact build-230 report: the lesson was created with the retired default
  // type, then given a YouTube URL. The reference was saved, the declared type
  // was not, and publishing refused the lesson as "no video".
  assert.strictEqual(lessonHasVideo({ video_type: 'vdocipher', youtube_video_id: 'dQw4w9WgXcQ' }), true);
  assert.strictEqual(lessonVideoType({ video_type: 'vdocipher', youtube_video_id: 'dQw4w9WgXcQ' }), 'youtube');
});

check('a YouTube URL stored in video_id wins over a stale video_type', () => {
  assert.strictEqual(
    lessonHasVideo({ video_type: '', video_id: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
    true,
  );
});

check('an empty lesson with a stale type still fails (no weakening)', () => {
  assert.strictEqual(lessonHasVideo({ video_type: 'vdocipher', video_id: '', youtube_video_id: '' }), false);
  assert.strictEqual(lessonHasVideo({ video_type: 'youtube', video_id: 'not a video' }), false);
});

check('every supported YouTube URL shape is accepted', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://m.youtube.com/watch?app=desktop&v=dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
  ]) {
    assert.strictEqual(lessonHasVideo({ video_type: 'youtube', video_id: url }), true, url);
  }
});

console.log('\nThe editor writes BOTH columns (the reference cannot be lost again)');

check('the save payload mirrors the YouTube id into video_id', () => {
  const editor = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'app', '(app)', 'lesson-editor', '[id].tsx'),
    'utf8',
  );
  const mirrors = editor.match(/video_id: videoType === 'youtube' \? \(youtubeVideoId \|\| videoId\) : videoId/g) || [];
  assert.ok(mirrors.length >= 2, `expected the explicit save and the auto-save to mirror it, found ${mirrors.length}`);
  // Entering a URL also selects the YouTube type, so a stale type cannot win.
  assert.match(editor, /setYoutubeVideoId\(extracted\)[\s\S]{0,400}setVideoType\('youtube'\)/);
  // Reopening reads the reference from either column.
  assert.match(editor, /isYoutubeReference\(data\.video_id\)/);
});

console.log('\nEmpty sections are allowed');

check('the builder no longer rejects a section with no lessons', () => {
  const builder = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'app', '(app)', 'course-builder', '[id].tsx'),
    'utf8',
  );
  assert.ok(
    !/issue\.sectionNoLessons/.test(builder),
    'an empty section must not contribute a publish blocker',
  );
  // The other requirements are untouched.
  assert.match(builder, /issue\.sectionRequired/);
  assert.match(builder, /issue\.titleRequired|cb\.issue\.titleRequired/);
});

check('the backend publish path imposes no section/lesson count', () => {
  const php = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'src', 'Controllers', 'CourseController.php'),
    'utf8',
  );
  const publish = php.slice(php.indexOf('public function publish('));
  assert.ok(!/sectionNoLessons|COUNT\(\*\) FROM lessons/i.test(publish.slice(0, 6000)));
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
