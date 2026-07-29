-- ══════════════════════════════════════════════════════════════════════════════
-- v216 — Fix hard_delete_user(): two classes of crash bugs
--
-- BUG 1 (universal crash — affects EVERY delete, SQLSTATE 42703):
--   UPDATE public.fraud_flags SET user_id = NULL WHERE user_id = p_target_user_id;
--   fraud_flags has NO user_id column (columns: id, doctor_id, flag_type,
--   severity, details, resolved, resolved_by, resolved_at, created_at).
--   This line is in the unconditional section with no EXCEPTION wrapper,
--   so it throws `undefined_column` and aborts the function on every call.
--
-- BUG 2 (crash for any user who created activation codes / code batches /
--        credit transactions / updated assistant permissions — SQLSTATE 23502):
--   Four FK columns are declared NOT NULL but the RPC tries SET col = NULL:
--     - activation_codes.created_by       NOT NULL  (NO ACTION FK)
--     - assistant_permissions.updated_by  NOT NULL  (NO ACTION FK)
--     - code_batches.created_by           NOT NULL  (NO ACTION FK)
--     - credit_transactions.performed_by  NOT NULL  (NO ACTION FK)
--   Attempting SET col = NULL on a NOT NULL column throws
--   `not_null_violation` (23502).
--   Fix: ALTER those columns to allow NULL, then the existing SET NULL works.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── Fix 2a: Make the four NOT NULL FK columns nullable ────────────────────────
ALTER TABLE public.activation_codes
  ALTER COLUMN created_by DROP NOT NULL;

ALTER TABLE public.assistant_permissions
  ALTER COLUMN updated_by DROP NOT NULL;

ALTER TABLE public.code_batches
  ALTER COLUMN created_by DROP NOT NULL;

ALTER TABLE public.credit_transactions
  ALTER COLUMN performed_by DROP NOT NULL;

-- ── Fix 1+2b: Redeploy hard_delete_user() without the bogus fraud_flags line ──
DROP FUNCTION IF EXISTS public.hard_delete_user(UUID, UUID, TEXT);

