-- Add password_changed to audit_action enum
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'password_changed';