# Authentication migration — users, passwords, sessions

## How Supabase stores credentials

Supabase Auth (GoTrue) stores accounts in `auth.users` with the password as a
**bcrypt hash** in `encrypted_password` (format `$2a$10$...`). Sessions are
JWTs signed with the Supabase project's JWT secret; refresh tokens live in
GoTrue's private token tables.

## What can actually be exported with your current access

You said you have **Table Editor access, not database-owner access** (no
`pg_dump`). What that means precisely:

| Data | Exportable via Table Editor? | Notes |
|---|---|---|
| `auth.users.id` (UUIDs) | ✅ | The `auth` schema is visible in Table Editor; export as CSV |
| `auth.users.email`, `phone` | ✅ | |
| `auth.users.encrypted_password` (bcrypt) | ✅ | This is the critical column — see below |
| `auth.users.raw_user_meta_data` | ✅ | contains `full_name`, `role`, `phone` overrides |
| `auth.users.created_at / updated_at` | ✅ | |
| GoTrue refresh tokens | ❌ | private; sessions simply end — users re-login after cutover |
| `profiles` and all business tables | ✅ | main export set (see MIGRATION_DATA_REQUIREMENTS.md) |

## Can users keep their passwords? YES — with one export

**Supabase bcrypt hashes (`$2a$`) are verifiable by PHP's `password_verify()`**
— both are bcrypt; PHP accepts `$2a$`, `$2b$` and `$2y$` prefixes natively.
So the migration plan is:

1. Export `auth.users` CSV including `encrypted_password`.
2. `backend/scripts/import-auth-users.php` inserts each row into the MySQL
   `users` table **keeping the original hash**.
3. On first successful login after cutover, `AuthService` re-hashes the
   password to `$2y$` (bcrypt cost 10) transparently via
   `Password::needsRehash()`.

**The one hard requirement:** you must be able to export the
`encrypted_password` column. If your cPanel/Supabase access cannot read the
`auth` schema at all (some Table Editor plans hide it), then hashes are
unobtainable and every user must reset their password. That is the exact
technical limitation — it cannot be worked around because Supabase never
stores plaintext or a recoverable intermediate.

## What changes for users

- **Identity**: UUIDs are preserved verbatim (`CHAR(36)`), so `profiles.id`,
  `devices.user_id`, enrollments, and audit logs keep their relationships.
- **Sessions**: GoTrue JWTs cannot be re-signed by PHP (they carry Supabase's
  secret). After cutover every client refreshes its session once via
  `POST /auth/refresh` — the app already handles this. If a refresh token
  fails, the user re-logs in (same password).
- **security_version**: `SECURITY_INITIAL_VERSION` in `.env` sets the starting
  counter; bumping it after cutover force-logs-out every device
  (`AuthMiddleware` compares the JWT `sv` claim to `profiles.security_version`).

## Password flows

| Flow | Supabase | PHP |
|---|---|---|
| Login | GoTrue `/token?grant_type=password` | `POST /auth/login` (bcrypt verify) |
| Registration | `/signup` | `POST /auth/register` |
| Forgot password | `/recover` (GoTrue email) | `POST /auth/forgot-password` → `password_reset_tokens` + email |
| Reset | `/reset` | `POST /auth/reset-password` |
| Change password | RPC + GoTrue | `POST /auth/change-password` (revokes sessions) |

Emails go through PHP `mail()`/SMTP (`.env` SMTP_*); the reset link points at
the app's reset screen.
