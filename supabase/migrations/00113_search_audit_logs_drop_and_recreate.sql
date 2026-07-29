
-- Drop both overloads of search_audit_logs before replacing them
DROP FUNCTION IF EXISTS public.search_audit_logs(text, text[], text, text, text, text, int, int);
DROP FUNCTION IF EXISTS public.search_audit_logs(text, text[], text, text, timestamptz, timestamptz, int, int);

-- Single canonical version with new category buckets
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
  IF p_category = 'users' THEN
    v_category_actions := ARRAY[
      'user_created','user_deleted','user_suspended','user_activated',
      'user_trashed','user_restored','user_hard_deleted','profile_updated',
      'bulk_trash','bulk_restore','bulk_suspend','bulk_unsuspend','bulk_permanent_delete',
      'account_restored','account_permanently_deleted',
      'admin_created','admin_updated','admin_deleted','super_admin_created',
      'unlimited_devices_enabled','unlimited_devices_disabled',
      'device_registered','device_reset','device_force_logout','device_logout_all',
      'device_revoked','device_removed','device_blocked','device_unblocked',
      'password_reset_by_admin'
    ];

  ELSIF p_category = 'roles' THEN
    v_category_actions := ARRAY[
      'role_changed','role_changed_to_doctor','role_changed_to_admin',
      'role_changed_to_super_admin','role_changed_to_student',
      'doctor_approved','doctor_rejected',
      'admin_created','admin_deleted'
    ];

  ELSIF p_category = 'doctor' THEN
    v_category_actions := ARRAY[
      'doctor_approved','doctor_rejected','doctor_created','doctor_removed',
      'earnings_settings_changed','custom_pricing_enabled','custom_pricing_disabled',
      'course_price_changed','credit_price_changed',
      'credit_allocated','credit_consumed_by_doctor','credit_deducted',
      'earnings_reset','revenue_settings_changed',
      'doctor_pricing_updated','pricing_updated',
      'doctor_course_assigned','doctor_course_removed'
    ];

  ELSIF p_category = 'student' THEN
    v_category_actions := ARRAY[
      'user_created',
      'enrollment_created','enrollment_created_by_admin','enrollment_removed_by_admin',
      'subscription_created','subscription_removed','subscription_restored',
      'credit_consumed','course_purchased','course_activated',
      'credits_purchased','activation_code_used','code_redeemed'
    ];

  ELSIF p_category = 'courses' THEN
    v_category_actions := ARRAY[
      'course_created','course_updated','course_deleted',
      'course_published','course_unpublished',
      'course_archived','course_restored','course_permanently_deleted',
      'lesson_created','lesson_updated','lesson_deleted',
      'category_created','category_updated','category_deleted',
      'university_created','university_updated','university_deleted',
      'video_uploaded','video_replaced','video_deleted',
      'pdf_uploaded','pdf_deleted'
    ];

  ELSIF p_category = 'codes' THEN
    v_category_actions := ARRAY[
      'code_created','code_deleted','code_redeemed','code_deactivated',
      'activation_code_created','activation_code_used',
      'code_expired','code_disabled','code_enabled'
    ];

  ELSIF p_category = 'auth' THEN
    v_category_actions := ARRAY[
      'login','logout','register','password_reset','password_changed',
      'phone_login','impersonation_started','impersonation_ended',
      'password_reset_by_admin','failed_login','session_revoked'
    ];

  ELSIF p_category = 'platform' THEN
    v_category_actions := ARRAY[
      'platform_pricing_changed','default_credit_price_changed',
      'security_settings_changed','platform_settings_updated',
      'system_config_updated','notification_sent'
    ];

  ELSIF p_category = 'finance' THEN
    v_category_actions := ARRAY[
      'credit_allocated','credit_consumed','credit_deducted',
      'credit_refunded','credit_expired','credit_consumed_by_doctor',
      'earnings_reset','platform_earnings_reset',
      'subscription_created','subscription_removed','subscription_restored',
      'enrollment_created','enrollment_created_by_admin','enrollment_removed_by_admin',
      'course_purchased','credits_purchased'
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
      'frida_detected','xposed_detected','app_integrity_compromised'
    ];

  ELSIF p_category = 'login' THEN   -- legacy key
    v_category_actions := ARRAY[
      'login','logout','register','password_reset','password_changed',
      'phone_login','impersonation_started','impersonation_ended',
      'device_registered','device_reset','device_force_logout','device_logout_all',
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
    al.resource_id,
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
    AND (p_log_status IS NULL OR al.log_status = p_log_status)
    AND (p_date_from IS NULL OR al.created_at >= p_date_from)
    AND (p_date_to   IS NULL OR al.created_at <= p_date_to)
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
      OR al.resource_id   ILIKE '%' || p_search || '%'
    )
  ORDER BY al.created_at DESC
  LIMIT  p_limit
  OFFSET p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION public.search_audit_logs(text, text[], text, text, timestamptz, timestamptz, int, int) TO authenticated, service_role;
