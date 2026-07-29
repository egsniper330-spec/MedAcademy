# Native Build Validation Pipeline

**Version:** 1.0 — MedAcademy v428+
**Last updated:** 2026-07-13
**Scope:** All pull requests targeting `main` and `release/*`; all EAS release builds.

---

## Overview

The Native Build Validation Pipeline is a multi-stage automated system that catches native compile errors **before** APK/IPA packaging begins. It was designed after the v428 packaging failure, where two unreplaced identifiers in Kotlin/Swift template code caused silent packaging rollbacks that were impossible to diagnose without examining generated source files directly.

The pipeline has two execution modes:

| Mode | When | Speed |
|------|------|-------|
| **Local** (`pnpm run validate`) | Developer runs before pushing | ~5 seconds |
| **CI** (GitHub Actions) | Every PR + every push to main | ~10–25 minutes |

---

## Problem Statement

Expo config plugins generate native source files (`.kt`, `.swift`, `.m`) at **prebuild time** by writing template strings from JavaScript plugin files. If a template string contains an unreplaced placeholder (e.g. `__DEV_PLACEHOLDER__`) or a missing declaration (e.g. a Swift stored property referenced in method bodies but never declared), the error is invisible until the native compiler runs — which happens late in the EAS build queue, typically 10–20 minutes into a build.

The validation pipeline moves this detection to the earliest possible point: before any code leaves the developer's machine.

### Root Causes Caught by This Pipeline

| Incident | Root Cause | Detection Stage |
|----------|-----------|----------------|
| v428 Android failure | `__DEV_PLACEHOLDER__` literal in Kotlin template | K2 (placeholder scan) |
| v428 iOS failure | `baselineIMPs` stored property used but not declared | S2 (property declaration check) |

---

## Pipeline Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  LOCAL (pnpm run validate)  — runs in ~5s, no toolchain needed  │
│                                                                 │
│  Stage 1: Kotlin Template Validation (validate-kotlin-template) │
│  Stage 2: Swift Source Validation    (validate-swift-source)    │
│  Stage 3: Full Native Build Check    (validate-native-build)    │
│     ├─ Plugin module loads                                      │
│     ├─ ObjC bridging header structure                           │
│     ├─ app.json schema (ATS, Privacy Manifest, App Attest)      │
│     ├─ ProGuard rules correctness                               │
│     ├─ tsconfig.json validity                                   │
│     └─ TypeScript security source guards                        │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│  CI (GitHub Actions) — runs on every PR and push to main        │
│                                                                 │
│  Job 1: static-validation (Ubuntu, ~30s)                        │
│     ├─ All three local validator scripts                        │
│     ├─ TypeScript type-check (tsc --noEmit)                     │
│     └─ ESLint (pnpm run lint)                                   │
│                                                                 │
│  Job 2: android-prebuild (Ubuntu, ~10min)                       │
│     ├─ expo prebuild --platform android --clean                 │
│     ├─ SecurityModule.kt / SecurityPackage.kt existence         │
│     ├─ Generated file placeholder scan (grep)                   │
│     ├─ Package declaration on line 1                            │
│     └─ SecurityPackage registered in MainApplication            │
│                                                                 │
│  Job 3: ios-prebuild (macOS, ~15min)                            │
│     ├─ expo prebuild --platform ios --clean                     │
│     ├─ IOSSecurityModule.swift / .m existence                   │
│     ├─ Generated file placeholder scan (grep)                   │
│     ├─ arc4random() absence check                               │
│     ├─ swiftc -parse (syntax-only compile, no SDK needed)       │
│     └─ RCT_EXTERN_MODULE present in .m                          │
│                                                                 │
│  Job 4: kotlin-compile (Ubuntu, ~10min)                         │
│     ├─ Download generated Android sources artifact              │
│     ├─ Install kotlinc standalone                               │
│     └─ Compile SecurityPackage.kt with stub interfaces          │
│                                                                 │
│  Job 5: validation-gate (required status check)                 │
│     └─ Aggregates all job results; blocks merge if any failed   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Validation Checks Reference

### Stage 1 — Kotlin Template Validation (`validate-kotlin-template.js`)

Extracts every `*_KT` template literal from `plugins/withSecurityModule.js` and validates its content before it is ever written to disk.

