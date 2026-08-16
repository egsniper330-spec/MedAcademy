/**
 * TextEncoder / TextDecoder polyfill for JSC (iOS).
 *
 * WHY THIS EXISTS
 * ---------------
 * Hermes (Android default) ships TextEncoder/TextDecoder natively.
 * JSC (@react-native-community/javascriptcore, used on iOS in this project)
 * does NOT include these globals.
 * React Native's own setUpXHR.js polyfills XMLHttpRequest, Blob, URL, etc.,
 * but never TextEncoder/TextDecoder.
 *
 * At startup, expo-router's require.context() eagerly calls require() on
 * EVERY route file. Several admin routes statically import
 * src/lib/exportUtils.ts which in turn has `import ExcelJS from 'exceljs'`
 * at module level. The exceljs browser bundle (exceljs.bare.js) executes
 *
 *   const textEncoder = typeof TextEncoder === 'undefined'
 *                         ? null : new TextEncoder('utf-8');
 *
 * at module-evaluation time. Under JSC's New-Architecture (Bridgeless) JSI
 * context the typeof guard on an unregistered global throws
 *   ReferenceError: Can't find variable: TextEncoder
 * rather than returning 'undefined', crashing the entire JS startup and
 * producing a permanent black screen.
 *
 * FIX
 * ---
 * This file is injected via metro.config.js `serializer.polyfillModuleNames`
 * so it runs as a *prepended script* — before InitializeCore, before the app
 * entry, before any route module is required.  It installs TextEncoder and
 * TextDecoder on `global` (the JSC global object) only when they are absent,
 * so Hermes and browser environments are unaffected.
 *
 * PACKAGE: fast-text-encoding@1.0.6 (pure-JS, no native dependencies)
 * fast-text-encoding wraps itself in:
 *   (function(scope) { ... scope.TextEncoder = scope.TextEncoder || v; })(
 *     typeof window !== 'undefined' ? window :
 *     typeof global !== 'undefined' ? global : this);
 * In JSC, `window` is undefined and `global` is the global object, so it
 * installs correctly.
 */

// Side-effect-only import: installs TextEncoder/TextDecoder on `global`.
require('fast-text-encoding');
