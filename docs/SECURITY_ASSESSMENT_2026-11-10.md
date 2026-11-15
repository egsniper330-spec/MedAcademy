# MedAcademy — Comprehensive Security Assessment, Gap Analysis & External Services Research

**Document type:** Audit and research report (no implementation performed)
**Date:** 2026-11-10
**Scope:** React Native/Expo mobile app (Android + iOS), PHP/MySQL backend, admin portal, VdoCipher video, PDF/material delivery
**Method:** Static inspection of source, native modules, plugins, routes, middleware, services, migrations and existing docs; vendor research from official pricing/documentation pages
**Access date for all vendor sources:** 2026-11-10

### Evidence rules used in this report

| Label | Meaning |
|---|---|
| **Verified (static)** | I read the enforcement path end-to-end and traced every caller; behaviour is determined by the code, not inferred from a name. |
| **Verified (tests)** | An existing automated suite exercises the path. |
| **Not runtime-verified** | No device, emulator, live server or production telemetry was available, so runtime behaviour was not observed. |
| **Assumption** | Stated explicitly, e.g. host-level configuration I cannot see from the repo. |
| **Recommendation** | A proposal, not a finding. |

No Gradle build, prebuild, EAS build, APK/IPA, migration, deploy or dependency install was performed for this audit. Nothing outside this report file was created or modified. No secret values appear in this document.

---

## 1. Executive Summary

MedAcademy has an unusually deep self-built security layer for an application of its size: a native detector suite on both platforms, an OS-enforced capture block, a client risk model with a hard gate, certificate pinning, JWT + opaque refresh rotation, RBAC with deny-by-default templates, integrity-attestation plumbing, hardware-keystore device signatures, per-student PDF raster watermarking, and VdoCipher DRM gated by server-side entitlement checks.

The problem is not absence. It is **enforcement posture**: the strongest mechanisms — Play Integrity, iOS App Attest, device-key evidence, and the risk tiers that gate video OTP and PDF delivery — are wired but default to `log_only`, or fail closed as "not configured". In the default configuration the platform therefore *observes* tampering rather than *blocking* it, while the parts that do block (root/Frida/emulator gates, watermarks, pinning) are client-side or above-the-OS and can be defeated by a determined attacker with a repackaged build.

Three findings dominate the risk picture:

1. **Attestation is telemetry, not a gate.** `IntegrityService` verifies Google's signed verdict correctly (request hash, package name, certificate digest, device/app verdicts, 300 s single-use rows), but every action tier defaults to `log_only` for `vdo_otp`, `redeem`, `device_bind`, `financial` and `material_pdf`. `SecurityEvidenceService` verifies real ECDSA P-256 signatures from the Android Keystore with a monotonic counter, and also defaults to `log_only` with `require_registered_key = false`.
2. **iOS attestation is dead.** The client generates and attests keys, and the server endpoint returns **HTTP 503 "App Attest server verification is not configured"**; `app.json` carries no App Attest entitlement. Any iOS build relying on that path is unprotected and, worse, the docs imply otherwise.
3. **Identity and session hardening stops at passwords.** There is no MFA/2FA anywhere, no account lockout or failed-attempt counter (only per-IP throttling on a handful of endpoints), no concurrent-playback limit, and no HSTS/CSP on the API. Account sharing and credential stuffing are the two most plausible real-world attacks against a paid education platform, and neither is structurally addressed.

Secondary but material: the generic `/api/{table}` data surface is broad, PDFs carry a visible watermark but no invisible per-copy fingerprint, VdoCipher's burned-in `annotate` watermark is off by default (an app-drawn overlay is used instead, removable by patching), upload validation is a MIME denylist with no malware scan, and there is no WAF, bot management, dependency scanning or alerting.

**Cost to close the critical gaps is low** — Play Integrity and App Attest are free, Cloudflare Pro is ~$20–25/month, Sentry Team ~$26–29/month, Snyk has a free tier, and a one-off mobile penetration test is the main discretionary spend. The heavy enterprise RASP/MTD vendors (Appdome, Promon, Zimperium, Approov, Guardsquare) cost tens of thousands per year and are **not** justified at MedAcademy's current scale; they become relevant only if content piracy or app cloning causes measurable loss.

**Bottom line:** finish and enforce what is already built before buying anything. Roughly 70% of the value in this report is configuration and completion work on existing code.

---

## 2. Architecture and Threat Model

### 2.1 Components observed

| Layer | Implementation | Notes |
|---|---|---|
| Mobile client | Expo/React Native, expo-router, `src/app/**`, `src/lib/**` | Hermes bytecode bundle; release builds shrink/obfuscate via R8 (`plugins/withProguardRules.js`) |
| Android native | Generated by `plugins/withSecurityModule.js` (~3.9k lines) | Detectors, Play Integrity token request, FLAG_SECURE, window/overlay bridge, native watermark overlay |
| iOS native | `plugins/ios/IOSSecurityModule.swift` (~1.2k lines) + `PinningURLProtocol.swift` | Jailbreak/debug/dylib/bundle checks, screen capture, VPN/proxy, App Attest/DeviceCheck, SPKI pinning |
| API | PHP 8, `backend/src/{Auth,Controllers,Middleware,Services,Video,Storage,Validation,Utils,Database}`, ~95 routes in `backend/routes/api.php` | Shared cPanel hosting (`api.medacademy.site`) |
| Database | MySQL, 53 migrations, `backend/database/schema.sql` | RBAC tables from `039_admin_rbac.sql` |
| Admin portal | Separate SPA on `portal.medacademy.site` | Same API, role-gated |
| Video | VdoCipher (Widevine/FairPlay) with server-issued OTP | `backend/src/Video/VdoCipherService.php`, `Controllers/VideoController.php` |
| Materials | Private storage + PDFium raster helper | `MaterialDeliveryController`, `Services/PdfWatermarkService.php` |

### 2.2 Trust boundaries

```
[attacker-controlled]  rooted/hooked device, patched bundle, scripts, proxies
        │
        ▼
[Mobile app]  JS gate + native detectors + keystore keys + pinning   ← not a boundary
        │  TLS + SPKI pin + JWT/refresh + integrity headers
        ▼
[PHP API]  auth, RBAC, rate limits, integrity verification, entitlement  ← real boundary
        │
        ├─► MySQL (single app user, prepared statements)
        ├─► private storage (PDF source, outside webroot)
        └─► VdoCipher (OTP + DRM licence)
```

The single most important architectural statement in this report: **the mobile client is not a security boundary.** Every client-side check is a speed bump that raises attacker cost and detects casual abuse; only the PHP layer, the OS (FLAG_SECURE, Keystore), and VdoCipher/Google/Apple can actually deny access.

### 2.3 Assets, in order of value

1. Paid video lectures (highest resale value; hardest to watermark robustly).
2. Paid PDFs/notes (easy to redistribute; currently raster-watermarked).
3. Student PII and academic records.
4. Doctor/admin accounts (content upload, student management, financial data).
5. Super Admin (tenant-wide, impersonation, finances).
6. Redeem codes / enrolment entitlements (direct monetisation).

### 2.4 Actors

| Actor | Capability | Primary goal |
|---|---|---|
| Casual student | Stock or rooted phone, screen recorder, PDF sharing | Free/continued access, share with friends |
| Technical student | Magisk/LSPosed/Frida, patched APK, mitmproxy | Bypass device limits, extract video/PDF, forge device identity |
| Content pirate | Automated ripping, resale | Bulk extraction, watermark removal |
| Credential attacker | Leaked password lists, low-rate distributed attempts | Account takeover, especially admin |
| Malicious insider | Doctor/admin credentials | Unauthorised content access, grade/finance manipulation |
| Opportunistic scanner | Automated endpoint fuzzing | Any unauthenticated surface, upload abuse |

### 2.5 What the threat model implies

- Anti-tamper must be **server-verified**, because client assertions are forgeable.
- Content protection must survive a **modified client**, so provider-side watermarking and per-copy fingerprints matter more than UI overlays.
- Account security must assume **password reuse**, so MFA and lockout outrank more detector heuristics.
- Detection without response is **telemetry**, which is useful only if someone reads it — currently nobody is alerted.

---

## 3. Complete Inventory of Existing Security Features

Statuses use the eight-point scale from the brief. "Layer" is where the control is actually enforced.

### A. Mobile application security

