// Self-contained Metro config for Expo SDK 55 / React Native 0.83
// Inlines all required Metro customizations so no platform-internal
// packages are required. Compatible with Windows, macOS, and Linux.
// All stub files live in ./metro-stubs/ (copied from devkit dist).
//
// Windows compatibility — root cause and fix:
//
//   metro-config@0.83.3 loadConfigFile() does:
//     1. try { config = await require(absolutePath) }   ← CJS, synchronous
//     2. catch { config = await import(absolutePath) }  ← ESM fallback
//
//   The ESM fallback receives the bare Windows path "D:\games\metro.config.js"
//   and Node's ESM loader rejects it: "Only URLs with a scheme in: file, data,
//   and node are supported. Received protocol 'd:'."
//
//   require() itself succeeds, BUT the config object it returns is evaluated
//   synchronously, and inside that evaluation withNativeWind() calls:
//     tailwindConfig(path.resolve("tailwind.config"))
//       → require("tailwindcss/loadConfig")(path)
//         → jiti(__filename, ...)   ← __filename = D:\...\load-config.js
//           → import("D:\...")      ← ERR_UNSUPPORTED_ESM_URL_SCHEME  ← CRASH
//
//   jiti (used by tailwindcss/loadConfig) calls dynamic import() with a bare
//   Windows path, which crashes. This happens synchronously inside require(),
//   causing require() to throw, which triggers the ESM fallback, which also
//   fails with the same error — producing the "Error loading Metro config" message.
//
//   FIX: Export a FUNCTION instead of a plain object.
//   metro-config@0.83.3 fully supports function exports (loadMetroConfigFromDisk
//   line 203: `if (typeof configModule === "function") await configModule(defaults)`).
//   When Metro calls our function asynchronously, withNativeWind() / tailwindConfig()
//   / jiti's import() all run in an async context where Node handles Windows paths
//   correctly (jiti internally wraps with pathToFileURL before calling import()).
//   The synchronous require() of metro.config.js itself returns a plain function —
//   no jiti, no import(), no crash.

'use strict';

const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

// ─── Stub paths ────────────────────────────────────────────────────────────────
const STUBS = path.join(__dirname, 'metro-stubs');

const EXPO_IMAGE_STUB            = path.join(STUBS, 'expo-image-stub.js');
const EXPO_CAMERA_STUB           = path.join(STUBS, 'expo-camera-stub.js');
const EXPO_CAMERA_RECORD_STUB    = path.join(STUBS, 'expo-camera-record-stub.js');
const EXPO_LINEAR_GRADIENT_STUB  = path.join(STUBS, 'expo-linear-gradient-stub.js');
const EXPO_BLUR_STUB             = path.join(STUBS, 'expo-blur-stub.js');
const EXPO_HAPTICS_STUB          = path.join(STUBS, 'expo-haptics-stub.js');
const EXPO_NOTIFICATIONS_STUB    = path.join(STUBS, 'expo-notifications-stub.js');
const EXPO_MEDIA_LIBRARY_STUB    = path.join(STUBS, 'expo-media-library-stub.js');
const EXPO_CALENDAR_STUB         = path.join(STUBS, 'expo-calendar-stub.js');
const EXPO_FILE_SYSTEM_STUB      = path.join(STUBS, 'expo-file-system-stub.js');
const EXPO_FILE_SYSTEM_NEXT_STUB = path.join(STUBS, 'expo-file-system-next-stub.js');
const EXPO_IMAGE_PICKER_STUB     = path.join(STUBS, 'expo-image-picker-stub.js');

