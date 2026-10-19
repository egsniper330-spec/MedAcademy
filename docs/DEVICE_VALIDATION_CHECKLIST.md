# Physical-Device Validation Checklist

Manual validation for every security protection this repository **restored** to
production, plus the app surfaces they can break. Nothing here requires a code
change — every item is a pass/fail observation on real hardware.

> **Why a checklist and not an automated test.** `tsc`, `npm run validate` and
> the `tests/` suites prove the *source* is correct. They cannot prove that
> Android actually blacked out a screenshot, or that a real device reports
> `developerOptionsEnabled`. Those are OS behaviours, so they must be observed.
>
> **No item may be "passed" by weakening a protection.** Do not lower a risk
> threshold, disable a detector, add a device allowlist, or globally release
> `FLAG_SECURE` to make a row go green. If a row fails, the fix belongs in
> `src/lib/security.ts`, `src/lib/screenCaptureGuard.ts` or the native module —
> never in the test procedure.

---

## 0. Build under test — establish this first

Every run below assumes a **release** build. A debug/dev build sets `__DEV__ =
true`, which fires `detectDebug()` deliberately, so a dev build *always* gates
and can never validate "normal use passes".

```bash
# From the repository root. Confirm this produced a release APK.
cd android && ./gradlew.bat assembleRelease
```

Record these before touching a device:

```bash
APK=android/app/build/outputs/apk/release/app-release.apk

# 1. Is it really production-shaped?
"$ANDROID_HOME/build-tools/<version>/aapt2.exe" dump badging "$APK" \
  | grep -E "package:|application-debuggable|testOnly"

# 2. Who signed it, and does that match the configured pin?
"$ANDROID_HOME/build-tools/<version>/apksigner.bat" verify --print-certs "$APK"
```

Expected:

| Check | Expected result |
|---|---|
| `package:` | `com.medacademy.app`, `versionCode 221` (or the intended release) |
| `application-debuggable` | **absent** |
| `testOnly` | **absent** |
| `apksigner` signer SHA-256 digest | **byte-identical** to `android/app/expected-cert-sha256.local` |

The pin file is git-ignored and is injected as `BuildConfig.EXPECTED_CERT_SHA256`
by `plugins/withProductionSigning.js`. If it is missing, the plugin now **fails
the release build** rather than shipping an app where the signature check
silently reports *UNAVAILABLE*. See `docs/PRODUCTION_SIGNING_SETUP.md`.

**Install for the ADB-dependent tests** (USB debugging must be on to install via
ADB — see the note in §3):

```bash
adb install -r "$APK"
```

---

## 1. Screenshot protection (`FLAG_SECURE`)

`src/lib/screenCaptureGuard.ts` → `expo-screen-capture` → native `FLAG_SECURE`.

| # | Step | Expected |
|---|---|---|
| 1.1 | Sign in and reach any authenticated screen (lecture list, profile). | Screen renders normally — protection must not blank the UI. |
| 1.2 | Take a screenshot (Power + Volume Down). | Blocked. Gallery shows a black/empty capture, or the OS refuses. |
| 1.3 | `adb shell screencap -p /sdcard/s.png && adb pull /sdcard/s.png` | The pulled PNG is **black/blank**, not app content. |
| 1.4 | Open the recent-apps switcher with the app in foreground. | Thumbnail is obscured/blank (app-switcher protection). |
| 1.5 | Navigate away and back across several tabs. | App still renders; screenshot still blocked (**no black-screen regression** — the reason the guard module exists). |
| 1.6 | Sign out to the **auth** screens, then screenshot. | Auth screens are protected too (guard is mounted at the root layout). |

**Watch for the historical failure mode:** a *permanently black app surface*
means overlapping `preventScreenCaptureAsync` callers clobbered the window layer.
That is a **fail** — it is the defect `screenCaptureGuard.ts` was written to
prevent. Report it with the screen sequence that triggered it.

## 2. Screen recording

