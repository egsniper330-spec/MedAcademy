
-- Fix: search_audit_logs crashed with "operator does not exist: uuid ~~* text"
-- because resource_id is uuid and ILIKE cannot operate on uuid directly.
-- Fix: cast resource_id::text in the search predicate.
-- Also: complete category bucket coverage for all real audit_action enum values.

DROP FUNCTION IF EXISTS public.search_audit_logs(text, text[], text, text, timestamptz, timestamptz, int, int);

CREATE FUNCTION public.search_audit_logs(
  p_search        text        DEFAULT NULL,
  p_action_filter text[]      DEFAULT NULL,
  p_category      text        DEFAULT NULL,
  p_log_status    text        DEFAULT NULL,
  p_date_from     timestamptz DEFAULT NULL,
  p_date_to       timestamptz DEFAULT NULL,
  p_limit         int         DEFAULT 100,
  p_offset        int         DEFAULT 0
)
RETURNS TABLE (
  id            uuid,
  action        text,
  actor_id      uuid,
  actor_name    text,
  actor_email   text,
  actor_role    text,
  target_name   text,
  description   text,
  log_status    text,
  resource_type text,
  resource_id   text,
  old_values    jsonb,
  new_values    jsonb,
  details       jsonb,
  ip_address    text,
  created_at    timestamptz,
  total_count   bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_category_actions text[];
BEGIN
  -- ── Category bucket mapping (all real audit_action enum values) ─────────────
  IF p_category = 'users' THEN
    v_category_actions := ARRAY[
      'user_created','user_deleted','user_suspended','user_activated',
      'user_blocked','user_unblocked',
      'user_trashed','user_restored','user_hard_deleted','user_searched',
      'profile_updated','profile_name_changed','profile_email_changed',
      'profile_phone_changed','profile_avatar_changed',
      'name_changed','email_changed','avatar_changed','avatar_updated',
      'bulk_trash','bulk_restore','bulk_suspend','bulk_unsuspend',
      'bulk_permanent_delete','bulk_reset_devices','bulk_reset_password','bulk_device_reset',
      'account_restored','account_permanently_deleted',
      'admin_created','admin_updated','admin_deleted','super_admin_created',
      'initial_super_admin_created',
      'unlimited_devices_enabled','unlimited_devices_disabled',
      'unlimited_enabled','unlimited_disabled',
      'device_registered','device_reset','device_reset_by_admin',
      'device_force_logout','device_logout_all',
      'device_revoked','device_removed','device_blocked','device_unblocked',
      'device_limit_changed','limit_changed',
      'password_reset','password_reset_by_admin','password_changed_by_admin',
      'temp_password_generated','deletion_verification_failed',
      'trash_emptied','undo_delete','permission_changed'
    ];

  ELSIF p_category = 'roles' THEN
    v_category_actions := ARRAY[
      'role_changed','role_changed_to_doctor','role_changed_to_admin',
      'role_changed_to_super_admin','role_changed_to_student',
      'doctor_approved','doctor_rejected',
      'admin_created','admin_deleted','super_admin_created',
      'grant_admin','grant_super_admin','instructor_changed'
    ];

  ELSIF p_category = 'doctor' THEN
    v_category_actions := ARRAY[
      'doctor_approved','doctor_rejected','doctor_created',
      'earnings_settings_changed','update_earnings_settings',
      'custom_pricing_enabled','custom_pricing_disabled',
      'course_price_changed','credit_price_changed',
      'credit_allocated','credit_consumed_by_doctor','credit_deducted',
      'credits_added','credits_removed',
      'earnings_reset','revenue_settings_changed',
      'platform_earnings_reset'
    ];

  ELSIF p_category = 'student' THEN
    v_category_actions := ARRAY[
      'user_created','student_created_by_doctor','student_bulk_imported',
      'enrollment_created','enrollment_created_by_admin','enrollment_removed_by_admin',
      'enrollment_removed','enrollment_visibility_changed','enrollment_hidden_flag_set',
      'subscription_created','subscription_removed','subscription_restored',
      'credit_consumed','credit_consumed_by_doctor',
      'credits_added','credits_removed',
      'activation_code_used','code_redeemed',
      'course_assigned_by_doctor'
    ];

  ELSIF p_category = 'courses' THEN
    v_category_actions := ARRAY[
      'course_created','course_updated','course_deleted',
      'course_published','course_unpublished',
      'course_archived','course_restored','course_hidden',
      'lesson_created','lesson_updated','lesson_deleted',
      'category_created','category_updated','category_deleted',
      'university_created','university_updated','university_deleted',
      'video_uploaded','video_replaced','video_deleted',
      'pdf_uploaded','pdf_deleted',
      'thumbnail_changed','instructor_changed'
    ];

  ELSIF p_category = 'codes' THEN
    v_category_actions := ARRAY[
      'code_created','code_deleted','code_redeemed','code_deactivated',
      'code_activated','code_disabled','code_expired',
      'activation_code_created','activation_code_used'
    ];

  ELSIF p_category = 'auth' THEN
    v_category_actions := ARRAY[
      'login','logout','register','failed_login',
      'password_reset','password_changed','password_changed_first_login',
      'phone_login','impersonation_started','impersonation_ended',
      'password_reset_by_admin','session_revoked','provider_changed'
    ];

  ELSIF p_category = 'platform' THEN
    v_category_actions := ARRAY[
      'platform_settings_changed','settings_changed','security_policy_changed',
      'system_health_check','notification_sent','permission_changed'
    ];

  ELSIF p_category = 'finance' THEN
    v_category_actions := ARRAY[
      'credit_allocated','credit_consumed','credit_deducted',
      'credit_refunded','credit_expired','credit_consumed_by_doctor',
      'credits_added','credits_removed',
      'earnings_reset','platform_earnings_reset',
      'subscription_created','subscription_removed','subscription_restored',
      'enrollment_created','enrollment_created_by_admin','enrollment_removed_by_admin',
      'enrollment_removed','course_assigned_by_doctor',
      'credit_price_changed','course_price_changed'
    ];

  ELSIF p_category = 'videos' THEN
    v_category_actions := ARRAY[
      'video_uploaded','video_replaced','video_deleted',
      'video_play','video_play_failed','pdf_uploaded','pdf_deleted'
    ];

  ELSIF p_category = 'notifications' THEN
    v_category_actions := ARRAY['notification_sent'];

  ELSIF p_category = 'security' THEN
    v_category_actions := ARRAY[
      'security_event','security_policy_changed','root_detected',
      'jailbreak_detected','vpn_detected','proxy_detected','ssl_pinning_failure',
      'screenshot_detected','screen_recording_detected','debug_detected',
      'frida_detected','xposed_detected','app_integrity_compromised',
      'device_blocked','device_unblocked','session_revoked'
    ];

  -- legacy key kept for backward compatibility
  ELSIF p_category = 'login' THEN
    v_category_actions := ARRAY[
      'login','logout','register','failed_login',
      'password_reset','password_changed','phone_login',
      'impersonation_started','impersonation_ended',
      'device_registered','device_reset','device_reset_by_admin',
      'device_force_logout','device_logout_all',
      'device_revoked','device_removed','device_blocked','device_unblocked'
    ];

  END IF;

  RETURN QUERY
  SELECT
    al.id,
    al.action::text,
    al.actor_id,
    COALESCE(al.actor_name, p.full_name)      AS actor_name,
    COALESCE(al.actor_email, p.email)         AS actor_email,
    COALESCE(al.actor_role, p.role::text)     AS actor_role,
    al.target_name,
    al.description,
    al.log_status,
    al.resource_type,
    -- ← FIX: cast uuid→text so ILIKE can operate on it
    al.resource_id::text,
    al.old_values,
    al.new_values,
    al.details,
    al.ip_address,
    al.created_at,
    COUNT(*) OVER ()                           AS total_count
  FROM audit_logs al
  LEFT JOIN profiles p ON p.id = al.actor_id
  WHERE
    (v_category_actions IS NULL OR al.action::text = ANY(v_category_actions))
    AND (p_action_filter IS NULL OR al.action::text = ANY(p_action_filter))
    AND (p_log_status   IS NULL OR al.log_status = p_log_status)
    AND (p_date_from    IS NULL OR al.created_at >= p_date_from)
    AND (p_date_to      IS NULL OR al.created_at <= p_date_to)
    AND (
      p_search IS NULL
      OR al.description   ILIKE '%' || p_search || '%'
      OR al.target_name   ILIKE '%' || p_search || '%'
      OR al.actor_name    ILIKE '%' || p_search || '%'
      OR al.actor_email   ILIKE '%' || p_search || '%'
      OR COALESCE(p.full_name,'') ILIKE '%' || p_search || '%'
      OR COALESCE(p.email,'')     ILIKE '%' || p_search || '%'
      OR al.action::text  ILIKE '%' || p_search || '%'
      OR al.resource_type ILIKE '%' || p_search || '%'
      OR al.resource_id::text ILIKE '%' || p_search || '%'
    )
  ORDER BY al.created_at DESC
  LIMIT  p_limit
  OFFSET p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION public.search_audit_logs(text, text[], text, text, timestamptz, timestamptz, int, int)
  TO authenticated, service_role, anon;