// ─── cssInterop: redirect expo-image / expo-linear-gradient / expo-blur ───────
// These stubs call cssInterop() on the real package so NativeWind className
// works on those components — required for both native and web builds.
function withCssInterop(config) {
  const upstream = config.resolver?.resolveRequest ?? null;
  const resolveRequest = (context, moduleName, platform) => {
    if (
      moduleName === 'expo-image' &&
      !context.originModulePath.includes('expo-image-stub.js')
    ) {
      return { filePath: EXPO_IMAGE_STUB, type: 'sourceFile' };
    }
    if (
      moduleName === 'expo-camera' &&
      !context.originModulePath.includes('expo-camera-stub.js') &&
      !context.originModulePath.includes('expo-camera-record-stub.js')
    ) {
      return { filePath: EXPO_CAMERA_STUB, type: 'sourceFile' };
    }
    if (
      moduleName === 'expo-linear-gradient' &&
      !context.originModulePath.includes('expo-linear-gradient-stub.js')
    ) {
      return { filePath: EXPO_LINEAR_GRADIENT_STUB, type: 'sourceFile' };
    }
    if (
      moduleName === 'expo-blur' &&
      !context.originModulePath.includes('expo-blur-stub.js')
    ) {
      return { filePath: EXPO_BLUR_STUB, type: 'sourceFile' };
    }
    if (upstream) return upstream(context, moduleName, platform);
    return context.resolveRequest(context, moduleName, platform);
  };
  return { ...config, resolver: { ...config.resolver, resolveRequest } };
}

// ─── Platform stubs: no-op replacements for native-only modules on web ────────
function withPlatformStubs(config) {
  const upstream = config.resolver?.resolveRequest ?? null;
  const resolveRequest = (context, moduleName, platform) => {
    if (
      (platform === 'android' || platform === 'web') &&
      moduleName === 'expo-notifications' &&
      !context.originModulePath.includes('expo-notifications-stub.js')
    ) {
      return { filePath: EXPO_NOTIFICATIONS_STUB, type: 'sourceFile' };
    }
    if (
      moduleName === 'expo-media-library' &&
      !context.originModulePath.includes('expo-media-library-stub.js')
    ) {
      return { filePath: EXPO_MEDIA_LIBRARY_STUB, type: 'sourceFile' };
    }
    if (
      moduleName === 'expo-calendar' &&
      !context.originModulePath.includes('expo-calendar-stub.js')
    ) {
      return { filePath: EXPO_CALENDAR_STUB, type: 'sourceFile' };
    }
    if (
      moduleName === 'expo-file-system/legacy' &&
      !context.originModulePath.includes('expo-file-system-stub.js')
    ) {
      return { filePath: EXPO_FILE_SYSTEM_STUB, type: 'sourceFile' };
    }
    if (
      moduleName === 'expo-file-system' &&
      !context.originModulePath.includes('expo-file-system-next-stub.js')
    ) {
      return { filePath: EXPO_FILE_SYSTEM_NEXT_STUB, type: 'sourceFile' };
    }
    if (
      platform === 'web' &&
      moduleName === 'expo-image-picker' &&
      !context.originModulePath.includes('expo-image-picker-stub.js')
    ) {
      return { filePath: EXPO_IMAGE_PICKER_STUB, type: 'sourceFile' };
    }
    if (
      platform === 'web' &&
      moduleName === 'expo-haptics' &&
      !context.originModulePath.includes('expo-haptics-stub.js')
    ) {
      return { filePath: EXPO_HAPTICS_STUB, type: 'sourceFile' };
    }
    if (
      platform === 'web' &&
      moduleName === 'expo-camera' &&
      !context.originModulePath.includes('expo-camera-record-stub.js') &&
      !context.originModulePath.includes('expo-camera-stub.js')
    ) {
      return { filePath: EXPO_CAMERA_RECORD_STUB, type: 'sourceFile' };
    }
    if (upstream) return upstream(context, moduleName, platform);
    return context.resolveRequest(context, moduleName, platform);
  };
  return { ...config, resolver: { ...config.resolver, resolveRequest } };
}

