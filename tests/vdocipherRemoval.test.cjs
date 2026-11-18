#!/usr/bin/env node
/**
 * VdoCipher removal — repository guard.
 *
 * The retired provider must not be reachable from the app or the API. This suite
 * asserts the REMOVAL (files, imports, routes, dependency, patch) and the parts of
 * the YouTube-only workflow that must survive it.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const p = (...parts) => path.join(ROOT, ...parts);
const read = (...parts) => fs.readFileSync(p(...parts), 'utf8');
const exists = (...parts) => fs.existsSync(p(...parts));

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

console.log('Retired client modules are gone');

for (const file of [
  'src/lib/vdoCipherUpload.ts',
  'src/lib/useVideoUploader.ts',
  'src/lib/videoUploadEngine.ts',
  'src/lib/videoLibraryApi.ts',
  'src/lib/backgroundUploadService.ts',
  'src/lib/nativeUploadBridge.ts',
  'src/lib/vdoPlayerSession.ts',
  'src/lib/uploadQueueStore.ts',
  'src/lib/uploadNotificationStore.ts',
  'src/types/vdocipher-rn-bridge.d.ts',
  'src/components/VideoLibraryPicker.tsx',
  'src/components/VideoUploadQueue.tsx',
  'src/components/VideoReplaceSheet.tsx',
  'src/components/LargeFileWarning.tsx',
  'src/components/VideoThumbnailCard.tsx',
]) {
  check(`deleted: ${file}`, () => assert.ok(!exists(file), `${file} still exists`));
}

check('nothing imports a deleted module', () => {
  const dead = [
    'vdoCipherUpload', 'useVideoUploader', 'videoUploadEngine', 'videoLibraryApi',
    'backgroundUploadService', 'nativeUploadBridge', 'vdoPlayerSession',
    'uploadQueueStore', 'uploadNotificationStore', 'VideoLibraryPicker',
    'VideoUploadQueue', 'VideoReplaceSheet', 'LargeFileWarning', 'VideoThumbnailCard',
  ];
  const walk = (dir) => fs.readdirSync(p(dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return walk(rel);
    return /\.(ts|tsx)$/.test(e.name) ? [rel] : [];
  });
  const hits = [];
  for (const rel of walk('src')) {
    const src = fs.readFileSync(p(rel), 'utf8');
    for (const name of dead) {
      if (new RegExp(`from '[^']*${name}'`).test(src)) hits.push(`${rel} -> ${name}`);
    }
  }
  assert.deepStrictEqual(hits, []);
});

check('the Doctor lesson editor has no upload/queue/library UI left', () => {
  const editor = read('src', 'app', '(app)', 'lesson-editor', '[id].tsx');
  for (const token of [
    'VDOCIPHER_UPLOAD_ENABLED', 'handleUploadVideo', 'enqueueVideoUpload',
    'useUploadQueueStore', 'VideoLibraryPicker', 'VideoReplaceSheet',
    'LargeFileWarning', 'VideoThumbnailCard',
  ]) {
    assert.ok(!editor.includes(token), `${token} is still referenced by the lesson editor`);
  }
  // The YouTube workflow must remain.
  assert.match(editor, /extractYouTubeId\(text\)/);
  assert.match(editor, /setVideoType\('youtube'\)/);
  assert.match(editor, /video_id: videoType === 'youtube' \? \(youtubeVideoId \|\| videoId\) : videoId/);
});

check('app startup registers no upload worker / FAB', () => {
  const layout = read('src', 'app', '(app)', '_layout.tsx');
  assert.ok(!/UploadFAB|VideoUploadQueue/.test(layout));
  const ctx = read('src', 'ctx.tsx');
  assert.ok(!/useUploadQueueStore|setUploadQueueSessionProvider|migrateLegacyQueue/.test(ctx));
});

console.log('\nNo active provider integration survives');

check('the VdoCipher-backed VideoProvider implementation is gone', () => {
  assert.ok(!exists('src/lib/providers/medacademy.ts'));
  const index = read('src/lib/providers/index.ts');
  assert.ok(!/medAcademyProvider|medacademy/.test(index), 'a video provider is still registered');
  assert.ok(!/registerVideoProvider\(|registerVideoLegacy\(/.test(index));
});

check('nothing invokes a retired video function', () => {
  const walk = (dir) => fs.readdirSync(p(dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return walk(rel);
    return /\.(ts|tsx)$/.test(e.name) ? [rel] : [];
  });
  const banned = [
    'vdocipher-otp', 'vdocipher-upload', 'vdocipher-delete', 'video-health-scan',
    'functions.invoke(\'vdocipher', 'offline-authorize',
  ];
  const hits = [];
  for (const rel of walk('src')) {
    const src = fs.readFileSync(p(rel), 'utf8');
    for (const token of banned) if (src.includes(token)) hits.push(`${rel} -> ${token}`);
  }
  assert.deepStrictEqual(hits, []);
});

check('the lesson screen has no offline download / DRM authorize path', () => {
  const lesson = read('src', 'app', '(app)', 'lesson', '[id].tsx');
  for (const token of ['offlineAuthorize', 'offline-authorize', 'downloadLessonVideo', 'VdoPlayerView']) {
    assert.ok(!lesson.includes(token), `${token} is still referenced by the lesson screen`);
  }
});

console.log('\nDependency and patch removed');

check('package.json no longer depends on the native bridge', () => {
  assert.ok(!/"vdocipher-rn-bridge"/.test(read('package.json')));
  assert.ok(!fs.existsSync(p('patches', 'vdocipher-rn-bridge+2.0.1.patch')));
});

console.log('\nNo client call targets a removed route');

check('the PHP endpoint map has no /video/ function routes', () => {
  const php = read('src', 'client', 'php.ts');
  assert.ok(!/'\/(video|video-providers)\//.test(php), 'a /video route is still mapped');
  assert.ok(!/vdocipher-/.test(php));
});

check('the API client has no removed provider calls', () => {
  const api = read('src', 'lib', 'api.ts');
  for (const token of ['vdocipher-otp', 'vdocipher-upload-init', 'vdocipher-delete-video', '/video/vdocipher-status', '/video/chunk']) {
    assert.ok(!api.includes(token), `${token} is still called`);
  }
});

console.log('\nBackend surface removed');

for (const file of [
  'backend/src/Video/VdoCipherService.php',
  'backend/src/Controllers/VideoController.php',
  'backend/src/Services/VideoLibrarySyncService.php',
  'backend/scripts/cron-video-health.php',
]) {
  check(`deleted: ${file}`, () => assert.ok(!exists(file)));
}

check('no /video/* route remains', () => {
  const routes = read('backend', 'routes', 'api.php');
  assert.ok(!/\$router->[a-z]+\('\/video\//.test(routes), 'a /video route is still registered');
});

check('the generic provider-policy control centre is preserved', () => {
  assert.ok(exists('backend/src/Controllers/VideoProviderController.php'));
  const routes = read('backend', 'routes', 'api.php');
  assert.match(routes, /\/video-providers'/);
  assert.match(routes, /^use MedAcademy\\Controllers\\VideoProviderController;$/m);
});

check('no remaining controller imports a deleted class', () => {
  const walk = (dir) => fs.readdirSync(p(dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return walk(rel);
    return e.name.endsWith('.php') ? [rel] : [];
  });
  const hits = [];
  for (const rel of walk('backend/src')) {
    const src = fs.readFileSync(p(rel), 'utf8');
    if (/use MedAcademy\\(Video\\VdoCipherService|Services\\VideoLibrarySyncService|Controllers\\VideoController)/.test(src)) {
      hits.push(rel);
    }
  }
  assert.deepStrictEqual(hits, []);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
