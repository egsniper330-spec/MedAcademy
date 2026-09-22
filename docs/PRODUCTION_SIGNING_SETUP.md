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
- `EXPECTED_CERT_SHA256` is injected into the **release BuildConfig** from
  `android/app/expected-cert-sha256.local` (gitignored, public fingerprint only)
  or `MEDA_EXPECTED_CERT_SHA256`. `SecurityModule.checkSignatureValid()` compares
  the runtime signing cert against it — this is the client-side integrity
  bootstrap pin that works before/without server config.

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

## Verification commands

```bash
# Verify the actual APK (do not trust gradle output alone):
~/AppData/Local/Android/Sdk/build-tools/37.0.0/apksigner.bat verify --verbose --print-certs \
  android/app/build/outputs/apk/release/app-release.apk

# Negative test — the archived debug-signed artifact must FAIL the pin:
~/AppData/Local/Android/Sdk/build-tools/37.0.0/apksigner.bat verify --print-certs \
  docs/artifacts/app-release-DEBUGSIGNED-archived.apk
```

Expected production result: `Verifies`, DN `CN=MedAcademy Production…`,
SHA-256 `62e8539c…f3784` (lowercase in apksigner output; pins are case-insensitive
in the codebase — both sides uppercase before comparison).