| # | Feature | Key files / symbols | Layer | Status |
|---|---|---|---|---|
| A1 | Root detection (Android) | `plugins/withSecurityModule.js` (`su` paths, `test-keys`, busybox, rw `/system`, Magisk paths) | Android native | Implemented but Not Runtime-Verified |
| A2 | Jailbreak detection (iOS) | `plugins/ios/IOSSecurityModule.swift` (Cydia scheme/paths, `/bin/bash`, `fork`, sandbox write, dyld images, apt/lib checks — ~10 heuristics) | iOS native | Implemented but Not Runtime-Verified |
| A3 | Magisk detection | `withSecurityModule.js` (Magisk dirs/packages, `magisk` in mounts) | Android native | Implemented but Not Runtime-Verified |
| A4 | LSPosed / Xposed detection | `withSecurityModule.js` (class-loader, stack-frame and maps heuristics) | Android native | Implemented but Not Runtime-Verified |
| A5 | Frida detection | `withSecurityModule.js` (default 27042 port, `frida`/`gum-js-loop` in `/proc`, thread names, pipes) | Android native | Implemented but Not Runtime-Verified |
| A6 | Debugger detection | `withSecurityModule.js` (`Debug.isDebuggerConnected`, TracerPid); iOS `sysctl` `P_TRACED` | Both native | Implemented but Not Runtime-Verified |
| A7 | Developer Options detection | `withSecurityModule.js` (`Settings.Global.DEVELOPMENT_SETTINGS_ENABLED`) | Android native | Implemented but Not Runtime-Verified |
| A8 | ADB / USB debugging | `withSecurityModule.js` (`ADB_ENABLED`) | Android native | Implemented but Not Runtime-Verified |
| A9 | Emulator detection | `withSecurityModule.js` (build props, sensors, CPU, telephony, `/dev/qemu_pipe` — 5 heuristics) | Android native | Implemented but Not Runtime-Verified (known false positives) |
| A10 | Hooking / injection detection | A4 + A5 + iOS dylib-load-command scan | Both native | Partially Implemented |
| A11 | Tamper / repackaging detection | Signature digest compare (Android), bundle integrity (iOS), + Play Integrity cert digest server-side | Native + PHP | Partially Implemented (enforcement off) |
| A12 | Signature verification | Native digest vs expected; server compares `certificateSha256Digest` | Native + PHP | Code Exists but Is Not Activated (server tier `log_only`) |
| A13 | APK integrity | Signing certificate only; no content hash or self-check | Android native | Partially Implemented |
| A14 | Native library integrity | None found (no `.so` hashing; R8 only renames) | — | Missing |
| A15 | Runtime integrity re-checks | `SecurityContext.tsx` 30 s interval + resume + pre-video preflight | RN | Implemented but Not Runtime-Verified |
| A16 | Anti-debugging (active) | Detection only; no `ptrace(PTRACE_TRACEME)` or anti-attach | Both native | Partially Implemented |
| A17 | Multi-window / split-screen | `isInMultiWindowMode`, `onPictureInPictureModeChanged` → block screen | Android native + RN | Implemented but Not Runtime-Verified |
| A18 | Overlay detection / prevention | `FLAG_WINDOW_IS_OBSCURED` touch evidence, `setHideOverlayWindows` (API 31+) | Android native | Partially Implemented |
| A19 | Screen recording / screenshot block | `FLAG_SECURE` (Android), `UIScreen.isCaptured` + blur (iOS) | OS + native | Implemented but Not Runtime-Verified |
| A20 | FLAG_SECURE | `applySecureFlag` in generated module; applied in release builds | Android OS | Implemented (OS-enforced) |
| A21 | Clipboard protection | None in `src/lib/security*`; copy actions exist in several screens | — | Missing |
| A22 | Background / foreground handling | `AppState` listener → re-evaluate + hold/lock | RN | Implemented but Not Runtime-Verified |
| A23 | VPN detection | `withSecurityModule.js` (NetworkCapabilities/`tun`), iOS `NWPathMonitor` + `getifaddrs` | Both native | Implemented but Not Runtime-Verified (iOS signal documented as unreliable) |
| A24 | Proxy detection | `System.getProperty("http.proxy*")`; iOS `CFNetworkCopySystemProxySettings` | Both native | Implemented but Not Runtime-Verified |
| A25 | Device attestation — Play Integrity | `src/lib/platformIntegrity.ts`, `integrityClient.ts`; server `IntegrityService.php` | Google + PHP | Configured but Ineffective (all tiers `log_only`) |
| A26 | Device attestation — App Attest | `IOSSecurityModule.swift` key/attest/assert; server `appIntegrity` | Apple + PHP | Code Exists but Is Not Activated (server returns **503**) |
| A27 | Device binding / limits | `DeviceController`, `installation_id`, `max_devices`, blocked-device check | PHP | Implemented but Not Runtime-Verified |
| A28 | Keystore device signatures | `src/lib/deviceKey.ts` (EC P-256, challenge→sign), `SecurityEvidenceService.php` | Android Keystore + PHP | Configured but Ineffective (`log_only`, `require_registered_key=false`) |
| A29 | Client risk model | `src/lib/security.ts` (weights + policy buckets), `securityStateModel.ts` | RN | Implemented but Not Runtime-Verified |
| A30 | Hard security gate | `SecurityContext.tsx`, `security-gate.tsx`, block screens | RN | Implemented but Not Runtime-Verified (patchable bundle) |
| A31 | Release obfuscation | `plugins/withProguardRules.js` (R8 shrink + rename) | Android build | Implemented |
| A32 | Update / version enforcement | `AuthMiddleware` HTTP 426 + min-version config | PHP | Implemented and Verified (tests) |
| A33 | Test-build bypass | `src/lib/securityTestBuild.ts` gates all detector bypass | RN | Implemented and Verified (scoped to test builds) |
| A34 | iOS screenshot prevention | Detection + blur after the fact | iOS | Partially Implemented (OS offers no prevention) |

### B. Network and API security

