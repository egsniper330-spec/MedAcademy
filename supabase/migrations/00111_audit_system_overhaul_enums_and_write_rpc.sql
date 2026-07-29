
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Add missing audit_action enum values
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  new_values text[] := ARRAY[
    'course_archived', 'course_restored', 'course_price_changed',
    'instructor_changed', 'thumbnail_changed',
    'credits_added', 'credits_removed', 'enrollment_removed',
    'password_reset_by_admin', 'email_changed', 'name_changed',
    'avatar_changed', 'device_limit_changed', 'device_reset_by_admin',
    'platform_settings_changed', 'code_activated', 'code_disabled', 'code_expired',
    'custom_pricing_enabled', 'custom_pricing_disabled', 'earnings_settings_changed',
    'revenue_settings_changed', 'update_earnings_settings', 'credit_price_changed',
    'course_hidden', 'failed_login', 'session_revoked',
    'bulk_device_reset'
  ];
  v text;
BEGIN
  FOREACH v IN ARRAY new_values LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_enum
      WHERE enumlabel = v
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'audit_action')
    ) THEN
      EXECUTE format('ALTER TYPE audit_action ADD VALUE %L', v);
    END IF;
  END LOOP;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Add missing columns to audit_logs (target_user_id if missing)
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'target_user_id'
  ) THEN
    ALTER TABLE audit_logs ADD COLUMN target_user_id uuid REFERENCES profiles(id) ON DELETE SET NULL;
  END IF;
END$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Drop old write_audit_log overloads and create ONE canonical version
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop all old overloads
DROP FUNCTION IF EXISTS write_audit_log(uuid, uuid, audit_action, text, text, text, text, text);
DROP FUNCTION IF EXISTS write_audit_log(uuid, uuid, audit_action, jsonb, text, text, uuid, boolean, text);
DROP FUNCTION IF EXISTS write_audit_log(uuid, uuid, audit_action, jsonb, uuid, boolean, text);
DROP FUNCTION IF EXISTS write_audit_log(audit_action, text, text, uuid, text, text, jsonb, jsonb, uuid, text);
DROP FUNCTION IF EXISTS write_audit_log(audit_action, text, uuid, text, text, jsonb, jsonb, uuid, text);