| Check ID | What It Validates | Failure Means |
|----------|-------------------|---------------|
| K1 | Package declaration on first non-blank line | Kotlin file is invalid — compiler rejects it |
| K2 | No `__FOO__`, `PLACEHOLDER_*`, `TODO_REPLACE` tokens | Template was not fully substituted before write |
| K3 | Debug guards use `BuildConfig.DEBUG` not raw identifiers | Unresolved identifier at compile time |
| K4 | Every `@ReactMethod` annotation is followed by a `fun` declaration | Method is registered but has no implementation |
| K5 | `getName()` returns a non-empty string | Module cannot be addressed from JavaScript |
| K6 | `runSafe()` is defined if it is called | Unresolved reference at compile time |
| K8 | No empty `catch` blocks | Silent exception swallowing |
| K9 | No JavaScript-only syntax (`const`, `=>`, `===`, `function()`) | Template string leaked JS code into Kotlin source |
| K10 | Class extends `ReactContextBaseJavaModule` or implements `ReactPackage` | Module will not integrate with RN bridge |

### Stage 2 — Swift Source Validation (`validate-swift-source.js`)

Validates `plugins/ios/IOSSecurityModule.swift` and cross-checks it against its ObjC bridging header.

| Check ID | What It Validates | Failure Means |
|----------|-------------------|---------------|
| S1 | No unreplaced placeholder tokens | Template left in an invalid state |
| S2 | All critical stored properties declared (`baselineIMPs`, `hasListeners`, `jailbreakCacheResult`, etc.) | `use of unresolved identifier` at compile time |
| S3 | No `arc4random()` | Non-cryptographic RNG in security-critical path |
| S4 | All `@objc()` annotations have matching `func` declarations | Method exported to ObjC runtime with no implementation |
| S5 | `#available(iOS X.Y)` guards use valid version numbers (≥14.0) | API unavailable on supported OS range |
| S6 | No force-unwrap (`!.`) on security values | Runtime crash on nil |
| S7 | Every `EVENT_*` constant appears in `supportedEvents()` | Event emitted but JS listener never receives it |
| S8 | `#if DEBUG` / `#endif` blocks are balanced | Compilation error or accidental debug code in release |
| S9 | No bare `print()` outside `#if DEBUG` | Production logs emit sensitive security data |
| S10 | All `import` statements reference known iOS frameworks | Unresolved module import at compile time |
| S11 | Every `RCT_EXTERN_METHOD` in `.m` has a Swift counterpart | Method callable from JS but undefined in Swift |
| S12 | No `try!` (force-try) | Unhandled throw causes app crash |

### Stage 3 — Full Native Build Validation (`validate-native-build.js`)

Validates the complete set of artifacts that feed into the native build.

| Check | Scope | What It Validates |
|-------|-------|-------------------|
| Plugin load | `withSecurityModule.js`, `withProguardRules.js` | `require()` succeeds — no syntax errors in plugin files |
| Kotlin templates | All `*_KT` in withSecurityModule.js | All Stage 1 checks applied as a set |
| Swift source | `plugins/ios/IOSSecurityModule.swift` | All Stage 2 checks applied as a set |
| ObjC header | `plugins/ios/IOSSecurityModule.m` | `RCTBridgeModule.h` imported, `RCT_EXTERN_METHOD` count > 0 |
| app.json — ATS | `expo.ios.infoPlist.NSAppTransportSecurity` | `NSAllowsArbitraryLoads` is `false` |
| app.json — Privacy | `expo.ios.infoPlist.NSPrivacyAccessedAPITypes` | Declared (required for App Store) |
| app.json — App Attest | `expo.ios.entitlements` | Environment is `production` |
| app.json — schema | `expo.ios.*` | No invalid fields (`deploymentTarget` etc.) |
| ProGuard — security | `PROGUARD_RULES` template | `com.medacademy.security.**` is kept |
| ProGuard — RN | `PROGUARD_RULES` template | `com.facebook.react.**` is kept |
| ProGuard — Play Integrity | `PROGUARD_RULES` template | Play Integrity classes kept (used via reflection) |
| tsconfig.json | Project root | Valid JSON |
| TS security sources | `src/lib/security*.ts`, `installationId.ts`, `useContentProtection.ts` | No bare `console.log/warn` outside `__DEV__` guard; `keychainService` isolator present |

---

## Running Locally

```bash
# Run the full validation suite (all 3 stages)
pnpm run validate

# Run individual stages
pnpm run validate:kotlin    # Kotlin templates only (~1s)
pnpm run validate:swift     # Swift sources only (~1s)
pnpm run validate:native    # Full check including app.json, ProGuard, TS (~2s)
```

### Expected Output (all passing)

