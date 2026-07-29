
-- ── 1. Add missing audit_action enum values ───────────────────────────────────
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'doctor_approved';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'doctor_rejected';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'video_replaced';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'video_deleted';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'course_published';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'course_unpublished';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'category_created';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'category_updated';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'category_deleted';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'university_created';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'university_updated';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'university_deleted';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'notification_sent';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'admin_updated';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'admin_deleted';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'earnings_reset';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'activation_code_created';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'activation_code_used';

-- ── 2. Add enriched columns to audit_logs ────────────────────────────────────
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS target_name   text,
  ADD COLUMN IF NOT EXISTS description   text,
  ADD COLUMN IF NOT EXISTS log_status    text NOT NULL DEFAULT 'success'
    CHECK (log_status IN ('success', 'failed', 'warning'));

-- ── 3. Denormalize actor fields so logs survive profile deletion ─────────────
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS actor_name  text,
  ADD COLUMN IF NOT EXISTS actor_email text,
  ADD COLUMN IF NOT EXISTS actor_role  text;

-- ── 4. Indexes for audit trail queries ───────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_logs_action       ON audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_log_status   ON audit_logs (log_status);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_id     ON audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource     ON audit_logs (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at   ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target_name  ON audit_logs USING gin (to_tsvector('simple', coalesce(target_name,'')));
CREATE INDEX IF NOT EXISTS idx_audit_logs_description  ON audit_logs USING gin (to_tsvector('simple', coalesce(description,'')));

-- ── 5. Back-fill log_status from existing boolean success column ─────────────
UPDATE audit_logs
SET log_status = CASE WHEN success THEN 'success' ELSE 'failed' END
WHERE log_status = 'success';

-- ── 6. Full-text search function for audit trail ──────────────────────────────
CREATE OR REPLACE FUNCTION search_audit_logs(
  p_search        text       DEFAULT NULL,
  p_action_filter text[]     DEFAULT NULL,   -- array of action values
  p_category      text       DEFAULT NULL,   -- 'users'|'doctors'|'courses'|'videos'|'categories'|'universities'|'login'|'finance'|'notifications'
  p_log_status    text       DEFAULT NULL,   -- 'success'|'failed'|'warning'
  p_date_from     timestamptz DEFAULT NULL,
  p_date_to       timestamptz DEFAULT NULL,
  p_limit         int        DEFAULT 100,
  p_offset        int        DEFAULT 0
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
  v_category_actions text[];
BEGIN
  -- Map category to action groups
  IF p_category = 'users' THEN
    v_category_actions := ARRAY['user_created','user_deleted','user_suspended','user_activated',
      'user_trashed','user_restored','user_hard_deleted','profile_updated','role_changed',
      'bulk_trash','bulk_restore','bulk_suspend','bulk_unsuspend','bulk_permanent_delete',
      'account_restored','account_permanently_deleted','admin_created','admin_updated','admin_deleted',
      'super_admin_created','doctor_approved','doctor_rejected'];
  ELSIF p_category = 'courses' THEN
    v_category_actions := ARRAY['course_created','course_updated','course_deleted',
      'course_published','course_unpublished','lesson_created','lesson_updated','lesson_deleted',
      'category_created','category_updated','category_deleted',
      'university_created','university_updated','university_deleted'];
  ELSIF p_category = 'videos' THEN
    v_category_actions := ARRAY['video_uploaded','video_replaced','video_deleted',
      'video_play','video_play_failed','pdf_uploaded','pdf_deleted'];
  ELSIF p_category = 'finance' THEN
    v_category_actions := ARRAY['credit_allocated','credit_consumed','credit_deducted',
      'credit_refunded','credit_expired','credit_consumed_by_doctor',
      'earnings_reset','platform_earnings_reset','subscription_created',
      'subscription_removed','subscription_restored','enrollment_created',
      'enrollment_created_by_admin','enrollment_removed_by_admin','code_created',
      'code_redeemed','code_deactivated','code_deleted','activation_code_created',
      'activation_code_used'];
  ELSIF p_category = 'login' THEN
    v_category_actions := ARRAY['login','logout','register','password_reset',
      'password_changed','phone_login','impersonation_started','impersonation_ended',
      'device_registered','device_reset','device_force_logout','device_logout_all',
      'device_revoked','device_removed','device_blocked','device_unblocked'];
  ELSIF p_category = 'notifications' THEN
    v_category_actions := ARRAY['notification_sent'];
  ELSIF p_category = 'security' THEN
    v_category_actions := ARRAY['security_event','security_policy_changed','root_detected',
      'jailbreak_detected','vpn_detected','proxy_detected','ssl_pinning_failure',
      'screenshot_detected','screen_recording_detected','debug_detected',
      'frida_detected','xposed_detected','app_integrity_compromised'];
  END IF;

  RETURN QUERY
  SELECT
    al.id,
    al.action::text,
    al.actor_id,
    COALESCE(al.actor_name, p.full_name)                        AS actor_name,
    COALESCE(al.actor_email, p.email)                           AS actor_email,
    COALESCE(al.actor_role, p.role::text)                       AS actor_role,
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
    COUNT(*) OVER ()                                             AS total_count
  FROM audit_logs al
  LEFT JOIN profiles p ON p.id = al.actor_id
  WHERE
    -- Category / action filter
    (v_category_actions IS NULL OR al.action::text = ANY(v_category_actions))
    AND (p_action_filter IS NULL OR al.action::text = ANY(p_action_filter))
    -- Status filter
    AND (p_log_status IS NULL OR al.log_status = p_log_status)
    -- Date range
    AND (p_date_from IS NULL OR al.created_at >= p_date_from)
    AND (p_date_to   IS NULL OR al.created_at <= p_date_to)
    -- Full-text / ilike search across key fields
    AND (
      p_search IS NULL
      OR al.description     ILIKE '%' || p_search || '%'
      OR al.target_name     ILIKE '%' || p_search || '%'
      OR al.actor_name      ILIKE '%' || p_search || '%'
      OR al.actor_email     ILIKE '%' || p_search || '%'
      OR COALESCE(p.full_name,'')  ILIKE '%' || p_search || '%'
      OR COALESCE(p.email,'')      ILIKE '%' || p_search || '%'
      OR al.action::text    ILIKE '%' || p_search || '%'
      OR al.resource_type   ILIKE '%' || p_search || '%'
    )
  ORDER BY al.created_at DESC
  LIMIT  p_limit
  OFFSET p_offset;
END;
$$;

-- Only super_admin can call this function
REVOKE ALL ON FUNCTION search_audit_logs FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_audit_logs TO authenticated;
