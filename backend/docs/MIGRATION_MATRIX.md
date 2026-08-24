# MedAcademy — Complete Migration Matrix
**Supabase Export → PHP/MySQL Backend**
Generated: 2026-08-19

---

## STATUS LEGEND
- ✅ COMPLETE — fully implemented and tested
- ⚠️ PARTIAL — partially implemented, gaps remain
- ❌ MISSING — not yet implemented
- 🔄 NEEDS REIMPLEMENTATION — exists but doesn't match original behavior
- 🔧 NEEDS FIX — exists but has bugs
- 📋 NEEDS DATA — schema exists, needs seed/migration data
- ⬜ NOT REQUIRED — diagnostic/debug only, not needed in production

---

## 1. DATABASE TABLES (60 public tables)

| Table | Status | Notes |
|-------|--------|-------|
| profiles | ✅ | Migrated with extended columns |
| devices | ✅ | Migrated with extended columns |
| universities | ✅ | Seed data present |
| faculties | ✅ | Seed data present |
| academic_levels | ✅ | Seed data present |
| categories | ✅ | Seed data present |
| courses | ✅ | Extended with many columns |
| sections | ✅ | Migrated |
| lessons | ✅ | Migrated |
| lesson_materials | ✅ | Migrated |
| lesson_progress | ❌ | MISSING — not in schema |
| enrollments | ✅ | Migrated |
| credits | ✅ | Schema uses `doctor_id` (old uses `user_id`) |
| credit_transactions | ✅ | Schema uses `doctor_id` |
| code_batches | ⚠️ | Schema mismatch — old has `label`, `course_id`, etc. |
| activation_codes | ⚠️ | Schema mismatch — old has `course_id`, `batch_label` |
| notifications | ✅ | Migrated |
| security_events | ✅ | Migrated |
| security_policies | ✅ | Migrated |
| security_vpn_whitelist | ✅ | Migrated |
| content_protection_policies | ⚠️ | Missing `strike1_action`/`strike2_action`/`strike3_action` columns |
| content_protection_violations | ⚠️ | Missing `device_name`, `platform`, `installation_id`, `session_id`, `ip_address`, `action_taken` columns |
| fraud_flags | ⚠️ | Missing `severity` column |
| video_uploads | ⚠️ | Missing many columns: `course_id`, `provider_video_id`, `thumbnail_url`, etc. |
| upload_sessions | ✅ | Migrated |
| upload_audit_logs | ✅ | Migrated |
| video_assets | ✅ | Migrated |
| video_providers | ✅ | Migrated |
| video_provider_config | ⚠️ | Missing `provider_key`, `last_sync_at` columns |
| video_daily_health_reports | ⚠️ | Missing `healthy_count`, `broken_count` columns |
| video_health_alerts | ⚠️ | Missing `upload_id`, `severity` columns |
| audit_logs | ✅ | Extended columns |
| crash_logs | ✅ | Migrated |
| analytics_events | ✅ | Migrated |
| course_lifecycle_logs | ✅ | Migrated |
| doctor_earnings_events | ✅ | Migrated |
| doctor_earnings_transactions | ✅ | Migrated |
| doctor_pricing_history | ✅ | Migrated |
| doctor_payout_requests | ✅ | Migrated |
| platform_earnings_resets | ✅ | Migrated |
| system_config | ✅ | Migrated |
| feature_flags | ✅ | Migrated |
| support_settings | ✅ | Migrated |
| maintenance_whitelist | ✅ | Migrated |
| trash_config | ✅ | Migrated |
| app_branding | ✅ | Migrated |
| app_pages | ✅ | Migrated |
| course_templates | ✅ | Migrated |
| credit_daily_stats | ✅ | Migrated |
| security_config | ✅ | Separate table for mobile security config |
| **NEW TABLES (not in old schema):** | | |
| deletion_records | ✅ | New — for deletion audit trail |
| idempotency_keys | ❌ | Referenced by credits Edge Function |
| play_integrity_nonces | ❌ | Referenced by verify-play-integrity |
| push_tokens | ❌ | Referenced by device-binding |
| login_history | ❌ | Referenced by device-binding |

---

## 2. ENUMS (18 types)

