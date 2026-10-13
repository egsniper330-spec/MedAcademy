# MedAcademy Production Android Signing Setup

Status: **CONFIGURED** (direct-APK distribution; Google Play NOT required and NOT configured).

## Signing identity (STABLE — never regenerate)

| Item | Value |
|------|-------|
| Keystore | `~/.medacademy/medacademy-release.keystore` (outside the repo) |
| Backup copy | `~/.medacademy/medacademy-release.keystore.backup` |
| Type / key | PKCS12, RSA 4096, self-signed |
| Alias | `medacademy-prod` |
| Subject | `CN=MedAcademy Production, OU=Mobile Engineering, O=MedAcademy, L=London, ST=London, C=GB` |
| Valid until | 2059-07-22 (~12,000 days) |
| Password file | `~/.medacademy/release-keystore.password` (0600, never committed, never printed) |
| Cert SHA-256 | `62E8539CBD1A66FE9E0AE2839D4C3B2C63EF896AE52F13ECBB37CDFDBEFF3784` |
| Cert SHA-1 | `691C82C2699A25BBAF2824224CA2B8403C37FFF2` |

**LOSING THIS KEYSTORE ORPHANS EVERY EXISTING INSTALLATION** (Android refuses
updates with a different signing key). Back up BOTH the keystore and the
password file to secure off-machine storage (password manager + encrypted
vault). The password is NOT recoverable.

## Credential flow (nothing secret is committed)

Gradle release signing reads credentials from, in priority order:

1. `android/gradle.properties.local` — machine-local, **gitignored**
2. `~/.medacademy/signing.properties` — machine-wide override, **outside the repo**
3. `MEDA_UPLOAD_STORE_FILE` / `MEDA_UPLOAD_STORE_PASSWORD` / `MEDA_UPLOAD_KEY_ALIAS` / `MEDA_UPLOAD_KEY_PASSWORD` environment variables — for CI

Keys used in those files:

```
MEDA_UPLOAD_STORE_FILE=C:/Users/<you>/.medacademy/medacademy-release.keystore
MEDA_UPLOAD_STORE_PASSWORD=<secret>
MEDA_UPLOAD_KEY_ALIAS=medacademy-prod
MEDA_UPLOAD_KEY_PASSWORD=<secret>
```

## Build wiring

- `android/app/build.gradle` — `signingConfigs.release` (fail-closed: release
  builds **fail** if no production credentials are configured; there is no
  debug-keystore fallback). `buildTypes.debug` → debug keystore; `buildTypes.release`
  → `signingConfigs.release`.
- `plugins/withProductionSigning.js` (registered in `app.json`) — re-applies the
  same configuration on every Expo prebuild so `/android` regeneration can never
  silently regress to debug signing.
- `EXPECTED_CERT_SHA256` is injected into BuildConfig by
  `plugins/withProductionSigning.js`, resolved at Gradle-configuration time in
  this order:
  1. Gradle property — `-PexpectedCertSha256=<64-hex>`
  2. Environment variable — `MEDA_EXPECTED_CERT_SHA256`
  3. `android/app/expected-cert-sha256.local` (gitignored, public fingerprint
     only; written by `scripts/set-production-cert-sha256.mjs`)

  It goes into `defaultConfig` (NOT the release buildType) because
  `SecurityModule.expectedCertSha256()` uses a direct static reference to
  `com.medacademy.app.BuildConfig.EXPECTED_CERT_SHA256`, which must compile in
  debug builds too. `checkSignatureValid()` compares the runtime signing cert
  against it — the client-side integrity bootstrap pin that works
  before/without server config.
- **Fail-closed release guard** — a release packaging task (`packageRelease` /
  `assembleRelease` / `bundleRelease` / `installRelease`) **fails with a
  `GradleException`** when the resolved pin is empty. Rationale: with an empty
  pin `checkSignatureValid()` returns `true` having compared *nothing*, so the
  release would ship with signature verification silently disabled while still
  looking "valid". Same posture as `signingConfigs.release`, which has no
  debug-keystore fallback. The guard is task-graph aware, so `assembleDebug`
  still works on a machine that has never generated the pin.

## Backend trust (authoritative)

