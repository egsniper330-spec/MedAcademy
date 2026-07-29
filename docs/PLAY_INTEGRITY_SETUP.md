# Play Integrity & Dynamic Security Config Setup

This guide covers the full dynamic security configuration system — version-aware refresh, multi-certificate fingerprint support, and Play Integrity activation.

---

## Architecture Overview

```
╔═══════════════════════════════════════════════════════════════════════════╗
║                         SECURITY SYSTEM FLOW                             ║
╠═══════════════════════════════════════════════════════════════════════════╣
║                                                                           ║
║  APP BUNDLE (static — baked at build time)                                ║
║  ┌─────────────────────────────────────────────────────────────────────┐  ║
║  │  src/config/security.ts  (STATIC_SECURITY)                          │  ║
║  │  • playIntegrity.projectNumber    → EXPO_PUBLIC_PLAY_INTEGRITY_...  │  ║
║  │  • playIntegrity.androidPackageName → EXPO_PUBLIC_ANDROID_PACKAGE.. │  ║
║  │  • signing.expectedSha256          → EXPO_PUBLIC_EXPECTED_CERT_...  │  ║
║  │    (bootstrap fallback only — DB value takes precedence)            │  ║
║  └─────────────────────────────────────────────────────────────────────┘  ║
║           │                                                               ║
║           │ on login + every 15 min + on foreground                       ║
║           ▼                                                               ║
║  ┌─────────────────────────────────────────────────────────────────────┐  ║
║  │  VERSION CHECK (lightweight — ~40 bytes)                            │  ║
║  │  GET  get-security-version  →  { security_version: N }              │  ║
║  │                                                                     │  ║
║  │  cached_version == remote_version?                                  │  ║
║  │    YES → skip full fetch, update freshness timestamp ───────────┐  │  ║
║  │    NO  → fetch full config ───────────────────────────────────┐ │  │  ║
║  └───────────────────────────────────────────────────────────────┼─┼──┘  ║
║                                                                   │ │     ║
║           ┌───────────────────────────────────────────────────────┘ │     ║
║           │ version changed                                          │     ║
║           ▼                                                          │     ║
║  ┌─────────────────────────────────────────────────────────────────┐ │     ║
║  │  FULL CONFIG FETCH (~400 bytes)                                 │ │     ║
║  │  POST  get-security-config  →  SecurityConfigPayload            │ │     ║
║  │  • play_integrity_enabled                                       │ │     ║
║  │  • expected_cert_sha256s  [ "AAAA...64", "BBBB...64" ]         │ │     ║
║  │  • minimum_app_version                                          │ │     ║
║  │  • force_update                                                 │ │     ║
║  │  • security_version                                             │ │     ║
║  │  • extras  (JSONB forward-compat bag)                           │ │     ║
║  └─────────────────────────────────────────────────────────────────┘ │     ║
║           │                                                           │     ║
║           ▼                                                           │     ║
║  ┌─────────────────────────────────────────────────────────────────┐ │     ║
║  │  3-LAYER CLIENT CACHE (securityConfigService.ts)               │ │     ║
║  │  Layer 1: in-memory  (zero latency, lost on restart)           │ │     ║
║  │  Layer 2: SecureStore/localStorage (survives restart + offline) │ │     ║
║  │  Layer 3: SAFE_DEFAULTS  (PI off, no certs, no force-update)   │◄┘     ║
║  └─────────────────────────────────────────────────────────────────┘       ║
║           │                                                                ║
║           ▼                                                                ║
║  ┌─────────────────────────────────────────────────────────────────┐       ║
║  │  getSecurityGuards()  —  derived from live config               │       ║
║  │  • PLAY_INTEGRITY_READY  = DB flag AND static creds set         │       ║
║  │  • SIGNATURE_CHECK_READY = TRUSTED_CERTS.length > 0            │       ║
║  │  • TRUSTED_CERTS         = DB certs ∪ bootstrap fallback        │       ║
║  └─────────────────────────────────────────────────────────────────┘       ║
║           │                                                                ║
║           ▼                                                                ║
║  ┌─────────────────────────────────────────────────────────────────┐       ║
║  │  RUNTIME DETECTORS  (security.ts)                               │       ║
║  │  • detectTamper()     — cert matches ANY TRUSTED_CERTS entry?  │       ║
║  │  • runPlayIntegrityCheck() — PLAY_INTEGRITY_READY guard         │       ║
║  │  • detectRoot/Frida/Overlay/etc. — always run (no guard)        │       ║
║  └─────────────────────────────────────────────────────────────────┘       ║
╚═══════════════════════════════════════════════════════════════════════════╝
```

