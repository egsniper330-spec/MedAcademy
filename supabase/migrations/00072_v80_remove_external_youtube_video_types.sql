-- ══════════════════════════════════════════════════════════════════════════════
-- v80 — Remove external/youtube lesson video types
-- Only 'vdocipher' and 'coming_soon' are supported going forward.
-- ══════════════════════════════════════════════════════════════════════════════

-- 1. Migrate any existing rows that used removed types → vdocipher
UPDATE lessons SET video_type = 'vdocipher' WHERE video_type IN ('external', 'youtube');

-- 2. Drop the existing default so the column can be retyped
ALTER TABLE lessons ALTER COLUMN video_type DROP DEFAULT;

-- 3. Create replacement enum with only the two valid values
CREATE TYPE video_type_new AS ENUM ('vdocipher', 'coming_soon');

-- 4. Swap the column to the new enum
ALTER TABLE lessons
  ALTER COLUMN video_type TYPE video_type_new
  USING video_type::text::video_type_new;

-- 5. Restore default with the new type
ALTER TABLE lessons ALTER COLUMN video_type SET DEFAULT 'vdocipher'::video_type_new;

-- 6. Drop the old enum and promote the new one
DROP TYPE video_type;
ALTER TYPE video_type_new RENAME TO video_type;

-- 7. Remove external_url column (no longer needed)
ALTER TABLE lessons DROP COLUMN IF EXISTS external_url;

-- 8. Recreate index
DROP INDEX IF EXISTS idx_lessons_video_type;
CREATE INDEX IF NOT EXISTS idx_lessons_video_type ON lessons(video_type);
