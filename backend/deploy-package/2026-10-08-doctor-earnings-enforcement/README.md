# Deploy package — Doctor Earnings enforcement + backend security hardening

**Regenerated:** 2026-10-09 (supersedes the 2026-10-08 single-file artifact)
**Target:** `https://api.medacademy.site` (document root `backend/public`)
**Database changes:** **none** — no migration, no schema change, no data backfill
**Configuration changes:** **none required** — see `ENV-CONFIG.md` (all optional)

> **Why this package was regenerated.** The original artifact shipped only
> `RpcController.php`. That file has since changed again (the cross-user profile
> response was minimized), so its recorded hash was stale and the package's own
> preflight correctly refused to pass. Because the security-hardening pass also
> changed nine other backend files that belong to the same deployable unit — and
> introduced one new class — they are packaged here together. The preflight was
> **extended, never relaxed**: every original guard is still present, and the new
> checks are strictly additive.

---

## 1. Layout

The package mirrors the server tree, so the upload mapping is unambiguous:

```
src/Controllers/RpcController.php   →   backend/src/Controllers/RpcController.php
src/Services/RateLimitService.php   →   backend/src/Services/RateLimitService.php
...
```

Do **not** upload the package folders themselves — only the file inside each `src/`
subdirectory, into the matching `backend/src/` subdirectory.

---

## 2. What to upload (10 files — all required)

| # | Local path | Server path | What changed |
|---|---|---|---|
| 1 | `src/Controllers/RpcController.php` | `backend/src/Controllers/RpcController.php` | Earnings gate on **all six** doctor-callable surfaces; `doctorStudentProfile` now selects an explicit column allowlist instead of `SELECT *`; per-IP throttle on the two public identifier lookups. |
| 2 | `src/Controllers/SecurityController.php` | `backend/src/Controllers/SecurityController.php` | **Stops returning SQLSTATE/driver text to clients** (generic `500`, real detail to the protected log); re-throws deliberate `ApiException`s; per-account throttle on `/security/events`; `ip_address`/`device_id` are overwritten with server-observed values. |
| 3 | `src/Services/SecurityService.php` | `backend/src/Services/SecurityService.php` | Normalizes all client-supplied telemetry before insert (clamps `risk_score`, whitelists `policy_action`, bounds free text) and stops leaking SQL internals on insert failure. |
| 4 | `src/Services/RateLimitService.php` | `backend/src/Services/RateLimitService.php` | **NEW FILE** — shared fixed-window limiter. Reuses the existing `rate_limits` table. |
| 5 | `src/Services/AuthService.php` | `backend/src/Services/AuthService.php` | Throttles refresh, forgot-password (per-IP **and** per-hashed-identifier), reset-password and change-password; `login`/`register` delegate to the shared limiter with an unchanged identifier+operation so live counters are not reset. |
| 6 | `src/Controllers/AuthController.php` | `backend/src/Controllers/AuthController.php` | Per-IP throttle on `/auth/lookup` and `/auth/pre-login-check`. |
| 7 | `src/Controllers/SecurityEvidenceController.php` | `backend/src/Controllers/SecurityEvidenceController.php` | Per-account throttles on device-key registration, challenge issuance and evidence submission. |
| 8 | `src/Controllers/IntegrityController.php` | `backend/src/Controllers/IntegrityController.php` | Per-account throttles on Play Integrity / App Integrity actions. |
| 9 | `src/Services/AppReleaseService.php` | `backend/src/Services/AppReleaseService.php` | Publish/rollback failures return a generic message; detail goes to the protected log with credential-shaped values redacted. |
| 10 | `src/Services/VideoLibrarySyncService.php` | `backend/src/Services/VideoLibrarySyncService.php` | Local-reconciliation failure no longer returns driver text on a doctor-reachable route. |

### Optional (may be skipped — comment-only, no behaviour change)

