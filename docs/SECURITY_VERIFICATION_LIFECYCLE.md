# Security verification lifecycle (what runs, when, and what may be reused)

This document answers one question for every check in the app: **what does it
measure, and how fast can that property change?** It is the authority for why a
background→foreground resume does not re-run every expensive check, and for the
checks that must still run every single time.

Owner of the resume path: `src/lib/SecurityContext.tsx` (`requestResumeVerification`)
→ `runSecurityChecks({ scope })` in `src/lib/security.ts`.
Server enforcement is independent and never replaced by anything here.

## 1. Scopes

| scope | triggered by | meaning |
|---|---|---|
| `full` | session start, manual re-check, **pre-video re-validation**, post-update (build change), login gate | a complete, freshly measured verdict |
| `resume` | background→foreground transition (`resume`, `resume-vpn-settled`) and the periodic tick | same detectors, same policy decision, but evidence that cannot have changed while backgrounded may be reused inside its bounded window |

`runSecurityChecks()` defaults to `full`, so any caller that does not opt in keeps
the complete pipeline.

## 2. Check inventory

| check | measures | can change while backgrounded? | resume behaviour | server enforces independently? |
|---|---|---|---|---|
| VPN (`detectVPN`) | active tunnel / VPN interface | **yes** — user toggles it | always run | yes (`video_playback`, risk service) |
| proxy (`detectProxy`) | system proxy | **yes** | always run | yes |
| debugger (`detectDebug`) | debugger / USB debugging | **yes** — Settings or ADB | always run | yes |
| developer options (`detectDeveloperOptions`) | toggle state | **yes** | always run | yes |
| screen recording (`detectScreenRecording`) | capture session | **yes** — another app can start one | always run | n/a (video policy) |
| overlay (`detectOverlay`) | draw-over apps | **yes** | always run | n/a |
| root/jailbreak | device root state | practically no within the window | always run (single native batch) | yes |
| frida / xposed / magisk | hooking frameworks | practically no | always run (single native batch) | yes |
| tamper / signature (`detectTamper`, `detectAppIntegrity`) | installed binary identity | **only on install/update/restore** | always run (single native batch) | yes |
| Play Integrity / App Attest | server-attested platform verdict | **only on install/update/restore** | reused inside `PI_TTL_MS` (10 min), then re-attested | **yes** — `IntegrityService::assertActionAllowed` per protected action |
| TLS / pinning probe (`detectSSLPinning`) | presented chain vs pin | only when the TLS path changes | a **verified** pin is reused for `SSL_PROBE_REUSE_MS` (90 s); otherwise probed | **yes** — platform pinning (`network_security_config.xml`, `PinningURLProtocol`) |
| security policy fetch (`getSecurityPolicies`) | server policy rows | only when an admin edits them | cached `POLICY_TTL_MS` (5 min); version probe still runs | **yes** — policy is server data |
| session / token | server session validity | yes (revocation, expiry) | refresh only when required, single-flight | **yes** |
| forced update / maintenance | server-configured minimum build | yes | evaluated on resume | **yes** (`426`) |
| course entitlement | enrollment / permission | yes | re-read by the course payload | **yes** (`canAccess`) |

### What is never skipped

* Anything that can be invalidated by the user *while the app is backgrounded*:
  VPN, proxy, debugger, developer options, screen recording, overlay.
* Every local detector. They all read **one** cached native flag batch, so
  re-running them on resume is a single cheap call — skipping them would be a
  real weakening, not an optimisation.
* Any check whose cached evidence has expired.

### What may be reused

Only evidence that is (a) network-bound, (b) attested by the server, and (c)
already inside its own bounded TTL:

* the Play Integrity / App Attest verdict (`PI_TTL_MS`);
* a **verified** TLS pin (`SSL_PROBE_REUSE_MS`) — an *inconclusive* probe is never
  recorded, so it can never be reused as if it had passed;
* the server security-policy rows (`POLICY_TTL_MS`).

A cached pass is **never** authorization. It cannot unlock a protected action:
the server re-decides every protected request, and the client's central lock
(`securityLock.ts`) still refuses protected traffic until a post-resume verdict
that *started at or after* the resume is published.

## 3. Invalidation rules

| evidence | invalidated by |
|---|---|
| Play Integrity / App Attest verdict | expiry (10 min), app update (`clearAppAttestKey` on build change), key invalidation, server rejection |
| TLS pin pass | expiry (90 s), any failure, `invalidatePolicyCache()` |
| policy rows | expiry (5 min), version bump from `get-security-version`, `invalidatePolicyCache()` |
| the whole verdict | logout / account switch (`reset()`), a new blocking finding, `enterBackgroundHold` |

## 4. Observability

Each evaluation records per-detector wall-clock times and returns them on
`SecurityCheckResult.timings` (names + durations only — no token, id, payload or
device evidence). A single line is printed in DEV, or on a device with
`EXPO_PUBLIC_SECURITY_DIAGNOSTICS=1`:

```
[SecurityCheck][timing] scope=resume total=412ms sslReused=yes threats=0 | root=180ms vpn=95ms proxy=60ms
```

`sslReused=yes` means the TLS probe was skipped because a verified pin was
recorded inside the 90 s window. `scope` and the total are the two numbers to
compare before/after any change.

## 5. What must be true after a change here

1. Exactly **one** evaluation per resume (coalesced + chained, never dropped).
2. A resume never waits on a network probe it does not need — but a *volatile*
   signal is re-read every time.
3. A newly enabled VPN/proxy/debugger while backgrounded is detected on the next
   foreground transition (tests: `vpnRuntimeDetection`, `vpnMandatoryBlock`,
   `resumeVerification`).
4. A protected action still fails closed when mandatory verification fails.
5. A transient network error never becomes a security finding, and never becomes
   "course not found" (`src/lib/courseLoadError.ts`).
