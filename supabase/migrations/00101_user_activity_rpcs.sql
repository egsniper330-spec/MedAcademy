
-- ── 1. get_user_profile_summary ──────────────────────────────────────────────
-- Returns enriched profile with last_login, last_logout, last_active derived
-- from audit_logs.
CREATE OR REPLACE FUNCTION get_user_profile_summary(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile  profiles%ROWTYPE;
  v_last_login   timestamptz;
  v_last_logout  timestamptz;
  v_last_active  timestamptz;
BEGIN
  SELECT * INTO v_profile FROM profiles WHERE id = p_user_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT created_at INTO v_last_login
  FROM audit_logs
  WHERE (user_id = p_user_id OR actor_id = p_user_id)
    AND action::text = 'login'
  ORDER BY created_at DESC LIMIT 1;

  SELECT created_at INTO v_last_logout
  FROM audit_logs
  WHERE (user_id = p_user_id OR actor_id = p_user_id)
    AND action::text = 'logout'
  ORDER BY created_at DESC LIMIT 1;

  SELECT created_at INTO v_last_active
  FROM audit_logs
  WHERE (user_id = p_user_id OR actor_id = p_user_id)
  ORDER BY created_at DESC LIMIT 1;

  RETURN jsonb_build_object(
    'id',           v_profile.id,
    'full_name',    v_profile.full_name,
    'email',        v_profile.email,
    'profile_email',v_profile.profile_email,
    'phone',        v_profile.phone,
    'role',         v_profile.role,
    'status',       v_profile.status,
    'avatar_url',   v_profile.avatar_url,
    'created_at',   v_profile.created_at,
    'last_login',   v_last_login,
    'last_logout',  v_last_logout,
    'last_active',  v_last_active
  );
END;
$$;

REVOKE ALL ON FUNCTION get_user_profile_summary FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_user_profile_summary TO authenticated;

-- ── 2. get_user_activity ─────────────────────────────────────────────────────
-- Returns paginated activity for a specific user: events where they are the
-- subject (user_id = p_user_id) OR the actor (actor_id = p_user_id).
CREATE OR REPLACE FUNCTION get_user_activity(
  p_user_id   uuid,
  p_category  text    DEFAULT NULL,   -- 'logins'|'courses'|'lessons'|'videos'|'payments'|'profile'|'admin_actions'
  p_search    text    DEFAULT NULL,
  p_limit     int     DEFAULT 50,
  p_offset    int     DEFAULT 0
)
RETURNS TABLE (
  id             uuid,
  action         text,
  actor_id       uuid,
  actor_name     text,
  actor_email    text,
  actor_role     text,
  target_name    text,
  description    text,
  log_status     text,
  resource_type  text,
  resource_id    uuid,
  old_values     jsonb,
  new_values     jsonb,
  details        jsonb,
  ip_address     text,
  created_at     timestamptz,
  total_count    bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actions text[];
BEGIN
  -- Map category to action groups
  CASE p_category
    WHEN 'logins' THEN
      v_actions := ARRAY[
        'login','logout','register','password_reset','password_changed',
        'password_changed_first_login','phone_login',
        'device_registered','device_reset','device_force_logout',
        'device_logout_all','device_revoked','device_removed',
        'device_blocked','device_unblocked',
        'impersonation_started','impersonation_ended'
      ];
    WHEN 'courses' THEN
      v_actions := ARRAY[
        'course_created','course_updated','course_deleted',
        'course_published','course_unpublished','course_assigned_by_doctor',
        'enrollment_created','enrollment_created_by_admin',
        'enrollment_removed_by_admin','enrollment_hidden_flag_set',
        'enrollment_visibility_changed',
        'doctor_approved','doctor_rejected'
      ];
    WHEN 'lessons' THEN
      v_actions := ARRAY[
        'lesson_created','lesson_updated','lesson_deleted'
      ];
    WHEN 'videos' THEN
      v_actions := ARRAY[
        'video_uploaded','video_replaced','video_deleted',
        'video_play','video_play_failed',
        'pdf_uploaded','pdf_deleted'
      ];
    WHEN 'payments' THEN
      v_actions := ARRAY[
        'credit_allocated','credit_consumed','credit_deducted',
        'credit_refunded','credit_expired','credit_consumed_by_doctor',
        'code_created','code_redeemed','code_deactivated','code_deleted',
        'activation_code_created','activation_code_used',
        'subscription_created','subscription_removed','subscription_restored',
        'earnings_reset','platform_earnings_reset'
      ];
    WHEN 'profile' THEN
      v_actions := ARRAY[
        'user_created','admin_created','super_admin_created',
        'profile_updated','avatar_updated','settings_changed',
        'role_changed','permission_changed',
        'user_suspended','user_activated','user_deleted',
        'user_trashed','user_restored','user_hard_deleted',
        'account_restored','account_permanently_deleted',
        'temp_password_generated','student_created_by_doctor'
      ];
    WHEN 'admin_actions' THEN
      v_actions := ARRAY[
        'user_suspended','user_activated','user_deleted','user_hard_deleted',
        'user_trashed','user_restored','bulk_trash','bulk_restore',
        'bulk_suspend','bulk_unsuspend','bulk_permanent_delete',
        'role_changed','permission_changed','limit_changed',
        'unlimited_enabled','unlimited_disabled',
        'device_limit_changed','unlimited_devices_enabled','unlimited_devices_disabled',
        'impersonation_started','impersonation_ended',
        'deletion_verification_failed','trash_emptied',
        'security_policy_changed','notification_sent','earnings_reset',
        'platform_earnings_reset','admin_created','admin_updated','admin_deleted'
      ];
    ELSE
      v_actions := NULL;
  END CASE;

  RETURN QUERY
  SELECT
    al.id,
    al.action::text,
    al.actor_id,
    COALESCE(al.actor_name,  p.full_name)   AS actor_name,
    COALESCE(al.actor_email, p.email)        AS actor_email,
    COALESCE(al.actor_role,  p.role::text)   AS actor_role,
    al.target_name,
    al.description,
    al.log_status,
    al.resource_type,
    al.resource_id,
    al.old_values,
    al.new_values,
    al.details,
    al.ip_address,
    al.created_at,
    COUNT(*) OVER ()                         AS total_count
  FROM audit_logs al
  LEFT JOIN profiles p ON p.id = al.actor_id
  WHERE
    -- Scope: events where this user is the subject OR the actor
    (al.user_id = p_user_id OR al.actor_id = p_user_id OR al.resource_id = p_user_id)
    -- Category filter
    AND (v_actions IS NULL OR al.action::text = ANY(v_actions))
    -- Full-text search
    AND (
      p_search IS NULL
      OR al.description   ILIKE '%' || p_search || '%'
      OR al.target_name   ILIKE '%' || p_search || '%'
      OR al.actor_name    ILIKE '%' || p_search || '%'
      OR COALESCE(p.full_name,'') ILIKE '%' || p_search || '%'
      OR al.action::text  ILIKE '%' || p_search || '%'
    )
  ORDER BY al.created_at DESC
  LIMIT  p_limit
  OFFSET p_offset;
END;
$$;

REVOKE ALL ON FUNCTION get_user_activity FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_user_activity TO authenticated;