| Enum | Status | Notes |
|------|--------|-------|
| user_role | ✅ | VARCHAR + CHECK |
| user_status | ✅ | VARCHAR + CHECK |
| course_status | ✅ | VARCHAR + CHECK |
| lesson_status | ✅ | VARCHAR + CHECK |
| video_type | ✅ | VARCHAR |
| device_status | ✅ | VARCHAR + CHECK |
| audit_action | ✅ | VARCHAR (100+ values) |
| credit_transaction_type | ✅ | VARCHAR |
| security_detection_type | ✅ | VARCHAR |
| security_event_type | ✅ | VARCHAR + CHECK |
| security_policy_action | ✅ | VARCHAR + CHECK |
| notification_type | ✅ | VARCHAR |
| violation_type | ✅ | VARCHAR + CHECK |
| content_protection_action | ✅ | VARCHAR |
| activation_code_status | ✅ | VARCHAR |
| difficulty_level | ✅ | VARCHAR |
| download_permission | ✅ | VARCHAR |
| enrollment_visibility | ✅ | VARCHAR |
| strike_action | ❌ | MISSING — referenced by process-violation |

---

## 3. VIEWS (9 documented + 21 estimated)

| View | Status | Notes |
|------|--------|-------|
| activation_codes_summary | ❌ | MISSING |
| activation_ledger_view | ❌ | MISSING |
| credit_ledger_view | ❌ | MISSING |
| credits_summary | ❌ | MISSING |
| credit_daily_stats_view | ❌ | MISSING |
| device_stats | ❌ | MISSING |
| doctor_credit_summary | ❌ | MISSING |
| fraud_detection_flags | ❌ | MISSING |
| revenue_analytics | ❌ | MISSING |

---

## 4. RPCs/DATABASE FUNCTIONS (59 total)

