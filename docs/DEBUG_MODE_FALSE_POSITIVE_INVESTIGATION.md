# Android release device blocked with `Debug Mode Active` (risk 20) — investigation

**Symptom reported by the phone owner**

- `Access Blocked`
- `Device Risk Score: 20`
- `Detected Issues (1)` → **`Debug Mode Active`**
- Login blocked by the organization's security policy

Release build, works normally on several other Android devices, the affected
phone cannot be connected to a computer and Developer Options may not be enabled.

---

## 1. The exact code path behind the screen

| Step | Where | What it does |
|---|---|---|
| 1 | `src/app/(auth)/sign-in.tsx` (`handleSignIn`, `check(installationId)`) | Runs `SecurityContext.check()` **before** any session exists. |
| 2 | `src/lib/SecurityContext.tsx` `check()` → `runSecurityChecks()` | Fresh evaluation, every detector re-runs (no cached verdict is served to a sign-in attempt). |
| 3 | `src/lib/security.ts` detectors | Produce `SecurityThreat` objects. |
| 4 | `src/lib/security.ts` `WEIGHTS` / `DETECTION_TO_EVENT` + `src/lib/securityStateModel.ts` `evaluateSecurityResult` | `debug_detected` = **weight 20**, bucket `debug` → **`block_login`** ⇒ `blocksLogin: true`. |
| 5 | `src/app/(auth)/sign-in.tsx` lines 106-114 | `router.push('/(auth)/security-warning', { threats: JSON.stringify(secResult.threats), riskScore: '20', blocksLogin: 'true' })`. |
| 6 | `src/app/(auth)/security-warning.tsx` | Renders `THREAT_META[t.type].label` → **"Debug Mode Active"** and `Device Risk Score` from `riskScore`. |

The screen is driven entirely by the **on-device** evaluation (the params carry the
local verdict). The backend is *not* the source of this block — see §3.7.

## 2. Every producer of `debug_detected` (verified by grep, all in `src/`)

| # | Producer | Detector location | `detectionMethod` | Native source |
|---|---|---|---|---|
| A | JS debug bundle | `security.ts:740-746` (`detectDebug`, `__DEV__`) | `Debug mode active` | build-time constant |
| B | Emulator-like device | `security.ts:750-760` (`detectDebug` ← `flags.emulatorDetected`) | `Emulator / debug environment detected` | `plugins/withSecurityModule.js:589` `detectEmulator()` (5 heuristics) |
| C | Test-only / debuggable install | `security.ts:838` (`detectDeveloperOptions` ← `flags.testOnlyBuild`) | `test-only build flag` | `ApplicationInfo.FLAG_TEST_ONLY` |
| D | Mock-location app selected | `security.ts:1266-1280` (`detectMockLocation` ← `flags.mockLocationDetected`) | `Mock location enabled` | `AppOpsManager.checkOpNoThrow(OPSTR_MOCK_LOCATION)` |

Nothing else in the app can emit that event: `app_integrity_compromised`,
`adb_enabled`, `developer_options_enabled`, `debugger_attached`,
`ssl_pinning_failure` and `tamper_detected` are separate event types and are
rendered with their own labels, so the single finding + score 20 pins the event to
`debug_detected` and nothing else. `libmedasec.so` (`raspAggregate` /
`coreHookLibs` / `coreFridaThreads`) is **not read by JS at all** and cannot
contribute.

