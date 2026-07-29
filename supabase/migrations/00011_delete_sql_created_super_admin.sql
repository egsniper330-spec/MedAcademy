
-- Delete the SQL-inserted super admin account.
-- profiles row cascades automatically via FK ON DELETE CASCADE.
DELETE FROM auth.users WHERE email = 'admin@medacademy.app';
