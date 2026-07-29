
-- The text-parameter overload body was assigning p_status (text) directly to
-- devices.status (device_status enum) — Postgres refuses implicit text→enum casts.
-- Fix: cast p_status::public.device_status everywhere inside the function body.
-- Also cast p_status in CASE comparisons so they resolve as enum, not text.
CREATE OR REPLACE FUNCTION public.update_device_status(
  p_device_id   uuid,
  p_status      text,
  p_block_reason text DEFAULT NULL,
  p_actor_id    uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor   profiles%ROWTYPE;
  v_target  profiles%ROWTYPE;
  v_device  devices%ROWTYPE;
  v_action  audit_action;
  v_desc    text;
  v_status  public.device_status;
BEGIN
  -- Validate and cast the text parameter to enum early — gives a clear error
  -- if an invalid status string is passed (e.g. typo).
  BEGIN
    v_status := p_status::public.device_status;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Invalid device status: %', p_status;
  END;

  SELECT * INTO v_device FROM devices WHERE devices.id = p_device_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Device not found'; END IF;

  SELECT * INTO v_actor  FROM profiles WHERE profiles.id = COALESCE(p_actor_id, auth.uid());
  SELECT * INTO v_target FROM profiles WHERE profiles.id = v_device.user_id;

  UPDATE devices SET
    status       = v_status,
    block_reason = CASE WHEN v_status = 'blocked'::public.device_status THEN p_block_reason ELSE NULL END,
    blocked_at   = CASE WHEN v_status = 'blocked'::public.device_status THEN now() ELSE NULL END,
    blocked_by   = CASE WHEN v_status = 'blocked'::public.device_status THEN v_actor.id ELSE NULL END
  WHERE devices.id = p_device_id;

  v_action := CASE v_status
    WHEN 'blocked'::public.device_status    THEN 'device_blocked'::audit_action
    WHEN 'active'::public.device_status     THEN 'device_unblocked'::audit_action
    WHEN 'logged_out'::public.device_status THEN 'device_revoked'::audit_action
    ELSE 'device_removed'::audit_action
  END;

  v_desc := CASE v_status
    WHEN 'blocked'::public.device_status    THEN format('%s blocked device "%s" on %s''s account (%s).%s',
      v_actor.full_name, COALESCE(v_device.device_name,'Unknown'),
      v_target.full_name, v_target.email,
      CASE WHEN p_block_reason IS NOT NULL AND p_block_reason <> ''
           THEN ' Reason: ' || p_block_reason ELSE '' END)
    WHEN 'active'::public.device_status     THEN format('%s unblocked device "%s" on %s''s account (%s)',
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
    jsonb_build_object('status', p_status, 'block_reason', p_block_reason),
    v_device.user_id, 'success'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_device_status(uuid, text, text, uuid) TO authenticated;