## 3. Hypothesis ranking (no device available)

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| 1 | **Emulator heuristic false positive (B)** | **Plausible — leading candidate** | Device-specific (device model/props). Same APK cannot be an emulator on other phones. Heuristics are build-prop based (`Build.MANUFACTURER == "unknown"`, fingerprint/`ro.product.device` terms, or 0 sensors **plus** matching build evidence). A single unit or a single model reporting vendor props like `unknown`/`generic` trips it. |
| 2 | **Mock-location false positive (D)** | **Plausible** | Device-specific setting. Tier 1 scans *every* installed package for `MODE_ALLOWED`; a vendor/preinstalled app that the ROM grants the op would trip it. Tier 3 (permission presence) was removed for exactly this class of false positive; Tier 1 has not been shown untruthful on stock hardware. |
| 3 | Developer Options / USB debugging / debugger attached | **Ruled out as the label** | Those emit `developer_options_enabled` / `adb_enabled` / `debugger_attached` → different labels. (Worth having the owner check anyway; it is a 20-second manual check.) |
| 4 | Genuinely debuggable / test-only APK (`__DEV__`, `FLAG_TEST_ONLY`) | **Ruled out** | These are build-level constants: they would block on *every* device running that artifact. Other devices work. Also `__DEV__` would mean the APK embeds a dev JS bundle — the same artifact would fail everywhere. |
| 5 | Native→JS mapping / boolean / fallback bug | **Ruled out** | `nativeSecurity.ts` merges native flags over `SAFE_FLAGS` (fail-safe = `false`); a missing/failed batch yields `emulatorDetected=false`, `mockLocationDetected=false` — it cannot *create* a finding. A thrown/failed check is reported as `detection_unavailable` (weight 0), never as `debug_detected`. |
| 6 | Stale cached/persisted evidence from a previous session | **Ruled out for this screen** | `sign-in` calls `check()`, which calls `runSecurityChecks()`; no verdict is persisted (only policy/config caches, TTL ≤5 min, and those carry no findings). The 500 ms native-flag coalescing cache is per-cycle. |
| 7 | Backend returning an old/aggregated finding | **Ruled out for this screen** | The screen renders `secResult` computed locally at sign-in. Server-side `security_events`/evidence enforcement is a *separate* layer; it was not what rendered this page. |
| 8 | Support-contacts load failure in the screenshot | **Independent** | `getPublicSupportContacts()` is a public endpoint; a failure shows "Could not load support contacts" with a Retry. It has no effect on findings, score or the block. |

**Confirmed root cause: none yet.** The evidence narrows it to (B) or (D) — the two
device-specific detectors that share the `debug_detected` event — but distinguishing
them requires one piece of device-side information: which native flag is `true`.
No speculative behaviour change was made on the strength of a guess.

### Diagnostic gap found while investigating

`POST /security/events` is behind `$auth` (`backend/routes/api.php:185`,
`AuthMiddleware` requires a Bearer token). A user who is blocked **at sign-in has
no session**, so `logThreats()` (called from `SecurityContext.check()`) is
rejected with 401 and swallowed. That is why an admin *cannot* currently see this
finding in `security_events` for the affected device — the login-block case is
precisely the case with no server-side audit trail. (Making that endpoint public
was **not** done: it would be an unauthenticated write surface.)

## 4. What was actually changed (proven defect, presentation only)

The engine reports four different conditions as one event, but only the **gate**
resolved the label from the detector (`resolveFindingCopyKey`); the two
`security-warning` screens still used `THREAT_META[t.type]`, so a mock-location or
emulator finding was rendered as *"Debug Mode Active — running in a debug
environment"*: inaccurate, and its advice ("reinstall the app") cannot clear the
condition. Fixed by resolving the copy key from `detectionMethod` on both screens
and adding the two derived entries.

**Nothing about enforcement changed**: same event type, same weight (20), same
`debug` → `block_login`, same single block decision, no new dismiss control, no
exemption, no reduced detection. `tests/debugModeFindingDiagnostics.test.cjs`
pins this.

## 5. Owner-side diagnostic (no computer, no root, no ADB)

The blocked screen now shows a **read-only** "Device security report" card on
BOTH policy-block surfaces — the pre-login `Access Blocked` screen (the one in
the reported screenshot) and the in-app `SecurityGate` page. Blocking findings
never route to `/security-warning` (`(app)/_layout.tsx` sends only warn-level
findings there), so the gate is the only place an in-app `debug_detected` block
can show it.

### 5.1 Verified accessibility (source-level, not assumed from a test)