| Local path | Server path | Note |
|---|---|---|
| `src/Http/Request.php` | `backend/src/Http/Request.php` | Documentation only. Records the `clientIp()` trust policy (`REMOTE_ADDR`; forwarded headers deliberately ignored). The executable line is unchanged, so skipping it changes nothing. |

### Do NOT upload

`rollback/`, `gen-manifest.cjs`, `preflight.cjs`, `verify-live.cjs`, `README.md`,
`ENV-CONFIG.md` — these are package tooling, not server code.

---

## 3. Server-side confirmation after upload

Each required file's SHA-256 is in `manifest.json` and reprinted by the preflight.
For the new file, an additional check: it must exist at all.

```bash
cd <document-root>/..            # the directory containing backend/
sha256sum backend/src/Controllers/RpcController.php
sha256sum backend/src/Services/RateLimitService.php
```

then compare against the hashes printed by `node preflight.cjs`.

---

## 4. Pre-upload check (run locally; exit 0 = safe)

```bash
cd backend/deploy-package/2026-10-08-doctor-earnings-enforcement
node gen-manifest.cjs     # only if you changed the source; refuses to sign a stale copy
node preflight.cjs
```

What it proves, grouped as it prints:

* **artifact integrity** — every required/optional file is byte-identical to its
  `backend/src/...` counterpart and matches its recorded manifest hash.
* **rollback baselines** — each baseline exists, matches its recorded hash, and genuinely
  differs from the artifact it reverses; the new file is declared delete-on-rollback.
* **php grammar + copy hygiene** — every artifact *and* rollback parses under the PHP 8
  grammar (`php-parser`; `php -l` is unavailable on this workstation), has no BOM, opens
  with `<?php` and declares `strict_types`.
* **earnings gate** — the six previously-verified structural guards (gate present in each
  of the six methods, exactly six call sites, staff-exempt, `assertEnabledFor` not
  `assertEnabled`, canonical flag key, gate ordered before the first DB write in the
  write-path, helper itself mutates nothing) plus the pre-fix rollback assertion.
* **internal-error disclosure** — across *every* packaged file: no `'DB error ['`, no
  `'Exception ['`, no `$sqlState` composition into a response, and **no `ApiException(...)`
  whose arguments contain `getMessage()`/`getCode()`**.
* **cross-user profile minimization** — no `SELECT * FROM profiles` anywhere in
  `RpcController.php`, the explicit allowlist is present, `credits`/`devices` blocks are
  gone, and **every allowlisted column exists in both shipped schemas** (so the route
  cannot 500 on one of them).
* **rate limiting** — the shared limiter reuses the existing table with
  `ON DUPLICATE KEY UPDATE`, returns `429` + `rate_limited`, refuses to lock everyone out
  when misconfigured, and **every file in the tree that references `RateLimitService` is
  in this package** (a completeness check — an omitted caller would mean an unthrottled
  path or a fatal class-not-found).
* **bucket identity trust** — `clientIp()` reads `REMOTE_ADDR`, does not read any
  forwarding header, and no packaged file falls back to a client-supplied IP header.
* **dependency completeness** — every `use MedAcademy\...` in every artifact resolves to
  a file that exists.
* **configuration reference** — `ENV-CONFIG.md` documents every `RATE_LIMIT_*` key the
  code reads, documents no key the code does not read, and the documented default equals
  the shipped default.

Recorded result for this build: see [`preflight-output.txt`](preflight-output.txt).

---

## 5. Post-upload verification (run against production)

```bash
API_BASE=https://api.medacademy.site \
SUPERADMIN_EMAIL='…' SUPERADMIN_PASSWORD='…' \
DOCTOR_EMAIL='…'     DOCTOR_PASSWORD='…' \
node verify-live.cjs
```

Exit codes: **0** all live checks passed · **1** the deployment does not enforce the flag ·
**2** incomplete (missing credentials / aborted).

