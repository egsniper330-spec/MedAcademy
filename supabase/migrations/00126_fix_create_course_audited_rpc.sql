
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: fix_create_course_audited_rpc
--
-- Root cause of "Failed to create course":
-- The RPC was inserting into columns that do not exist on the courses table:
--   price, duration_hours, level, what_you_learn, requirements, who_is_this_for,
--   contact_phone, contact_whatsapp, contact_email, contact_telegram, is_featured
--
-- The actual courses table uses:
--   price_egp, phone, whatsapp, telegram, facebook,
--   short_description, full_description, thumbnail_url, cover_url,
--   difficulty, tags, instructor_name, sequential_learning,
--   free_preview, certificate_enabled, subscription_required,
--   academic_level_id, image_url
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_course_audited(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
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
  SELECT full_name, email, role
    INTO v_actor_name, v_actor_email, v_actor_role
    FROM public.profiles WHERE id = v_actor_id;

  v_title     := p_payload->>'title';
  v_doctor_id := (p_payload->>'doctor_id')::uuid;

  IF v_doctor_id IS NOT NULL THEN
    SELECT full_name INTO v_doctor_name
      FROM public.profiles WHERE id = v_doctor_id;
  END IF;

  -- ── INSERT using the real courses table columns ──────────────────────────
  INSERT INTO public.courses (
    title,
    description,
    short_description,
    full_description,
    thumbnail_url,
    cover_url,
    image_url,
    status,
    doctor_id,
    university_id,
    faculty_id,
    academic_level_id,
    language,
    difficulty,
    tags,
    instructor_name,
    phone,
    whatsapp,
    telegram,
    facebook,
    price_egp,
    sequential_learning,
    free_preview,
    certificate_enabled,
    subscription_required,
    updated_at
  )
  VALUES (
    p_payload->>'title',
    coalesce(p_payload->>'description', ''),
    p_payload->>'short_description',
    p_payload->>'full_description',
    p_payload->>'thumbnail_url',
    p_payload->>'cover_url',
    p_payload->>'image_url',
    coalesce(p_payload->>'status', 'draft'),
    (p_payload->>'doctor_id')::uuid,
    (p_payload->>'university_id')::uuid,
    (p_payload->>'faculty_id')::uuid,
    (p_payload->>'academic_level_id')::uuid,
    coalesce(p_payload->>'language', 'Arabic'),
    coalesce(p_payload->>'difficulty', 'all_levels')::difficulty_level,
    coalesce(
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'tags')),
      '{}'::text[]
    ),
    p_payload->>'instructor_name',
    p_payload->>'phone',
    p_payload->>'whatsapp',
    p_payload->>'telegram',
    p_payload->>'facebook',
    coalesce((p_payload->>'price_egp')::numeric, 0),
    coalesce((p_payload->>'sequential_learning')::boolean, false),
    coalesce((p_payload->>'free_preview')::boolean, false),
    coalesce((p_payload->>'certificate_enabled')::boolean, false),
    coalesce((p_payload->>'subscription_required')::boolean, true),
    now()
  )
  RETURNING id INTO v_course_id;

  -- ── Audit log ────────────────────────────────────────────────────────────
  PERFORM public.write_audit_log(
    p_action        := 'course_created',
    p_description   := format('%s created course "%s"%s',
                              coalesce(v_actor_name, 'Unknown'),
                              coalesce(v_title, 'Untitled'),
                              CASE WHEN v_doctor_name IS NOT NULL
                                   THEN ' for instructor ' || v_doctor_name
                                   ELSE '' END),
    p_resource_id   := v_course_id::text,
    p_resource_type := 'course',
    p_target_name   := coalesce(v_title, 'Untitled'),
    p_old_values    := null,
    p_new_values    := jsonb_build_object(
                         'title',     v_title,
                         'status',    coalesce(p_payload->>'status', 'draft'),
                         'price_egp', p_payload->>'price_egp',
                         'doctor_id', v_doctor_id
                       ),
    p_user_id       := v_actor_id,
    p_log_status    := 'success'
  );

  RETURN jsonb_build_object('id', v_course_id, 'title', v_title);
END;
$$;