```
═══════════════════════════════════════════════════════════════════
  MedAcademy — Native Build Validation Suite
  2026-07-13T00:00:00.000Z
═══════════════════════════════════════════════════════════════════

── Stage 1/3: Kotlin Template Validation ─────────────────────────
  ✅  [SECURITY_MODULE_KT] K1: package declaration present
  ✅  [SECURITY_MODULE_KT] K2: no unreplaced placeholder tokens
  ✅  [SECURITY_MODULE_KT] K3: debug guard uses BuildConfig.DEBUG
  ...

── Stage 2/3: Swift Source Validation ────────────────────────────
  ✅  [IOSSecurityModule.swift] S1: no unreplaced placeholder tokens
  ✅  [IOSSecurityModule.swift] S2: all critical stored properties declared
  ...

── Stage 3/3: Full Native Build Validation ───────────────────────
  ✅  plugins/withSecurityModule.js loads successfully
  ✅  SECURITY_MODULE_KT: no forbidden placeholders
  ✅  plugins/ios/IOSSecurityModule.swift: all critical stored properties declared
  ...

═══════════════════════════════════════════════════════════════════
  VALIDATION SUMMARY
═══════════════════════════════════════════════════════════════════
  ✅  Stage 1/3: Kotlin Template Validation (exit 0)
  ✅  Stage 2/3: Swift Source Validation (exit 0)
  ✅  Stage 3/3: Full Native Build Validation (exit 0)
═══════════════════════════════════════════════════════════════════
  ✅  ALL STAGES PASSED — build is safe to proceed to packaging
═══════════════════════════════════════════════════════════════════
```

### Example Failure Output (v428-style bugs)

```
❌  [SECURITY_MODULE_KT] K2: unreplaced placeholder found: "__DEV_PLACEHOLDER__"
❌  [IOSSecurityModule.swift] S2: 'baselineIMPs' is used but not declared as a stored property

  RESULT: ❌  FAILED — 2 error(s), 0 warning(s)
```

---

## CI Workflow Details

### Trigger Conditions

| Event | Condition | Jobs Run |
|-------|-----------|---------|
| `pull_request` | Targets `main` or `release/*`; plugin/security/config files changed | All 5 jobs |
| `push` | To `main` branch | All 5 jobs |
| `workflow_dispatch` | Manual trigger | All 5 jobs |
| `workflow_call` | Called from release workflow | All 5 jobs |

### Branch Protection Configuration

Add `validation-gate` (the aggregating job) as the **required status check** in GitHub branch protection rules for `main` and `release/*`. This ensures that:
- A PR cannot be merged if any validation job fails.
- Force-push to main is blocked when validation has not run.

```yaml
# In GitHub → Settings → Branches → Branch protection rules → main:
Required status checks:
  - Validation Gate (required for merge)
```

### Artifact Retention

Both `android-prebuild` and `ios-prebuild` jobs upload the generated source files as GitHub Actions artifacts (`android-generated-sources`, `ios-generated-sources`) with a 7-day retention period. This allows post-failure forensics without having to re-run prebuild.

---

## File Map

```
scripts/
├── validate-all.js              ← Orchestrator: runs all stages, unified exit code
├── validate-kotlin-template.js  ← Stage 1: Kotlin template deep validation (10 checks)
├── validate-swift-source.js     ← Stage 2: Swift source deep validation (12 checks)
└── validate-native-build.js     ← Stage 3: Full native build validation (all sources)

.github/
└── workflows/
    └── native-build-validation.yml  ← CI workflow (5 jobs, 4 platforms)

docs/
└── NATIVE_BUILD_VALIDATION.md  ← This document
```

---

## Adding New Checks

### When to Add a Check

Add a new validation check whenever:

1. A new Kotlin or Swift source file is added to a config plugin template.
2. A new stored property is added to `IOSSecurityModule.swift`.
3. A new `@ReactMethod` or `RCT_EXTERN_METHOD` is introduced.
4. A new pattern of template substitution is used in a plugin.
5. A new security-critical check is added that must not log in production.

### How to Add a Swift Stored Property Check

Edit `scripts/validate-swift-source.js`, `REQUIRED_STORED_PROPS` array:

```js
const REQUIRED_STORED_PROPS = [
  'baselineIMPs',
  'hasListeners',
  // Add new property name here:
  'myNewSecurityState',
];
```

### How to Add a Kotlin Placeholder Check

Edit `scripts/validate-kotlin-template.js`, `PLACEHOLDER_PATTERNS` array:

```js
const PLACEHOLDER_PATTERNS = [
  /__[A-Z][A-Z0-9_]+__/,
  /PLACEHOLDER_[A-Z_]+/,
  // Add new pattern:
  /MY_CUSTOM_TOKEN/,
];
```

### How to Add a CI Shell Check

Add a step to the appropriate job in `.github/workflows/native-build-validation.yml`:

```yaml
- name: Verify my new file was generated
  run: |
    FILE="android/app/src/.../MyNewFile.kt"
    if [ ! -f "$FILE" ]; then
      echo "❌ MyNewFile.kt not generated"
      exit 1
    fi
    echo "✅ MyNewFile.kt present"
```

---

## Escalation: When Validation Fails in CI