-- Create the canonical write_audit_log
CREATE OR REPLACE FUNCTION write_audit_log(
  p_action        audit_action,
  p_description   text,
  p_resource_id   uuid        DEFAULT NULL,
  p_resource_type text        DEFAULT NULL,
  p_target_name   text        DEFAULT NULL,
  p_old_values    jsonb       DEFAULT NULL,
  p_new_values    jsonb       DEFAULT NULL,
  p_user_id       uuid        DEFAULT NULL,   -- target / subject of action
  p_log_status    text        DEFAULT 'success'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor profiles%ROWTYPE;
BEGIN
  SELECT * INTO v_actor FROM profiles WHERE profiles.id = auth.uid();

  INSERT INTO audit_logs(
    actor_id,   actor_name,  actor_email, actor_role,
    action,     resource_type, resource_id,
    target_name, description,
    old_values,  new_values,
    user_id,     log_status
  ) VALUES (
    auth.uid(),
    v_actor.full_name,
    v_actor.email,
    v_actor.role::text,
    p_action,
    p_resource_type,
    p_resource_id,
    p_target_name,
    p_description,
    p_old_values,
    p_new_values,
    p_user_id,
    p_log_status
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Fix set_device_limit — rich audit with names & description
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_device_limit(
  p_target_user_id uuid,
  p_max_devices    integer,
  p_actor_id       uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor   profiles%ROWTYPE;
  v_target  profiles%ROWTYPE;
  v_old     integer;
  v_action  audit_action;
  v_desc    text;
BEGIN
  SELECT * INTO v_actor  FROM profiles WHERE profiles.id = COALESCE(p_actor_id, auth.uid());
  SELECT * INTO v_target FROM profiles WHERE profiles.id = p_target_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Target user not found'; END IF;

  v_old := v_target.max_devices;
  UPDATE profiles SET max_devices = p_max_devices WHERE profiles.id = p_target_user_id;

  IF p_max_devices IS NULL THEN
    v_action := 'unlimited_devices_enabled'::audit_action;
    v_desc   := format('%s enabled unlimited devices for %s (%s)',
                  v_actor.full_name, v_target.full_name, v_target.email);
  ELSIF v_old IS NULL THEN
    v_action := 'unlimited_devices_disabled'::audit_action;
    v_desc   := format('%s disabled unlimited devices for %s (%s) — limit set to %s',
                  v_actor.full_name, v_target.full_name, v_target.email, p_max_devices);
  ELSE
    v_action := 'device_limit_changed'::audit_action;
    v_desc   := format('%s changed device limit for %s (%s) from %s to %s',
                  v_actor.full_name, v_target.full_name, v_target.email,
                  v_old, p_max_devices);
  END IF;

  INSERT INTO audit_logs(
    actor_id, actor_name, actor_email, actor_role,
    action, resource_type, resource_id,
    target_name, description,
    old_values, new_values,
    user_id, log_status
  ) VALUES (
    v_actor.id, v_actor.full_name, v_actor.email, v_actor.role::text,
    v_action, 'profile', p_target_user_id,
    v_target.full_name, v_desc,
    jsonb_build_object('max_devices', v_old),
    jsonb_build_object('max_devices', p_max_devices),
    p_target_user_id, 'success'
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Fix admin_reset_device — rich audit
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION admin_reset_device(
  p_target_user_id uuid,
  p_reason         text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor         profiles%ROWTYPE;
  v_target        profiles%ROWTYPE;
  v_deleted_count int;
BEGIN
  SELECT * INTO v_actor  FROM profiles WHERE profiles.id = auth.uid();
  SELECT * INTO v_target FROM profiles WHERE profiles.id = p_target_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;

  DELETE FROM devices WHERE user_id = p_target_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  UPDATE profiles
  SET security_version = COALESCE(security_version, 0) + 1
  WHERE profiles.id = p_target_user_id;

  INSERT INTO audit_logs(
    actor_id, actor_name, actor_email, actor_role,
    action, resource_type, resource_id,
    target_name, description,
    old_values, new_values,
    user_id, log_status
  ) VALUES (
    v_actor.id, v_actor.full_name, v_actor.email, v_actor.role::text,
    'device_reset_by_admin', 'profile', p_target_user_id,
    v_target.full_name,
    format('%s reset all devices for %s (%s). %s device(s) removed.%s',
      v_actor.full_name, v_target.full_name, v_target.email,
      v_deleted_count,
      CASE WHEN p_reason <> '' THEN ' Reason: ' || p_reason ELSE '' END),
    jsonb_build_object('devices_count', v_deleted_count),
    jsonb_build_object('devices_count', 0, 'security_version', 'bumped'),
    p_target_user_id, 'success'
  );

  RETURN jsonb_build_object(
    'success',         true,
    'deleted_devices', v_deleted_count,
    'message',         'All devices deleted and security version bumped.'
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Fix delete_device_record — rich audit
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION delete_device_record(
  p_device_id uuid,
  p_actor_id  uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor   profiles%ROWTYPE;
  v_target  profiles%ROWTYPE;
  v_device  devices%ROWTYPE;
BEGIN
  SELECT * INTO v_device FROM devices WHERE devices.id = p_device_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Device not found'; END IF;

  SELECT * INTO v_actor  FROM profiles WHERE profiles.id = COALESCE(p_actor_id, auth.uid());
  SELECT * INTO v_target FROM profiles WHERE profiles.id = v_device.user_id;

  DELETE FROM devices WHERE devices.id = p_device_id;

  INSERT INTO audit_logs(
    actor_id, actor_name, actor_email, actor_role,
    action, resource_type, resource_id,
    target_name, description,
    old_values, new_values,
    user_id, log_status
  ) VALUES (
    v_actor.id, v_actor.full_name, v_actor.email, v_actor.role::text,
    'device_removed', 'device', p_device_id,
    v_target.full_name,
    format('%s removed device "%s" (%s) from %s''s account (%s)',
      v_actor.full_name,
      COALESCE(v_device.device_name, 'Unknown Device'),
      COALESCE(v_device.platform, ''),
      v_target.full_name, v_target.email),
    jsonb_build_object(
      'device_name', v_device.device_name,
      'platform', v_device.platform,
      'device_model', v_device.device_model,
      'status', v_device.status::text
    ),
    '{}'::jsonb,
    v_device.user_id, 'success'
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Fix update_device_status — rich audit with names
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_device_status(
  p_device_id    uuid,
  p_status       text,
  p_block_reason text DEFAULT NULL,
  p_actor_id     uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor   profiles%ROWTYPE;
  v_target  profiles%ROWTYPE;
  v_device  devices%ROWTYPE;
  v_action  audit_action;
  v_desc    text;
BEGIN
  SELECT * INTO v_device FROM devices WHERE devices.id = p_device_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Device not found'; END IF;

  SELECT * INTO v_actor  FROM profiles WHERE profiles.id = COALESCE(p_actor_id, auth.uid());
  SELECT * INTO v_target FROM profiles WHERE profiles.id = v_device.user_id;

  UPDATE devices SET
    status       = p_status,
    block_reason = CASE WHEN p_status = 'blocked' THEN p_block_reason ELSE NULL END,
    blocked_at   = CASE WHEN p_status = 'blocked' THEN now() ELSE NULL END,
    blocked_by   = CASE WHEN p_status = 'blocked' THEN v_actor.id ELSE NULL END
  WHERE devices.id = p_device_id;

  v_action := CASE p_status
    WHEN 'blocked'    THEN 'device_blocked'::audit_action
    WHEN 'active'     THEN 'device_unblocked'::audit_action
    WHEN 'logged_out' THEN 'device_revoked'::audit_action
    ELSE 'device_removed'::audit_action
  END;

  v_desc := CASE p_status
    WHEN 'blocked'    THEN format('%s blocked device "%s" on %s''s account (%s).%s',
      v_actor.full_name, COALESCE(v_device.device_name,'Unknown'),
      v_target.full_name, v_target.email,
      CASE WHEN p_block_reason IS NOT NULL AND p_block_reason <> ''
           THEN ' Reason: ' || p_block_reason ELSE '' END)
    WHEN 'active'     THEN format('%s unblocked device "%s" on %s''s account (%s)',
      v_actor.full_name, COALESCE(v_device.device_name,'Unknown'),
      v_target.full_name, v_target.email)
    ELSE format('%s removed device "%s" from %s''s account (%s)',
      v_actor.full_name, COALESCE(v_device.device_name,'Unknown'),
      v_target.full_name, v_target.email)
  END;

  INSERT INTO audit_logs(
    actor_id, actor_name, actor_email, actor_role,
    action, resource_type, resource_id,
    target_name, description,
    old_values, new_values,
    user_id, log_status
  ) VALUES (
    v_actor.id, v_actor.full_name, v_actor.email, v_actor.role::text,
    v_action, 'device', p_device_id,
    v_target.full_name, v_desc,
    jsonb_build_object('status', v_device.status::text),
    jsonb_build_object('status', p_status,
      'block_reason', p_block_reason),
    v_device.user_id, 'success'
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Reset password by admin — new audited RPC
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION reset_user_password_by_admin(
  p_target_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor   profiles%ROWTYPE;
  v_target  profiles%ROWTYPE;
BEGIN
  SELECT * INTO v_actor  FROM profiles WHERE profiles.id = auth.uid();
  SELECT * INTO v_target FROM profiles WHERE profiles.id = p_target_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Target user not found'; END IF;

  IF v_actor.role NOT IN ('admin', 'super_admin') THEN
    RAISE EXCEPTION 'Forbidden: admin or super_admin role required';
  END IF;

  INSERT INTO audit_logs(
    actor_id, actor_name, actor_email, actor_role,
    action, resource_type, resource_id,
    target_name, description,
    old_values, new_values,
    user_id, log_status
  ) VALUES (
    v_actor.id, v_actor.full_name, v_actor.email, v_actor.role::text,
    'password_reset_by_admin', 'profile', p_target_id,
    v_target.full_name,
    format('%s triggered a password reset for %s (%s)',
      v_actor.full_name, v_target.full_name, v_target.email),
    jsonb_build_object('email', v_target.email),
    jsonb_build_object('reset_email_sent', true),
    p_target_id, 'success'
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Course RPCs: publish, unpublish, archive+audit, restore+audit, create_audited, update_audited
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION publish_course(p_course_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor   profiles%ROWTYPE;
  v_course  courses%ROWTYPE;
BEGIN
  SELECT * INTO v_actor  FROM profiles WHERE profiles.id = auth.uid();
  SELECT * INTO v_course FROM courses WHERE courses.id = p_course_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Course not found'; END IF;

  IF v_actor.role NOT IN ('doctor','admin','super_admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF v_actor.role = 'doctor' AND v_course.doctor_id != auth.uid() THEN
    RAISE EXCEPTION 'Forbidden: not your course';
  END IF;

  UPDATE courses SET status = 'published', updated_at = now()
  WHERE courses.id = p_course_id;

  INSERT INTO audit_logs(
    actor_id, actor_name, actor_email, actor_role,
    action, resource_type, resource_id,
    target_name, description,
    old_values, new_values, user_id, log_status
  ) VALUES (
    v_actor.id, v_actor.full_name, v_actor.email, v_actor.role::text,
    'course_published', 'course', p_course_id,
    v_course.title,
    format('%s published course "%s"', v_actor.full_name, v_course.title),
    jsonb_build_object('status', v_course.status::text),
    jsonb_build_object('status', 'published'),
    v_actor.id, 'success'
  );
END;
$$;

CREATE OR REPLACE FUNCTION unpublish_course(p_course_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor   profiles%ROWTYPE;
  v_course  courses%ROWTYPE;
BEGIN
  SELECT * INTO v_actor  FROM profiles WHERE profiles.id = auth.uid();
  SELECT * INTO v_course FROM courses WHERE courses.id = p_course_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Course not found'; END IF;

  IF v_actor.role NOT IN ('doctor','admin','super_admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF v_actor.role = 'doctor' AND v_course.doctor_id != auth.uid() THEN
    RAISE EXCEPTION 'Forbidden: not your course';
  END IF;

  UPDATE courses SET status = 'draft', updated_at = now()
  WHERE courses.id = p_course_id;

  INSERT INTO audit_logs(
    actor_id, actor_name, actor_email, actor_role,
    action, resource_type, resource_id,
    target_name, description,
    old_values, new_values, user_id, log_status
  ) VALUES (
    v_actor.id, v_actor.full_name, v_actor.email, v_actor.role::text,
    'course_hidden', 'course', p_course_id,
    v_course.title,
    format('%s hid/unpublished course "%s"', v_actor.full_name, v_course.title),
    jsonb_build_object('status', v_course.status::text),
    jsonb_build_object('status', 'draft'),
    v_actor.id, 'success'
  );
END;
$$;

-- Fix archive_course to ALSO write to audit_logs (it currently only writes to course_lifecycle_logs)
CREATE OR REPLACE FUNCTION archive_course(
  p_course_id  uuid,
  p_actor_id   uuid,
  p_actor_role text,
  p_reason     text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor       profiles%ROWTYPE;
  v_course      courses%ROWTYPE;
  v_students    integer;
  v_lessons     integer;
  v_videos      integer;
  v_attachments integer;
BEGIN
  SELECT * INTO v_actor  FROM profiles WHERE profiles.id = p_actor_id;
  SELECT * INTO v_course FROM courses WHERE courses.id = p_course_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Course not found'; END IF;
  IF v_course.archived_at IS NOT NULL THEN RAISE EXCEPTION 'Course is already archived'; END IF;

  SELECT COUNT(*) INTO v_students    FROM enrollments      WHERE course_id = p_course_id AND status = 'active';
  SELECT COUNT(*) INTO v_lessons     FROM lessons          WHERE course_id = p_course_id;
  SELECT COUNT(*) INTO v_videos      FROM lessons          WHERE course_id = p_course_id AND video_id IS NOT NULL;
  SELECT COUNT(*) INTO v_attachments FROM lesson_materials WHERE course_id = p_course_id;

  UPDATE courses
  SET archived_at    = now(),
      archived_by    = p_actor_id,
      archive_reason = p_reason,
      status         = 'archived',
      updated_at     = now()
  WHERE courses.id = p_course_id;

  INSERT INTO course_lifecycle_logs
    (course_id, course_title, doctor_id, action, actor_id, actor_role, reason,
     students_count, lessons_count, videos_count, attachments_count)
  VALUES
    (p_course_id, v_course.title, v_course.doctor_id, 'archived',
     p_actor_id, p_actor_role, p_reason,
     v_students, v_lessons, v_videos, v_attachments);

  INSERT INTO audit_logs(
    actor_id, actor_name, actor_email, actor_role,
    action, resource_type, resource_id,
    target_name, description,
    old_values, new_values, user_id, log_status
  ) VALUES (
    v_actor.id, v_actor.full_name, v_actor.email, v_actor.role::text,
    'course_archived', 'course', p_course_id,
    v_course.title,
    format('%s archived course "%s".%s',
      v_actor.full_name, v_course.title,
      CASE WHEN p_reason IS NOT NULL AND p_reason <> ''
           THEN ' Reason: ' || p_reason ELSE '' END),
    jsonb_build_object('status', v_course.status::text,
      'students', v_students, 'lessons', v_lessons),
    jsonb_build_object('status', 'archived'),
    v_actor.id, 'success'
  );
END;
$$;

CREATE OR REPLACE FUNCTION restore_course(
  p_course_id  uuid,
  p_actor_id   uuid,
  p_actor_role text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor  profiles%ROWTYPE;
  v_course courses%ROWTYPE;
BEGIN
  SELECT * INTO v_actor  FROM profiles WHERE profiles.id = p_actor_id;
  SELECT * INTO v_course FROM courses WHERE courses.id = p_course_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Course not found'; END IF;
  IF v_course.archived_at IS NULL THEN RAISE EXCEPTION 'Course is not archived'; END IF;

  UPDATE courses
  SET archived_at = NULL, archived_by = NULL, archive_reason = NULL,
      restored_at = now(), restored_by = p_actor_id,
      status = 'published', updated_at = now()
  WHERE courses.id = p_course_id;

  INSERT INTO course_lifecycle_logs
    (course_id, course_title, doctor_id, action, actor_id, actor_role)
  VALUES
    (p_course_id, v_course.title, v_course.doctor_id, 'restored', p_actor_id, p_actor_role);

  INSERT INTO audit_logs(
    actor_id, actor_name, actor_email, actor_role,
    action, resource_type, resource_id,
    target_name, description,
    old_values, new_values, user_id, log_status
  ) VALUES (
    v_actor.id, v_actor.full_name, v_actor.email, v_actor.role::text,
    'course_restored', 'course', p_course_id,
    v_course.title,
    format('%s restored course "%s" from archive', v_actor.full_name, v_course.title),
    jsonb_build_object('status', 'archived'),
    jsonb_build_object('status', 'published'),
    v_actor.id, 'success'
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. create_course_audited / update_course_audited
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION create_course_audited(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor  profiles%ROWTYPE;
  v_course courses%ROWTYPE;
  v_id     uuid;
BEGIN
  SELECT * INTO v_actor FROM profiles WHERE profiles.id = auth.uid();
  IF v_actor.role NOT IN ('doctor','admin','super_admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  INSERT INTO courses (
    title, description, doctor_id, category_id, status,
    price_egp, image_url, thumbnail_url, cover_url,
    contact_email, contact_phone, contact_whatsapp, contact_telegram,
    university_id, faculty_id, academic_level_id
  )
  SELECT
    p_payload->>'title',
    p_payload->>'description',
    COALESCE((p_payload->>'doctor_id')::uuid, auth.uid()),
    (p_payload->>'category_id')::uuid,
    COALESCE(p_payload->>'status', 'draft'),
    (p_payload->>'price_egp')::numeric,
    p_payload->>'image_url',
    p_payload->>'thumbnail_url',
    p_payload->>'cover_url',
    p_payload->>'contact_email',
    p_payload->>'contact_phone',
    p_payload->>'contact_whatsapp',
    p_payload->>'contact_telegram',
    (p_payload->>'university_id')::uuid,
    (p_payload->>'faculty_id')::uuid,
    (p_payload->>'academic_level_id')::uuid
  RETURNING id INTO v_id;

  SELECT * INTO v_course FROM courses WHERE courses.id = v_id;

  INSERT INTO audit_logs(
    actor_id, actor_name, actor_email, actor_role,
    action, resource_type, resource_id,
    target_name, description,
    old_values, new_values, user_id, log_status
  ) VALUES (
    v_actor.id, v_actor.full_name, v_actor.email, v_actor.role::text,
    'course_created', 'course', v_id,
    v_course.title,
    format('%s created course "%s"', v_actor.full_name, v_course.title),
    '{}'::jsonb,
    jsonb_build_object(
      'title', v_course.title,
      'status', v_course.status::text,
      'price_egp', v_course.price_egp
    ),
    v_actor.id, 'success'
  );

  RETURN jsonb_build_object('id', v_id, 'title', v_course.title);
END;
$$;

CREATE OR REPLACE FUNCTION update_course_audited(
  p_course_id uuid,
  p_updates   jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor      profiles%ROWTYPE;
  v_old_course courses%ROWTYPE;
  v_changed    jsonb := '{}'::jsonb;
  v_old_vals   jsonb := '{}'::jsonb;
BEGIN
  SELECT * INTO v_actor     FROM profiles WHERE profiles.id = auth.uid();
  SELECT * INTO v_old_course FROM courses WHERE courses.id = p_course_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Course not found'; END IF;

  IF v_actor.role NOT IN ('doctor','admin','super_admin') THEN RAISE EXCEPTION 'Forbidden'; END IF;
  IF v_actor.role = 'doctor' AND v_old_course.doctor_id != auth.uid() THEN
    RAISE EXCEPTION 'Forbidden: not your course';
  END IF;

  -- Track changed fields
  IF (p_updates->>'title') IS NOT NULL AND (p_updates->>'title') != v_old_course.title THEN
    v_old_vals := v_old_vals || jsonb_build_object('title', v_old_course.title);
    v_changed  := v_changed  || jsonb_build_object('title', p_updates->>'title');
  END IF;
  IF (p_updates->>'description') IS NOT NULL AND (p_updates->>'description') != v_old_course.description THEN
    v_old_vals := v_old_vals || jsonb_build_object('description', left(v_old_course.description,100));
    v_changed  := v_changed  || jsonb_build_object('description', left(p_updates->>'description',100));
  END IF;
  IF (p_updates->>'price_egp') IS NOT NULL THEN
    v_old_vals := v_old_vals || jsonb_build_object('price_egp', v_old_course.price_egp);
    v_changed  := v_changed  || jsonb_build_object('price_egp', (p_updates->>'price_egp')::numeric);
  END IF;

  -- Apply update
  UPDATE courses
  SET
    title          = COALESCE(p_updates->>'title',          title),
    description    = COALESCE(p_updates->>'description',    description),
    price_egp      = COALESCE((p_updates->>'price_egp')::numeric, price_egp),
    image_url      = COALESCE(p_updates->>'image_url',      image_url),
    thumbnail_url  = COALESCE(p_updates->>'thumbnail_url',  thumbnail_url),
    cover_url      = COALESCE(p_updates->>'cover_url',      cover_url),
    contact_email  = COALESCE(p_updates->>'contact_email',  contact_email),
    contact_phone  = COALESCE(p_updates->>'contact_phone',  contact_phone),
    updated_at     = now()
  WHERE courses.id = p_course_id;

  INSERT INTO audit_logs(
    actor_id, actor_name, actor_email, actor_role,
    action, resource_type, resource_id,
    target_name, description,
    old_values, new_values, user_id, log_status
  ) VALUES (
    v_actor.id, v_actor.full_name, v_actor.email, v_actor.role::text,
    'course_updated', 'course', p_course_id,
    v_old_course.title,
    format('%s updated course "%s"', v_actor.full_name, v_old_course.title),
    v_old_vals,
    v_changed,
    v_actor.id, 'success'
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. Update search_audit_logs to support new categories
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION search_audit_logs(
  p_search        text    DEFAULT NULL,
  p_action_filter text[]  DEFAULT NULL,
  p_category      text    DEFAULT NULL,
  p_log_status    text    DEFAULT NULL,
  p_date_from     text    DEFAULT NULL,
  p_date_to       text    DEFAULT NULL,
  p_limit         integer DEFAULT 100,
  p_offset        integer DEFAULT 0
)
RETURNS TABLE(
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
  resource_id   uuid,
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
  CASE p_category
    WHEN 'users' THEN
      v_category_actions := ARRAY[
        'user_created','user_deleted','user_suspended','user_activated',
        'user_trashed','user_restored','user_hard_deleted','profile_updated',
        'bulk_trash','bulk_restore','bulk_suspend','bulk_unsuspend','bulk_permanent_delete',
        'account_restored','account_permanently_deleted','admin_created','admin_updated',
        'admin_deleted','super_admin_created','doctor_approved','doctor_rejected',
        'avatar_changed','name_changed','email_changed','password_reset_by_admin',
        'temp_password_generated'
      ];
    WHEN 'roles' THEN
      v_category_actions := ARRAY['role_changed','permission_changed'];
    WHEN 'doctor' THEN
      v_category_actions := ARRAY[
        'doctor_approved','doctor_rejected','credits_added','credits_removed',
        'credit_allocated','credit_deducted','credit_refunded','credit_expired',
        'custom_pricing_enabled','custom_pricing_disabled','earnings_settings_changed',
        'revenue_settings_changed','update_earnings_settings','credit_price_changed',
        'course_price_changed'
      ];
    WHEN 'student' THEN
      v_category_actions := ARRAY[
        'user_created','enrollment_created','enrollment_created_by_admin',
        'enrollment_removed_by_admin','enrollment_removed',
        'credit_consumed','credit_consumed_by_doctor',
        'subscription_created','subscription_removed','subscription_restored',
        'code_redeemed','activation_code_used'
      ];
    WHEN 'courses' THEN
      v_category_actions := ARRAY[
        'course_created','course_updated','course_deleted','course_published',
        'course_unpublished','course_hidden','course_archived','course_restored',
        'course_price_changed','instructor_changed','thumbnail_changed',
        'lesson_created','lesson_updated','lesson_deleted',
        'video_replaced','video_deleted','video_uploaded',
        'category_created','category_updated','category_deleted',
        'university_created','university_updated','university_deleted'
      ];
    WHEN 'codes' THEN
      v_category_actions := ARRAY[
        'code_created','code_redeemed','code_deactivated','code_deleted',
        'code_activated','code_disabled','code_expired',
        'activation_code_created','activation_code_used'
      ];
    WHEN 'auth' THEN
      v_category_actions := ARRAY[
        'login','logout','register','password_reset','password_reset_by_admin',
        'password_changed','password_changed_first_login','phone_login',
        'failed_login','session_revoked',
        'impersonation_started','impersonation_ended',
        'device_registered','device_reset','device_force_logout','device_logout_all',
        'device_revoked','device_removed','device_blocked','device_unblocked',
        'device_limit_changed','device_reset_by_admin',
        'unlimited_devices_enabled','unlimited_devices_disabled'
      ];
    WHEN 'platform' THEN
      v_category_actions := ARRAY[
        'settings_changed','platform_settings_changed','security_policy_changed',
        'earnings_reset','platform_earnings_reset','notification_sent',
        'system_health_check','revenue_settings_changed'
      ];
    WHEN 'finance' THEN
      v_category_actions := ARRAY[
        'credit_allocated','credit_consumed','credit_deducted','credits_added','credits_removed',
        'credit_refunded','credit_expired','credit_consumed_by_doctor',
        'credit_price_changed','course_price_changed',
        'earnings_reset','platform_earnings_reset','subscription_created',
        'subscription_removed','subscription_restored','enrollment_created',
        'enrollment_created_by_admin','enrollment_removed_by_admin','enrollment_removed',
        'code_created','code_redeemed','code_deactivated','code_deleted',
        'activation_code_created','activation_code_used'
      ];
    WHEN 'security' THEN
      v_category_actions := ARRAY[
        'security_event','security_policy_changed','root_detected','jailbreak_detected',
        'vpn_detected','proxy_detected','ssl_pinning_failure','screenshot_detected',
        'screen_recording_detected','debug_detected','frida_detected','xposed_detected',
        'app_integrity_compromised','failed_login','impersonation_started','impersonation_ended'
      ];
    ELSE
      v_category_actions := NULL;
  END CASE;

  RETURN QUERY
  SELECT
    al.id,
    al.action::text,
    al.actor_id,
    COALESCE(al.actor_name,  p.full_name)    AS actor_name,
    COALESCE(al.actor_email, p.email)         AS actor_email,
    COALESCE(al.actor_role,  p.role::text)    AS actor_role,
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
    COUNT(*) OVER ()                          AS total_count
  FROM audit_logs al
  LEFT JOIN profiles p ON p.id = al.actor_id
  WHERE
    (v_category_actions IS NULL OR al.action::text = ANY(v_category_actions))
    AND (p_action_filter IS NULL OR al.action::text = ANY(p_action_filter))
    AND (p_log_status IS NULL OR al.log_status = p_log_status)
    AND (p_date_from IS NULL OR al.created_at >= p_date_from::timestamptz)
    AND (p_date_to   IS NULL OR al.created_at <= p_date_to::timestamptz)
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
