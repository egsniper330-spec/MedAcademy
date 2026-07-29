
-- 1. Add default contact fields to doctor profiles
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS contact_whatsapp text,
  ADD COLUMN IF NOT EXISTS contact_telegram text,
  ADD COLUMN IF NOT EXISTS contact_phone    text;

-- 2. Add flag to courses: true = use doctor's profile contact (default), false = use course-specific contact
ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS use_default_contact boolean NOT NULL DEFAULT true;

-- 3. Back-fill existing courses that already have custom contact set:
--    if any of whatsapp/telegram/phone is non-empty on the course row, treat it as custom
UPDATE courses
SET use_default_contact = false
WHERE (whatsapp IS NOT NULL AND whatsapp <> '')
   OR (telegram IS NOT NULL AND telegram <> '')
   OR (phone    IS NOT NULL AND phone    <> '');