| # | Feature | Key files / symbols | Layer | Status |
|---|---|---|---|---|
| B1 | HTTPS enforcement | `android:usesCleartextTraffic=false`; API base is https | Android/RN | Implemented |
| B2 | HSTS | Not present in `backend/public/.htaccess` | Host | Missing |
| B3 | TLS configuration | Host-managed (cPanel); not in repo | Host | Unknown |
| B4 | Certificate pinning (Android) | `plugins/withNetworkSecurityConfig.js` → `<pin-set>` 6 SPKI pins, system anchors only, expiry 2028-06-01 | Android NSC | Implemented and Verified (config + `tests/certificatePinning.test.cjs` 29/29) |
| B5 | Certificate pinning (iOS) | `PinningURLProtocol.swift` SPKI pin compare | iOS | Implemented but Not Runtime-Verified |
| B6 | API authentication | `AuthMiddleware`, `Jwt` (HS256, 900 s), bearer token | PHP | Implemented and Verified |
| B7 | Authorization / permissions | route role gates + `PermissionService` templates/overrides, deny-by-default | PHP | Implemented and Verified |
| B8 | Rate limiting | `RateLimitService`: login 10/min/IP, register 10/h/IP, forgot 20/h/IP + 5/h/account, reset 40/h/IP, refresh 120/min/IP, integrity 60/min, evidence 60/min | PHP | Partially Implemented (most endpoints unthrottled) |
| B9 | Brute-force protection | Per-IP throttle only; no per-account counter, no lockout, no CAPTCHA | PHP | Partially Implemented |
| B10 | Replay protection | Integrity `request_hash` single-use + 300 s TTL; evidence monotonic counter; PDF token TTL 300 s | PHP | Partially Implemented (only on those flows) |
| B11 | Request signing | `X-Security-Signature` ECDSA over challenge (opt-in) | PHP | Code Exists but Is Not Activated |
| B12 | Nonce / timestamp validation | Integrity + device evidence only | PHP | Partially Implemented |
| B13 | API abuse prevention | None beyond rate limits | — | Missing |
| B14 | Bot protection | None | — | Missing |
| B15 | WAF | None | — | Missing |
| B16 | DDoS protection | None in project; host-dependent | Host | Unknown |
| B17 | CORS | `CorsMiddleware` allowlist, native no-Origin allowed | PHP | Implemented and Verified |
| B18 | Security headers | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy` | PHP/.htaccess | Partially Implemented (no HSTS, no CSP) |
| B19 | SQL injection protection | PDO prepared statements throughout; identifier whitelist in `DataController` | PHP | Implemented and Verified |
| B20 | Input validation | `Validation` layer on auth/admin/upload paths; generic data API accepts arbitrary filters | PHP | Partially Implemented |
| B21 | File upload validation | `UploadIntegrityService` (server-measured size, SHA-256, PDF structural parse), path ownership `canWritePath` | PHP | Partially Implemented (MIME denylist, no AV) |
| B22 | Endpoint exposure | ~95 routes; generic `/api/{table}` with whitelist + owner scoping | PHP | Partially Implemented (large surface) |

### C. Authentication and account security

| # | Feature | Key files | Layer | Status |
|---|---|---|---|---|
| C1 | Password hashing | `Password.php`, bcrypt cost 10 | PHP | Implemented and Verified |
| C2 | Password reset | 30-min single-use hashed token, IP + account throttles, session revoke | PHP | Implemented and Verified |
| C3 | Access token expiry | JWT 900 s (`JWT_ACCESS_TTL_SECONDS`) | PHP | Implemented |
| C4 | Refresh rotation | `SessionManager`: 48-byte opaque, SHA-256 stored, rotate on use, 365-day rolling | PHP | Implemented and Verified |
| C5 | Session revocation | `security_version` bump invalidates all tokens | PHP | Implemented and Verified |
| C6 | Device/session management | Device list, revoke, block, limits | PHP | Implemented |
| C7 | Concurrent login restriction | None (device count ≠ concurrent sessions) | — | Missing |
| C8 | Account locking | None (no failed-attempt counter) | — | Missing |
| C9 | OTP / MFA | None found anywhere | — | Missing |
| C10 | Suspicious login detection | `login_history`, `security_events` recorded; no automated response or alert | PHP | Partially Implemented |
| C11 | Credential-stuffing protection | IP throttle only | PHP | Partially Implemented |
| C12 | Admin protection | RBAC + SA isolation + audited impersonation; no MFA | PHP | Partially Implemented |
| C13 | Privilege escalation prevention | Delegation guard, super-admin immutability, template validation | PHP | Implemented and Verified |
| C14 | RBAC | `PermissionService`, 039 migration, route + controller checks | PHP/DB | Implemented and Verified |
| C15 | Super Admin isolation | Separate routes, SA-only impersonation, audited | PHP | Implemented |
| C16 | Audit logging | `audit_logs`, `security_events`, `Logger` | PHP/DB | Partially Implemented (no SIEM/alerts) |

### D. Backend and infrastructure

| # | Feature | Files | Status |
|---|---|---|---|
| D1 | Secrets management | `.env` outside webroot, gitignored, deploy excludes it | Partially Implemented (no vault/rotation policy) |
| D2 | Env file protection | `.htaccess` denies `.env`, logs, `storage/private` | Implemented and Verified |
| D3 | Directory traversal prevention | `StorageService` path normalisation + ownership checks | Implemented and Verified |
| D4 | RCE risk | No `eval`; `shell_exec` confined to PDF raster helper with capability gate | Partially Implemented (needs review) |
| D5 | Dependency vulnerability scanning | None (no SCA in CI) | Missing |
| D6 | Database access controls | Single app user, prepared statements; grants unknown | Unknown |
| D7 | File permissions | Deploy script sets dirs/files; exact modes unverified | Unknown |
| D8 | Backup security | Deploy creates timestamped backups; storage/encryption unverified | Unknown |
| D9 | Logging / monitoring | File logs, DB tables; no aggregation, no alerting, no APM | Partially Implemented |
| D10 | IDS / malware detection | None | Missing |
| D11 | Server-side enforcement of mobile policy | `IntegrityService` + `SecurityEvidenceService` gates exist | Configured but Ineffective (default `log_only`) |

### E. Video, PDF and content protection

| # | Feature | Files | Enforced by | Status |
|---|---|---|---|---|
| E1 | VdoCipher DRM | `VdoCipherService.php` | Provider (Widevine/FairPlay) | Implemented |
| E2 | OTP playback authorization | `VideoController::otp` — feature flag → provider policy → Play Integrity → device evidence → risk → entitlement | PHP | Implemented and Verified (code path) |
| E3 | Video token/session expiry | Provider OTP TTL (short-lived), playback session | Provider | Implemented (TTL not runtime-verified) |
| E4 | Video URL protection | No raw URLs returned; OTP + playbackInfo only | PHP + provider | Implemented |
| E5 | Playback domain restriction | Not in repo (VdoCipher dashboard) | Provider | Unknown |
| E6 | Concurrent playback limit | None found in code or config | — | Missing |
| E7 | Screen-recording resistance (video) | FLAG_SECURE + provider DRM | OS + provider | Partially Implemented |
| E8 | Dynamic watermark (provider burn-in) | `annotate` rtext only when `VIDEO_WATERMARK_LAYER=provider`; default is `app` | Provider/Client | Partially Implemented (**default is client overlay**) |
| E9 | Native moving watermark | `NativeWatermarkOverlay` (drawn over player) | Client | Implemented but Not Runtime-Verified (bypassable) |
| E10 | Student identity watermark | Name + `public_user_id` | Client + provider | Implemented |
| E11 | Visible PDF watermark | `PdfWatermarkService` — one centred composite, raster only | PHP (baked pixels) | Implemented and Verified |
| E12 | Invisible PDF fingerprint | None (no XMP/custom metadata/per-copy UUID) | — | Missing |
| E13 | PDF flattening / rasterisation | Raster-only pipeline; vector/flatten legacy paths refused | PHP helper | Implemented and Verified |
| E14 | Download restrictions | permission + `download_enabled` + 300 s HMAC token + re-check at stream | PHP | Implemented and Verified |
| E15 | Material delivery authorization | HMAC(material+student+intent), TTL, re-check on stream | PHP | Implemented and Verified |
| E16 | Leaked-content identification | Visible student identity → manual attribution | PHP watermark | Partially Implemented |
| E17 | Per-student tracing | Video + PDF carry student identity; no automated tracing | Mixed | Partially Implemented |
| E18 | Watermark-removal resistance | Raster resists editing; OCR/crop can remove; overlay removable by patch | Mixed | Partially Implemented |
| E19 | Unauthorized sharing prevention | Deterrence + device limits; content not device-bound | Mixed | Partially Implemented |
---

## 4. Status of Every Existing Protection (summary)

| Status | Count | Notable members |
|---|---|---|
| Implemented and Verified | 12 | JWT auth, refresh rotation, RBAC/deny-by-default, SQLi protection, CORS, Android pinning, PDF HMAC delivery, PDF raster watermark, update floor, hash/password/reset, test-build bypass scoping |
| Implemented but Not Runtime-Verified | 19 | All root/JB/Magisk/LSPosed/Frida/debug/ADB/emulator detectors, VPN/proxy, multi-window, overlay, 30 s re-checks, iOS pinning, device limits, gate |
| Partially Implemented | 20 | Tamper detection, anti-debug, overlay, iOS screenshot, rate limiting, brute-force, replay, input validation, uploads, headers, audit, PDF/video tracing, watermark resistance |
| Code Exists but Is Not Activated | 4 | Play Integrity tiers, device-evidence enforcement, request signing, iOS App Attest |
| Configured but Ineffective | 2 | Attestation policy (`log_only`), server-side mobile-policy enforcement |
| Broken | 1 | App Attest verification endpoint returns 503 "not configured" |
| Missing | 13 | MFA/OTP, account lockout, concurrent sessions, concurrent playback, HSTS, CSP, WAF, bot mgmt, DDoS, WAF/abuse analytics, dependency scanning, IDS/AV, invisible PDF fingerprint, clipboard guard, native-lib integrity |
| Unknown | 5 | TLS config, DB grants, file modes, backup encryption, VdoCipher domain restriction |

**Reading the table correctly:** "Implemented but Not Runtime-Verified" is *not* a pass. It means the code is present and reachable, and the logic is consistent when read, but no device executed it during this audit. The `security-test-evidence/` folder contains build/lint logs only, not behavioural test results.

---

## 5. Broken, Inactive, Unused and Partially Implemented Protections

### 5.1 Broken

**B-1 iOS App Attest verification returns 503.**
`IntegrityController::appIntegrity` → `404/503 "App Attest server verification is not configured"`. The iOS module implements key generation, `attestKey`, and `generateAssertion`, and the client calls them, but the server cannot validate attestations: no Apple root CA chain validation, no `receipt`/`keyId` storage, no `assertion` counter check. `app.json` also has no App Attest entitlement (the `validate:native` run reports this). Net effect: **iOS integrity attestation is inert**, and any documentation implying iOS device attestation is active is wrong.

**B-2 Attestation tiers default to `log_only` for every sensitive action.**
`IntegrityService` action policy defaults: `vdo_otp`, `redeem`, `device_bind`, `financial`, `material_pdf` → `log_only`. `SecurityEvidenceService` likewise, plus `require_registered_key = false`. The verification code is correct — request hash single-use, package name, certificate SHA-256, `PLAY_RECOGNIZED`, device verdicts, 300 s TTL — but the verdict never denies anything. **This is the single largest gap between "we have Play Integrity" and "Play Integrity protects us".**

### 5.2 Inactive / not wired

| Item | Evidence | Consequence |
|---|---|---|
| Request signing on general API | `X-Security-Signature` only checked on evidence-enabled actions | API calls are bearer-token-only; a stolen token is fully usable |
| Attestation history → promotion | `SecurityEvidenceService` promotion rules exist but depend on enforcement being on | No device ever becomes "trusted" in practice |
| App Attest entitlement | absent from `app.json` | iOS attestation cannot run even if the server were ready |
| VdoCipher `annotate` watermark | gated on `VIDEO_WATERMARK_LAYER=provider`, default `app` | Burned-in watermark (survives a patched client) is off by default |
| Play Integrity licence check | `require_licensed` default false | Sideloaded builds not distinguished |

### 5.3 Unused / dead

- Several detector result fields are collected but not mapped into any policy bucket (recorded in `security_events` only). Useful as telemetry, zero enforcement.
- Legacy vector/flatten PDF watermark paths remain in `PdfWatermarkService` but are refused; dead code increases review surface.
- `docs/SECURITY_AUDIT_REPORT.md` (dated 2026-07-13) documents a **Supabase Edge Function `verify-play-integrity`** and applied migrations that no longer describe the current PHP backend. Documentation drift is itself a risk: reviewers and future maintainers will believe controls exist that do not.

### 5.4 Partial, with the gap that matters

| Protection | What works | What does not |
|---|---|---|
| Root/JB detection | Broad heuristics, native, server-reported | String/path heuristics; Magisk DenyList + Shamiko or a repackaged build defeats them; no hardware signal |
| Frida detection | Port/`/proc`/thread heuristics | Non-default port, renamed agent, `hidepid`, or gadget injection evades; no code-page integrity check |
| Signature verification | Digest compare + Play Integrity cert digest | Only enforced when tier = `enforce`; a resigned APK with integrity off passes |
| Overlay defence | Obscured-touch detection, `hideOverlayWindows` | Touch-triggered only; no package enumeration; accessibility-based capture not covered |
| iOS screenshot | Detection + blur | Cannot prevent; iOS offers no FLAG_SECURE equivalent |
| Rate limiting | Auth, integrity, evidence, material, refresh | Course/content/admin listing endpoints unthrottled — enumeration and scraping possible |
| Brute force | IP throttle | No account-level counter; distributed attempts across IPs unopposed |
| Upload validation | Size/hash/PDF structure/path ownership | MIME denylist; no AV/YARA; polyglot PDFs possible |
| Audit logging | Durable tables, rich events | No alerting, no retention policy, no tamper-evidence |
| Video watermark | Identity shown, moving overlay | Default overlay is client-drawn → removable by patching; provider burn-in off |

---

## 6. Missing Security Features

Ordered by relevance to MedAcademy's actual threat model (paid content + student accounts), not by industry fashion.

| # | Missing control | Why it matters here | Priority |
|---|---|---|---|
| M1 | MFA / TOTP for admin, doctor, super-admin | Admin takeover = mass content exfiltration + finance manipulation. Password-only is the weakest link in the chain. | Critical |
| M2 | Per-account failed-login counter + lockout/backoff | Current protection is per-IP; credential stuffing rotates IPs. | Critical |
| M3 | Concurrent playback/session limit | Directly addresses account sharing — the most common revenue leak. | High |
| M4 | HSTS + CSP + full header set | Trivial to add at host/`.htaccess`; protects against downgrade and injected content in the portal. | High |
| M5 | Enforced attestation (Play Integrity + App Attest) | Converts existing code into a real gate; stops repackaged apps and scripted API use. | Critical |
| M6 | WAF + bot management at the edge | Absorbs scanning, credential stuffing, scraping before PHP sees it. | High |
| M7 | Invisible per-copy PDF fingerprint | Visible watermark proves *a* student; an invisible ID proves *which copy* even after crop/OCR. | High |
| M8 | Provider-side burned-in watermark by default | Survives client patching; the only watermark that matters against a modified app. | High |
| M9 | Dependency scanning (SCA) in CI | 161 PHP files + npm tree; no SCA today. | Medium |
| M10 | Error/uptime monitoring with alerts | Security events are written but nobody is paged. | Medium |
| M11 | Uptime/availability + backup restore testing | Backup *existence* ≠ restore capability. | Medium |
| M12 | Clipboard guard for sensitive fields | Credentials/codes can leak to other apps' clipboards. | Low |
| M13 | Native library / bundle integrity hash | Detects patched `.so`/bundle beyond signing cert. | Medium |
| M14 | Behavioural anomaly detection (per-user) | Bulk download/streaming patterns; high value, high effort. | Low |
| M15 | SIEM / centralised log pipeline | Only worth it once volume justifies it. | Low |
| M16 | Device reputation / risk scoring service | Enterprise RASP territory; evaluate only if piracy is measured. | Low |
| M17 | Forensic watermarking with extraction service | Needed to *prove* leakage in disputes; vendor-dependent. | Medium |
| M18 | Email/domain authentication (SPF/DKIM/DMARC) | Phishing of students/staff is a realistic vector. Cheap to verify. | Medium |

---

## 7. External Security Vendors and Services

Pricing recorded from official pages on **2026-11-10**. Where a vendor does not publish prices, that is stated and no number is invented.

### 7.1 Google Play Integrity API — *attestation*
- **Site/docs:** https://developer.android.com/google/play/integrity · https://developer.android.com/google/play/integrity/overview
- **Protects:** verifies the app binary is unmodified and installed by Play, that the request came from a genuine Android device passing device-integrity verdicts.
- **How:** server requests a nonce (`request_hash`), client obtains an encrypted token from Play, server decrypts via Google API, checks `appIntegrity`, `deviceIntegrity`, `accountDetails`, package name and certificate digest.
- **Android:** native, built into Play Services. **iOS:** n/a. **PHP:** yes via REST `decodeIntegrityToken`. **Expo:** needs a config plugin/native module (already implemented).
- **Replaces/adds:** already integrated; completion = enforcement. Adds hardware-backed signal the app cannot forge.
- **Limits:** no iOS, requires Play-distributed installs, quota, verdicts are point-in-time; a rooted device can still pass `MEETS_DEVICE_INTEGRITY` if Play-certified and unmodified app.
- **Complexity:** low (existing code). **Ops:** GCP project + service account.
- **Pricing:** **free**; default quota **10,000 token requests and 10,000 decryptions per day**, increase requestable via Play Console (https://developer.android.com/google/play/integrity/limits).

### 7.2 Apple App Attest + DeviceCheck — *attestation*
- **Docs:** https://developer.apple.com/documentation/devicecheck
- **Protects:** proves the iOS app instance is genuine and unmodified; `DeviceCheck` gives two per-device bits.
- **How:** Secure Enclave key → `attestKey` (one-time, server validates Apple attestation chain) → `generateAssertion` per request with counter.
- **Android:** n/a. **iOS:** native. **PHP:** yes (CBOR/COSE parsing + Apple root CA). **Expo:** config plugin + entitlement required.
- **Status at MedAcademy:** client code present, server **503**, entitlement missing → must be completed, not purchased.
- **Limits:** iOS 14+, per-install keys, no device-wide identity, add-on cost none but implementation effort real.
- **Pricing:** **included** with Apple Developer Program, **$99/year** (https://developer.apple.com/programs/).

### 7.3 Cloudflare — *WAF, DDoS, bot management, CDN*
- **Plans:** https://www.cloudflare.com/plans/ · Bot: https://www.cloudflare.com/products/bot-management/ · Turnstile: https://www.cloudflare.com/products/turnstile/
- **Protects:** L3/4 DDoS (unmetered on all plans), L7 WAF managed rules, bot scoring, rate limiting, TLS termination, caching.
- **How:** DNS proxy in front of `api.medacademy.site`; WAF rules and rate limits at edge; Turnstile on auth/registration forms.
- **Compat:** host-agnostic — works with cPanel origin. No app SDK needed for WAF; Turnstile is web-only (portal + web).
- **Replaces/adds:** replaces nothing in code; adds edge filtering, DDoS absorption, IP reputation, managed rulesets, and offloads login throttling.
- **Limits:** shared-hosting origin still needs correct headers; bot management beyond basic heuristics is enterprise; Turkish/EU data-residency considerations.
- **Complexity:** low–medium (DNS change + rule tuning). **Ops:** ongoing rule review.
- **Pricing (public, 2026-11-10):** Free **$0**; Pro **$20/mo billed annually ($25 monthly)**; Business **$200/mo annual ($250 monthly)**; Enterprise **quote**. Bot Fight Mode free; Super Bot Fight Mode on Pro/Business; **Bot Management is an Enterprise paid add-on — quote**. Turnstile **free** (up to 20 widgets), Enterprise custom.

### 7.4 AWS WAF + Shield — *WAF, bot control, DDoS*
- **Pricing:** https://aws.amazon.com/waf/pricing/
- **Protects:** managed rule groups, rate-based rules, Bot Control, Shield Standard (automatic) / Advanced.
- **Compat:** works only if the API is behind CloudFront/ALB — MedAcademy is on shared cPanel hosting, so adoption implies a migration. **This is the main reason Cloudflare is the better fit.**
- **Pricing (public):** **$5/WebACL/mo + $1/rule/mo + $0.60 per million requests**; Bot Control **$10/mo + $1 per million requests** (first 10M free). Shield Advanced separate (~$3,000/mo commitment, quote-based).

### 7.5 DataDome — *bot & fraud defence*
- **Pricing:** https://datadome.co/pricing/
- **Protects:** credential stuffing, scraping, card fraud, API abuse; bot scoring per request.
- **Integration:** reverse proxy/CDN module or JS tag; REST API for server-side decisions. Mobile SDK available.
- **Adds over Cloudflare Pro:** dedicated bot-detection models and fraud signals; stronger against sophisticated credential stuffing.
- **Limits:** cost; tuning; privacy review.
- **Pricing (public tiers):** Essentials **$3,830/mo**, Advanced **$8,670/mo**, Premium **$10,160/mo**, Enterprise **from $13,270/mo**.

### 7.6 Approov — *mobile app attestation / API shielding*
- **Pricing:** https://approov.io/pricing
- **Protects:** ensures API calls come from a genuine, unmodified instance of *your* app; blocks scripted/replayed API use; manages pinning and secrets.
- **How:** native SDK obtains a short-lived attestation token (Play Integrity / App Attest / its own checks), backend validates via Approov cloud; optional dynamic pinning and API key protection.
- **Compat:** Android + iOS SDKs; RN/Expo via config plugin (native build); PHP backend via token verification endpoint.
- **Adds over in-house:** managed attestation policy, cross-platform parity (fixes the iOS gap), pinning management, secret injection, response to new bypass techniques without app updates.
- **Limits:** recurring per-MAU cost; another vendor in the request path; still not unbypassable on a fully compromised device.
- **Pricing:** tiers published (Aspire ≈10k MAU, Launch ≈100k MAU, Velocity ≈1M MAU, Enterprise), MAU-based, **30-day free trial**; **exact dollar values are not published on the page retrieved — treat as quote/self-serve, not a verified number**.

### 7.7 Appdome — *no-code RASP/anti-fraud build*
- **Pricing:** https://www.appdome.com/pricing/ — **quote only**, 30-day trial.
- **Protects:** anti-tamper, anti-root/hook, anti-debug, anti-overlay, anti-keylogging, screenshot block, ONEShield encryption, bot defence.
- **How:** cloud build service injects protections into the existing APK/IPA — no source changes.
- **Adds:** broad RASP coverage in days; consistent Android/iOS policy.
- **Limits:** build-pipeline dependency; per-app annual licensing; some protections overlap existing (deduplicate); pricing opaque. (AWS Marketplace listings are indicative only and are **not** an official quote.)
- **Pricing:** **quote-based**; third-party AWS listings reference six-figure annual figures for enterprise bundles — **not applicable to MedAcademy and not an official price**.

### 7.8 Guardsquare (DexGuard / iXGuard / AppSweep) — *hardening + obfuscation*
- **Pricing:** https://www.guardsquare.com/pricing — Core/Control/Command **quote**; **AppSweep free**.
- **Protects:** string/control-flow obfuscation, RASP, tamper detection, root/hook checks, call hiding.
- **Replaces:** strengthens what R8 does today (R8 renames; DexGuard also encrypts strings and adds runtime checks).
- **Compat:** Gradle/Xcode build step; no RN-specific support beyond the native layers.
- **Limits:** build complexity, mapping-file management, crash de-obfuscation workflow.
- **Pricing:** quote-based. A 2025 Guardsquare fact sheet quotes ~**€3,499/app/year** for AppSweep paid tiers (secondary source, label as reference only).

### 7.9 Promon SHIELD — *RASP*
- **Site:** https://promon.co/ — **quote only**, trial available.
- **Adds:** obfuscation, anti-debug, anti-hook, overlay/screen-reader defence, runtime self-defence; strong on Android.
- **Limits:** price opacity, native integration, no PHP component.

### 7.10 Zimperium — *MTD + app scanning*
- **Site:** https://www.zimperium.com/ · AWS Marketplace listings.
- **Products:** zScan (static app security testing), zDefend (on-device MTD SDK), zIPS, MTD.
- **Adds:** device threat telemetry (OS exploits, network attacks, phishing) beyond app-level checks; useful if the threat model includes targeted attacks on doctors.
- **Pricing (AWS Marketplace references, 2026-11-10):** zScan **$20,000/app/year**; zDefend **$48,000/year up to 100k downloads**; MTD **$4,800 per 100 devices/year**. Treat as vendor list references, not negotiated quotes.

### 7.11 Sentry — *error & release monitoring*
- **Pricing:** https://sentry.io/pricing/
- **Protects (operationally):** surfaces crashes, failed integrity calls, 500s, broken auth flows; release health; alerting.
- **Compat:** RN/Expo SDK, PHP SDK, source maps/deobfuscation for Hermes and R8.
- **Pricing (public):** Developer **free** (1 user, limited errors); Team **$26/mo billed annually ($29 monthly)**; Business **$80/mo annual ($89 monthly)**; Enterprise **quote**.

### 7.12 Snyk — *dependency & code scanning*
- **Pricing:** https://snyk.io/plans/
- **Protects:** known-vulnerable npm/Composer packages, licence issues, IaC misconfig, container scans.
- **Compat:** CLI + GitHub integration; Composer and npm supported.
- **Pricing (public):** Free **$0** (limited tests/month, 1 user); Team **$25/dev/mo (minimum 5 devs)**; Ignite **$1,260/dev/year**; Enterprise **quote**.

### 7.13 VdoCipher — *video DRM (already in use)*
- **Pricing:** https://www.vdocipher.com/pricing/
- **Protects:** Widevine/FairPlay DRM, OTP-based playback authorisation, dynamic (moving) watermark, domain restriction, screen-capture deterrence via OS, optional piracy tracking.
- **Adds if upgraded:** provider-side burned-in watermark (survives patched clients), forensic watermark extraction, multi-DRM licences.
- **Limits:** watermark removal via re-encoding remains possible; DRM cannot stop a camera pointed at a screen.
- **Pricing (public, annual prepaid):** Starter **$149/yr** (1 TB storage / 100 GB streaming), Value **$399/yr** (2.5 TB), Express **$699/yr** (5 TB), Pro **$1,599/yr** (15 TB), Plus **$4,999/yr** (50 TB). Free trial 5 GB / 4 videos / 30 days. DRM and dynamic watermark included in paid plans.

### 7.14 Others reviewed, not recommended now

| Vendor | Category | Why not now |
|---|---|---|
| Akamai | WAF/CDN/bot | Enterprise pricing and contract; overkill for a single API host |
| Datadog | Observability/SIEM | Excellent but usage-priced; Sentry + host logs cover current needs |
| NowSecure | Mobile app security testing | Useful as a one-off audit, not recurring |
| Irdeto / NexGuard | Forensic video watermarking | Broadcast-grade, quote-only, disproportionate cost |
| HackerOne / Bugcrowd | Bug bounty | Only after the critical gaps are closed |
| OWASP ZAP / MobSF | Self-hosted testing | Free; good complement, not a managed service |

---

## 8. Current Pricing and Cost Comparison

All figures from official pages on 2026-11-10 unless marked otherwise.

| Service | Free tier | Entry paid | Mid tier | Enterprise | Billing model |
|---|---|---|---|---|---|
| Play Integrity | Yes (10k req/day, 10k decrypts/day) | — | — | quota increase free | per-request quota |
| Apple App Attest / DeviceCheck | — | $99/yr Developer Program | — | — | annual membership |
| Cloudflare | $0 (WAF managed rules, unmetered DDoS) | Pro **$20/mo** annual / **$25** monthly | Business **$200/mo** annual / **$250** monthly | quote (Bot Mgmt add-on quote) | per zone/month |
| AWS WAF | — | $5/ACL + $1/rule + $0.60/M req | Bot Control $10/mo + $1/M | Shield Advanced quote | usage |
| DataDome | trial | **$3,830/mo** | $8,670 / $10,160/mo | from **$13,270/mo** | monthly tier |
| Approov | 30-day trial | Aspire (10k MAU) | Launch (100k MAU) | Velocity/Enterprise | MAU, **price on request** |
| Appdome | 30-day trial | — | — | **quote only** | per app/year, quote |
| Guardsquare | AppSweep free | — | Core/Control/Command | **quote** | per app/year |
| Promon SHIELD | trial | — | — | **quote only** | per app/year |
| Zimperium | — | zScan **$20k/app/yr** (AWS ref) | zDefend **$48k/yr** ≤100k dl | MTD $4,800/100 devices/yr | per app/device |
| Sentry | Developer free | Team **$26/mo** annual ($29 monthly) | Business **$80/mo** annual ($89) | quote | per org/month |
| Snyk | Free $0 | Team **$25/dev/mo**, min 5 | Ignite **$1,260/dev/yr** | quote | per developer |
| VdoCipher | 30-day trial | Starter **$149/yr** | Value $399 / Express $699 | Pro $1,599 / Plus $4,999 | annual prepaid |

**Note on opaque vendors:** Appdome, Promon, Guardsquare (Core+), Approov dollar values and Cloudflare Bot Management are quote/self-serve. Any budget line for them in this report is labelled **estimate** and derived from public list references only.

---

## 9. Code vs External vs Hybrid Comparison

| Protection | Current status | Code-only approach | External service | What external adds | Est. cost | Recommendation |
|---|---|---|---|---|---|---|
| Android attestation | Integrated, `log_only` | Finish + enforce existing Play Integrity | Play Integrity (already external, free) | Nothing new — just turn on | $0 | **Enforce existing** |
| iOS attestation | Broken (503) | Implement Apple chain validation + entitlement | App Attest (free) or Approov | Managed validation, cross-platform parity | $0 / Approov quote | **Fix in-house first**; Approov only if iOS parity is business-critical |
| Root/hook/tamper RASP | Native heuristics | More heuristics, integrity self-hash, Play Integrity enforcement | Appdome / Promon / Guardsquare | Continuously updated bypass detection without app releases; string encryption | Quote (five figures/yr) | **Code + Play Integrity now**; RASP vendor only if cloning is observed |
| API-origin assurance | Bearer tokens only | Enforce device-evidence signatures on all sensitive routes | Approov / Appdome | Attestation token per request, key protection, pinning managed | Approov MAU quote | **Device evidence first** (already built), Approov later |
| Pinning | Implemented both platforms | Maintain pin rotations | Approov/Cloudflare | Managed rotation, dynamic pins | Included in above | **Keep in-house** |
| WAF / DDoS / bot | None | n/a | Cloudflare Pro/Business, AWS WAF, DataDome | Edge filtering, IP reputation, managed rules, rate limits | $20–25/mo Cloudflare; DataDome $3.8k+/mo | **Cloudflare Pro + Turnstile**; DataDome only if stuffing persists |
| Credential stuffing | IP throttle only | Account lockout + MFA + Turnstile | Cloudflare/DataDome bot scoring | Distributed-attack detection | $0–25/mo | **Lockout + MFA + Turnstile** |
| Dependency vulns | None | Manual audits | Snyk | Continuous SCA, PR gating | Free–$125/mo | **Snyk Free → Team** |
| Error/security monitoring | File logs | Custom dashboards | Sentry | Aggregation, alerting, release health | $26–29/mo | **Sentry Team** |
| PDF fingerprint | Visible only | XMP + per-copy UUID + hidden text layer | No mainstream vendor for small scale | — | $0 | **Build in-house** |
| Video watermark | Client overlay | Provider burn-in flag | VdoCipher (already) + forensic add-on | Burned-in, extraction service | Included / quote | **Switch default to provider** |
| Concurrent playback | None | Session/stream count in Redis/DB | VdoCipher plan limits | Provider-side concurrency enforcement | plan-dependent | **Build in-house** |
| Device reputation | None | Risk scoring from existing events | Zimperium/DataDome | Global threat intel | $20k+/yr | **Not justified now** |
| Forensic extraction | None | Manual visible-ID attribution | Irdeto/NexGuard, VdoCipher piracy tracking | Court-grade watermark extraction | quote | **Only if litigation/piracy occurs** |

**Where external services are *not* worth paying for:** attestation on Android and iOS (free APIs), pinning (already implemented), rate limiting (code is fine, put Cloudflare in front), PDF watermarking (already strong, add metadata yourself), and RASP at current scale (Play Integrity enforcement covers the main repackaging risk).

---

## 10. Attack Scenario Analysis

| # | Scenario | Protected today? | Enforcement layer | Bypass | Best mitigation | Code/Service |
|---|---|---|---|---|---|---|
| S1 | Rooted device, Magisk + DenyList | Partially (detect only) | Native detectors + client gate | DenyList/Shamiko hides root; patched JS removes gate | Enforce Play Integrity `MEETS_DEVICE_INTEGRITY` for `vdo_otp` | Code (config) |
| S2 | LSPosed hooking of security module | Partially | Native + RN | Hook `getSecurityFlags` to return clean | Server-verified attestation; Play Integrity enforcement; R8/DexGuard | Code, optional RASP |
| S3 | Frida instrumentation | Partially | Native heuristics | Non-default port, gadget, renamed agent | Integrity verdict + certificate digest; detect `frida-server` via Play Integrity device verdict | Code |
| S4 | Repackaged APK with disabled checks | **No** (integrity log-only) | Play Integrity (inactive) | Patch bundle, resign, install | Enforce `PLAY_RECOGNIZED` + cert digest on video/PDF/redeem | Code (free) |
| S5 | API calls outside the app (scripts) | Partially | JWT + rate limits | Valid token + no attestation → full API | Enforce integrity/evidence on sensitive routes; Approov if needed | Code, then service |
| S6 | Forged device identity | Partially | `installation_id` + device key | Client-generated ID spoofable; key not required | `require_registered_key=true`, bind to Play Integrity device verdict | Code |
| S7 | Stolen refresh token | Partially | Rotation + `security_version` | Token replay before rotation detection; 365-day window | MFA, shorter refresh, device-bound refresh, anomaly alert | Code |
| S8 | Account sharing | **No** | Device limit only | Share credentials across devices ≤ limit | Concurrent-session/stream cap, device-bound sessions | Code |
| S9 | Credential stuffing | Partially | 10/min/IP | Distributed IPs; no lockout | Account lockout + Turnstile + Cloudflare bot rules + MFA | Code + Cloudflare |
| S10 | Admin privilege escalation | Partially | RBAC, SA immutability, delegation guard | Stolen admin password → full admin | **MFA on admin**, IP allow-list for portal, alerting | Code |
| S11 | Unauthorized PDF download | Partially | HMAC token + permission + 300 s + re-check | Authorised user downloads and shares | Invisible per-copy fingerprint + download quotas | Code |
| S12 | Video recording & redistribution | Partially | FLAG_SECURE + DRM + watermark | Camera capture, rooted capture, overlay watermark removal | Provider burn-in watermark, forensic extraction on plans | Code/config + VdoCipher |
| S13 | Watermark removal | Partially | Raster (PDF), overlay (video) | Crop/OCR PDF; patch overlay | Provider burn-in; invisible PDF ID; redundancy | Config + code |
| S14 | Overlay / tapjacking | Partially | Obscured-touch + hideOverlayWindows | Non-touch overlays, accessibility services | Keep FLAG_SECURE, add accessibility-service check, block on background | Code |
| S15 | Split-screen exfiltration | Partially | Multi-window block | Second window recording | Already blocking; verify on device | Code (verify) |
| S16 | Tampering with local flags | Partially | Server `security_config` | Patch client to ignore policy | Server-side denies, not client flags | Code |
| S17 | Disabling native modules | Partially | JS gate | Repackage without module; JS still gates | Attestation enforcement makes missing module a server-side fail | Code |
| S18 | Replay of old requests | Partially | Integrity nonce, evidence counter, PDF TTL | Non-integrity endpoints have no nonce | Add idempotency/nonce to sensitive mutations | Code |
| S19 | Extracting secrets from app | Partially | Server-only secrets; R8 | Hermes strings, hardcoded keys if any | Audit bundle for secrets; VdoCipher/Play keys server-side only | Code |
| S20 | Weak PHP endpoint exploitation | Partially | Prepared statements, validation | Generic `/api/{table}` filters; unthrottled endpoints | Tighten whitelist, add throttles, add CSP/HSTS, WAF | Code + Cloudflare |
| S21 | Database compromise | Unknown | Single app user, prepared stmts | Credential leak, host compromise | Least-privilege DB user, encrypted backups, alerting | Code/ops |
| S22 | Public upload abuse | Partially | Auth + validation | Large/polyglot files, storage exhaustion | Allowlist MIME, size caps, AV scan, per-user quotas | Code |

---

## 11. Security Weaknesses and Bypass Risks (ranked)

1. **Enforcement gap on attestation** — the highest-leverage weakness: correct verification, no denial. Attackers with a repackaged app or rooted device face only logging.
2. **iOS attestation non-functional** — asymmetric protection; iOS side effectively has only client-side heuristics.
3. **No MFA for privileged accounts** — a single phished admin password yields content, PII and finance access.
4. **No account lockout** — credential stuffing is throttled per IP only.
5. **Client-side gate is the visible barrier** — patching the JS/Hermes bundle removes warnings; only server checks survive.
6. **Watermark default is client-drawn** — a patched build can suppress the overlay; provider burn-in is one config flag away.
7. **No concurrent-playback limit** — account sharing is unimpeded.
8. **Broad generic data API** — large attack surface with arbitrary filters; needs a table/column review.
9. **No HSTS/CSP** — portal/API downgrade and injection exposure.
10. **No edge protection** — scanning, stuffing and scraping hit PHP directly.
11. **No invisible PDF identifier** — leaked PDFs can only be attributed if the visible watermark survives.
12. **Detection with no response** — security events accumulate unread; no alert thresholds.
13. **Upload validation is a denylist** — polyglot/malformed PDFs possible; no AV.
14. **Documentation drift** — old docs describe a Supabase edge function and controls that no longer exist.
15. **Refresh token lifetime 365 days rolling** — long theft window if a token leaks and rotation isn't observed.

**False-positive risks to manage:** emulator and developer-options detection can lock out legitimate users (documented false-positive fix exists); iOS VPN detection is explicitly unreliable; aggressive root blocking on low-end devices may hurt retention. These should be policy-tuned, not removed.

---

## 12. Prioritized Recommendations

### Critical (do first; mostly configuration/finishing work)
| # | Recommendation | Benefit | Approach | Effort | Recurring |
|---|---|---|---|---|---|
| C-1 | Enforce Play Integrity for `vdo_otp`, `material_pdf`, `redeem`, `device_bind` | Stops repackaged/sideloaded clients at the server | Flip action tiers to `enforce` after a telemetry window; provision GCP service account | 1–3 days + monitoring | $0 |
| C-2 | Fix or remove iOS App Attest | Closes the platform asymmetry | Add entitlement, validate Apple attestation chain, store keyId + counter; or remove claims until done | 3–5 days | $0 (+$99/yr Apple) |
| C-3 | MFA (TOTP) for super-admin, admin, doctor | Neutralises password theft | TOTP enrolment + recovery codes, enforced at login, step-up for finance/RBAC changes | 3–5 days | $0 |
| C-4 | Account lockout + backoff + CAPTCHA on login | Blocks credential stuffing | Per-account counter (DB/Redis), exponential backoff, Turnstile on web | 1–2 days | $0 |
| C-5 | Enable device-evidence enforcement (`require_registered_key=true`) for video/redeem | Makes the keystore signature a real gate | After warmup telemetry; keep grace for unsupported devices | 2–3 days | $0 |
| C-6 | HSTS + CSP + full header set | Downgrade/injection protection | `.htaccess`/host config; CSP report-only first | 0.5 day | $0 |

### High
| # | Recommendation | Benefit | Approach | Effort | Recurring |
|---|---|---|---|---|---|
| H-1 | Cloudflare in front of API + Turnstile | DDoS/WAF/bot/rate-limiting offload | DNS proxy, WAF managed rules, rate rules, Turnstile on auth | 2–3 days | $20–25/mo |
| H-2 | Concurrent stream/session cap | Directly reduces account sharing | Count active playback sessions per user; deny or revoke oldest | 2–3 days | $0 |
| H-3 | Provider burn-in watermark by default | Survives client patching | `VIDEO_WATERMARK_LAYER=provider` for student playback; keep app overlay as secondary | 0.5 day + verification | VdoCipher plan |
| H-4 | Invisible PDF fingerprint | Per-copy attribution after crop/OCR | XMP metadata + hidden text layer + per-delivery UUID logged server-side | 2–3 days | $0 |
| H-5 | Sentry (RN + PHP) with alert rules | Turns detection into response | SDKs, release tagging, alerts on auth/integrity spikes | 1–2 days | $26–29/mo |
| H-6 | Snyk in CI | Finds vulnerable deps | GitHub app + `snyk test` on PRs | 0.5 day | $0–125/mo |
| H-7 | Review generic `/api/{table}` surface + add throttles | Reduces attack surface | Column whitelist, per-route limits, admin-only tables audited | 2–4 days | $0 |
| H-8 | Upload allowlist + AV/YARA scan + quotas | Prevents malicious/polyglot uploads | Strict `%PDF-` + structure check, ClamAV or API scan, per-user quota | 2–3 days | $0–low |
| H-9 | Backup restore drill + encrypted offsite copies | Real recoverability | Restore to staging, verify integrity, encrypt at rest | 1 day + policy | storage |

### Medium
| # | Recommendation | Benefit | Effort | Recurring |
|---|---|---|---|---|
| M-1 | Shorten refresh lifetime (e.g. 90 days) with sliding re-auth | Reduces stolen-token window | 1 day | $0 |
| M-2 | Security-event alert thresholds (failed logins, integrity failures, mass downloads) | Early warning | 2 days | Sentry/Cloudflare |
| M-3 | Device-bound sessions (bind refresh to device key) | Token theft resistance | 3–4 days | $0 |
| M-4 | SPF/DKIM/DMARC + login-notification emails | Phishing/takeover detection | 1 day | $0 |
| M-5 | Native lib/bundle integrity hash checks | Detects patched binaries | 2–3 days | $0 |
| M-6 | Clipboard guard for credentials/codes | Prevents cross-app leakage | 0.5 day | $0 |
| M-7 | Dependency/secret scanning in pre-commit | Prevents secret commits | 1 day | $0 |
| M-8 | One-off mobile pentest (zScan or independent) | Independent validation of S1–S6 | external | **$20k list / quote** (discretionary) |

### Low
| # | Recommendation | Benefit | Recurring |
|---|---|---|---|
| L-1 | Behavioural anomaly scoring (bulk download/stream patterns) | Insider/sharing detection | $0 + effort |
| L-2 | SIEM/log aggregation | Correlation at scale | usage |
| L-3 | RASP vendor (Appdome/Promon/Guardsquare) | Managed anti-tamper | five figures/yr |
| L-4 | Device reputation / MTD (Zimperium) | Targeted-attack defence | $20k+/yr |
| L-5 | Forensic watermark extraction service | Court-grade leakage proof | quote |

### Protections to remove or redesign
- **Remove or clearly mark as inactive** the iOS App Attest claims until the 503 path is fixed — a control that reports "not configured" while docs claim attestation is worse than no claim.
- **Redesign** the emulator/developer-options blocking into a warn-then-limit policy to avoid locking out legitimate low-end users; keep hard block only for video/PDF.
- **Replace** the client-only video overlay default with provider burn-in (keep overlay as defence in depth).
- **Delete** the dead vector/flatten watermark branches to shrink review surface.
- **Retire** `docs/SECURITY_AUDIT_REPORT.md` claims about the Supabase edge function or annotate it as historical.

---

## 13. Recommended Security Architecture

```
Device ──► Cloudflare (WAF, DDoS, bot rules, Turnstile, rate limits, TLS)
              │  HSTS, security headers at edge
              ▼
        PHP API (cPanel origin, HTTPS only)
          ├─ AuthMiddleware: JWT 15m + refresh rotation + security_version
          ├─ MFA gate for admin/doctor/super-admin
          ├─ Account lockout + per-account throttles
          ├─ RBAC (deny-by-default) + SA isolation + audited impersonation
          ├─ Integrity gate: Play Integrity (enforce) | App Attest (enforce)
          ├─ Device evidence: ECDSA + registered key required for content
          ├─ Entitlement + concurrency check ──► VdoCipher OTP (provider burn-in watermark)
          └─ Material HMAC ──► raster PDF + visible + invisible per-copy ID
              │
              ├─ MySQL: least-privilege user, encrypted backups, audit tables
              └─ Sentry (errors/security alerts) · Snyk (SCA) · offsite backups
