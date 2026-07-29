
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'audit_action'::regtype
      AND enumlabel = 'password_changed_by_admin'
  ) THEN
    ALTER TYPE audit_action ADD VALUE 'password_changed_by_admin';
  END IF;
END $$;
