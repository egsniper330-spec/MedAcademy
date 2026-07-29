-- ══════════════════════════════════════════════════════════════════════════════
-- v157 — Add YouTube as a second video provider
-- ══════════════════════════════════════════════════════════════════════════════

-- 1. Add 'youtube' to the video_type enum
ALTER TYPE video_type ADD VALUE IF NOT EXISTS 'youtube';

-- 2. Add youtube_video_id column (stores the 11-char YouTube video ID)
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS youtube_video_id TEXT;

-- 3. Index for efficient provider queries
CREATE INDEX IF NOT EXISTS idx_lessons_youtube_video_id ON lessons(youtube_video_id) WHERE youtube_video_id IS NOT NULL;
