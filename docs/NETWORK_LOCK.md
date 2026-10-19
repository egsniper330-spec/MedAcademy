# Network lock — app traffic suspended while a mandatory verification is pending

The app's **own** network traffic is temporarily suspended whenever a mandatory
security verification is pending, and restored automatically the moment a clean
verdict lands. No restart, no user action, no "Continue".

Canonical scope list (also exported and asserted in tests):
`NETWORK_LOCK_SCOPE` in [src/lib/securityStateModel.ts](../src/lib/securityStateModel.ts).

---

## 1. When the lock is engaged

| Trigger | Where | Mode |
|---|---|---|
| App **start** (a session exists, no verdict published in this process) | `SecurityContext` session effect — `enterBackgroundHold('session-start')` | hard |
| **Resume** from background (and the instant the app is backgrounded) | AppState listener — `enterBackgroundHold('appstate=…')` / `'resumed'` | hard |
| Native **VPN/proxy transport** signal (before the verdict) | `nativeStateChanged` handler | soft (provisional) |
| Confirmed **policy violation** | verdict effect — `LOCK_SRC_VERDICT` | hard |
| Live **obscured-window** signal / prohibited **window mode** | native overlay + window-mode handlers | hard |

All holders compose by source name, so one release can never clear a lock another
holder still owns.

## 2. When it is released — and when it is not

- **Clean verdict that started at or after the event** → released
  (`acceptsResumeVerification` + `resolveBackgroundResumeGate`), queued work flows.
- **Confirmed violation** → the verdict holder stays engaged; that holder is only
  released by a fresh clean verdict. Queued work **expires instead of sending**.
- **Failed / indeterminate verification** → nothing is published, so no release.
  The 8 s watchdog reports it and retries the evaluation **once**; a watchdog fire
  is never authorization. The deferral bound then refuses queued requests.

## 3. What the lock covers (and what it cannot)

**Covered — the app's own traffic**

| Path | Behaviour while locked |
|---|---|
| Central API client (`apiFetch` / `apiFetchOnce`, [php.ts](../src/client/php.ts)) | Queued before any network I/O, deduplicated, bounded, replayed **once** after a real unlock; refused (`SECURITY_LOCK`) at the bound |
| In-flight registered requests | Aborted immediately by containment (`registerProtectedAbort`) |
| Direct storage upload (`/storage/upload`) | Refused (a write is never queued for replay) |
| VdoCipher chunk uploads ([vdoCipherUpload.ts](../src/lib/vdoCipherUpload.ts)) | Held between chunks, resumed after unlock; a bound expiry is reported as **paused** |
| Protected playback | Hard lock → native player unmounted, WebView load stopped, Plyr paused, cross-origin frame detached |

**Not covered — connections the app cannot intercept**

| Path | Reality |
|---|---|
| YouTube embed inside the player WebView | It opens its own connection to YouTube. A JS-layer gate cannot block it. |
| An already-established native media stream that ignores `pause()` | Not revoked by stopping new requests. |
| Anything the OS or another app does | Never touched — the restriction is scoped to MedAcademy. |

**Mitigation used instead** (never a socket-level block): stop the load, pause the
player, detach the frame, **and do not render the player at all** while the lock
is held — `lesson/[id].tsx` gates the player on `!blocksVideo && !securityLockHard`,
and a player that still manages to mount during the lock is stopped on
`registerPlaybackStopper` registration.

### Options considered for a true app-wide block (none implemented)

1. **Block the WebView's own requests** (`onShouldStartLoadWithRequest`, an empty
   `originWhitelist`, or a custom WebView client that cancels non-app URLs).
   *Tradeoff:* the player document is served as inline HTML with a `baseUrl`, so
   the YouTube iframe is a same-document child frame — blocking it reliably means
   denying everything the player needs, i.e. the player cannot work at all while
   locked. That is what we already achieve by not rendering it; doing it inside
   the WebView adds surface without adding guarantees.