Detection comes from `detectScreenRecording()` (`MediaProjection` /
`WindowManager.isScreenRecorded()` on Android; `UIScreen.isCaptured` on iOS).

| # | Step | Expected |
|---|---|---|
| 2.1 | Start a screen recording (or mirror over AirPlay/QuickTime), then open the app. | Gate: **"Screen Recording Detected"** — *"Stop screen recording or mirroring to continue."* |
| 2.2 | Start recording *while* the app is in the foreground. | Gate appears on the state re-check without needing a restart (real-time emitter). |
| 2.3 | Stop recording. | App unlocks; no restart required. |

## 3. USB debugging (ADB) detection

> **Platform limitation — state this accurately.** An Android app **cannot turn
> off system USB debugging itself**; that is a developer setting the user (or
> ADB) owns. The app-side policy is therefore to **detect and block**, not to
> remediate. Never report "the app disabled USB debugging".

**Order matters:** install via ADB first (§0), *then* evaluate, because ADB
requires USB debugging to be on — which the app is designed to block.

| # | Step | Expected |
|---|---|---|
| 3.1 | With USB debugging **on**, open the app. | Gate: **"USB Debugging Enabled"** — *"Open Settings → Developer options and turn USB debugging off."* |
| 3.2 | Risk score shown. | **20** (`adb_enabled` weight) unless other findings stack. |
| 3.3 | Turn USB debugging off (unplug ADB first if the toggle is greyed), reopen. | App opens normally. |
| 3.4 | Simulate without the UI: `adb shell settings put global adb_enabled 0`, then reopen. | App opens normally. Restore afterwards. |

## 4. Developer Options detection

| # | Step | Expected |
|---|---|---|
| 4.1 | Developer Options **on** (USB debugging off), open the app. | Gate: **"Developer Options Enabled"** — *"Open Settings → Developer options and turn Developer options off."* |
| 4.2 | Turn Developer Options off, reopen. | App opens normally. |
| 4.3 | Attach a live debugger and open the app. | Gate: **"Debugger Detected"** (distinct from 4.1 — the audit trail must record the exact surface). |
| 4.4 | Check the backend audit trail for the failed attempt. | The recorded event is the specific one (`adb_enabled` / `developer_options_enabled` / `debugger_attached`), **not** a generic `debug_detected`. |

**These are mandatory blocks by policy.** If a legitimate workflow needs the app
to run with Developer Options on, that is a product decision — raise it, do not
relax the detector.

## 5. Mock location — genuine detection *and* the fixed false positive

| # | Step | Expected |
|---|---|---|
| 5.1 | Set a mock location app (Developer options → Select mock location app), open the app. | Gate: **"Mock Location Detected"** — instructs how to clear the mock app. |
| 5.2 | **False-positive regression:** Developer Options on with **no** mock app selected. | Must **not** say "Mock Location Detected". (Both are `debug_detected`/weight 20, but `resolveFindingCopyKey` must pick the *device-state* copy, not "Insecure Build Detected".) |
| 5.3 | Clear the mock app entirely, reopen. | App opens normally. |
| 5.4 | Read the **login-blocked** (`Access Blocked`) screen's issue row with a mock app selected. | **"Mock Location Detected"** — never "Debug Mode Active". (`debug_detected` is one event/weight 20 shared by four conditions; both `security-warning` screens resolve the label from `resolveFindingCopyKey`.) |

## 6. Emulator / virtual device

| # | Step | Expected |
|---|---|---|
| 6.1 | Install and open on any emulator. | Gate: **"Unsupported Device Detected"** — *"This app cannot run on an emulator or virtual device."* |
| 6.2 | Same on a physical device. | Opens normally. |
| 6.3 | On a physical device where the check reports an emulator (a device-specific false positive), read the issue row. | **"Unsupported Device Detected"**, not "Debug Mode Active" — and the **Device security report** (§14) shows `Emulator / virtual device: on` with the manufacturer/model/build fingerprint needed to tighten the heuristic. |