| Function | Status | Notes |
|----------|--------|-------|
| get_my_role | ✅ | PHP session check |
| is_admin | ✅ | PHP middleware |
| is_super_admin | ✅ | PHP middleware |
| is_doctor | ✅ | PHP middleware |
| set_updated_at | ✅ | MySQL ON UPDATE |
| handle_new_user | ✅ | PHP post-registration |
| handle_user_deleted | ✅ | MySQL FK CASCADE |
| enforce_credit_balance | ⚠️ | CHECK constraint exists, but PHP guard needed |
| log_enrollment_audit | ⚠️ | AuditService exists but not called from enrollment |
| log_credit_audit | ⚠️ | AuditService exists but not called from credit txn |
| handle_code_redemption | ⚠️ | Inline in redeem(), not trigger-based |
| log_storage_operation | ❌ | MISSING — storage audit hook |
| redeem_activation_code | ✅ | CreditController::redeem() |
| pre_login_device_check | ✅ | AuthController::preLoginCheck() |
| write_audit_log | ✅ | AuditService::write() |
| lookup_user_by_identifier | ✅ | AuthController::lookup() |
| get_my_credits_balance | ✅ | CreditController::me() |
| get_security_version | ✅ | SecurityController::version() |
| get_course_progress | ❌ | MISSING |
| get_doctor_students | ✅ | UserController::doctorStudents() |
| get_security_stats | ❌ | MISSING |
| set_user_role | ✅ | AdminController::setRole() |
| set_user_status | ✅ | AdminController::setStatus() |
| grant_course_access | ❌ | MISSING — admin direct enrollment |
| publish_course | ❌ | MISSING — course lifecycle |
| unpublish_course | ❌ | MISSING — course lifecycle |
| archive_course | ❌ | MISSING — course lifecycle |
| restore_course | ❌ | MISSING — course lifecycle |
| create_course_audited | ⚠️ | CourseController::create() exists but different signature |
| update_course_audited | ⚠️ | CourseController::update() exists but different signature |
| duplicate_course | ❌ | MISSING |
| permanently_delete_course | ❌ | MISSING |
| recalculate_doctor_earnings | ❌ | MISSING |
| reset_doctor_earnings | ❌ | MISSING |
| reset_platform_earnings | ❌ | MISSING |
| search_audit_logs | ⚠️ | AdminController::auditLogs() exists but different API |
| run_db_audit | ❌ | MISSING |
| get_doctor_earnings_dashboard | ❌ | MISSING |
| get_doctor_student_profile | ❌ | MISSING |
| get_doctor_activity_stats | ❌ | MISSING |
| get_doctor_credit_transactions | ❌ | MISSING |
| get_user_activity | ❌ | MISSING |
| get_user_profile_summary | ❌ | MISSING |
| get_trash_list | ❌ | MISSING |
| get_trash_stats | ❌ | MISSING |
| get_deletion_stats | ❌ | MISSING |
| get_archive_analytics | ❌ | MISSING |
| get_archived_courses | ❌ | MISSING |
| get_chunk_upload_state | ❌ | MISSING |
| get_course_delete_stats | ❌ | MISSING |
| get_lesson_video_state | ❌ | MISSING |
| get_video_asset_usage | ❌ | MISSING |
| get_orphan_deletion_records | ❌ | MISSING |
| get_risky_devices | ❌ | MISSING |
| get_enum_values_bulk | ❌ | MISSING |
| get_teacher_provider_permissions | ❌ | MISSING |
| mark_deletion_repaired | ❌ | MISSING |
| mark_lesson_video_missing | ❌ | MISSING |
| recover_stale_upload_sessions | ❌ | MISSING |
| remove_course_enrollment | ❌ | MISSING |
| remove_student_and_record_earnings | ❌ | MISSING |
| set_doctor_credit_price | ❌ | MISSING |
| set_enrollment_assigned_price | ❌ | MISSING |
| upsert_teacher_provider_permission | ❌ | MISSING |
| admin_reset_violations | ❌ | MISSING |
| get_email_by_phone | ❌ | MISSING |
| reset_user_password_by_admin | ❌ | MISSING |
| process_student_activation | ❌ | MISSING — student-operations RPC |
| allocate_credits | ❌ | MISSING — credits Edge Function RPC |
| revoke_credits | ❌ | MISSING — credits Edge Function RPC |
| check_low_credit_and_notify | ❌ | MISSING |
| register_device_for_user | ❌ | MISSING — device-binding RPC |
| logout_device | ❌ | MISSING |
| update_device_status | ❌ | MISSING |
| delete_device_record | ❌ | MISSING |
| rename_device | ❌ | MISSING |
| set_device_limit | ❌ | MISSING |
| admin_reset_device | ❌ | MISSING |
| force_logout_device | ❌ | MISSING |
| logout_all_devices | ❌ | MISSING |
| increment_security_version | ❌ | MISSING |
| bump_security_version | ❌ | MISSING |
| write_login_history | ❌ | MISSING |
| admin_enroll_student | ❌ | MISSING |
| admin_remove_enrollment | ❌ | MISSING |
| set_enrollment_visibility | ❌ | MISSING |
| hard_delete_user | ❌ | MISSING |
| get_delete_preflight | ❌ | MISSING |
| cleanup_expired_trash | ❌ | MISSING |
| bulk_trash_users | ❌ | MISSING |
| bulk_restore_users | ❌ | MISSING |

---

## 5. EDGE FUNCTIONS (42 total)