2. **Platform network enforcement** (a local `VpnService`, a DNS/proxy hook, or an
   `NSURLProtocol`/URLSession interceptor).
   *Tradeoff:* device-wide or app-wide interception, extra permissions, Play
   policy risk, and it changes the user's networking. **Not used** — explicitly
   out of scope without approval, and the requirement is that only MedAcademy is
   affected.
3. **Certificate installation / Accessibility privileges.** Never used.

Therefore: **the app is not "offline" while locked.** Its own API traffic is
suspended and protected media is stopped/unmounted; the YouTube connection is
handled by containment (stop + teardown + not rendering the player), not by a
network block, and no status message claims otherwise.

## 4. Allowlist (the only traffic that bypasses the lock)

| Path | Why it must flow |
|---|---|
| `/security/policies`, `/security/config` | the evaluation itself **and** the VPN whitelist it reads — blocking these would deadlock recovery |
| `/security/events`, `/security/violations` | the violation report is the audit trail |
| `/auth/logout` | a locked user must always be able to sign out |
| `/support/contact` | public, read-only; the block screen's support contacts |

Deliberately **not** exempt: `/auth/refresh` (token rotation is protected
activity) and everything else. Forced-update (`/app/version`) and maintenance
(`/maintenance`) are ordinary GETs, so they are **queued** rather than refused —
they appear as soon as verification clears, and a permanent block keeps them
refused (the security screen dominates).

## 5. Root causes this change fixes

1. **`NETWORK_LOCKED` state existed only implicitly.** Now named
   (`resolveNetworkAccessState`), exposed on the context (`networkLocked`,
   `networkAccessState`) and documented with its real scope.
2. **The session-start verification never ran.** The immediate check called
   `runPeriodicCheckRef.current()` *before* the ref was assigned, so it invoked an
   inert initializer; the first authoritative evaluation waited for the 30 s
   interval tick. Fixed by assigning first, then calling.
3. **No lock at app start.** A session now engages the hold before its first
   verification, so protected traffic cannot flow unverified.
4. **The resume verification dropped its result.** Only `check()` and
   `runPeriodicCheck` published, so a clean post-resume verdict could not release
   the hold — the app stayed locked until the next periodic tick (up to 30 s).
   All triggers now share one `publishVerdict` path.
5. **Locked requests were refused outright.** Screens that mounted in the window
   showed error/empty states forever. They are now queued (deduplicated by
   method+path+body, bounded, replayed once) — a non-idempotent call still
   executes **once**.
6. **VdoCipher chunk uploads ignored the lock** (their own connection). They now
   hold between chunks and resume after unlock.

## 6. Queue semantics

`runWhenNetworkUnlocked(key, run, timeoutMs)` in
[securityLock.ts](../src/lib/securityLock.ts):

- lock clear → `run()` executes immediately;
- lock held → queued; identical keys **join** the existing entry (one execution);
- after a real unlock the run executes **once**, re-reading headers/token/timeout;
- a **re-engage** between the unlock and the run makes it refuse (nothing is sent
  behind a lock);
- bound expiry → `{ ran: false }` → `SECURITY_LOCK` refusal. A bound is never
  authorization.

Diagnostics: `networkLockMs`, `networkUnlockMs`, `deferredProtectedRequests`,
`deferredRequestsExpired` (`getContainmentDiagnostics()`).

## 7. Tests

`tests/networkLock.test.cjs` (79 checks) — model/vocabulary/scope, wait + queue +
dedupe + bound + re-engage behaviour against the real compiled module, transport
wiring and allowlist, context triggers/ordering/publishing, the ten playback
scenarios, upload holding, and honesty guards (no device-wide blocking mechanism,
no "YouTube is blocked" claim). Related: `securityLock`, `resumeVerification`,
`vpnMandatoryBlock`, `serverSideSecurityEnforcement`, `securityParamAuthorityGuard`.

## 8. Not verified

No device testing was performed. Unverified on hardware: real unlock latency after
a resume, Android player unmount timing, WebView `stopLoading` behaviour mid-media,
and whether an established YouTube connection drains its buffer before teardown.
No backend change was required and no backend endpoint was made public.
