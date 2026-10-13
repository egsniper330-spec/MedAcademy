// https://docs.expo.dev/guides/using-eslint/
// eslint.config.js is a CommonJS module — require/module.exports are valid here.
/* eslint-disable */
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*", "android/*", "ios/*"],
  },
  // Node-flavored CommonJS tooling: repo scripts, config plugins, and the
  // node-executed static-analysis test suites. These run under plain Node (the
  // suites are invoked as `node tests/x.test.cjs`), so __dirname/process are
  // defined at runtime — without this override eslint's browser/globals set
  // flags them no-undef and the CI lint gate fails on healthy code.
  {      files: [
        "tests/**/*.cjs",
        // Repo scripts are Node CommonJS too: the test runners and the
        // validation/guard scripts are invoked as `node scripts/x.cjs`. They
        // were missing from this list, so `__dirname` was flagged no-undef and
        // `npm run lint` (a CI step) failed on healthy code.
        "scripts/**/*.cjs",
        "scripts/**/*.js",
        "backend/tests/**/*.js",
        "backend/deploy-package/**/*.cjs",
        "plugins/**/*.js",
        "metro-stubs/**/*.js",
        ".freebuff/**/*.cjs",
      ],
    languageOptions: {
      globals: {
        __dirname: "readonly",
        require: "readonly",
        module: "writable",
        exports: "writable",
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        Promise: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        Buffer: "readonly",
        crypto: "readonly",
      },
    },
  },
  // Vendored generated artifact (plugin-lucide-react-native.js is a checked-in
  // 3k-line generated Babel plugin): keep lint meaningful by not policing var
  // usage there.
  {
    files: ["babel-plugins/**/*.js"],
    rules: { "no-var": "off" },
  },
]);