---

## What You Need

| Value | Where It Lives | Secret or Config? |
|-------|---------------|-------------------|
| Google Cloud Project Number | Google Cloud Console | Expo public env var + Supabase secret |
| Google Service Account JSON | Google Cloud Console | Supabase secret only |
| Android Package Name | Play Console / app.json | Expo public env var + Supabase secret |
| Trusted cert fingerprints | `security_config.expected_cert_sha256s` | DB array (no env var required) |

> **Key architecture**: `expected_cert_sha256s`, `play_integrity_enabled`, and all other dynamic
> values live in the `security_config` DB table. Changing them propagates to all clients within
> **15 minutes** (or immediately on next foreground) — **no app release required**.

---

## Static vs Dynamic Config

### Static (baked into the bundle at build time)

Required before any network call. Cannot change without a new release:

| Field | Env var | Why static |
|-------|---------|------------|
| Google Cloud project number | `EXPO_PUBLIC_PLAY_INTEGRITY_PROJECT_NUMBER` | Passed to native Play Services SDK at OS level |
| Android package name | `EXPO_PUBLIC_ANDROID_PACKAGE_NAME` | Scopes the PI token request; fixed for app lifetime |
| Bootstrap cert SHA-256 | `EXPO_PUBLIC_EXPECTED_CERT_SHA256` | Single last-resort fallback before first login; optional |

### Dynamic (fetched from Supabase after login)

Stored in `security_config`, served by Edge Functions. Super Admin can change any value:

| DB column | Type | Purpose | Update impact |
|-----------|------|---------|---------------|
| `play_integrity_enabled` | bool | Master on/off for PI checks | ≤15 min on all clients |
| `expected_cert_sha256s` | jsonb | Array of trusted cert fingerprints | ≤15 min — no app release |
| `minimum_app_version` | text | Minimum version to run the app | Triggers force-update UI |
| `force_update` | bool | Hard-blocks clients below minimum | Immediate on next check |
| `security_version` | int | Monotonically increasing version counter | Used for version-check optimisation |
| `extras` | jsonb | Forward-compat bag for future fields | No schema migration needed |

---

## `security_config` Table Schema

```sql
CREATE TABLE security_config (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ── Security detectors ────────────────────────────────────────────────────
  play_integrity_enabled       boolean     NOT NULL DEFAULT false,
  expected_cert_sha256s        jsonb       NOT NULL DEFAULT '[]',
    -- Array of trusted fingerprints: each entry is 64 uppercase hex chars, no colons.
    -- DB constraint validate_cert_fingerprints() enforces format + no-duplicates.

  -- ── Force / Soft Update ───────────────────────────────────────────────────
  minimum_app_version          text        NOT NULL DEFAULT '1.0.0',
    -- @deprecated: kept for backward compat with old cached bundles.
    -- Use minimum_supported_version for all new logic.
  minimum_supported_version    text        NOT NULL DEFAULT '1.0.0',
    -- Hard floor: clients STRICTLY BELOW this version are force-blocked.
  latest_version               text        NOT NULL DEFAULT '1.0.0',
    -- Soft ceiling: clients below this see a dismissible banner.
  force_update                 boolean     NOT NULL DEFAULT false,
    -- Emergency override: hard-block even when version is at/above minimum.
  update_title                 text        NOT NULL DEFAULT 'Update Required',
  update_message               text        NOT NULL DEFAULT
    'A critical update is available. Please update the app to continue.',
  android_store_url            text        NOT NULL DEFAULT '',
  ios_store_url                text        NOT NULL DEFAULT '',

  -- ── Metadata ─────────────────────────────────────────────────────────────
  security_version             integer     NOT NULL DEFAULT 1,
    -- Monotonically increasing. Clients compare before fetching full config.
  extras                       jsonb       NOT NULL DEFAULT '{}',
  is_active                    boolean     NOT NULL DEFAULT true,
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  updated_by                   uuid        REFERENCES auth.users(id),
  created_at                   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_cert_fingerprints_format
    CHECK (validate_cert_fingerprints(expected_cert_sha256s))
);
-- Partial index enables index-only scan for get-security-version:
CREATE INDEX idx_security_config_version_check
  ON security_config (is_active, security_version) WHERE is_active = true;
```

