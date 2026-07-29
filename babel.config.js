// Self-contained Babel config for Expo SDK 55 / React Native 0.83
// Inlines all required Babel transforms so no platform-internal packages
// are required. The lucide tree-shaking plugin lives in ./babel-plugins/.

module.exports = {
  presets: [
    [
      'babel-preset-expo',
      {
        // NativeWind v4 requires nativewind as jsxImportSource
        jsxImportSource: 'nativewind',
        // Disable built-in worklets injection — handled manually below
        // so we can control web vs. native variants separately
        worklets: false,
        // Transform import.meta.env → process.env for packages like zustand v5
        // that ship ESM builds containing import.meta.env (e.g. devtools middleware)
        unstable_transformImportMeta: true,
      },
    ],
    // NativeWind v4 Babel preset: enables className prop on RN components
    'nativewind/babel',
  ],
  plugins: [
    // Lucide icon tree-shaking: replaces barrel imports with per-icon imports
    // so Metro only bundles the icons actually used in the app
    [require('./babel-plugins/plugin-lucide-react-native.js'), {}],
    // react-native-worklets: required for react-native-reanimated v4
    // Native and web need different options
    ...(
      // Detect web build via Babel caller (set by Metro when platform=web)
      // At config-evaluation time we can't know yet, so we emit both plugins
      // and let the isWeb/caller check inside worklets handle it.
      // babel-preset-expo already handles platform detection internally.
      [
        [require.resolve('react-native-worklets/plugin'), {}],
      ]
    ),
  ],
};
