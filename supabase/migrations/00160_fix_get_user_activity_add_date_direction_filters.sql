
-- Fix get_user_activity:
--   1. resource_id::text cast (same uuid ~~* text crash as search_audit_logs)
--   2. Add p_date_from / p_date_to for date range filtering
--   3. Add p_direction: 'by' (actor_id = user) | 'on' (user_id/resource_id = user) | NULL (both)
--   4. Expand category buckets to cover all required action groups
--   5. Add user_blocked/user_unblocked + device_* + role_* to appropriate buckets

DROP FUNCTION IF EXISTS get_user_activity(uuid, text, text, int, int);

CREATE FUNCTION get_user_activity(
  p_user_id   uuid,
  p_category  text        DEFAULT NULL,
  p_search    text        DEFAULT NULL,
  p_date_from timestamptz DEFAULT NULL,
  p_date_to   timestamptz DEFAULT NULL,
  p_direction text        DEFAULT NULL,   -- 'by' | 'on' | NULL (both)
  p_limit     int         DEFAULT 50,
  p_offset    int         DEFAULT 0
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
  resource_id    text,
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
  CASE p_category
    WHEN 'auth' THEN
      v_actions := ARRAY[
        'login','logout','register','failed_login',
        'password_reset','password_changed','password_changed_first_login',
        'password_changed_by_admin','password_reset_by_admin',
        'phone_login','session_revoked','provider_changed',
        'impersonation_started','impersonation_ended'
      ];
    WHEN 'profile' THEN
      v_actions := ARRAY[
        'user_created','admin_created','super_admin_created',
        'student_created_by_doctor','student_bulk_imported',
        'profile_updated','profile_name_changed','profile_email_changed',
        'profile_phone_changed','profile_avatar_changed',
        'name_changed','email_changed','avatar_changed','avatar_updated',
        'settings_changed','permission_changed','temp_password_generated'
      ];
    WHEN 'security' THEN
      v_actions := ARRAY[
        'security_event','security_policy_changed',
        'root_detected','jailbreak_detected','vpn_detected','proxy_detected',
        'ssl_pinning_failure','screenshot_detected','screen_recording_detected',
        'debug_detected','frida_detected','xposed_detected','app_integrity_compromised',
        'deletion_verification_failed','session_revoked'
      ];
    WHEN 'devices' THEN
      v_actions := ARRAY[
        'device_registered','device_reset','device_reset_by_admin',
        'device_force_logout','device_logout_all',
        'device_revoked','device_removed',
        'device_blocked','device_unblocked',
        'device_limit_changed','limit_changed',
        'unlimited_devices_enabled','unlimited_devices_disabled',
        'unlimited_enabled','unlimited_disabled'
      ];
    WHEN 'courses' THEN
      v_actions := ARRAY[
        'course_created','course_updated','course_deleted',
        'course_published','course_unpublished','course_archived','course_restored',
        'course_assigned_by_doctor',
        'enrollment_created','enrollment_created_by_admin',
        'enrollment_removed_by_admin','enrollment_removed',
        'enrollment_visibility_changed','enrollment_hidden_flag_set',
        'lesson_created','lesson_updated','lesson_deleted',
        'video_uploaded','video_replaced','video_deleted','video_play','video_play_failed',
        'pdf_uploaded','pdf_deleted','thumbnail_changed'
      ];
    WHEN 'purchases' THEN
      v_actions := ARRAY[
        'credit_allocated','credit_consumed','credit_deducted',
        'credit_refunded','credit_expired','credit_consumed_by_doctor',
        'credits_added','credits_removed',
        'code_created','code_redeemed','code_deactivated','code_deleted',
        'code_activated','code_disabled','code_expired',
        'activation_code_created','activation_code_used',
        'subscription_created','subscription_removed','subscription_restored',
        'earnings_reset','platform_earnings_reset',
        'course_price_changed','credit_price_changed',
        'earnings_settings_changed','update_earnings_settings'
      ];
    WHEN 'admin_actions' THEN
      v_actions := ARRAY[
        'user_suspended','user_activated','user_deleted','user_hard_deleted',
        'user_trashed','user_restored',
        'bulk_trash','bulk_restore','bulk_suspend','bulk_unsuspend',
        'bulk_permanent_delete','bulk_reset_devices','bulk_reset_password',
        'account_restored','account_permanently_deleted',
        'trash_emptied','undo_delete',
        'password_reset_by_admin','password_changed_by_admin',
        'impersonation_started','impersonation_ended',
        'notification_sent','admin_created','admin_updated','admin_deleted',
        'super_admin_created','initial_super_admin_created',
        'deletion_verification_failed'
      ];
    WHEN 'roles' THEN
      v_actions := ARRAY[
        'role_changed','role_changed_to_doctor','role_changed_to_admin',
        'role_changed_to_super_admin','role_changed_to_student',
        'doctor_approved','doctor_rejected',
        'grant_admin','grant_super_admin','instructor_changed',
        'admin_created','admin_deleted'
      ];
    WHEN 'blocking' THEN
      v_actions := ARRAY[
        'user_blocked','user_unblocked',
        'device_blocked','device_unblocked',
        'user_suspended','user_activated',
        'bulk_suspend','bulk_unsuspend',
        'session_revoked'
      ];
    WHEN 'system' THEN
      v_actions := ARRAY[
        'platform_settings_changed','settings_changed',
        'security_policy_changed','system_health_check',
        'notification_sent','permission_changed',
        'platform_earnings_reset','earnings_reset'
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
    COALESCE(al.actor_email, p.email)       AS actor_email,
    COALESCE(al.actor_role,  p.role::text)  AS actor_role,
    al.target_name,
    al.description,
    al.log_status,
    al.resource_type,
    al.resource_id::text,                   -- ← FIX: uuid→text
    al.old_values,
    al.new_values,
    al.details,
    al.ip_address,
    al.created_at,
    COUNT(*) OVER ()                        AS total_count
  FROM audit_logs al
  LEFT JOIN profiles p ON p.id = al.actor_id
  WHERE
    -- Direction filter
    CASE
      WHEN p_direction = 'by' THEN al.actor_id = p_user_id
      WHEN p_direction = 'on' THEN (al.user_id = p_user_id OR al.resource_id = p_user_id)
      ELSE (al.user_id = p_user_id OR al.actor_id = p_user_id OR al.resource_id = p_user_id)
    END
    AND (v_actions   IS NULL OR al.action::text = ANY(v_actions))
    AND (p_date_from IS NULL OR al.created_at >= p_date_from)
    AND (p_date_to   IS NULL OR al.created_at <= p_date_to)
    AND (
      p_search IS NULL
      OR al.description   ILIKE '%' || p_search || '%'
      OR al.target_name   ILIKE '%' || p_search || '%'
      OR al.actor_name    ILIKE '%' || p_search || '%'
      OR COALESCE(p.full_name,'') ILIKE '%' || p_search || '%'
      OR al.action::text  ILIKE '%' || p_search || '%'
      OR al.resource_type ILIKE '%' || p_search || '%'
    )
  ORDER BY al.created_at DESC
  LIMIT  p_limit
  OFFSET p_offset;
END;
$$;

REVOKE ALL ON FUNCTION get_user_activity FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_user_activity TO authenticated, service_role;