**RLS policies:**
- `service_role` — full access (Edge Functions, migrations)
- `super_admin` (authenticated) — read + write
- All other users — **no direct access** (config served only via Edge Functions)

---

## Edge Functions

| Endpoint | Response size | When called |
|----------|--------------|-------------|
| `get-security-version` | ~40 bytes | Every 15 min, on foreground, on login |
| `get-security-config` | ~400 bytes | Only when `security_version` changed |

---

## Version-Check Flow

```
Trigger: login | 15-min timer fires | app returns to foreground
      │
      ▼
checkAndRefreshSecurityConfig()
      │
      ├─ call get-security-version  (~40 bytes, index-only DB scan)
      │         │
      │         ├─ network error / 401  ──────────────────────────────────┐
      │         │                                                          │
      │         └─ returns { security_version: N }                        │
      │                     │                                             │
      │         cached_version == N?                                      │
      │              YES ──▶ update freshness timestamp only              │
      │                      return current in-memory config              │
      │              NO  ──▶ call loadSecurityConfig() ──────────────┐   │
      │                                                               │   │
      │                      (fetch full ~400 byte payload)          │   │
      │                      validate all fields                     │   │
      │                      update memory + SecureStore cache       │   │
      │                      return fresh config                     │   │
      │                                                               │   │
      └─ network failure path ────────────────────────────────────────┘◄──┘
                │
                ▼
         loadSecurityConfig() — same full-fetch path above
         (uses cache if server unreachable)
```

### Why only the version is requested on each cycle

- The full config payload is ~400 bytes. With 1 million daily active users refreshing every 15 minutes, that is ~2.9 TB/day of config traffic.
- The version payload is ~40 bytes. When config is unchanged (the normal case), traffic drops by **~99%** — only the version number travels across the wire.
- `get-security-version` uses a DB partial index (`idx_security_config_version_check`) making it an **index-only scan**: no heap pages read, sub-millisecond latency.

---

## Cache Strategy

```
App starts (no session yet)
      │
      ▼
prewarmSecurityConfig()
  ├─ SecureStore has v2 cache?  ──YES──▶  load into memory (from_cache=true)
  └─ No cache                   ──────▶  SAFE_DEFAULTS in memory

User logs in
      │
      ▼
checkAndRefreshSecurityConfig()    ← always run on session start
  (see version-check flow above)

Every 15 minutes (timer — foreground only)
      │
      ▼
checkAndRefreshSecurityConfig()    ← version probe, full fetch only if changed

App returns to foreground (AppState 'active')
      │
      ▼
checkAndRefreshSecurityConfig()    ← immediate version probe

User logs out
      │
      ▼
invalidateSecurityConfig()
  ├─ clear in-memory config
  └─ delete SecureStore entry (v2 key)
```

### Offline Behaviour

| Situation | Behaviour |
|-----------|----------|
| Network unavailable, cache exists | Use cached config — all detectors run normally |
| Network unavailable, no cache (first install) | SAFE_DEFAULTS: PI disabled, sig check skipped |
| Version-check fails (network error) | Fall through to `loadSecurityConfig()` — uses cache |
| Full-fetch returns malformed response | Reject, keep existing cache |
| Server returns 401/403 | Keep existing cache (session may have expired) |
| SecureStore read fails | Fall back to SAFE_DEFAULTS; never crash |

The app **never blocks startup** — all fetches are fire-and-forget after login.

---

## Multiple Certificate Fingerprints

### Why multiple fingerprints?

Android apps can have more than one signing cert in rotation (upload key, app signing key, legacy
self-managed keystore). Supporting a set of trusted fingerprints lets you:

- **Rotate certificates** without an emergency app release.
- **Test new certs** alongside the production cert before cutting over.
- **Maintain backward compatibility** for users who installed older signed builds.

### Schema

```json
// security_config.expected_cert_sha256s
[
  "AAAA...64 uppercase hex chars, no colons",
  "BBBB...64 uppercase hex chars, no colons"
]
```

Validation rules (enforced by DB constraint, EF sanitiser, and client validator — three layers):
- Each entry: exactly 64 hexadecimal characters.
- Case-insensitive matching; all stored and compared in UPPERCASE.
- Duplicates rejected.
- Empty strings rejected.
- Non-string entries dropped silently.

