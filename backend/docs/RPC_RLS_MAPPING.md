# PostgreSQL RPC / RLS → PHP mapping

The MySQL database has no RLS and no SECURITY DEFINER functions. Every
authorization decision moves into the PHP layer. This document is the map.

## RLS policies (148 final, 183 created)

RLS enforced `auth.uid()`-based rules per table. Equivalent enforcement in PHP:

| Pattern | PHP equivalent |
|---|---|
| `id = auth.uid() OR is_admin_or_super_admin()` | `AuthMiddleware` user context; service checks `$request->user['id']` / role |
| `doctor_id = auth.uid() OR is_admin_or_super_admin()` (courses/sections/lessons) | `CourseController::assertCourseOwner()` |
| `status = 'published' OR owner/admin` | encoded directly in `CourseController` SELECT WHERE clauses |
| `is_doctor_or_above()` (enrollments/progress reads) | role check `['doctor','admin','super_admin']` in `AuthMiddleware` |
| `assistant_id = auth.uid() OR admin` | `assistant_permissions` lookup in `AuthMiddleware` (option `permission`) |
| `is_admin_or_super_admin()` | route option `role => ['admin','super_admin']` |
| `get_my_role() = 'super_admin'` | route option `role => ['super_admin']` |

**Rule:** a PHP service may only relax a check when the original RLS policy
proves the access is broader. None were relaxed in Phase 1.

## SECURITY DEFINER functions (246 total) — priority classes

| Class | Examples | PHP target | Status |
|---|---|---|---|
| Auth / device | `pre_login_device_check`, `register_device_for_user`, `bump_security_version`, `set_user_role`, `set_user_status`, `lookup_user_by_identifier`, `get_email_by_phone`, `sync_auth_phone_*` | `AuthService`, `SessionManager` | PORTED |
| Credits / codes | `redeem_activation_code`, `allocate_credits`, `grant_course_access`, `create_activation_code*`, `process_student_activation` | `CreditController`, `AuthService` | PORTED (core) |
| Earnings | `trg_record_earnings_event`, `trg_deduct_earnings_on_account_deletion`, `recalculate_doctor_earnings`, `get_doctor_earnings_dashboard` | MySQL triggers + `DoctorEarningsService` | PARTIAL (triggers ported; dashboard Phase 2) |
| Courses/LMS | `create_course_audited`, `update_course_audited`, `archive_course`, `get_course_for_edit` | `CourseController` + `AuditService` | PARTIAL |
| Admin | `hard_delete_user`, `bulk_trash_users`, `bulk_restore_users`, `trash_user`, `restore_account`, `search_audit_logs`, `get_user_activity` | `AdminController` + `AuditService` | PARTIAL (search/list ported; delete pipeline Phase 2) |
| Security | `check_auth_web_fingerprint`, `record_security_event`, `process_violation`, `get_security_config` | `SecurityService` | PORTED (core) |
| Views backing | `admin_all_profiles` (= `SELECT * FROM profiles`) | direct `profiles` queries | PORTED |

## PostgreSQL-specific features → replacements

| PG feature | MySQL replacement |
|---|---|
| `auth.uid()` | JWT `sub` claim (verified in `AuthMiddleware`) |
| SECURITY DEFINER | PHP services run as the application DB user; authorization is explicit per service |
| RLS | middleware + service-level checks (above) |
| `tsvector` search | `LIKE` + FULLTEXT in Phase 2 (`SearchService`) |
| Enums (`CREATE TYPE ... AS ENUM`) | `VARCHAR(n)` + `CHECK (col IN (...))` (schema.sql) |
| `jsonb` | `JSON` column type |
| `gen_random_bytes()` defaults | app-generated (PHP `random_bytes`) |
| Triggers | MySQL triggers in schema.sql (business invariants) + PHP as primary enforcer |
| Sequences (`wm_id_seq`) | `watermark_seq` table |
| Materialized / regular views | recreated as MySQL views where used by the API (see schema.sql notes) |

## Audit trail

`audit_logs` keeps the full PG `audit_action` vocabulary (100+ values) via a
CHECK constraint; `AuditService::write()` is called by every mutating service,
mirroring the `write_audit_log` RPC used by the Edge Functions.