### Step 1 — Reproduce Locally

```bash
pnpm run validate
```

This gives the same output as CI but instantly, without waiting for the build queue.

### Step 2 — Identify the Failing Check

Look for the `❌` lines and the check ID (K2, S2, etc.). Each ID maps directly to the table in the [Validation Checks Reference](#validation-checks-reference) section above.

### Step 3 — Apply the Fix

| Check ID | Typical Fix |
|----------|-------------|
| K1 | Add `package com.medacademy.xyz` as first line of Kotlin template |
| K2 | Replace `__PLACEHOLDER__` with the correct Kotlin expression (e.g. `BuildConfig.DEBUG.not()`) |
| K3 | Replace raw JS boolean flag with `BuildConfig.DEBUG` |
| K9 | Remove JS syntax (`const`, `=>`, `===`) from Kotlin template string |
| S1 | Replace `__PLACEHOLDER__` with the correct Swift expression |
| S2 | Add `private var propertyName: Type = initialValue` to the Swift class stored-property block |
| S7 | Add the missing `EVENT_*` constant to the `supportedEvents()` return array |
| S8 | Add the missing `#endif` to close the `#if DEBUG` block |
| S9 | Wrap `print()` call in `#if DEBUG … #endif` |
| S12 | Replace `try!` with `do { try … } catch { … }` |

### Step 4 — Re-validate

```bash
pnpm run validate  # Must exit 0 before pushing
```

---

## Relationship to EAS Build Pipeline

```
Developer pushes code
        │
        ▼
GitHub Actions: native-build-validation.yml
        │
        ├─ static-validation (< 2 min)
        │      If FAILS → PR is blocked, error posted as PR comment
        │
        ├─ android-prebuild + ios-prebuild (parallel, ~15 min)
        │      If FAILS → PR is blocked, generated sources uploaded as artifact
        │
        ├─ kotlin-compile (~10 min)
        │      If FAILS → PR is blocked
        │
        └─ validation-gate
               │
               ├─ PASS → Merge allowed → EAS build triggered
               └─ FAIL → Merge blocked → Fix required first
                                │
                         (EAS build never starts)
                         (No packaging cost wasted)
```

This design guarantees that the EAS build queue is only entered when all native source validation has passed, eliminating the class of "packaging failed, rolling back" failures that have no actionable error message in the EAS dashboard.

---

## Maintenance

| Task | Frequency | Owner |
|------|-----------|-------|
| Review and update `REQUIRED_STORED_PROPS` | Every time a new property is added to `IOSSecurityModule.swift` | iOS security developer |
| Update Kotlin version in CI workflow | When `kotlin-compiler` version is bumped in Gradle | Android developer |
| Review `KNOWN_SWIFT_IMPORTS` | When a new framework is added to the Swift module | iOS developer |
| Update ProGuard checks | When a new SDK is integrated that needs `-keep` rules | Android developer |
| Run `pnpm run validate` before every PR | Per commit | All developers |

---

## Known Validator Behaviours

### `__DEV__` is not a placeholder

`__DEV__` is a legitimate React Native / Metro global injected at bundle time.
All three validators explicitly skip it via `RN_LEGITIMATE_GLOBALS`:

```js
const RN_LEGITIMATE_GLOBALS = new Set([
  '__DEV__', '__DEV_STAGE__', '__BUNDLE_START_TIME__', '__fbBatchedBridge__'
]);
```

Only uppercase-body dunder tokens **not** in this set (e.g. `__FOO_BAR__`) are
flagged as unreplaced placeholders.

### Comment lines are excluded from pattern checks

Placeholder, `arc4random`, and `#if DEBUG` balance checks all skip lines that
begin with `//`, `*`, or `/*`. This avoids false positives from developer
documentation that references a forbidden pattern in prose
(e.g. `// replaces arc4random()`).

### `@objc(ClassName)` class decorators are exempt from S4

The S4 cross-check skips `@objc(...)` annotations immediately followed by the
`class` keyword. Only method-level `@objc(selector:...)` annotations are
verified against `func` declarations.

### `#if DEBUG` balance counts non-comment lines only (S8)

The S8 balance check counts `#if DEBUG` / `#endif` occurrences on non-comment
lines only, preventing documentation references from creating a false
"unbalanced" error.

### `scripts/**` is excluded from oxlint

The validator scripts use Node.js CommonJS APIs (`require`, `__dirname`).
The devkit oxlint config sets `"env": { "browser": true }` globally with no
Node.js environment, which would cause `no-undef` errors. `scripts/**` is
added to `ignorePatterns` in the devkit's `oxlint-config.json` to exclude
these build-tooling files from application linting. This is intentional —
the scripts are CI infrastructure, not React Native application code.
