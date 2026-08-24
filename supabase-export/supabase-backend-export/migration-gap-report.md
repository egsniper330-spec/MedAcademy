# MedAcademy — Migration Gap Report
**Supabase → PHP/MySQL (cPanel)**
Generated: 2026-07-13
Source project: `xdvjwfuqipatkpimejcb.supabase.co`

---

## Scope & Methodology

This report compares the original Supabase backend against a target PHP/MySQL
cPanel environment. Since no PHP codebase was provided, every Supabase component
is classified by its migration status using only the Supabase source evidence.

**Classification key:**
- `[MIGRATED+TESTED]` — confirmed working in PHP/MySQL with passing tests
- `[MIGRATED+NOT TESTED]` — ported but not verified end-to-end
- `[PARTIALLY MIGRATED]` — some logic ported, gaps remain
- `[NOT MIGRATED]` — no PHP equivalent found
- `[UNKNOWN]` — cannot determine from available evidence
- `[SUPABASE-ONLY]` — depends on Supabase infrastructure; requires re-implementation
- `[NO LONGER REQUIRED]` — deprecated / diagnostic / not needed in production

> ⚠️ **No PHP codebase was provided.** All items are classified `[NOT MIGRATED]`
> or `[SUPABASE-ONLY]` by default. Update this report as migration progresses.

---

## 1. DATABASE TABLES (60 public tables)

| Table | Rows (est.) | Classification | Notes |
|-------|-------------|----------------|-------|
| profiles | 14 | [NOT MIGRATED] | Core user table. Maps 1:1 to auth.users via UUID PK. In MySQL: use auto-increment ID + separate uuid column |
| devices | 60 | [NOT MIGRATED] | Device registration & binding logic |
| universities | 1 | [NOT MIGRATED] | Seed data — trivial to recreate |
| faculties | 3 | [NOT MIGRATED] | Seed data |
| academic_levels | 15 | [NOT MIGRATED] | Seed data |
| categories | 12 | [NOT MIGRATED] | Seed data |
| courses | 3 | [NOT MIGRATED] | Core content table |
| sections | ~0 | [NOT MIGRATED] | |
| lessons | 6 | [NOT MIGRATED] | |
| lesson_materials | ~0 | [NOT MIGRATED] | File metadata |
| lesson_progress | ~0 | [NOT MIGRATED] | |
| enrollments | 4 | [NOT MIGRATED] | Student-course access |
| credits | 14 | [NOT MIGRATED] | Credit wallet per user |
| credit_transactions | ~30 | [NOT MIGRATED] | Full ledger |
| code_batches | ~5 | [NOT MIGRATED] | |
| activation_codes | ~50 | [NOT MIGRATED] | |
| notifications | ~20 | [NOT MIGRATED] | In-app only (no push) |
| security_events | ~100 | [NOT MIGRATED] | |
| security_policies | 15 | [NOT MIGRATED] | Config table |
| security_vpn_whitelist | ~0 | [NOT MIGRATED] | |
| content_protection_policies | 2 | [NOT MIGRATED] | |
| content_protection_violations | ~5 | [NOT MIGRATED] | |
| fraud_flags | ~5 | [NOT MIGRATED] | |
| video_uploads | 57 | [NOT MIGRATED] | VdoCipher upload jobs |
| upload_sessions | ~10 | [NOT MIGRATED] | Chunked upload state |
| upload_audit_logs | 452 | [NOT MIGRATED] | Storage audit trail |
| video_assets | 57 | [NOT MIGRATED] | VdoCipher asset metadata |
| video_providers | 1 | [NOT MIGRATED] | |
| video_provider_config | 1 | [NOT MIGRATED] | |
| video_daily_health_reports | ~10 | [NOT MIGRATED] | |
| video_health_alerts | ~5 | [NOT MIGRATED] | |
| audit_logs | 206 | [NOT MIGRATED] | Full admin audit trail |
| crash_logs | ~20 | [NOT MIGRATED] | |
| analytics_events | ~100 | [NOT MIGRATED] | |
| course_lifecycle_logs | ~10 | [NOT MIGRATED] | |
| doctor_earnings_events | ~20 | [NOT MIGRATED] | |
| doctor_earnings_transactions | ~10 | [NOT MIGRATED] | |
| doctor_pricing_history | ~5 | [NOT MIGRATED] | |
| doctor_payout_requests | ~3 | [NOT MIGRATED] | |
| platform_earnings_resets | 1 | [NOT MIGRATED] | |
| system_config | 10 | [NOT MIGRATED] | Config — easy to recreate |
| feature_flags | 9 | [NOT MIGRATED] | Config — easy to recreate |
| support_settings | 3 | [NOT MIGRATED] | Config — easy to recreate |
| maintenance_whitelist | ~0 | [NOT MIGRATED] | |
| trash_config | 1 | [NOT MIGRATED] | |
| app_branding | ~5 | [NOT MIGRATED] | |
| app_pages | ~3 | [NOT MIGRATED] | |
| course_templates | ~0 | [NOT MIGRATED] | |
| credit_daily_stats | ~30 | [NOT MIGRATED] | Analytics aggregate |

