
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: fix_course_rpc_audit_log_signature
--
-- Root cause
-- ──────────
-- There are 4 overloads of write_audit_log. The course RPCs call it with named
-- parameters whose combination does NOT unambiguously resolve to any single
-- overload, so PostgreSQL raises:
--   "function public.write_audit_log(...) does not exist"
--
-- Specifically:
--   • p_action := 'course_created'    → text string
--   • p_description := ...            → named param not in the text-action overload
--   • p_resource_id := uuid::text     → text, but overload wants uuid
--
-- The text-action overload signature is:
--   write_audit_log(
--     p_action       text,
--     p_resource_type text  DEFAULT NULL,
--     p_resource_id   uuid  DEFAULT NULL,   ← UUID, not text
--     p_target_name   text  DEFAULT NULL,
--     p_description   text  DEFAULT NULL,
--     p_old_values    jsonb DEFAULT NULL,
--     p_new_values    jsonb DEFAULT NULL,
--     p_user_id       uuid  DEFAULT NULL
--   )
-- 
-- Fix strategy
-- ────────────
-- 1. Pass p_resource_id as UUID (not ::text) to match the overload.
-- 2. Wrap every audit PERFORM in EXCEPTION WHEN OTHERS so a logging failure
--    can NEVER roll back a committed course INSERT/UPDATE. The course operation
--    always succeeds; the audit entry is best-effort.
-- 3. Rewrite create_course_audited, update_course_audited, publish_course,
--    and unpublish_course with the corrected call.
--    archive_course and restore_course INSERT directly into audit_logs (bypassing
--    write_audit_log entirely) — they are NOT affected.
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

  -- ── INSERT course ─────────────────────────────────────────────────────────
  INSERT INTO public.courses (
    title, description, short_description, full_description,
    thumbnail_url, cover_url, image_url,
    status,
    doctor_id, university_id, faculty_id, academic_level_id,
    language, difficulty, tags, instructor_name,
    phone, whatsapp, telegram, facebook,
    price_egp, sequential_learning, free_preview,
    certificate_enabled, subscription_required,
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
    coalesce(p_payload->>'status', 'draft')::course_status,
    (p_payload->>'doctor_id')::uuid,
    (p_payload->>'university_id')::uuid,
    (p_payload->>'faculty_id')::uuid,
    (p_payload->>'academic_level_id')::uuid,
    coalesce(p_payload->>'language', 'Arabic'),
    coalesce(p_payload->>'difficulty', 'all_levels')::difficulty_level,
    coalesce(ARRAY(SELECT jsonb_array_elements_text(p_payload->'tags')), '{}'::text[]),
    p_payload->>'instructor_name',
    p_payload->>'phone', p_payload->>'whatsapp',
    p_payload->>'telegram', p_payload->>'facebook',
    coalesce((p_payload->>'price_egp')::numeric, 0),
    coalesce((p_payload->>'sequential_learning')::boolean, false),
    coalesce((p_payload->>'free_preview')::boolean, false),
    coalesce((p_payload->>'certificate_enabled')::boolean, false),
    coalesce((p_payload->>'subscription_required')::boolean, true),
    now()
  )
  RETURNING id INTO v_course_id;

  -- ── Audit log (best-effort — must NOT block course creation) ──────────────
  BEGIN
    PERFORM public.write_audit_log(
      p_action        := 'course_created'::text,
      p_resource_type := 'course',
      p_resource_id   := v_course_id,            -- uuid, not ::text
      p_target_name   := coalesce(v_title, 'Untitled'),
      p_description   := format('%s created course "%s"%s',
                                coalesce(v_actor_name, 'Unknown'),
                                coalesce(v_title, 'Untitled'),
                                CASE WHEN v_doctor_name IS NOT NULL
                                     THEN ' for instructor ' || v_doctor_name
                                     ELSE '' END),
      p_old_values    := null,
      p_new_values    := jsonb_build_object(
                           'title',     v_title,
                           'status',    coalesce(p_payload->>'status', 'draft'),
                           'price_egp', p_payload->>'price_egp',
                           'doctor_id', v_doctor_id
                         ),
      p_user_id       := v_actor_id
    );
  EXCEPTION WHEN OTHERS THEN
    -- Audit failure must never abort course creation. Log to stderr only.
    RAISE WARNING '[create_course_audited] audit log failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object('id', v_course_id, 'title', v_title);
END;
$function$;


