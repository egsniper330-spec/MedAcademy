# Supabase Edge Function → PHP mapping

Every function under `supabase/functions/` (41 total) maps to a PHP
service/controller. Column **Status**:

- `PORTED` — implemented in `backend/` (Phase 1)
- `PARTIAL` — core behaviour ported; remaining detail tracked in Phase 2
- `PHASE 2` — mapped, not yet implemented (no code invented — the business
  logic in the Edge Function is the spec)

All functions are **recreated from the actual source** in
`supabase/functions/<name>/index.ts` — none of this is invented.

| Edge Function | Purpose (from source) | PHP endpoint / service | Status |
|---|---|---|---|
| `activation-codes` | Batch create / deactivate activation codes | `CreditController::createCodes` + `POST /admin/activation-codes` | PARTIAL |
| `admin-doctor-earnings` | Admin updates a doctor's earnings settings | `AdminController` + `DoctorEarningsService` (Phase 2) | PHASE 2 |
| `admin-enrollment` | Admin enroll/unenroll students | `AdminController` + `EnrollmentService` | PARTIAL |
| `admin-update-email` | Super-admin updates auth email + profile email | `AdminController` (Phase 2) | PHASE 2 |
| `auth-probe` | Diagnostic auth isolation | `GET /health` | PARTIAL |
| `block-user` | Super-admin block/unblock user | `AdminController::blockUser` + `POST /admin/users/{id}/block` | PORTED |
| `bootstrap-super-admin` | One-time first super admin creation | `scripts/bootstrap-super-admin.php` (Phase 2) | PHASE 2 |
| `bulk-user-ops` | Bulk user operations (v76) | `AdminController` bulk endpoints (Phase 2) | PHASE 2 |
| `change-password` | Self password change; revoke device sessions | `AuthService::changePassword` + `POST /auth/change-password` | PORTED |
| `credits` | Allocate/refund/revoke credits, fraud flagging | `CreditController::allocate` (+ refund in Phase 2) | PARTIAL |
| `delete-course` | Cascade-delete a course | `CourseController` delete (Phase 2) | PHASE 2 |
| `delete-lesson` | Atomically delete lesson + assets | `LessonService` (Phase 2) | PHASE 2 |
| `delete-user` | Permanent account deletion pipeline | `AdminController` hard-delete (Phase 2) | PHASE 2 |
| `device-binding` | Device registration/block/unblock/logout/limit config | `AuthService::registerDevice/revokeDevice`, `SecurityController::blockDevice` | PORTED |
| `get-security-config` | Serve active security_config | `SecurityController::config` + `GET /security/config` | PORTED |
| `get-security-version` | Lightweight version check | `SecurityController::version` + `GET /security/version` | PORTED |
| `get-signed-url` | Signed URL for private storage (lesson-materials/pdfs) | `StorageController::signedUrl` + `GET /storage/signed-url` | PORTED |
| `impersonate` | Super-admin magic link for a user | `AuthService::impersonate` (Phase 2) | PHASE 2 |
| `process-violation` | Content-protection violation + strike policy | `SecurityService::processViolation` + `POST /security/violations` | PORTED |
| `provider-health` | Video provider health | `HealthController::providerHealth` + `GET /provider-health` | PORTED |
| `restore-account` | Restore trashed/deleted account | `AdminController::restoreUser` + `POST /admin/users/{id}/restore` | PORTED |
| `security-logger` | Log security events | `SecurityService::logEvent` + `POST /security/events` | PORTED |
| `student-operations` | Unified student account + activation operations | `AuthService` + `CreditController::redeem` | PARTIAL |
| `system-health` | System health + self-test runner | `HealthController::systemHealth` + `GET /system-health` | PORTED |
| `trash-cleanup` | Cron: purge expired trash | `scripts/cron-trash-cleanup.php` (Phase 2) | PHASE 2 |
| `trash-user` | Soft-delete with retention | `AdminController::setStatus` (trashed) | PORTED |
| `user-lookup` | Lookup by email/phone/user_id/name | `AuthService::lookupIdentifier` + `POST /auth/lookup` | PORTED |
| `user-management` | Role-gated user creation | `AdminController` (Phase 2) | PHASE 2 |
| `vdocipher-debug-creds` | DEBUG ONLY — do not migrate | — | SKIP (debug) |
| `vdocipher-delete-video` | Delete VdoCipher video + clear lesson ref | `VideoController::delete` + `POST /video/delete` | PORTED |
| `vdocipher-orphan-cleanup` | DEBUG ROLLBACK — cleanup disabled | — | SKIP (disabled) |
| `vdocipher-otp` | OTP playback token + dynamic watermark | `VdoCipherService::otp` + `POST /video/otp` | PORTED |
| `vdocipher-upload-init` | Create video entry + upload credentials | `VdoCipherService::uploadInit` + `POST /video/upload-init` | PORTED |
| `vdocipher-upload-status` | Poll encoding status | `VdoCipherService::uploadStatus` + `POST /video/upload-status` | PORTED |
| `verify-play-integrity` | Play Integrity token verification | `SecurityService::verifyPlayIntegrity` (Phase 2 — needs Google creds) | PHASE 2 |
| `video-assemble-upload` | Assemble chunks from video-chunks bucket | `VideoService::assembleChunks` (Phase 2) | PHASE 2 |
| `video-daily-health` | Scheduled daily health scan | `scripts/cron-video-health.php` (Phase 2) | PHASE 2 |
| `video-health-scan` | Video health scan | `HealthController` + `video_health_scans` writes (Phase 2) | PHASE 2 |
| `video-upload-chunk` | Store a binary chunk (video-chunks bucket) | `StorageController::upload` chunk variant (Phase 2) | PARTIAL |

## Notes

- **Auth/authorization** in every Edge Function (`requireAuth`, `requireRole`)
  is reproduced by `Middleware/AuthMiddleware` (JWT + account status +
  security_version + role allow-list).
- **Secrets**: `SUPABASE_SERVICE_ROLE_KEY`, `VDOCIPHER_API_SECRET`,
  `VDOCIPHER_WEBHOOK_SECRET` etc. become PHP environment variables in `.env`
  — never client-side.
- **Cron-style Edge Functions** (`trash-cleanup`, `video-daily-health`) become
  cPanel cron jobs invoking PHP CLI scripts (`scripts/`).