| Function | Status | PHP Route | Notes |
|----------|--------|-----------|-------|
| admin-doctor-earnings | ❌ | MISSING | Doctor earnings admin panel |
| admin-enrollment | ❌ | MISSING | Admin student enrollment (6 actions) |
| admin-update-email | ❌ | MISSING | Admin email change |
| activation-codes | ⚠️ | /activation-codes | Only create/batch_create/redeem. Missing: assign, deactivate, reactivate, delete_code, bulk ops, batch ops |
| auth-probe | ⬜ | N/A | Diagnostic only |
| block-user | ⚠️ | /admin/users/{id}/block | Exists but missing auth ban_duration, security_version bump |
| bootstrap-super-admin | ⬜ | N/A | One-time only |
| bulk-user-ops | ❌ | MISSING | 7 bulk operations |
| change-password | ❌ | MISSING | Self + admin password change |
| credits | ⚠️ | /credits/allocate | Only allocate. Missing: refund, revoke, bulk_allocate |
| delete-course | ❌ | MISSING | Full cascade with VdoCipher cleanup |
| delete-lesson | ❌ | MISSING | Lesson + VdoCipher cleanup |
| delete-user | ❌ | MISSING | Full deletion pipeline (8 steps) |
| device-binding | ❌ | MISSING | 12 actions: register, status, get_devices, logout_device, block/unblock, delete, rename, set_limit, admin_reset, force_logout, logout_all, check_authorization, get_login_history, update_push_token, record_failure |
| get-security-config | ✅ | /security/config | Implemented |
| get-security-version | ✅ | /security/version | Implemented |
| get-signed-url | ⚠️ | /storage/signed-url | Exists but different bucket list |
| impersonate | ❌ | MISSING | Super admin impersonation |
| process-violation | ⚠️ | /security/violations | Exists but missing role guard, exemption logic |
| provider-health | ✅ | /provider-health | Implemented |
| restore-account | ⚠️ | /admin/users/{id}/restore | Exists but simpler than original |
| security-logger | ✅ | /security/events | Implemented |
| student-operations | ❌ | MISSING | 5 modes: create_only, create_and_enroll_credits, create_and_enroll_code, enroll_existing_credits, enroll_existing_code |
| system-health | ⚠️ | /system-health | Exists but missing run_db_audit call |
| trash-cleanup | ❌ | MISSING | Cron job |
| trash-user | ❌ | MISSING | Soft-delete user |
| upload-patch | ❌ | MISSING | OTA patch ZIP upload |
| user-lookup | ⚠️ | /auth/lookup | Exists but different response format |
| user-management | ❌ | MISSING | Create users (all roles) |
| vdocipher-debug-creds | ⬜ | N/A | Debug only |
| vdocipher-delete-video | ⚠️ | /video/delete | Exists |
| vdocipher-orphan-cleanup | ❌ | MISSING | Cron job |
| vdocipher-otp | ⚠️ | /video/otp | Exists but missing webhook handler, audit log |
| vdocipher-upload-init | ⚠️ | /video/upload-init | Exists |
| vdocipher-upload-status | ⚠️ | /video/upload-status | Exists |
| verify-app-integrity | ❌ | MISSING | iOS DeviceCheck — source missing from export |
| verify-play-integrity | ❌ | MISSING | Android Play Integrity |
| video-assemble-upload | ❌ | MISSING | Chunked upload assembly |
| video-daily-health | ❌ | MISSING | Cron job |
| video-health-scan | ❌ | MISSING | On-demand video health scan |
| video-upload-chunk | ❌ | MISSING | Single chunk upload |

---

## 6. STORAGE BUCKETS (8)

| Bucket | Status | Notes |
|--------|--------|-------|
| course-images | ❌ | MISSING — no storage endpoint for this bucket |
| user-avatars | ❌ | MISSING |
| lesson-materials | ⚠️ | /storage/signed-url exists but limited |
| video-chunks | ❌ | MISSING — needed for chunked upload |
| video-uploads | ❌ | MISSING |
| video-thumbnails | ❌ | MISSING |
| temp-uploads | ❌ | MISSING |
| patch-uploads | ❌ | MISSING |

---

## 7. AUTH

| Component | Status | Notes |
|-----------|--------|-------|
| Email/password auth | ✅ | Registration + login |
| Phone/OTP auth | ❌ | MISSING — verifyOtp flow |
| JWT session management | ✅ | PHP JWT |
| Password hashing | ✅ | bcrypt via password_hash() |
| Email confirmation | ❌ | MISSING |
| Password reset emails | ⚠️ | EmailService exists but not connected to auth flow |
| Device binding | ❌ | MISSING — entire device-binding Edge Function |
| Pre-login device check | ✅ | AuthController::preLoginCheck() |
| Session revocation | ✅ | SessionManager |
| Change password (self) | ❌ | MISSING |
| Change password (admin) | ❌ | MISSING |

---

## 8. CRON JOBS

| Job | Status | Notes |
|-----|--------|-------|
| trash-cleanup (2 AM) | ❌ | MISSING — needs PHP CLI script |
| video-daily-health (3 AM) | ❌ | MISSING — needs PHP CLI script |

---

## 9. WEBHOOK

| Webhook | Status | Notes |
|---------|--------|-------|
| vdocipher-webhook | ❌ | MISSING — POST /vdocipher-otp/webhook |

---

## 10. EXTERNAL INTEGRATIONS

| Integration | Status | Notes |
|-------------|--------|-------|
| VdoCipher (OTP) | ⚠️ | /video/otp exists |
| VdoCipher (upload-init) | ⚠️ | /video/upload-init exists |
| VdoCipher (upload-status) | ⚠️ | /video/upload-status exists |
| VdoCipher (delete) | ⚠️ | /video/delete exists |
| VdoCipher (webhook) | ❌ | MISSING |
| VdoCipher (orphan cleanup) | ❌ | MISSING |
| Google Play Integrity | ❌ | MISSING |
| Apple DeviceCheck | ❌ | MISSING — source not in export |

