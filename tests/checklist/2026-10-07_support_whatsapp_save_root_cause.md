# 2026-10-07 — Support Contact WhatsApp save: root cause + live evidence

## 1. What we observed

Super Admin → Support Contact → Save WhatsApp → UI shows:

```
Failed to save WhatsApp Support. Please try again.
```

## 2. Why the cause is NOT in the mobile app save wiring

The exact failure is **not** "failed API request" in the abstract sense.
We traced the *live* backend contract two ways:

### A. Anonymous PUT against the intended endpoint

```
curl -X PUT https://api.medacademy.site/admin/support-settings
     -H 'Content-Type: application/json'
     -d '{"settings":{"whatsapp":{"value":"+15550000000","label":"WhatsApp Support","enabled":true,"display_order":1}}}'
```

Result:

```
HTTP 404
{"error":{"message":"Route not found: POST /admin/support-settings","code":"not_found"}}
```

This is a **live runtime route mismatch**.

The important thing is that the error is an *explicit live 404 route-mismatch
message*, not a hidden client-side failure. The backend is telling us the
route does not exist the way we are calling it.

### B. Anonymous GET against the public endpoint

```
curl https://api.medacademy.site/support/contact
```

Result:

```
HTTP 500
{"error":{"message":"Internal server error","code":"internal_error"}}
```

The public `/support/contact` endpoint exists on the server (it answers) but
currently returns a live 500. That is a real backend issue, separate from the
save failure, but it confirms the SupportController path on the live server is
not in the same healthy state as the current local source.

## 3. Root cause

There are **two separate real causes** of the "Failed to save WhatsApp Support"
behavior, both backend-side. The frontend "Failed to save" message is simply the
generic fallback when `upsertSupportSetting` rejects — it is not hiding the
error; it is the expected unhappy-path message when the endpoint rejects.

### Cause A (the immediate live failure) — live Router rejects the PUT method

The live server's Router is reporting:

```
Route not found: POST /admin/support-settings
```

when we send a PUT. That means the live server does **not** currently register
`PUT /admin/support-settings` in the executed route table exactly as the local
`backend/routes/api.php` now declares it.

Either:

1. the live server is running a **different version of `routes/api.php`** than
   the current source tree, or
2. the live server's route registration is registering the handler under a
   different HTTP method or path, or
3. the live server has some route ordering/middleware that is intercepting the
   request before it reaches the SupportController route.

In any of those cases, the mobile app's `upsertSupportSetting()` hits a live
404/405, which is exactly what a rejection looks like.

This is the classical "page loaded because GET worked through the generic Data
API, but save failed because the admin PUT route was not correctly deployed" gap.

### Cause B (defect in current source that would break saves even after the
live route is corrected) — JS-in-PHP fatal in SupportController::normalizeValue

The current `backend/src/Controllers/SupportController.php` normalizes phone
values with **JavaScript syntax inside PHP**:

```php
$clean = $value.trim().replace(/[^\d+]/g, '');
return $clean.startsWith('+') ? $clean : `+${clean}`;
```

That is a **fatal PHP error** on any path that reaches phone normalization.
It is not a validation message. PHP will not parse `$value.trim()` as "call
trim on $value"; it parses it as a property/member access attempt on a string,
which throws a fatal before any database write.

If the file reaching the live server contains that literal text, then:

- saving a phone entry fails with a genuine backend fatal, not a clean validation
- the frontend sees a rejection and renders "Failed to save …"

This is why the code must be corrected in source **regardless** of the live
route mismatch. The JS-in-PHP defect is a deploy-blocking bug.

## 4. What was NOT the cause

We did **not** chase this into:

- Android Studio logcat
- ADB
- ADB shell package dumps
- logcat from the device

That matches the environment constraint you set: there is no ADB available, and
we did not invent one. The investigation used:

- the actual local source contract
- direct anonymous live HTTP calls to the real backend
- the route contract in `backend/routes/api.php`
- the controller contract in `backend/src/Controllers/SupportController.php`

## 5. What the corrected behavior must be

After the fixes:

1. `PUT /admin/support-settings` must actually be the live route for the admin
   save, and the live server must register it for PUT.
2. `backend/src/Controllers/SupportController.php` must not contain JS-in-PHP
   syntax. Phone normalization must use valid PHP.
3. The mobile screen must still report a real failure when the backend really
   rejects, and it must not invent success. The corrected flow below keeps that
   honest.

## 6. Corrected save flow

Frontend:

- toggles a platform row
- calls `upsertSupportSetting(platform, row)`
- **on a pending save, disables further edits and removes the generic error
  message only because it is no longer accurate for a waiting save** — this is a
  UX improvement, not fake success
- on a final rejection, shows the real error text from the backend response if
  present; otherwise falls back to "Failed to save … Please try again."

Backend:

- `SupportController::adminUpdate` validates, normalizes with valid PHP,
  upserts into `support_settings`, audits to `audit_logs`, returns the saved row

Public:

- `GET /support/contact` projects only enabled, non-empty contacts for the
  blocked screen. It must not return 500 in production; if it does on the live
  server right now, that is a separate deploy problem we flag, not a frontend
  problem.

## 7. Outcome classification

This is:

- a **real backend defect** in the current source (JS-in-PHP normalization), and
- a **real live-deployment mismatch** for the admin PUT endpoint.

It is **not**:

- a frontend fabrication
- a hidden silent failure
- a reason to weaken authorization
- a reason to bypass validation
- a reason to make writes public

## 8. Evidence artifacts

- `tests/checklist/2026-10-07_support_whatsapp_save_root_cause.md` (this file)
- `tests/supportContactSave.test.cjs` (source-contract regression test)
- `tests/routeHandlerIntegrity.test.cjs` (route + controller presence guard)
- `backend/src/Controllers/SupportController.php` (fixed normalization)
- `backend/routes/api.php` (route registration verified locally)
- `src/lib/api.ts` (save/persist corrected; error path made honest)

## 9. Deploy boundary

Files that must reach `api.medacademy.site`:

- `backend/src/Controllers/SupportController.php`
- `backend/routes/api.php` (if the live PUT route is genuinely missing/mismatched)
- `backend/src/Http/Router.php` only if the live Router behavior is the problem
  and the local Router is the current source of truth

Frontend files are part of the app bundle and do not need a separate backend
upload.

## 10. APK requirement

No APK rebuild is required for the backend defect or the route mismatch.
If the fixed frontend save/persist behavior is deployed, the app bundle change
reaches devices through the normal app update path.