## 7. Signing verification / tamper

| # | Step | Expected |
|---|---|---|
| 7.1 | Install the correctly signed release (§0). | Signature check **passes**; no gate. |
| 7.2 | Rebuild with a **different** keystore, install, open. | Gate: **"App Integrity Compromised"** — *"This installation failed integrity verification."* |
| 7.3 | Confirm the pin is present at build time. | `BuildConfig.EXPECTED_CERT_SHA256` non-empty. If empty, the check is *UNAVAILABLE*, not *passed* — and the release build should have failed at the plugin step. |

## 8. SecurityGate consistency (finding ↔ risk ↔ decision)

The gate must be derived from one authoritative evaluation.

| # | Step | Expected |
|---|---|---|
| 8.1 | Trigger exactly one condition (e.g. 4.1). | Displayed finding, risk score (**20**) and block decision all describe that one condition. |
| 8.2 | Trigger two at once (Developer Options **+** USB debugging). | **Both** rows are listed on the single gate page; risk is the sum (`20 + 20`); no queued/stacked dialogs. |
| 8.3 | While an evaluation is in flight. | If it cannot complete, the gate shows **"Security Check Incomplete"** — an honest sentinel that self-resolves. It must never claim the build is tampered with. |
| 8.4 | Count shown findings vs. the security diagnostics screen. | They agree. A screen that says 0 findings while the gate blocks is a **fail**. |

## 9. Startup, resume, and stale state

> **Resume no longer shows a verification page.** An ordinary background→foreground
> transition restores the app shell immediately and verifies asynchronously, with
> protected requests/playback held by the central lock until the verdict lands.
> See [RESUME_VERIFICATION.md](RESUME_VERIFICATION.md).

| # | Step | Expected |
|---|---|---|
| 9.1 | Cold start with a clean condition. | No gate flash, no false `debug_detected`. |
| 9.2 | Clear a condition (e.g. turn off Developer Options) while the app is backgrounded, then resume. | Gate clears on resume. |
| 9.3 | Introduce a condition while backgrounded (turn USB debugging on), then resume. | Gate appears on resume. |
| 9.4 | Leave the app foregrounded past a check cycle (~30 s). | Findings/risk refresh; no drift between the gate and diagnostics. |
| 9.5 | Airplane mode / no network, then restore. | Fails closed and honest; never reports "trusted" because a check could not run. |
| 9.6 | Clean device: background the app, then resume. | **No** `VERIFYING YOUR SESSION` page. The screen you left is back immediately; protected requests and lesson playback stay refused for the moment the check takes. No Continue button is needed. |
| 9.7 | Clean device on a slow network: background, then resume. | Same as 9.6 — no verification page, no artificial wait. A stalled check may be retried once after ~8 s; access is never granted on the timeout. |
| 9.8 | Background/resume the app 5× in a row. | One verification per resume (no duplicate native bridge calls or API storms); never stuck locked after a final clean verdict. |
| 9.9 | Turn on a VPN (or Developer Options / USB debugging / mock location), background the app, then resume. | The **authoritative** page for that exact finding appears as soon as the verdict lands — VPN/proxy copy and steps for a connection block, the matching row for any other finding. No `Continue Anyway`, no way past it. |
| 9.10 | Repeat 9.9 with the app already on a protected lesson. | The player is stopped and unmounted on the hard lock; no protected frame or audio continues behind the block. |

## 10. VPN / proxy — launch, runtime and resume

> **This section pins a fixed defect.** Previously a non-blocking (warn-level)
> VPN/proxy finding was surfaced **only** on a background→foreground transition,
> and the screen it navigated to received **no data**, so it rendered
> `Device Risk Score: 0` and `Detected Issues (0)` alongside copy claiming issues
> had been detected. A pre-existing VPN at cold launch was never shown at all.
> Expected results below reflect the fixed behaviour.

