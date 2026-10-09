# 2026-10-07 — Production deploy plan (Security Dashboard + Support Contact)

## Confirmed live state (probed 2026-10-07, pre-deploy)

| Probe | Result | Meaning |
|---|---|---|
| `GET /health` | 200 JSON | Backend + DB reachable |
| `GET /support/contact` | **500, EMPTY body, `text/html`** | PHP **fatal/parse error** at autoload of `SupportController.php`. A caught exception would render the JSON `internal_error` envelope (as every other route does) — an empty body cannot come from the app's ErrorHandler. |
| `PUT /admin/support-settings` (correct `-X PUT`, no auth) | **401 Missing Authorization** (JSON) | The **PUT route EXISTS on live**; auth middleware runs. The earlier "404 POST" results were probe artifacts (`-d` without `-X PUT` sends POST). `routes/api.php` on live is current for Support. |
| `GET /maintenance`, `GET /app/version` | 200 JSON | All other controllers parse fine — the failure is isolated to SupportController. |

## Root causes

1. **Support Contact (both the public 500 and the in-app "Failed to save WhatsApp")**
   The live server runs the **pre-fix `backend/src/Controllers/SupportController.php`** containing
   JavaScript syntax inside PHP (`$value.trim().replace(/[^\d+]/g, '')` / `` `+${clean}` ``).
   PHP throws a **parse error when the class is autoloaded** → fatal → 500 with empty body.
   - `GET /support/contact` runs with no auth → autoload fires immediately → empty 500.
   - The app's authenticated `PUT` passes auth, then autoloads the same file → fatal → the app
     shows its fallback "Failed to save WhatsApp Support. Please try again."
   The local repo already contains the fixed file (PHP `preg_replace` normalization) — it was fixed
   in source but **never uploaded**.

2. **Production DB missing `display_order`**
   Confirmed by the owner's own phpMyAdmin error: `#1054 - Unknown column 'display_order' in 'INSERT INTO'`.
   Production's `support_settings` predates the column. Even with a fixed controller, both
   `publicContact` (SELECT) and `adminUpdate` (INSERT/UPSERT) reference `display_order`.
   Additionally, the migration's `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` is **MariaDB-only
   syntax** — on MySQL it is itself a syntax error, which is why the migration could never apply.
   Fixed in `backend/database/mysql-migrations/001_add_support_settings.sql` (v3) with an
   INFORMATION_SCHEMA-guarded PREPARE that works on MySQL and MariaDB.

3. **Security Dashboard "Internal server error"**
   Distinct failure mode: the dashboard sees the JSON `internal_error` envelope (a **caught**
   Throwable), not an empty-body fatal. Requires server-side file comparison of
   `AnalyticsController.php` / `SecurityController.php` + app logs to pin down (the four dashboard
   endpoints are auth-gated so they cannot be probed anonymously). **Step 1 of server access is to
   fetch those live files and diff against the repo** — the same stale-deploy pattern as #1 is the
   prime suspect.

## Deploy — file upload (minimum required)

| File | Why |
|---|---|
| `backend/src/Controllers/SupportController.php` | REQUIRED — replaces the parse-error file; fixes public 500 + save failure (incl. phone normalization). |

Upload ONLY if the post-fix probe shows a missing route (currently NOT expected — PUT route already live):
| `backend/routes/api.php` | Only if `PUT` probe returns 404 after deploy. |

## Deploy — database (run in phpMyAdmin, statements in order)

Execute the fixed `backend/database/mysql-migrations/001_add_support_settings.sql` (v3), or just
this minimal fragment against the production DB:

```sql
SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'support_settings'
     AND COLUMN_NAME  = 'display_order');
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE `support_settings` ADD COLUMN `display_order` INT NOT NULL DEFAULT 0 AFTER `enabled`',
  'SELECT ''display_order already exists'' AS note');
PREPARE _ddl_stmt FROM @ddl;
EXECUTE _ddl_stmt;
DEALLOCATE PREPARE _ddl_stmt;
```

Non-destructive: adds one column if missing; touches nothing else; never re-imports schema.sql.

## Post-deploy verification

1. `GET https://api.medacademy.site/support/contact` → expect **200** `{"contacts":[...]}` (empty list is correct until a contact is enabled).
2. `PUT /admin/support-settings` no-auth → still **401** (authorization intact, NOT weakened).
3. In-app: Super Admin → Support Contact → save WhatsApp → success; reload shows saved value.
4. `GET /support/contact` returns the enabled WhatsApp contact with `platform: "whatsapp"` and the normalized `https://wa.me/...` URL, and no admin-only fields.
5. Security Dashboard: diff live `AnalyticsController.php` + `SecurityController.php` vs repo; read app log (`Logger` output) for the exact exception; deploy corrected files as indicated; re-test in Preview.

## Constraints honored

- Super Admin authorization untouched; no endpoint made public; no security middleware disabled.
- Production `.env`/secrets untouched; no unrelated files modified or deleted; no destructive SQL.
