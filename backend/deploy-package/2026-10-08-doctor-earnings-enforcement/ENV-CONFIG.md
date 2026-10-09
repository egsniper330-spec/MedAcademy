# Configuration reference — rate limiting (`RATE_LIMIT_*`)

**Scope:** the shared fixed-window limiter (`backend/src/Services/RateLimitService.php`)
plus the two pre-existing login/registration limits it now shares an implementation
with (`backend/src/Services/AuthService.php`).

**Required keys: none.** Every key below is optional. Each is read through
`Config::int($key, $default)`, and `Config::int()` falls back to the default whenever
the key is missing *or* non-numeric — so an empty `.env` yields the defaults below and
the server behaves correctly. Do **not** block the deploy waiting on configuration.

**No secrets are involved.** These are plain integer ceilings. Nothing on this page is
sensitive, and nothing here needs to be quoted or escaped in `.env`.

---

## 1. How the values are read

* Loaded by `MedAcademy\Utils\Env::load()` into `$_ENV` (real process environment wins
  over `.env`), then read by `Config::get()` → `Config::int()`.
* Values are cached in a per-process static array and re-initialised via
  `Config::init()` at the start of a request, so a `.env` edit takes effect on the
  **next request** — no restart, no redeploy.
* An unquoted value has a trailing `#` comment stripped; a quoted value keeps it. These
  values are integers, so either form is fine.
* **`0` disables that limiter.** `RateLimitService::hit()` returns immediately when
  `$max <= 0`. Use this to turn a single ceiling off without reverting the code
  (e.g. `RATE_LIMIT_IDENTIFIER_LOOKUP_PER_MINUTE=0`).
* The counter lives in the **existing** `rate_limits` table
  (`UNIQUE (identifier, operation, window_start)`), which is already present in both
  shipped schemas — **no migration and no schema change is required.**

## 2. Bucket identity and windows

Fixed windows aligned to `time() % window`, so a counter always resets at the window
boundary — the worst case for a legitimate user is a single window, never a permanent
lockout.

| Bucket | Identifier | Chosen for |
|---|---|---|
| `ip:<REMOTE_ADDR>` | socket peer address | pre-authentication endpoints and cheap floods |
| `user:<uuid>` | authenticated account from the verified JWT | anything account-scoped |
| `id:<sha256(identifier)[0:32]>` | the *submitted* identifier, hashed | targeted mail-bombing of one account |

`Request::clientIp()` reads **`REMOTE_ADDR` only**. `X-Forwarded-For`, `X-Real-IP`,
`CF-Connecting-IP` and `Client-IP` are deliberately **not** consulted, because on a
direct-to-PHP cPanel deployment those headers are attacker-controlled and would let a
client choose its own bucket (or frame someone else's address). If this API is ever put
behind a reverse proxy, forwarded headers may only be trusted after explicitly
validating that the immediate peer is a configured trusted proxy — never by default.

**Carrier NAT:** every `ip:` ceiling is sized far above real end-user behaviour, so
hundreds of unrelated subscribers behind one carrier address cannot exhaust it. The
tight ceilings are all `user:` / `id:` scoped, which a shared IP cannot disturb.
The hashed identifier bucket stores no raw e-mail or phone number.

## 3. The keys

| Key | Default | Bucket | Window | What it bounds |
| `RATE_LIMIT_LOGIN_PER_MINUTE` | 10 | ip | 60s | credential-stuffing / password guessing at `POST /auth/login` (pre-existing) |
| `RATE_LIMIT_REGISTER_PER_HOUR` | 10 | ip | 3600s | automated account creation at `POST /auth/register` (pre-existing) |
| `RATE_LIMIT_REFRESH_PER_MINUTE` | 120 | ip | 60s | refresh-token rotation floods and token-guessing at the refresh endpoint |
| `RATE_LIMIT_FORGOT_PASSWORD_PER_HOUR` | 20 | ip | 3600s | forgot-password floods from one address (generous: shared NAT) |
| `RATE_LIMIT_FORGOT_PASSWORD_PER_ACCOUNT_PER_HOUR` | 5 | hashed identifier | 3600s | mail-bombing one mailbox; checked before the account-existence probe so the 429 cannot reveal whether an identifier exists |
| `RATE_LIMIT_RESET_PASSWORD_PER_HOUR` | 40 | ip | 3600s | reset-token guessing and endpoint floods (each success rewrites a password and revokes sessions) |
| `RATE_LIMIT_CHANGE_PASSWORD_PER_HOUR` | 20 | account | 3600s | current-password guessing by an authenticated caller |
| `RATE_LIMIT_DEVICE_KEY_PER_MINUTE` | 20 | account | 60s | device-key registration/rotation churn (writes `device_keys` rows) |
| `RATE_LIMIT_SECURITY_CHALLENGE_PER_MINUTE` | 60 | account | 60s | unbounded growth of `security_challenges` rows (each issue writes a TTL'd row) |
| `RATE_LIMIT_SECURITY_EVIDENCE_PER_MINUTE` | 60 | account | 60s | the most expensive security endpoint (canonical JSON + ECDSA P-256 verify + transactional decision write) |
| `RATE_LIMIT_SECURITY_EVENTS_PER_MINUTE` | 300 | account | 60s | telemetry flooding of `security_events`; deliberately far above one-event-per-threat batching |
| `RATE_LIMIT_INTEGRITY_PER_MINUTE` | 60 | account | 60s | Play Integrity / App Integrity actions (server-to-Google token decode, quota-bound, plus challenge writes) |
| `RATE_LIMIT_IDENTIFIER_LOOKUP_PER_MINUTE` | 60 | ip | 60s | the four **public** pre-login identifier lookups (`/rpc/check-registration-conflicts`, `/rpc/get-email-by-phone`, `/auth/lookup`, `/auth/pre-login-check`) — an unthrottled phone→e-mail or account-existence oracle otherwise |

## 4. Suggested `.env` block (entirely optional)

```
# Rate limiting — all keys optional; omit to use the defaults in ENV-CONFIG.md.
# Set any key to 0 to disable that single limiter.
RATE_LIMIT_IDENTIFIER_LOOKUP_PER_MINUTE=30
```

Left unset, everything above uses the defaults, which are chosen to be lockout-safe
rather than maximally restrictive. Raise a value only if real users are being limited;
lower it only with the shared-NAT trade-off in mind.

## 5. Response contract

A refused request returns **HTTP 429** with the existing envelope, unchanged from the
historical `AuthService` behaviour, so no client change is needed:

```json
{ "error": { "message": "Too many attempts. Please try again later.",
             "code": "rate_limited" } }
```

## 6. Reading a deployment log

The limiter writes nothing to the log on the happy path. To confirm it is active after
upload, exercise any throttled endpoint more than its ceiling allows within one window
and expect `429` + `code: "rate_limited"`; the counter row is visible in the
`rate_limits` table as `(identifier, operation, window_start, request_count)`.
Operations are namespaced (`auth`, `auth_refresh`, `auth_forgot_ip`, `auth_forgot_id`,
`auth_reset_ip`, `auth_change_password`, `identifier_lookup`, `security_events`,
`security_device_key`, `security_challenge`, `security_evidence`, `integrity_play`,
`integrity_app`), so a `429` on one flow never affects another.