Signature verification in `detectTamper()`:
```
SIGNATURE_CHECK_READY = TRUSTED_CERTS.length > 0
Passes when: runtime cert SHA-256 matches ANY entry in TRUSTED_CERTS
```

---

## Certificate Rotation Workflow

### Add a new certificate (zero-downtime rotation)

**Step 1 — Add the new cert to the trusted set:**
```sql
UPDATE security_config
SET
  expected_cert_sha256s = expected_cert_sha256s || '["NEWCERT64CHARHEX"]'::jsonb,
  security_version      = security_version + 1
WHERE is_active = true;
```

All clients pick up the new cert within **15 minutes** (next foreground or timer cycle).
Both old and new certs are now trusted → no user is blocked during transition.

**Step 2 — Wait for client propagation (recommended: 48 hours)**

Monitor the admin dashboard or `security_events` table. Once you confirm no clients are
presenting the old cert fingerprint, proceed.

**Step 3 — Remove the old cert:**
```sql
UPDATE security_config
SET
  expected_cert_sha256s = (
    SELECT jsonb_agg(cert)
    FROM jsonb_array_elements_text(expected_cert_sha256s) AS cert
    WHERE cert <> upper('OLDCERT64CHARHEX')
  ),
  security_version = security_version + 1
WHERE is_active = true;
```

### How to get a certificate fingerprint

```sh
# Google Play App Signing (recommended — Play Console manages the key):
# Play Console → App → Setup → App integrity → App signing key certificate
# Copy SHA-256, remove colons, uppercase.
# Example: A1:B2:C3... → A1B2C3...

# Self-managed keystore:
keytool -list -v -keystore release.jks -alias <your-alias>
# Copy the SHA256 fingerprint line, remove colons.
```

---

## How to Enable Play Integrity After Google Play Release

```sql
UPDATE security_config
SET
  play_integrity_enabled = true,
  expected_cert_sha256s  = '["YOUR64CHARHEXFINGERPRINT"]'::jsonb,
  security_version       = security_version + 1
WHERE is_active = true;
```

Then ensure these Supabase secrets are set (Dashboard → Settings → Edge Functions → Secrets):

| Secret | Value |
|--------|-------|
| `GOOGLE_CLOUD_PROJECT_NUMBER` | Numeric project number from Google Cloud Console |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full JSON of service account key |
| `ANDROID_PACKAGE_NAME` | Your package name, e.g. `com.medacademy.app` |

---

## Force Update & Version Management

### How It Works

On every app startup (and on foreground resume), `useForceUpdate` compares the installed version against `minimum_supported_version` from the cached security config:

```
App start / foreground resume
          │
          ▼
  useForceUpdate() reads getSecurityConfig() (zero-latency, synchronous)
          │
  installedVersion < minimum_supported_version?
    OR force_update == true?
          │
    YES ──▶  ForceUpdateGate renders ForceUpdateScreen (FULL SCREEN)
             • Stack navigator never mounts
             • Android Back button intercepted + suppressed
             • Only action: "Update Now" → Linking.openURL(storeUrl)
          │
    NO  ──▶  App renders normally
             │
      installedVersion < latest_version?
              YES ──▶  Soft banner shown above the Stack (dismissible)
              NO  ──▶  No banner
```

### Semver Comparison

Versions are compared **numerically per segment** — NOT as plain strings.

| Comparison | String result (WRONG) | Numeric result (CORRECT) |
|-----------|----------------------|--------------------------|
| `1.9.9` vs `1.10.0` | `1.9.9` > `1.10.0` ❌ | `1.9.9` < `1.10.0` ✓ |
| `2.0.0` vs `1.99.0` | `2.0.0` > `1.99.0` ✓ | `2.0.0` > `1.99.0` ✓ |
| `1.2.10` vs `1.2.9` | `1.2.10` < `1.2.9` ❌ | `1.2.10` > `1.2.9` ✓ |

Implementation (`useForceUpdate.ts`):
```ts
function parseSemver(ver: string): [number, number, number] {
  const m = ver.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}
// Compares segment-by-segment: major → minor → patch
```

### Force Update Flow (Hard Block)

Triggered when: `installed < minimum_supported_version` OR `force_update = true` in DB.

