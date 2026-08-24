# MedAcademy PHP Backend (Phase 1)

Replacement backend for the Supabase stack, targeting **Namecheap shared cPanel
hosting (PHP 8.x + MySQL/MariaDB)**. The Supabase backend stays fully
operational during the migration — nothing in this repository rewires the app
to this backend yet.

```
React Native / Web
      ↓ HTTPS + JWT
https://api.medacademy.eu.cc   (public/ → index.php front controller)
      ↓
PHP 8 REST API (PDO prepared statements)
      ↓
MySQL/MariaDB
      ↓
Filesystem storage + VdoCipher + SMTP/FCM/APNs
```

## Layout

```
backend/
  public/            web root — index.php + .htaccess (cPanel: point the
                     api.medacademy.eu.cc document root here)
  src/
    Controllers/     HTTP endpoints (thin)
    Services/        business logic (Auth, Security, Audit, ...)
    Middleware/      CORS, auth, error handling
    Database/        PDO connection
    Auth/            JWT (HS256), password hashing, session manager
    Security/        device checks, violations
    Storage/         public/private files + signed URLs
    Video/           VdoCipher (server-side secrets only)
    Notifications/   email (mail() / SMTP), push hooks
    Validation/      request validation
    Utils/           env, config, logger, uuid, json
  routes/api.php     route table
  database/schema.sql  MySQL DDL (generated, reproducible)
  scripts/           schema extractor/generator, CSV import tools
  docs/              edge-function & RPC/RLS migration maps
  storage/           public/, private/, logs/, tmp/ (runtime data)
  .env.example       copy to .env on the server
```

## Deployment (cPanel)

1. Upload the `backend/` directory (excluding `.env`, `storage/logs`).
2. In cPanel → **Domains**, create `api.medacademy.eu.cc` with document root
   pointing at `backend/public`.
3. Copy `.env.example` → `.env` and fill in real values (DB creds from the
   MySQL database/user you created; generate `JWT_SECRET` with
   `php -r "echo bin2hex(random_bytes(32));"`).
4. Import the schema:
   ```bash
   mysql -u medacademy_user -p medacademy < backend/database/schema.sql
   ```
5. Confirm routing works: `curl https://api.medacademy.eu.cc/health`.

No Composer, Node, Docker, or long-running processes are required.

## Reproducible schema

The MySQL DDL is generated from the real Supabase migrations:

```bash
node backend/scripts/extract-schema.mjs        # parses supabase/migrations -> schema-inventory.json
node backend/scripts/generate-mysql-schema.mjs # inventory -> database/schema.sql
node backend/scripts/validate-mysql-schema.js  # parse-check every statement (MySQL dialect)
```

## Deployment

**Step-by-step manual cPanel instructions: `NAMECHEAP_DEPLOYMENT.md`**
(phpMyAdmin/Terminal import, document root, permissions, .env, SSL,
troubleshooting). Deployment smoke test: `GET https://api.medacademy.eu.cc/api/health`
(no auth, no secrets in the response). Server-side CLI diagnostics:
`php backend/scripts/server-selfcheck.php`.

## Validation status (Phase 1)

- MySQL DDL: all statements parse as MySQL via node-sql-parser (full file
  and the phpMyAdmin split variant).
- PHP: every file is written for PHP 8.0+ and passes the PHP 8 grammar
  parser; run `php -l` on the server (this machine has no PHP binary).
- Route table, env-key coverage, and every SQL reference cross-checked
  against the schema inventory (scripts/check-*.js).
- The mobile app has **not** been rewired; `src/` is untouched.

## Phase 2 (next)

1. Port the remaining RPC-heavy services (courses builder, bulk ops, hard
   delete pipeline, trash cleanup cron → PHP cron script).
2. Push notifications (FCM/APNs) behind the existing push_tokens table.
3. Client adapter behind an env switch (EXPO_PUBLIC_API_URL) with the
   Supabase client still available for rollback.
4. Full regression suite against migrated production data.

See `docs/EDGE_FUNCTIONS_MAPPING.md`, `docs/RPC_RLS_MAPPING.md`,
`docs/AUTH_MIGRATION.md` and `MIGRATION_DATA_REQUIREMENTS.md`.
