# Namecheap / cPanel Deployment Guide — MedAcademy PHP API (Phase 1)

This guide is for **you** to perform manually in your Namecheap cPanel.
I do not have access to your hosting account — nothing here runs against
Namecheap on my side. Everything was prepared and validated locally in this
workspace (see `backend/README.md` → "Validation status").

Target: `https://api.medacademy.eu.cc` · PHP 8.x · MySQL/MariaDB · no
Composer/Node/Docker required.

---

## A. PHP version selection

1. cPanel → **Select PHP Version** (MultiPHP Manager).
2. For the domain `api.medacademy.eu.cc` (or the parent domain, which
   subdomains inherit), select **PHP 8.1 or 8.2** (8.2 preferred).
3. This backend targets PHP 8.0+ (`str_starts_with`, typed properties,
   `match`-free, union-free). Do **not** use PHP 7.x.

## B. Required PHP extensions

Enable these in **Select PHP Version → Extensions** (almost all are on by
default):

| Extension | Used by |
|---|---|
| `pdo` + `pdo_mysql` | all database access (PDO prepared statements) |
| `curl` | VdoCipher API calls |
| `fileinfo` | MIME detection for served files |
| `mbstring` | request validation (mb_strlen) |
| `json` | JSON responses / bodies (core in PHP 8) |
| `ctype`, `filter`, `date`, `hash` | validation / tokens / JWT |

`openssl` is **not** required (JWT uses `hash_hmac`).

## B2. Personalized PDF watermarking — extra requirements (optional feature)

The flattened watermark engine is only active when a teacher switches
"Personalized Student Watermark" on for a material. When it is on, delivery is
REFUSED (HTTP 503) unless the engine is fully available — the unwatermarked
original is never served as a fallback. Configure it with these `.env` keys
(add them to `backend/.env` on the server — this file is not overwritten for you):

```
PDF_WATERMARK_MODE=raster        # raster | vector | auto   (default: raster)
PDF_WATERMARK_DPI=200            # 96–400; higher = sharper but larger
PDF_WATERMARK_IMAGE_FORMAT=png   # png (lossless) | jpeg
PDF_WATERMARK_JPEG_QUALITY=85    # used only when format = jpeg
PDF_WATERMARK_OPACITY=0.15       # 0.05–0.5
PDF_WATERMARK_MAX_PAGES=150
PDF_WATERMARK_MAX_PIXELS_PER_PAGE=20000000
PDF_WATERMARK_TIMEOUT_SECONDS=180
GHOSTSCRIPT_BIN=gs
PDF_WATERMARK_FONT=              # blank = auto-detect DejaVu/Liberation/FreeSans
```

Engine requirements:

| Engine | Requires | Notes |
|---|---|---|
| `raster` (flattened, no text layer) | Ghostscript CLI reachable via `proc_open` **+** a compositor (GD with FreeType **or** Imagick) **+** a TTF font **+** FPDF | Output pages are images: no selectable text, no removable annotation |
| `vector` (FPDI/FPDF) | FPDF 1.8.x + FPDI 3 under `backend/lib/pdf` or `backend/vendor` | Keeps the text layer; used by hosts without a renderer |
| `auto` | either of the above | Prefers `raster`, falls back to `vector` |

PHP runtime limits: the web front controller does NOT raise `memory_limit` or
`max_execution_time` (only `config/config.php`, used by CLI scripts, sets
512M / no time limit). In cPanel → **Select PHP Version → Options**, set for the
`api` domain:

| Setting | Recommended | Why |
|---|---|---|
| `memory_limit` | `512M` | two truecolor render layers per page; the service also refuses a page that would exceed ~60% of this |
| `max_execution_time` | `300` or more | a multi-page render spawns Ghostscript; the request stays inside the service's own `PDF_WATERMARK_TIMEOUT_SECONDS` |

Licensing: Ghostscript is dual-licensed **AGPL / commercial (Artifex)**. See
`backend/docs/PDF_WATERMARK_LICENSING.md` before enabling the raster engine in
production — this is a decision that needs explicit approval.

Many shared cPanel hosts **disable `proc_open`** and/or have **no Ghostscript**.
In that case leave `PDF_WATERMARK_MODE=vector` (or `auto`) so watermarking keeps
working with the vector engine. Verify what the server supports AFTER upload:

```bash
cd /home/USERNAME/medacademy-api
php backend/scripts/watermark-diagnostics.php   # prints the engine + missing pieces
```

No database migration beyond `032_lesson_material_watermark.sql` is required,
and no new files need special permissions.

## C. Create / configure the API subdomain

1. In your domain registrar DNS, add the record for the subdomain
   (Namecheap control panel → **Advanced DNS** on `medacademy.eu.cc`):
   - Type `A`, Host `api`, Value = your server IP, TTL Automatic.
   - Wait for propagation (Namecheap shows the subdomain in cPanel once DNS
     resolves; you can also add it in cPanel immediately).
2. cPanel → **Domains** → **Create a New Domain** (or **Subdomains**):
   - Domain: `api.medacademy.eu.cc`
   - Document Root: leave the auto value for now; you will change it in step D.

## D. Document root