---

## 2. DATABASE ENUMS (18 types)

All enums must be re-implemented as MySQL `ENUM` columns or lookup tables.

| Enum | MySQL Approach | Classification |
|------|---------------|----------------|
| user_role | ENUM('student','doctor','assistant','admin','super_admin') | [NOT MIGRATED] |
| user_status | ENUM('active','suspended','pending','deleted','trashed','blocked') | [NOT MIGRATED] |
| course_status | ENUM('draft','published','hidden','archived') | [NOT MIGRATED] |
| lesson_status | ENUM('draft','published','hidden','scheduled','archived') | [NOT MIGRATED] |
| video_type | ENUM('vdocipher','coming_soon','youtube') | [NOT MIGRATED] |
| device_status | ENUM('active','blocked','logged_out') | [NOT MIGRATED] |
| audit_action | 100+ values — use VARCHAR(100) + CHECK or lookup table | [NOT MIGRATED] |
| credit_transaction_type | ENUM with 9 values | [NOT MIGRATED] |
| security_detection_type | ENUM with 15 values | [NOT MIGRATED] |
| security_event_type | ENUM with 20 values | [NOT MIGRATED] |
| security_policy_action | ENUM('log_only','warn_only','block_video','block_login') | [NOT MIGRATED] |
| notification_type | ENUM with 8 values | [NOT MIGRATED] |
| violation_type | ENUM('screenshot_detected','screen_recording_detected') | [NOT MIGRATED] |
| content_protection_action | ENUM with 4 values | [NOT MIGRATED] |
| activation_code_status | ENUM with 7 values | [NOT MIGRATED] |
| difficulty_level | ENUM with 4 values | [NOT MIGRATED] |
| download_permission | ENUM with 4 values | [NOT MIGRATED] |
| enrollment_visibility | ENUM with 3 values | [NOT MIGRATED] |

---

## 3. DATABASE VIEWS (30 views)

| View | Classification | MySQL Equivalent |
|------|---------------|-----------------|
| activation_codes_summary | [NOT MIGRATED] | MySQL VIEW with GROUP BY |
| activation_ledger_view | [NOT MIGRATED] | MySQL VIEW with JOINs |
| credit_ledger_view | [NOT MIGRATED] | MySQL VIEW |
| credits_summary | [NOT MIGRATED] | MySQL VIEW |
| credit_daily_stats_view | [NOT MIGRATED] | MySQL VIEW with DATE() grouping |
| device_stats | [NOT MIGRATED] | MySQL VIEW |
| doctor_credit_summary | [NOT MIGRATED] | MySQL VIEW |
| fraud_detection_flags | [NOT MIGRATED] | MySQL VIEW |
| revenue_analytics | [NOT MIGRATED] | MySQL VIEW |

---

## 4. PostgreSQL FUNCTIONS / RPCs (59 functions)

All RPCs must be re-implemented as PHP functions / API endpoints or MySQL stored procedures.

