-- Migration 007: Add unique index on video_assets(doctor_id, provider_video_id)
-- This enables the ON DUPLICATE KEY UPDATE clause used by upsertVideoAsset(),
-- ensuring one video_assets row per doctor per VdoCipher video (no duplicates).
--
-- Safe/idempotent: uses CREATE UNIQUE INDEX IF NOT EXISTS pattern.

-- Remove duplicate rows first (keep the one with the earliest created_at)
-- then add the unique index.
DELETE t1 FROM `video_assets` t1
INNER JOIN (
    SELECT MIN(id) AS keep_id, doctor_id, provider_video_id
    FROM `video_assets`
    GROUP BY doctor_id, provider_video_id
    HAVING COUNT(*) > 1
) t2 ON t1.doctor_id = t2.doctor_id
    AND t1.provider_video_id = t2.provider_video_id
    AND t1.id != t2.keep_id;

-- Create the unique index if it doesn't already exist
SET @idx_exists = (
    SELECT COUNT(*)
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'video_assets'
      AND index_name = 'uq_video_assets_doctor_provider'
);

SET @sql = IF(
    @idx_exists = 0,
    'ALTER TABLE `video_assets` ADD UNIQUE INDEX `uq_video_assets_doctor_provider` (`doctor_id`, `provider_video_id`)',
    'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
