#!/usr/bin/env node
/* eslint-env node */
/* global require, __dirname, __filename, process, module */
/**
 * validate-all.js
 *
 * Orchestrator — runs every validation stage in sequence, accumulates results,
 * and produces a unified exit code.
 *
 * Stages (in order):
 *   1. Kotlin template validation    (validate-kotlin-template.js)
 *   2. Swift source validation       (validate-swift-source.js)
 *   3. Full native build validation  (validate-native-build.js)
 *      (covers plugins, ObjC headers, app.json, ProGuard, tsconfig, TS security)
 *
 * The orchestrator exits 0 only if ALL stages pass.
 * It always runs every stage (no short-circuit) so that all errors are reported
 * in a single CI run.
 */

'use strict';

const { spawnSync } = require('child_process');
const path          = require('path');

const SCRIPTS_DIR = __dirname;
const NODE        = process.execPath;

const STAGES = [
  {
    id:     '1/3',
    label:  'Kotlin Template Validation',
    script: path.join(SCRIPTS_DIR, 'validate-kotlin-template.js'),
  },
  {
    id:     '2/3',
    label:  'Swift Source Validation',
    script: path.join(SCRIPTS_DIR, 'validate-swift-source.js'),
  },
  {
    id:     '3/3',
    label:  'Full Native Build Validation (plugins, app.json, ProGuard, TS)',
    script: path.join(SCRIPTS_DIR, 'validate-native-build.js'),
  },
];

function separator(char = '═', width = 67) {
  return char.repeat(width);
}

function main() {
  console.log(separator());
  console.log('  MedAcademy — Native Build Validation Suite');
  console.log(`  ${new Date().toISOString()}`);
  console.log(separator());

  const results = [];

  for (const stage of STAGES) {
    console.log(`\n${separator('─')}`);
    console.log(`  Stage ${stage.id}: ${stage.label}`);
    console.log(separator('─'));

    const result = spawnSync(NODE, [stage.script], {
      stdio: 'inherit',
      env:   process.env,
    });

    const passed = result.status === 0;
    results.push({ ...stage, passed, status: result.status });

    if (result.error) {
      console.error(`  [orchestrator] Failed to spawn stage: ${result.error.message}`);
      results[results.length - 1].passed = false;
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${separator()}`);
  console.log('  VALIDATION SUMMARY');
  console.log(separator());

  let allPassed = true;
  for (const { id, label, passed, status } of results) {
    const icon = passed ? '✅' : '❌';
    console.log(`  ${icon}  Stage ${id}: ${label} (exit ${status})`);
    if (!passed) allPassed = false;
  }

  console.log(separator());
  if (allPassed) {
    console.log('  ✅  ALL STAGES PASSED — build is safe to proceed to packaging');
  } else {
    const failed = results.filter(r => !r.passed).length;
    console.error(`  ❌  ${failed} stage(s) FAILED — fix errors above before packaging`);
  }
  console.log(separator() + '\n');

  process.exit(allPassed ? 0 : 1);
}

main();
