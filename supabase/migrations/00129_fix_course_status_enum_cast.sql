
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: fix_course_status_enum_cast
--
-- Root cause
-- ──────────
-- create_course_audited does:
--   coalesce(p_payload->>'status', 'draft')
-- The ->> operator extracts JSONB values as plain `text`.  PostgreSQL will NOT
-- implicitly cast text → course_status in an INSERT column list, raising:
--   "column 'status' is of type course_status but expression is of type text"
--
-- Fixes applied
-- ─────────────
-- 1. create_course_audited  — add ::course_status to the status INSERT value.
-- 2. duplicate_course       — add ::course_status to the 'draft' literal in the
--                             INSERT...SELECT statement.
--
-- Not changed (already correct or not affected)
-- ─────────────────────────────────────────────
-- • update_course_audited   — already has ::course_status cast ✅
-- • publish_course          — PL/pgSQL assignment auto-casts enum literal ✅
-- • unpublish_course        — same ✅
-- • archive_course          — same ✅
-- • restore_course          — same ✅
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. create_course_audited ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_course_audited(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  --  FIX: cast status from text → course_status explicitly.
  --  The ->> operator produces plain text; PostgreSQL will NOT auto-cast it
  --  to an enum type inside an INSERT column list.
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
    coalesce(p_payload->>'status', 'draft')::course_status,   -- ← FIX
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
$function$;

-- ── 2. duplicate_course ──────────────────────────────────────────────────────
--  FIX: In INSERT...SELECT the 'draft' string literal is typed as text by the
--  query planner; add ::course_status so it matches the enum column.
CREATE OR REPLACE FUNCTION public.duplicate_course(
  p_source_id    uuid,
  p_target_doctor uuid,
  p_new_title    text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_new_course_id   uuid;
  v_new_section_id  uuid;
  v_new_lesson_id   uuid;
  sec               RECORD;
  les               RECORD;
  mat               RECORD;
BEGIN
  -- Copy course row (exclude student/analytics data)
  INSERT INTO courses (
    title, description, short_description, full_description,
    thumbnail_url, cover_url, category_id, university_id, faculty_id, academic_level_id,
    language, difficulty, tags, estimated_duration_hours, instructor_name,
    sequential_learning, free_preview, certificate_enabled,
    subscription_required, credits_required, activation_code_required,
    doctor_id, status,
    whatsapp, telegram, facebook, phone
  )
  SELECT
    COALESCE(p_new_title, title || ' (Copy)'),
    description, short_description, full_description,
    thumbnail_url, cover_url, category_id, university_id, faculty_id, academic_level_id,
    language, difficulty, tags, estimated_duration_hours, instructor_name,
    sequential_learning, free_preview, certificate_enabled,
    subscription_required, credits_required, activation_code_required,
    p_target_doctor, 'draft'::course_status,   -- ← FIX
    whatsapp, telegram, facebook, phone
  FROM courses WHERE id = p_source_id
  RETURNING id INTO v_new_course_id;

  -- Copy sections
  FOR sec IN SELECT * FROM sections WHERE course_id = p_source_id ORDER BY order_index LOOP
    INSERT INTO sections (course_id, title, description, order_index)
    VALUES (v_new_course_id, sec.title, sec.description, sec.order_index)
    RETURNING id INTO v_new_section_id;

    -- Copy lessons within section
    FOR les IN SELECT * FROM lessons WHERE section_id = sec.id ORDER BY order_index LOOP
      INSERT INTO lessons (
        section_id, course_id, title, description, order_index,
        video_type, video_id, video_title, video_playback_id, video_thumbnail, video_duration_seconds,
        external_url, content_html, notes,
        is_preview, download_enabled, comments_enabled, visible,
        status, duration_seconds
      )
      VALUES (
        v_new_section_id, v_new_course_id, les.title, les.description, les.order_index,
        les.video_type, les.video_id, les.video_title, les.video_playback_id, les.video_thumbnail, les.video_duration_seconds,
        les.external_url, les.content_html, les.notes,
        les.is_preview, les.download_enabled, les.comments_enabled, les.visible,
        'draft', les.duration_seconds
      )
      RETURNING id INTO v_new_lesson_id;

      -- Copy lesson materials
      FOR mat IN SELECT * FROM lesson_materials WHERE lesson_id = les.id ORDER BY order_index LOOP
        INSERT INTO lesson_materials (
          lesson_id, course_id, uploaded_by, file_name, file_url, storage_path,
          file_type, file_size, download_enabled, preview_enabled, permission, order_index
        )
        VALUES (
          v_new_lesson_id, v_new_course_id, p_target_doctor,
          mat.file_name, mat.file_url, mat.storage_path,
          mat.file_type, mat.file_size, mat.download_enabled, mat.preview_enabled, mat.permission, mat.order_index
        );
      END LOOP;
    END LOOP;
  END LOOP;

  RETURN v_new_course_id;
END;
$function$;