The server-controlled trust source is `security_config.expected_cert_sha256s`
(served by `GET /security/config` → client `securityConfigService` →
`detectTamper()` `TRUSTED_CERTS`). Generate the SQL:

```bash
node scripts/apply-production-cert-pin.mjs
```

which prints:

```sql
UPDATE security_config
SET expected_cert_sha256s = '["62E8539CBD1A66FE9E0AE2839D4C3B2C63EF896AE52F13ECBB37CDFDBEFF3784"]',
    security_version = security_version + 1
WHERE is_active = 1;
```

Apply it as a DB administrator (the script intentionally holds no DB credentials).
Semantics preserved:

- runtime cert **matches** a configured fingerprint → signature VALID
- runtime cert **differs** → `signature_invalid` → integrity failure
- **no configuration** → verification UNAVAILABLE (evidence recorded, never "tampered")

## Future multi-certificate (e.g. Play App Signing)

`expected_cert_sha256s` is an **array** — append the future Play-App-Signing cert
to the same JSON array (both trusted during the rotation window). Do NOT invent
fingerprints ahead of time. No redesign needed.

## Changing the signing identity

Never edit `expected-cert-sha256.local` by hand. After any (discouraged) key
change: `node scripts/set-production-cert-sha256.mjs` → rebuild → update the
backend pin (append, don't replace, if old installs must still update).

## When the pin is missing (UNAVAILABLE, never "tampered")

Two independent layers keep a missing pin from being mistaken for a *passed*
check:

1. **Native** — `checkSignatureValid()` returns `true` when the pin is empty
   (skip), and `getSecurityFlags()` publishes
   `expectedCertConfigured = EXPECTED_CERT_SHA256.isNotEmpty()`. A consumer can
   therefore always tell "verified against a pin" from "nothing to compare
   against".
2. **JS** — *both* integrity detectors (`detectAppIntegrity()` and
   `detectTamper()`) require `expectedCertConfigured === true` before they will
   accept `signatureValid` at all. Without that condition, a build with no pin
   would have its unverified signature read as *verified* whenever the server
   had `expected_cert_sha256s` configured. The state is reported as evidence
   (`expected_cert_configured: false` on the security event) and never produces
   `signature_invalid`.

Build time closes the third gap: see the fail-closed release guard above.

## Verification commands

Run the case-verification script first — it needs no build and no SDK for its
static cases:

```bash
node scripts/verify-signing-cases.mjs
```

**Prerequisite — the generated Android tree.** Static cases C and D read
`android/app/src/main/java/com/medacademy/security/SecurityModule.kt` and
`android/app/build.gradle`. Those are `npx expo prebuild -p android` output and
are **not committed**, so on a fresh checkout the script reports them as
`FAIL — PREREQUISITE MISSING` (a deliberate red with the exact command to run;
never a silent skip, so the gate stays fail-closed). Run the prebuild first, or
run the script from a tree that already has one.

Cases A (production-signed + pin → VALID) and B (archived debug-signed artifact
→ must FAIL the pin) are dynamic: they are reported as `SKIPPED` with a reason
when the APK or the Android SDK is absent. Case B needs a debug-signed APK
archived to `docs/artifacts/app-release-NEGATIVE-debug-signed.apk`.

Direct APK check (do not trust Gradle output alone):

```bash
$ANDROID_HOME/build-tools/<version>/apksigner.bat verify --verbose --print-certs \
  android/app/build/outputs/apk/release/app-release.apk
```

Expected production result: `Verifies`, DN `CN=MedAcademy Production…`,
SHA-256 `62e8539c…f3784` (lowercase in apksigner output; pins are case-insensitive
in the codebase — both sides uppercase before comparison).

Confirm which pin the build actually baked in:

```bash
unzip -p android/app/build/outputs/apk/release/app-release.apk classes.dex \
  | strings | grep -i 62e8539c
```

Confirm the guard resolves the pin the same way BuildConfig does (no build):

```bash
grep -n "release cert-pin fail-closed guard" -A 20 android/app/build.gradle
```

Never read, copy or print the keystore password. `scripts/set-production-cert-sha256.mjs`
reads it from `~/.medacademy/release-keystore.password` and only ever writes the
PUBLIC fingerprint.