Set the document root to the **`public/`** folder of the backend, NOT the
backend root:

1. cPanel → **Domains** → **Manage** (next to `api.medacademy.eu.cc`) →
   **Document Root** → change it to:
   ```
   /home/USERNAME/medacademy-api/public
   ```
   (adjust `USERNAME` and the folder name to wherever you upload the code;
   it must be a path inside your home directory).
2. The web server will then serve **only** `public/`. Everything else
   (`src/`, `routes/`, `.env`, `storage/`, `database/`, `scripts/`) is
   **outside the web root** and unreachable over HTTP.

> Alternative: if you prefer to keep everything under `public_html`, upload
> the backend to `public_html/medacademy-api/` and set the document root to
> `public_html/medacademy-api/public`. The code folders are still not
> web-accessible because only `public/` is served.

## E. Uploading backend files

Upload the **entire `backend/` directory** from this repository to
`/home/USERNAME/medacademy-api/` (so that `backend/public` → `medacademy-api/public`).

Use any of: cPanel **File Manager** (Upload), FTP/SFTP (FileZilla), or
**Git Version Control** in cPanel.

**Do not upload**: any local `.env` you may have created for testing (upload
`.env.example` instead and create `.env` fresh on the server — step F), and
there is no `node_modules` or `vendor` to upload.

## F. Creating the environment file (secrets)

1. In cPanel **File Manager**, navigate to `/home/USERNAME/medacademy-api/`.
2. Copy `.env.example` → `.env` (File Manager → right-click → Copy), or
   create `.env` locally from `.env.example`, fill it in, and upload it **to
   `medacademy-api/`** (never inside `public/`).
3. Fill in the real values (see section "Environment variables" below and
   `backend/.env.example` for every key).
4. Permissions on `.env`: `600` (owner read/write only).

## G. MySQL credentials configuration

Your cPanel **MySQL Databases** page shows the real database/user names —
cPanel prefixes them (e.g. `medaca_medacademy`). In `.env`:

```
DB_HOST=localhost          # always localhost on cPanel — not the server IP
DB_PORT=3306
DB_NAME=medaca_medacademy  # your actual DB name
DB_USER=medaca_medacademy  # your actual DB user
DB_PASS=REAL_PASSWORD      # the password you set when creating the user
```

Requirements:
- The DB user must have **ALL PRIVILEGES** on the database (cPanel →
  MySQL Databases → "Add User To Database" → tick **ALL PRIVILEGES**).
- `DB_HOST` must be `localhost` (or `127.0.0.1`); cPanel databases do not
  accept a remote host.

## H. File permissions

With cPanel's default PHP handler (LSAPI / suPHP, PHP runs as your account
user):

| Path | Permissions |
|---|---|
| `medacademy-api/` and all subdirectories | `755` (owner rwx) |
| `*.php` files | `644` |
| `medacademy-api/.env` | `600` |
| `medacademy-api/storage/` | `755` |
| `medacademy-api/storage/logs/` | `755` (PHP writes `app.log` here) |
| `medacademy-api/storage/tmp/` | `755` |
| `medacademy-api/storage/public/` + subdirs | `755` |
| `medacademy-api/storage/private/` + subdirs | `755` |

If a folder must be written by PHP, owner-write (`755`) is enough under
LiteSpeed/suPHP. If you ever get "Storage directory is not writable", make
the folder owner-writable and re-check — do not jump to `777`.

## I. SSL / HTTPS

1. cPanel → **SSL/TLS Status** → run **AutoSSL** for `medacademy.eu.cc` and
   the `api` subdomain (AutoSSL usually covers subdomains automatically).
   If AutoSSL does not issue for the subdomain, use **Let's Encrypt SSL** in
   cPanel and issue a certificate including `api.medacademy.eu.cc`.
2. After the certificate is active, force HTTPS. In
   `medacademy-api/public/.htaccess`, uncomment/append:
   ```apache
   RewriteCond %{HTTPS} off
   RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]
   ```
   (add it above the front-controller rule) — or use cPanel's built-in
   "Force HTTPS Redirect" toggle for the subdomain.
3. Always test with `https://` — the app configures `APP_URL` with https and
   CORS against https origins.

## J. Testing GET /api/health

After upload + `.env` + docroot:

```
https://api.medacademy.eu.cc/api/health
```

Expected (DB not yet imported / not yet configured):
```json
{"status":"degraded","services":{"database":"error","api":"ok"},"timestamp":"...","error":"database_unavailable","version":"1.0.0"}
```

Expected after the schema import + working DB credentials:
```json
{"status":"ok","services":{"database":"ok","api":"ok"},"timestamp":"...","error":null,"version":"1.0.0"}
```

The response never contains credentials, secrets, paths, or stack traces.
A plain `https://api.medacademy.eu.cc/` returns the service identity block.

If you get a blank page / 500 instead of JSON:
1. Check `medacademy-api/storage/logs/app.log` and the domain's
   `error_log` (cPanel File Manager → show hidden files).
2. Run the self-check (section "Server self-check" below).

## K. Testing database connectivity

