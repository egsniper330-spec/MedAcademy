# MedAcademy — Production Data Migration Requirements

Everything below is derived from the real schema
(`supabase/migrations/`, parsed into `backend/scripts/schema-inventory.json`).
You do **not** need `pg_dump` — every table listed can be exported from the
Supabase **Table Editor → Export as CSV**.

> ⚠️ Do not delete, truncate, or modify Supabase. The old backend stays the
> source of truth until the PHP backend passes the full regression suite.

---

## 1. Tables that MUST be exported from production (ordered)

Export **in this order** (FK dependencies). CSV columns must use the exact
table column names.

| # | Table | Why | Notes |
|---|---|---|---|
| 1 | `auth.users` | credentials + identities | keep `id`, `email`, `phone`, `encrypted_password`, `raw_user_meta_data`, `created_at`, `updated_at`. **The password hash column is the critical one** (see docs/AUTH_MIGRATION.md) |
| 2 | `profiles` | users, roles, status, watermarks, pricing | `id` must match `auth.users.id` |
| 3 | `universities`, `faculties`, `academic_levels` | academic structure | |
| 4 | `categories` | course categories | |
| 5 | `devices` | device binding + trust state | |
| 6 | `courses` | courses + pricing + contact fields | |
| 7 | `sections`, `lessons`, `lesson_pdfs`, `lesson_materials` | LMS content | keep `video_id` (VdoCipher) and storage paths |
| 8 | `enrollments`, `lesson_progress` | enrollments + progress | |
| 9 | `credits`, `credit_transactions` | doctor credits | |
| 10 | `activation_codes`, `code_batches` | activation codes | |
| 11 | `notifications` | user notifications | |
| 12 | `assistant_permissions` | assistant ACLs | |
| 13 | `system_config`, `feature_flags`, `app_branding`, `app_pages`, `maintenance_whitelist` | config/branding | |
| 14 | `course_templates` | course templates | |
| 15 | `video_uploads`, `upload_sessions`, `video_assets` | video state (VdoCipher IDs) | |
| 16 | `video_providers`, `video_provider_config`, `provider_registry`, `teacher_provider_permissions` | provider config | |
| 17 | `subscription_timeline` | subscription history | |
| 18 | `security_config`, `security_policies`, `security_vpn_whitelist`, `content_protection_policies`, `deletion_records`, `trash_config` | security configuration | |
| 19 | `push_tokens` | push device tokens | |
| 20 | `platform_earnings_resets`, `doctor_pricing_history` | earnings config history | |
| 21 | `doctor_earnings_events` | earnings ledger | export **before** `enrollments` is imported into MySQL? No — import after; it references profiles/courses/students by UUID |

## 2. Tables that are RECREATED, not exported

| Table | Why recreate |
|---|---|
| `audit_logs` | history is useful but optional; the PHP backend writes its own. **Export if you want the audit trail** (large) |
| `login_history`, `rate_limits`, `idempotency_keys` | runtime/transient |
| `video_health_scans`, `video_health_alerts`, `video_daily_health_reports`, `provider_audit_log`, `bulk_import_jobs` | operational/derived |
| `security_events`, `content_protection_violations`, `fraud_flags`, `play_integrity_nonces`, `course_lifecycle_logs` | operational (export `fraud_flags` if you want the fraud history) |
| Views (`credit_ledger_view`, `revenue_analytics`, …) | recomputed by the API/analytics queries |

## 3. Data that cannot currently be obtained

| Item | Why | Impact |
|---|---|---|
| GoTrue refresh tokens | private to Supabase Auth | All sessions end at cutover; one re-login per user. `POST /auth/refresh` handles the app side automatically where possible |
| GoTrue email-confirmation/recovery tokens | private | unconfirmed accounts need re-verification (rare in practice) |
| `auth.users.encrypted_password` | **only if** your Table Editor access hides the `auth` schema | if unavailable, **every user must reset their password** — see docs/AUTH_MIGRATION.md |

## 4. Storage (Supabase Storage) — what to copy

Buckets created in `00002_create_storage_buckets.sql` (plus later ones):

| Bucket | Visibility | Target |
|---|---|---|
| `avatars` | public | `backend/storage/public/avatars/` |
| `course-images`, `course-covers`, `lesson-thumbnails` | public | `backend/storage/public/<bucket>/` |
| `app-assets` | public | `backend/storage/public/app-assets/` |
| `lesson-pdfs`, `lesson-materials` | private | `backend/storage/private/<bucket>/` |
| `video-chunks` | private (transient) | not migrated — chunk uploads are transient |

**How to copy:** for each bucket use the Supabase dashboard “Download folder”
or the storage API to fetch objects to `object/public/<bucket>/<path>`. The
**path structure must be preserved exactly** because `lesson_materials` and
`lesson_pdfs` rows store those paths, and `StorageService` serves files by
path. Do **not** migrate VdoCipher video blobs — VdoCipher hosts them; only
the `video_id` references migrate.

## 5. Import tooling

- `backend/scripts/import-csv.php` — generic CSV → MySQL importer
  (preserves UUIDs, converts `\N` → NULL, JSON strings, booleans, timestamps).
  Usage: `php backend/scripts/import-csv.php --table=profiles --file=profiles.csv`
- `backend/scripts/import-auth-users.php` — special importer for `auth.users`
  that preserves `encrypted_password` bcrypt hashes (never re-hashes).
- `backend/scripts/import-manifest.json` — ordered manifest consumed by the
  importers (same order as the table above).

## 6. Recommended verification after import

1. Row counts match the Supabase Table Editor counts per table.
2. UUID relationships spot-checked (e.g. `profiles.id` in `devices.user_id`).
3. A test login with a real migrated account (password kept working).
4. One lesson video plays (VdoCipher `video_id` intact).