-- ── 2. update_course_audited ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_course_audited(p_course_id uuid, p_updates jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor_id   uuid;
  v_actor_name text;
  v_old        jsonb;
  v_new_vals   jsonb := '{}';
  v_old_vals   jsonb := '{}';
  v_title      text;
  v_key        text;
  v_old_val    text;
  v_new_val    text;
BEGIN
  v_actor_id := auth.uid();
  SELECT full_name INTO v_actor_name
    FROM public.profiles WHERE id = v_actor_id;

  SELECT to_jsonb(c) INTO v_old FROM public.courses c WHERE id = p_course_id;
  v_title := v_old->>'title';

  FOR v_key IN SELECT jsonb_object_keys(p_updates) LOOP
    v_old_val := v_old->>v_key;
    v_new_val := p_updates->>v_key;
    IF v_old_val IS DISTINCT FROM v_new_val THEN
      v_old_vals := v_old_vals || jsonb_build_object(v_key, v_old_val);
      v_new_vals := v_new_vals || jsonb_build_object(v_key, v_new_val);
    END IF;
  END LOOP;

  UPDATE public.courses SET
    title                = coalesce(p_updates->>'title',                       title),
    description          = coalesce(p_updates->>'description',                 description),
    short_description    = coalesce(p_updates->>'short_description',           short_description),
    full_description     = coalesce(p_updates->>'full_description',            full_description),
    thumbnail_url        = coalesce(p_updates->>'thumbnail_url',               thumbnail_url),
    cover_url            = coalesce(p_updates->>'cover_url',                   cover_url),
    image_url            = coalesce(p_updates->>'image_url',                   image_url),
    status               = coalesce(p_updates->>'status',                      status::text)::course_status,
    doctor_id            = coalesce((p_updates->>'doctor_id')::uuid,           doctor_id),
    university_id        = coalesce((p_updates->>'university_id')::uuid,       university_id),
    faculty_id           = coalesce((p_updates->>'faculty_id')::uuid,          faculty_id),
    academic_level_id    = coalesce((p_updates->>'academic_level_id')::uuid,   academic_level_id),
    language             = coalesce(p_updates->>'language',                    language),
    difficulty           = coalesce(p_updates->>'difficulty',                  difficulty::text)::difficulty_level,
    instructor_name      = coalesce(p_updates->>'instructor_name',             instructor_name),
    phone                = coalesce(p_updates->>'phone',                       phone),
    whatsapp             = coalesce(p_updates->>'whatsapp',                    whatsapp),
    telegram             = coalesce(p_updates->>'telegram',                    telegram),
    facebook             = coalesce(p_updates->>'facebook',                    facebook),
    price_egp            = coalesce((p_updates->>'price_egp')::numeric,        price_egp),
    sequential_learning  = coalesce((p_updates->>'sequential_learning')::boolean, sequential_learning),
    free_preview         = coalesce((p_updates->>'free_preview')::boolean,     free_preview),
    certificate_enabled  = coalesce((p_updates->>'certificate_enabled')::boolean, certificate_enabled),
    subscription_required= coalesce((p_updates->>'subscription_required')::boolean, subscription_required),
    updated_at           = now()
  WHERE id = p_course_id;

  -- ── Audit log (best-effort) ───────────────────────────────────────────────
  IF v_old_vals <> '{}' THEN
    BEGIN
      PERFORM public.write_audit_log(
        p_action        := 'course_updated'::text,
        p_resource_type := 'course',
        p_resource_id   := p_course_id,           -- uuid, not ::text
        p_target_name   := coalesce(v_title, 'Untitled'),
        p_description   := format('%s updated course "%s"',
                                  coalesce(v_actor_name, 'Unknown'),
                                  coalesce(v_title, 'Untitled')),
        p_old_values    := v_old_vals,
        p_new_values    := v_new_vals,
        p_user_id       := v_actor_id
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[update_course_audited] audit log failed: %', SQLERRM;
    END;
  END IF;
END;
$function$;


-- ── 3. publish_course ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.publish_course(p_course_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor_id   uuid;
  v_actor_name text;
  v_actor_role text;
  v_old_status text;
  v_title      text;
BEGIN
  v_actor_id := auth.uid();
  SELECT full_name, role INTO v_actor_name, v_actor_role
    FROM public.profiles WHERE id = v_actor_id;

  SELECT title, status::text INTO v_title, v_old_status
    FROM public.courses WHERE id = p_course_id;

  UPDATE public.courses
    SET status = 'published', updated_at = now()
  WHERE id = p_course_id;

  -- ── Audit log (best-effort) ───────────────────────────────────────────────
  BEGIN
    PERFORM public.write_audit_log(
      p_action        := 'course_published'::text,
      p_resource_type := 'course',
      p_resource_id   := p_course_id,
      p_target_name   := coalesce(v_title, 'Untitled'),
      p_description   := format('%s published course "%s"',
                                coalesce(v_actor_name, 'Unknown'),
                                coalesce(v_title, 'Untitled')),
      p_old_values    := jsonb_build_object('status', v_old_status),
      p_new_values    := jsonb_build_object('status', 'published'),
      p_user_id       := v_actor_id
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[publish_course] audit log failed: %', SQLERRM;
  END;
END;
$function$;


-- ── 4. unpublish_course ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.unpublish_course(p_course_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor_id   uuid;
  v_actor_name text;
  v_actor_role text;
  v_old_status text;
  v_title      text;
BEGIN
  v_actor_id := auth.uid();
  SELECT full_name, role INTO v_actor_name, v_actor_role
    FROM public.profiles WHERE id = v_actor_id;

  SELECT title, status::text INTO v_title, v_old_status
    FROM public.courses WHERE id = p_course_id;

  UPDATE public.courses
    SET status = 'draft', updated_at = now()
  WHERE id = p_course_id;

  -- ── Audit log (best-effort) ───────────────────────────────────────────────
  BEGIN
    PERFORM public.write_audit_log(
      p_action        := 'course_unpublished'::text,
      p_resource_type := 'course',
      p_resource_id   := p_course_id,
      p_target_name   := coalesce(v_title, 'Untitled'),
      p_description   := format('%s unpublished course "%s"',
                                coalesce(v_actor_name, 'Unknown'),
                                coalesce(v_title, 'Untitled')),
      p_old_values    := jsonb_build_object('status', v_old_status),
      p_new_values    := jsonb_build_object('status', 'draft'),
      p_user_id       := v_actor_id
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[unpublish_course] audit log failed: %', SQLERRM;
  END;
END;
$function$;