1. Run the CLI self-check on the server:
   ```bash
   cd /home/USERNAME/medacademy-api
   php backend/scripts/server-selfcheck.php
   ```
   (or use cPanel **Terminal**; the script prints a JSON report of PHP
   version, extensions, `.env` presence, JWT/VdoCipher config booleans,
   `SELECT 1` connectivity, storage writability, and route-table load —
   no secrets are printed).
2. The self-check is safe to paste into a ticket: it prints booleans and
   lengths, never values.

## L. Cron jobs

**None required for Phase 1.** The Supabase Edge Functions that ran on a
schedule (`trash-cleanup`, `video-daily-health`) become cPanel **Cron Jobs**
in Phase 2. If you want to be ready, note that cPanel → Cron Jobs uses:
`/usr/local/bin/php /home/USERNAME/medacademy-api/backend/scripts/...`

## M. Common cPanel issues and diagnosis

| Symptom | Likely cause | Fix |
|---|---|---|
| Blank page / 500 on `/api/health` | PHP error before the handler | Check `storage/logs/app.log`; set `APP_DEBUG=true` temporarily; enable display_errors via cPanel PHP selector |
| `Route not found` JSON | `.htaccess` rewrite not applied or wrong docroot | Confirm docroot = `.../medacademy-api/public`; confirm `.htaccess` was uploaded |
| `Database connection failed` | `DB_HOST` not `localhost`, wrong name/user, or missing privileges | cPanel MySQL → confirm user has ALL PRIVILEGES; `DB_HOST=localhost` |
| `JWT secret is not configured` | `.env` missing/empty | Copy `.env.example` → `.env`, generate `JWT_SECRET` |
| `.env` not loaded | Wrong location | `.env` must sit in `medacademy-api/` (parent of `public/`) |
| `Storage directory is not writable` | folder perms | chmod `755` on `storage/`, owner-write |
| Mixed content (http assets on https page) | `APP_URL` has http | Set `APP_URL=https://api.medacademy.eu.cc` |
| Email not sent | cPanel `mail()` restrictions | Configure SMTP_* in `.env` (Hostinger/Namecheap SMTP) |
| CORS blocked in browser | origin missing from allow-list | Add the web origin to `CORS_ALLOWED_ORIGINS` |
| phpMyAdmin import error on triggers | phpMyAdmin cannot run `DELIMITER` | Use cPanel Terminal (primary) or the split files (below) |

---

## Importing the MySQL schema (step 7 of the task list)

**Order:** create the database/user (done) → **import the schema** → then
configure `.env` → then test. Uploading application files and importing the
schema are independent; do the import before the first health test.

**Primary method — cPanel Terminal:**

```
mysql -u medaca_medacademy -p medaca_medacademy < backend/database/schema.sql
```
(enter the DB password when prompted). This imports tables, indexes, the
enum CHECK constraints, the appendix tables, and all triggers in one pass.

**Fallback — phpMyAdmin** (if Terminal is unavailable):
1. Import `backend/database/schema-no-triggers.sql` via phpMyAdmin → Import
   (file is ~100 KB, under the import size limit).
2. Then open the **SQL** tab, set the **delimiter box to `$$`**, paste the
   entire contents of `backend/database/triggers.sql`, and run it. (The
   split files exist precisely because phpMyAdmin cannot execute `DELIMITER`.)

**No manual cPanel database settings are required** — standard utf8mb4,
InnoDB defaults. Nothing is executed against Supabase, ever.

---

## Deployment summary (what to upload)

```
medacademy-api/                     # upload the whole backend/ folder
├── public/          → DOCUMENT ROOT for api.medacademy.eu.cc (contains index.php + .htaccess)
├── src/             → PHP application code (NOT web-accessible)
├── routes/          → route table (NOT web-accessible)
├── config/          → bootstrap config (NOT web-accessible)
├── database/        → schema.sql + split variants (NOT web-accessible)
├── scripts/         → importers + self-check (NOT web-accessible)
├── docs/            → migration docs (NOT web-accessible)
├── storage/         → PRIVATE data: logs, private files, tmp (NOT web-accessible)
├── .env             → secrets, created on server from .env.example (NOT web-accessible)
└── .env.example     → template (safe to upload)
```

Publicly accessible on the web: **only** everything under `public/` (and
`public/storage/...` if you later publish static files there).

## Server self-check (one command, after .env is in place)

```bash
cd /home/USERNAME/medacademy-api && php backend/scripts/server-selfcheck.php
```

It validates: PHP ≥ 8.0, extensions, `.env` presence, JWT/VdoCipher config
(booleans only), DB `SELECT 1`, storage writability, and that the route
table loads with `/api/health` registered. JSON output, zero secrets.

## What I validated locally (before you deploy)

- PHP 8 grammar parse: 41/41 files (glayzzle php-parser — no PHP binary on
  this machine, so `php -l` on the server is still recommended).
- MySQL DDL: 203/203 statements parse (node-sql-parser).
- SQL-vs-schema cross-check: 206 references — all tables/columns exist.
- Route table: all 56 route targets resolve to real controller methods.
- Env coverage: every config key used by the code is documented in
  `.env.example`.
- The mobile app, `src/`, and Supabase were not modified.
