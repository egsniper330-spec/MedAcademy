# 2026-10-07 — Live probe baseline (before deploy)

## Summary

- Health: `GET /health` → **200**.
- Support read: `GET /support/contact` → **500** with **empty body** (`size=0`, `Content-Type: text/html`, `content-length: 0`). This is NOT the app's normal `{error:{message,code}}` envelope — it is a raw PHP 500 with no JSON.
- Support write: `PUT /admin/support-settings` → **404** with body `{"error":{"message":"Route not found: POST /admin/support-settings","code":"not_found"}}`. Note the message says `POST`, not `PUT`, which indicates a Router-level mismatch on the live server relative to the local route table (`PUT /admin/support-settings → SupportController::adminUpdate`).
- Analytics/security endpoints: `GET /analytics/security-stats` and `GET /security/version` → **401** (Missing Authorization). Authenticated probes were not performed from this environment.

## Key observations

1. The support read returning `500` with an empty body is the signature we must explain and fix on the server. It is not a generic "server busy" — it is a deterministic per-request failure.
2. The support write returning `404` saying `POST` when we sent `PUT` is a strong sign the live route table does not currently have `PUT /admin/support-settings` wired as expected.
3. The backend is reachable and healthy on `/` / `/health`, so this is a route/handler/DB issue in the Support and Security paths, not a global outage.

## Probes used

```
curl -sS -m 25 -o NUL -w 'SUPPORT_GET HTTP %{http_code} size=%{size_download} time=%{time_total}\n' \
  -H 'Accept: application/json' 'https://api.medacademy.site/support/contact'

curl -sS -m 25 -o NUL -w 'SUPPORT_PUT HTTP %{http_code} size=%{size_download} time=%{time_total}\n' \
  -H 'Content-Type: application/json' -H 'Accept: application/json' -H 'Origin: https://app.medacademy.site' \
  'https://api.medacademy.site/admin/support-settings' \
  -d '{"settings":{"whatsapp":{"value":"+15550000000","label":"WhatsApp Support","enabled":true,"display_order":1}}}'

curl -sS -m 25 -o NUL -w 'ANALYTICS_STATS HTTP %{http_code} size=%{size_download} time=%{time_total}\n' \
  -H 'Accept: application/json' 'https://api.medacademy.site/analytics/security-stats'

curl -sS -m 25 -o NUL -w 'SECURITY_VERSION HTTP %{http_code} size=%{size_download} time=%{time_total}\n' \
  -H 'Accept: application/json' 'https://api.medacademy.site/security/version'

curl -sS -m 25 -o NUL -w 'HEALTH HTTP %{http_code} size=%{size_download} time=%{time_total}\n' \
  -H 'Accept: application/json' 'https://api.medacademy.site/health'
```

## Next steps

1. Fetch the live `backend/src/Controllers/SupportController.php`, `backend/routes/api.php`, `backend/src/Http/Router.php`, `backend/src/Controllers/SecurityController.php`, `backend/src/Controllers/AnalyticsController.php` and diff them against the current repo.
2. Inspect the live error log for `/support/contact` 500s and `/admin/support-settings` 404s.
3. Compare the production `support_settings` table schema against `001_add_support_settings.sql`.
4. Apply the minimal required fix only after identifying the exact mismatch.
