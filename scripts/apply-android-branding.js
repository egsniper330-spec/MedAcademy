#!/usr/bin/env node
/* global __dirname */
'use strict';
/**
 * apply-android-branding.js — regenerate the Android brand resources in an
 * ALREADY-PREBUILT `android/` tree.
 *
 *     node scripts/apply-android-branding.js
 *
 * WHY BOTH THIS AND A CONFIG PLUGIN
 *   plugins/withAndroidBranding.js is the durable fix: it re-applies the
 *   resources after every `expo prebuild`, so nothing can be lost to
 *   `prebuild --clean`. This CLI applies the identical logic to the checkout
 *   that already exists — the APK shipped to the phone was built with
 *   `gradlew assembleRelease`, which does not run prebuild, so without this
 *   step the stale mipmaps and splash would still be compiled.
 *
 * Both paths call the same single implementation, so they can never disagree.
 * Idempotent: re-running writes nothing when the bytes already match.
 */

const path = require('path');
const fs = require('fs');

const { writeAndroidBrandResources } = require('./brand/android-brand-resources');

const ROOT = path.join(__dirname, '..');
const RES_DIR = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');

function main() {
  if (!fs.existsSync(RES_DIR)) {
    console.error('no android/app/src/main/res at ' + RES_DIR + ' — run `npx expo prebuild` first');
    process.exitCode = 1;
    return;
  }
  const { written, removed } = writeAndroidBrandResources(RES_DIR, {
    log: (msg) => console.log('  ' + msg),
  });
  console.log('\nandroid brand resources: ' + written.length + ' written, ' + removed.length + ' stale removed');
  console.log('res dir: ' + path.relative(ROOT, RES_DIR));
  if (!written.length && !removed.length) console.log('(already up to date — nothing to do)');
}

if (require.main === module) main();

module.exports = { main, RES_DIR };