> **There is no warn mode for a connection finding any more.** A confirmed
> VPN/proxy is a MANDATORY block in three planes (stored policy row, served
> `/security/policies` payload, client policy table) — see
> [VPN_PROXY_MANDATORY_BLOCK.md](VPN_PROXY_MANDATORY_BLOCK.md). Every row below
> expects the non-dismissible **SecurityGate** page ("VPN OR PROXY DETECTED")
> with a **HOW TO TURN IT OFF** list and a "Verify security and continue"
> control. A `Continue Anyway` button anywhere on a VPN/proxy finding is a
> **FAIL**.

| # | Step | Expected |
|---|---|---|
| 10.1 | VPN **off**. Launch MedAcademy cold, sign in. | No VPN finding. Dashboard loads normally. |
| 10.2 | With the app **foregrounded**, enable the VPN (open the VPN app or Settings, then return). | SecurityGate opens with the **real score (15)**, 1 listed finding ("VPN Connection Detected"), platform-specific turn-off steps, and a re-verify control. |
| 10.3 | Disable the VPN, return to the app, tap **Verify security and continue**. | Gate clears on the fresh evaluation (the `vpnStateChanged` native signal and every foreground return also trigger it). No restart needed. The re-verify control alone must never clear the gate. |
| 10.4 | Disable VPN. Launch the app, then **background it**, enable the VPN while backgrounded, and resume. | Same as 10.2 — the post-resume re-check must catch it. |
| 10.5 | **Force-close** the app. Enable the VPN. Then launch the app fresh. | **The finding must appear from the FIRST verdict.** This is the previously broken case. Warn mode → security-warning with score 15 and 1 finding; block mode → SecurityGate. |
| 10.6 | Repeat 10.5 for a **proxy** configuration the platform exposes. | Mandatory block on the SAME gate page: score **15**, finding "Proxy Connection Detected", distinct from the VPN row. |
| 10.7 | On the **security-warning** screen (reachable only for NON-connection warn-level findings, or by deep link), read the four numbers/lists together. | Title, accent colour, risk score, `Detected Issues (N)` and the button label all describe the **same** state. `N` must equal the number of rendered finding rows. |
| 10.8 | Deep-link into the warn screen with a connection finding, e.g. `/(app)/security-warning?blocksLogin=false&threats=[{"type":"vpn_detected"}]`, and the pre-login variant. | **No dismiss control of any kind.** The VPN/proxy block + turn-off steps render (the finding suppresses the button, not the `blocksLogin` flag). Pre-login the only forward action is "I turned it off — try again", which returns to sign-in and re-runs the check. |
| 10.9 | If a screen is ever reached with **no** findings. | It must read "Security Check" / "No issues detected" (or "Verification in progress" while a check runs) — **never** "Security issues were detected" over an empty list, and the button reads "Continue". |
| 10.10 | With an admin VPN whitelist configured (any rows). | Detection is skipped by design — the finding is expected to be **absent**. Confirm this is intentional, not the bug. |

**Record for each run:** the finding type(s), risk score, gate decision
(warning vs SecurityGate), and the timestamp — the report asked for these
explicitly.

### iOS detection limits — state these honestly, never as "VPN fully covered"

- **No app can enumerate arbitrary VPNs.** The authoritative native path is a
two-gate check: `NWPathMonitor` (is the active path using a non-standard
interface type?) plus `getifaddrs` with `IFF_UP` (is a `utun*`/`ipsec*`/`ppp*`
interface actually up?). Both gates must pass, which is what removed the old
100% false-positive rate from iOS's permanent system `utun0/1/2` interfaces.
- **The JS fallback is much weaker.** If the native `IOSSecurityModule` is not
  present, detection falls back to `@react-native-community/netinfo` and only
  `type === 'vpn'` counts (the `other`/`unknown` heuristic was deliberately
  removed because it false-positived on Ethernet adapters, hotspots, corporate
  Wi-Fi and iCloud Private Relay). Packet-tunnel VPNs (WireGuard, OpenVPN,
  Tailscale, Cloudflare WARP) commonly report as **`wifi`/`other`, not `vpn`**,
  so in fallback mode they may be **missed**. Check which path is active and say
  so in the report.