// ─── Lucide tree-shaking: resolve lucide-react-native/dist/* imports ──────────
const fs = require('fs');
let _lucidePkgRoot = null;
function getLucidePkgRoot() {
  if (_lucidePkgRoot) return _lucidePkgRoot;
  let dir = path.dirname(require.resolve('lucide-react-native'));
  while (true) {
    const pkgJson = path.join(dir, 'package.json');
    if (fs.existsSync(pkgJson)) {
      const { name } = require(pkgJson);
      if (name === 'lucide-react-native') { _lucidePkgRoot = dir; return dir; }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Cannot locate lucide-react-native package root');
    dir = parent;
  }
}
const esmExtCache = new Map();
function getEsmExt(pkgRoot) {
  const cached = esmExtCache.get(pkgRoot);
  if (cached) return cached;
  const esmIconsDir = path.join(pkgRoot, 'dist/esm/icons');
  const ext =
    fs.existsSync(esmIconsDir) &&
    fs.readdirSync(esmIconsDir).some((f) => f.endsWith('.mjs'))
      ? '.mjs'
      : '.js';
  esmExtCache.set(pkgRoot, ext);
  return ext;
}
function withLucideResolver(config) {
  const LUCIDE_DIST_PREFIX = 'lucide-react-native/dist/';
  const upstream = config.resolver?.resolveRequest ?? null;
  const pkgRoot = getLucidePkgRoot();
  const resolveRequest = (context, moduleName, platform) => {
    if (moduleName.startsWith(LUCIDE_DIST_PREFIX)) {
      const subpath = moduleName.slice('lucide-react-native'.length + 1);
      const ext = subpath.startsWith('dist/esm/') ? getEsmExt(pkgRoot) : '.js';
      const filePath = path.join(pkgRoot, subpath + ext);
      return { filePath, type: 'sourceFile' };
    }
    if (upstream) return upstream(context, moduleName, platform);
    return context.resolveRequest(context, moduleName, platform);
  };
  return { ...config, resolver: { ...config.resolver, resolveRequest } };
}

// ─── WASM asset support ────────────────────────────────────────────────────────
function withWasmSupport(config) {
  const existing = config.resolver?.assetExts ?? [];
  if (existing.includes('wasm')) return config;
  return {
    ...config,
    resolver: { ...config.resolver, assetExts: [...existing, 'wasm'] },
  };
}

// ─── esbuild minifier — skipped: metro-minify-esbuild is not a direct dep.
// Metro's built-in Terser minifier is used for release builds instead.
// To opt in later: add metro-minify-esbuild to package.json and uncomment.
// function withEsbuildMinify(config) { ... }

// ─── Assemble ──────────────────────────────────────────────────────────────────
// Export a FUNCTION — Metro calls it asynchronously, so withNativeWind() and
// its tailwindConfig() / jiti / dynamic import() all run async. This avoids
// jiti's synchronous import("D:\...") crash during require() on Windows.
module.exports = async function (metroDefaults) {
  let config = getDefaultConfig(__dirname);

  config = withCssInterop(config);
  config = withPlatformStubs(config);
  config = withLucideResolver(config);
  config = withWasmSupport(config);

  // NativeWind: processes global.css and inlines Tailwind at build time.
  // Called inside the async function so tailwindConfig() / jiti run async —
  // no synchronous import("D:\...") crash on Windows.
  //
  // disableTypeScriptGeneration: true — skip nativewind-env.d.ts rewrite which
  // opens a file handle synchronously and can cause permission errors on Windows.
  //
  // input uses path.resolve() so the absolute path is passed to the tailwind
  // child process via NATIVEWIND_INPUT env var — prevents relative-path
  // resolution failures when fork()'s cwd differs from project root on Windows.
  config = withNativeWind(config, {
    input: path.resolve(__dirname, 'src/global.css'),
    inlineRem: 16,
    disableTypeScriptGeneration: true,
  });

  // Re-resolve transformerPath through project-level node_modules so Metro's
  // require(transformerPath) uses a short, Windows-safe path (pnpm creates a
  // real directory copy at node_modules/react-native-css-interop on Windows).
  if (config.transformerPath) {
    const projectTransformerPath = path.join(
      __dirname,
      'node_modules',
      'react-native-css-interop',
      'dist',
      'metro',
      'transformer.js'
    );
    if (require('fs').existsSync(projectTransformerPath)) {
      config = { ...config, transformerPath: projectTransformerPath };
    }
  }

  return config;
};