| Function | Type | Classification | PHP Migration Path |
|----------|------|---------------|-------------------|
| get_my_role / is_admin / is_super_admin / is_doctor | SECURITY DEFINER helpers | [SUPABASE-ONLY] | Replace with PHP session/JWT role check |
| set_updated_at | Trigger fn | [SUPABASE-ONLY] | Replace with MySQL `ON UPDATE CURRENT_TIMESTAMP` |
| handle_new_user | Trigger fn | [SUPABASE-ONLY] | Replace with PHP post-registration hook |
| handle_user_deleted | Trigger fn | [SUPABASE-ONLY] | Replace with MySQL FK CASCADE |
| enforce_credit_balance | Trigger fn | [SUPABASE-ONLY] | Replace with MySQL CHECK constraint or PHP guard |
| log_enrollment_audit | Trigger fn | [SUPABASE-ONLY] | Replace with PHP audit logging |
| log_credit_audit | Trigger fn | [SUPABASE-ONLY] | Replace with PHP audit logging |
| handle_code_redemption | Trigger fn | [SUPABASE-ONLY] | Replace with PHP transaction in redeem endpoint |
| log_storage_operation | Trigger fn | [SUPABASE-ONLY] | Replace with PHP upload hook |
| redeem_activation_code | RPC | [NOT MIGRATED] | PHP endpoint with MySQL transaction + row lock |
| pre_login_device_check | RPC | [NOT MIGRATED] | PHP device check function |
| write_audit_log | RPC | [NOT MIGRATED] | PHP audit log insert |
| lookup_user_by_identifier | RPC | [NOT MIGRATED] | PHP search function |
| get_my_credits_balance | RPC | [NOT MIGRATED] | PHP SELECT query |
| get_security_version | RPC | [NOT MIGRATED] | PHP MD5 of security config |
| get_course_progress | RPC | [NOT MIGRATED] | PHP + MySQL aggregate query |
| get_doctor_students | RPC | [NOT MIGRATED] | PHP + MySQL paginated query |
| get_security_stats | RPC | [NOT MIGRATED] | PHP aggregate query |
| set_user_role | RPC | [NOT MIGRATED] | PHP admin endpoint |
| set_user_status | RPC | [NOT MIGRATED] | PHP admin endpoint |
| grant_course_access | RPC | [NOT MIGRATED] | PHP enrollment endpoint |
| publish_course / unpublish_course / archive_course / restore_course | RPCs | [NOT MIGRATED] | PHP course lifecycle endpoints |
| create_course_audited / update_course_audited | RPCs | [NOT MIGRATED] | PHP endpoints with audit |
| permanently_delete_course | RPC | [NOT MIGRATED] | PHP cascading delete |
| recalculate_doctor_earnings | RPC | [NOT MIGRATED] | PHP earnings recalculation |
| reset_doctor_earnings | RPC | [NOT MIGRATED] | PHP admin endpoint |
| reset_platform_earnings | RPC | [NOT MIGRATED] | PHP super-admin endpoint |
| search_audit_logs | RPC | [NOT MIGRATED] | PHP paginated search |
| run_db_audit | RPC | [NOT MIGRATED] | PHP integrity check |
| *(remaining 30+ RPCs)* | RPCs | [NOT MIGRATED] | See rpc-inventory.json |

---

## 5. TRIGGERS (25 triggers)

| Trigger | Classification | MySQL/PHP Equivalent |
|---------|---------------|---------------------|
| on_auth_user_created → handle_new_user | [SUPABASE-ONLY] | PHP post-registration creates users + credits rows |
| on_auth_user_deleted → handle_user_deleted | [SUPABASE-ONLY] | MySQL FK ON DELETE CASCADE |
| set_*_updated_at (17 triggers) | [SUPABASE-ONLY] | MySQL `updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP` |
| credit_balance_guard | [SUPABASE-ONLY] | MySQL CHECK(balance >= 0) or PHP guard |
| log_enrollment_created | [SUPABASE-ONLY] | PHP audit log call after INSERT |
| log_credit_transaction | [SUPABASE-ONLY] | PHP audit log call after INSERT |
| handle_activation_code_redeemed | [SUPABASE-ONLY] | PHP transaction handles this |
| log_storage_upload / log_storage_delete | [SUPABASE-ONLY] | PHP upload/delete handlers |

---

## 6. RLS POLICIES (110+ policies)

| Classification | Count | Notes |
|---------------|-------|-------|
| [SUPABASE-ONLY] | 110 | PostgreSQL RLS has no direct MySQL equivalent |
| PHP equivalent | — | Implement as middleware: check JWT role before every query |

**PHP Migration Pattern:**
```php
// Every query must be preceded by role check
function requireRole(string $requiredRole): void {
    $user = Auth::user(); // from JWT
    if (!in_array($user->role, getAllowedRoles($requiredRole))) {
        throw new ForbiddenException();
    }
}
// Then scope all queries: WHERE user_id = $userId OR $isAdmin
```

---

## 7. EDGE FUNCTIONS (42 functions)