- **Deliberately not flagged:** iCloud Private Relay (Apple surfaces it as
  `.wifi`/`.cellular`), and DNS-only / per-app VPNs that never become the active
  path transport. Treat these as **accepted gaps**, not pass/fail rows.
- **Proxy detection** uses `CFNetworkCopySystemProxySettings` (HTTP/HTTPS/SOCKS).
  A PAC file or a proxy applied inside an app is not visible to this API.
- **Cold-launch timing.** Apple's network state settles shortly after launch. If
  a first-launch verdict misses a VPN that is plainly active, wait for the next
  periodic check (~30 s) before concluding — and report the timing either way.

## 11. Video playback (the restored protection must not break the player)

Protection and the VdoCipher/Plyr fixes must coexist.

| # | Step | Expected |
|---|---|---|
| 10.1 | Open a lecture video and play. | Video renders and plays — **no black surface**, no audio-only playback. |
| 10.2 | Toggle fullscreen and back, repeatedly. | No remount storm, no reload, no frozen frame; position preserved where intended. |
| 10.3 | Rotate while playing. | Playback continues; layout adapts. |
| 10.4 | Screenshot during playback. | Blocked (still `FLAG_SECURE`). |
| 10.5 | Background/foreground the app mid-playback. | Player recovers cleanly; no stuck spinner, no duplicate audio. |
| 10.6 | Play offline-downloaded content (if enabled). | Plays; capture still blocked. |

## 12. PDF / lecture-material viewing

| # | Step | Expected |
|---|---|---|
| 11.1 | Open a watermarked PDF as **student A**, then as **student B**. | The two watermarks differ and each names its own student. |
| 11.2 | Screenshot the PDF. | Blocked. |
| 11.3 | Verify download/copy restrictions. | Unchanged by the capture restoration. |

## 13. Account-role exemptions

Both exemptions are **backend-verified role** decisions, not device states.

| # | Step | Expected |
|---|---|---|
| 12.1 | Sign in as **Super Admin**; screenshot a protected screen. | Capture is permitted by design (`SecurityContext.isSuperAdmin` via `useContentProtection` / `useScreenCapture`). |
| 12.2 | Sign in as a **non-student** role and trigger a content-protection violation. | Server returns `action='exempt'` / role ≠ student → **no penalty** applied. |
| 12.3 | Sign in as a **student** and trigger the same violation. | Penalty **is** applied — the exemption must not leak to students. |
| 12.4 | Confirm the role source. | Derived from the backend profile, **never** from a client-supplied value. |

## 14. Device security report (the only diagnostic on a phone that cannot be attached to a computer)

Read-only card rendered on **every policy block surface**: both `security-warning`
screens (including the pre-login `Access Blocked` page) and the in-app
`SecurityGate` page (blocking findings never route to `security-warning`, so the
gate carries the same card). It cannot unblock, cannot change a policy or the
risk score, logs nothing, and sends nothing to the backend. See
`docs/DEBUG_MODE_FALSE_POSITIVE_INVESTIGATION.md` for the detector trace it
supports.