```
┌────────────────────────────────────────────────────────────────────┐
│              ForceUpdateGate (root layout level)                   │
│                                                                    │
│  isForceUpdateRequired = true                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                  ForceUpdateScreen                           │  │
│  │                                                              │  │
│  │  [App Icon]  [Large refresh illustration]                    │  │
│  │                                                              │  │
│  │  Title:    "Update Required"          (from DB)              │  │
│  │  Message:  "A critical update..."     (from DB)              │  │
│  │                                                              │  │
│  │  ┌────────────────────────────────────────────────────────┐  │  │
│  │  │  Installed Version:  v1.0.422                          │  │  │
│  │  │  Latest Version:     v1.5.0       (from DB)            │  │  │
│  │  │  Minimum Required:   v1.3.0       (from DB)            │  │  │
│  │  └────────────────────────────────────────────────────────┘  │  │
│  │                                                              │  │
│  │  [Update Now]  ──▶  Linking.openURL(storeUrl)               │  │
│  │                                                              │  │
│  │  Android Back button: INTERCEPTED — returns true (blocked)  │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  Stack navigator: NOT RENDERED (zero navigation possible)          │
└────────────────────────────────────────────────────────────────────┘
```

### Soft Update Flow (Dismissible Banner)

Triggered when: `installed >= minimum_supported_version` AND `installed < latest_version`.

```
Normal app stack + overlay banner at bottom of screen
  ┌─────────────────────────────────────────┐
  │  [ArrowUp]  "Newer version available"   │
  │  v1.0.422  →  v1.5.0                   │
  │  [Update Now]   [Maybe Later]           │
  └─────────────────────────────────────────┘
  • Banner is dismissed once per session (state in ForceUpdateGate)
  • Next app start: banner re-evaluates (shown again if still applicable)
  • App is fully usable — no navigation blocked
```

### Execution Order Guarantee

```
App start
    │
    ▼
GestureHandlerRootView
    │
    ▼
SessionProvider  (auth session)
    │
    ▼
SecurityProvider  (security config prewarm + refresh)
    │
    ▼
ForceUpdateGate  ◀── blocks here if force update required
    │                 (BEFORE all of the below)
    ▼
ToastProvider
    │
    ▼
RootLayoutNav  (Stack.Protected routing)
    │
    ├── (auth) routes
    └── (app) routes
          ├── home / dashboard
          ├── course loading
          └── video playback
```

### Offline Behavior

| Situation | Behavior |
|-----------|---------|
| Config cached (normal case) | Force-update enforced from cache. Never weakened by network failure. |
| No config (first install, never logged in) | SAFE_DEFAULTS: `force_update=false`, `minimum=1.0.0` — app is NOT blocked |
| Config fetch fails on foreground | Continues using cached config. Re-tries on next version-check cycle. |
| Network unavailable + cached force-update | Force-update REMAINS enforced. No bypass via airplane mode. |

### Admin: Trigger a Force Update

```sql
-- Hard-block all clients below v1.5.0:
UPDATE security_config
SET
  minimum_supported_version = '1.5.0',
  latest_version            = '1.5.0',
  update_title              = 'Critical Update Required',
  update_message            = 'This release contains important security fixes. Please update now.',
  android_store_url         = 'https://play.google.com/store/apps/details?id=com.medacademy.app',
  ios_store_url             = 'https://apps.apple.com/app/id<YOUR_APP_ID>',
  security_version          = security_version + 1
WHERE is_active = true;
```

All clients will show the force-update screen within 15 minutes (or immediately on next foreground). No app release required.

### Admin: Emergency Override (`force_update` flag)

Set `force_update = true` to hard-block ALL clients regardless of version:

```sql
UPDATE security_config
SET force_update = true, security_version = security_version + 1
WHERE is_active = true;
-- Unblock when the emergency is resolved:
UPDATE security_config
SET force_update = false, security_version = security_version + 1
WHERE is_active = true;
```

### Admin: Publish a Soft Update (Banner Only)

```sql
-- Announce v1.4.2 without forcing an update:
UPDATE security_config
SET
  latest_version            = '1.4.2',
  -- minimum_supported_version stays unchanged (e.g. '1.2.0')
  update_title              = 'New Version Available',
  update_message            = 'Version 1.4.2 is now available with new features.',
  android_store_url         = 'https://play.google.com/store/apps/details?id=com.medacademy.app',
  ios_store_url             = 'https://apps.apple.com/app/id<YOUR_APP_ID>',
  security_version          = security_version + 1
WHERE is_active = true;
```