| Function | Classification | PHP Migration Path |
|----------|---------------|-------------------|
| admin-doctor-earnings | [NOT MIGRATED] | PHP /api/admin/earnings endpoint |
| admin-enrollment | [NOT MIGRATED] | PHP /api/admin/enrollment endpoint |
| admin-update-email | [NOT MIGRATED] | PHP update user email + audit log |
| activation-codes | [NOT MIGRATED] | PHP /api/activation-codes CRUD |
| block-user | [NOT MIGRATED] | PHP /api/admin/users/{id}/block |
| bootstrap-super-admin | [NO LONGER REQUIRED] | Run once — replace with PHP seeder/migration |
| bulk-user-ops | [NOT MIGRATED] | PHP /api/admin/users/bulk endpoint |
| change-password | [NOT MIGRATED] | PHP /api/auth/change-password |
| credits | [NOT MIGRATED] | PHP /api/admin/credits endpoint |
| delete-course | [NOT MIGRATED] | PHP /api/courses/{id} DELETE + VdoCipher cleanup |
| delete-lesson | [NOT MIGRATED] | PHP /api/lessons/{id} DELETE + VdoCipher cleanup |
| delete-user | [NOT MIGRATED] | PHP /api/admin/users/{id} DELETE + VdoCipher cleanup |
| device-binding | [NOT MIGRATED] | PHP /api/devices/register endpoint |
| get-security-config | [NOT MIGRATED] | PHP /api/security/config GET |
| get-security-version | [NOT MIGRATED] | PHP /api/security/version GET |
| get-signed-url | [NOT MIGRATED] | PHP signed URL generation (local storage or S3) |
| impersonate | [NOT MIGRATED] | PHP /api/admin/impersonate — generate limited JWT |
| process-violation | [NOT MIGRATED] | PHP /api/security/violation POST |
| provider-health | [NOT MIGRATED] | PHP /api/admin/provider-health |
| restore-account | [NOT MIGRATED] | PHP /api/admin/users/{id}/restore |
| security-logger | [NOT MIGRATED] | PHP /api/security/events POST |
| student-operations | [NOT MIGRATED] | PHP /api/doctor/students endpoint |
| system-health | [NOT MIGRATED] | PHP /api/admin/health endpoint |
| trash-cleanup | [NOT MIGRATED] | PHP cron job via cPanel cron |
| trash-user | [NOT MIGRATED] | PHP /api/admin/users/{id}/trash |
| upload-patch | [NOT MIGRATED] | PHP /api/upload-patch — store ZIP, return signed URL |
| user-lookup | [NOT MIGRATED] | PHP /api/admin/users/search |
| user-management | [NOT MIGRATED] | PHP /api/admin/users POST (create) |
| vdocipher-debug-creds | [NO LONGER REQUIRED] | Debug only — delete after migration |
| vdocipher-delete-video | [NOT MIGRATED] | PHP cURL to VdoCipher DELETE API |
| vdocipher-orphan-cleanup | [NOT MIGRATED] | PHP cron job |
| vdocipher-otp | [NOT MIGRATED] | PHP /api/video/otp POST + webhook handler |
| vdocipher-upload-init | [NOT MIGRATED] | PHP /api/video/upload-init POST |
| vdocipher-upload-status | [NOT MIGRATED] | PHP /api/video/upload-status GET |
| verify-app-integrity | [NOT MIGRATED] | PHP /api/security/integrity (iOS DeviceCheck + Android Play Integrity) |
| verify-play-integrity | [NOT MIGRATED] | PHP /api/security/play-integrity |
| video-assemble-upload | [NOT MIGRATED] | PHP chunked upload assembly |
| video-daily-health | [NOT MIGRATED] | PHP cron job via cPanel |
| video-health-scan | [NOT MIGRATED] | PHP /api/admin/video-health POST |
| video-upload-chunk | [NOT MIGRATED] | PHP /api/video/chunk POST |
| auth-probe | [NO LONGER REQUIRED] | Diagnostic only — delete |

---

## 8. STORAGE BUCKETS (8 buckets)

| Bucket | Classification | PHP/cPanel Equivalent |
|--------|---------------|----------------------|
| course-images | [NOT MIGRATED] | cPanel public_html/uploads/course-images/ or S3 |
| user-avatars | [NOT MIGRATED] | cPanel public_html/uploads/avatars/ or S3 |
| lesson-materials | [NOT MIGRATED] | Private cPanel directory + signed URL generation |
| video-chunks | [NOT MIGRATED] | PHP temp upload directory — purge after assembly |
| video-uploads | [NOT MIGRATED] | PHP temp directory — purge after VdoCipher transfer |
| video-thumbnails | [NOT MIGRATED] | cPanel public_html/uploads/thumbnails/ |
| temp-uploads | [NOT MIGRATED] | PHP temp directory with cron cleanup |
| patch-uploads | [NOT MIGRATED] | PHP /patches/ directory + signed URL (24h expiry) |

