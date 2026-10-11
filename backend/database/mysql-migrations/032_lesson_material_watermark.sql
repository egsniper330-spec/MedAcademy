-- ============================================================================
-- 032_lesson_material_watermark.sql
--
-- Personalized student PDF watermarking + Preview-Only enforcement.
--
-- WHAT THIS ADDS
--   1. `lesson_materials.watermark_enabled` — the teacher's independent
--      "Personalized Student Watermark" switch. It is deliberately SEPARATE
--      from the existing download controls (`permission`, `download_enabled`):
--        • watermark_enabled = 1 → every delivered copy is personalized.
--        • permission = 'preview_only' → viewing allowed, download refused.
--      All four combinations are legal.
--
--   2. `lesson_material_pdfs` — the registry of generated personalized copies.
--      One row per (material, student, variant). `variant_key` hashes the
--      source file hash + the engine/settings, so a regenerated source PDF or
--      a settings change invalidates the cached copy instead of serving stale
--      bytes. The bytes themselves live in the private bucket
--      `lesson-material-pdfs`, which has NO signed-URL route: it is reachable
--      only through the token-gated delivery endpoint.
--
-- SAFETY
--   • Additive only. No existing column is altered or dropped, no data is moved.
--   • `watermark_enabled` defaults to 0 (OFF), so every existing material keeps
--     its current behaviour exactly — nothing starts watermarking by accident.
--
-- WHY THERE IS NO information_schema PRE-CHECK
--   On cPanel the MySQL user (e.g. `cpses_…`) is often NOT granted read access
--   to the `information_schema` database. A `SELECT ... FROM
--   information_schema.COLUMNS` guard therefore fails with:
--       #1044 - Access denied for user '…'@'localhost' to database 'information_schema'
--   and — because phpMyAdmin stops at the first failing statement — the real
--   ALTER/CREATE below would never run. This file now contains only statements
--   that need privileges on the MedAcademy database itself.
--
-- HOW TO APPLY
--   phpMyAdmin → select the MedAcademy database → Import → choose this file,
--   OR paste it into the SQL tab. Run it ONCE.
--
--   If you are re-running it (e.g. to confirm state) phpMyAdmin may report one
--   of these harmless errors, which mean "already applied":
--       #1060 - Duplicate column name 'watermark_enabled'
--       #1050 - Table 'lesson_material_pdfs' already exists   (unlikely — the
--               CREATE below is guarded with IF NOT EXISTS)
--   Those can be ignored; nothing is changed twice.
--
--   To check state WITHOUT information_schema: in phpMyAdmin open
--   `lesson_materials` → Structure and confirm a `watermark_enabled` column
--   exists, and confirm a `lesson_material_pdfs` table is listed.
-- ============================================================================

-- ── 1. Teacher-controlled watermark toggle ───────────────────────────────────
-- Run once. If this errors with #1060 the column already exists — skip it.
--
-- NOTE ON IDEMPOTENCY:
--   MySQL 8 does not support `ADD COLUMN IF NOT EXISTS`; MariaDB does. If your
--   server is MariaDB (common on cPanel) you may replace the line below with:
--       ALTER TABLE `lesson_materials`
--         ADD COLUMN IF NOT EXISTS `watermark_enabled` TINYINT(1) NOT NULL DEFAULT 0
--         COMMENT '…';
--   The plain form below is the portable choice for a one-time import.
ALTER TABLE `lesson_materials`
  ADD COLUMN `watermark_enabled` TINYINT(1) NOT NULL DEFAULT 0
  COMMENT 'Personalized Student Watermark: 1 = every delivered copy carries the student identity';

-- ── 2. Registry of generated personalized copies ─────────────────────────────
-- Guarded, so re-running this file is safe for the table.
CREATE TABLE IF NOT EXISTS `lesson_material_pdfs` (
  `id`            CHAR(36)     DEFAULT (UUID()) COMMENT 'pg_default: gen_random_uuid()',
  `material_id`   CHAR(36)     NOT NULL,
  `student_id`    CHAR(36)     NOT NULL,
  -- sha256 of the SOURCE pdf, so replacing the source invalidates every copy.
  `source_hash`   CHAR(64)     NOT NULL,
  -- sha256(identity + engine/settings + source_hash): cache identity of a copy.
  `variant_key`   CHAR(64)     NOT NULL,
  -- Private object path inside the `lesson-material-pdfs` bucket.
  `storage_path`  TEXT         NOT NULL,
  `file_size`     BIGINT       DEFAULT 0 NOT NULL COMMENT 'pg_default: 0',
  `page_count`    INT          DEFAULT 0 NOT NULL COMMENT 'pg_default: 0',
  `created_at`    DATETIME(6)  DEFAULT CURRENT_TIMESTAMP NOT NULL COMMENT 'pg_default: now()',
  `updated_at`    DATETIME(6)  DEFAULT CURRENT_TIMESTAMP NOT NULL COMMENT 'pg_default: now()',
  PRIMARY KEY (`id`),
  -- One cached copy per (material, student, variant). Two students can never
  -- share a row, and a changed source/settings produces a new variant_key.
  UNIQUE KEY `uq_lesson_material_pdfs_variant` (`material_id`, `student_id`, `variant_key`),
  KEY `idx_lesson_material_pdfs_student` (`student_id`),
  CONSTRAINT `fk_lesson_material_pdfs_material`
    FOREIGN KEY (`material_id`) REFERENCES `lesson_materials` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_lesson_material_pdfs_student`
    FOREIGN KEY (`student_id`) REFERENCES `profiles` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 3. Done ──────────────────────────────────────────────────────────────────
-- Verify in phpMyAdmin (Structure tab / table list) rather than via
-- information_schema, which this MySQL user may not be allowed to read.
-- No index is created on `watermark_enabled` on purpose: it is a low-cardinality
-- boolean flag and an index on it adds write cost without helping any query.
