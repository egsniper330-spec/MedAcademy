#!/usr/bin/env node
// Fails the install when the required vdocipher-rn-bridge patch is not present.
// The Android fullscreen listener MUST return true (SDK stays inside the RN view);
// see patches/vdocipher-rn-bridge+2.0.1.patch.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BRIDGE = path.join(ROOT, 'node_modules', 'vdocipher-rn-bridge');

const checks = [
  {
    file: 'android/src/main/java/com/vdocipher/rnbridge/ReactVdoPlayerUIView.java',
    mustContain: ['MEDACADEMY PATCH (vdocipher-rn-bridge 2.0.1)', 'return true;', 'private final FrameLayout overlayHost;', 'public void addOverlayChild('],
    mustNotMatch: [/fullscreenToggleListener = isFullscreen -> \{[\s\S]*?return false;\s*\};/],
  },
  {
    file: 'android/src/newarch/java/com/vdocipher/rnbridge/ReactVdoPlayerUIViewManager.java',
    mustContain: ['MEDACADEMY PATCH (vdocipher-rn-bridge 2.0.1)', 'public void addView(ReactVdoPlayerUIView parent'],
  },
  {
    file: 'android/src/oldarch/java/com/vdocipher/rnbridge/ReactVdoPlayerUIViewManager.java',
    mustContain: ['MEDACADEMY PATCH (vdocipher-rn-bridge 2.0.1)', 'public void addView(ReactVdoPlayerUIView parent'],
  },
  {
    file: 'ios/RCTVdoPlayerUIView.swift',
    mustContain: ['MEDACADEMY PATCH (vdocipher-rn-bridge 2.0.1)'],
  },
  {
    file: 'ios/AssetList.swift',
    mustContain: ['MEDACADEMY PATCH (vdocipher-rn-bridge 2.0.1)'],
  },
];

const failures = [];
for (const check of checks) {
  const full = path.join(BRIDGE, check.file);
  if (!fs.existsSync(full)) {
    failures.push(`missing file: ${check.file}`);
    continue;
  }
  const text = fs.readFileSync(full, 'utf8');
  for (const needle of check.mustContain || []) {
    if (!text.includes(needle)) failures.push(`${check.file}: missing "${needle}"`);
  }
  for (const re of check.mustNotMatch || []) {
    if (re.test(text)) failures.push(`${check.file}: unpatched listener (returns false) present`);
  }
}

if (failures.length) {
  console.error('[verify-vdocipher-patch] FAILED: vdocipher-rn-bridge patch is not applied.');
  for (const f of failures) console.error('  - ' + f);
  console.error('Run "npx patch-package" and inspect patches/vdocipher-rn-bridge+2.0.1.patch.');
  process.exit(1);
}
console.log('[verify-vdocipher-patch] vdocipher-rn-bridge patch verified.');
