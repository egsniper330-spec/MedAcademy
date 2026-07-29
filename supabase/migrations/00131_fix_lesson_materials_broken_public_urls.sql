
-- Fix all lesson_materials rows where file_url contains a broken
-- /object/public/lesson-materials/ URL. Replace with the raw storage_path.
-- After this fix, file_url == storage_path for all rows.
-- At read-time, getMaterialSignedUrl() is called to generate a valid signed URL.
UPDATE lesson_materials
SET file_url = storage_path
WHERE file_url LIKE '%/object/public/lesson-materials/%'
  AND storage_path IS NOT NULL
  AND storage_path <> '';