---

## 11. MISSING RPCs NEEDED FOR EDGE FUNCTIONS

These RPCs are called by Edge Functions but NOT implemented in PHP:

| RPC | Called By | Priority |
|-----|-----------|----------|
| register_device_for_user | device-binding | HIGH |
| logout_device | device-binding | HIGH |
| update_device_status | device-binding | HIGH |
| delete_device_record | device-binding | HIGH |
| rename_device | device-binding | MEDIUM |
| set_device_limit | device-binding | MEDIUM |
| admin_reset_device | device-binding | HIGH |
| force_logout_device | device-binding | HIGH |
| logout_all_devices | device-binding | HIGH |
| increment_security_version | block-user | HIGH |
| bump_security_version | block-user | HIGH |
| write_login_history | device-binding | MEDIUM |
| process_student_activation | student-operations | HIGH |
| allocate_credits | credits | HIGH |
| revoke_credits | credits | HIGH |
| check_low_credit_and_notify | credits | LOW |
| admin_enroll_student | admin-enrollment | HIGH |
| admin_remove_enrollment | admin-enrollment | MEDIUM |
| set_enrollment_visibility | admin-enrollment | MEDIUM |
| hard_delete_user | delete-user, bulk-user-ops | HIGH |
| get_delete_preflight | delete-user | HIGH |
| cleanup_expired_trash | trash-cleanup | MEDIUM |
| bulk_trash_users | bulk-user-ops | MEDIUM |
| bulk_restore_users | bulk-user-ops | MEDIUM |

---

## 12. FRONTEND COMPATIBILITY CHECKLIST

### Frontend Edge Function Invocations (19)

| Edge Function | PHP Endpoint | Status |
|---------------|-------------|--------|
| admin-doctor-earnings | ❌ | MISSING |
| admin-enrollment | ❌ | MISSING |
| admin-update-email | ❌ | MISSING |
| block-user | /admin/users/{id}/block | ⚠️ PARTIAL |
| device-binding | ❌ | MISSING |
| get-security-config | /security/config | ✅ |
| get-security-version | /security/version | ✅ |
| get-signed-url | /storage/signed-url | ⚠️ PARTIAL |
| impersonate | ❌ | MISSING |
| process-violation | /security/violations | ⚠️ PARTIAL |
| provider-health | /provider-health | ✅ |
| restore-account | /admin/users/{id}/restore | ⚠️ PARTIAL |
| security-logger | /security/events | ✅ |
| student-operations | ❌ | MISSING |
| system-health | /system-health | ⚠️ PARTIAL |
| vdocipher-otp | /video/otp | ⚠️ PARTIAL |
| verify-app-integrity | ❌ | MISSING |
| verify-play-integrity | ❌ | MISSING |
| video-health-scan | ❌ | MISSING |

### Frontend RPC Calls (56)

56 RPCs called from frontend. ~20 are implemented as PHP endpoints. ~36 are MISSING.

### Frontend Auth Methods (12)

| Method | Status |
|--------|--------|
| signInWithPassword | ✅ |
| signUp | ✅ |
| signOut | ✅ |
| getSession | ✅ (via /auth/me) |
| getUser | ✅ (via /auth/me) |
| onAuthStateChange | ❌ MISSING (client-side polling needed) |
| refreshSession | ✅ |
| resetPasswordForEmail | ❌ MISSING (email flow) |
| setSession | ❌ MISSING |
| updateUser | ❌ MISSING |
| verifyOtp | ❌ MISSING |
| signInWithOAuth | ❌ MISSING (placeholder) |

---

## 13. PRIORITY IMPLEMENTATION ORDER

### Phase A — Critical Missing Endpoints (blocks frontend)
1. **device-binding** — entire Edge Function (12 actions)
2. **student-operations** — create + enroll student
3. **change-password** — self + admin
4. **trash-user** — soft-delete user
5. **bulk-user-ops** — 7 bulk operations
6. **admin-enrollment** — 6 actions
7. **admin-update-email** — super admin email change
8. **block-user** — enhance existing with auth ban + security_version
9. **verify-play-integrity** — Android attestation
10. **verify-app-integrity** — reverse-engineer from frontend