| # | Step | Expected |
|---|---|---|
| 14.1 | Try to sign in on a device the check blocks, then scroll the `Access Blocked` page to **Device security report**. | Six rows appear: Developer options, USB debugging (ADB), Debugger connected to the app, Test-only build flag, Emulator / virtual device, Mock-location app selected — each `on` / `off` / `unknown` / `unavailable`. No login, Super Admin role, dev build or deep link was needed. |
| 14.2 | Compare the rows with the finding shown above them. | Exactly the reported condition reads `on`; every unrelated signal reads `off`; a signal that could not be measured reads `unknown` (measured device) or `unavailable` (native module unreachable) — never `off`. |
| 14.2b | Open Android Settings (leaving the block page mounted), turn Developer options off, then return to the app. | The card re-reads on foreground: the row changes to `off` without a manual refresh. |
| 14.2c | Sign in on a clean account, then trigger an in-app policy block (e.g. root/tamper on a test device). | The `SECURITY BLOCK ACTIVE` page also carries the card; the block is unchanged and non-dismissible. |
| 14.3 | Tap **Copy security report**. | The copied text carries the six signals, app version/build, Android version + API level, manufacturer/model, build fingerprint, the finding with its raw event type + detector description, and a timestamp. No token, credential, identifier or user data. |
| 14.4 | Force the native module to be unavailable (e.g. an Expo Go / web-dev run). | The card states the module is **UNAVAILABLE** and that the values are *not* a clean result — it must never present fail-safe defaults as verified. |
| 14.5 | Try to reach the rest of the app from the card. | Impossible: the card contains no dismiss, continue, verify or navigation control, and the block still stands (§10.8). |

## 15. Network lock (traffic suspended while a verification is pending)

See [NETWORK_LOCK.md](NETWORK_LOCK.md). The lock suspends the app's **own**
traffic and stops/unmounts protected media; it does not disconnect the YouTube
connection, and nothing in the UI may claim the device is offline.

| # | Step | Expected |
|---|---|---|
| 15.0.1 | Launch clean, with a session. | Protected requests are queued for the moment the first verification takes and then flow normally — no empty/error dashboard that never recovers, no restart needed. |
| 15.0.2 | Background the app while a lesson video plays, then resume. | Playback stops; the YouTube player is **not** rendered while the lock is held; after the clean verdict it loads normally from the resume position. |
| 15.0.3 | Resume and immediately open a video. | The player does not load YouTube: at most a loading/unavailable state, never audio or frames. |
| 15.0.4 | Turn on a VPN, background, resume. | Protected traffic stays blocked and the **VPN/proxy** block screen appears; no protected content is briefly visible. The queue never sends. |
| 15.0.5 | Airplane mode, background, resume. | Fails closed: no protected access granted on a timeout, and the app is not permanently stuck (recovers when the check succeeds). |
| 15.0.6 | Background/foreground 5× quickly. | One verification per resume, no deadlock, and normal traffic resumes after the last clean verdict. |
| 15.0.7 | Start a video upload (VdoCipher) as a doctor/admin, then background/resume mid-upload. | No chunk is sent while the lock is held; the upload resumes after the verdict (or reports Paused) — never a silent success. |
| 15.0.8 | Trigger a forced update or maintenance state while a verification is pending. | The flow still appears once verification clears (its GETs are queued, not refused). |

## 16. Split-screen / multi-window (mandatory full-screen usage)

MedAcademy may only run full-screen. Enforcement is a HARD block driven by the
Android window state, with no dismiss control (see `docs/MULTI_WINDOW_BLOCKING.md`
for what is and is not detectable).

