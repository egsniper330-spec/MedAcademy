#!/usr/bin/env node
/* eslint-env node */
/**
 * bundle-plyr-sprite.js — regenerate src/lib/plyr/plyrSprite.ts from the
 * Plyr package that is actually installed.
 *
 * WHY: Plyr's default `iconUrl` points at its own CDN
 * (https://cdn.plyr.io/3.8.4/plyr.svg) and the player fetches it on a cold
 * cache. The native WebView player embeds the sprite instead, so no request
 * leaves the device for the control icons. Bundling it from node_modules keeps
 * the markup byte-identical to the installed version (a hand-copied sprite
 * would silently drift from the bundle if Plyr is upgraded).
 *
 * Usage: node scripts/bundle-plyr-sprite.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const source = path.join(ROOT, 'node_modules', 'plyr', 'dist', 'plyr.svg');
const target = path.join(ROOT, 'src', 'lib', 'plyr', 'plyrSprite.ts');

const version = require(path.join(ROOT, 'node_modules', 'plyr', 'package.json')).version;
const svg = fs.readFileSync(source, 'utf8');

const header = `/**
 * plyrSprite.ts
 *
 * Plyr ${version} icon sprite, bundled LOCALLY for the native WebView player.
 * Source: node_modules/plyr/dist/plyr.svg (verbatim).
 *
 * WHY: Plyr loads its icon sprite from its own CDN default
 *   iconUrl: https://cdn.plyr.io/${version}/plyr.svg
 * by injecting the fetched markup into a hidden element with id "sprite-plyr".
 * Plyr skips that request entirely when an element with that id ALREADY exists
 * (see its loadSprite path: it only injects the fetched markup when no element
 * with that id exists yet), so embedding this sprite in the player document
 * removes the cold-cache request to cdn.plyr.io while keeping every control
 * icon.
 *
 * Do NOT edit manually — regenerate with:
 *   node scripts/bundle-plyr-sprite.js
 */

// Plyr ${version} sprite (${Buffer.byteLength(svg, 'utf8')} bytes)
export const PLYR_SPRITE: string = ${JSON.stringify(svg)};
`;

fs.writeFileSync(target, header, 'utf8');
console.log(`wrote ${path.relative(ROOT, target)} (${Buffer.byteLength(header, 'utf8')} bytes)`);