CREATE FUNCTION public.hard_delete_user(
  p_target_user_id UUID,
  p_actor_id       UUID,
  p_reason         TEXT DEFAULT 'Admin-initiated permanent delete'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_profile        RECORD;
  v_actor          RECORD;
  v_admin_count    INT;
  v_sa_count       INT;
  v_course_count   INT;
  v_deleted_label  TEXT;
  v_actor_label    TEXT;
BEGIN
  -- ── 1. Load target profile ──────────────────────────────────────────────────
  SELECT id, full_name, role, email, phone_e164, status
  INTO   v_profile FROM public.profiles WHERE id = p_target_user_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success',false,'code','NOT_FOUND','message','User not found');
  END IF;

  SELECT id, role, full_name INTO v_actor FROM public.profiles WHERE id = p_actor_id;

  v_deleted_label := CASE v_profile.role
    WHEN 'student'     THEN 'Deleted Student'
    WHEN 'doctor'      THEN 'Deleted Doctor'
    WHEN 'admin'       THEN 'Deleted Admin'
    WHEN 'super_admin' THEN 'Deleted Super Admin'
    ELSE                    'Deleted User'
  END;
  v_actor_label := COALESCE(v_actor.full_name, 'Unknown Actor');

  -- ── 2. Business-rule guards ─────────────────────────────────────────────────
  -- Doctor with active courses (v212: 'deleted' is not a valid course_status enum)
  IF v_profile.role = 'doctor' AND (v_actor.role IS DISTINCT FROM 'super_admin') THEN
    SELECT COUNT(*) INTO v_course_count FROM public.courses
    WHERE  doctor_id = p_target_user_id
      AND  status != 'archived'::public.course_status;
    IF v_course_count > 0 THEN
      RETURN json_build_object(
        'success', false, 'code', 'DOCTOR_HAS_COURSES',
        'message', format('Doctor has %s active course(s). Archive them first.', v_course_count)
      );
    END IF;
  END IF;

  IF v_profile.role = 'admin' THEN
    SELECT COUNT(*) INTO v_admin_count FROM public.profiles
    WHERE  role = 'admin' AND status = 'active' AND id <> p_target_user_id;
    IF v_admin_count = 0 THEN
      RETURN json_build_object('success',false,'code','LAST_ADMIN',
        'message','Cannot delete the last active admin.');
    END IF;
  END IF;

  IF v_profile.role = 'super_admin' THEN
    SELECT COUNT(*) INTO v_sa_count FROM public.profiles
    WHERE  role = 'super_admin' AND status = 'active' AND id <> p_target_user_id;
    IF v_sa_count = 0 THEN
      RETURN json_build_object('success',false,'code','LAST_SUPER_ADMIN',
        'message','Cannot delete the last active super admin.');
    END IF;
  END IF;

  -- ── 3. Nullify ALL NO ACTION FKs before DELETE FROM profiles ───────────────
  --
  -- Verified against live information_schema.referential_constraints:
  -- delete_rule = 'NO ACTION' means PostgreSQL will REFUSE the DELETE unless
  -- we nullify (or delete) every referencing row first.
  --
  -- CASCADE / SET NULL FKs are handled automatically by PostgreSQL — not listed.
  --
  -- ┌──────────────────────────────────────────────────────────────────────────┐
  -- │ Table                            │ Column        │ Nullable │ Fix ver   │
  -- ├──────────────────────────────────┼───────────────┼──────────┼───────────┤
  -- │ activation_codes                 │ created_by    │ YES(v216)│ original  │
  -- │ assistant_permissions            │ updated_by    │ YES(v216)│ v214      │
  -- │ audit_logs                       │ user_id       │ YES      │ original  │
  -- │ code_batches                     │ created_by    │ YES(v216)│ original  │
  -- │ content_protection_policies      │ updated_by    │ YES      │ v215      │
  -- │ courses                          │ archived_by   │ YES      │ original  │
  -- │ courses                          │ restored_by   │ YES      │ original  │
  -- │ credit_transactions              │ performed_by  │ YES(v216)│ original  │
  -- │ credit_transactions              │ student_id    │ YES      │ original  │
  -- │ fraud_flags                      │ resolved_by   │ YES      │ v214      │
  -- │ provider_audit_log               │ actor_id      │ YES      │ original  │
  -- │ subscription_timeline            │ actor_id      │ YES      │ original  │
  -- │ system_config                    │ updated_by    │ YES      │ v214      │
  -- │ video_health_alerts              │ resolved_by   │ YES      │ original  │
  -- │ video_health_scans               │ triggered_by  │ YES      │ v214      │
  -- └──────────────────────────────────┴───────────────┴──────────┴───────────┘
  --
  -- NOTE: fraud_flags.user_id does NOT exist — removed (was bug #1 in v214/v215)

  -- audit_logs (two FK columns: user_id + actor_id; actor_id is SET NULL → safe)
  UPDATE public.audit_logs
  SET    user_id = NULL,
         details = COALESCE(details, '{}')
                   || jsonb_build_object(
                        'deleted_actor_label', v_deleted_label,
                        'deletion_reason',     p_reason)
  WHERE  user_id = p_target_user_id;

  -- credit_transactions
  UPDATE public.credit_transactions SET performed_by = NULL WHERE performed_by = p_target_user_id;
  UPDATE public.credit_transactions SET student_id   = NULL WHERE student_id   = p_target_user_id;

  -- activation_codes
  UPDATE public.activation_codes SET created_by = NULL WHERE created_by = p_target_user_id;

  -- code_batches
  UPDATE public.code_batches SET created_by = NULL WHERE created_by = p_target_user_id;

  -- courses
  UPDATE public.courses SET archived_by = NULL WHERE archived_by = p_target_user_id;
  UPDATE public.courses SET restored_by = NULL WHERE restored_by = p_target_user_id;

  -- fraud_flags — only resolved_by (NO ACTION); user_id column does NOT exist
  UPDATE public.fraud_flags SET resolved_by = NULL WHERE resolved_by = p_target_user_id;

  -- provider_audit_log
  UPDATE public.provider_audit_log SET actor_id = NULL WHERE actor_id = p_target_user_id;

  -- subscription_timeline
  UPDATE public.subscription_timeline SET actor_id = NULL WHERE actor_id = p_target_user_id;

  -- Optional tables — wrapped in EXCEPTION to tolerate missing table/column
  BEGIN
    UPDATE public.assistant_permissions SET updated_by = NULL WHERE updated_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  BEGIN
    UPDATE public.system_config SET updated_by = NULL WHERE updated_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  BEGIN
    UPDATE public.video_health_scans SET triggered_by = NULL WHERE triggered_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  BEGIN
    UPDATE public.content_protection_policies SET updated_by = NULL WHERE updated_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  BEGIN
    UPDATE public.video_health_alerts SET resolved_by = NULL WHERE resolved_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  BEGIN
    UPDATE public.assistant_permissions SET granted_by = NULL WHERE granted_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  BEGIN
    UPDATE public.security_policies SET created_by = NULL WHERE created_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  BEGIN
    UPDATE public.security_vpn_whitelist SET added_by = NULL WHERE added_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  BEGIN
    UPDATE public.content_protection_policies SET created_by = NULL WHERE created_by = p_target_user_id;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL; END;

  -- ── 4. Delete profile row (CASCADE handles devices, enrollments, etc.) ──────
  DELETE FROM public.profiles WHERE id = p_target_user_id;

  -- ── 5. Final audit entry ────────────────────────────────────────────────────
  INSERT INTO public.audit_logs(actor_id, action, resource_type, resource_id, success, details)
  VALUES (p_actor_id, 'account_permanently_deleted', 'profile', p_target_user_id, true,
    jsonb_build_object(
      'deleted_name',        v_profile.full_name,
      'deleted_role',        v_profile.role,
      'deleted_actor_label', v_deleted_label,
      'actor_name',          v_actor_label,
      'actor_role',          v_actor.role,
      'reason',              p_reason
    )
  );

  RETURN json_build_object(
    'success',       true,
    'deleted_name',  v_profile.full_name,
    'deleted_role',  v_profile.role,
    'deleted_label', v_deleted_label
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.hard_delete_user(UUID, UUID, TEXT) TO authenticated;