---

## 9. AUTH SYSTEM

| Component | Classification | PHP Migration Notes |
|-----------|---------------|---------------------|
| Email/password auth | [NOT MIGRATED] | PHP: firebase/php-jwt or Laravel Sanctum |
| Phone/OTP auth | [NOT MIGRATED] | PHP: Twilio OTP integration |
| JWT session management | [SUPABASE-ONLY] | Replace with PHP JWT (firebase/php-jwt) |
| Password hashing (bcrypt) | [NOT MIGRATED] | PHP password_verify() is bcrypt-compatible IF hashes can be exported |
| Password hash export | [NOT EXPORTABLE] | Supabase does not expose auth.users.encrypted_password via SQL editor |
| Email confirmation | [SUPABASE-ONLY] | PHP: custom email confirmation flow |
| Password reset emails | [SUPABASE-ONLY] | PHP: PHPMailer + custom token |
| auth.users table | [SUPABASE-ONLY] | Replace with custom users table |
| Auth triggers (handle_new_user) | [SUPABASE-ONLY] | PHP post-registration hook |
| User role in JWT | [NOT MIGRATED] | Supabase stores role in profiles not JWT. PHP: include role in JWT payload |
| MFA | [NOT APPLICABLE] | MFA not enabled in this project |
| OAuth (Google/Apple) | [NOT MIGRATED] | Configured in code but not confirmed active; PHP: league/oauth2-client |

---

## 10. CRON JOBS

| Job | Classification | cPanel Equivalent |
|-----|---------------|-----------------|
| trash-cleanup-daily (2 AM UTC) | [NOT MIGRATED] | cPanel Cron: `0 2 * * * php /path/to/artisan trash:cleanup` |
| video-daily-health (3 AM UTC) | [NOT MIGRATED] | cPanel Cron: `0 3 * * * php /path/to/artisan video:health-check` |

---

## 11. WEBHOOKS & INTEGRATIONS

| Integration | Classification | PHP Migration Notes |
|-------------|---------------|---------------------|
| VdoCipher API (outbound) | [NOT MIGRATED] | PHP cURL to same VdoCipher REST endpoints. Same API key. |
| VdoCipher webhook (inbound) | [NOT MIGRATED] | PHP endpoint: verify HMAC, update video status |
| Google Play Integrity | [NOT MIGRATED] | PHP: google/apiclient or direct JWT verification |
| Supabase Auth (internal) | [SUPABASE-ONLY] | Replace entirely with PHP auth system |
| Push notifications | [NOT APPLICABLE] | Not found in backend — in-app notifications only |
| Email (transactional) | [SUPABASE-ONLY] | Replace with PHPMailer + SMTP |

---

## 12. ENVIRONMENT VARIABLES / SECRETS