| # | Step | Expected |
|---|---|---|
| 15.1 | Launch the app **directly into split-screen** (open MedAcademy from the recent-apps split view, or pair it from another app's split menu) while signed in. | The full-screen **FULL-SCREEN REQUIRED** page appears (title `FULL-SCREEN REQUIRED`, split-screen copy). No app content, no playback, no dismiss control. |
| 15.2 | While running full-screen, enter split-screen (recents → split screen). | The block appears immediately, without needing a tap or a resume. |
| 15.3 | Try to interact with the app while the block is up. | Nothing behind the page is reachable: hardware back is consumed, no route/navigation leaves it, no “Continue Anyway”, no Verify button. |
| 15.4 | Drag the app back to full-screen. | The page clears **automatically** once the fresh security evaluation lands — no restart, no manual step. |
| 15.5 | Press Home while in split-screen, then reopen the app (still split). | The block is still up after resume (the resume re-read never treats “not measured yet” as full-screen). |
| 15.6 | Put MedAcademy into **picture-in-picture** (Home / recents → PiP, on a device that supports it). | A block appears whose copy names the **floating window** — it must NOT say “split-screen” and must NOT claim an overlay was detected. |
| 15.7 | Close the PiP window and open the app normally. | Access returns automatically, as in 15.4. |
| 15.8 | Open another app in split-screen or PiP **next to / over** MedAcademy’s own full-screen window (e.g. a floating chat head, a floating-window OEM feature). | Only **MedAcademy's own** window mode is asserted. If MedAcademy itself is full-screen, no multi-window page is shown — and neither page ever claims “another app is floating over you”. (An overlay over the app is the separate overlay signal of §1/§2 behaviour.) |
| 15.9 | Confirm no new permission prompt appears. | None: multi-window detection uses `isInMultiWindowMode()` / `isInPictureInPictureMode()` — no accessibility service, no usage access, no screen capture. |
| 15.10 | Trigger a screenshot or screen recording while the multi-window page is up. | Capture stays blocked (`FLAG_SECURE` is held while any block is displayed). |

---

## Result recording

| Area | Device / OS | Result | Notes / evidence |
|---|---|---|---|
| §0 Build identity | | | signer SHA-256 vs pin |
| §1 Screenshots | | | |
| §2 Screen recording | | | |
| §3 USB debugging | | | |
| §4 Developer Options | | | |
| §5 Mock location | | | |
| §6 Emulator | | | |
| §7 Signing | | | |
| §8 Gate consistency | | | |
| §9 Startup / resume | | | |
| §10 VPN / proxy | | | finding, score, gate decision, timestamp per scenario |
| §11 Video | | | |
| §12 PDF | | | |
| §13 Role exemptions | | | |
| §14 Device security report | | | copied report text + which signal read `on` |
| §15 Network lock | | | queued requests flowed after unlock; no protected traffic or playback while pending |
| §16 Split-screen / multi-window | | | mode detected (split-screen vs PiP), page shown, auto-clear on return to full-screen |
| iOS platform integrity | | | must read DEFERRED / NOT VERIFIED — never PASS |

Record the device model, Android/iOS version, and build `versionCode` beside
each run.

### iOS platform integrity — must read `DEFERRED / NOT VERIFIED`, never `PASS`

App Attest is **temporarily deferred** (decision record:
`docs/PRODUCTION_READINESS_AUDIT.md` §8). On iOS:

| # | Step | Expected |
|---|---|---|
| iOS-1 | Sign in as **Super Admin** → **Security Diagnostics**. | Platform Integrity Enforcement shows **`DEFERRED / NOT VERIFIED`**, with the reason "Server verification not configured (HTTP 503) — enforcement intentionally inactive, NOT a pass". It must **never** display `PASS`. |
| iOS-2 | Confirm the deferral does not block anyone. | iOS users sign in and use the app normally. The deferral is a non-blocking, explicitly-unverified state — not a violation, and not something to "fix" by clearing. |
| iOS-3 | Record it as an accepted gap. | Do **not** report it as coverage. Android's Play Integrity row on the same screen is a separate, working control. |
| iOS-4 | Force-quit and reopen, then re-check iOS-1. | The status must not flip to `PASS` after a restart or a key rotation, and must not be presented as a clean result at any point. |

**Android counterpart:** §3/§4 are Android-only. On Android the same card should
show a **real verdict** from Play Integrity (`PASS` / `FAIL` / `UNAVAILABLE` /
`INCONCLUSIVE`) — `DEFERRED` on Android would indicate a regression in the
Android path.

## Known limitations to report honestly

- An app **cannot** disable system USB debugging or Developer Options — only
  detect and block (§3).
- A determined user with ADB can flip these settings back; the control is
  deterrence plus the server-side audit trail, not prevention.
- Mock-location detection depends on the OS reporting an app-op; a rooted device
  can defeat it (which is itself detected by `root_detected` / `magisk_detected`).
- Screenshot blocking prevents casual capture; it is not DRM.