### Step 1 — Publish to Google Play (Internal Track)

Play Integrity tokens are only issued for apps registered in Play Console.

1. `eas build --platform android --profile production`
2. Upload AAB → Play Console → Internal Testing
3. Publish (zero testers is fine — the track just needs to exist)

### Step 2 — Enable Play Integrity API

1. [console.cloud.google.com](https://console.cloud.google.com)
2. Select your project → API Library → search "Play Integrity API" → Enable
3. Note the **Project Number** (Home → Project info card → numeric string)

### Step 3 — Create a Service Account

1. IAM & Admin → Service Accounts → Create
2. Name: `play-integrity-verifier`
3. Role: **Service Account Token Creator**
4. Keys tab → Add Key → JSON → download

### Step 4 — Get the Cert Fingerprint

1. Play Console → App → Setup → App integrity → App signing key certificate
2. Copy SHA-256, remove colons → 64-char uppercase hex string

### Step 5 — Set Expo Env Vars

```dotenv
# .env.production
EXPO_PUBLIC_PLAY_INTEGRITY_PROJECT_NUMBER=123456789012
EXPO_PUBLIC_ANDROID_PACKAGE_NAME=com.medacademy.app
# Optional bootstrap fallback (DB value takes precedence once logged in):
EXPO_PUBLIC_EXPECTED_CERT_SHA256=A1B2C3...64CHARS
```

### Step 6 — Set Supabase Secrets

```sh
supabase secrets set GOOGLE_CLOUD_PROJECT_NUMBER=123456789012
supabase secrets set GOOGLE_SERVICE_ACCOUNT_JSON="$(cat service-account.json)"
supabase secrets set ANDROID_PACKAGE_NAME=com.medacademy.app
```

Redeploy after secrets change:
```sh
supabase functions deploy verify-play-integrity
```

### Step 7 — Enable in DB

```sql
UPDATE security_config
SET
  play_integrity_enabled = true,
  expected_cert_sha256s  = '["YOUR64CHARHEXFINGERPRINT"]'::jsonb,
  security_version       = security_version + 1
WHERE is_active = true;
```

### Step 8 — Rebuild & Test

```sh
eas build --platform android --profile production
# Install on physical non-rooted device — no security warning should appear
```

---

## Graceful Degradation Table

| Missing / Failed | Behaviour |
|------------------|-----------|
| `EXPO_PUBLIC_PLAY_INTEGRITY_PROJECT_NUMBER` empty | PI check skipped, dev warning logged |
| `EXPO_PUBLIC_ANDROID_PACKAGE_NAME` empty | PI check skipped, dev warning logged |
| `expected_cert_sha256s` is `[]` | Signature check skipped (SIGNATURE_CHECK_READY=false) |
| `play_integrity_enabled = false` in DB | PI check skipped silently |
| Network unavailable on version-check | Falls through to `loadSecurityConfig()` → cache |
| Network unavailable on full fetch | Uses SecureStore cache or SAFE_DEFAULTS |
| Malformed server response | Rejected; cache kept intact |
| SecureStore read error | SAFE_DEFAULTS; never crashes |
| `GOOGLE_SERVICE_ACCOUNT_JSON` missing | EF returns `passed=true` (non-blocking) + warning |

---

## Verification Checklist

- [ ] App on Internal Testing track
- [ ] Play Integrity API enabled in Google Cloud
- [ ] `EXPO_PUBLIC_PLAY_INTEGRITY_PROJECT_NUMBER` set
- [ ] `EXPO_PUBLIC_ANDROID_PACKAGE_NAME` set
- [ ] `GOOGLE_CLOUD_PROJECT_NUMBER` in Supabase secrets
- [ ] `GOOGLE_SERVICE_ACCOUNT_JSON` in Supabase secrets
- [ ] `ANDROID_PACKAGE_NAME` in Supabase secrets
- [ ] `verify-play-integrity` redeployed after secrets added
- [ ] `security_config` row updated: `play_integrity_enabled=true`, cert in `expected_cert_sha256s`
- [ ] `security_version` incremented after DB change
- [ ] Release build tested on physical non-rooted Android — no security warning
