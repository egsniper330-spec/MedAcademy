// https://docs.expo.dev/guides/using-eslint/
// eslint.config.js is a CommonJS module — require/module.exports are valid here.
/* eslint-disable */
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  }
]);
