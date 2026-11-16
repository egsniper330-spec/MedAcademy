/**
 * DIAGNOSTIC (SECURITY-TEST) BUILD FLAG — a plain compile-time constant.
 *
 * ─── WHAT THIS IS ────────────────────────────────────────────────────────────
 * The single source of truth for `SECURITY_TEST_BUILD` in
 * `src/lib/securityTestBuild.ts`. It is a CONSTANT (not env, not storage, not
 * remote config), so the release minifier folds it away completely:
 *
 *   false  → every diagnostic branch is dead code (markers, banner, waiver)
 *   true   → the diagnostic build is compiled in
 *
 * ─── WHY IT IS NOT `process.env` ─────────────────────────────────────────────
 * It used to be `process.env.EXPO_PUBLIC_SECURITY_TEST_BUILD === '1' && …`.
 * A release bundle inlines `process.env.EXPO_PUBLIC_*` at transform time
 * (`babel-preset-expo/build/inline-env-vars.js`), which requires the value to be
 * present in the METRO WORKER that transforms the file. Android build 223 and
 * the first run with the keys written into every `.env` channel both proved that
 * unreliable: Expo's own loader printed `env: load .env.production.local .env.local
 * .env.production .env` inside `:app:createBundleReleaseJsAndAssets` (so the
 * files WERE read), the pre-build gate compiled the switch to `true` in the same
 * process, and the shipped, minified bundle still contained none of the markers —
 * i.e. the worker had inlined `void 0 === '1'`, stripping the diagnostic code as
 * dead code. A build input that cannot be observed where it is consumed is not a
 * usable input, so the value is now a source constant that the bundler cannot
 * misread.
 *
 * ─── HOW IT IS ARMED (and why it cannot happen by accident) ──────────────────
 * `scripts/arm-diagnostic-suspension.cjs arm` rewrites this file to `true` — but
 * ONLY when BOTH build-time keys are present in its environment:
 *
 *   EXPO_PUBLIC_SECURITY_TEST_BUILD=1
 *   EXPO_PUBLIC_SECURITY_TEST_BUILD_ACK=security-test
 *
 * Those keys are set by `.github/workflows/android-apk.yml` (job `env:`) and by
 * the `security-test` profile in `eas.json`; no ordinary build has them. The
 * checked-in value is `false` and `scripts/check-diagnostic-build-guards.cjs`
 * FAILS the build if this file is ever committed as `true`.
 *
 * ─── RESTORATION ─────────────────────────────────────────────────────────────
 * `node scripts/arm-diagnostic-suspension.cjs disarm` writes `false` back and
 * removes the suspension lines it added to the env files. Deleting that script
 * and its workflow steps leaves this file at `false` — a normal build.
 */
export const DIAGNOSTIC_BUILD_FLAG: boolean = false;
