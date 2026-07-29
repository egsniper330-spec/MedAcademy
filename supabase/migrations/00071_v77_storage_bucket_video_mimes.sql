
-- ══════════════════════════════════════════════════════════════════════════════
-- v77 — Fix lesson-materials bucket: add all supported video MIME types
-- ══════════════════════════════════════════════════════════════════════════════
-- Root cause of "Unsupported video format." bug:
--   The bucket only allowed video/mp4 and video/webm.
--   Uploading .mov/.mkv/.avi/.mpeg/.3gp/.ts files was rejected at storage level.
-- ══════════════════════════════════════════════════════════════════════════════

UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  -- Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
  'application/x-zip-compressed',
  -- Images
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  -- Audio
  'audio/mpeg', 'audio/ogg', 'audio/wav',
  -- ── Video — FULL list matching src/lib/videoFormats.ts ACCEPTED_VIDEO_MIMES ──
  'video/mp4',
  'video/quicktime',        -- .mov
  'video/x-matroska',       -- .mkv
  'video/webm',
  'video/x-msvideo',        -- .avi
  'video/mpeg',             -- .mpeg / .mpg
  'video/3gpp',             -- .3gp
  'video/3gpp2',            -- .3g2
  'video/mp2t',             -- .ts / .m2ts
  'video/x-m4v',            -- .m4v
  'video/ogg',              -- .ogv
  'video/x-flv',            -- .flv
  'video/x-ms-wmv',         -- .wmv
  -- ── Fallback — Android often returns this for binary video files ──
  'application/octet-stream',
  -- Text
  'text/plain', 'text/html'
]
WHERE id = 'lesson-materials';
