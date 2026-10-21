# Blocked-screen support contacts + unexpected logout after resume

Two unrelated defects that both surfaced on the pre-login security path. They share
**one** transport-level root cause class: requests that must be allowed to finish
were being killed by the security lock's containment.

---

## Issue A — “Could not load support contacts. Check your connection and try again.”

### What was not wrong

* endpoint: `GET /support/contact` exists (`backend/routes/api.php`) and is
  **public** (no auth middleware) — the blocked, signed-out screen can call it;
* client: `getPublicSupportContacts()` (`src/lib/api.ts`) calls that exact path and
  maps `{ contacts: [...] }`;
* the path **was already on the lock allowlist** (`LOCK_EXEMPT_PREFIXES` in
  `src/client/php.ts`) precisely so the block screen could still reach support;
* the screen already had a `Retry` action.

### Root cause

`apiFetchOnce()` passed **every** request to `registerProtectedAbort(controller)`,
including allowlisted ones. `registerProtectedAbort()` aborts the controller
**immediately when the lock is already held** — by design, so a protected request
cannot slip in behind the lock. The pre-login block screen exists *because* the
lock is held, so every allowlisted request was aborted at birth:

* `/support/contact` → “Could not load support contacts …”;
* `/security/events`, `/security/violations` → violation telemetry never reached
  the backend audit while locked;
* `/auth/logout` → an explicit sign-out notification was aborted on a locked
  device;
* `/security/policies`, `/security/config` → the verification pipeline fell back
  to fail-secure defaults instead of the authoritative policy while locked.

The allowlist was therefore dead code exactly when it mattered. This was not a
connectivity problem, not an HTTP error, not a parsing failure, and not a missing
route — the request never reached the network.

### Fix

Allowlisted traffic is verification / recovery / audit plane — it must **complete**,
never be contained:

```ts
const abortExempt = isLockExempt(path) || path.startsWith('/auth/refresh');
const unregisterAbort = abortExempt ? () => {} : registerProtectedAbort(controller);
```

Nothing else changed: the allowlist is still the same six documented prefixes, and
a request that is not on it is still queued/refused while locked.

---

## Issue B — logged out ~1 minute after returning from a ~30 min background (iOS; Android not reported)

### Session mechanism (as implemented)

PHP API + rotating opaque tokens: `POST /auth/login` → `access_token` +
`refresh_token`; `POST /auth/refresh` **rotates** the pair (single use) and revokes
the spent token; `JWT_ACCESS_TTL_SECONDS` defaults to 900 s, refresh-token TTL to
365 days (`backend/src/Auth/SessionManager.php`). The client stores the pair and
refreshes on 401 (`src/client/php.ts`), only clearing the session on a **definitive**
auth failure (`src/lib/authFailureModel.ts`).

After ~30 min in the background the access token is always expired — that is
expected and refreshable.

### Root cause

On resume, the security lock engages (containment) and **aborts every registered
in-flight request — including an in-flight `POST /auth/refresh`**. Rotation is
single-use: when the abort lands after the server has already completed the
rotation, the server has revoked the old refresh token while the client never
received the new pair. The stored credential is now dead. The next refresh — the
30 s revocation poll, once the lock clears — posts the revoked token, gets a
**definitive 401**, and the correct-by-design definitive-failure policy clears the
session. “Resumes normally, logs out about a minute later” is exactly that
sequence. The same loss occurs if iOS suspends the app mid-rotation.

Contributing: while the lock was up, `refreshAccessToken()` returned `false` and
nothing retried afterwards, so the app idled on expired-token 401s until a poll
happened to re-trigger the chain.

### Fix

1. **Never abort a rotation in flight.** `/auth/refresh` is exempt from
   `registerProtectedAbort` (still frozen while the lock is held by
   `refreshAccessToken`'s own guard + the pre-network gate — exempt from
   containment, not from the lock). It is bounded by the existing 30 s timeout.
2. **Recover deterministically after unlock.** A suppressed refresh schedules one
   post-unlock rotation through `runWhenNetworkUnlocked` (the same bounded queue
   used for other deferred work). It runs **only** after the lock has fully
   cleared, re-reads the stored session at execution time (so a sign-out or
   identity swap during the lock cannot be rotated), and on a confirmed violation
   it expires without minting credentials.

Unchanged: single-flight refresh (concurrent 401s spend one rotation), the
identity-swap discard, definitive-only session clearing, transient failures
(network/timeout/5xx/429) preserving the session, forced update, maintenance,
security blocking, and explicit sign-out.

### Residual risk

If iOS kills the app between the server completing a rotation and the client
persisting the response, the old token is still lost and the next refresh is a
legitimate 401 → re-login. Fully closing that window needs a server-side
single-use grace window for a just-rotated token, which is a security-policy
change and is **not** included here.

---

## Tests

`tests/securityLockTrafficAndSessionRecovery.test.cjs` (new) — compiled
`securityLock` + `authFailureModel` behaviour (abort-on-lock, refusal-vs-replay,
dedupe, definitive-vs-transient) plus transport/support-contact/session contracts.

`tests/networkLock.test.cjs` — allowlist minimality, abort-exemption, and the
post-unlock rotation contract.

**Not verified on a physical iOS or Android device.** Automated suites only.
