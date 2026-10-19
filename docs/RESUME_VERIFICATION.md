# Background → Resume Security Verification

How MedAcademy verifies a session when the app returns to the foreground, why the
app shell comes back immediately, and what stays blocked until the decision is made.

**Scope of the change:** the *presentation* and *scheduling* of the resume check.
No detector, risk weight, policy action or risk threshold was changed.

---

## 1. Root cause of the old "VERIFYING YOUR SESSION" stall

The resume hold was rendered as a full-screen page and its release depended on a
**post-resume evaluation being published**. Three defects made that take a long
time (sometimes until the 30 s periodic cycle), on clean devices:

1. **Dropped concurrent evaluations.** `runEvaluation()` held a single-flight
   guard that *refused* a request arriving while an evaluation was running
   (`if (checkRef.current) return null`). A resume that happened while the
   launch/periodic/VPN evaluation was running therefore did **not** produce a
   post-resume evaluation at all. The hold had nothing that could clear it until
   the next periodic tick.
2. **The Continue button could not fix that state.** It called `verifySecurity()`
   → `check()` → `runEvaluation()`, hit the same in-flight guard, got `null`, and
   the page stayed. The control looked actionable and did nothing — which is why
   the screen *appeared* to require Continue and then ignore it.
3. **The blocking boundary was in the wrong place.** The full-screen page was the
   only thing withholding the app, so the page had to stay until the (network-
   bound) evaluation finished. Every resume paid the full cost of the pipeline —
   native bridge batch + policy/config fetch + Play Integrity nonce/verdict —
   even though only *protected operations* needed to be withheld.

Evidence: `tests/resumeVerification.test.cjs` Part 2 (queue semantics, "the
in-flight early-return is gone", "the request is fired, never awaited") and Part
3 ("the VERIFYING YOUR SESSION page is gone from the app").

---

## 2. The flow now

```
AppState 'background'
  ├─ engageSecurityLock(LOCK_SRC_BACKGROUND, { hard: true })
  │    → abort in-flight protected requests, stop protected playback
  ├─ protected screens keyed on securityLockHard unmount native players
  └─ transport refuses every non-allowlisted request

AppState 'active'
  ├─ resumeToken++            (older evaluations become ineligible)
  ├─ hold stays engaged       (containment is unchanged)
  ├─ app shell restored immediately — no verification page
  └─ requestResumeVerification(reason)
       ├─ markResumeHoldEngaged()                 (monotonic timestamp)
       ├─ runEvaluation(reason)                   (queued, never dropped)
       └─ watchdog at RESUME_VERIFICATION_TIMEOUT_MS (8 s)
            → marks overdue (evidence) and retries ONCE; never unlocks

verdict lands
  ├─ clean, started at/after the resume → release hold, record duration
  ├─ VPN/proxy block                    → BLOCKED_VPN page (connection copy)
  └─ any other policy block             → BLOCKED_SECURITY_VIOLATION page
```

The gate state remains the single decision (`resolveSecurityGateState`), but the
question "must protected content be withheld?" (`isGateBlocked`) is now separate
from "does this cause take over the screen?" (`rendersBlockScreen`).
`BLOCKED_BACKGROUND_RESUME` is the only blocking state that renders **no page**.

### Precedence (changed deliberately)

```
BLOCKED_OVERLAY > BLOCKED_MULTI_WINDOW > BLOCKED_VPN > BLOCKED_SECURITY_VIOLATION
                > BLOCKED_BACKGROUND_RESUME > CHECKING > ALLOWED
```

A confirmed violation outranks the interim resume hold **for display**, because
the hold renders nothing: if it outranked the policy states, a violation found
during a resume would be masked and the user would face refused requests with no
explanation. Containment is unaffected — the hold is a lock holder, and every
holder must release before the app is usable.

---

## 3. What may be reused (evidence policy)

`RESUME_VERIFICATION_EVIDENCE_POLICY` in `src/lib/securityStateModel.ts`:

| Rule | Value |
|---|---|
| Reuse a verdict across a resume | **never** (`acceptsResumeVerification`) |
| Reuse sub-measurements inside one evaluation | within their own TTL |
| Release requires an evaluation that started at/after the resume | yes |
| Timeout releases protected access | **never** (`isResumeVerificationOverdue` is reporting only) |

Safe reuse is therefore *within* a pipeline run, not *across* a resume:

* **Native flag batch** — one bridge call per evaluation (`getNativeSecurityFlags`
  is warmed once and every detector reuses it). No per-detector bridge chatter.
* **Policy/config caches** — long TTL, refreshed by `checkAndRefreshSecurityConfig`;
  a queued re-run chained immediately after a previous run reuses them.
* **Detector concurrency** — the 14 detectors run under one `Promise.all`, each
  bounded by `DETECTOR_TIMEOUT_MS`. No detector waits for an unrelated one.

Invalidated by: a native signal (VPN/window-mode/overlay change), a network
change, **any** foreground transition (`resumeToken++`), and a session identity
change. A verdict from before those events can never clear a newer hold.

---

## 4. Central enforcement (client boundary)

`src/client/php.ts` refuses every protected request **before network I/O** while
`isSecurityLocked()` is true. The complete allowlist:

| Path | Why it must flow |
|---|---|
| `/security/policies`, `/security/config` | the evaluation itself; blocking it would deadlock recovery |
| `/security/events`, `/security/violations` | the violation report is the audit trail |
| `/auth/logout` | a locked user must always be able to sign out |
| `/support/contact` | public, read-only; the block screen's support contacts |

`/auth/refresh` is deliberately **not** exempt — token rotation is protected
activity. Playback: `registerPlaybackStopper` + the `securityLockHard` keys on the
lesson/offline screens unmount the native player and WebView on the hard lock.

> This is a **client-side** boundary. It stops the app from issuing/continuing
> protected operations; it is not a server security boundary. The backend keeps
> enforcing policy per endpoint (see §7).

---

## 5. Failure and indeterminate results

| Situation | Behaviour |
|---|---|
| Evaluation throws | Not published (no synthetic block page); the caller of a sensitive action still receives the fail-closed sentinel |
| Mandatory check unresolved past 8 s | Recorded as overdue, retried once, hold stays engaged — no authorization |
| Detector unavailable / timed out | Reportable evidence (e.g. VPN degraded), never a finding and never a "clean" claim |
| Coalesced/superseded result | `null` — never treated as a verdict |
| Verification succeeds | Hold released without remount/reload; queued work continues |

---

## 6. Automated coverage

`tests/resumeVerification.test.cjs` (82 checks) — resume state model, queue,
timing, gate presentation, containment, failures, exemptions, plus regressions.
Related suites: `securityGateState`, `securityLock`, `securityStartupFlash`,
`multiWindowGate`, `overlayLifecycleWiring`, `vpnMandatoryBlock`,
`vpnRuntimeDetection`, `serverSideSecurityEnforcement`, `securityParamAuthorityGuard`.

---

## 7. Backend

No backend change was required for this work: the resume check is a **client**
re-evaluation of the same authoritative endpoints, and no API contract changed.
Backend files must not be re-uploaded for this change. Server-side enforcement
of security state remains as previously shipped (`SecurityController`,
`SecurityRiskService`, `AuthMiddleware`).

---

## 8. Not verified here

Automated suites and validation scripts only. Physical-device confirmation is
still required for: real resume latency, Android player unmount timing on a hard
lock, PiP/split-screen transitions on the resumed activity, and iOS App Attest /
Play Integrity behaviour on a slow network. Use §9 of
[DEVICE_VALIDATION_CHECKLIST.md](DEVICE_VALIDATION_CHECKLIST.md).
