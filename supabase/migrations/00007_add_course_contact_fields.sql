-- Add contact fields to courses table
ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS whatsapp  text,
  ADD COLUMN IF NOT EXISTS telegram  text,
  ADD COLUMN IF NOT EXISTS facebook  text,
  ADD COLUMN IF NOT EXISTS phone     text;

-- Add a check: published courses must have at least one contact method
-- (enforced at the DB level as a belt-and-suspenders guard)
ALTER TABLE courses DROP CONSTRAINT IF EXISTS courses_published_needs_contact;
ALTER TABLE courses ADD CONSTRAINT courses_published_needs_contact
  CHECK (
    status != 'published' OR (
      (whatsapp IS NOT NULL AND whatsapp != '') OR
      (telegram IS NOT NULL AND telegram != '') OR
      (facebook IS NOT NULL AND facebook != '') OR
      (phone    IS NOT NULL AND phone    != '')
    )
  );

COMMENT ON COLUMN courses.whatsapp IS 'International format e.g. +201001234567';
COMMENT ON COLUMN courses.telegram IS 'Username or public link e.g. @username or https://t.me/username';
COMMENT ON COLUMN courses.facebook IS 'Profile or page URL';
COMMENT ON COLUMN courses.phone    IS 'International phone number e.g. +201001234567';