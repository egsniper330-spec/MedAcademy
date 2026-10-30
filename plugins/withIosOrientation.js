/**
 * withIosOrientation — allow landscape on iOS.
 *
 * Expo's built-in withOrientation builds UISupportedInterfaceOrientations from
 * the top-level `orientation` key ("portrait" in app.json) and overwrites any
 * landscape entries set under expo.ios.infoPlist. Result: iOS can never rotate,
 * so fullscreen video cannot go landscape.
 *
 * This plugin runs after Expo's orientation mod (it is listed after the core
 * plugins) and adds the landscape orientations back. The rest of the app stays
 * portrait-locked by its own expo-screen-orientation calls; only fullscreen
 * video locks landscape.
 *
 * Idempotent: safe to run on every prebuild.
 */
const path = require('path');

const expoRoot = path.dirname(require.resolve('expo/package.json'));
const { withInfoPlist } = require(
  require.resolve('@expo/config-plugins', { paths: [expoRoot] })
);

const LANDSCAPE_ORIENTATIONS = [
  'UIInterfaceOrientationLandscapeLeft',
  'UIInterfaceOrientationLandscapeRight',
];

const withIosOrientation = (config) =>
  withInfoPlist(config, (cfg) => {
    const current = Array.isArray(cfg.modResults.UISupportedInterfaceOrientations)
      ? cfg.modResults.UISupportedInterfaceOrientations
      : [];
    cfg.modResults.UISupportedInterfaceOrientations = [
      ...new Set([...current, ...LANDSCAPE_ORIENTATIONS]),
    ];
    return cfg;
  });

module.exports = withIosOrientation;
