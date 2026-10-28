-- ============================================================================
-- 038_pdf_watermark_queue.sql
--
-- Durable, bounded queue for personalized (watermarked) lesson-PDF copies.
--
-- WHY
--   Generating a student's personalized copy used to happen INSIDE the
--   `/materials/pdf-url` request. On cPanel shared hosting a handful of
--   simultaneous first-opens of the same large PDF therefore held PHP-FPM
--   workers for the whole render, and every student paid that latency on their
--   first open. The queue moves generation into a short-lived CLI worker run
--   from cron, so a student's first request never renders a PDF inline.
--
-- WHAT THIS ADDS
--   `lesson_material_pdf_jobs` — one row per (material, student, variant) that
--   still needs a copy. `variant_key` is the SAME identity the delivery path
--   uses (source hash + student identity + engine settings), so a replaced
--   source PDF or a settings change produces a NEW job instead of silently
--   reusing a stale copy.
--
--   status: queued | processing | ready | failed | skipped
--     • queued     — waiting; `run_after` is the retry backoff gate.
--     • processing — claimed by a worker; `lock_token` identifies the claim so
--                    a worker only ever finishes jobs IT claimed.
--     • ready      — the copy exists in the registry (`lesson_material_pdfs`).
--     • failed     — `max_attempts` exhausted; a student retry re-queues it.
--     • skipped    — no longer eligible (unpublished, suspended enrollment,
--                    material hidden/deleted, source changed). Terminal.
--
-- SAFETY
--   • Additive only: one new table, no existing column or row is touched.
--   • The UNIQUE key (material_id, student_id, variant_key) is what prevents
--     duplicate jobs — concurrent uploads/requests cannot create two renders of
--     the same copy.
--   • Foreign keys cascade, so deleting a material or a profile cannot leave a
--     job pointing at nothing.
--
-- HOW TO APPLY (LATER — not applied to production by this change)
--   phpMyAdmin → select the MedAcademy database → Import → choose this file,
--   OR paste it into the SQL tab. Run it ONCE.
--   Re-running is harmless: CREATE TABLE IF NOT EXISTS.
--
-- TO ROLL BACK
--   See 038_pdf_watermark_queue_down.sql. Dropping the queue table loses only
--   the queue state; generated copies stay in `lesson_material_pdfs` and remain
--   deliverable, and a later request re-creates a job if a copy is missing.
-- ============================================================================

CREATE TABLE IF NOT EXISTS `lesson_material_pdf_jobs` (
  `id`            CHAR(36)     NOT NULL,
  `material_id`   CHAR(36)     NOT NULL,
  `student_id`    CHAR(36)     NOT NULL,
  -- sha256 of the SOURCE pdf this job must personalize.
  `source_hash`   CHAR(64)     NOT NULL,
  -- sha256(source_hash + identity + engine settings) — same formula as
  -- MaterialPdfVariantService, so job and cache identity can never drift.
  `variant_key`   CHAR(64)     NOT NULL,
  `status`        VARCHAR(16)  NOT NULL DEFAULT 'queued',
  -- Lower runs first. 0 = a student is waiting on this copy right now,
  -- 10 = upload-time pre-generation for enrolled students.
  `priority`      INT          NOT NULL DEFAULT 10,
  `attempts`      INT          NOT NULL DEFAULT 0,
  `max_attempts`  INT          NOT NULL DEFAULT 4,
  -- Claim identity: a worker completes only the jobs it holds this token for.
  `lock_token`    CHAR(36)     DEFAULT NULL,
  `locked_at`     DATETIME(6)  DEFAULT NULL,
  `locked_by`     VARCHAR(64)  DEFAULT NULL,
  -- Earliest time this job may be claimed (immediate, or retry backoff).
  `run_after`     DATETIME(6)  NOT NULL,
  -- Machine-readable failure stage (engine_unavailable, render_failed, …),
  -- never a path, a name or document content.
  `last_error`    VARCHAR(191) DEFAULT NULL,
  `ready_at`      DATETIME(6)  DEFAULT NULL,
  `created_at`    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  -- ONE job per (material, student, variant). This is the duplicate guard.
  UNIQUE KEY `uq_lesson_material_pdf_jobs_variant` (`material_id`, `student_id`, `variant_key`),
  -- The worker's claim scan.
  KEY `idx_lesson_material_pdf_jobs_claim` (`status`, `run_after`, `priority`, `created_at`),
  -- Student "is my copy ready?" lookups.
  KEY `idx_lesson_material_pdf_jobs_student` (`student_id`, `status`),
  -- Stale-source invalidation and admin diagnostics.
  KEY `idx_lesson_material_pdf_jobs_material` (`material_id`, `source_hash`),
  CONSTRAINT `fk_lesson_material_pdf_jobs_material`
    FOREIGN KEY (`material_id`) REFERENCES `lesson_materials` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_lesson_material_pdf_jobs_student`
    FOREIGN KEY (`student_id`) REFERENCES `profiles` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Verify in phpMyAdmin: the table is listed with its UNIQUE key. Do NOT query
-- information_schema — the cPanel MySQL user often has no read grant on it.
