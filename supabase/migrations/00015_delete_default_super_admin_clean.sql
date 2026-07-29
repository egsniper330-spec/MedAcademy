
-- Delete audit_logs referencing the default super admin first, then remove the account.
-- profiles cascades from auth.users ON DELETE CASCADE.
DELETE FROM audit_logs WHERE user_id = (
  SELECT id FROM auth.users WHERE email = 'admin@medacademy.app'
);
DELETE FROM auth.users WHERE email = 'admin@medacademy.app';