| Question | Answer |
|---|---|
| Which component? | `src/components/SecuritySignalReport.tsx` |
| Which screens? | `(auth)/security-warning.tsx` on BOTH blocked branches (connection block, `blocksLogin`); `(app)/security-warning.tsx` on its blocked branches; `(app)/security-gate.tsx` on every policy block page (not the overlay/multi-window window-state pages). |
| Same screen as the screenshot? | Yes — `(auth)/security-warning.tsx` renders the title **Access Blocked** and is what `sign-in.tsx` pushes *before* any session exists when `secResult.blocksLogin` is true. |
| Reachable when login is blocked? | Yes. No session, no auth, no backend. It is inside the page's `ScrollView`. |
| Needs Super Admin / dev build / hidden route / deep link? | No. The card is plain JSX on the block branch; the route is auto-registered by the `(auth)` `<Stack>` (`src/app/(auth)/_layout.tsx`) and reached by `router.push` from sign-in. No `__DEV__`, role, env var or param gates it. |
| Hidden in Release? | No conditional build flag anywhere in the component or its call sites. Both native deps (`expo-clipboard`, `expo-device`) are declared in `package.json` and autolinked into the Release APK. |
| Live or stale? | Live per mount, re-read on **Refresh** and on every return to the foreground (`AppState`), and built from `getNativeSecurityFlags()` — the same measurement the engine reads. The only reuse is the 500 ms per-cycle native batch cache (never across cycles; failures are never cached). |
| All six signals + emulator vs mock-location? | Yes: Developer options, USB debugging (ADB), Debugger attached, Test-only build, Emulator/virtual device, Mock-location app selected, each `on`/`off`/`unknown`/`unavailable`. The report also carries the finding's raw event type and the detector's own `detectionMethod`, which is what separates `emulatorDetected` (`Emulator / debug environment detected`) from `mockLocationDetected` (`Mock location enabled`). |
| Copy without signing in? | Yes — `Clipboard.setStringAsync` from the same card; a failed copy is now surfaced instead of swallowed. |
| Matches this document? | Yes. One gap was found and fixed while verifying: an unreachable native module returned fail-safe `false` flags, so every row rendered **off** (only a banner said otherwise). Rows now read **unavailable** unless the batch was actually measured. |

**Native limitation (unchanged):** the Kotlin batch wraps each detector in
`runCatching { … }.getOrDefault(false)`, so a single detector that throws is
indistinguishable from a measured `false`. Availability is therefore reported
per module, not per row; making it per-row needs a native contract change and
was out of scope for this UI fix.

1. On the phone, open MedAcademy and try to sign in → the `Access Blocked` screen
   appears.
2. Scroll to **Device security report**.
3. Read the six signals — whichever is `ON` is the cause:
   - Developer options
   - USB debugging (ADB)
   - Debugger connected to the app
   - Test-only build flag
   - Emulator / virtual device
   - Mock-location app selected
4. Tap **Copy security report**, then paste it into a message to the
   administrator/support contact (WhatsApp/Telegram/email — whatever the screen
   offers). The report contains the six signals, the app version/build, the
   Android version + API level, manufacturer/model, build fingerprint, the
   finding with its raw event type and detector description, and a timestamp.
   It contains **no** tokens, credentials, identifiers or personal data.
5. If the signal is **Mock-location app selected**: `Settings → Developer options
   → Select mock location app → None`, then reopen the app.
6. If it is **Emulator / virtual device**: the report's manufacturer/model/build
   fingerprint identifies the device model — send it in; the model-specific
   heuristic can then be confirmed and tightened against the real hardware.
7. If it is **Test-only build flag** or **Debug Mode Active**: the installed APK
   is not the production artifact (or the friend installed a different build);
   the report's app version/build pins which one.

Manual check that needs no report at all: `Settings → Developer options` (toggle
off), `USB debugging` (off), `Select mock location app` (None).

The report is read-only by construction: it calls `getNativeSecurityFlags()`
(a plain measurement), writes nothing, logs nothing, offers no dismiss/verify
control, cannot change a policy or the risk score, and does not talk to the
backend. Its copy builder (`src/lib/securitySignalReport.ts`) has no imports at
all so it cannot become a privileged path.

## 6. Remaining diagnostics only the owner can do

- Steps in §5 (the report is the only way to see the flags for that device).
- If the report shows an unexpected signal, the model/build fingerprint is what
  lets a maintainer reproduce the heuristic against that hardware.

## 7. Known limitations

- The affected device has **not** been verified; no fix is claimed to resolve it.
  The card's Release-UI availability is established from source/config, not from
  an installed APK on that hardware.
- Per-signal unavailability is not reported (see the native limitation in §5.1).
- The login-block case leaves no server-side audit trail (see §3, diagnostic gap).
- If a stale session token is still on the device, `logThreats()` may succeed and
  the admin *could* see `debug_detected` with its `detection_method` in
  `security_events` — but that is not guaranteed for a blocked-at-login user.
- The report shows the values that *can* produce the finding; the authoritative
  decision remains the evaluation in `SecurityContext`.
