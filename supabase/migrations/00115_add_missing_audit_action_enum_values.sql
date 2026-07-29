
-- Add every missing action used by recent audit improvements.
-- All ADD VALUE calls are idempotent-guarded via DO blocks.

DO $$ BEGIN
  -- Profile self-edit actions
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = 'audit_action'::regtype AND enumlabel = 'profile_name_changed') THEN
    ALTER TYPE audit_action ADD VALUE 'profile_name_changed';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = 'audit_action'::regtype AND enumlabel = 'profile_avatar_changed') THEN
    ALTER TYPE audit_action ADD VALUE 'profile_avatar_changed';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = 'audit_action'::regtype AND enumlabel = 'profile_email_changed') THEN
    ALTER TYPE audit_action ADD VALUE 'profile_email_changed';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = 'audit_action'::regtype AND enumlabel = 'profile_phone_changed') THEN
    ALTER TYPE audit_action ADD VALUE 'profile_phone_changed';
  END IF;
END $$;

-- Role-specific user creation actions
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = 'audit_action'::regtype AND enumlabel = 'doctor_created') THEN
    ALTER TYPE audit_action ADD VALUE 'doctor_created';
  END IF;
END $$;

-- code_redeemed: used in activation-codes assign flow
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = 'audit_action'::regtype AND enumlabel = 'code_redeemed') THEN
    ALTER TYPE audit_action ADD VALUE 'code_redeemed';
  END IF;
END $$;

-- role_changed_to_* actions (used by set_user_role RPC)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = 'audit_action'::regtype AND enumlabel = 'role_changed_to_doctor') THEN
    ALTER TYPE audit_action ADD VALUE 'role_changed_to_doctor';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = 'audit_action'::regtype AND enumlabel = 'role_changed_to_admin') THEN
    ALTER TYPE audit_action ADD VALUE 'role_changed_to_admin';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = 'audit_action'::regtype AND enumlabel = 'role_changed_to_super_admin') THEN
    ALTER TYPE audit_action ADD VALUE 'role_changed_to_super_admin';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = 'audit_action'::regtype AND enumlabel = 'role_changed_to_student') THEN
    ALTER TYPE audit_action ADD VALUE 'role_changed_to_student';
  END IF;
END $$;