It proves on the live server: `/health` reachable and unauthenticated earnings calls still
`401`; all six doctor surfaces usable with the flag **ON**; Super Admin disables
`doctor_earnings`; **all six** surfaces then return `403 feature_disabled` including a
direct raw-token API call, with a user-safe message; Super Admin stays exempt; unrelated
endpoints (`/app/version`, `/support/contact`, `/rpc/teacher-provider-permissions`,
`/auth/me`) are unaffected; a *partial* deploy is explicitly detected and reported; and
re-enabling restores access with **no reinstall and no re-login**.

Safety: it mutates exactly two things (the global `doctor_earnings` value and the test
doctor's `redeem_codes` override) and restores both in a `finally` block. `DRY_RUN=1`
reads state only.

> Rate limiting is **not** exercised by `verify-live.cjs` — deliberately. A live 429 test
> would have to exceed a real ceiling and would leave `rate_limits` rows behind. The
> limiter is covered by `tests/rateLimiting.test.cjs` locally instead.

---

## 6. Rollback

Restore **all** baselines together — they are one deployable unit. Restoring only some is
worse than not rolling back, because `AuthController`/`AuthService`/`SecurityService`
reference the new `RateLimitService` class.

```bash
# 1. copy every rollback/src/** file back over backend/src/**
# 2. DELETE backend/src/Services/RateLimitService.php  (it did not exist before)
# 3. re-run: DRY_RUN=1 node verify-live.cjs   (read-only)
```

`manifest.json → files.new_files` records the one file that must be deleted.
Rolling back restores the previous behaviour: Earnings keeps working while the flag is
off, internal SQL text is returned again, and the new endpoints are unthrottled.

---

## 7. Propagation & caching (why no reinstall is needed)

* The server evaluates the flag **per request** with a 15s internal cache
  (`FeatureFlagService::CACHE_TTL`); worst case a Super Admin toggle is visible within
  15 seconds. Rate-limit counters are likewise per request.
* The app re-hydrates flag state on cold start after profile load and on
  background→foreground resume, and treats `403 feature_disabled` as an availability
  state rather than a generic error, so a stale screen self-corrects on its next call.
* Offline behaviour is unchanged: the app falls back to its last known flag state and the
  server stays authoritative on reconnect.

---

## 8. Database / config summary

| Item | Required? |
|---|---|
| SQL migration | **No.** `rate_limits` already exists in both shipped schemas with `UNIQUE (identifier, operation, window_start)`. |
| New tables/columns | **No.** |
| `.env` changes | **No.** All 13 `RATE_LIMIT_*` keys are optional with lockout-safe defaults (`ENV-CONFIG.md`). |
| New PHP dependency | **No.** The limiter is plain PHP over the existing DB layer. |
| New Android APK / iOS build | **No.** No mobile file changes are in this package. |
| Hosting action | **None.** No hosting setting, firewall rule or IP-blocker change is part of this package. |

---

## 9. Files in this package

| Path | Purpose |
|---|---|
| `src/**` | the artifacts to upload (mirrors the server tree) |
| `rollback/src/**` | pre-change baselines for every artifact except the new file |
| `manifest.json` | hashes, server paths, per-file change summary, new-file + no-DB-change record |
| `ENV-CONFIG.md` | the `RATE_LIMIT_*` configuration reference (every key, default, scope, window) |
| `gen-manifest.cjs` | regenerates `manifest.json`; refuses to sign a stale copy |
| `preflight.cjs` | pre-upload gate (run locally) |
| `preflight-output.txt` | recorded preflight result for this build |
| `verify-live.cjs` | post-upload live verification against api.medacademy.site |
| `README.md` | this document |

## 10. Deploy checklist

- [ ] `node preflight.cjs` → all checks PASS, exit 0
- [ ] upload the **10 required** files to their mirrored `backend/src/...` paths
- [ ] optional: upload `src/Http/Request.php` (comment-only)
- [ ] server `sha256sum` matches the hashes printed by the preflight
- [ ] `node verify-live.cjs` with credentials → exit 0, `STATUS: PASSED`
- [ ] doctor account: Earnings OFF blocks the screen **and** the API; flag re-enabled → works again
- [ ] keep `rollback/` reachable until the change is pinned in git
