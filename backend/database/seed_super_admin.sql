-- ============================================================================
-- MedAcademy — Super Admin seed (idempotent, MySQL/MariaDB)
-- ============================================================================
-- Account:
--   Email:    ahmedabdelfattah44@icloud.com
--   Phone:    01020182886            (E.164: +201020182886)
--   Password: 123@#$Eg               (stored as bcrypt, cost 10 — NEVER
--                                     plaintext; hash generated with the
--                                     application's Password::hash() so the
--                                     normal /auth/login endpoint accepts it)
--   Role:     super_admin            (exact value checked by backend authz)
--
-- HOW THIS WORKS (mirrors AdminController::userManagement(), the app's own
-- admin user-creation path — see backend/src/Controllers/AdminController.php):
--   1. INSERT into users WITHOUT the `phone` column. Inserting users.phone
--      would fire trg_sync_auth_phone_on_new_user -> UPDATE profiles ->
--      trg_sync_auth_phone_on_profile_update -> UPDATE users -> MySQL
--      Error 1442 ("Can't update table 'users' ... used by the statement that
--      invoked the trigger") — this is exactly what broke the previous seed.
--      trg_on_auth_user_created fires and creates the profiles row, reading
--      full_name/role from raw_user_meta_data.
--   2. UPDATE profiles (the row created by the trigger) with phone fields,
--      role='super_admin', status='active' and a sequential watermark. Writing
--      phone_e164 here legally syncs users.phone back via the trigger (the
--      invoking statement is on profiles, so no 1442).
--   3. credits row inserted idempotently; trg_super_admin_unlimited sets
--      allocated=-1 / remaining=-1 (unlimited) automatically.
--
-- RUN (cPanel Terminal — preferred):
--   mysql -u USER -p DBNAME < backend/database/seed_super_admin.sql
-- or paste into phpMyAdmin's SQL tab. Safe to run multiple times.
-- ============================================================================

-- Fixed UUID so the statements reference one account and re-runs are safe.
SET @sa_id = '10000000-0000-4000-8000-000000000001';

-- 1. Auth user (GoTrue-style users table). Phone intentionally omitted (1442
--    note above). email_confirmed_at/phone_confirmed_at are set so the account
--    is fully confirmed and usable immediately.
INSERT INTO `users`
  (`id`, `email`, `encrypted_password`, `raw_user_meta_data`,
   `email_confirmed_at`, `phone_confirmed_at`, `created_at`, `updated_at`)
VALUES
  (@sa_id,
   'ahmedabdelfattah44@icloud.com',
   '$2y$10$6EvTLEr/p23bGD8b/do.9O2I/FUMqrNZS5AN0TA5a63X7HCokpgKW',
   JSON_OBJECT('full_name', 'Ahmed Abdelfattah', 'role', 'super_admin', 'phone', '+201020182886'),
   UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
ON DUPLICATE KEY UPDATE
  `encrypted_password` = VALUES(`encrypted_password`),
  `raw_user_meta_data`  = VALUES(`raw_user_meta_data`),
  `email_confirmed_at`  = COALESCE(`email_confirmed_at`, UTC_TIMESTAMP(6)),
  `phone_confirmed_at`  = COALESCE(`phone_confirmed_at`, UTC_TIMESTAMP(6)),
  `updated_at`          = UTC_TIMESTAMP(6);

-- Resolve the real id (our fixed UUID on a fresh insert; the existing row's id
-- if the account already existed with a different UUID).
SET @sa_id = (SELECT `id` FROM `users` WHERE `email` = 'ahmedabdelfattah44@icloud.com' LIMIT 1);

-- 2. Sequential watermark (same scheme as AuthService::nextWatermarkId()).
UPDATE `watermark_seq` SET `next_val` = `next_val` + 1 WHERE `id` = 1;
SET @sa_watermark = (SELECT HEX(`next_val` - 1) FROM `watermark_seq` WHERE `id` = 1);

-- 3. Profile row (created by trg_on_auth_user_created). Fill the fields the
--    trigger does not set. Writing phone_e164 syncs users.phone back via
--    trg_sync_auth_phone_on_profile_update (legal: outer statement is on
--    profiles). `phone` keeps the national format the app stores for the raw
--    field; `phone_e164`/`phone_national`/`phone_country_code` are set too.
UPDATE `profiles`
   SET `email`             = 'ahmedabdelfattah44@icloud.com',
       `profile_email`     = 'ahmedabdelfattah44@icloud.com',
       `full_name`         = 'Ahmed Abdelfattah',
       `phone`             = '01020182886',
       `phone_national`    = '01020182886',
       `phone_country_code`= '+20',
       `phone_e164`        = '+201020182886',
       `role`              = 'super_admin',
       `status`            = 'active',
       `watermark_id`      = @sa_watermark,
       `updated_at`        = UTC_TIMESTAMP(6)
 WHERE `id` = @sa_id;

-- 4. Credits row (idempotent). trg_super_admin_unlimited auto-sets
--    allocated=-1 / remaining=-1 (unlimited) because the profile role is
--    super_admin at this point.
INSERT INTO `credits` (`doctor_id`, `allocated`, `consumed`, `remaining`, `updated_at`)
VALUES (@sa_id, 0, 0, 0, UTC_TIMESTAMP(6))
ON DUPLICATE KEY UPDATE `updated_at` = `updated_at`;