| Variable | Exportable | Classification | PHP Config Key |
|----------|-----------|---------------|----------------|
| SUPABASE_URL | No (irrelevant post-migration) | [SUPABASE-ONLY] | Replace with DB_HOST etc. |
| SUPABASE_SERVICE_ROLE_KEY | NOT EXPORTABLE | [SUPABASE-ONLY] | No equivalent needed |
| SERVICE_ROLE_KEY | NOT EXPORTABLE | [SUPABASE-ONLY] | No equivalent needed |
| SUPABASE_ANON_KEY | NOT EXPORTABLE | [SUPABASE-ONLY] | No equivalent needed |
| VDOCIPHER_API_SECRET | NOT EXPORTABLE | [NOT MIGRATED] | Same key in PHP .env |
| VDOCIPHER_WEBHOOK_SECRET | NOT EXPORTABLE | [NOT MIGRATED] | Same key in PHP .env |
| APP_DOMAIN | Exportable | [NOT MIGRATED] | APP_URL in PHP .env |
| BOOTSTRAP_SECRET | NOT EXPORTABLE | [NO LONGER REQUIRED] | One-time use — discard |
| CRON_SECRET | NOT EXPORTABLE | [NOT MIGRATED] | Replace with cPanel cron auth |
| GOOGLE_PLAY_INTEGRITY_DECRYPTION_KEY | NOT EXPORTABLE | [NOT MIGRATED] | Same key in PHP .env |
| GOOGLE_PLAY_INTEGRITY_VERIFICATION_KEY | NOT EXPORTABLE | [NOT MIGRATED] | Same key in PHP .env |
| EXPO_PUBLIC_SUPABASE_URL | Exportable | [NOT MIGRATED] | Replace with new API base URL in mobile app |
| EXPO_PUBLIC_SUPABASE_ANON_KEY | NOT EXPORTABLE | [NOT MIGRATED] | Replace with new API key |
| SITE_URL | Exportable (https://medacademy.app) | [NOT MIGRATED] | APP_URL |

---

## 13. REALTIME

| Component | Classification | PHP Migration Notes |
|-----------|---------------|---------------------|
| supabase_realtime publication | [SUPABASE-ONLY] | Replace with WebSockets (Ratchet/Pusher/SSE) |
| Notification realtime | [SUPABASE-ONLY] | PHP: polling endpoint or Pusher channels |
| Video upload progress realtime | [SUPABASE-ONLY] | PHP: SSE or polling |

---

## 14. SUPABASE-ONLY FEATURES (No Direct MySQL Equivalent)

| Feature | Notes |
|---------|-------|
| Row Level Security (RLS) | Must be replaced with PHP middleware/scoped queries |
| SECURITY DEFINER functions | Replace with PHP service layer functions |
| auth.uid() in SQL | Not possible in MySQL — must pass user ID from PHP |
| PostgreSQL triggers | Partial MySQL equivalent; complex logic → PHP |
| pg_cron | Replace with cPanel cron jobs |
| pg_net | Remove — PHP makes direct HTTP calls |
| supabase_vault | Replace with PHP encrypted config storage |
| Supabase Auth JWT | Replace with PHP JWT library |
| Supabase Storage | Replace with cPanel file system or S3-compatible storage |
| Supabase Realtime | Replace with Pusher, WebSockets, or SSE |
| PostgREST auto-API | Must build all endpoints manually in PHP |

---

## 15. MIGRATION PRIORITY ORDER

```
Phase 1 — Database Schema
  1. Create MySQL schema (enums → ENUM columns, tables, indexes, FKs)
  2. Seed data (categories, universities, faculties, levels, system_config, feature_flags, security_policies)

Phase 2 — Authentication
  3. PHP JWT auth (replace Supabase Auth)
  4. User registration endpoint (replaces handle_new_user trigger)
  5. Device binding endpoint

Phase 3 — Core Business Logic
  6. Credit system (balance, transactions, redeem activation codes)
  7. Course/section/lesson CRUD
  8. Enrollment system
  9. Activation codes

Phase 4 — Video Integration
  10. VdoCipher integration (upload, OTP, delete, health)
  11. Chunked upload engine

Phase 5 — Security
  12. Security event logging
  13. Device/VPN/root detection response
  14. Content protection violations

Phase 6 — Admin
  15. All admin RPCs → PHP endpoints
  16. Audit logging
  17. Doctor earnings

Phase 7 — Background Jobs
  18. Trash cleanup cron
  19. Video health cron

Phase 8 — Realtime
  20. Notification delivery (polling or Pusher)
```

---

## 16. CRITICAL MIGRATION RISKS

| Risk | Severity | Details |
|------|----------|---------|
| Password hash export | 🔴 HIGH | Supabase does not expose bcrypt hashes — all users must reset passwords on cutover |
| UUID vs auto-increment IDs | 🔴 HIGH | All PKs are UUIDs. MySQL supports UUID but performance differs. Consider using VARCHAR(36) or BINARY(16) |
| auth.uid() in SQL | 🔴 HIGH | All RPCs and RLS policies use auth.uid() — must pass user ID explicitly from PHP |
| Transaction atomicity | 🟡 MEDIUM | PostgreSQL transactions in RPCs must be re-implemented as PHP DB transactions |
| Concurrent code redemption (FOR UPDATE lock) | 🟡 MEDIUM | redeem_activation_code uses SELECT FOR UPDATE — replicate with MySQL SELECT FOR UPDATE |
| Trigger cascade complexity | 🟡 MEDIUM | handle_new_user creates 2 rows atomically — PHP must do same in one transaction |
| Mobile app re-pointing | 🟡 MEDIUM | EXPO_PUBLIC_SUPABASE_URL and ANON_KEY in app binary must be updated → app store re-release required |
| VdoCipher webhook URL change | 🟡 MEDIUM | VdoCipher webhook must be reconfigured to point to new PHP endpoint |
| Realtime subscriptions | 🟡 MEDIUM | 3 realtime subscriptions in frontend must be replaced with polling or new WS implementation |

---

*End of Migration Gap Report*
*For full schema: see database/schema.sql*
*For full RPC list: see rpc-inventory.json*
*For full Edge Function source: see edge-functions/*
