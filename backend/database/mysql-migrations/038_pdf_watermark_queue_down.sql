-- ============================================================================
-- 038_pdf_watermark_queue_down.sql — rollback for 038_pdf_watermark_queue.sql
--
-- Drops ONLY the queue table. Generated personalized copies in
-- `lesson_material_pdfs` (migration 032) and their bytes are untouched, so
-- delivery keeps working; the next student request simply renders inline again
-- (the pre-queue behaviour).
--
-- Run this ONLY if you are deliberately reverting the queue. Delete any cron
-- entry that calls backend/scripts/watermark-worker.php at the same time —
-- the worker refuses to run once the table is gone, but the cron mail is noise.
-- ============================================================================

DROP TABLE IF EXISTS `lesson_material_pdf_jobs`;
