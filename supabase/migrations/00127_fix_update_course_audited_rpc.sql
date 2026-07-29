
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: fix_update_course_audited_rpc
--
-- Mirrors the same column-name mismatch fix for the UPDATE path.
-- Old stale columns: price, duration_hours, level, what_you_learn,
--   requirements, who_is_this_for, contact_phone, contact_whatsapp,
--   contact_email, contact_telegram, is_featured
-- Actual table columns: price_egp, phone, whatsapp, telegram, facebook,
--   short_description, full_description, difficulty, etc.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.update_course_audited(p_course_id uuid, p_updates jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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

  -- Snapshot current values for diff
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

  -- ── UPDATE using real column names ───────────────────────────────────────
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

  -- Only audit if something actually changed
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
