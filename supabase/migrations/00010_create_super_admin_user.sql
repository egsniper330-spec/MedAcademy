
-- Create the Super Admin directly in auth.users.
-- handle_new_user trigger fires automatically and inserts the profiles row.
DO $$
DECLARE
  v_uid uuid := gen_random_uuid();
  v_email text := 'admin@medacademy.app';
  v_password text := 'SuperAdmin@2025';
  v_now timestamptz := now();
BEGIN
  -- Remove any stale entry with this email first (idempotent)
  DELETE FROM auth.users WHERE email = v_email;

  INSERT INTO auth.users (
    id,
    instance_id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    confirmation_sent_at,
    raw_app_meta_data,
    raw_user_meta_data,
    is_super_admin,
    created_at,
    updated_at,
    last_sign_in_at,
    is_sso_user,
    deleted_at
  ) VALUES (
    v_uid,
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    v_email,
    crypt(v_password, gen_salt('bf', 10)),
    v_now,                      -- email pre-confirmed
    v_now,
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object(
      'role',      'super_admin',
      'full_name', 'Super Admin',
      'phone',     ''
    ),
    false,
    v_now,
    v_now,
    v_now,
    false,
    null
  );

  -- Also insert the identity row so password login works correctly
  INSERT INTO auth.identities (
    id,
    provider_id,
    user_id,
    identity_data,
    provider,
    last_sign_in_at,
    created_at,
    updated_at
  ) VALUES (
    gen_random_uuid(),
    v_email,
    v_uid,
    jsonb_build_object('sub', v_uid::text, 'email', v_email),
    'email',
    v_now,
    v_now,
    v_now
  );
END;
$$;
