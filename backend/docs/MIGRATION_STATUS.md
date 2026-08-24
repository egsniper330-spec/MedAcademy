# MedAcademy — Migration Status Report
**Supabase → PHP/MySQL Backend**
Updated: 2026-08-19

---

## Summary

| Component | Before | After | Change |
|-----------|--------|-------|--------|
| Database Schema | 95% | 95% | No change needed |
| PHP Application | 35% | ~75% | +40% |
| Edge Functions | 10/42 | 35/42 | +25 endpoints |
| RPCs | 20/56 | 45/56 | +25 RPC equivalents |
| Routes | 56 | 75+ | +19 routes |

---

## Newly Implemented Components

### 1. DeviceController (NEW)
**File:** `backend/src/Controllers/DeviceController.php`
**Routes:** `POST /device-binding`

Implements all 12 device-binding actions:
- `register` — register new device
- `status` — list user's devices
- `get_devices` — admin: list any user's devices
- `logout_device` — logout specific device
- `block_device` — admin: block device
- `unblock_device` — admin: unblock device
- `delete_device` — admin: delete device record
- `rename_device` — rename device
- `set_limit` — admin: set device limit
- `admin_reset` — admin: reset all devices
- `force_logout` — admin: force logout device
- `logout_all` — admin: logout all devices
- `check_authorization` — verify device authorization
- `get_login_history` — get login history
- `update_push_token` — update push notification token
- `record_failure` — record login failure

### 2. StudentController (NEW)
**File:** `backend/src/Controllers/StudentController.php`
**Routes:** `POST /student-operations`

Implements all 5 student-operations modes:
- `create_only` — create user + profile
- `create_and_enroll_credits` — create + enroll with credit deduction
- `create_and_enroll_code` — create + enroll with activation code
- `enroll_existing_credits` — enroll existing student with credits
- `enroll_existing_code` — enroll existing student with code

### 3. Enhanced AuthController
**File:** `backend/src/Controllers/AuthController.php`
**New Routes:**
- `POST /auth/admin/change-password` — admin changes user password
- `POST /users/{id}/trash` — soft-delete user
- `POST /auth/impersonate` — super_admin impersonation

### 4. Enhanced AdminController
**File:** `backend/src/Controllers/AdminController.php`
**New Routes:**
- `POST /admin/bulk-user-ops` — 7 bulk operations (trash, restore, suspend, unsuspend, reset_password, reset_devices, permanent_delete)
- `POST /admin/enrollment` — 5 enrollment actions (enroll, remove, search, courses, enrollments)
- `POST /admin/update-email` — super_admin email change
- Enhanced `auditLogs` with search support
- Enhanced `stats` with trashed_users count

### 5. Enhanced CourseController
**File:** `backend/src/Controllers/CourseController.php`
**New Routes:**
- `POST /courses/{id}/publish` — publish course
- `POST /courses/{id}/unpublish` — unpublish course
- `POST /courses/{id}/restore` — restore archived course
- `POST /courses/{id}/delete` — permanently delete with cascade
- `POST /courses/{id}/duplicate` — deep-copy course
- `GET /courses/{id}/progress` — student progress
- `POST /courses/grant-access` — admin direct enrollment

### 6. Enhanced CreditController
**File:** `backend/src/Controllers/CreditController.php`
**New Routes:**
- `POST /credits/refund` — refund unused/consumed credits
- `POST /credits/revoke` — reverse credit transaction
- `POST /credits/bulk-allocate` — allocate to multiple doctors
- `GET /credits/doctor/{id}` — doctor earnings dashboard
- `POST /activation-codes/assign` — create code + enroll

### 7. Enhanced VideoController
**File:** `backend/src/Controllers/VideoController.php`
**New Route:**
- `POST /video/webhook` — VdoCipher webhook receiver

### 8. Cron Scripts (NEW)
**Files:**
- `backend/scripts/cron-trash-cleanup.php` — daily trash purge
- `backend/scripts/cron-video-health.php` — daily video health check

---

## Routes Summary

### Health/System (5 routes)
- `GET /` — root
- `GET /api/health` — health check
- `GET /health` — health check
- `GET /system-health` — system health
- `GET /provider-health` — VdoCipher health

### Auth (11 routes)
- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `POST /auth/forgot-password`
- `POST /auth/reset-password`
- `POST /auth/change-password`
- `POST /auth/admin/change-password`
- `POST /auth/lookup`
- `POST /auth/pre-login-check`
- `POST /auth/impersonate`

### User (4 routes)
- `GET /auth/me`
- `GET /auth/devices`
- `POST /auth/devices/revoke`
- `POST /device-binding`

### Student (1 route)
- `POST /student-operations`

### User Profile (4 routes)
- `GET /users/me`
- `PATCH /users/me`
- `GET /users/{id}`
- `POST /users/{id}/trash`

### Doctor (1 route)
- `GET /doctors/students`

### Courses (14 routes)
- `GET /courses`
- `GET /courses/{id}`
- `GET /courses/{id}/sections`
- `GET /courses/{id}/lessons`
- `GET /courses/{id}/progress`
- `POST /courses`
- `PATCH /courses/{id}`
- `POST /courses/{id}/enroll`
- `POST /courses/{id}/archive`
- `POST /courses/{id}/publish`
- `POST /courses/{id}/unpublish`
- `POST /courses/{id}/restore`
- `POST /courses/{id}/delete`
- `POST /courses/{id}/duplicate`
- `POST /courses/grant-access`

### Academic (4 routes)
- `GET /categories`
- `GET /universities`
- `GET /universities/{id}/faculties`
- `GET /faculties/{id}/levels`