```

Principles:
1. **Server decides, client advises.** Every gate that matters is enforced in PHP.
2. **Attestation is the root of trust** for "is this our app on a real device"; it is free — use it.
3. **Content protection is layered:** DRM + provider burn-in + invisible per-copy ID + entitlement + concurrency. No single layer is sufficient.
4. **Detection must page someone** — otherwise it is only forensics.
5. **Prefer free/cheap primitives** (Play Integrity, App Attest, Cloudflare Pro, Snyk Free, Sentry Team) before enterprise RASP.

---

## 14. Estimated Monthly and Annual Security Budget

Estimates only; vendor list prices from 2026-11-10.

| Scenario | Components | Monthly | Annual |
|---|---|---|---|
| **A. Minimum viable (recommended start)** | Play Integrity $0, App Attest $0 (+$99/yr Apple), Cloudflare Pro $20–25, Sentry Team $26–29, Snyk Free $0, HSTS/CSP $0, MFA/lockout in-house $0 | **≈ $46–54** | **≈ $650–750** (incl. $99 Apple) |
| **B. Hardened** | A + Snyk Team (5 devs, $125) + Cloudflare rate-limit/bot add-ons (plan tier) + VdoCipher plan upgrade (estimate $399–699/yr) + one-off pentest (amortised) | **≈ $180–230** | **≈ $2,200–2,800** + one-off testing |
| **C. Enterprise RASP/MTD (not recommended now)** | B + Approov (MAU quote, estimate five figures) or Appdome/Promon/Guardsquare (quote) + Zimperium zScan $20k one-off | **≈ $1,700–4,000+** | **≈ $20,000–48,000+** |

**Cost-effectiveness note:** Scenario A closes every Critical finding for under $60/month. Scenario C buys marginal anti-tamper hardening that only pays off if determined pirates are actively targeting the app — a decision to revisit if leak evidence appears.

---

## 15. Implementation Roadmap

| Phase | Window | Work | Exit criteria |
|---|---|---|---|
| **0. Baseline** | Week 1 | Turn on Sentry + Snyk; add HSTS/CSP; document current state; fix stale docs | Alerts firing; CI blocks vulnerable deps; headers verified |
| **1. Enforce attestation** | Weeks 1–3 | Telemetry review → `enforce` for `vdo_otp`, `material_pdf`, `redeem`, `device_bind`; provision GCP credentials; handle `MEETS_BASIC_INTEGRITY` vs `DEVICE_INTEGRITY` policy | Repackaged app denied at OTP; dashboards show verdict mix |
| **2. iOS parity** | Weeks 2–4 | App Attest entitlement, server chain validation, keyId/counter storage, assertion on sensitive calls | iOS attestation returns 200 and denies unmodified-detection failures |
| **3. Account security** | Weeks 3–5 | TOTP MFA for admin/doctor/SA; account lockout/backoff; Turnstile; login alerts | MFA enforced; stuffing simulation blocked |
| **4. Content hardening** | Weeks 5–7 | Provider burn-in watermark; concurrency cap; invisible PDF fingerprint; tighter download quotas | Watermark survives patched client; second stream denied; fingerprint recoverable |
| **5. Edge & surface** | Weeks 6–8 | Cloudflare proxy + WAF + rate rules; `/api/{table}` review; upload allowlist + AV | Scans absorbed at edge; no unthrottled sensitive route |
| **6. Assurance** | Weeks 8–10 | Device-matrix testing (rooted, Frida, emulator, split-screen, screen record); restore drill; optional pentest | Evidence recorded per scenario S1–S22; restore proven |

**Verification for each item** must be behavioural: attempt the attack, capture the server log/HTTP status, and store the artefact — not just a code review.

---

## 16. Decision Matrix

| # | Decision | Option A: Code only | Option B: External | Option C: Hybrid (recommended) | Cost | Choose when |
|---|---|---|---|---|---|---|
| D1 | Android attestation | — | Play Integrity (free) | Enforce existing integration | $0 | Always |
| D2 | iOS attestation | Implement Apple chain | App Attest (free) / Approov | App Attest now, Approov if parity needed | $0 / quote | Always; Approov only at scale |
| D3 | Anti-tamper/RASP | More heuristics + R8 | Appdome/Promon/Guardsquare | Play Integrity + R8, vendor later | $0 / five figures | Vendor only if cloning observed |
| D4 | Edge protection | Rate limits only | Cloudflare / AWS WAF / DataDome | Cloudflare Pro + Turnstile | $20–25/mo | Now |
| D5 | Credential stuffing | Lockout + MFA | DataDome / Cloudflare bot | Lockout + MFA + Turnstile + CF rules | $0–25/mo | Now; DataDome if persists |
| D6 | Dependency security | Manual | Snyk | Snyk Free → Team | $0–125/mo | Now |
| D7 | Monitoring | File logs | Sentry / Datadog | Sentry | $26–29/mo | Now |
| D8 | Video watermark | Client overlay | VdoCipher burn-in / forensic | Provider burn-in + overlay | plan | Now |
| D9 | PDF fingerprint | Metadata + hidden ID | (no fit) | In-house | $0 | Now |
| D10 | Concurrency control | DB session count | VdoCipher limits | In-house | $0 | Now |
| D11 | Device reputation | Risk score from events | Zimperium / DataDome | Defer | $20k+/yr | Only on targeted attacks |
| D12 | Forensic leakage proof | Visible ID | Irdeto / VdoCipher tracking | Defer | quote | Only on litigation/piracy |

---

## Appendix — Sources (accessed 2026-11-10)

| Topic | URL |
|---|---|
| Play Integrity overview | https://developer.android.com/google/play/integrity/overview |
| Play Integrity quotas | https://developer.android.com/google/play/integrity/limits |
| App Attest / DeviceCheck | https://developer.apple.com/documentation/devicecheck |
| Apple Developer Program pricing | https://developer.apple.com/programs/ |
| Cloudflare plans | https://www.cloudflare.com/plans/ |
| Cloudflare bot management | https://www.cloudflare.com/products/bot-management/ |
| Cloudflare Turnstile | https://www.cloudflare.com/products/turnstile/ |
| AWS WAF pricing | https://aws.amazon.com/waf/pricing/ |
| DataDome pricing | https://datadome.co/pricing/ |
| Sentry pricing | https://sentry.io/pricing/ |
| Snyk plans | https://snyk.io/plans/ |
| Approov pricing | https://approov.io/pricing |
| Appdome pricing | https://www.appdome.com/pricing/ |
| Guardsquare pricing | https://www.guardsquare.com/pricing |
| Promon | https://promon.co/ |
| Zimperium | https://www.zimperium.com/ |
| VdoCipher pricing | https://www.vdocipher.com/pricing/ |

**Quoted/estimated figures are labelled inline.** No price in this report was invented; where a vendor publishes no figure, the report says so.

---

### Report limitations

- No runtime testing on physical devices, emulators, or the live API; all mobile statuses are static-analysis + test-suite based.
- Host-level configuration (TLS ciphers, HSTS at the edge, DB grants, backup encryption, file modes) is outside the repository and marked Unknown.
- VdoCipher dashboard settings (domain restriction, plan features) are not visible in code.
- Play Integrity/App Attest behaviour against specific attack tools (Magisk DenyList, Shamiko, Frida gadget) is based on public research, not tested here.
