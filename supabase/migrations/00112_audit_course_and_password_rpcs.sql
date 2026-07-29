
-- ============================================================
-- Migration: audit_course_and_password_rpcs
-- Creates SECURITY DEFINER RPCs for:
--   1. reset_user_password_by_admin
--   2. create_course_audited
--   3. update_course_audited
--   4. publish_course
--   5. unpublish_course
--
-- All RPCs write rich audit log entries via write_audit_log.
-- ============================================================

-- ────────────────────────────────────────────────────────────────
-- 1. reset_user_password_by_admin
--    Called non-blocking from api.ts after auth.resetPasswordForEmail
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reset_user_password_by_admin(
  p_target_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id    uuid;
  v_actor_name  text;
  v_actor_email text;
  v_actor_role  text;
  v_target_name text;
  v_target_email text;
BEGIN
  -- Actor = caller
  v_actor_id := auth.uid();
  SELECT full_name, email, role INTO v_actor_name, v_actor_email, v_actor_role
    FROM public.profiles WHERE id = v_actor_id;

  -- Target
  SELECT full_name, email INTO v_target_name, v_target_email
    FROM public.profiles WHERE id = p_target_id;

  PERFORM public.write_audit_log(
    p_action        := 'password_reset_by_admin',
    p_description   := format('%s (%s) reset the password for %s (%s)',
                              coalesce(v_actor_name, 'Unknown'),
                              coalesce(v_actor_role, 'admin'),
                              coalesce(v_target_name, 'Unknown'),
                              coalesce(v_target_email, '')),
    p_resource_id   := p_target_id::text,
    p_resource_type := 'user',
    p_target_name   := coalesce(v_target_name, v_target_email),
    p_old_values    := null,
    p_new_values    := jsonb_build_object('password_reset', true, 'reset_email_sent_to', v_target_email),
    p_user_id       := v_actor_id,
    p_log_status    := 'success'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_user_password_by_admin(uuid) TO authenticated;


-- ────────────────────────────────────────────────────────────────
-- 2. create_course_audited
--    Inserts a new course and writes audit log.
--    p_payload JSONB must contain all required course fields.
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_course_audited(
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id    uuid;
  v_actor_name  text;
  v_actor_email text;
  v_actor_role  text;
  v_course_id   uuid;
  v_title       text;
  v_doctor_id   uuid;
  v_doctor_name text;
BEGIN
  v_actor_id := auth.uid();
  SELECT full_name, email, role INTO v_actor_name, v_actor_email, v_actor_role
    FROM public.profiles WHERE id = v_actor_id;

  v_title     := p_payload->>'title';
  v_doctor_id := (p_payload->>'doctor_id')::uuid;

  IF v_doctor_id IS NOT NULL THEN
    SELECT full_name INTO v_doctor_name FROM public.profiles WHERE id = v_doctor_id;
  END IF;

  -- Insert the course (pass through all payload keys)
  INSERT INTO public.courses (
    title, description, price, status, doctor_id, category_id,
    university_id, faculty_id, duration_hours, level, language,
    what_you_learn, requirements, who_is_this_for,
    contact_phone, contact_whatsapp, contact_email, contact_telegram,
    is_featured, updated_at
  )
  SELECT
    p_payload->>'title',
    p_payload->>'description',
    (p_payload->>'price')::numeric,
    coalesce(p_payload->>'status', 'draft'),
    (p_payload->>'doctor_id')::uuid,
    (p_payload->>'category_id')::uuid,
    (p_payload->>'university_id')::uuid,
    (p_payload->>'faculty_id')::uuid,
    (p_payload->>'duration_hours')::numeric,
    p_payload->>'level',
    p_payload->>'language',
    p_payload->'what_you_learn',
    p_payload->'requirements',
    p_payload->'who_is_this_for',
    p_payload->>'contact_phone',
    p_payload->>'contact_whatsapp',
    p_payload->>'contact_email',
    p_payload->>'contact_telegram',
    coalesce((p_payload->>'is_featured')::boolean, false),
    now()
  RETURNING id INTO v_course_id;

  PERFORM public.write_audit_log(
    p_action        := 'course_created',
    p_description   := format('%s created course "%s"%s',
                              coalesce(v_actor_name, 'Unknown'),
                              coalesce(v_title, 'Untitled'),
                              case when v_doctor_name is not null then ' for instructor ' || v_doctor_name else '' end),
    p_resource_id   := v_course_id::text,
    p_resource_type := 'course',
    p_target_name   := coalesce(v_title, 'Untitled'),
    p_old_values    := null,
    p_new_values    := jsonb_build_object(
                         'title',     v_title,
                         'status',    coalesce(p_payload->>'status', 'draft'),
                         'price',     p_payload->>'price',
                         'doctor_id', v_doctor_id
                       ),
    p_user_id       := v_actor_id,
    p_log_status    := 'success'
  );

  RETURN jsonb_build_object('id', v_course_id, 'title', v_title);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_course_audited(jsonb) TO authenticated;


-- ────────────────────────────────────────────────────────────────
-- 3. update_course_audited
--    Applies partial updates to a course and writes audit log
--    with old vs new values for every changed field.
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_course_audited(
  p_course_id uuid,
  p_updates   jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id    uuid;
  v_actor_name  text;
  v_actor_email text;
  v_actor_role  text;
  v_old         jsonb;
  v_new_vals    jsonb := '{}';
  v_old_vals    jsonb := '{}';
  v_title       text;
  v_key         text;
  v_old_val     text;
  v_new_val     text;
BEGIN
  v_actor_id := auth.uid();
  SELECT full_name, email, role INTO v_actor_name, v_actor_email, v_actor_role
    FROM public.profiles WHERE id = v_actor_id;

  -- Snapshot current values
  SELECT to_jsonb(c) INTO v_old FROM public.courses c WHERE id = p_course_id;
  v_title := v_old->>'title';

  -- Build old/new diff for changed keys
  FOR v_key IN SELECT jsonb_object_keys(p_updates) LOOP
    v_old_val := v_old->>v_key;
    v_new_val := p_updates->>v_key;
    IF v_old_val IS DISTINCT FROM v_new_val THEN
      v_old_vals := v_old_vals || jsonb_build_object(v_key, v_old_val);
      v_new_vals := v_new_vals || jsonb_build_object(v_key, v_new_val);
    END IF;
  END LOOP;

  -- Apply the update
  UPDATE public.courses
  SET
    title           = coalesce(p_updates->>'title',           title),
    description     = coalesce(p_updates->>'description',     description),
    price           = coalesce((p_updates->>'price')::numeric, price),
    status          = coalesce(p_updates->>'status',          status),
    doctor_id       = coalesce((p_updates->>'doctor_id')::uuid, doctor_id),
    category_id     = coalesce((p_updates->>'category_id')::uuid, category_id),
    university_id   = coalesce((p_updates->>'university_id')::uuid, university_id),
    faculty_id      = coalesce((p_updates->>'faculty_id')::uuid, faculty_id),
    duration_hours  = coalesce((p_updates->>'duration_hours')::numeric, duration_hours),
    level           = coalesce(p_updates->>'level',           level),
    language        = coalesce(p_updates->>'language',        language),
    what_you_learn  = coalesce(p_updates->'what_you_learn',   what_you_learn),
    requirements    = coalesce(p_updates->'requirements',     requirements),
    who_is_this_for = coalesce(p_updates->'who_is_this_for',  who_is_this_for),
    contact_phone   = coalesce(p_updates->>'contact_phone',   contact_phone),
    contact_whatsapp= coalesce(p_updates->>'contact_whatsapp',contact_whatsapp),
    contact_email   = coalesce(p_updates->>'contact_email',   contact_email),
    contact_telegram= coalesce(p_updates->>'contact_telegram',contact_telegram),
    is_featured     = coalesce((p_updates->>'is_featured')::boolean, is_featured),
    image_url       = coalesce(p_updates->>'image_url',       image_url),
    updated_at      = now()
  WHERE id = p_course_id;

  -- Only log if something actually changed
  IF v_old_vals <> '{}' THEN
    PERFORM public.write_audit_log(
      p_action        := 'course_updated',
      p_description   := format('%s updated course "%s"',
                                coalesce(v_actor_name, 'Unknown'),
                                coalesce(v_title, 'Untitled')),
      p_resource_id   := p_course_id::text,
      p_resource_type := 'course',
      p_target_name   := coalesce(v_title, 'Untitled'),
      p_old_values    := v_old_vals,
      p_new_values    := v_new_vals,
      p_user_id       := v_actor_id,
      p_log_status    := 'success'
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_course_audited(uuid, jsonb) TO authenticated;


-- ────────────────────────────────────────────────────────────────
-- 4. publish_course
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.publish_course(
  p_course_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id    uuid;
  v_actor_name  text;
  v_actor_role  text;
  v_old_status  text;
  v_title       text;
BEGIN
  v_actor_id := auth.uid();
  SELECT full_name, role INTO v_actor_name, v_actor_role
    FROM public.profiles WHERE id = v_actor_id;

  SELECT title, status INTO v_title, v_old_status
    FROM public.courses WHERE id = p_course_id;

  UPDATE public.courses
    SET status = 'published', updated_at = now()
  WHERE id = p_course_id;

  PERFORM public.write_audit_log(
    p_action        := 'course_published',
    p_description   := format('%s published course "%s"',
                              coalesce(v_actor_name, 'Unknown'),
                              coalesce(v_title, 'Untitled')),
    p_resource_id   := p_course_id::text,
    p_resource_type := 'course',
    p_target_name   := coalesce(v_title, 'Untitled'),
    p_old_values    := jsonb_build_object('status', v_old_status),
    p_new_values    := jsonb_build_object('status', 'published'),
    p_user_id       := v_actor_id,
    p_log_status    := 'success'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.publish_course(uuid) TO authenticated;


-- ────────────────────────────────────────────────────────────────
-- 5. unpublish_course
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.unpublish_course(
  p_course_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id    uuid;
  v_actor_name  text;
  v_actor_role  text;
  v_old_status  text;
  v_title       text;
BEGIN
  v_actor_id := auth.uid();
  SELECT full_name, role INTO v_actor_name, v_actor_role
    FROM public.profiles WHERE id = v_actor_id;

  SELECT title, status INTO v_title, v_old_status
    FROM public.courses WHERE id = p_course_id;

  UPDATE public.courses
    SET status = 'draft', updated_at = now()
  WHERE id = p_course_id;

  PERFORM public.write_audit_log(
    p_action        := 'course_unpublished',
    p_description   := format('%s unpublished (hid) course "%s"',
                              coalesce(v_actor_name, 'Unknown'),
                              coalesce(v_title, 'Untitled')),
    p_resource_id   := p_course_id::text,
    p_resource_type := 'course',
    p_target_name   := coalesce(v_title, 'Untitled'),
    p_old_values    := jsonb_build_object('status', v_old_status),
    p_new_values    := jsonb_build_object('status', 'draft'),
    p_user_id       := v_actor_id,
    p_log_status    := 'success'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.unpublish_course(uuid) TO authenticated;