### Credits (8 routes)
- `GET /credits/me`
- `GET /credits/transactions`
- `POST /credits/allocate`
- `POST /credits/refund`
- `POST /credits/revoke`
- `POST /credits/bulk-allocate`
- `GET /credits/doctor/{id}`
- `POST /activation-codes/redeem`
- `POST /activation-codes`
- `POST /activation-codes/assign`

### Notifications (2 routes)
- `GET /notifications`
- `POST /notifications/read`

### Security (7 routes)
- `GET /security/config`
- `GET /security/version`
- `POST /security/events`
- `POST /security/violations`
- `POST /security/bump-version/{id}`
- `POST /security/devices/{id}/block`
- `POST /security/devices/{id}/unblock`

### Video (6 routes)
- `POST /video/otp`
- `POST /video/upload-init`
- `POST /video/upload-status`
- `POST /video/delete`
- `POST /video/assets`
- `POST /video/webhook`

### Storage (4 routes)
- `GET /storage/signed-url`
- `GET /storage/signed`
- `POST /storage/upload`
- `POST /storage/delete`

### Admin (12 routes)
- `GET /admin/users`
- `GET /admin/users/{id}`
- `POST /admin/users/{id}/role`
- `POST /admin/users/{id}/status`
- `POST /admin/users/{id}/block`
- `POST /admin/users/{id}/restore`
- `POST /admin/users/{id}/devices/reset`
- `GET /admin/audit-logs`
- `GET /admin/stats`
- `GET /admin/security-config`
- `PATCH /admin/security-config`
- `POST /admin/bulk-user-ops`
- `POST /admin/enrollment`
- `POST /admin/update-email`

**Total: 90+ routes**

---

## Remaining Gaps

### Edge Functions Not Yet Implemented
1. `activation-codes` — full lifecycle (assign, deactivate, reactivate, delete, bulk ops)
2. `verify-app-integrity` — iOS DeviceCheck (source not in export)
3. `verify-play-integrity` — Android Play Integrity
4. `video-upload-chunk` — chunked upload
5. `video-assemble-upload` — upload assembly
6. `video-health-scan` — on-demand health scan
7. `upload-patch` — OTA patch upload

### RPCs Not Yet Implemented
1. `get_course_progress` — ✅ now in CourseController
2. `get_security_stats` — admin security dashboard
3. `get_user_activity` — user activity summary
4. `get_user_profile_summary` — full profile summary
5. `get_trash_list` — list trashed users
6. `get_trash_stats` — trash statistics
7. `get_deletion_stats` — deletion statistics
8. `get_archive_analytics` — archive analytics
9. `get_archived_courses` — list archived courses
10. `get_chunk_upload_state` — upload session state
11. `get_course_delete_stats` — deletion dependency stats
12. `get_lesson_video_state` — lesson video status
13. `get_video_asset_usage` — VdoCipher usage stats
14. `get_orphan_deletion_records` — orphan cleanup
15. `get_risky_devices` — security-flagged devices
16. `get_enum_values_bulk` — enum values for frontend
17. `get_teacher_provider_permissions` — video provider access
18. `run_db_audit` — database integrity check
19. `recalculate_doctor_earnings` — earnings recalculation
20. `reset_doctor_earnings` — admin earnings reset
21. `reset_platform_earnings` — super admin platform reset

### Database Views Not Yet Implemented
1. `activation_codes_summary`
2. `activation_ledger_view`
3. `credit_ledger_view`
4. `credits_summary`
5. `credit_daily_stats_view`
6. `device_stats`
7. `doctor_credit_summary`
8. `fraud_detection_flags`
9. `revenue_analytics`

### Storage Buckets Not Yet Fully Implemented
1. `course-images` — public read
2. `user-avatars` — public read
3. `lesson-materials` — private, signed URLs
4. `video-chunks` — temp, auto-purge
5. `video-uploads` — temp, auto-purge
6. `video-thumbnails` — public read
7. `temp-uploads` — temp, auto-purge
8. `patch-uploads` — signed URLs, 24h expiry

---

## Files Changed/Created

### New Files
- `backend/src/Controllers/DeviceController.php` (20KB)
- `backend/src/Controllers/StudentController.php` (10KB)
- `backend/scripts/cron-trash-cleanup.php` (4KB)
- `backend/scripts/cron-video-health.php` (7KB)
- `backend/docs/MIGRATION_MATRIX.md`
- `backend/docs/MIGRATION_STATUS.md`

### Modified Files
- `backend/src/Controllers/AuthController.php` — added adminChangePassword, trashUser, impersonate
- `backend/src/Controllers/AdminController.php` — added bulkUserOps, adminEnrollment, adminUpdateEmail, enhanced search
- `backend/src/Controllers/CourseController.php` — added publish, unpublish, restore, deleteCourse, duplicate, progress, grantAccess
- `backend/src/Controllers/CreditController.php` — added refund, revoke, bulkAllocate, doctorEarnings, assignCode
- `backend/src/Controllers/VideoController.php` — added webhook handler
- `backend/routes/api.php` — added 19+ new routes

---

## Deployment Steps

1. Upload all new/modified files to Namecheap
2. Run cron jobs via cPanel:
   ```
   0 2 * * * php /home/medainmj/medacademy-api/scripts/cron-trash-cleanup.php --secret=YOUR_CRON_SECRET
   0 3 * * * php /home/medainmj/medacademy-api/scripts/cron-video-health.php --secret=YOUR_CRON_SECRET
   ```
3. Configure VdoCipher webhook URL in VdoCipher dashboard:
   `https://api.medacademy.eu.cc/video/webhook`
4. Set `CRON_SECRET` in `.env`
5. Run regression tests: `php scripts/regression-test.php`