### Phase B — Course Lifecycle
11. publish_course / unpublish_course / archive_course / restore_course
12. delete-course — full cascade with VdoCipher
13. delete-lesson — VdoCipher cleanup
14. duplicate_course
15. permanently_delete_course

### Phase C — Credits & Earnings
16. credits refund/revoke/bulk
17. doctor earnings dashboard
18. recalculate_doctor_earnings
19. reset_doctor_earnings
20. reset_platform_earnings

### Phase D — Admin & Analytics
21. impersonate
22. system-health (enhance)
23. security stats
24. search_audit_logs (enhance)
25. run_db_audit

### Phase E — Video & Storage
26. video-upload-chunk
27. video-assemble-upload
28. video-health-scan
29. VdoCipher webhook
30. All 8 storage buckets

### Phase F — Cron Jobs
31. trash-cleanup cron
32. video-daily-health cron
33. vdocipher-orphan-cleanup cron

### Phase G — Database Completeness
34. All 9 views
35. All missing columns
36. All missing tables (login_history, play_integrity_nonces, etc.)
37. Missing trigger logic (credit_balance_guard, etc.)

---

## 14. SCHEMA GAPS TO FIX

### Missing Columns (by table)

**content_protection_policies:**
- strike1_action (VARCHAR, DEFAULT 'warning')
- strike2_action (VARCHAR, DEFAULT 'logout')
- strike3_action (VARCHAR, DEFAULT 'suspend')

**content_protection_violations:**
- device_name, platform, installation_id, session_id, ip_address
- action_taken

**fraud_flags:**
- severity (VARCHAR)

**video_uploads:**
- course_id, provider_video_id, thumbnail_url, storage_path
- thumbnail_storage_path, health_score, verification_status
- playback_status, video_resolution, video_duration_sec

**profiles (extensions needed):**
- phone_e164, phone_national, profile_email
- watermark_id, max_devices, security_version
- is_suspended, suspension_reason, suspension_at
- force_password_change, created_by_doctor_id
- violation_count, strike_count, is_suspended
- pre_trash_status, trashed_at, trash_expires_at
- delete_permissions, push_token

**devices (extensions needed):**
- device_fingerprint, device_model, os, os_version
- manufacturer, ip_address, installation_id
- trust_level, block_reason, blocked_at
- registered_at, last_active_at, revoked_at
- revoked_reason, push_token

**code_batches (extensions needed):**
- label, course_id, total_count, disabled_count
- expires_at, notes, prefix, max_uses

**activation_codes (extensions needed):**
- course_id, batch_label, max_uses
- disabled_by, disabled_at

**audit_logs (extensions needed):**
- actor_id, actor_name, actor_email, actor_role
- resource_type, resource_id, target_user_id, target_name
- description, old_values, new_values, success
- details, user_id, log_status

**notifications (extensions needed):**
- message (not body), notification_type (not type)

**security_events (extensions needed):**
- detection_method, policy_action, risk_score
- device_name, installation_id
- policy_action (CHECK constraint already exists)

**security_config (new table needed):**
- play_integrity_enabled, expected_cert_sha256, expected_cert_sha256s
- minimum_app_version, minimum_supported_version, latest_version
- force_update, update_title, update_message
- android_store_url, ios_store_url, extras, is_active

---

## 15. SUMMARY

| Component | Total | Complete | Partial | Missing | Not Required |
|-----------|-------|----------|---------|---------|-------------|
| Tables | 60 | 42 | 8 | 10 | 0 |
| Enums | 18 | 17 | 0 | 1 | 0 |
| Views | 9 | 0 | 0 | 9 | 0 |
| RPCs | 59+ | 20 | 5 | 34+ | 0 |
| Edge Functions | 42 | 4 | 10 | 24 | 4 |
| Storage Buckets | 8 | 0 | 1 | 7 | 0 |
| Auth Components | 12 | 6 | 1 | 5 | 0 |
| Cron Jobs | 2 | 0 | 0 | 2 | 0 |
| Webhooks | 1 | 0 | 0 | 1 | 0 |
| Integrations | 3 | 0 | 1 | 2 | 0 |

**Overall Migration Progress: ~35% complete**
